/**
 * spend.sync.fast (docs/SPEND-CONTROLS-SPEC.md 6.1, 4.6, 4.16, 8.4). Every 15 minutes, for workspaces with an open commitment
 * or a managed Meta limit, per ad account (the spending account and any account with open commitments):
 *
 * 1. GET act_X/insights level=account time_increment=1 date_preset=this_month fields=spend: SpendDaily account rows
 *    (origin `all`, scope id = the MetaAsset id, account-time-zone days). SET, never incremented: Meta revises spend.
 * 2. GET act_X/insights level=adset filtering=[adset.id IN the open commitments' ad sets] date_preset=today (plus
 *    yesterday until 03:00 account time) fields=spend,impressions,clicks,cpm,ctr,actions: SpendDaily ad set rows (origin
 *    `platform`) and IntradaySpendSample rows. Campaign-budget commitments are read the same way at campaign level.
 * 3. External spend = account - Σ platform, per day, written as origin `external`.
 * Then the structure sync (4.6.1) runs for the account in the same pass, and spend.breakers.run is queued.
 *
 * Reads only. A rate limit backs the workspace off for 30 minutes (PlatformSetting spend:sync:<tenantId>). Skipped: sandbox
 * accounts (SPEND_SIM writes their series), demo assets (8.4) and accounts whose getAssetAccess answers 409, which opens
 * meta_cap_unreachable while commitments are live and leaves the data to go stale (sync_stale, 4.6).
 */
import type { Prisma } from "@/generated/prisma/client";
import { fetchAccountInsights, isRateLimit, type RawInsightRow } from "@/lib/ads/insights-fetch";
import { pickResults, parseCount } from "@/lib/ads/insights-map";
import { prisma } from "@/lib/db";
import { enqueue as enqueueJob } from "@/lib/queue";
import { describeError } from "@/lib/safe-error";
import { clearBreaker, openBreaker } from "../breakers/state";
import { getControl, type SpendDb } from "../control";
import { isDemoAsset } from "../demo";
import { currencyExponent, decimalToMinorBig, isCurrencyCode } from "../money";
import { notifySpend } from "../notify";
import { addDays, dayKey, dayKeyToDate, localParts, monthStartDay, resolveTimeZone, startOfLocalDay } from "../periods";
import { SPEND_QUEUES, type SpendNotice } from "../types";
import { syncStructure } from "./structure";

export const FAST_SYNC_EVERY_MS = 15 * 60_000;
export const SYNC_BACKOFF_MS = 30 * 60_000;
/** Yesterday's ad set rows are refreshed until this hour, account time (late spend lands after midnight). */
export const YESTERDAY_UNTIL_HOUR = 3;
const MAX_PAGES = 10;
const MAX_IDS_PER_REQUEST = 50;
const TENANT_BUDGET_MS = 8 * 60_000;
const OPEN = ["reserved", "live", "unconfirmed"];

export const syncStateKey = (tenantId: string): string => `spend:sync:${tenantId}`;

export type SyncIo = {
  db?: SpendDb;
  env?: Record<string, string | undefined>;
  now?: Date;
  /** The ad account's token (getAssetAccess; HttpError 409 when the connection expired or was revoked). */
  access?: (tenantId: string, adAccountAssetId: string) => Promise<{ token: string; externalId: string }>;
  enqueue?: (queue: string, payload: unknown, opts?: { runAt?: Date }) => Promise<unknown>;
  notify?: (notice: SpendNotice) => Promise<unknown>;
};

export type AccountSyncResult = { adAccountAssetId: string; status: "synced" | "demo" | "sandbox" | "unreachable" | "no_asset" | "rate_limited" | "failed"; dailyRows: number; samples: number };
export type FastSyncResult = { tenantId: string; status: "synced" | "backoff" | "rate_limited" | "nothing"; accounts: AccountSyncResult[] };

type Asset = { id: string; externalId: string; name: string | null; meta: unknown; sandbox?: boolean; status?: string };
type InsightRow = RawInsightRow;

const dbOf = (io: SyncIo): SpendDb => io.db ?? prisma;
const act = (externalId: string): string => `act_${externalId.replace(/^act_/, "")}`;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const max0 = (x: bigint): bigint => (x < 0n ? 0n : x);

export async function tokenFor(io: SyncIo, tenantId: string, adAccountAssetId: string): Promise<{ token: string; externalId: string }> {
  if (io.access) return io.access(tenantId, adAccountAssetId);
  const { getAssetAccess } = await import("@/lib/meta-connect");
  const a = await getAssetAccess(tenantId, adAccountAssetId);
  return { token: a.token, externalId: a.externalId };
}

