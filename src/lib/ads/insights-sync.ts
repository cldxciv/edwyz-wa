import { prisma } from "@/lib/db";
import { enqueue } from "@/lib/queue";
import { sanitizeMessage } from "@/lib/safe-error";
import { tenantMayRunBackground } from "@/lib/tenant-state";
import { HttpError } from "@/lib/tenancy";
import { getAssetAccess, listAssets } from "@/lib/meta-connect";
import { addDays as addDayKey, dayKey, resolveTimeZone } from "@/lib/spend/periods";
import type { SpendDailyInput } from "@/lib/spend/sync/fast-insights";
import { LEVELS, InsightsRateLimitError, entityIdOf, exactSpendMinor, fetchLevel, type RawInsightRow } from "./insights-fetch";
import { currencyExponent } from "./insights-money";
import { loadState, patchState, toSnapshot, upsertSnapshots, type SnapshotData } from "./insights-store";

export const SYNC_QUEUE = "ads.insights.sync";
export const BACKFILL_DAYS = 30;
export const REFRESH_DAYS = 3;
export const MANUAL_COOLDOWN_MS = 15 * 60_000;
export const RATE_LIMIT_BACKOFF_MS = 30 * 60_000;
const TIME_BUDGET_MS = 8 * 60_000;

export type TenantSyncResult = { tenantId: string; accounts: number; rows: number; rateLimited: boolean; errors: string[] };

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

/** UTC calendar window. VERIFY: Meta reads time_range in the ad account's time zone, so the last day may be one ahead of or behind it. */
export function syncWindow(backfilled: boolean, now: Date): { since: string; until: string } {
  return { since: ymd(addDays(now, -((backfilled ? REFRESH_DAYS : BACKFILL_DAYS) - 1))), until: ymd(now) };
}

function currencyOf(meta: unknown): string | null {
  const c = (meta as { currency?: unknown } | null)?.currency;
  return typeof c === "string" ? c : null;
}

async function syncAccount(tenantId: string, asset: { id: string; meta: unknown }, backfilled: boolean, now: Date): Promise<number> {
  const access = await getAssetAccess(tenantId, asset.id);
  const exponent = currencyExponent(currencyOf(asset.meta));
  const { since, until } = syncWindow(backfilled, now);
  let total = 0;
  for (const level of LEVELS) {
    const { rows } = await fetchLevel(access.token, access.externalId, level, since, until);
    const items = rows.map((r) => toSnapshot(tenantId, level, r, exponent)).filter((x): x is SnapshotData => x !== null);
    total += await upsertSnapshots(items);
    // The exact figure (no 32-bit clamp) is what the spend controls count; a clamped snapshot is logged as insights.clamped.
    const exact = rows.map((r) => ({ row: r, spend: exactSpendMinor(r, exponent, { level, id: entityIdOf(level, r) }) }));
    if (level === "adset") {
      await setOlderSpendDaily(tenantId, asset, exact, now).catch((e: unknown) => console.warn(`[insights] spend history not stored: ${sanitizeMessage(e instanceof Error ? e.message : "failed")}`));
    }
  }
  return total;
}

/** Days the fast sync no longer refreshes: before yesterday in the ad account's time zone. */
export function olderThanFastSync(now: Date, timezone: string): string {
  return addDayKey(dayKey(now, timezone), -1);
}

/**
 * The 6-hour sync also SETs SpendDaily for older days (docs/SPEND-CONTROLS-SPEC.md 6.1): Meta revises spend for up to 28
 * days. Only Edwyz's own campaigns (origin platform), at the level of the budget holder: ad set rows, or one campaign row per
 * day for a campaign whose budget is at campaign level (so nothing is counted twice). Today and yesterday stay with the
 * fast sync.
 */
async function setOlderSpendDaily(tenantId: string, asset: { id: string; meta: unknown }, rows: { row: RawInsightRow; spend: { minor: bigint } | null }[], now: Date): Promise<void> {
  if (rows.length === 0) return;
  const campaigns = ((await prisma.adCampaign.findMany({ where: { tenantId, metaCampaignId: { not: null } }, select: { id: true, metaCampaignId: true } })) ?? []) as { id: string; metaCampaignId: string | null }[];
  const platform = new Set(campaigns.map((c) => c.metaCampaignId).filter((x): x is string => !!x));
  if (platform.size === 0) return;
  const campaignLevel = new Set(
    (((await prisma.spendCommitment.findMany({ where: { tenantId, adAccountAssetId: asset.id, objectLevel: "campaign" }, select: { metaObjectId: true } })) ?? []) as { metaObjectId: string }[]).map((r) => r.metaObjectId),
  );
  const tzRaw = (asset.meta as { timezone?: unknown } | null)?.timezone;
  const cutoff = olderThanFastSync(now, resolveTimeZone(typeof tzRaw === "string" ? tzRaw : null));
  const currency = currencyOf(asset.meta) ?? "INR";
  const byKey = new Map<string, SpendDailyInput>();
  for (const { row, spend } of rows) {
    if (!spend || !row.adset_id || !row.campaign_id || !row.date_start || !platform.has(row.campaign_id) || row.date_start >= cutoff) continue;
    const atCampaign = campaignLevel.has(row.campaign_id);
    const scopeId = atCampaign ? row.campaign_id : row.adset_id;
    const key = `${atCampaign ? "campaign" : "adset"}:${scopeId}:${row.date_start}`;
    const prev = byKey.get(key);
    byKey.set(key, {
      tenantId,
      scopeType: atCampaign ? "campaign" : "adset",
      scopeId,
      day: row.date_start,
      currency,
      amountMinor: (prev?.amountMinor ?? 0n) + spend.minor,
      origin: "platform",
      impressions: BigInt(Number(row.impressions ?? 0) || 0) + (prev?.impressions ?? 0n),
      clicks: BigInt(Number(row.clicks ?? 0) || 0) + (prev?.clicks ?? 0n),
      source: "insights",
    });
  }
  if (byKey.size === 0) return;
  const { setSpendDaily } = await import("@/lib/spend/sync/fast-insights");
  await setSpendDaily([...byKey.values()], now);
}

