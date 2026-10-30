/**
 * Anomaly breakers (docs/SPEND-CONTROLS-SPEC.md 6.2).
 *
 * - cpm_ctr_anomaly (ad set): over the last hour, with at least 1,000 impressions, CPM at or above 2.5 x the 7-day median CPM,
 *   or CTR at or below 0.33 x the 7-day median CTR. Blocks raises on the ad set and notifies; assistants at Level 1 or 2 may
 *   still pause it (a lowering). Clears by itself 24 hours after the last time it was seen; a repeat restarts the 24 hours.
 * - account_spike (workspace): the whole account spent more today than 1.5 x its busiest day of the last 7 days, and more than
 *   INR 1,000 equivalent. Blocks raises (this covers spend from Ads Manager) and notifies; clears at the next account day.
 * The maths is exact: medians and ratios are compared as fractions of whole numbers, never floats.
 */
import { formatMinor } from "../money";
import { addDays, dayKey } from "../periods";
import { adsTimezone, DAY_MS, inrEquivalentMinor, nextAccountMidnight, tripBreaker, watchedAdSets, type BreakerContext, type DailyRow, type SampleRow } from "./ads";

export const ANOMALY_MIN_IMPRESSIONS = 1_000n;
export const ANOMALY_WINDOW_MS = 60 * 60_000;
/** Samples this close to an hour apart still count as "the last hour" (syncs run every 15 minutes). */
const WINDOW_SLACK_MS = 5 * 60_000;
export const ANOMALY_MIN_HISTORY_DAYS = 3;
export const ACCOUNT_SPIKE_FLOOR_INR_MINOR = 100_000n;

/** A non-negative fraction num/den (den > 0). */
export type Fraction = { num: bigint; den: bigint };

const cmp = (a: Fraction, b: Fraction): number => {
  const l = a.num * b.den;
  const r = b.num * a.den;
  return l < r ? -1 : l > r ? 1 : 0;
};

/** The median of fractions, as a fraction (the mean of the two middle values for an even count). Null for none. */
export function medianFraction(values: Fraction[]): Fraction | null {
  const v = values.filter((f) => f.den > 0n).sort(cmp);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  if (v.length % 2 === 1) return v[mid];
  const a = v[mid - 1];
  const b = v[mid];
  return { num: a.num * b.den + b.num * a.den, den: 2n * a.den * b.den };
}

export type HourFigures = { spendMinor: bigint; impressions: bigint; clicks: bigint };

/**
 * cpm_ctr_anomaly (pure). `history` is the ad set's daily rows of the previous 7 days. CPM = spend x 1000 / impressions;
 * CTR = clicks / impressions. Needs 1,000 impressions in the hour and 3 days with impressions in the history.
 */
export function cpmCtrCheck(hour: HourFigures, history: Pick<DailyRow, "amountMinor" | "impressions" | "clicks">[]): { trip: boolean; why: "cpm" | "ctr" | null; medianCpm: Fraction | null; medianCtr: Fraction | null } {
  const days = history.filter((d) => d.impressions > 0n);
  const medianCpm = medianFraction(days.map((d) => ({ num: d.amountMinor * 1000n, den: d.impressions })));
  const medianCtr = medianFraction(days.map((d) => ({ num: d.clicks, den: d.impressions })));
  if (hour.impressions < ANOMALY_MIN_IMPRESSIONS || days.length < ANOMALY_MIN_HISTORY_DAYS) return { trip: false, why: null, medianCpm, medianCtr };
  // CPM_hour >= 2.5 x median:  spend*1000/impr >= 25/10 * num/den  <=>  spend*1000*den*10 >= 25*num*impr
  if (medianCpm && medianCpm.num > 0n && hour.spendMinor * 1000n * medianCpm.den * 10n >= 25n * medianCpm.num * hour.impressions) return { trip: true, why: "cpm", medianCpm, medianCtr };
  // CTR_hour <= 0.33 x median:  clicks/impr <= 33/100 * num/den  <=>  clicks*den*100 <= 33*num*impr
  if (medianCtr && medianCtr.num > 0n && hour.clicks * medianCtr.den * 100n <= 33n * medianCtr.num * hour.impressions) return { trip: true, why: "ctr", medianCpm, medianCtr };
  return { trip: false, why: null, medianCpm, medianCtr };
}

/** The last hour of one ad set from its intraday samples: the newest sample and the newest one at least an hour older. */
export function lastHour(samples: SampleRow[]): HourFigures | null {
  const s = [...samples].sort((a, b) => a.sampledAt.getTime() - b.sampledAt.getTime());
  const last = s[s.length - 1];
  if (!last) return null;
  const start = [...s].reverse().find((x) => x.accountDate === last.accountDate && last.sampledAt.getTime() - x.sampledAt.getTime() >= ANOMALY_WINDOW_MS - WINDOW_SLACK_MS);
  if (!start) return null;
  return { spendMinor: last.spendMinor - start.spendMinor, impressions: last.impressions - start.impressions, clicks: last.clicks - start.clicks };
}

