import { prisma } from "@/lib/db";
import { getAssetAccess } from "@/lib/meta-connect";
import { describeError } from "@/lib/safe-error";
import { recordLowering } from "@/lib/spend/book";
import { sandboxFlagFor } from "@/lib/spend/sandbox";
import { markUnpaused } from "@/lib/spend/tasks/adsguard";
import type { SpendActor } from "@/lib/spend/types";
import { adsClient, type AdsClient } from "./client";

/*
 * stopCommitments (docs/SPEND-CONTROLS-SPEC.md 4.8, 4.11, 4.17): pauses what is running, for the kill switches, the breakers,
 * locked, suspended and closing workspaces, and Meta disconnects. Lowering only, so it is never refused (I2), works while
 * frozen, and never throws.
 *
 * - What it looks at: every campaign of the workspace that is active in the database or still has an open commitment
 *   (reserved, live or unconfirmed), filtered by origin (assistant-launched only, or all), ad account and Meta object ids.
 * - A whole campaign is paused at campaign level: one call, and it does not use the ad set budget-change quota. That is the
 *   case without an object filter, when the filter names the campaign, or when it names every ad set of the campaign.
 *   Otherwise the named ad sets are paused one by one.
 * - Every pause goes through recordLowering (requested row, a lowering permit, the Meta call with no lock held, the
 *   commitment stopped, the outcome row). On success the campaign or ad set row is marked paused.
 * - An object it could not pause stays counted, with its commitments marked `unconfirmed`: `failed` (Meta refused or did not
 *   answer) or `unreachable` (the Meta connection can no longer give a token: expired, revoked, disconnected). The reconciler
 *   reads unconfirmed commitments again once a token is back; until then Meta's own limit bounds them when it is managed, and
 *   the caller tells the owner which campaigns may still be running (the items list names them).
 */

export type StopFilter = {
  /** Only campaigns an assistant launched, or every campaign (the default). */
  origin?: "assistant" | "all";
  adAccountAssetId?: string;
  /** Campaign or ad set Meta ids. A campaign id, or every ad set id of a campaign, pauses the whole campaign. */
  metaObjectIds?: readonly string[];
};

export type StopItemResult = "done" | "failed" | "unreachable" | "skipped";

export type StopItem = {
  campaignId: string;
  campaignName: string;
  adAccountAssetId: string;
  metaObjectId: string;
  level: "campaign" | "adset";
  result: StopItemResult;
  /** The campaign row's lastError before this run (callers flag a failure once). */
  lastError: string | null;
};

export type StopResult = {
  done: number;
  failed: number;
  unreachable: number;
  /** Not tried: the time budget ran out, or a recent failure is still waiting for its retry. */
  skipped: number;
  /** Objects targeted (done + failed + unreachable + skipped). */
  total: number;
  items: StopItem[];
};

export type StopOptions = {
  /** Epoch ms after which no new pause is started (the inline stop's 20 s budget). */
  deadline?: number;
  /** Skip an object whose pause failed within this long (the 1-minute sweep retries a failure every 15 minutes, not every minute). */
  retryFailedAfterMs?: number;
  now?: () => number;
  env?: Record<string, string | undefined>;
};

type Target = Omit<StopItem, "result">;

const OPEN_STATUSES = ["reserved", "live", "unconfirmed"];
const MAX_CAMPAIGNS = 500;
const MAX_COMMITMENTS = 5_000;

const campaignSelect = { id: true, name: true, adAccountAssetId: true, metaCampaignId: true, origin: true, status: true, dailyBudgetMinor: true, lastError: true } as const;
type CampaignRow = { id: string; name: string; adAccountAssetId: string; metaCampaignId: string | null; origin: string | null; status: string; dailyBudgetMinor: number; lastError: string | null };
type OpenRow = { campaignId: string; adSetId: string | null; metaObjectId: string; objectLevel: string; origin: string; adAccountAssetId: string };
type SetRow = { id: string; campaignId: string; metaAdSetId: string | null };

