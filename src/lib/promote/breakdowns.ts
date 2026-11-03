/**
 * The rows the campaign page's Results tabs show (docs/IG-PAGE-ADS-SPEC.md 3.10, 4.4, 5.3, D24; PRM-12). Reads InsightBreakdown
 * (filled by the promote.breakdowns task through ads/insights-sync.ts), InsightSnapshot (the level sync) and Lead. Calls no Meta.
 *
 * - Overview: spend, results for the goal, cost per result, reach, and CTR and CPM computed here from summed clicks,
 *   impressions and spend ("clicks per 100 views", "cost per 1,000 views"). Reach for the whole run comes from the run total
 *   (R3a, dimension run_total) and is never a sum of daily reach; a day's own reach is shown only when the range is one day.
 * - Where it worked: placement rows sorted by cost per result, "Instagram Reels: 46 chats, ₹31 each". A known
 *   publisher_platform|platform_position pair has a name; an unknown one shows "Facebook: {raw}".
 * - Which version worked: per ad (versions), and per asset for per-placement-asset ads. The route adds the compare verdict.
 * - Who saw it: age and gender, and region.
 * - A goal whose result is people reached (awareness) shows views and cost per 1,000 views on these tabs: daily reach counts
 *   a person once per day, placement and ad, so it never adds up. Its people reached are on the Overview (the run total).
 * - Results count what the goal counts. Breakdown rows were counted for the goal at sync time (website visits by the ad set's
 *   optimisation); a level-sync row counted by objective adds its results only when they are the goal's (snapshotResult), and
 *   is otherwise "not counted yet" rather than another metric under the goal's name.
 * - Leads: "Leads from this ad: 23 (Instagram 17, Facebook 6)", Lead rows joined by adMetaId and platform. While Lead.platform
 *   is not returned, the split by app falls back to Meta's own lead counts from the placement rows, labelled "From Meta's report".
 * - Boosted posts carry the paid-only note (D24).
 *
 * Money is exact: InsightBreakdown.spendMinor is a bigint written with decimalToMinorBig; every amount leaves here as a string
 * of minor units plus its formatted text, so a JSON answer never holds a bigint.
 */
import { CHAT_STARTED, THRUPLAY_RESULT, resultActionsFor, resultActionsForOptimization } from "@/lib/ads/insights-map";
import { prisma } from "@/lib/db";
import { currencyExponent } from "@/lib/spend/money";
import { HttpError } from "@/lib/tenancy";
import { placementName, placementOfDimKey, RUN_TOTAL_KEY } from "./catalog/breakdowns";
import { goalOfLegacyTemplate } from "./catalog/goals";
import { formatCount, formatMoney, joinList, promoteText } from "./copy";

// =====================================================================================================================
// Copy (English: the ads pages stay English until PROMOTE_PAGE_LANGS allows more, D23)
// =====================================================================================================================

export const RESULTS_COPY = {
  paidOnly: "Free (organic) numbers need an extra Meta permission that Edwyz hasn't asked for.",
  notLaunched: "Results show here once your ad has started.",
  noData: "No results yet. They show here a few hours after your ad starts.",
  runReach: "People reached (whole run)",
  dayReach: "People reached that day",
  reachMissing: "Not reported yet",
  notCounted: "Not counted yet",
  viewsNotReach: "People reached can't be added up across days or placements, so this tab shows views. The Overview shows how many people your ad reached.",
  fromMetaReport: promoteText("results.from_meta_report"),
  platformUnknown: promoteText("results.platform_unknown"),
  ctr: promoteText("results.ctr"),
  cpm: promoteText("results.cost_per_1000"),
} as const;

// =====================================================================================================================
// Dimensions
// =====================================================================================================================

/** The Results tabs: the four of 4.8 plus the Overview and Leads tabs of 3.10. */
export const RESULT_DIMENSIONS = ["overview", "placement", "creative", "age_gender", "region", "leads"] as const;
export type ResultDimension = (typeof RESULT_DIMENSIONS)[number];
export const isResultDimension = (v: unknown): v is ResultDimension => typeof v === "string" && (RESULT_DIMENSIONS as readonly string[]).includes(v);

// =====================================================================================================================
// Goals, nouns and money (pure)
// =====================================================================================================================

const NOUNS: Readonly<Record<string, readonly [string, string]>> = {
  whatsapp_chats: ["chat", "chats"],
  instagram_dms: ["chat", "chats"],
  messenger_chats: ["chat", "chats"],
  any_chat: ["chat", "chats"],
  lead_form: ["lead", "leads"],
  website_visits: ["visit", "visits"],
  website_sales: ["sale", "sales"],
  profile_visits: ["profile visit", "profile visits"],
  engagement: ["like or comment", "likes and comments"],
  video_views: ["video view", "video views"],
  awareness: ["person reached", "people reached"],
  page_likes: ["Page like", "Page likes"],
  OUTCOME_LEADS: ["lead", "leads"],
  OUTCOME_TRAFFIC: ["visit", "visits"],
  OUTCOME_SALES: ["sale", "sales"],
};