/** One read of the account's insights edge with cursors (reads only, no permit; ads/insights-fetch.ts makes the call). */
export async function readInsights(token: string, accountExternalId: string, query: Record<string, string>): Promise<InsightRow[]> {
  return fetchAccountInsights(token, accountExternalId, query, MAX_PAGES);
}

export type SpendDailyInput = {
  tenantId: string;
  scopeType: "account" | "campaign" | "adset";
  scopeId: string;
  day: string;
  currency: string;
  amountMinor: bigint;
  origin: "platform" | "external" | "all";
  results?: number | null;
  impressions?: bigint | null;
  clicks?: bigint | null;
  source: "fast_sync" | "insights";
};

/** SETs SpendDaily rows (Meta revises spend for 28 days, so a later read replaces an earlier one). */
export async function setSpendDaily(rows: SpendDailyInput[], syncedAt: Date, db: SpendDb = prisma): Promise<number> {
  let n = 0;
  for (const r of rows) {
    if (!DAY.test(r.day)) continue;
    const key = { tenantId: r.tenantId, pot: "ads", scopeType: r.scopeType, scopeId: r.scopeId, day: dayKeyToDate(r.day), origin: r.origin };
    const values = { currency: r.currency, amountMinor: r.amountMinor, results: r.results ?? null, impressions: r.impressions ?? null, clicks: r.clicks ?? null, source: r.source, syncedAt };
    await db.spendDaily.upsert({ where: { tenantId_pot_scopeType_scopeId_day_origin: key }, create: { ...key, ...values }, update: values });
    n++;
  }
  return n;
}

/** Spend of one insights row in minor units, with no clamp (3.1). Unreadable spend throws: it is never counted as zero. */
export function spendMinorOf(row: Pick<InsightRow, "spend">, currency: string): bigint {
  return decimalToMinorBig(row.spend ?? "0", currencyExponent(currency));
}

const big = (v: unknown): bigint => BigInt(parseCount(v));

/** Workspaces the fast sync covers: any open commitment, or a managed Meta limit. */
export async function fastSyncTenants(db: SpendDb = prisma): Promise<string[]> {
  const a = ((await db.spendCommitment.findMany({ where: { status: { in: OPEN } }, select: { tenantId: true }, take: 5_000 })) ?? []) as { tenantId: string }[];
  const b = ((await db.metaSpendLimit.findMany({ where: { mode: "managed" }, select: { tenantId: true }, take: 2_000 })) ?? []) as { tenantId: string }[];
  return [...new Set([...a, ...b].map((r) => r.tenantId))];
}

type SyncState = { backoffUntil?: string; lastOkAt?: string };

async function loadState(db: SpendDb, tenantId: string): Promise<SyncState> {
  const row = (await db.platformSetting.findUnique({ where: { key: syncStateKey(tenantId) } })) as { value?: unknown } | null;
  return row?.value && typeof row.value === "object" && !Array.isArray(row.value) ? (row.value as SyncState) : {};
}

async function saveState(db: SpendDb, tenantId: string, state: SyncState): Promise<void> {
  const key = syncStateKey(tenantId);
  const value = state as Prisma.InputJsonValue;
  await db.platformSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
}

/** The Meta ids the ad set and campaign reads cover on one account: open commitments, ones stopped today, and DB-active (orphan) ad sets. */
async function objectsToRead(db: SpendDb, tenantId: string, adAccountAssetId: string, todayStart: Date): Promise<{ adsets: string[]; campaigns: string[] }> {
  const rows = ((await db.spendCommitment.findMany({
    where: { tenantId, adAccountAssetId, OR: [{ status: { in: OPEN } }, { status: "stopped", updatedAt: { gte: todayStart } }] },
    select: { metaObjectId: true, objectLevel: true, campaignId: true },
  })) ?? []) as { metaObjectId: string; objectLevel: string; campaignId: string }[];
  const adsets = new Set<string>();
  const campaigns = new Set<string>();
  // Platform rows are kept at the level of the budget holder, so a campaign-budget campaign is read at campaign level only
  // (its ad sets would otherwise be counted twice).
  const campaignLevel = new Set(rows.filter((r) => r.objectLevel === "campaign").map((r) => r.campaignId));
  for (const r of rows) {
    if (r.metaObjectId.startsWith("db:")) continue;
    (r.objectLevel === "campaign" ? campaigns : adsets).add(r.metaObjectId);
  }
  // DB-active campaigns without a commitment yet (orphans, 4.6) are counted too, so their spend must be read.
  const active = ((await db.adCampaign.findMany({ where: { tenantId, adAccountAssetId, status: "active" }, select: { id: true } })) ?? []) as { id: string }[];
  const orphanCampaigns = active.filter((c) => !campaignLevel.has(c.id));
  if (orphanCampaigns.length > 0) {
    const sets = ((await db.adSet.findMany({ where: { tenantId, campaignId: { in: orphanCampaigns.map((c) => c.id) } }, select: { metaAdSetId: true, status: true } })) ?? []) as { metaAdSetId: string | null; status?: string }[];
    for (const s of sets) if (s.metaAdSetId && s.status !== "archived" && s.status !== "deleted") adsets.add(s.metaAdSetId);
  }
  return { adsets: [...adsets], campaigns: [...campaigns] };
}