const isSynthetic = (metaObjectId: string) => metaObjectId.startsWith("db:");

/** What to pause, biggest campaigns first. Reads only. */
async function planTargets(tenantId: string, filter: StopFilter): Promise<Target[]> {
  const scope = { tenantId, ...(filter.adAccountAssetId ? { adAccountAssetId: filter.adAccountAssetId } : {}) };
  const active = ((await prisma.adCampaign.findMany({ where: { ...scope, status: "active", metaCampaignId: { not: null } }, select: campaignSelect, take: MAX_CAMPAIGNS })) ?? []) as CampaignRow[];
  const open = ((await prisma.spendCommitment.findMany({
    where: { ...scope, status: { in: OPEN_STATUSES } },
    select: { campaignId: true, adSetId: true, metaObjectId: true, objectLevel: true, origin: true, adAccountAssetId: true },
    take: MAX_COMMITMENTS,
  })) ?? []) as OpenRow[];
  const known = new Set(active.map((c) => c.id));
  const missing = [...new Set(open.map((o) => o.campaignId))].filter((id) => !known.has(id));
  const extra = missing.length ? (((await prisma.adCampaign.findMany({ where: { tenantId, id: { in: missing } }, select: campaignSelect })) ?? []) as CampaignRow[]) : [];
  const assistantOnly = filter.origin === "assistant";
  const campaigns = [...active, ...extra]
    .filter((c) => !assistantOnly || c.origin === "assistant" || open.some((o) => o.campaignId === c.id && o.origin === "assistant"))
    .sort((a, b) => (b.dailyBudgetMinor ?? 0) - (a.dailyBudgetMinor ?? 0));
  const ids = campaigns.map((c) => c.id);
  const sets = ids.length ? (((await prisma.adSet.findMany({ where: { tenantId, campaignId: { in: ids } }, select: { id: true, campaignId: true, metaAdSetId: true } })) ?? []) as SetRow[]) : [];
  const wanted = filter.metaObjectIds ? new Set(filter.metaObjectIds) : null;

  const targets: Target[] = [];
  const base = (c: CampaignRow) => ({ campaignId: c.id, campaignName: c.name, adAccountAssetId: c.adAccountAssetId, lastError: c.lastError ?? null });
  for (const c of campaigns) {
    const setIds = sets.filter((s) => s.campaignId === c.id && s.metaAdSetId).map((s) => s.metaAdSetId!);
    const openIds = open.filter((o) => o.campaignId === c.id && o.objectLevel === "adset" && !isSynthetic(o.metaObjectId)).map((o) => o.metaObjectId);
    let whole = !wanted || (!!c.metaCampaignId && wanted.has(c.metaCampaignId));
    let named: string[] = [];
    if (!whole) {
      named = [...new Set([...setIds, ...openIds])].filter((id) => wanted!.has(id));
      if (named.length === 0) continue;
      whole = setIds.length > 0 && setIds.every((id) => named.includes(id));
    }
    if (whole && c.metaCampaignId) targets.push({ ...base(c), metaObjectId: c.metaCampaignId, level: "campaign" });
    else for (const id of whole ? [...new Set([...setIds, ...openIds])] : named) targets.push({ ...base(c), metaObjectId: id, level: "adset" });
  }
  // Open commitments whose campaign row is gone are still paused by their own Meta id.
  const rows = new Set([...known, ...extra.map((c) => c.id)]);
  for (const o of open) {
    if (rows.has(o.campaignId) || isSynthetic(o.metaObjectId)) continue;
    if (assistantOnly && o.origin !== "assistant") continue;
    if (wanted && !wanted.has(o.metaObjectId)) continue;
    if (targets.some((t) => t.metaObjectId === o.metaObjectId)) continue;
    targets.push({ campaignId: o.campaignId, campaignName: "", adAccountAssetId: o.adAccountAssetId, lastError: null, metaObjectId: o.metaObjectId, level: o.objectLevel === "campaign" ? "campaign" : "adset" });
  }
  return targets;
}

