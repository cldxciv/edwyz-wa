import { formatMinor } from "@/lib/spend/money";
import type { OptimizerConfig } from "./config";

export type Snap = {
  entityMetaId: string;
  date: Date;
  spendMinor: number;
  impressions: number;
  clicks: number;
  results: number;
  frequency: number | null;
};

export type AdRef = { metaId: string; name: string; adSetMetaId: string; campaignMetaId: string; hookText?: string };
export type AdSetRef = { metaId: string; name: string; campaignMetaId: string; dailyBudgetMinor: number | null };

export type ProposalKind = "pause_ad" | "shift_budget" | "rotate_creative" | "new_angle";
export type ProposalDraft = {
  kind: ProposalKind;
  targetType: "ad" | "adset" | "campaign";
  targetMetaId: string;
  rationale: string;
  payload: Record<string, unknown>;
};

type Totals = { spendMinor: number; impressions: number; clicks: number; results: number };
const DAY_MS = 86_400_000;
const zero = (): Totals => ({ spendMinor: 0, impressions: 0, clicks: 0, results: 0 });
const dayStart = (d: Date) => Math.floor(d.getTime() / DAY_MS);

/** Days between the snapshot date and now (0 = today). Negative for future dates. */
export const ageDays = (date: Date, now: Date) => dayStart(now) - dayStart(date);

function totalsFor(snaps: Snap[], id: string, now: Date, fromAge: number, toAge: number): Totals {
  const t = zero();
  for (const s of snaps) {
    const a = ageDays(s.date, now);
    if (s.entityMetaId !== id || a < fromAge || a >= toAge) continue;
    t.spendMinor += s.spendMinor;
    t.impressions += s.impressions;
    t.clicks += s.clicks;
    t.results += s.results;
  }
  return t;
}

const cpr = (t: Totals) => (t.results > 0 ? t.spendMinor / t.results : null);
const ctr = (t: Totals) => (t.impressions > 0 ? t.clicks / t.impressions : null);
const round = (n: number) => Math.round(n);
const pct = (n: number) => Math.round(n * 10) / 10;
/** Plain money for a rationale ("₹31", "₹1,02,340"), in the ad account currency with its exponent, never a raw number. */
const moneyIn = (currency: string) => (minor: number) => formatMinor(BigInt(Math.max(0, round(minor))), currency);

function groupBy<T>(items: T[], key: (i: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const i of items) m.set(key(i), [...(m.get(key(i)) ?? []), i]);
  return m;
}

function campaignAverages(ads: AdRef[], snaps: Snap[], now: Date, days: number) {
  const out = new Map<string, Totals>();
  for (const [campaign, group] of groupBy(ads, (a) => a.campaignMetaId)) {
    const t = zero();
    for (const ad of group) {
      const a = totalsFor(snaps, ad.metaId, now, 0, days);
      t.spendMinor += a.spendMinor;
      t.results += a.results;
    }
    out.set(campaign, t);
  }
  return out;
}

export function pauseAdProposals(ads: AdRef[], snaps: Snap[], cfg: OptimizerConfig, now: Date, currency = "INR"): ProposalDraft[] {
  const money = moneyIn(currency);
  const averages = campaignAverages(ads, snaps, now, cfg.windowDays);
  const peers = groupBy(ads, (a) => a.campaignMetaId);
  const drafts: ProposalDraft[] = [];
  for (const ad of ads) {
    const t = totalsFor(snaps, ad.metaId, now, 0, cfg.windowDays);
    if (t.spendMinor <= 0 || t.spendMinor < cfg.minSpendMinor) continue;
    const avg = cpr(averages.get(ad.campaignMetaId) ?? zero());
    const own = cpr(t);
    const base = { spendMinor: t.spendMinor, results: t.results, windowDays: cfg.windowDays, adName: ad.name };
    if (t.results === 0 && t.spendMinor >= cfg.zeroResultSpendMinor) {
      drafts.push({
        kind: "pause_ad",
        targetType: "ad",
        targetMetaId: ad.metaId,
        rationale: `Spent ${money(t.spendMinor)} in ${cfg.windowDays} days with no results.`,
        payload: { ...base, reason: "zero_results" },
      });
    } else if (own !== null && avg !== null && (peers.get(ad.campaignMetaId)?.length ?? 0) > 1 && own > avg * cfg.cprMultiple) {
      drafts.push({
        kind: "pause_ad",
        targetType: "ad",
        targetMetaId: ad.metaId,
        rationale: `Cost per result is ${pct(own / avg)} times the campaign average over ${cfg.windowDays} days (${money(own)} against ${money(avg)}).`,
        payload: { ...base, reason: "high_cpr", cprMinor: round(own), campaignCprMinor: round(avg), multiple: pct(own / avg) },
      });
    }
  }
  return drafts;
}