/** "chats" for 46, "chat" for 1, by goal (or objective); "results" when unknown. */
export function resultNoun(goalOrObjective: string | null | undefined, count = 2): string {
  const pair = goalOrObjective && Object.prototype.hasOwnProperty.call(NOUNS, goalOrObjective) ? NOUNS[goalOrObjective] : (["result", "results"] as const);
  return count === 1 ? pair[0] : pair[1];
}

/** The goal a campaign's results count (4.4): its own, else its legacy template's, else its objective. */
export function campaignResultKey(c: { goal?: string | null; template?: string | null; objective?: string | null }): string | null {
  return c.goal || (c.template ? goalOfLegacyTemplate(c.template)?.goal : null) || c.objective || null;
}

/** Goals whose result is the number of people reached (4.4). Reach never adds up across days, placements or ads. */
const REACH_GOALS = new Set(["awareness"]);
export const isReachGoal = (key: string | null | undefined): boolean => !!key && REACH_GOALS.has(key);

/**
 * The action types a campaign's (or one version's) results count, from its ad sets' optimisation (4.4, catalog/goals.ts
 * resultActionFor): website visits count landing page views or link clicks, whichever the ad sets optimise for. Null when the
 * ad sets don't share one optimisation that decides it; the goal's own list then applies.
 */
export function goalResultActions(resultKey: string | null, optimizationGoals: readonly (string | null | undefined)[]): readonly string[] | null {
  const goals = new Set(optimizationGoals.filter((g): g is string => !!g));
  return goals.size === 1 ? resultActionsForOptimization(resultKey, [...goals][0]) : null;
}

/** What a level-sync (InsightSnapshot) row can say about results. */
export type SnapshotLike = { results: number; messagingStarts?: number | null; thruplays?: number | null; raw?: unknown };

/**
 * A level-sync row's results for the goal, or null when the row can't say. The level sync counts results by Meta's objective
 * (OUTCOME_ENGAGEMENT counts chats, else post engagements), which is not always the goal's result: a video-views or Page-likes
 * campaign would show post engagements under its own name. So: chats from messagingStarts, ThruPlays from thruplays, else the
 * row's count only when the action it counted is one the goal counts, or 0 when every action the goal counts comes before the
 * one it counted in the objective's list (so all of them were zero). People reached is never taken from here (the reach rule).
 */
export function snapshotResult(resultKey: string | null, s: SnapshotLike, actions?: readonly string[] | null): number | null {
  if (isReachGoal(resultKey)) return null;
  const goal = actions ?? resultActionsFor(resultKey);
  if (goal.length === 0) return 0;
  if (goal.length === 1 && goal[0] === CHAT_STARTED && typeof s.messagingStarts === "number") return num(s.messagingStarts);
  if (goal.length === 1 && goal[0] === THRUPLAY_RESULT) return typeof s.thruplays === "number" ? num(s.thruplays) : null;
  const raw = rawOf(s);
  if (!("resultAction" in raw)) return null;
  const picked = typeof raw.resultAction === "string" ? raw.resultAction : null;
  if (picked && goal.includes(picked)) return num(s.results);
  const counted = resultActionsFor(typeof raw.objective === "string" ? raw.objective : undefined);
  const upTo = picked ? counted.indexOf(picked) : counted.length;
  if (upTo < 0) return null;
  return goal.every((g) => {
    const i = counted.indexOf(g);
    return i >= 0 && i < upTo;
  })
    ? 0
    : null;
}

/** Adds a level-sync row to totals: its spend, views and clicks, and its results only when they are the goal's (snapshotResult). */
export function addSnapshot(t: Totals, s: SnapshotLike & { spendMinor: MinorLike; impressions?: number | null; clicks?: number | null }, resultKey: string | null, actions?: readonly string[] | null): Totals {
  const results = snapshotResult(resultKey, s, actions);
  addTo(t, { spendMinor: s.spendMinor, impressions: s.impressions, clicks: s.clicks, results: results ?? 0 });
  if (results === null) t.uncounted = true;
  return t;
}

/** The day of a stored row, YYYY-MM-DD. */
export const dayOf = (d: unknown): string => (d instanceof Date ? d.toISOString().slice(0, 10) : typeof d === "string" ? d.slice(0, 10) : "");

/** "version A", "versions A and C", "versions A, B and C". */
export function formatVersionList(keys: readonly string[]): string {
  return keys.length === 1 ? `version ${keys[0]}` : `versions ${joinList(keys)}`;
}

/** A boost (an existing Facebook or Instagram post): results are paid only (D24). */
export const isBoost = (c: { sourceKind?: string | null; template?: string | null }) => c.sourceKind === "fb_post" || c.sourceKind === "ig_media" || c.template === "boost_post";

