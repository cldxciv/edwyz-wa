import { prisma } from "@/lib/db";
import { GraphError } from "@/lib/graph";
import { log } from "@/lib/log";
import { enqueue } from "@/lib/queue";
import { sanitizeMessage } from "@/lib/safe-error";
import { tenantMayRunBackground } from "@/lib/tenant-state";
import { HttpError } from "@/lib/tenancy";
import { getAssetAccess, listAssets } from "@/lib/meta-connect";
import { campaignResultKey, goalResultActions, isReachGoal } from "@/lib/promote/breakdowns";
import type { BreakdownDimension } from "@/lib/promote/catalog/breakdowns";
import { adAccountScope, PRIORITY, PromoteThrottledError, throttle as promoteThrottle, type Throttle } from "@/lib/promote/throttle";
import { isDemoAsset } from "@/lib/spend/demo";
import { addDays as addDayKey, dayKey, resolveTimeZone } from "@/lib/spend/periods";
import type { SpendDailyInput } from "@/lib/spend/sync/fast-insights";
import { BREAKDOWN_FILTER_MAX, LEVELS, InsightsRateLimitError, entityIdOf, exactSpendMinor, fetchBreakdown, fetchLevel, type InsightsPace, type RawInsightRow } from "./insights-fetch";
import { currencyExponent } from "./insights-money";
import {
  BREAKDOWN_ROWS_PER_SYNC,
  type AccountState,
  loadBreakdownState,
  loadState,
  patchBreakdownState,
  patchState,
  pruneBreakdowns,
  toBreakdown,
  toSnapshot,
  upsertBreakdowns,
  upsertSnapshots,
  type BreakdownContext,
  type BreakdownData,
  type SnapshotData,
} from "./insights-store";

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

// =====================================================================================================================
// Results breakdowns (docs/IG-PAGE-ADS-SPEC.md 3.10, 4.2 R3, R3a, R4, R5, 4.9, 5.5; PRM-12). Run by the promote worker's
// promote.breakdowns task every 6 hours (src/lib/promote/tasks/breakdowns.ts), so they follow PROMOTE_ENABLED.
//
// - Edwyz's own campaigns only: launched (a Meta campaign id), and running or changed in the last 30 days.
// - Per ad account and per dimension: a dimension backfills 30 days until all its reads finish uncut, then refreshes the last
//   3, in the account's time zone (D30). A dimension cut by the row cap, or refused by Meta, backfills again on the next run.
// - Reads, in order of importance, so a cut-off sync keeps what matters most: the run totals (R3a, one read per start day, from
//   the run's start to today; per version too for a fair test whose result is people reached), placements (R3), age and gender
//   and region (R5), then the assets of per-placement-asset ads (R4). A read Meta refuses is logged
//   (insights.breakdowns.read_failed) and the others still run; busy, a rate limit or a dead token stop the account.
// - Throttle priority 5 (4.9): a cooldown or high usage holds the account until a later run; a rate limit backs it off 30 minutes.
// - Caps (5.5): at most 20,000 rows a sync, and 100,000 a workspace (the oldest daily rows are dropped first).
// - A run takes no new workspace after BREAKDOWN_TASK_BUDGET_MS; the workspaces synced longest ago go first next time.
// =====================================================================================================================

/** A run takes no new workspace after this long. */
export const BREAKDOWN_TASK_BUDGET_MS = 4 * 60_000;

export type BreakdownSyncResult = { campaigns: number; rows: number; failed: number };
export type TenantBreakdownResult = { tenantId: string; accounts: number; campaigns: number; rows: number; truncated: boolean; rateLimited: boolean; pruned: number; errors: string[] };
export type BreakdownSyncOptions = {
  /** The promote throttle (default: the process-wide one on PlatformSetting). */
  throttle?: Throttle;
  /** Rows per sync (default and maximum BREAKDOWN_ROWS_PER_SYNC). */
  maxRows?: number;
};

const DAY_MS = 86_400_000;
const LIVE_STATUSES = ["active", "paused", "archived"];