/** Every Meta id of an Edwyz object on the account (platform spend), for step 3. */
async function platformIds(db: SpendDb, tenantId: string, adAccountAssetId: string): Promise<string[]> {
  const ids = new Set<string>();
  const commitments = ((await db.spendCommitment.findMany({ where: { tenantId, adAccountAssetId }, select: { metaObjectId: true }, take: 5_000 })) ?? []) as { metaObjectId: string }[];
  for (const c of commitments) if (!c.metaObjectId.startsWith("db:")) ids.add(c.metaObjectId);
  const campaigns = ((await db.adCampaign.findMany({ where: { tenantId, adAccountAssetId }, select: { id: true, metaCampaignId: true }, take: 2_000 })) ?? []) as { id: string; metaCampaignId: string | null }[];
  for (const c of campaigns) if (c.metaCampaignId) ids.add(c.metaCampaignId);
  if (campaigns.length > 0) {
    const sets = ((await db.adSet.findMany({ where: { tenantId, campaignId: { in: campaigns.map((c) => c.id) } }, select: { metaAdSetId: true } })) ?? []) as { metaAdSetId: string | null }[];
    for (const s of sets) if (s.metaAdSetId) ids.add(s.metaAdSetId);
  }
  return [...ids];
}

function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * Steps 1-3 for one ad account, then its structure sync. Throws InsightsRateLimit-style errors (isRateLimit) to the caller,
 * which backs the workspace off.
 */
