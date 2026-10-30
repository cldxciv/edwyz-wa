/**
 * Worst-case maths of the ads pot (docs/SPEND-CONTROLS-SPEC.md 4.5). Pure: no database, no network, no clock (callers pass
 * `now`). Integer bigint arithmetic throughout, rounding UP (3.1), so nothing overflows and nothing is under-counted.
 *
 * Meta may spend up to 75% over an ad set's daily budget on one day (its rule uses the day's HIGHEST budget, so a mid-day cut
 * does not lower today's worst case) and at most 7x the week's highest daily budget per Sunday-to-Saturday week, both in the
 * ad account's time zone. So:
 *
 * - ceil175(x) = (7x + 3) / 4, the day cap of a daily budget x;
 * - dayRisk(c) = max(0, ceil175(peakToday) - spentToday): what today could still add;
 * - remainingMonth(c) walks the account days from today to min(end day, month end), end day inclusive. Each day takes
 *   min(day cap - spent today (today only), what is left of its week's room). The current week's room is 7 x max(D, weekPeak)
 *   minus the spend already made that week, including days of the previous month; later weeks start at 7 x D. A lifetime
 *   budget caps the sum (Meta never exceeds it). Without an end date the horizon is the month end; the next month reserves
 *   again at rollover.
 * - (critic) A lifetime-only commitment (lifetime budget, no daily budget) has no documented per-day ceiling, so until runbook
 *   V10 measures one its dayRisk is the whole remainder L - spentLifetime, and remainingMonth is the same amount.
 * - (critic) Ad set budget sharing found on: 2.1x a day (ceil210(x) = (21x + 9) / 10) and 8.4x a week.
 * - External risk (only when Meta's limit is managed, decision 2.3.4): E = the highest daily outside spend of the last 7 days;
 *   day risk max(0, E - outside spend today); the month walk runs with D = E. Always shown as an estimate.
 *
 * The shapes (CommitmentMath, CommitmentSpend) match src/lib/spend/commitments.ts, so the book can use this module directly.
 */
import { addDays, compareDays, dayKey, monthEndDay, resolveTimeZone, weekStartOfDay } from "./periods";

/** A campaign whose end passed this long ago can no longer spend (clock skew allowance). */
export const ENDED_GRACE_MS = 15 * 60_000;

const max0 = (x: bigint): bigint => (x < 0n ? 0n : x);
const minB = (a: bigint, b: bigint): bigint => (a < b ? a : b);
const maxB = (a: bigint, b: bigint): bigint => (a > b ? a : b);

/** ceil(1.75 x) in integers: Meta's day worst case of a daily budget. 0 for 0 or less. */
export function ceil175(x: bigint): bigint {
  return x <= 0n ? 0n : (7n * x + 3n) / 4n;
}

/** ceil(2.1 x) in integers: the measured day worst case when ad set budget sharing is on (4.5, critic). */
export function ceil210(x: bigint): bigint {
  return x <= 0n ? 0n : (21n * x + 9n) / 10n;
}

/** The day cap of a daily budget: 1.75x, or 2.1x with budget sharing. */
export function dayCap(x: bigint, sharing = false): bigint {
  return sharing ? ceil210(x) : ceil175(x);
}

/** The week cap of a daily budget: 7x, or ceil(8.4x) with budget sharing. */
export function weekCap(x: bigint, sharing = false): bigint {
  if (x <= 0n) return 0n;
  return sharing ? (42n * x + 4n) / 5n : 7n * x;
}

/**
 * The largest daily budget C whose worst case fits a daily limit: floor(4 x limit / 7), so ceil175(C) <= limit and
 * ceil175(C + 1) > limit. The /api/ads/caps shim (4.8) and the "up to ₹1,142 a day in ad budgets" note (4.4) use it.
 */
export function maxDailyBudgetWithin(limit: bigint): bigint {
  return limit <= 0n ? 0n : (4n * limit) / 7n;
}

