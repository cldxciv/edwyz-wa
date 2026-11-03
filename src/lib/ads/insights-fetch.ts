import { GraphError, graphFetchAs } from "@/lib/graph";
import { log } from "@/lib/log";
import { BREAKDOWNS, type BreakdownDimension } from "@/lib/promote/catalog/breakdowns";
import { decimalToMinorBig } from "@/lib/spend/money";
import { INT_MAX } from "./insights-money";

export type InsightLevel = "campaign" | "adset" | "ad";
export const LEVELS: InsightLevel[] = ["campaign", "adset", "ad"];
export const MAX_PAGES = 40;
export const MAX_ROWS = 20_000;
const PAGE_SIZE = 500;

export class InsightsRateLimitError extends Error {
  constructor() {
    super("Meta rate limit reached");
  }
}

export type RawInsightRow = {
  date_start?: string;
  account_id?: string;
  account_currency?: string;
  campaign_id?: string;
  campaign_name?: string;
  adset_id?: string;
  adset_name?: string;
  ad_id?: string;
  ad_name?: string;
  objective?: string;
  spend?: string;
  impressions?: string;
  clicks?: string;
  frequency?: string;
  quality_ranking?: string;
  actions?: { action_type?: string; value?: string }[];
  // The extra metrics (docs/IG-PAGE-ADS-SPEC.md 4.2, stored on InsightSnapshot and InsightBreakdown).
  date_stop?: string;
  reach?: string;
  inline_link_clicks?: string;
  cost_per_action_type?: RawAction[];
  video_thruplay_watched_actions?: RawAction[];
  video_p25_watched_actions?: RawAction[];
  video_p50_watched_actions?: RawAction[];
  video_p75_watched_actions?: RawAction[];
  video_p100_watched_actions?: RawAction[];
  // Breakdown values (R3, R4, R5).
  publisher_platform?: string;
  platform_position?: string;
  age?: string;
  gender?: string;
  region?: string;
  body_asset?: RawAsset;
  title_asset?: RawAsset;
  image_asset?: RawAsset;
  video_asset?: RawAsset;
  call_to_action_asset?: RawAsset;
};

export type RawAction = { action_type?: string; value?: string };
/** One asset of a per-placement-asset ad, as Meta names it in an R4 row (text for bodies and titles, a hash or video id for media). */
export type RawAsset = { id?: string; text?: string; hash?: string; url?: string; video_id?: string; name?: string; type?: string };

/** ThruPlays and the video quartiles. Meta leaves a field out on a day with none. */
export const VIDEO_FIELDS = ["video_thruplay_watched_actions", "video_p25_watched_actions", "video_p50_watched_actions", "video_p75_watched_actions", "video_p100_watched_actions"];

/*
 * account_id and account_currency let the insights page filter by ad account and total each currency on its own; the names
 * let it show campaigns made in Meta Ads Manager by name instead of by id. Reach, link clicks, ThruPlays and the quartiles are
 * the extra InsightSnapshot metrics (4.2); a day's reach is only ever shown for that day.
 */
export const BASE_FIELDS = ["date_start", "account_id", "account_currency", "objective", "spend", "impressions", "clicks", "frequency", "actions", "reach", "inline_link_clicks", ...VIDEO_FIELDS];
export const LEVEL_FIELDS: Record<InsightLevel, string[]> = {
  campaign: ["campaign_id", "campaign_name"],
  adset: ["campaign_id", "campaign_name", "adset_id", "adset_name"],
  ad: ["campaign_id", "campaign_name", "adset_id", "adset_name", "ad_id", "ad_name", "quality_ranking"],
};

/** The entity's own name on Meta for its level, when Meta sent one. */
export const entityNameOf = (level: InsightLevel, row: RawInsightRow): string | undefined =>
  level === "campaign" ? row.campaign_name : level === "adset" ? row.adset_name : row.ad_name;

export const entityIdOf = (level: InsightLevel, row: RawInsightRow): string | undefined =>
  level === "campaign" ? row.campaign_id : level === "adset" ? row.adset_id : row.ad_id;

/** Meta codes: 4 app limit, 17 account limit, 32 page limit, 613 custom limit, 80000 to 80014 Business Use Case limits. VERIFY. */
export function isRateLimit(e: unknown): boolean {
  if (!(e instanceof GraphError)) return false;
  const c = e.code;
  return e.status === 429 || c === 4 || c === 17 || c === 32 || c === 613 || (c !== undefined && c >= 80000 && c <= 80014);
}

type Page = { data?: RawInsightRow[]; paging?: { cursors?: { after?: string }; next?: string } };