export async function syncAccountFast(tenantId: string, asset: Asset, io: SyncIo & { timezone: string }): Promise<AccountSyncResult> {
  const db = dbOf(io);
  const now = io.now ?? new Date();
  const result: AccountSyncResult = { adAccountAssetId: asset.id, status: "synced", dailyRows: 0, samples: 0 };
  if (isDemoAsset(asset)) return { ...result, status: "demo" };
  if (asset.sandbox === true) return { ...result, status: "sandbox" };
  let token: string;
  try {
    token = (await tokenFor(io, tenantId, asset.id)).token;
  } catch (error) {
    if ((error as { status?: unknown })?.status === 409) {
      await unreachable(io, tenantId, asset, now);
      return { ...result, status: "unreachable" };
    }
    return { ...result, status: "failed" };
  }
  // Reachable again: a meta_cap_unreachable this sync opened earlier clears (metacap clears its own on its next read too).
  await clearBreaker({ tenantId, kind: "meta_cap_unreachable", scopeType: "ad_account", scopeId: asset.id }, { db, now, reason: "Edwyz can reach Meta for this ad account again." }).catch(() => undefined);
  const metaTz = asset.meta && typeof asset.meta === "object" ? (asset.meta as { timezone?: unknown }).timezone : null;
  const tz = resolveTimeZone(typeof metaTz === "string" ? metaTz : io.timezone);
  const metaCurrency = asset.meta && typeof asset.meta === "object" ? (asset.meta as { currency?: unknown }).currency : null;
  const currency = isCurrencyCode(metaCurrency) ? metaCurrency : "INR";
  const today = dayKey(now, tz);
  const monthFirst = monthStartDay(today.slice(0, 7));

  // 1. Whole-account spend, this month, per account day (origin all).
  const accountRows = await readInsights(token, asset.externalId, { level: "account", time_increment: "1", date_preset: "this_month", fields: "spend" });
  const accountByDay = new Map<string, bigint>();
  for (const r of accountRows) if (r.date_start && DAY.test(r.date_start) && r.date_start >= monthFirst) accountByDay.set(r.date_start, spendMinorOf(r, currency));
  if (!accountByDay.has(today)) accountByDay.set(today, 0n);
  result.dailyRows += await setSpendDaily(
    [...accountByDay].map(([day, amount]) => ({ tenantId, scopeType: "account" as const, scopeId: asset.id, day, currency, amountMinor: amount, origin: "all" as const, source: "fast_sync" as const })),
    now,
    db,
  );
  await db.intradaySpendSample.create({ data: { tenantId, adAccountAssetId: asset.id, entityType: "account", entityMetaId: asset.id, accountDate: dayKeyToDate(today), sampledAt: now, spendMinor: accountByDay.get(today) ?? 0n, impressions: 0n, clicks: 0n, results: 0 } });
  result.samples++;

  // 2. Ad sets (and campaign-budget campaigns) of the open commitments: today, plus yesterday until 03:00 account time.
  const { adsets, campaigns } = await objectsToRead(db, tenantId, asset.id, startOfLocalDay(today, tz));
  const presets = localParts(now, tz).hour < YESTERDAY_UNTIL_HOUR ? ["today", "yesterday"] : ["today"];
  const levels: { level: "adset" | "campaign"; ids: string[]; field: "adset.id" | "campaign.id" }[] = [
    { level: "adset", ids: adsets, field: "adset.id" },
    { level: "campaign", ids: campaigns, field: "campaign.id" },
  ];
  for (const { level, ids, field } of levels) {
    for (const part of chunks(ids, MAX_IDS_PER_REQUEST)) {
      for (const preset of presets) {
        const rows = await readInsights(token, asset.externalId, {
          level,
          date_preset: preset,
          filtering: JSON.stringify([{ field, operator: "IN", value: part }]),
          fields: `${level === "adset" ? "adset_id,campaign_id" : "campaign_id"},spend,impressions,clicks,cpm,ctr,actions`,
        });
        const day = preset === "today" ? today : addDays(today, -1);
        const seen = new Set<string>();
        const daily: SpendDailyInput[] = [];
        for (const r of rows) {
          const id = level === "adset" ? r.adset_id : r.campaign_id;
          if (!id) continue;
          seen.add(id);
          const spend = spendMinorOf(r, currency);
          const { results } = pickResults(undefined, r.actions);
          daily.push({ tenantId, scopeType: level, scopeId: id, day: r.date_start && DAY.test(r.date_start) ? r.date_start : day, currency, amountMinor: spend, origin: "platform", results, impressions: big(r.impressions), clicks: big(r.clicks), source: "fast_sync" });
          if (preset === "today" && level === "adset") {
            await db.intradaySpendSample.create({ data: { tenantId, adAccountAssetId: asset.id, entityType: "adset", entityMetaId: id, accountDate: dayKeyToDate(today), sampledAt: now, spendMinor: spend, impressions: big(r.impressions), clicks: big(r.clicks), results } });
            result.samples++;
          }
        }
        // No row means no spend today: recorded as 0, so the book knows the data is fresh.
        if (preset === "today") for (const id of part) if (!seen.has(id)) daily.push({ tenantId, scopeType: level, scopeId: id, day, currency, amountMinor: 0n, origin: "platform", source: "fast_sync" });
        result.dailyRows += await setSpendDaily(daily, now, db);
      }
    }
  }

  // 3. Outside spend = account - Σ platform, per day.
  const ids = await platformIds(db, tenantId, asset.id);
  const platform = new Map<string, bigint>();
  if (ids.length > 0) {
    const rows = ((await db.spendDaily.findMany({ where: { tenantId, pot: "ads", origin: "platform", scopeType: { in: ["adset", "campaign"] }, scopeId: { in: ids }, day: { gte: dayKeyToDate(monthFirst) } }, select: { day: true, amountMinor: true } })) ?? []) as { day: Date; amountMinor: bigint | number }[];
    for (const r of rows) {
      const d = r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day).slice(0, 10);
      platform.set(d, (platform.get(d) ?? 0n) + BigInt(r.amountMinor));
    }
  }
  result.dailyRows += await setSpendDaily(
    [...accountByDay].map(([day, all]) => ({ tenantId, scopeType: "account" as const, scopeId: asset.id, day, currency, amountMinor: max0(all - (platform.get(day) ?? 0n)), origin: "external" as const, source: "fast_sync" as const })),
    now,
    db,
  );

  // The structure sync (4.6.1) in the same pass, after step 2, so a campaign resumed in Ads Manager counts from now on.
  try {
    await syncStructure(tenantId, asset.id, { ...io, token, asset });
  } catch (error) {
    if (isRateLimit(error)) throw error;
    console.error(`[spend] structure sync of ${asset.id} failed: ${describeError(error)}`);
  }
  return result;
}