/** What the maths needs to know about one commitment, with peaks already rolled to the current day and week. */
export type CommitmentMath = {
  /** D, the current daily budget (null for a lifetime-only commitment). */
  dailyBudgetMinor: bigint | null;
  /** L, the lifetime budget. */
  lifetimeBudgetMinor: bigint | null;
  /** The highest daily budget this account day (at least D). */
  peakToday: bigint;
  /** The highest daily budget this Sunday-to-Saturday week (at least peakToday). */
  weekPeak: bigint;
  endsAt: Date | null;
  /** Ad set budget sharing found on (4.5): 2.1x a day and 8.4x a week. */
  sharing?: boolean;
};

/** Spend already made by one commitment: per account day, and over its lifetime as far as it is known. */
export type CommitmentSpend = {
  /** Spend per account day key ("YYYY-MM-DD"), also for days of the previous month in the current week. */
  byDay: ReadonlyMap<string, bigint>;
  /** Spend since the commitment started (for a lifetime budget). */
  lifetime: bigint;
  /** Today's spend; null when it is unknown (no fast sync for 60 minutes), which means the full day worst case. */
  today: bigint | null;
};

export const NO_SPEND: CommitmentSpend = Object.freeze({ byDay: new Map<string, bigint>(), lifetime: 0n, today: 0n });

/** True when the commitment's end has passed (with the 15-minute allowance): it cannot spend any more. */
export function hasEnded(c: Pick<CommitmentMath, "endsAt">, now: Date): boolean {
  return !!c.endsAt && c.endsAt.getTime() + ENDED_GRACE_MS < now.getTime();
}

/** A lifetime budget and no daily budget. */
export function isLifetimeOnly(c: Pick<CommitmentMath, "dailyBudgetMinor" | "lifetimeBudgetMinor">): boolean {
  return (c.dailyBudgetMinor === null || c.dailyBudgetMinor <= 0n) && c.lifetimeBudgetMinor !== null;
}

/** L - spentLifetime, floored at 0; null without a lifetime budget. */
export function lifetimeLeft(c: Pick<CommitmentMath, "lifetimeBudgetMinor">, spend: Pick<CommitmentSpend, "lifetime">): bigint | null {
  return c.lifetimeBudgetMinor === null ? null : max0(c.lifetimeBudgetMinor - max0(spend.lifetime));
}

/**
 * Today's worst case still to come: max(0, day cap of peakToday - spentToday). Unknown spend counts as 0 (the whole day). A
 * lifetime-only commitment can spend all that is left of its lifetime budget today (critic, until runbook V10). Never negative,
 * so spend above 1.75x (Meta's own overshoot, or a late revision) gives 0, not a refund.
 */
export function dayRisk(c: CommitmentMath, spend: CommitmentSpend, now: Date): bigint {
  if (hasEnded(c, now)) return 0n;
  const left = lifetimeLeft(c, spend);
  if (isLifetimeOnly(c)) return left ?? 0n;
  const peak = maxB(c.peakToday, c.dailyBudgetMinor ?? 0n);
  const risk = max0(dayCap(peak, c.sharing) - max0(spend.today ?? 0n));
  return left === null ? risk : minB(risk, left);
}

/** The last account day a commitment can spend on: the day of its end (inclusive), or null without an end. */
export function endDayOf(c: Pick<CommitmentMath, "endsAt">, timeZone: string): string | null {
  return c.endsAt ? dayKey(c.endsAt, resolveTimeZone(timeZone)) : null;
}

/**
 * The worst case from now to the end date or the end of the account month, whichever is first (4.5). See the module header
 * for the walk. `timeZone` is the ad account's zone; an unknown zone falls back to Asia/Kolkata.
 */