export type BudgetLimits = { maxDailyBudgetMinor: number | null };

/** Largest safe move: at most maxShiftPct (never above 20) of the donor budget, donor stays above the floor, receiver stays at or below the cap. */
export function shiftAmount(fromBudget: number, toBudget: number, cfg: OptimizerConfig, cap: number): number {
  const pctCap = Math.floor((fromBudget * Math.min(cfg.maxShiftPct, 20)) / 100);
  const floorRoom = fromBudget - cfg.minAdSetBudgetMinor;
  const capRoom = cap - toBudget;
  return Math.max(0, Math.min(pctCap, floorRoom, capRoom));
}

export function shiftBudgetProposals(adSets: AdSetRef[], snaps: Snap[], cfg: OptimizerConfig, now: Date, limits: BudgetLimits, currency = "INR"): ProposalDraft[] {
  const money = moneyIn(currency);
  const cap = limits.maxDailyBudgetMinor;
  if (cap === null || cap <= 0) return [];
  const drafts: ProposalDraft[] = [];
  for (const [campaign, group] of groupBy(adSets, (a) => a.campaignMetaId)) {
    const scored = group
      .filter((a): a is AdSetRef & { dailyBudgetMinor: number } => a.dailyBudgetMinor !== null && a.dailyBudgetMinor > 0)
      .map((a) => ({ a, t: totalsFor(snaps, a.metaId, now, 0, cfg.windowDays) }))
      .filter(({ t }) => t.spendMinor >= cfg.minSpendMinor && t.results > 0)
      .map(({ a, t }) => ({ a, cost: t.spendMinor / t.results }));
    if (scored.length < 2) continue;
    const sorted = [...scored].sort((x, y) => x.cost - y.cost);
    const best = sorted[0];
    const worst = sorted[sorted.length - 1];
    if (best.a.metaId === worst.a.metaId || worst.cost < best.cost * cfg.shiftCprRatio) continue;
    const amount = shiftAmount(worst.a.dailyBudgetMinor, best.a.dailyBudgetMinor, cfg, cap);
    if (amount <= 0) continue;
    drafts.push({
      kind: "shift_budget",
      targetType: "adset",
      targetMetaId: worst.a.metaId,
      rationale: `Ad set "${worst.a.name}" costs ${money(worst.cost)} per result against ${money(best.cost)} for "${best.a.name}" over ${cfg.windowDays} days. Move ${money(amount)} of daily budget (${pct((amount / worst.a.dailyBudgetMinor) * 100)}%).`,
      payload: {
        campaignMetaId: campaign,
        fromAdSetMetaId: worst.a.metaId,
        toAdSetMetaId: best.a.metaId,
        fromBudgetBefore: worst.a.dailyBudgetMinor,
        fromBudgetAfter: worst.a.dailyBudgetMinor - amount,
        toBudgetBefore: best.a.dailyBudgetMinor,
        toBudgetAfter: best.a.dailyBudgetMinor + amount,
        amountMinor: amount,
        fromCprMinor: round(worst.cost),
        toCprMinor: round(best.cost),
        capMinor: cap,
        windowDays: cfg.windowDays,
      },
    });
  }
  return drafts;
}

export function rotateCreativeProposals(ads: AdRef[], snaps: Snap[], cfg: OptimizerConfig, now: Date): ProposalDraft[] {
  const drafts: ProposalDraft[] = [];
  const recentDays = Math.max(1, Math.floor(cfg.windowDays / 2));
  for (const ad of ads) {
    const own = snaps.filter((s) => s.entityMetaId === ad.metaId && ageDays(s.date, now) >= 0 && ageDays(s.date, now) < cfg.windowDays);
    const latest = own.filter((s) => s.frequency !== null).sort((x, y) => y.date.getTime() - x.date.getTime())[0];
    if (!latest || (latest.frequency as number) <= cfg.frequencyThreshold) continue;
    const recent = totalsFor(snaps, ad.metaId, now, 0, recentDays);
    const earlier = totalsFor(snaps, ad.metaId, now, recentDays, cfg.windowDays);
    if (recent.impressions < cfg.minImpressions || earlier.impressions < cfg.minImpressions) continue;
    const r = ctr(recent) as number;
    const e = ctr(earlier) as number;
    if (e <= 0) continue;
    const drop = ((e - r) / e) * 100;
    if (drop < cfg.ctrDropPct) continue;
    drafts.push({
      kind: "rotate_creative",
      targetType: "ad",
      targetMetaId: ad.metaId,
      rationale: `Frequency is ${pct(latest.frequency as number)} and click-through rate fell ${pct(drop)}% (${pct(e * 100)}% to ${pct(r * 100)}%). Refresh the creative.`,
      payload: { adName: ad.name, frequency: latest.frequency, ctrBefore: e, ctrAfter: r, ctrDropPct: pct(drop), advisory: true },
    });
  }
  return drafts;
}

