import { createHash } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { placementDimKey, RUN_TOTAL_KEY, type BreakdownDimension } from "@/lib/promote/catalog/breakdowns";
import { decimalToMinorBig } from "@/lib/spend/money";
import { decimalToMinor } from "./insights-money";
import { entityIdOf, entityNameOf, MAX_ROWS, type InsightLevel, type RawAsset, type RawInsightRow } from "./insights-fetch";
import { actionCount, CHAT_STARTED, leadCount, normalizeRanking, parseCount, pickResults, pickRowResults, sumActions } from "./insights-map";

export type SnapshotData = {
  tenantId: string;
  entityType: InsightLevel;
  entityMetaId: string;
  date: Date;
  spendMinor: number;
  impressions: number;
  clicks: number;
  results: number;
  frequency: number | null;
  qualityRanking: string | null;
  raw: Record<string, unknown>;
  // The extra metrics (0012, docs/IG-PAGE-ADS-SPEC.md 4.2). Reach and link clicks are null when Meta sent none; the action
  // counts are 0 on a day with none, because Meta leaves an empty action list out.
  reach: number | null;
  linkClicks: number | null;
  thruplays: number;
  videoP25: number;
  videoP50: number;
  videoP75: number;
  videoP100: number;
  messagingStarts: number;
};

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** A count Meta may leave out: null when absent, else parseCount. */
const optionalCount = (v: unknown): number | null => (v === undefined || v === null || v === "" ? null : parseCount(v));

/** Maps one Graph row to a snapshot, or null when the row has no usable id, date or spend. Spend is converted with integer arithmetic. */
export function toSnapshot(tenantId: string, level: InsightLevel, row: RawInsightRow, exponent: number): SnapshotData | null {
  const id = entityIdOf(level, row);
  if (!id || !row.date_start || !YMD.test(row.date_start)) return null;
  const { results, actionType } = pickResults(row.objective, row.actions);
  const freq = Number(row.frequency);
  let spendMinor = 0;
  try {
    spendMinor = decimalToMinor(row.spend, exponent);
  } catch {
    return null;
  }
  return {
    tenantId,
    entityType: level,
    entityMetaId: id,
    date: new Date(`${row.date_start}T00:00:00.000Z`),
    spendMinor,
    impressions: parseCount(row.impressions),
    clicks: parseCount(row.clicks),
    results,
    frequency: Number.isFinite(freq) && freq > 0 ? Math.round(freq * 100) / 100 : null,
    qualityRanking: level === "ad" ? normalizeRanking(row.quality_ranking) : null,
    reach: optionalCount(row.reach),
    linkClicks: optionalCount(row.inline_link_clicks),
    thruplays: sumActions(row.video_thruplay_watched_actions),
    videoP25: sumActions(row.video_p25_watched_actions),
    videoP50: sumActions(row.video_p50_watched_actions),
    videoP75: sumActions(row.video_p75_watched_actions),
    videoP100: sumActions(row.video_p100_watched_actions),
    messagingStarts: actionCount(row.actions, CHAT_STARTED),
    raw: {
      objective: row.objective ?? null,
      resultAction: actionType,
      campaignId: row.campaign_id ?? null,
      adSetId: row.adset_id ?? null,
      // Display and filtering only (src/lib/ads/insights-queries.ts): the name on Meta, the ad account and its currency.
      name: clip(entityNameOf(level, row)),
      campaignName: clip(row.campaign_name),
      accountId: row.account_id ? String(row.account_id).replace(/^act_/, "").slice(0, 40) : null,
      currency: currencyOf(row),
    },
  };
}

const clip = (v: unknown, max = 200) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const currencyOf = (row: RawInsightRow) => (typeof row.account_currency === "string" && /^[A-Za-z]{3}$/.test(row.account_currency) ? row.account_currency.toUpperCase() : null);

const CHUNK = 25;