type MinorLike = bigint | number | string | null | undefined;
const big = (v: MinorLike): bigint => {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return Number.isFinite(v) ? BigInt(Math.trunc(v)) : 0n;
  if (typeof v === "string" && /^-?\d{1,30}$/.test(v)) return BigInt(v);
  return 0n;
};

/** Cost per result in minor units, rounded half up; null without results. Exact for any spend. */
export function costPerResultBig(spendMinor: bigint, results: number): bigint | null {
  if (!Number.isSafeInteger(results) || results <= 0) return null;
  const r = BigInt(results);
  return (spendMinor * 2n + r) / (r * 2n);
}

/** For display: a cost of at least one major unit is rounded to whole units ("₹31", "₹38 vs ₹55"); smaller ones keep their fraction. */
export function displayCost(minor: bigint, currency: string): string {
  const scale = 10n ** BigInt(currencyExponent(currency));
  const shown = scale > 1n && minor >= scale ? ((minor + scale / 2n) / scale) * scale : minor;
  return formatMoney(shown, currency);
}

/** -1 when a is cheaper per result than b, 1 when dearer, 0 when equal. Rows without results sort last. Exact (cross-multiplied). */
export function compareCost(a: { spendMinor: bigint; results: number }, b: { spendMinor: bigint; results: number }): number {
  if (a.results <= 0 || b.results <= 0) return a.results > 0 ? -1 : b.results > 0 ? 1 : 0;
  const left = a.spendMinor * BigInt(b.results);
  const right = b.spendMinor * BigInt(a.results);
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Clicks per 100 views (two decimals), or null without views. */
export function clicksPer100(clicks: number, impressions: number): number | null {
  return impressions > 0 ? Math.round((clicks * 10_000) / impressions) / 100 : null;
}

/** Cost per 1,000 views in minor units (rounded half up), or null without views. */
export function costPer1000(spendMinor: bigint, impressions: number): bigint | null {
  if (!Number.isSafeInteger(impressions) || impressions <= 0) return null;
  const i = BigInt(impressions);
  return (spendMinor * 2000n + i) / (i * 2n);
}

// =====================================================================================================================
// Rows
// =====================================================================================================================

export type Totals = {
  spendMinor: bigint;
  impressions: number;
  clicks: number;
  results: number;
  leads: number;
  /** Some of these numbers came from a level-sync row that can't say how many results the goal got (snapshotResult). */
  uncounted?: boolean;
};
const zero = (): Totals => ({ spendMinor: 0n, impressions: 0, clicks: 0, results: 0, leads: 0 });

/**
 * What a breakdown tab measures. "results": the goal's results and cost per result. "views": views and cost per 1,000 views,
 * for a goal whose result is people reached, because reach can't be added up across days, placements or ads.
 */
export type Measure = "results" | "views";
export const measureFor = (resultKey: string | null): Measure => (isReachGoal(resultKey) ? "views" : "results");

export type RowContext = { currency: string; resultKey: string | null; measure?: Measure };

/** What a stored breakdown row contributes. */
export type StoredBreakdown = {
  entityMetaId: string;
  date: Date;
  dimension: string;
  dimKey: string;
  spendMinor: MinorLike;
  impressions: number;
  clicks: number;
  results: number;
  reach?: number | null;
  raw?: unknown;
};

const rawOf = (row: { raw?: unknown }) => (row.raw && typeof row.raw === "object" && !Array.isArray(row.raw) ? (row.raw as Record<string, unknown>) : {});
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

export function addTo(t: Totals, row: { spendMinor: MinorLike; impressions?: number | null; clicks?: number | null; results?: number | null; raw?: unknown }): Totals {
  t.spendMinor += big(row.spendMinor);
  t.impressions += num(row.impressions);
  t.clicks += num(row.clicks);
  t.results += num(row.results);
  t.leads += num(rawOf(row).leads);
  return t;
}

/** Sums rows by a key, keeping the first-seen order. */
export function totalsBy<R extends { spendMinor: MinorLike; impressions?: number | null; clicks?: number | null; results?: number | null; raw?: unknown }>(rows: readonly R[], keyOf: (r: R) => string): Map<string, Totals> {
  const out = new Map<string, Totals>();
  for (const r of rows) {
    const k = keyOf(r);
    addTo(out.get(k) ?? out.set(k, zero()).get(k)!, r);
  }
  return out;
}

export type ResultRowView = {
  key: string;
  label: string;
  /** "Instagram Reels: 46 chats, ₹31 each", "Facebook Feed: no chats yet, ₹120 spent", or for reach "Instagram Reels: 12,000 views, ₹25 per 1,000 views". */
  text: string;
  /** "results": results is the goal's count and the cost is per result. "views": results is the views and the cost is per 1,000 views. */
  measure: Measure;
  /** False when the goal's results for this row aren't known yet (only spend, views and clicks are): results is then 0. */
  counted: boolean;
  results: number;
  spendMinor: string;
  spend: string;
  costPerResultMinor: string | null;
  costPerResult: string | null;
  impressions: number;
  clicks: number;
};

/** The count and the cost a row is ranked and shown by: results and cost per result, or views and cost per 1,000 views. */
function measured(t: Totals, measure: Measure): { count: number; cost: bigint | null } {
  if (measure === "views") return { count: t.impressions, cost: costPer1000(t.spendMinor, t.impressions) };
  return { count: t.uncounted ? 0 : t.results, cost: t.uncounted ? null : costPerResultBig(t.spendMinor, t.results) };
}

export function rowView(key: string, label: string, t: Totals, ctx: RowContext): ResultRowView {
  const measure = ctx.measure ?? "results";
  const { count, cost } = measured(t, measure);
  const spend = formatMoney(t.spendMinor, ctx.currency);
  const counted = measure === "views" || !t.uncounted;
  let text: string;
  if (measure === "views") text = cost === null ? `${label}: no views yet, ${spend} spent` : `${label}: ${formatCount(count)} ${count === 1 ? "view" : "views"}, ${displayCost(cost, ctx.currency)} per 1,000 views`;
  else if (!counted) text = `${label}: ${resultNoun(ctx.resultKey)} not counted yet, ${spend} spent`;
  else text = cost === null ? `${label}: no ${resultNoun(ctx.resultKey)} yet, ${spend} spent` : `${label}: ${formatCount(count)} ${resultNoun(ctx.resultKey, count)}, ${displayCost(cost, ctx.currency)} each`;
  return {
    key,
    label,
    text,
    measure,
    counted,
    results: count,
    spendMinor: t.spendMinor.toString(),
    spend,
    costPerResultMinor: cost === null ? null : cost.toString(),
    costPerResult: cost === null ? null : displayCost(cost, ctx.currency),
    impressions: t.impressions,
    clicks: t.clicks,
  };
}

/** Cheapest first (per result, or per view); rows without any last, the biggest spend first among them. */
export function sortByCost<T extends { totals: Totals }>(rows: T[], measure: Measure = "results"): T[] {
  const m = (t: Totals) => ({ spendMinor: t.spendMinor, results: measured(t, measure).count });
  return rows.sort((a, b) => {
    const [x, y] = [m(a.totals), m(b.totals)];
    const c = compareCost(x, y);
    if (c !== 0) return c;
    if (x.results !== y.results) return y.results - x.results;
    return a.totals.spendMinor > b.totals.spendMinor ? -1 : a.totals.spendMinor < b.totals.spendMinor ? 1 : 0;
  });
}

/** Placement rows (3.10 "Where it worked"), sorted by cost per result (per 1,000 views for reach). */
export function placementRows(rows: readonly StoredBreakdown[], ctx: RowContext): ResultRowView[] {
  const by = totalsBy(rows, (r) => r.dimKey);
  return sortByCost(
    [...by].map(([key, totals]) => ({ key, totals })),
    ctx.measure,
  ).map(({ key, totals }) => ({ ...rowView(key, placementName(key), totals, ctx), placement: placementOfDimKey(key) }));
}

const GENDERS: Readonly<Record<string, string>> = { female: "Women", male: "Men" };

/** "Women 25-34", "Men 65+", "Gender not known 18-24". */
export function ageGenderLabel(dimKey: string): string {
  const [gender = "", age = ""] = dimKey.split("|");
  const who = GENDERS[gender] ?? "Gender not known";
  const ages = !age || age === "unknown" ? "age not known" : age;
  return `${who} ${ages}`;
}

export const regionLabel = (dimKey: string) => (!dimKey || dimKey.toLowerCase() === "unknown" ? "Region not known" : dimKey);

const ASSET_KINDS: Readonly<Record<string, string>> = {
  asset_body: "Text",
  asset_title: "Headline",
  asset_image: "Picture",
  asset_video: "Video",
  asset_cta: "Button",
};

/** Per-asset rows of per-placement-asset ads: "Text: Chat with us on WhatsApp", "Picture 2". */
export function assetRows(rows: readonly StoredBreakdown[], ctx: RowContext): (ResultRowView & { kind: string })[] {
  const labels = new Map<string, string | null>();
  for (const r of rows) {
    const k = `${r.dimension}|${r.dimKey}`;
    const label = rawOf(r).label;
    if (!labels.has(k) || (typeof label === "string" && !labels.get(k))) labels.set(k, typeof label === "string" ? label : null);
  }
  const by = totalsBy(rows, (r) => `${r.dimension}|${r.dimKey}`);
  const seen: Record<string, number> = {};
  const named = [...by].map(([key, totals]) => {
    const dimension = key.slice(0, key.indexOf("|"));
    const kind = ASSET_KINDS[dimension] ?? "Asset";
    seen[dimension] = (seen[dimension] ?? 0) + 1;
    const label = labels.get(key);
    return { key, totals, dimension, name: label ? `${kind}: ${label}` : `${kind} ${seen[dimension]}` };
  });
  return sortByCost(named, ctx.measure).map(({ key, totals, dimension, name }) => ({ ...rowView(key, name, totals, ctx), kind: dimension }));
}

// =====================================================================================================================
// Leads (3.10 Leads tab)
// =====================================================================================================================

export type LeadSplit = {
  total: number;
  instagram: number;
  facebook: number;
  /** Other apps, and leads whose app Meta didn't say. */
  other: number;
  /** "leads": Lead rows by adMetaId and platform. "meta_report": Meta's own lead counts from the placement rows. */
  source: "leads" | "meta_report";
  text: string;
  /** "From Meta's report" when the split is Meta's. */
  note: string | null;
  /** "Instagram or Facebook: not reported by Meta" while Lead.platform is missing. */
  platformNote: string | null;
  /** Leads in the Leads hub for this ad (the split above may be Meta's). */
  inHub: number;
};

export type LeadCount = { adMetaId: string | null; platform: string | null; count: number };

type Split = { instagram: number; facebook: number; other: number; missing: number };
const emptySplit = (): Split => ({ instagram: 0, facebook: 0, other: 0, missing: 0 });
const MISSING_PLATFORM = new Set([null, "", "unknown"]);

function leadText(total: number, instagram: number, facebook: number): string {
  return promoteText("results.leads_from_ad", { total, instagram, facebook });
}

/**
 * The Leads tab's numbers for one ad (pure). Lead rows give the split while every lead names its app; while Lead.platform is
 * missing, Meta's own `lead` counts from the placement rows (R3) give the split, labelled "From Meta's report".
 */
export function leadSplit(hub: Split, meta: { instagram: number; facebook: number; other: number } | null): LeadSplit {
  const inHub = hub.instagram + hub.facebook + hub.other + hub.missing;
  const metaTotal = meta ? meta.instagram + meta.facebook + meta.other : 0;
  if (hub.missing > 0 && meta && metaTotal > 0) {
    return {
      total: metaTotal,
      instagram: meta.instagram,
      facebook: meta.facebook,
      other: meta.other,
      source: "meta_report",
      text: leadText(metaTotal, meta.instagram, meta.facebook),
      note: RESULTS_COPY.fromMetaReport,
      platformNote: RESULTS_COPY.platformUnknown,
      inHub,
    };
  }
  return {
    total: inHub,
    instagram: hub.instagram,
    facebook: hub.facebook,
    other: hub.other + hub.missing,
    source: "leads",
    text: leadText(inHub, hub.instagram, hub.facebook),
    note: null,
    platformNote: hub.missing > 0 ? RESULTS_COPY.platformUnknown : null,
    inHub,
  };
}

/** Lead counts per ad from Lead rows (grouped by adMetaId and platform). */
export function hubSplits(counts: readonly LeadCount[]): Map<string, Split> {
  const out = new Map<string, Split>();
  for (const c of counts) {
    if (!c.adMetaId) continue;
    const s = out.get(c.adMetaId) ?? out.set(c.adMetaId, emptySplit()).get(c.adMetaId)!;
    const n = Math.max(0, Math.floor(c.count));
    if (MISSING_PLATFORM.has(c.platform)) s.missing += n;
    else if (c.platform === "instagram") s.instagram += n;
    else if (c.platform === "facebook") s.facebook += n;
    else s.other += n;
  }
  return out;
}

/** Meta's lead counts per ad and app, from placement rows (raw.leads, the app from raw.platform or the key). */
export function metaReportSplits(rows: readonly StoredBreakdown[]): Map<string, { instagram: number; facebook: number; other: number }> {
  const out = new Map<string, { instagram: number; facebook: number; other: number }>();
  for (const r of rows) {
    const leads = num(rawOf(r).leads);
    if (leads === 0) continue;
    const raw = rawOf(r).platform;
    const platform = typeof raw === "string" ? raw : r.dimKey.split("|")[0];
    const s = out.get(r.entityMetaId) ?? out.set(r.entityMetaId, { instagram: 0, facebook: 0, other: 0 }).get(r.entityMetaId)!;
    if (platform === "instagram") s.instagram += leads;
    else if (platform === "facebook") s.facebook += leads;
    else s.other += leads;
  }
  return out;
}

export type LeadsView = LeadSplit & { ads: (LeadSplit & { adMetaId: string; name: string })[] };

/** The Leads tab: per ad, and the campaign's total (Meta's report when any ad's split is Meta's). */
export function leadsView(ads: readonly { metaAdId: string; name: string }[], counts: readonly LeadCount[], placementRowsForLeads: readonly StoredBreakdown[]): LeadsView {
  const hub = hubSplits(counts);
  const meta = metaReportSplits(placementRowsForLeads);
  const perAd = ads.map((a) => ({ adMetaId: a.metaAdId, name: a.name, ...leadSplit(hub.get(a.metaAdId) ?? emptySplit(), meta.get(a.metaAdId) ?? null) }));
  const sum = perAd.reduce((t, a) => ({ instagram: t.instagram + a.instagram, facebook: t.facebook + a.facebook, other: t.other + a.other, inHub: t.inHub + a.inHub }), { instagram: 0, facebook: 0, other: 0, inHub: 0 });
  const total = sum.instagram + sum.facebook + sum.other;
  const fromMeta = perAd.some((a) => a.source === "meta_report");
  const unknown = perAd.some((a) => a.platformNote !== null);
  return {
    total,
    instagram: sum.instagram,
    facebook: sum.facebook,
    other: sum.other,
    source: fromMeta ? "meta_report" : "leads",
    text: leadText(total, sum.instagram, sum.facebook),
    note: fromMeta ? RESULTS_COPY.fromMetaReport : null,
    platformNote: unknown ? RESULTS_COPY.platformUnknown : null,
    inHub: sum.inHub,
    ads: perAd,
  };
}

// =====================================================================================================================
// Overview
// =====================================================================================================================

export type OverviewView = {
  spendMinor: string;
  spend: string;
  /** Null while the goal's results can't be counted yet (resultsText then says so). */
  results: number | null;
  resultsText: string;
  costPerResultMinor: string | null;
  costPerResult: string | null;
  /** "Cost per chat", or for reach "Cost per person reached (whole run)" / "that day". */
  costPerResultLabel: string;
  /**
   * What the cost per result divides: "range" the range's spend by its results; "run" the whole run's spend by the run's reach
   * (people reached never adds up over a part of the run); "day" one day's spend by that day's reach.
   */
  costScope: "range" | "run" | "day";
  reach: number | null;
  reachLabel: string;
  /** "run": the run total (R3a). "day": that one day's reach. Never a sum of days. */
  reachScope: "run" | "day" | null;
  impressions: number;
  clicks: number;
  ctr: number | null;
  ctrLabel: string;
  cpmMinor: string | null;
  cpm: string | null;
  cpmLabel: string;
  /**
   * Where spend and results came from, day by day: the placement rows, the level sync's campaign rows on days without
   * placement rows ("mixed" when both), or nothing yet.
   */
  source: "breakdowns" | "snapshots" | "mixed" | "none";
};

/**
 * The Overview (pure). Reach: on a one-day range the day's own reach, otherwise the run total's; daily reach is never added up.
 * For a goal whose result is reach (awareness) the result is that same reach, not the sum of the daily rows' results, and its
 * cost per person divides the same span's spend: that day's, or the whole run's (the run total's own spend, `runSpendMinor`),
 * never a part of the run's spend by the whole run's reach. CTR and CPM come from the summed clicks, impressions and spend.
 */
export function overviewView(input: {
  totals: Totals;
  source: OverviewView["source"];
  runReach: number | null;
  /** The run total's own spend (R3a), read with its reach. */
  runSpendMinor?: bigint | null;
  dayReach: number | null;
  singleDay: boolean;
  currency: string;
  resultKey: string | null;
}): OverviewView {
  const { totals: t, currency } = input;
  const reach = input.singleDay ? input.dayReach : input.runReach;
  const reachGoal = isReachGoal(input.resultKey);
  const costScope: OverviewView["costScope"] = !reachGoal ? "range" : input.singleDay ? "day" : "run";
  const results = reachGoal ? reach : t.uncounted ? null : t.results;
  const costSpend = costScope === "run" ? (input.runSpendMinor ?? null) : t.spendMinor;
  const cost = results === null || costSpend === null ? null : costPerResultBig(costSpend, results);
  const cpm = costPer1000(t.spendMinor, t.impressions);
  const one = resultNoun(input.resultKey, 1);
  return {
    spendMinor: t.spendMinor.toString(),
    spend: formatMoney(t.spendMinor, currency),
    results,
    resultsText: results === null ? (reachGoal ? RESULTS_COPY.reachMissing : RESULTS_COPY.notCounted) : `${formatCount(results)} ${resultNoun(input.resultKey, results)}`,
    costPerResultMinor: cost === null ? null : cost.toString(),
    costPerResult: cost === null ? null : displayCost(cost, currency),
    costPerResultLabel: `Cost per ${one}${costScope === "run" ? " (whole run)" : costScope === "day" ? " that day" : ""}`,
    costScope,
    reach,
    reachLabel: reach === null ? RESULTS_COPY.reachMissing : input.singleDay ? RESULTS_COPY.dayReach : RESULTS_COPY.runReach,
    reachScope: reach === null ? null : input.singleDay ? "day" : "run",
    impressions: t.impressions,
    clicks: t.clicks,
    ctr: clicksPer100(t.clicks, t.impressions),
    ctrLabel: RESULTS_COPY.ctr,
    cpmMinor: cpm === null ? null : cpm.toString(),
    cpm: cpm === null ? null : formatMoney(cpm, currency),
    cpmLabel: RESULTS_COPY.cpm,
    source: input.source,
  };
}

// =====================================================================================================================
// Loading (database)
// =====================================================================================================================

export type ResultsCampaign = {
  id: string;
  name: string;
  goal: string | null;
  template: string;
  objective: string;
  currency: string;
  metaCampaignId: string | null;
  sourceKind: string | null;
  adSets: {
    id: string;
    name: string;
    metaAdSetId: string | null;
    variantKey: string | null;
    status: string;
    optimizationGoal?: string | null;
    ads: { id: string; name: string; metaAdId: string | null; variantLabel: string | null }[];
  }[];
};

const CAMPAIGN_SELECT = {
  id: true,
  name: true,
  goal: true,
  template: true,
  objective: true,
  currency: true,
  metaCampaignId: true,
  sourceKind: true,
  adSets: {
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      name: true,
      metaAdSetId: true,
      variantKey: true,
      status: true,
      optimizationGoal: true,
      ads: { orderBy: { createdAt: "asc" }, select: { id: true, name: true, metaAdId: true, variantLabel: true } },
    },
  },
} as const;