/** Edwyz's launched campaigns that may have delivered in the last 30 days: running, or changed (paused, ended, archived) since. */
export function platformCampaignWhere(now: Date) {
  const since = new Date(now.getTime() - BACKFILL_DAYS * DAY_MS);
  return {
    metaCampaignId: { not: null },
    status: { in: LIVE_STATUSES },
    AND: [{ OR: [{ status: "active" }, { updatedAt: { gte: since } }] }, { OR: [{ endsAt: null }, { endsAt: { gte: since } }] }],
  };
}

const CAMPAIGN_SELECT = {
  id: true,
  metaCampaignId: true,
  adAccountAssetId: true,
  goal: true,
  template: true,
  objective: true,
  startsAt: true,
  launchedAt: true,
  adSets: { select: { metaAdSetId: true, variantKey: true, optimizationGoal: true, ads: { select: { metaAdId: true, format: true, creative: true } } } },
} as const;

type PlatformCampaign = {
  id: string;
  metaCampaignId: string | null;
  adAccountAssetId: string;
  goal: string | null;
  template: string;
  objective: string;
  startsAt: Date | null;
  launchedAt: Date | null;
  adSets: { metaAdSetId?: string | null; variantKey?: string | null; optimizationGoal?: string | null; ads: { metaAdId: string | null; format: string; creative: unknown }[] }[];
};

/** The daily dimensions. Each one is backfilled 30 days on its own; the run total always reads the whole run. */
export const BACKFILL_DIMENSIONS = ["placement", "age_gender", "region", "asset_body", "asset_title", "asset_image", "asset_video", "asset_cta"] as const satisfies readonly BreakdownDimension[];
type DailyDimension = (typeof BACKFILL_DIMENSIONS)[number];

/** The dimensions whose backfill is done for an account: those in `dims`, or all of them when only `backfilledAt` was kept. */
export function backfilledDimensions(acc: AccountState): Set<string> {
  if (acc.dims) return new Set(Object.keys(acc.dims).filter((k) => !!acc.dims?.[k]));
  return new Set<string>(acc.backfilledAt ? BACKFILL_DIMENSIONS : []);
}

/**
 * The action types a row of this campaign counts (insights-map resultActionsForOptimization): from the ad set's optimisation,
 * or, for a campaign-level row, from the one optimisation every ad set shares. Null when that is unknown.
 */
export function campaignResultActions(c: Pick<PlatformCampaign, "goal" | "template" | "objective" | "adSets">, metaAdSetId: string | null): readonly string[] | null {
  const sets = metaAdSetId ? c.adSets.filter((s) => s.metaAdSetId === metaAdSetId) : c.adSets;
  return goalResultActions(campaignResultKey(c), sets.map((s) => s.optimizationGoal));
}

/** A campaign whose versions need their own run total: its result is people reached, and it compares two or more versions. */
const comparesReach = (c: PlatformCampaign) => isReachGoal(campaignResultKey(c)) && c.adSets.filter((s) => s.variantKey && s.metaAdSetId).length > 1;

/** An ad with per-placement assets (4.3): one picture or video for feeds and a tall one for Stories and Reels. R4 reads only these. */
export function isPlacementAssetAd(ad: { format?: string | null; creative?: unknown }): boolean {
  if (ad.format !== "single_image" && ad.format !== "single_video") return false;
  const media = (ad.creative as { media?: Record<string, unknown> } | null)?.media;
  if (!media || typeof media !== "object") return false;
  const has = (k: string) => typeof media[k] === "string" && (media[k] as string).length > 0;
  return has("vertical") && (has("feed") || has("square") || has("video"));
}

/** The run's start day in the account's zone (the run total's row date), or null before it starts or when it has none. */
export function runStartDay(c: { startsAt: Date | null; launchedAt: Date | null }, timeZone: string, today: string): string | null {
  const start = c.startsAt ?? c.launchedAt;
  if (!start) return null;
  const day = dayKey(start, timeZone);
  return day <= today ? day : null;
}

const chunks = <T>(items: readonly T[], size = BREAKDOWN_FILTER_MAX): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

