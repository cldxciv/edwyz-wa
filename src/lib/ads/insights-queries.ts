import { prisma } from "@/lib/db";
import { HttpError } from "@/lib/tenancy";
import { costPerResultMinor } from "./insights-money";
import type { InsightLevel } from "./insights-fetch";
import { isLowQuality } from "./insights-map";

export const FATIGUE_FREQUENCY = 3;
export const PACING_DAYS = 3;
const ROW_CAP = 50_000;

export type Totals = { spendMinor: number; impressions: number; clicks: number; results: number; ctr: number | null; costPerResultMinor: number | null };
export type DayPoint = { day: string; spendMinor: number; impressions: number; clicks: number; results: number };
/** currency: the ad account currency of the entity's spend, null when it cannot be told. */
export type EntityRow = Totals & { entityMetaId: string; name: string; currency: string | null };
export type CurrencyTotals = { currency: string | null; current: Totals; previous: Totals };

/**
 * One ad account of the workspace, for ?adAccount= filters. A snapshot belongs to it when Meta said so (raw.accountId,
 * stored since the sync asks for account_id); older snapshots are matched through Edwyz's own campaigns of that account.
 */
export type AccountScope = { assetId: string; externalId: string; name: string | null; currency: string | null; campaignIds: Set<string> };

type SnapRow = {
  entityMetaId: string;
  date: Date;
  spendMinor: number;
  impressions: number;
  clicks: number;
  results: number;
  frequency: number | null;
  qualityRanking: string | null;
  raw?: unknown;
};

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
const rawOf = (r: Pick<SnapRow, "raw">): Record<string, unknown> => (r.raw && typeof r.raw === "object" && !Array.isArray(r.raw) ? (r.raw as Record<string, unknown>) : {});
const rawString = (r: Pick<SnapRow, "raw">, key: string): string | null => {
  const v = rawOf(r)[key];
  return typeof v === "string" && v ? v : null;
};
const stripAct = (id: string) => id.replace(/^act_/, "");
const currencyOfMeta = (meta: unknown): string | null => {
  const c = (meta as { currency?: unknown } | null)?.currency;
  return typeof c === "string" && /^[A-Za-z]{3}$/.test(c) ? c.toUpperCase() : null;
};

export function addDaysYmd(s: string, n: number): string {
  return ymd(new Date(day(s).getTime() + n * 86_400_000));
}

export function listDaysYmd(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDaysYmd(d, 1)) out.push(d);
  return out;
}

/** The Meta campaign id a snapshot belongs to: the entity itself at campaign level, raw.campaignId below it. */
const campaignIdOf = (level: InsightLevel, r: SnapRow): string | null => (level === "campaign" ? r.entityMetaId : rawString(r, "campaignId"));

export function inScope(level: InsightLevel, r: SnapRow, scope: AccountScope): boolean {
  const account = rawString(r, "accountId");
  if (account) return stripAct(account) === scope.externalId;
  const campaign = campaignIdOf(level, r);
  return !!campaign && scope.campaignIds.has(campaign);
}

async function rows(tenantId: string, entityType: InsightLevel, from: string, to: string, ids?: string[], scope?: AccountScope | null): Promise<SnapRow[]> {
  const list = (await prisma.insightSnapshot.findMany({
    where: { tenantId, entityType, date: { gte: day(from), lte: day(to) }, ...(ids ? { entityMetaId: { in: ids } } : {}) },
    select: { entityMetaId: true, date: true, spendMinor: true, impressions: true, clicks: true, results: true, frequency: true, qualityRanking: true, raw: true },
    orderBy: { date: "asc" },
    take: ROW_CAP,
  })) as SnapRow[];
  return scope ? list.filter((r) => inScope(entityType, r, scope)) : list;
}

/** The workspace's ad account by its row id, with the Edwyz campaigns made in it. Throws 404 for another workspace's id. */
export async function accountScope(tenantId: string, adAccountAssetId: string): Promise<AccountScope> {
  const assets = (await prisma.metaAsset.findMany({ where: { tenantId, type: "ad_account" }, select: { id: true, externalId: true, name: true, meta: true } })) as { id: string; externalId: string; name: string | null; meta: unknown }[];
  const asset = assets.find((a) => a.id === adAccountAssetId);
  if (!asset) throw new HttpError(404, "Ad account not found.");
  const campaigns = (await prisma.adCampaign.findMany({ where: { tenantId, adAccountAssetId }, select: { metaCampaignId: true, adAccountAssetId: true } })) as { metaCampaignId: string | null; adAccountAssetId?: string }[];
  return {
    assetId: asset.id,
    externalId: stripAct(asset.externalId),
    name: asset.name,
    currency: currencyOfMeta(asset.meta),
    campaignIds: new Set(campaigns.filter((c) => !c.adAccountAssetId || c.adAccountAssetId === adAccountAssetId).map((c) => c.metaCampaignId).filter((v): v is string => !!v)),
  };
}