export function remainingMonth(c: CommitmentMath, now: Date, timeZone: string, spend: CommitmentSpend): bigint {
  if (hasEnded(c, now)) return 0n;
  const left = lifetimeLeft(c, spend);
  if (isLifetimeOnly(c)) return left ?? 0n;
  const d = max0(c.dailyBudgetMinor ?? 0n);
  const peakToday = maxB(c.peakToday, d);
  const weekPeak = maxB(c.weekPeak, peakToday);
  const tz = resolveTimeZone(timeZone);
  const today = dayKey(now, tz);
  const monthEnd = monthEndDay(today.slice(0, 7));
  const endDay = endDayOf(c, tz) ?? monthEnd;
  const horizon = compareDays(endDay, monthEnd) < 0 ? endDay : monthEnd;
  if (compareDays(horizon, today) < 0) return 0n;
  const spentToday = max0(spend.today ?? 0n);
  const thisWeek = weekStartOfDay(today);
  let sum = 0n;
  let week = "";
  let room = 0n;
  for (let day = today; compareDays(day, horizon) <= 0; day = addDays(day, 1)) {
    const wk = weekStartOfDay(day);
    if (wk !== week) {
      week = wk;
      if (wk === thisWeek) {
        // Spend already made this week, on days before today (also in the previous month), plus today's.
        let spentThisWeek = spentToday;
        for (let x = wk; compareDays(x, today) < 0; x = addDays(x, 1)) spentThisWeek += max0(spend.byDay.get(x) ?? 0n);
        room = max0(weekCap(maxB(d, weekPeak), c.sharing) - spentThisWeek);
      } else room = weekCap(d, c.sharing);
    }
    const cap = day === today ? max0(dayCap(peakToday, c.sharing) - spentToday) : dayCap(d, c.sharing);
    const take = max0(minB(cap, room));
    room -= take;
    sum += take;
  }
  return left === null ? sum : minB(sum, left);
}

/** Both figures of one commitment. */
export function commitmentWorstCase(c: CommitmentMath, now: Date, timeZone: string, spend: CommitmentSpend = NO_SPEND): { dayRisk: bigint; remainingMonth: bigint } {
  return { dayRisk: dayRisk(c, spend, now), remainingMonth: remainingMonth(c, now, timeZone, spend) };
}

export type ExternalRisk = {
  /** The highest daily outside spend of the last 7 days (and today). */
  e: bigint;
  /** max(0, E - outside spend today). */
  day: bigint;
  /** The month walk with D = E. */
  month: bigint;
  spentToday: bigint;
  /** Always an estimate: the UI labels it so. */
  estimated: true;
};

/**
 * Outside spend on a managed account (4.5): spend on the account from campaigns not made in Edwyz, per account day. E is
 * the highest daily value of the last 7 days (today included); the day risk is max(0, E - outside spend today) and the month
 * walk runs with D = E.
 */
export function externalRisk(byDay: ReadonlyMap<string, bigint>, now: Date, timeZone: string): ExternalRisk {
  const tz = resolveTimeZone(timeZone);
  const today = dayKey(now, tz);
  let e = 0n;
  for (let i = 0; i <= 7; i++) e = maxB(e, max0(byDay.get(addDays(today, -i)) ?? 0n));
  const spentToday = max0(byDay.get(today) ?? 0n);
  if (e === 0n) return { e, day: 0n, month: 0n, spentToday, estimated: true };
  const month = remainingMonth({ dailyBudgetMinor: e, lifetimeBudgetMinor: null, peakToday: e, weekPeak: e, endsAt: null }, now, tz, { byDay, lifetime: 0n, today: spentToday });
  return { e, day: max0(e - spentToday), month, spentToday, estimated: true };
}

/**
 * Peaks after a budget change at `now` (4.6 step 6 and 11): a raise lifts today's and the week's peak; a cut lowers D only,
 * because Meta's 175% rule uses the day's highest budget. `peakToday`/`weekPeak` must already be rolled to today and this week.
 */
export function withBudgetChange(c: CommitmentMath, toMinor: bigint): CommitmentMath {
  const to = max0(toMinor);
  const peakToday = maxB(maxB(c.peakToday, c.dailyBudgetMinor ?? 0n), to);
  return { ...c, dailyBudgetMinor: to, peakToday, weekPeak: maxB(c.weekPeak, peakToday) };
}

/** Sum of a list of bigints (committed totals). */
export function sumMinor(values: Iterable<bigint>): bigint {
  let total = 0n;
  for (const v of values) total += v;
  return total;
}