/** Idempotent: re-running the same window overwrites the same rows by (tenantId, entityType, entityMetaId, date). */
export async function upsertSnapshots(items: SnapshotData[]): Promise<number> {
  for (let i = 0; i < items.length; i += CHUNK) {
    await Promise.all(
      items.slice(i, i + CHUNK).map((d) => {
        const { tenantId, entityType, entityMetaId, date, raw, ...rest } = d;
        const values = { ...rest, raw: raw as Prisma.InputJsonObject };
        return prisma.insightSnapshot.upsert({
          where: { tenantId_entityType_entityMetaId_date: { tenantId, entityType, entityMetaId, date } },
          create: { tenantId, entityType, entityMetaId, date, ...values },
          update: values,
        });
      }),
    );
  }
  return items.length;
}

// =====================================================================================================================
// InsightBreakdown (docs/IG-PAGE-ADS-SPEC.md 3.10, 4.2 R3, R3a, R4, R5, 5.1, 5.3, 5.5; PRM-12). Aggregates only.
// =====================================================================================================================

/** At most this many rows per workspace (5.5); the oldest daily rows are dropped first. */
export const BREAKDOWN_ROWS_PER_WORKSPACE = 100_000;
/** At most this many rows per sync (5.5). */
export const BREAKDOWN_ROWS_PER_SYNC = MAX_ROWS;

export type BreakdownData = {
  tenantId: string;
  entityType: InsightLevel;
  entityMetaId: string;
  date: Date;
  dimension: BreakdownDimension;
  dimKey: string;
  /** Exact: decimalToMinorBig with the ad account currency's exponent, never clamped (5.3). */
  spendMinor: bigint;
  impressions: number;
  reach: number | null;
  clicks: number;
  results: number;
  thruplays: number | null;
  raw: Record<string, unknown>;
};

export type BreakdownContext = {
  /** The ad account currency's exponent (0 for JPY, 2 for INR, 3 for KWD). */
  exponent: number;
  /** The goal (or, for an old-wizard campaign, the objective) whose results count, by Meta campaign id. */
  resultKeyOf?(metaCampaignId: string): string | null | undefined;
  /**
   * The action types a row counts, chosen from the ad set's optimisation (insights-map resultActionsForOptimization): website
   * visits count landing page views or link clicks, never the first of the two that is non-zero. Null keeps the goal's list.
   */
  resultActionsOf?(ids: { campaignId: string; adSetId: string | null }): readonly string[] | null | undefined;
  /** The run total's row date (R3a): the run's start day, YYYY-MM-DD, by Meta campaign id. */
  runStartOf?(metaCampaignId: string): string | null | undefined;
};

const ASSET_FIELDS: Readonly<Record<string, { field: keyof RawInsightRow; prefix: string }>> = {
  asset_body: { field: "body_asset", prefix: "body" },
  asset_title: { field: "title_asset", prefix: "title" },
  asset_image: { field: "image_asset", prefix: "image" },
  asset_video: { field: "video_asset", prefix: "video" },
  asset_cta: { field: "call_to_action_asset", prefix: "cta" },
};

const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");
const word = (v: unknown, max = 100): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim().toLowerCase().slice(0, max);
  return t ? t : null;
};

/** The dimension key of an R4 asset: Meta's asset id, else a SHA-1 of what identifies it ('body:<sha1>'). */
function assetKey(prefix: string, asset: RawAsset | undefined): { dimKey: string; label: string | null } | null {
  if (!asset || typeof asset !== "object") return null;
  const id = typeof asset.id === "string" && /^[\w.-]{1,64}$/.test(asset.id) ? asset.id : null;
  const ident = asset.text ?? asset.hash ?? asset.video_id ?? asset.type ?? asset.name ?? asset.url;
  if (!id && typeof ident !== "string") return null;
  const dimKey = `${prefix}:${id ?? sha1(String(ident))}`;
  // A short label for the table: the text of a body or title, the button type, else nothing (the UI says "Picture 1").
  const label = clip(asset.text ?? asset.type ?? asset.name, 80);
  return { dimKey, label };
}

