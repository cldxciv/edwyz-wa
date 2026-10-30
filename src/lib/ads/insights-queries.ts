import { prisma } from "@/lib/db";
import { costPerResultMinor } from "./insights-money";
import type { InsightLevel } from "./insights-fetch";
import { isLowQuality } from "./insights-map";

export const FATIGUE_FREQUENCY = 3;
export const PACING_DAYS = 3;
const ROW_CAP = 50_000;

export type Totals = { spendMinor: number; impressions: number; clicks: number; results: number; ctr: number | null; costPerResultMinor: number | null };
export type DayPoint = { day: string; spendMinor: number; impressions: number; clicks: number; results: number };
export type EntityRow = Totals & { entityMetaId: string; name: string };

type SnapRow = {
  entityMetaId: string;
  date: Date;
  spendMinor: number;
  impressions: number;
  clicks: number;
  results: number;
  frequency: number | null;
  qualityRanking: string | null;
};

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);

export function addDaysYmd(s: string, n: number): string {
  return ymd(new Date(day(s).getTime() + n * 86_400_000));
}

export function listDaysYmd(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDaysYmd(d, 1)) out.push(d);
  return out;
}

function rows(tenantId: string, entityType: InsightLevel, from: string, to: string, ids?: string[]): Promise<SnapRow[]> {
  return prisma.insightSnapshot.findMany({
    where: { tenantId, entityType, date: { gte: day(from), lte: day(to) }, ...(ids ? { entityMetaId: { in: ids } } : {}) },
    select: { entityMetaId: true, date: true, spendMinor: true, impressions: true, clicks: true, results: true, frequency: true, qualityRanking: true },
    orderBy: { date: "asc" },
    take: ROW_CAP,
  }) as Promise<SnapRow[]>;
}

export function totalsOf(list: Pick<SnapRow, "spendMinor" | "impressions" | "clicks" | "results">[]): Totals {
  let spendMinor = 0;
  let impressions = 0;
  let clicks = 0;
  let results = 0;
  for (const r of list) {
    spendMinor += r.spendMinor;
    impressions += r.impressions;
    clicks += r.clicks;
    results += r.results;
  }
  return {
    spendMinor,
    impressions,
    clicks,
    results,
    ctr: impressions > 0 ? Math.round((clicks / impressions) * 10_000) / 100 : null,
    costPerResultMinor: costPerResultMinor(spendMinor, results),
  };
}

/** Single account currency of the tenant's ads, or null when unknown or mixed. */
export async function tenantCurrency(tenantId: string): Promise<{ currency: string | null; mixed: boolean }> {
  const [campaigns, assets] = await Promise.all([
    prisma.adCampaign.findMany({ where: { tenantId }, select: { currency: true }, distinct: ["currency"] }),
    prisma.metaAsset.findMany({ where: { tenantId, type: "ad_account" }, select: { meta: true } }),
  ]);
  const set = new Set<string>();
  for (const c of campaigns) set.add(c.currency.toUpperCase());
  for (const a of assets) {
    const cur = (a.meta as { currency?: unknown } | null)?.currency;
    if (typeof cur === "string" && cur) set.add(cur.toUpperCase());
  }
  return { currency: set.size === 1 ? [...set][0] : null, mixed: set.size > 1 };
}

/** Totals for the period and the equally long period before it. Campaign rows only, so levels are never double counted. */
export async function summaryByPeriod(tenantId: string, from: string, to: string): Promise<{ current: Totals; previous: Totals }> {
  const span = listDaysYmd(from, to).length;
  const prevTo = addDaysYmd(from, -1);
  const prevFrom = addDaysYmd(prevTo, -(span - 1));
  const [cur, prev] = await Promise.all([rows(tenantId, "campaign", from, to), rows(tenantId, "campaign", prevFrom, prevTo)]);
  return { current: totalsOf(cur), previous: totalsOf(prev) };
}

/** One point per calendar day in the range, zero filled. */
export async function dailySeries(tenantId: string, from: string, to: string): Promise<DayPoint[]> {
  const list = await rows(tenantId, "campaign", from, to);
  const byDay = new Map<string, SnapRow[]>();
  for (const r of list) {
    const k = ymd(r.date);
    byDay.set(k, [...(byDay.get(k) ?? []), r]);
  }
  return listDaysYmd(from, to).map((d) => {
    const t = totalsOf(byDay.get(d) ?? []);
    return { day: d, spendMinor: t.spendMinor, impressions: t.impressions, clicks: t.clicks, results: t.results };
  });
}

async function namesFor(tenantId: string, level: InsightLevel, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  if (level === "campaign") {
    const r = await prisma.adCampaign.findMany({ where: { tenantId, metaCampaignId: { in: ids } }, select: { metaCampaignId: true, name: true } });
    return new Map(r.map((x) => [x.metaCampaignId as string, x.name]));
  }
  if (level === "adset") {
    const r = await prisma.adSet.findMany({ where: { tenantId, metaAdSetId: { in: ids } }, select: { metaAdSetId: true, name: true } });
    return new Map(r.map((x) => [x.metaAdSetId as string, x.name]));
  }
  const r = await prisma.ad.findMany({ where: { tenantId, metaAdId: { in: ids } }, select: { metaAdId: true, name: true } });
  return new Map(r.map((x) => [x.metaAdId as string, x.name]));
}