/** The workspace's ad accounts for the insights picker. */
export async function insightAccounts(tenantId: string): Promise<{ id: string; name: string | null; currency: string | null }[]> {
  const assets = (await prisma.metaAsset.findMany({ where: { tenantId, type: "ad_account" }, select: { id: true, name: true, meta: true } })) as { id: string; name: string | null; meta: unknown }[];
  return assets.filter((a) => typeof a.id === "string").map((a) => ({ id: a.id, name: a.name ?? null, currency: currencyOfMeta(a.meta) }));
}

/**
 * Tells the currency of a snapshot: what Meta said (raw.currency), else its ad account's, else its Edwyz campaign's, else
 * the workspace's single currency. Null when none of these is known.
 */
async function currencyResolver(tenantId: string): Promise<(level: InsightLevel, r: SnapRow) => string | null> {
  const [assets, campaigns, single] = await Promise.all([
    prisma.metaAsset.findMany({ where: { tenantId, type: "ad_account" }, select: { externalId: true, meta: true } }) as Promise<{ externalId?: string; meta: unknown }[]>,
    prisma.adCampaign.findMany({ where: { tenantId, metaCampaignId: { not: null } }, select: { metaCampaignId: true, currency: true } }) as Promise<{ metaCampaignId: string | null; currency: string }[]>,
    tenantCurrency(tenantId),
  ]);
  const byAccount = new Map<string, string>();
  for (const a of assets) {
    const c = currencyOfMeta(a.meta);
    if (a.externalId && c) byAccount.set(stripAct(a.externalId), c);
  }
  const byCampaign = new Map<string, string>();
  for (const c of campaigns) if (c.metaCampaignId && c.currency) byCampaign.set(c.metaCampaignId, c.currency.toUpperCase());
  return (level, r) => {
    const own = rawString(r, "currency");
    if (own) return own.toUpperCase();
    const account = rawString(r, "accountId");
    const fromAccount = account ? byAccount.get(stripAct(account)) : undefined;
    if (fromAccount) return fromAccount;
    const campaign = campaignIdOf(level, r);
    return (campaign ? byCampaign.get(campaign) : undefined) ?? single.currency;
  };
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

const previousPeriod = (from: string, to: string) => {
  const span = listDaysYmd(from, to).length;
  const prevTo = addDaysYmd(from, -1);
  return { prevFrom: addDaysYmd(prevTo, -(span - 1)), prevTo };
};

/** Totals for the period and the equally long period before it. Campaign rows only, so levels are never double counted. */
export async function summaryByPeriod(tenantId: string, from: string, to: string, scope?: AccountScope | null): Promise<{ current: Totals; previous: Totals }> {
  const { prevFrom, prevTo } = previousPeriod(from, to);
  const [cur, prev] = await Promise.all([rows(tenantId, "campaign", from, to, undefined, scope), rows(tenantId, "campaign", prevFrom, prevTo, undefined, scope)]);
  return { current: totalsOf(cur), previous: totalsOf(prev) };
}

/**
 * The same totals, one set per currency (for a workspace whose ad accounts use different currencies, so money of different
 * currencies is never added up). Highest spend first.
 */
export async function summaryByCurrency(tenantId: string, from: string, to: string): Promise<CurrencyTotals[]> {
  const { prevFrom, prevTo } = previousPeriod(from, to);
  const [cur, prev, currencyOf] = await Promise.all([rows(tenantId, "campaign", from, to), rows(tenantId, "campaign", prevFrom, prevTo), currencyResolver(tenantId)]);
  const group = (list: SnapRow[]) => {
    const out = new Map<string | null, SnapRow[]>();
    for (const r of list) {
      const c = currencyOf("campaign", r);
      out.set(c, [...(out.get(c) ?? []), r]);
    }
    return out;
  };
  const now = group(cur);
  const before = group(prev);
  return [...new Set([...now.keys(), ...before.keys()])]
    .map((currency) => ({ currency, current: totalsOf(now.get(currency) ?? []), previous: totalsOf(before.get(currency) ?? []) }))
    .sort((a, b) => b.current.spendMinor - a.current.spendMinor);
}

/** One point per calendar day in the range, zero filled. */
export async function dailySeries(tenantId: string, from: string, to: string, scope?: AccountScope | null): Promise<DayPoint[]> {
  const list = await rows(tenantId, "campaign", from, to, undefined, scope);
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

/** Names of Edwyz's own campaigns, ad sets or ads by Meta id. */
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

/** The name shown for an entity: Edwyz's own name, else the latest name Meta sent (campaigns made in Ads Manager), else the id. */
function displayName(id: string, local: Map<string, string>, group: SnapRow[]): string {
  const own = local.get(id);
  if (own) return own;
  for (let i = group.length - 1; i >= 0; i--) {
    const name = rawString(group[i], "name");
    if (name) return name;
  }
  return id;
}

/** Per-entity totals for one level over the range, highest spend first. */
export async function breakdownByLevel(tenantId: string, level: InsightLevel, from: string, to: string, limit = 100, scope?: AccountScope | null): Promise<EntityRow[]> {
  const list = await rows(tenantId, level, from, to, undefined, scope);
  const groups = new Map<string, SnapRow[]>();
  for (const r of list) groups.set(r.entityMetaId, [...(groups.get(r.entityMetaId) ?? []), r]);
  const [names, currencyOf] = await Promise.all([namesFor(tenantId, level, [...groups.keys()]), scope ? Promise.resolve(null) : currencyResolver(tenantId)]);
  return [...groups.entries()]
    .map(([id, g]) => ({ entityMetaId: id, name: displayName(id, names, g), currency: scope ? scope.currency : (currencyOf?.(level, g[g.length - 1]) ?? null), ...totalsOf(g) }))
    .sort((a, b) => b.spendMinor - a.spendMinor)
    .slice(0, limit);
}

/**
 * Best ads are those with results, lowest cost per result first. Worst ads are those that spent with no results (most spend first),
 * then those with the highest cost per result. Ads with no spend are ignored.
 */
export async function topAndBottomAds(tenantId: string, from: string, to: string, n = 5, scope?: AccountScope | null): Promise<{ top: EntityRow[]; bottom: EntityRow[] }> {
  const all = (await breakdownByLevel(tenantId, "ad", from, to, ROW_CAP, scope)).filter((r) => r.spendMinor > 0);
  const withResults = all.filter((r) => r.results > 0).sort((a, b) => (a.costPerResultMinor as number) - (b.costPerResultMinor as number));
  const noResults = all.filter((r) => r.results === 0).sort((a, b) => b.spendMinor - a.spendMinor);
  const bottom = [...noResults, ...[...withResults].reverse()].slice(0, n);
  return { top: withResults.slice(0, n), bottom };
}

export type FatigueCandidate = { entityMetaId: string; name: string; frequency: number | null; qualityRanking: string | null; reasons: ("frequency" | "quality")[] };

/** Ads whose latest frequency in the range is at or above the threshold, or whose latest quality ranking is below average. */
export async function fatigueCandidates(tenantId: string, from: string, to: string, threshold = FATIGUE_FREQUENCY, scope?: AccountScope | null): Promise<FatigueCandidate[]> {
  const list = await rows(tenantId, "ad", from, to, undefined, scope);
  const latest = new Map<string, { frequency: number | null; ranking: string | null; spend: number; rows: SnapRow[] }>();
  for (const r of list) {
    const cur = latest.get(r.entityMetaId) ?? { frequency: null, ranking: null, spend: 0, rows: [] };
    cur.spend += r.spendMinor;
    cur.rows.push(r);
    if (r.frequency !== null) cur.frequency = r.frequency;
    if (r.qualityRanking) cur.ranking = r.qualityRanking;
    latest.set(r.entityMetaId, cur);
  }
  const hits = [...latest.entries()].filter(([, v]) => v.spend > 0 && ((v.frequency ?? 0) >= threshold || isLowQuality(v.ranking)));
  const names = await namesFor(tenantId, "ad", hits.map(([id]) => id));
  return hits
    .map(([id, v]) => ({
      entityMetaId: id,
      name: displayName(id, names, v.rows),
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
  currency: string;
};

/** Average daily spend of the last PACING_DAYS days ending at `to` against each active campaign's daily budget. */
export async function spendPacing(tenantId: string, to: string, scope?: AccountScope | null): Promise<PacingRow[]> {
  const campaigns = (await prisma.adCampaign.findMany({
    where: { tenantId, status: "active", metaCampaignId: { not: null }, ...(scope ? { adAccountAssetId: scope.assetId } : {}) },
    select: { id: true, metaCampaignId: true, name: true, dailyBudgetMinor: true, currency: true, adAccountAssetId: true },
  })) as { id: string; metaCampaignId: string | null; name: string; dailyBudgetMinor: number; currency: string; adAccountAssetId?: string }[];
  const chosen = scope ? campaigns.filter((c) => !c.adAccountAssetId || c.adAccountAssetId === scope.assetId) : campaigns;
  if (chosen.length === 0) return [];
  const ids = chosen.map((c) => c.metaCampaignId as string);
  const list = await rows(tenantId, "campaign", addDaysYmd(to, -(PACING_DAYS - 1)), to, ids);
  const spent = new Map<string, number>();
  for (const r of list) spent.set(r.entityMetaId, (spent.get(r.entityMetaId) ?? 0) + r.spendMinor);
  return chosen
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
        currency: (c.currency ?? "").toUpperCase(),
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