/** The promote throttle as the breakdown reads' pace (priority 5). Pacing never changes a read's outcome. */
export function breakdownPace(throttle: Throttle, externalId: string): InsightsPace {
  const scope = adAccountScope(externalId);
  return {
    before: () => throttle.check(scope, PRIORITY.breakdowns),
    onHeaders: (headers) => void throttle.noteHeaders(scope, headers).catch(() => undefined),
    onError: async (e) => void (await throttle.noteError(scope, { code: e.code ?? null, subcode: e.subcode ?? null })),
  };
}

type Progress = { rows: number; truncated: boolean };

/** What one account's sync got done: the dimensions whose reads all finished, and the reads Meta refused. */
type AccountOutcome = { completed: Set<DailyDimension>; failures: { dimension: BreakdownDimension; error: string }[] };

/** Errors that stop the account: Meta busy or rate limited (back off), or a token Meta no longer accepts (every read would fail). */
const stopsAccount = (e: unknown) => e instanceof InsightsRateLimitError || e instanceof PromoteThrottledError || (e instanceof GraphError && e.code === 190);

async function syncAccountBreakdowns(
  tenantId: string,
  asset: { id: string; meta: unknown },
  campaigns: PlatformCampaign[],
  backfilled: ReadonlySet<string>,
  now: Date,
  progress: Progress,
  maxRows: number,
  throttle: Throttle,
  outcome: AccountOutcome,
): Promise<void> {
  const access = await getAssetAccess(tenantId, asset.id);
  const tzRaw = (asset.meta as { timezone?: unknown } | null)?.timezone;
  const tz = resolveTimeZone(typeof tzRaw === "string" ? tzRaw : null);
  const today = dayKey(now, tz);
  // Each dimension on its own: 30 days until its backfill is done, then the last 3.
  const sinceFor = (dimension: DailyDimension) => addDayKey(today, -((backfilled.has(dimension) ? REFRESH_DAYS : BACKFILL_DAYS) - 1));
  const pace = breakdownPace(throttle, access.externalId);
  const byMetaId = new Map(campaigns.map((c) => [String(c.metaCampaignId), c]));
  const ctx: BreakdownContext = {
    exponent: currencyExponent(currencyOf(asset.meta)),
    resultKeyOf: (id) => {
      const c = byMetaId.get(id);
      return c ? campaignResultKey(c) : null;
    },
    resultActionsOf: ({ campaignId, adSetId }) => {
      const c = byMetaId.get(campaignId);
      return c ? campaignResultActions(c, adSetId) : null;
    },
    runStartOf: (id) => {
      const c = byMetaId.get(id);
      return c ? runStartDay(c, tz, today) : null;
    },
  };

  /**
   * One read, stored. True when it finished with nothing cut. A read Meta refuses (anything but busy, a rate limit or a dead
   * token) is logged and recorded, and the sync goes on with the next read, so one refused breakdown never holds back the rest.
   */
  const read = async (dimension: BreakdownDimension, ids: { campaignIds?: string[]; adIds?: string[] }, from: string, until: string, level?: "adset"): Promise<boolean> => {
    const left = maxRows - progress.rows;
    if (left <= 0) {
      progress.truncated = true;
      return false;
    }
    let fetched: { rows: RawInsightRow[]; truncated: boolean };
    try {
      fetched = await fetchBreakdown(access.token, access.externalId, { dimension, since: from, until, ...ids, ...(level ? { level } : {}) }, { maxRows: left, pace });
    } catch (e) {
      if (stopsAccount(e)) throw e;
      const error = sanitizeMessage(e instanceof Error ? e.message : "read failed");
      log.warn("insights.breakdowns.read_failed", { tenantId, account: asset.id, dimension, level: level ?? null, error });
      outcome.failures.push({ dimension, error });
      return false;
    }
    if (fetched.truncated) progress.truncated = true;
    const items = fetched.rows.map((r) => toBreakdown(tenantId, dimension, r, ctx, level ? { level } : {})).filter((x): x is BreakdownData => x !== null);
    progress.rows += await upsertBreakdowns(items, now);
    return !fetched.truncated;
  };

  /** Reads one daily dimension in batches; it counts as backfilled only when every batch finished. */
  const readDaily = async (dimension: DailyDimension, batches: { campaignIds?: string[]; adIds?: string[] }[]) => {
    let complete = true;
    for (const ids of batches) if (!(await read(dimension, ids, sinceFor(dimension), today))) complete = false;
    if (complete) outcome.completed.add(dimension);
  };

  // R3a: the run's reach, one read per start day (the time range is the run), never a sum of daily rows.
  const byStart = new Map<string, PlatformCampaign[]>();
  for (const c of campaigns) {
    const start = runStartDay(c, tz, today);
    if (start) byStart.set(start, [...(byStart.get(start) ?? []), c]);
  }
  const starts = [...byStart].sort(([a], [b]) => a.localeCompare(b));
  for (const [start, list] of starts) {
    for (const part of chunks(list.map((c) => String(c.metaCampaignId)))) await read("run_total", { campaignIds: part }, start, today);
  }
  // The same per version, for a fair test whose result is people reached: each version's reach over the run, one row per ad set.
  for (const [start, list] of starts) {
    for (const part of chunks(list.filter(comparesReach).map((c) => String(c.metaCampaignId)))) await read("run_total", { campaignIds: part }, start, today, "adset");
  }
  const campaignBatches = chunks([...byMetaId.keys()]).map((part) => ({ campaignIds: part }));
  for (const dimension of ["placement", "age_gender", "region"] as const) await readDaily(dimension, campaignBatches);
  const assetAds = [
    ...new Set(campaigns.flatMap((c) => c.adSets.flatMap((s) => s.ads.filter((a) => a.metaAdId && /^\d{1,30}$/.test(a.metaAdId) && isPlacementAssetAd(a)).map((a) => String(a.metaAdId))))),
  ];
  const adBatches = chunks(assetAds).map((part) => ({ adIds: part }));
  for (const dimension of ["asset_body", "asset_title", "asset_image", "asset_video", "asset_cta"] as const) await readDaily(dimension, adBatches);
}