/** The guarded client for one ad account, or null when its Meta connection can no longer give a token. */
async function clientFor(tenantId: string, adAccountAssetId: string, actor: SpendActor, env: StopOptions["env"]): Promise<AdsClient | null> {
  try {
    const access = await getAssetAccess(tenantId, adAccountAssetId);
    if (access.type !== "ad_account") return null;
    const sandbox = await sandboxFlagFor(tenantId, adAccountAssetId).catch(() => false);
    return adsClient(access.token, access.externalId, { tenantId, adAccountAssetId, actor, sandbox }, { env });
  } catch {
    return null;
  }
}

async function recentlyFailed(tenantId: string, metaObjectId: string, since: Date): Promise<boolean> {
  try {
    const row = await prisma.spendLedger.findFirst({ where: { tenantId, metaObjectId, phase: "failed", createdAt: { gte: since } }, select: { id: true } });
    return !!row;
  } catch {
    return false;
  }
}

/** The database follows Meta once the pause went through. Never throws: the reconciler and the structure sync correct it. */
async function markPausedRow(tenantId: string, t: Target): Promise<void> {
  try {
    if (t.level === "campaign") await prisma.adCampaign.updateMany({ where: { id: t.campaignId, tenantId, status: "active" }, data: { status: "paused" } });
    else await prisma.adSet.updateMany({ where: { tenantId, metaAdSetId: t.metaObjectId }, data: { status: "paused" } });
  } catch (error) {
    console.error(`[ads] paused on Meta but the row was not updated: ${describeError(error)}`);
  }
}

const hold = (tenantId: string, t: Target) => markUnpaused(tenantId, t.level === "campaign" ? { campaignId: t.campaignId } : { metaObjectIds: [t.metaObjectId] });

/** Pauses what the filter covers. Never throws; see the module comment. */
export async function stopCommitments(tenantId: string, filter: StopFilter, actor: SpendActor, reason: string, opts: StopOptions = {}): Promise<StopResult> {
  const result: StopResult = { done: 0, failed: 0, unreachable: 0, skipped: 0, total: 0, items: [] };
  const clock = opts.now ?? Date.now;
  const why = (reason ?? "").trim() || "Spending was stopped, so this was paused.";
  let targets: Target[];
  try {
    targets = await planTargets(tenantId, filter ?? {});
  } catch (error) {
    console.error(`[ads] stop could not list what is running: ${describeError(error)}`);
    return { ...result, failed: 1, total: 1 };
  }
  result.total = targets.length;
  const clients = new Map<string, AdsClient | null>();
  const record = (t: Target, r: StopItemResult) => {
    result.items.push({ ...t, result: r });
    if (r === "done") result.done++;
    else if (r === "failed") result.failed++;
    else if (r === "unreachable") result.unreachable++;
    else result.skipped++;
  };
  for (const t of targets) {
    if (opts.deadline !== undefined && clock() >= opts.deadline) {
      record(t, "skipped");
      continue;
    }
    if (opts.retryFailedAfterMs && (await recentlyFailed(tenantId, t.metaObjectId, new Date(clock() - opts.retryFailedAfterMs)))) {
      record(t, "skipped");
      continue;
    }
    if (!clients.has(t.adAccountAssetId)) clients.set(t.adAccountAssetId, await clientFor(tenantId, t.adAccountAssetId, actor, opts.env));
    const client = clients.get(t.adAccountAssetId) ?? null;
    if (!client) {
      record(t, "unreachable");
      await hold(tenantId, t);
      continue;
    }
    try {
      await recordLowering(tenantId, { kind: "pause", metaObjectId: t.metaObjectId }, actor, why, (permit) => client.setStatus(t.metaObjectId, "PAUSED", permit), { objectLevel: t.level, reasonCodes: ["stop"] });
      await markPausedRow(tenantId, t);
      record(t, "done");
    } catch (error) {
      console.error(`[ads] could not pause ${t.level} on Meta: ${describeError(error)}`);
      record(t, "failed");
      await hold(tenantId, t);
    }
  }
  return result;
}