const HOOKS: { id: string; label: string; test: (text: string) => boolean }[] = [
  { id: "question", label: "open with a question", test: (t) => /\?/.test(t.split(/[.!\n]/)[0] ?? "") || /^(are|do|does|is|want|need|looking|why|how|what|ready)\b/i.test(t) },
  { id: "number", label: "lead with a number or price", test: (t) => /\d/.test(t.slice(0, 40)) },
  { id: "offer", label: "state a clear offer", test: (t) => /\b(free|\d+\s?%|off|discount|offer|sale|save)\b/i.test(t) },
  { id: "urgency", label: "add urgency", test: (t) => /\b(today|now|limited|last|ends|hurry|only)\b/i.test(t) },
  { id: "social_proof", label: "show social proof", test: (t) => /\b(trusted|rated|customers|reviews?|loved)\b/i.test(t) },
];

export function hookPatterns(text: string): string[] {
  const clean = text.trim();
  return clean ? HOOKS.filter((h) => h.test(clean)).map((h) => h.id) : [];
}

/** Text suggestion only. Nothing is created or changed on Meta. */
export function newAngleProposals(ads: AdRef[], snaps: Snap[], cfg: OptimizerConfig, now: Date, currency = "INR"): ProposalDraft[] {
  const money = moneyIn(currency);
  const drafts: ProposalDraft[] = [];
  const averages = campaignAverages(ads, snaps, now, cfg.windowDays);
  for (const [campaign, group] of groupBy(ads, (a) => a.campaignMetaId)) {
    const avg = cpr(averages.get(campaign) ?? zero());
    if (avg === null) continue;
    const judged = group
      .map((ad) => ({ ad, t: totalsFor(snaps, ad.metaId, now, 0, cfg.windowDays) }))
      .filter(({ t }) => t.spendMinor >= cfg.minSpendMinor && t.results > 0);
    const winners = judged.filter(({ t }) => t.spendMinor / t.results <= avg * cfg.winnerCprRatio);
    if (winners.length < cfg.minWinners) continue;
    const counts = new Map<string, number>();
    for (const w of winners) for (const p of hookPatterns(w.ad.hookText ?? "")) counts.set(p, (counts.get(p) ?? 0) + 1);
    const top = [...counts.entries()].filter(([, n]) => n >= cfg.minWinners && n / winners.length > 0.5).sort((a, b) => b[1] - a[1])[0];
    const hook = top && HOOKS.find((h) => h.id === top[0]);
    if (!top || !hook) continue;
    const winnerCpr = winners.reduce((s, w) => s + w.t.spendMinor, 0) / winners.reduce((s, w) => s + w.t.results, 0);
    drafts.push({
      kind: "new_angle",
      targetType: "campaign",
      targetMetaId: campaign,
      rationale: `${top[1]} of ${winners.length} winning ads ${hook.label} and cost ${money(winnerCpr)} per result against a campaign average of ${money(avg)}.`,
      payload: {
        pattern: hook.id,
        suggestion: `Write a new variant that will ${hook.label}, reusing the offer of your best ad. Test it as a new ad in the same ad set.`,
        winningAdMetaIds: winners.map((w) => w.ad.metaId),
        winnerCprMinor: round(winnerCpr),
        campaignCprMinor: round(avg),
        advisory: true,
      },
    });
  }
  return drafts;
}

export function allProposals(input: { ads: AdRef[]; adSets: AdSetRef[]; adSnaps: Snap[]; adSetSnaps: Snap[]; cfg: OptimizerConfig; now: Date; limits: BudgetLimits; currency?: string }): ProposalDraft[] {
  const { ads, adSets, adSnaps, adSetSnaps, cfg, now, limits } = input;
  const currency = input.currency ?? "INR";
  if (!cfg.enabled) return [];
  return [
    ...pauseAdProposals(ads, adSnaps, cfg, now, currency),
    ...shiftBudgetProposals(adSets, adSetSnaps, cfg, now, limits, currency),
    ...rotateCreativeProposals(ads, adSnaps, cfg, now),
    ...newAngleProposals(ads, adSnaps, cfg, now, currency),
  ];
}