/**
 * Syncs the breakdowns of one workspace's own campaigns, account by account, within the per-sync row cap, then keeps the
 * workspace under its row cap. Rows already read stay stored when Meta stops a later read.
 */
export async function syncBreakdownsTenant(tenantId: string, now = new Date(), opts: BreakdownSyncOptions = {}): Promise<TenantBreakdownResult> {
  const result: TenantBreakdownResult = { tenantId, accounts: 0, campaigns: 0, rows: 0, truncated: false, rateLimited: false, pruned: 0, errors: [] };
  if (!(await tenantMayRunBackground(tenantId))) return result;
  const campaigns = ((await prisma.adCampaign.findMany({ where: { tenantId, ...platformCampaignWhere(now) }, select: CAMPAIGN_SELECT })) ?? []) as PlatformCampaign[];
  const own = campaigns.filter((c) => c.metaCampaignId && /^\d{1,30}$/.test(c.metaCampaignId));
  if (own.length === 0) return result;
  const assets = (await listAssets(tenantId, "ad_account")).filter((a) => a.status === "active" && !isDemoAsset(a));
  const state = await loadBreakdownState(tenantId);
  const throttle = opts.throttle ?? promoteThrottle;
  const maxRows = Math.max(0, Math.min(opts.maxRows ?? BREAKDOWN_ROWS_PER_SYNC, BREAKDOWN_ROWS_PER_SYNC));
  const progress: Progress = { rows: 0, truncated: false };
  const done: Record<string, { ok: boolean; backoffUntil?: string; completed: DailyDimension[] }> = {};

  for (const asset of assets) {
    const mine = own.filter((c) => c.adAccountAssetId === asset.id);
    if (mine.length === 0) continue;
    if (progress.rows >= maxRows) {
      progress.truncated = true;
      break;
    }
    const acc = state.accounts[asset.id] ?? {};
    if (acc.backoffUntil && Date.parse(acc.backoffUntil) > now.getTime()) {
      result.rateLimited = true;
      continue;
    }
    const outcome: AccountOutcome = { completed: new Set(), failures: [] };
    try {
      await syncAccountBreakdowns(tenantId, asset, mine, backfilledDimensions(acc), now, progress, maxRows, throttle, outcome);
      result.accounts++;
      result.campaigns += mine.length;
      done[asset.id] = { ok: true, completed: [...outcome.completed] };
    } catch (e) {
      // What finished before the stop stays backfilled, so the next run does not read it over 30 days again.
      if (e instanceof PromoteThrottledError || e instanceof InsightsRateLimitError) {
        result.rateLimited = true;
        const until = e instanceof PromoteThrottledError ? e.until : new Date(now.getTime() + RATE_LIMIT_BACKOFF_MS);
        done[asset.id] = { ok: false, backoffUntil: until.toISOString(), completed: [...outcome.completed] };
        continue;
      }
      if (e instanceof HttpError && e.status === 409) continue;
      result.errors.push(sanitizeMessage(e instanceof Error ? e.message : "sync failed"));
      done[asset.id] = { ok: false, completed: [...outcome.completed] };
    } finally {
      for (const f of outcome.failures) result.errors.push(`${f.dimension}: ${f.error}`);
    }
  }

  result.rows = progress.rows;
  result.truncated = progress.truncated;
  if (progress.truncated) log.warn("insights.breakdowns.truncated", { tenantId, rows: progress.rows });
  if (progress.rows > 0) result.pruned = await pruneBreakdowns(tenantId);
  await patchBreakdownState(tenantId, (s) => {
    const at = now.toISOString();
    for (const [id, d] of Object.entries(done)) {
      const a = (s.accounts[id] ??= {});
      // An account backfilled before dimensions were kept one by one counts every dimension as done.
      if (!a.dims && a.backfilledAt) a.dims = Object.fromEntries(BACKFILL_DIMENSIONS.map((k) => [k, a.backfilledAt]));
      if (d.completed.length) a.dims = { ...a.dims, ...Object.fromEntries(d.completed.map((k) => [k, a.dims?.[k] ?? at])) };
      // backfilledAt says every dimension is done; a cut or refused dimension leaves it unset.
      if (!a.backfilledAt && BACKFILL_DIMENSIONS.every((k) => a.dims?.[k])) a.backfilledAt = at;
      if (d.ok) delete a.backoffUntil;
      else if (d.backoffUntil) a.backoffUntil = d.backoffUntil;
    }
    s.lastSyncAt = now.toISOString();
    s.lastError = result.errors[0] ?? (result.rateLimited ? "Meta is busy; the results sync resumes on its next run." : null);
  });
  return result;
}