/** The workspace's campaign (its row id), or 404. */
export async function loadResultsCampaign(tenantId: string, campaignId: string): Promise<ResultsCampaign> {
  const c = (await prisma.adCampaign.findFirst({ where: { id: campaignId, tenantId }, select: CAMPAIGN_SELECT })) as ResultsCampaign | null;
  if (!c) throw new HttpError(404, "Campaign not found.");
  return c;
}

/** The launched ads of a campaign: Meta ad id, its name and its version (the ad set's A, B or C). */
export function launchedAds(c: ResultsCampaign): { metaAdId: string; name: string; adSetId: string; version: string | null }[] {
  return c.adSets.flatMap((s) =>
    s.ads.filter((a) => !!a.metaAdId).map((a) => ({ metaAdId: String(a.metaAdId), name: s.variantKey ? `Version ${s.variantKey}` : a.variantLabel || a.name, adSetId: s.id, version: s.variantKey })),
  );
}

const dayDate = (day: string) => new Date(`${day}T00:00:00.000Z`);

type Range = { from: string; to: string };

/** Stored breakdown rows of some ads or a campaign, by dimension, within the range (inclusive days). */
async function storedRows(tenantId: string, where: { entityType: "ad" | "campaign"; ids: string[]; dimensions: string[] }, range: Range): Promise<StoredBreakdown[]> {
  if (where.ids.length === 0) return [];
  return (await prisma.insightBreakdown.findMany({
    where: { tenantId, entityType: where.entityType, entityMetaId: { in: where.ids }, dimension: { in: where.dimensions }, date: { gte: dayDate(range.from), lte: dayDate(range.to) } },
    select: { entityMetaId: true, date: true, dimension: true, dimKey: true, spendMinor: true, impressions: true, clicks: true, results: true, reach: true, raw: true },
  })) as StoredBreakdown[];
}