/** The dimension key of a row, or null when the row lacks what its dimension needs. */
function dimKeyOf(dimension: BreakdownDimension, row: RawInsightRow): { dimKey: string; label?: string | null } | null {
  switch (dimension) {
    case "placement": {
      const platform = word(row.publisher_platform, 40);
      const position = word(row.platform_position, 80);
      // Meta's raw publisher_platform|platform_position pair (4.2): Facebook's positions are not documented, so none is renamed here.
      return platform && position ? { dimKey: placementDimKey(platform, position) } : null;
    }
    case "age_gender": {
      const gender = word(row.gender, 20);
      const age = word(row.age, 20);
      return gender && age ? { dimKey: `${gender}|${age}` } : null;
    }
    case "region": {
      const region = clip(row.region, 100);
      return region ? { dimKey: region } : null;
    }
    case "run_total":
      return { dimKey: RUN_TOTAL_KEY };
    default: {
      const spec = ASSET_FIELDS[dimension];
      return spec ? assetKey(spec.prefix, row[spec.field] as RawAsset | undefined) : null;
    }
  }
}

/**
 * Maps one breakdown row to an InsightBreakdown row, or null when it has no usable id, day, key or spend. Placement and asset
 * rows are per ad; age and gender, region and the run total are per campaign. The run total's date is the run's start day, so
 * the unique key keeps one row per campaign that each sync updates. `opts.level: "adset"` maps a version's run total (the R3a
 * read at ad set level): one row per ad set, so a fair test can compare the people each version reached over the run.
 */
export function toBreakdown(tenantId: string, dimension: BreakdownDimension, row: RawInsightRow, ctx: BreakdownContext, opts: { level?: "adset" } = {}): BreakdownData | null {
  const perAd = dimension === "placement" || dimension.startsWith("asset_");
  const perAdSet = dimension === "run_total" && opts.level === "adset";
  const entityMetaId = perAd ? row.ad_id : perAdSet ? row.adset_id : row.campaign_id;
  if (!entityMetaId || !/^\d{1,30}$/.test(entityMetaId)) return null;
  const day = dimension === "run_total" ? (ctx.runStartOf?.(row.campaign_id ?? "") ?? row.date_start) : row.date_start;
  if (!day || !YMD.test(day)) return null;
  const key = dimKeyOf(dimension, row);
  if (!key) return null;
  let spendMinor: bigint;
  try {
    spendMinor = decimalToMinorBig(row.spend ?? "0", ctx.exponent);
  } catch {
    return null;
  }
  const resultKey = (row.campaign_id ? ctx.resultKeyOf?.(row.campaign_id) : null) ?? row.objective;
  const actions = row.campaign_id ? ctx.resultActionsOf?.({ campaignId: row.campaign_id, adSetId: row.adset_id ?? null }) : null;
  const { results, actionType } = pickRowResults(resultKey, row, actions);
  const freq = Number(row.frequency);
  return {
    tenantId,
    entityType: perAd ? "ad" : perAdSet ? "adset" : "campaign",
    entityMetaId,
    date: new Date(`${day}T00:00:00.000Z`),
    dimension,
    dimKey: key.dimKey,
    spendMinor,
    impressions: parseCount(row.impressions),
    reach: optionalCount(row.reach),
    clicks: parseCount(row.clicks),
    results,
    thruplays: row.video_thruplay_watched_actions === undefined ? null : sumActions(row.video_thruplay_watched_actions),
    raw: {
      resultAction: actionType,
      campaignId: row.campaign_id ?? null,
      adSetId: row.adset_id ?? null,
      // Meta's own lead count: the Leads tab's split by app while Lead.platform is not returned (3.10).
      leads: leadCount(row.actions),
      messagingStarts: actionCount(row.actions, CHAT_STARTED),
      linkClicks: optionalCount(row.inline_link_clicks),
      currency: currencyOf(row),
      ...(dimension === "placement" ? { platform: word(row.publisher_platform, 40), position: word(row.platform_position, 80) } : {}),
      ...(key.label ? { label: key.label } : {}),
      ...(dimension === "run_total" ? { until: YMD.test(row.date_stop ?? "") ? row.date_stop : null, frequency: Number.isFinite(freq) && freq > 0 ? Math.round(freq * 100) / 100 : null } : {}),
    },
  };
}

/**
 * Upserts on the unique key (tenantId, entityType, entityMetaId, date, dimension, dimKey), so a repeat sync is idempotent. A run
 * total whose campaign start moved replaces the old row: one run_total row per campaign.
 */