/** Syncs every active ad account of one tenant. A rate limit stops the tenant and sets a backoff; the next run resumes. */
export async function syncTenant(tenantId: string, now = new Date()): Promise<TenantSyncResult> {
  const result: TenantSyncResult = { tenantId, accounts: 0, rows: 0, rateLimited: false, errors: [] };
  if (!(await tenantMayRunBackground(tenantId))) return result;
  const state = await loadState(tenantId);
  const assets = (await listAssets(tenantId, "ad_account")).filter((a) => a.status === "active");
  const done: Record<string, { ok: boolean; backoff?: boolean }> = {};

  for (const asset of assets) {
    const acc = state.accounts[asset.id] ?? {};
    if (acc.backoffUntil && Date.parse(acc.backoffUntil) > now.getTime()) {
      result.rateLimited = true;
      continue;
    }
    try {
      result.rows += await syncAccount(tenantId, asset, !!acc.backfilledAt, now);
      result.accounts++;
      done[asset.id] = { ok: true };
    } catch (e) {
      if (e instanceof InsightsRateLimitError) {
        result.rateLimited = true;
        done[asset.id] = { ok: false, backoff: true };
        break;
      }
      if (e instanceof HttpError && e.status === 409) continue;
      result.errors.push(sanitizeMessage(e instanceof Error ? e.message : "sync failed"));
      done[asset.id] = { ok: false };
    }
  }

  await patchState(tenantId, (s) => {
    for (const [id, d] of Object.entries(done)) {
      const a = (s.accounts[id] ??= {});
      if (d.ok) {
        a.backfilledAt ??= now.toISOString();
        delete a.backoffUntil;
      } else if (d.backoff) a.backoffUntil = new Date(now.getTime() + RATE_LIMIT_BACKOFF_MS).toISOString();
    }
    s.lastSyncAt = now.toISOString();
    s.lastError = result.errors[0] ?? (result.rateLimited ? "Meta rate limit reached; the sync resumes on its next run." : null);
  });
  return result;
}

/** Tenants that have at least one active Meta connection. */
export async function tenantsWithActiveConnection(): Promise<string[]> {
  const rows = await prisma.metaConnection.findMany({ where: { status: "active" }, select: { tenantId: true }, distinct: ["tenantId"] });
  return rows.map((r) => r.tenantId);
}

export async function runInsightsSync(now = new Date()): Promise<TenantSyncResult[]> {
  const started = Date.now();
  const out: TenantSyncResult[] = [];
  for (const tenantId of await tenantsWithActiveConnection()) {
    if (Date.now() - started > TIME_BUDGET_MS) break;
    try {
      out.push(await syncTenant(tenantId, now));
    } catch (e) {
      out.push({ tenantId, accounts: 0, rows: 0, rateLimited: false, errors: [sanitizeMessage(e instanceof Error ? e.message : "sync failed")] });
    }
  }
  return out;
}

export async function nextManualSyncAt(tenantId: string, now = new Date()): Promise<Date | null> {
  const { lastManualAt } = await loadState(tenantId);
  const next = lastManualAt ? Date.parse(lastManualAt) + MANUAL_COOLDOWN_MS : 0;
  return next > now.getTime() ? new Date(next) : null;
}

/** Queues a sync for the tenant unless one was requested in the last 15 minutes. Throws HttpError 429 or 409. */
export async function requestManualSync(tenantId: string, now = new Date()): Promise<{ nextAllowedAt: Date }> {
  const wait = await nextManualSyncAt(tenantId, now);
  if (wait) throw new HttpError(429, `A sync was requested recently. Try again in ${Math.ceil((wait.getTime() - now.getTime()) / 60_000)} minutes.`);
  const connected = await prisma.metaConnection.count({ where: { tenantId, status: "active" } });
  if (!connected) throw new HttpError(409, "Connect a Meta account first.");
  await patchState(tenantId, (s) => {
    s.lastManualAt = now.toISOString();
  });
  await enqueue(SYNC_QUEUE, { tenantId }, { maxAttempts: 2 });
  return { nextAllowedAt: new Date(now.getTime() + MANUAL_COOLDOWN_MS) };
}