export const accountPath = (externalId: string) => `act_${externalId.replace(/^act_/, "")}/insights`;

/** Daily rows for one level and window, following cursors up to MAX_PAGES and MAX_ROWS. Throws InsightsRateLimitError. */
export async function fetchLevel(
  token: string,
  externalId: string,
  level: InsightLevel,
  since: string,
  until: string,
): Promise<{ rows: RawInsightRow[]; truncated: boolean }> {
  const rows: RawInsightRow[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const query: Record<string, string> = {
      level,
      fields: [...BASE_FIELDS, ...LEVEL_FIELDS[level]].join(","),
      time_increment: "1",
      time_range: JSON.stringify({ since, until }),
      limit: String(PAGE_SIZE),
    };
    if (after) query.after = after;
    let res: Page;
    try {
      res = await graphFetchAs<Page>(token, { path: accountPath(externalId), query });
    } catch (e) {
      if (isRateLimit(e)) throw new InsightsRateLimitError();
      throw e;
    }
    for (const row of res.data ?? []) {
      if (rows.length >= MAX_ROWS) return { rows, truncated: true };
      rows.push(row);
    }
    after = res.paging?.next ? res.paging.cursors?.after : undefined;
    if (!after) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

/**
 * The exact spend of one row in minor units (docs/SPEND-CONTROLS-SPEC.md 3.1): decimalToMinorBig, with no clamp, for the
 * spend controls' SpendDaily rows. The reporting snapshot keeps its 32-bit column; when its clamp would fire this logs
 * `insights.clamped` (ids and the level only), and the spend book uses only the exact value. Null for unreadable spend.
 */
export function exactSpendMinor(row: Pick<RawInsightRow, "spend" | "date_start">, exponent: number, ref: { level: InsightLevel; id?: string } = { level: "campaign" }): { minor: bigint; clamped: boolean } | null {
  let minor: bigint;
  try {
    minor = decimalToMinorBig(row.spend ?? "0", exponent);
  } catch {
    return null;
  }
  const clamped = minor > BigInt(INT_MAX);
  if (clamped) log.warn("insights.clamped", { level: ref.level, entity: ref.id ?? null, date: row.date_start ?? null });
  return { minor, clamped };
}

/**
 * One insights read of an ad account with the caller's query (the spend controls' fast sync, docs/SPEND-CONTROLS-SPEC.md
 * 6.1), following cursors up to `maxPages`. Reads only. Meta's errors are thrown as they are (isRateLimit tells a rate limit).
 */
export async function fetchAccountInsights(token: string, externalId: string, query: Record<string, string>, maxPages = 10): Promise<RawInsightRow[]> {
  const rows: RawInsightRow[] = [];
  let after: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const res = await graphFetchAs<Page>(token, { path: accountPath(externalId), method: "GET", query: { ...query, limit: String(PAGE_SIZE), ...(after ? { after } : {}) } });
    rows.push(...(res?.data ?? []));
    after = res?.paging?.next ? res.paging.cursors?.after : undefined;
    if (!after) break;
  }
  return rows;
}

// =====================================================================================================================
// Results breakdowns (docs/IG-PAGE-ADS-SPEC.md 3.10, 4.2 R3, R3a, R4, R5; PRM-12). Edwyz's own campaigns only: every read is
// filtered to campaign ids (or, for R4, ad ids) the caller passes. Reads only (not_spend). This file stays the only reader of
// the ad account's insights edge (tests/usage-scopes-alignment.test.ts).
// =====================================================================================================================

/** Ids per filter. Meta's IN filter takes more, but 50 keeps the URL short and a refusal small. */
export const BREAKDOWN_FILTER_MAX = 50;

const ROW_METRICS = ["spend", "impressions", "reach", "clicks", "inline_link_clicks", "actions", "cost_per_action_type", ...VIDEO_FIELDS];

/** Fields of the daily breakdown reads (R3 and R4 at ad level, R5 at campaign level). */
export const BREAKDOWN_FIELDS: Readonly<Record<"ad" | "campaign", readonly string[]>> = {
  ad: ["date_start", "account_currency", "objective", "campaign_id", "adset_id", "ad_id", ...ROW_METRICS],
  campaign: ["date_start", "account_currency", "objective", "campaign_id", ...ROW_METRICS],
};

/**
 * Fields of the run total (R3a): the run's reach and frequency, with its totals. One row per campaign (or, read per ad set
 * for a fair test, one per version with adset_id added), no time_increment.
 */
export const RUN_TOTAL_FIELDS: readonly string[] = ["date_start", "date_stop", "account_currency", "objective", "campaign_id", "reach", "frequency", "spend", "impressions", "clicks", "actions", "video_thruplay_watched_actions"];

export type BreakdownRequest = {
  dimension: BreakdownDimension;
  /** Account-local days, YYYY-MM-DD. The run total reads from the run's start day to today. */
  since: string;
  until: string;
  /** Meta campaign ids: every read but R4. */
  campaignIds?: readonly string[];
  /** Meta ad ids: R4 reads per-placement-asset ads only. */
  adIds?: readonly string[];
  /**
   * The run total only: "adset" reads it per ad set (still filtered to the campaign ids), so a fair test can compare the
   * people each version reached over the run. Reach is never added up across days, so a version's reach needs its own read.
   */
  level?: "adset";
};

const META_ID = /^\d{1,30}$/;
const YMD_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The query of one breakdown read (pure). Throws RangeError for an unknown dimension, a bad day or a bad id list. */
export function breakdownQuery(req: BreakdownRequest): Record<string, string> {
  const spec = BREAKDOWNS.find((b) => b.dimension === req.dimension);
  if (!spec) throw new RangeError("Unknown breakdown.");
  if (!YMD_DAY.test(req.since) || !YMD_DAY.test(req.until) || req.since > req.until) throw new RangeError("A breakdown read needs a valid day range.");
  const byAd = spec.call === "R4";
  if (req.level !== undefined && (req.level !== "adset" || spec.call !== "R3a")) throw new RangeError("Only the run total is read per ad set.");
  const ids = [...new Set((byAd ? req.adIds : req.campaignIds) ?? [])];
  if (ids.length === 0 || ids.length > BREAKDOWN_FILTER_MAX || !ids.every((id) => META_ID.test(id))) {
    throw new RangeError(`A breakdown read needs 1 to ${BREAKDOWN_FILTER_MAX} ${byAd ? "ad" : "campaign"} ids.`);
  }
  const perAdSet = req.level === "adset";
  const query: Record<string, string> = {
    level: perAdSet ? "adset" : spec.level,
    fields: (spec.call === "R3a" ? (perAdSet ? [...RUN_TOTAL_FIELDS, "adset_id"] : RUN_TOTAL_FIELDS) : BREAKDOWN_FIELDS[spec.level]).join(","),
    time_range: JSON.stringify({ since: req.since, until: req.until }),
    filtering: JSON.stringify([{ field: byAd ? "ad.id" : "campaign.id", operator: "IN", value: ids }]),
  };
  if (spec.breakdowns.length) query.breakdowns = spec.breakdowns.join(",");
  if (spec.daily) query.time_increment = "1";
  return query;
}

/**
 * Pacing for the breakdown reads (priority 5 of 4.9, src/lib/promote/throttle.ts): `before` runs ahead of each page and throws
 * to hold it, `onHeaders` sees Meta's usage headers, and `onError` sees Meta's error before it is thrown on.
 */
export type InsightsPace = {
  before(): Promise<void>;
  onHeaders?(headers: Headers, status: number): void;
  onError?(error: GraphError): Promise<void>;
};

/**
 * One breakdown read, following cursors up to MAX_PAGES and `maxRows` (at most MAX_ROWS). A rate limit is thrown as
 * InsightsRateLimitError after the pace has seen it; anything the pace throws (Meta busy) is thrown as it is, before any call.
 */
export async function fetchBreakdown(
  token: string,
  externalId: string,
  req: BreakdownRequest,
  opts: { maxRows?: number; pace?: InsightsPace } = {},
): Promise<{ rows: RawInsightRow[]; truncated: boolean }> {
  const query = breakdownQuery(req);
  const cap = Math.max(0, Math.min(Math.floor(opts.maxRows ?? MAX_ROWS), MAX_ROWS));
  const rows: RawInsightRow[] = [];
  if (cap === 0) return { rows, truncated: true };
  const pace = opts.pace;
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    await pace?.before();
    let res: Page;
    try {
      res = await graphFetchAs<Page>(token, { path: accountPath(externalId), query: { ...query, limit: String(PAGE_SIZE), ...(after ? { after } : {}) } }, pace?.onHeaders ? { onHeaders: (h, s) => pace.onHeaders?.(h, s) } : undefined);
    } catch (e) {
      if (e instanceof GraphError && pace?.onError) await pace.onError(e).catch(() => undefined);
      if (isRateLimit(e)) throw new InsightsRateLimitError();
      throw e;
    }
    for (const row of res?.data ?? []) {
      if (rows.length >= cap) return { rows, truncated: true };
      rows.push(row);
    }
    after = res?.paging?.next ? res.paging.cursors?.after : undefined;
    if (!after) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}