/** Leads in the Leads hub per ad and app (test leads left out), created within the range. */
async function leadCounts(tenantId: string, adIds: string[], range: Range): Promise<LeadCount[]> {
  if (adIds.length === 0) return [];
  const groups = await prisma.lead.groupBy({
    by: ["adMetaId", "platform"],
    where: { tenantId, adMetaId: { in: adIds }, isTest: false, createdAt: { gte: dayDate(range.from), lt: new Date(dayDate(range.to).getTime() + 86_400_000) } },
    _count: { _all: true },
  });
  return groups.map((g) => ({ adMetaId: g.adMetaId, platform: g.platform, count: g._count._all }));
}

export type DimensionResult = {
  campaignId: string;
  dimension: ResultDimension;
  from: string;
  to: string;
  currency: string;
  goal: string | null;
  /** The plural result noun for the goal ("chats"). */
  resultNoun: string;
  /** What the rows measure: the goal's results, or views for a goal whose result is people reached (RESULTS_COPY.viewsNotReach). */
  measure: Measure;
  rows: (ResultRowView & Record<string, unknown>)[];
  assets?: (ResultRowView & { kind: string })[];
  overview?: OverviewView;
  leads?: LeadsView;
  /** Plain notes for the tab: the paid-only note on boosts, "No results yet". */
  notes: string[];
};