/** Per-entity totals for one level over the range, highest spend first. */
export async function breakdownByLevel(tenantId: string, level: InsightLevel, from: string, to: string, limit = 100): Promise<EntityRow[]> {
  const list = await rows(tenantId, level, from, to);
  const groups = new Map<string, SnapRow[]>();
  for (const r of list) groups.set(r.entityMetaId, [...(groups.get(r.entityMetaId) ?? []), r]);
  const names = await namesFor(tenantId, level, [...groups.keys()]);
  return [...groups.entries()]
    .map(([id, g]) => ({ entityMetaId: id, name: names.get(id) ?? id, ...totalsOf(g) }))
    .sort((a, b) => b.spendMinor - a.spendMinor)
    .slice(0, limit);
}

/**
 * Best ads are those with results, lowest cost per result first. Worst ads are those that spent with no results (most spend first),
 * then those with the highest cost per result. Ads with no spend are ignored.
 */
export async function topAndBottomAds(tenantId: string, from: string, to: string, n = 5): Promise<{ top: EntityRow[]; bottom: EntityRow[] }> {
  const all = (await breakdownByLevel(tenantId, "ad", from, to, ROW_CAP)).filter((r) => r.spendMinor > 0);
  const withResults = all.filter((r) => r.results > 0).sort((a, b) => (a.costPerResultMinor as number) - (b.costPerResultMinor as number));
  const noResults = all.filter((r) => r.results === 0).sort((a, b) => b.spendMinor - a.spendMinor);
  const bottom = [...noResults, ...[...withResults].reverse()].slice(0, n);
  return { top: withResults.slice(0, n), bottom };
}

export type FatigueCandidate = { entityMetaId: string; name: string; frequency: number | null; qualityRanking: string | null; reasons: ("frequency" | "quality")[] };

/** Ads whose latest frequency in the range is at or above the threshold, or whose latest quality ranking is below average. */
export async function fatigueCandidates(tenantId: string, from: string, to: string, threshold = FATIGUE_FREQUENCY): Promise<FatigueCandidate[]> {
  const list = await rows(tenantId, "ad", from, to);
  const latest = new Map<string, { frequency: number | null; ranking: string | null; spend: number }>();
  for (const r of list) {
    const cur = latest.get(r.entityMetaId) ?? { frequency: null, ranking: null, spend: 0 };
    cur.spend += r.spendMinor;
    if (r.frequency !== null) cur.frequency = r.frequency;
    if (r.qualityRanking) cur.ranking = r.qualityRanking;
    latest.set(r.entityMetaId, cur);
  }
  const hits = [...latest.entries()].filter(([, v]) => v.spend > 0 && ((v.frequency ?? 0) >= threshold || isLowQuality(v.ranking)));
  const names = await namesFor(tenantId, "ad", hits.map(([id]) => id));
  return hits
    .map(([id, v]) => ({
      entityMetaId: id,
      name: names.get(id) ?? id,
      frequency: v.frequency,
      qualityRanking: v.ranking,
      reasons: [...((v.frequency ?? 0) >= threshold ? (["frequency"] as const) : []), ...(isLowQuality(v.ranking) ? (["quality"] as const) : [])],
    }))
    .sort((a, b) => (b.frequency ?? 0) - (a.frequency ?? 0));
}

export type PacingRow = {
  campaignId: string;
  metaCampaignId: string;
  name: string;
  dailyBudgetMinor: number;
  avgDailySpendMinor: number;
  pacingPct: number;
  state: "under" | "on_track" | "over";
};

/** Average daily spend of the last PACING_DAYS days ending at `to` against each active campaign's daily budget. */
export async function spendPacing(tenantId: string, to: string): Promise<PacingRow[]> {
  const campaigns = await prisma.adCampaign.findMany({
    where: { tenantId, status: "active", metaCampaignId: { not: null } },
    select: { id: true, metaCampaignId: true, name: true, dailyBudgetMinor: true },
  });
  if (campaigns.length === 0) return [];
  const ids = campaigns.map((c) => c.metaCampaignId as string);
  const list = await rows(tenantId, "campaign", addDaysYmd(to, -(PACING_DAYS - 1)), to, ids);
  const spent = new Map<string, number>();
  for (const r of list) spent.set(r.entityMetaId, (spent.get(r.entityMetaId) ?? 0) + r.spendMinor);
  return campaigns
    .filter((c) => c.dailyBudgetMinor > 0)
    .map((c) => {
      const avg = Math.round((spent.get(c.metaCampaignId as string) ?? 0) / PACING_DAYS);
      const pct = Math.round((avg * 100) / c.dailyBudgetMinor);
      return {
        campaignId: c.id,
        metaCampaignId: c.metaCampaignId as string,
        name: c.name,
        dailyBudgetMinor: c.dailyBudgetMinor,
        avgDailySpendMinor: avg,
        pacingPct: pct,
        state: pct < 70 ? ("under" as const) : pct > 110 ? ("over" as const) : ("on_track" as const),
      };
    });
}

export async function connectionStatus(tenantId: string): Promise<{ connected: boolean; adAccounts: number }> {
  const [connected, adAccounts] = await Promise.all([
    prisma.metaConnection.count({ where: { tenantId, status: "active" } }),
    prisma.metaAsset.count({ where: { tenantId, type: "ad_account", status: "active" } }),
  ]);
  return { connected: connected > 0, adAccounts };
}