async function unreachable(io: SyncIo, tenantId: string, asset: Asset, now: Date): Promise<void> {
  const db = dbOf(io);
  const live = Number(await db.spendCommitment.count({ where: { tenantId, adAccountAssetId: asset.id, status: { in: OPEN } } }));
  if (live === 0) return;
  await openBreaker(
    { tenantId, kind: "meta_cap_unreachable", scopeType: "ad_account", scopeId: asset.id, effect: "block_raises", reason: "Edwyz can't reach Meta for this ad account, so assistants can't raise anything on it until it is connected again.", details: { since: now.toISOString() } },
    { db, now },
  ).catch((e: unknown) => console.error(`[spend] meta_cap_unreachable not opened: ${describeError(e)}`));
  await (io.notify ?? notifySpend)({
    tenantId,
    kind: "meta_limit",
    severity: "action_needed",
    audience: "owner",
    dedupeKey: `sync:unreachable:${asset.id}:${now.toISOString().slice(0, 10)}`,
    title: "Connect Meta again",
    body: `We can't read spend for ${asset.name?.trim() || act(asset.externalId)} because its Meta connection expired or was removed. Connect again in Settings > Connections.`,
    link: "/app/settings/connections",
    subjectType: "ad_account",
    subjectId: asset.id,
  }).catch(() => undefined);
}

/** The fast sync of one workspace (6.1). Never throws. */
export async function syncTenantFast(tenantId: string, io: SyncIo = {}): Promise<FastSyncResult> {
  const db = dbOf(io);
  const now = io.now ?? new Date();
  const state = await loadState(db, tenantId).catch(() => ({}) as SyncState);
  if (state.backoffUntil && Date.parse(state.backoffUntil) > now.getTime()) return { tenantId, status: "backoff", accounts: [] };
  const control = await getControl(tenantId, { db, prune: false });
  const commitmentAccounts = ((await db.spendCommitment.findMany({ where: { tenantId, status: { in: OPEN } }, select: { adAccountAssetId: true }, take: 5_000 })) ?? []) as { adAccountAssetId: string }[];
  const managed = ((await db.metaSpendLimit.findMany({ where: { tenantId, mode: "managed" }, select: { adAccountAssetId: true } })) ?? []) as { adAccountAssetId: string }[];
  const accountIds = [...new Set([...commitmentAccounts.map((r) => r.adAccountAssetId), ...managed.map((r) => r.adAccountAssetId)])];
  if (accountIds.length === 0) return { tenantId, status: "nothing", accounts: [] };
  const out: AccountSyncResult[] = [];
  for (const id of accountIds) {
    const asset = (await db.metaAsset.findFirst({ where: { id, tenantId, type: "ad_account" } })) as Asset | null;
    if (!asset) {
      out.push({ adAccountAssetId: id, status: "no_asset", dailyRows: 0, samples: 0 });
      continue;
    }
    try {
      out.push(await syncAccountFast(tenantId, asset, { ...io, timezone: control.timezone }));
    } catch (error) {
      if (isRateLimit(error)) {
        await saveState(db, tenantId, { ...state, backoffUntil: new Date(now.getTime() + SYNC_BACKOFF_MS).toISOString() }).catch(() => undefined);
        out.push({ adAccountAssetId: id, status: "rate_limited", dailyRows: 0, samples: 0 });
        return { tenantId, status: "rate_limited", accounts: out };
      }
      console.error(`[spend] fast sync of ${id} failed: ${describeError(error)}`);
      out.push({ adAccountAssetId: id, status: "failed", dailyRows: 0, samples: 0 });
    }
  }
  if (out.some((r) => r.status === "synced")) await saveState(db, tenantId, { lastOkAt: now.toISOString() }).catch(() => undefined);
  // The breakers run right after each sync (6.1).
  await (io.enqueue ?? enqueueJob)(SPEND_QUEUES.breakersRun, { tenantId, reason: "fast_sync" }).catch((e: unknown) => console.error(`[spend] breakers run not queued: ${describeError(e)}`));
  return { tenantId, status: "synced", accounts: out };
}

/** Every workspace the fast sync covers, within a time budget. Never throws. */
export async function runFastSync(io: SyncIo = {}): Promise<FastSyncResult[]> {
  const started = Date.now();
  const out: FastSyncResult[] = [];
  let tenants: string[] = [];
  try {
    tenants = await fastSyncTenants(dbOf(io));
  } catch (error) {
    console.error(`[spend] fast sync tenants: ${describeError(error)}`);
    return out;
  }
  for (const tenantId of tenants) {
    if (Date.now() - started > TENANT_BUDGET_MS) break;
    try {
      out.push(await syncTenantFast(tenantId, io));
    } catch (error) {
      console.error(`[spend] fast sync of ${tenantId} failed: ${describeError(error)}`);
    }
  }
  return out;
}