/**
 * The promote.breakdowns task: every workspace with a launched platform ad, the one synced longest ago first, until the time
 * budget is spent. With no platform ad it makes one database read and nothing else.
 */
export async function runBreakdownSync(now = new Date(), opts: BreakdownSyncOptions & { budgetMs?: number } = {}): Promise<BreakdownSyncResult> {
  const out: BreakdownSyncResult = { campaigns: 0, rows: 0, failed: 0 };
  const found = ((await prisma.ad.findMany({ where: { metaAdId: { not: null }, adSet: { campaign: platformCampaignWhere(now) } }, select: { tenantId: true }, distinct: ["tenantId"] })) ?? []) as { tenantId: string }[];
  const tenants = [...new Set(found.map((r) => r.tenantId))];
  if (tenants.length === 0) return out;
  const lastAt = new Map<string, number>();
  for (const t of tenants) lastAt.set(t, Date.parse((await loadBreakdownState(t)).lastSyncAt ?? "") || 0);
  tenants.sort((a, b) => (lastAt.get(a) ?? 0) - (lastAt.get(b) ?? 0));
  const started = Date.now();
  const budget = opts.budgetMs ?? BREAKDOWN_TASK_BUDGET_MS;
  for (const tenantId of tenants) {
    if (Date.now() - started > budget) break;
    try {
      const r = await syncBreakdownsTenant(tenantId, now, opts);
      out.campaigns += r.campaigns;
      out.rows += r.rows;
      if (r.errors.length) out.failed++;
    } catch (e) {
      out.failed++;
      log.warn("insights.breakdowns.failed", { tenantId, error: sanitizeMessage(e instanceof Error ? e.message : "sync failed") });
    }
  }
  return out;
}