const per1000 = (f: Fraction | null): bigint => (f && f.den > 0n ? f.num / f.den : 0n);

export async function runCpmCtrAnomaly(ctx: BreakerContext): Promise<void> {
  const tz = adsTimezone(ctx);
  const today = dayKey(ctx.now, tz);
  const from = addDays(today, -7);
  const cur = ctx.currency;
  for (const c of watchedAdSets(ctx)) {
    const hour = lastHour(ctx.samples.filter((x) => x.entityType === "adset" && x.entityMetaId === c.metaObjectId));
    if (!hour) continue;
    const history = ctx.daily.filter((r) => r.origin === "platform" && r.scopeType === "adset" && r.scopeId === c.metaObjectId && r.day >= from && r.day < today);
    const check = cpmCtrCheck(hour, history);
    if (!check.trip) continue;
    const name = ctx.adSetNames.get(c.metaObjectId) ?? ctx.campaigns.get(c.campaignId)?.name ?? "An ad set";
    const hourCpm = hour.impressions > 0n ? (hour.spendMinor * 1000n) / hour.impressions : 0n;
    const facts =
      check.why === "cpm"
        ? `Ads in '${name}' cost ${formatMinor(hourCpm, cur)} per 1,000 views in the last hour, against about ${formatMinor(per1000(check.medianCpm), cur)} on a usual day.`
        : `People clicked ads in '${name}' far less often in the last hour than on a usual day.`;
    const autoClearAt = new Date(ctx.now.getTime() + DAY_MS);
    const res = await tripBreaker(ctx, {
      tenantId: ctx.tenantId,
      kind: "cpm_ctr_anomaly",
      scopeType: "adset",
      scopeId: c.metaObjectId,
      effect: "block_raises",
      reason: facts,
      details: { why: check.why, impressions: hour.impressions, spendMinor: hour.spendMinor, clicks: hour.clicks },
      autoClearAt,
      notice: { title: `Unusual results in '${name}'`, body: `${facts} Budget increases for it are on hold for 24 hours.`, severity: "heads_up" },
    });
    // A repeat while it is open restarts the 24 hours ("auto after 24 h with no repeat").
    if (!res.created) await ctx.db.spendBreaker.updateMany({ where: { id: res.breaker.id, state: "tripped" }, data: { autoClearAt } });
  }
}

/** account_spike (pure): today > 1.5 x the busiest of the previous 7 days (which must have spend), and above the floor. */
export function accountSpikeCheck(todayMinor: bigint, previousDays: bigint[], floorMinor: bigint): { trip: boolean; peakMinor: bigint } {
  const peak = previousDays.reduce((m, v) => (v > m ? v : m), 0n);
  return { trip: peak > 0n && todayMinor * 10n > peak * 15n && todayMinor > floorMinor, peakMinor: peak };
}

export async function runAccountSpike(ctx: BreakerContext): Promise<void> {
  const account = ctx.detail.state.spendingAccount;
  if (!account) return;
  const tz = account.timezone;
  const today = dayKey(ctx.now, tz);
  const ids = new Set([account.assetId, account.externalId, account.externalId.replace(/^act_/, ""), `act_${account.externalId.replace(/^act_/, "")}`]);
  const rows = ctx.daily.filter((r) => r.scopeType === "account" && r.origin === "all" && ids.has(r.scopeId));
  const byDay = new Map<string, bigint>();
  for (const r of rows) byDay.set(r.day, (byDay.get(r.day) ?? 0n) + r.amountMinor);
  const previous: bigint[] = [];
  for (let i = 1; i <= 7; i++) previous.push(byDay.get(addDays(today, -i)) ?? 0n);
  const spent = byDay.get(today) ?? 0n;
  const check = accountSpikeCheck(spent, previous, inrEquivalentMinor(ACCOUNT_SPIKE_FLOOR_INR_MINOR, ctx.currency, ctx.fx, ctx.now));
  if (!check.trip) return;
  const cur = ctx.currency;
  const facts = `Your ad account spent ${formatMinor(spent, cur)} today, more than 1.5 times its busiest day this week (${formatMinor(check.peakMinor, cur)}).`;
  await tripBreaker(ctx, {
    tenantId: ctx.tenantId,
    kind: "account_spike",
    scopeType: "workspace",
    scopeId: ctx.tenantId,
    effect: "block_raises",
    reason: facts,
    details: { day: today, spentMinor: spent, peakMinor: check.peakMinor },
    autoClearAt: nextAccountMidnight(ctx.now, tz),
    notice: { title: "Your ad account is spending much more than usual", body: `${facts} This includes ads run in Meta Ads Manager. Budget increases are on hold until tomorrow.` },
  });
}