/** One Results tab of a campaign, from stored rows only. */
export async function dimensionRows(tenantId: string, campaignId: string, dimension: ResultDimension, range: Range): Promise<DimensionResult> {
  if (!isResultDimension(dimension)) throw new HttpError(400, "dimension must be overview, placement, creative, age_gender, region or leads.");
  const c = await loadResultsCampaign(tenantId, campaignId);
  const resultKey = campaignResultKey(c);
  // A reach goal's breakdown tabs show views: reach summed over days, placements or ads counts people more than once.
  const measure: Measure = dimension === "overview" || dimension === "leads" ? "results" : measureFor(resultKey);
  const ctx: RowContext = { currency: c.currency, resultKey, measure };
  const out: DimensionResult = { campaignId: c.id, dimension, from: range.from, to: range.to, currency: c.currency, goal: resultKey, resultNoun: resultNoun(resultKey), measure, rows: [], notes: [] };
  if (isBoost(c)) out.notes.push(RESULTS_COPY.paidOnly);
  if (measure === "views") out.notes.push(RESULTS_COPY.viewsNotReach);
  const ads = launchedAds(c);
  const adIds = ads.map((a) => a.metaAdId);
  if (!c.metaCampaignId) {
    out.notes.push(RESULTS_COPY.notLaunched);
    if (dimension === "overview") out.overview = overviewView({ totals: zero(), source: "none", runReach: null, dayReach: null, singleDay: range.from === range.to, currency: c.currency, resultKey });
    if (dimension === "leads") out.leads = leadsView([], [], []);
    return out;
  }
  const metaCampaignId = c.metaCampaignId;

  switch (dimension) {
    case "overview": {
      const rows = await storedRows(tenantId, { entityType: "ad", ids: adIds, dimensions: ["placement"] }, range);
      const single = range.from === range.to;
      const snaps = (await prisma.insightSnapshot.findMany({
        where: { tenantId, entityType: "campaign", entityMetaId: metaCampaignId, date: { gte: dayDate(range.from), lte: dayDate(range.to) } },
        select: { date: true, spendMinor: true, impressions: true, clicks: true, results: true, reach: true, messagingStarts: true, thruplays: true, raw: true },
      })) as (SnapshotLike & { date: Date; spendMinor: number; impressions: number; clicks: number; reach: number | null })[];
      // Day by day: the placement rows where the day has any, else the level sync's row for that day, so a range that starts
      // before the breakdowns do still counts every day once.
      const totals = rows.reduce((t, r) => addTo(t, r), zero());
      const covered = new Set(rows.map((r) => dayOf(r.date)));
      const actions = goalResultActions(resultKey, c.adSets.map((s) => s.optimizationGoal));
      let fromSnaps = 0;
      for (const s of snaps) {
        if (covered.has(dayOf(s.date))) continue;
        addSnapshot(totals, s, resultKey, actions);
        fromSnaps++;
      }
      const source: OverviewView["source"] = rows.length && fromSnaps ? "mixed" : rows.length ? "breakdowns" : fromSnaps ? "snapshots" : "none";
      const run = (await prisma.insightBreakdown.findFirst({
        where: { tenantId, entityType: "campaign", entityMetaId: metaCampaignId, dimension: "run_total", dimKey: RUN_TOTAL_KEY },
        orderBy: { syncedAt: "desc" },
        select: { reach: true, spendMinor: true },
      })) as { reach: number | null; spendMinor: MinorLike } | null;
      const dayReach = single && snaps.length === 1 && typeof snaps[0].reach === "number" ? snaps[0].reach : null;
      out.overview = overviewView({ totals, source, runReach: run?.reach ?? null, runSpendMinor: run ? big(run.spendMinor) : null, dayReach, singleDay: single, currency: c.currency, resultKey });
      if (source === "none") out.notes.push(RESULTS_COPY.noData);
      return out;
    }
    case "placement": {
      const rows = await storedRows(tenantId, { entityType: "ad", ids: adIds, dimensions: ["placement"] }, range);
      out.rows = placementRows(rows, ctx);
      break;
    }
    case "creative": {
      const [placements, assets] = await Promise.all([
        storedRows(tenantId, { entityType: "ad", ids: adIds, dimensions: ["placement"] }, range),
        storedRows(tenantId, { entityType: "ad", ids: adIds, dimensions: ["asset_body", "asset_title", "asset_image", "asset_video", "asset_cta"] }, range),
      ]);
      const byAd = totalsBy(placements, (r) => r.entityMetaId);
      out.rows = sortByCost(
        ads.map((a) => ({ a, totals: byAd.get(a.metaAdId) ?? zero() })),
        measure,
      ).map(({ a, totals }) => ({ ...rowView(a.metaAdId, a.name, totals, ctx), adSetId: a.adSetId, version: a.version }));
      out.assets = assetRows(assets, ctx);
      break;
    }
    case "age_gender":
    case "region": {
      const rows = await storedRows(tenantId, { entityType: "campaign", ids: [metaCampaignId], dimensions: [dimension] }, range);
      const by = totalsBy(rows, (r) => r.dimKey);
      const label = dimension === "age_gender" ? ageGenderLabel : regionLabel;
      out.rows = sortByCost(
        [...by].map(([key, totals]) => ({ key, totals })),
        measure,
      ).map(({ key, totals }) => rowView(key, label(key), totals, ctx));
      break;
    }
    case "leads": {
      const [counts, placements] = await Promise.all([leadCounts(tenantId, adIds, range), storedRows(tenantId, { entityType: "ad", ids: adIds, dimensions: ["placement"] }, range)]);
      out.leads = leadsView(
        ads.map((a) => ({ metaAdId: a.metaAdId, name: a.name })),
        counts,
        placements,
      );
      return out;
    }
  }
  if (out.rows.length === 0 || out.rows.every((r) => r.results === 0 && r.spendMinor === "0")) out.notes.push(RESULTS_COPY.noData);
  return out;
}