export async function upsertBreakdowns(items: BreakdownData[], now = new Date()): Promise<number> {
  for (let i = 0; i < items.length; i += CHUNK) {
    await Promise.all(
      items.slice(i, i + CHUNK).map(async (d) => {
        const { tenantId, entityType, entityMetaId, date, dimension, dimKey, raw, ...rest } = d;
        if (dimension === "run_total") {
          await prisma.insightBreakdown.deleteMany({ where: { tenantId, entityType, entityMetaId, dimension: "run_total", NOT: { date } } });
        }
        const values = { ...rest, raw: raw as Prisma.InputJsonObject, syncedAt: now };
        return prisma.insightBreakdown.upsert({
          where: { tenantId_entityType_entityMetaId_date_dimension_dimKey: { tenantId, entityType, entityMetaId, date, dimension, dimKey } },
          create: { tenantId, entityType, entityMetaId, date, dimension, dimKey, ...values },
          update: values,
        });
      }),
    );
  }
  return items.length;
}

const PRUNE_BATCH = 5_000;

/**
 * Keeps a workspace at `cap` rows (5.5): the oldest daily rows go first (by day, then by when they were synced). Run totals
 * (one per campaign) are kept, because the Overview's reach comes only from them. Returns how many rows were deleted.
 */
export async function pruneBreakdowns(tenantId: string, cap = BREAKDOWN_ROWS_PER_WORKSPACE): Promise<number> {
  let over = (await prisma.insightBreakdown.count({ where: { tenantId } })) - cap;
  let deleted = 0;
  while (over > 0) {
    const batch = await prisma.insightBreakdown.findMany({
      where: { tenantId, dimension: { not: "run_total" } },
      orderBy: [{ date: "asc" }, { syncedAt: "asc" }, { id: "asc" }],
      take: Math.min(over, PRUNE_BATCH),
      select: { id: true },
    });
    if (batch.length === 0) break;
    const { count } = await prisma.insightBreakdown.deleteMany({ where: { tenantId, id: { in: batch.map((b) => b.id) } } });
    deleted += count;
    over -= batch.length;
  }
  return deleted;
}

// =====================================================================================================================
// Sync state (PlatformSetting)
// =====================================================================================================================

export type AccountState = {
  /** The level sync: set once its 30-day backfill is done. The breakdown sync: set once every dimension in `dims` is. */
  backfilledAt?: string;
  backoffUntil?: string;
  /**
   * The breakdown sync only: when each dimension's 30-day backfill finished, by dimension. A dimension is set only when all of
   * its reads in that sync finished, with nothing cut by the row cap and no read refused, so a cut or failed dimension
   * backfills again on the next run while the others refresh 3 days.
   */
  dims?: Partial<Record<string, string>>;
};
export type SyncState = { lastSyncAt?: string; lastManualAt?: string; lastError?: string | null; accounts: Record<string, AccountState> };

const stateKey = (tenantId: string) => `ads:insights:state:${tenantId}`;
/** The breakdown sync keeps its own row, so it never races the level sync's read-modify-write. */
const breakdownStateKey = (tenantId: string) => `ads:insights:breakdowns:${tenantId}`;

async function loadKey(key: string): Promise<SyncState> {
  const row = await prisma.platformSetting.findUnique({ where: { key } });
  const v = (row?.value ?? {}) as Partial<SyncState>;
  return { ...v, accounts: v.accounts ?? {} };
}

async function patchKey(key: string, patch: (s: SyncState) => void): Promise<SyncState> {
  const state = await loadKey(key);
  patch(state);
  await prisma.platformSetting.upsert({ where: { key }, create: { key, value: state as object }, update: { value: state as object } });
  return state;
}

export const loadState = (tenantId: string): Promise<SyncState> => loadKey(stateKey(tenantId));
export const patchState = (tenantId: string, patch: (s: SyncState) => void): Promise<SyncState> => patchKey(stateKey(tenantId), patch);
export const loadBreakdownState = (tenantId: string): Promise<SyncState> => loadKey(breakdownStateKey(tenantId));
export const patchBreakdownState = (tenantId: string, patch: (s: SyncState) => void): Promise<SyncState> => patchKey(breakdownStateKey(tenantId), patch);
