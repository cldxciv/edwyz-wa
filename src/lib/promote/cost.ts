/**
 * The cost presenter (docs/IG-PAGE-ADS-SPEC.md 6.2, 3.1, 3.1a, 3.8, D5, D8, D32). Pure: built on Phase 0's runWorstCase
 * (src/lib/spend/worstcase.ts, request P0-5), so the card never shows less than reserveAds sets aside (6.1 rule 16).
 *
 * - presentCost: "About X in total", "At most Y" split by account month, today's part, what is left, and whether typing
 *   the figure is required (this month's worst case at least 50% of what is left this month, D5).
 * - maxFittingDaily: the largest daily total, in steps, whose today part and this-month part fit (exact: D fits, D + step
 *   does not). With versions, each share is what Phase 0 will see (3.8 rounding).
 * - maxFittingDays: the longest run (2 days at least, D31) up to the chosen days that fits at the chosen daily total.
 * - fixesFor: the one-tap fixes for a refusal, only those that fit.
 * - splitDaily: the fair-test split; each share rounds down to a whole major unit and the confirmed total is their sum.
 * - budgetStep / defaultDailyMinor: ₹10 and ₹300 in INR; in another currency the Phase 0 FX equivalent (3.1a).
 */
import type { SpendCopyCode } from "@/lib/spend/copy";
import { currencyExponent } from "@/lib/spend/money";
import { monthKey, resolveTimeZone } from "@/lib/spend/periods";
import { runWorstCase } from "@/lib/spend/worstcase";
import { formatDay, formatDayKey, formatMoney, formatTime, joinList, monthName, promoteText } from "./copy";
import { MIN_RUN_DAYS, runDates, setAsideFromToday } from "./dates";
import type { CostView, Fix, PromoteLang, StartMode } from "./types";

/** ₹10: the stepper step in INR (3.1). */
export const INR_STEP_MINOR = 1_000n;
/** ₹300: the default daily budget in INR (D8). */
export const INR_DEFAULT_DAILY_MINOR = 30_000n;
/** D5: typing the figure is required when this month's worst case is at least this share of what is left this month. */
export const TYPED_CONFIRM_PERCENT = 50n;
/** Up to 3 versions in a fair test (3.8). */
export const MAX_VERSIONS = 3;

const max0 = (x: bigint): bigint => (x < 0n ? 0n : x);
const floorTo = (x: bigint, step: bigint): bigint => (x / step) * step;
const ceilTo = (x: bigint, step: bigint): bigint => ((x + step - 1n) / step) * step;

/** One major unit of the currency in minor units (100 for INR and USD, 1 for JPY). */
export function majorUnit(currency: string): bigint {
  return 10n ** BigInt(currencyExponent(currency));
}

// ===== Versions (3.8) =====

export type DailySplit = { shares: bigint[]; shareMinor: bigint; confirmedTotalMinor: bigint };

/**
 * A fair test's split: every version gets the total divided by the number of versions, rounded down to a whole major
 * unit, so all shares are equal. confirmedTotalMinor (and every cost figure) is the sum of the shares, never the typed
 * total: ₹290 split 3 ways is ₹96 each, ₹288 in total.
 */
export function splitDaily(totalMinor: bigint, versions: number, currency: string): DailySplit {
  const n = Math.max(1, Math.min(MAX_VERSIONS, Math.floor(versions)));
  if (n === 1) return { shares: [max0(totalMinor)], shareMinor: max0(totalMinor), confirmedTotalMinor: max0(totalMinor) };
  const share = floorTo(max0(totalMinor) / BigInt(n), majorUnit(currency));
  const shares = Array.from({ length: n }, () => share);
  return { shares, shareMinor: share, confirmedTotalMinor: share * BigInt(n) };
}

// ===== The card's figures (6.2) =====

/** What the presenter needs from Phase 0's headroom (the full Headroom type fits). */
export type CostHeadroom = { currency: string; today: { left: bigint | null }; month: { left: bigint | null } };

export type PresentCostInput = {
  /** One entry per ad set (version), each with the daily budget Phase 0 will see. */
  sets: readonly { dailyMinor: bigint }[];
  startsAt: Date;
  endsAt: Date;
  /** The ad account's zone. */
  tz: string;
  headroom: CostHeadroom;
  lang?: PromoteLang;
  /** The ad account's currency; defaults to the headroom's (the readiness row catches a mismatch, 3.1a). */
  currency?: string;
  /** The month-crossing line says "the boost" or "the ads". */
  kind?: "boost" | "ads";
  now?: Date;
};

type RunFigures = { aboutMinor: bigint; totalMinor: bigint; todayMinor: bigint; byMonth: { month: string; minor: bigint }[] };

function runFigures(sets: readonly { dailyMinor: bigint }[], startsAt: Date, endsAt: Date, tz: string, now: Date): RunFigures {
  const months = new Map<string, bigint>();
  let aboutMinor = 0n;
  let totalMinor = 0n;
  let todayMinor = 0n;
  for (const s of sets) {
    const w = runWorstCase({ dailyMinor: s.dailyMinor, startsAt, endsAt, tz, now });
    aboutMinor += w.aboutMinor;
    totalMinor += w.totalMinor;
    todayMinor += w.todayMinor;
    for (const m of w.byMonth) months.set(m.month, (months.get(m.month) ?? 0n) + m.minor);
  }
  const byMonth = [...months.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([month, minor]) => ({ month, minor }));
  return { aboutMinor, totalMinor, todayMinor, byMonth };
}

/** True when today's part fits what is left today and this month's part fits what is left this month. No daily limit: nothing fits. */
function fitsHeadroom(f: Pick<RunFigures, "todayMinor" | "byMonth">, leftToday: bigint | null, leftMonth: bigint | null): boolean {
  if (leftToday === null) return false;
  const month = f.byMonth[0]?.minor ?? 0n;
  return f.todayMinor <= leftToday && (leftMonth === null || month <= leftMonth);
}

/** The cost card (6.2): figures, fit, the typed-confirmation flag and the plain lines in the language. */
export function presentCost(i: PresentCostInput): CostView {
  const now = i.now ?? new Date();
  const lang = i.lang ?? "en";
  const currency = i.currency ?? i.headroom.currency;
  const f = runFigures(i.sets, i.startsAt, i.endsAt, i.tz, now);
  const money = (minor: bigint) => formatMoney(minor, currency);
  const worstMonthMinor = f.byMonth[0]?.minor ?? 0n;
  const leftToday = i.headroom.today.left;
  const leftMonth = i.headroom.month.left;
  const leftTodayMinor = leftToday === null ? null : max0(leftToday - f.todayMinor);
  const leftMonthMinor = leftMonth === null ? null : max0(leftMonth - worstMonthMinor);
  const crossesMonth = f.byMonth.length > 1;
  const typedConfirmRequired = leftMonth !== null && worstMonthMinor > 0n && worstMonthMinor * 100n >= leftMonth * TYPED_CONFIRM_PERCENT;
  const later = setAsideFromToday(i.startsAt, now, i.tz);

  let byMonth: string;
  if (f.byMonth.length <= 1) {
    byMonth = promoteText("cost.by_month_one", { first: money(worstMonthMinor), firstMonth: monthName(f.byMonth[0]?.month ?? monthKeyOf(now, i.tz), lang) }, lang);
  } else if (f.byMonth.length === 2) {
    const [a, b] = f.byMonth;
    byMonth = promoteText("cost.by_month", { first: money(a.minor), firstMonth: monthName(a.month, lang), second: money(b.minor), secondMonth: monthName(b.month, lang) }, lang);
  } else {
    const items = f.byMonth.map((m) => promoteText("cost.by_month_item", { amount: money(m.minor), month: monthName(m.month, lang) }, lang));
    byMonth = promoteText("cost.by_month_many", { list: joinList(items, lang) }, lang);
  }

  let left: string | null = null;
  if (leftTodayMinor !== null) {
    left = leftMonthMinor === null ? promoteText("cost.left_today", { today: money(leftTodayMinor) }, lang) : promoteText("cost.left", { today: money(leftTodayMinor), month: money(leftMonthMinor) }, lang);
  }

  let monthCross: string | null = null;
  if (crossesMonth) {
    const next = f.byMonth[1].month;
    monthCross = promoteText(i.kind === "boost" ? "cost.month_cross" : "cost.month_cross_ads", { month: monthName(next, lang), date: formatDayKey(`${next}-01`, lang) }, lang);
  }

  return {
    currency,
    aboutTotalMinor: f.aboutMinor,
    atMostMinor: f.totalMinor,
    byMonth: f.byMonth,
    worstMonthMinor,
    todayMinor: f.todayMinor,
    leftTodayMinor,
    leftMonthMinor,
    fits: fitsHeadroom(f, leftToday, leftMonth),
    crossesMonth,
    typedConfirmRequired,
    setAsideFromToday: later,
    lines: {
      about: promoteText("cost.about", { amount: money(f.aboutMinor) }, lang),
      atMost: promoteText("cost.at_most", { amount: money(f.totalMinor) }, lang),
      byMonth,
      left,
      monthCross,
      setAside: later ? promoteText("cost.set_aside_from_today", { date: formatDay(i.startsAt, i.tz, lang) }, lang) : null,
    },
  };
}

const monthKeyOf = (at: Date, tz: string): string => monthKey(at, resolveTimeZone(tz));

// ===== What fits (3.1, 6.2) =====

export type FitInput = {
  startsAt: Date;
  endsAt: Date;
  tz: string;
  now: Date;
  /** Phase 0 headroom before this run; null today means no daily limit (spend.no_limit), so nothing fits. */
  leftTodayMinor: bigint | null;
  leftMonthMinor: bigint | null;
  /** ₹10, or the FX equivalent rounded up to a whole unit (budgetStep). */
  stepMinor: bigint;
  currency: string;
  /** Compare versions: the total is split (splitDaily) and every share counts. Default 1. */
  versions?: number;
  /** Meta's minimum daily budget for one ad set (C5); a share below it never fits. */
  minDailyMinor?: bigint | null;
  /** An upper bound for the search (for example a limit the UI shows). */
  capMinor?: bigint | null;
};

/** The figures Phase 0 will count for a daily total split over versions. */
function figuresAt(totalMinor: bigint, i: Pick<FitInput, "startsAt" | "endsAt" | "tz" | "now" | "currency" | "versions">): RunFigures & { shareMinor: bigint } {
  const split = splitDaily(totalMinor, i.versions ?? 1, i.currency);
  return { ...runFigures(split.shares.map((d) => ({ dailyMinor: d })), i.startsAt, i.endsAt, i.tz, i.now), shareMinor: split.shareMinor };
}

/** True when this daily total fits today and this month (and every share is above Meta's minimum, when given). */
export function dailyFits(totalMinor: bigint, i: FitInput): boolean {
  const f = figuresAt(totalMinor, i);
  if (f.shareMinor <= 0n) return false;
  if (i.minDailyMinor && f.shareMinor < i.minDailyMinor) return false;
  return fitsHeadroom(f, i.leftTodayMinor, i.leftMonthMinor);
}

/**
 * The largest daily total D, a multiple of the step, whose worst case fits what is left today and this month (and, for a
 * test, whose shares all fit). Null when nothing fits, or when a fitting total's share is below Meta's minimum. Exact: D
 * fits and D + step does not (unless D + step is above capMinor).
 */
export function maxFittingDaily(i: FitInput): bigint | null {
  if (i.leftTodayMinor === null || i.stepMinor <= 0n) return null;
  const n = BigInt(Math.max(1, Math.min(MAX_VERSIONS, Math.floor(i.versions ?? 1))));
  const fitsLimits = (d: bigint) => {
    const f = figuresAt(d, i);
    return f.shareMinor > 0n && fitsHeadroom(f, i.leftTodayMinor, i.leftMonthMinor);
  };
  // Today's part is at least the sum of the shares, which is at least D - n units, so D never exceeds left today + n units.
  let hi = (i.leftTodayMinor + n * majorUnit(i.currency)) / i.stepMinor + 1n;
  if (i.capMinor !== null && i.capMinor !== undefined) hi = hi < i.capMinor / i.stepMinor ? hi : i.capMinor / i.stepMinor;
  if (hi < 1n || !fitsLimits(i.stepMinor)) return null;
  let lo = 1n;
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    if (fitsLimits(mid * i.stepMinor)) lo = mid;
    else hi = mid - 1n;
  }
  const best = lo * i.stepMinor;
  if (i.minDailyMinor && splitDaily(best, Number(n), i.currency).shareMinor < i.minDailyMinor) return null;
  return best;
}

export type DaysFitInput = {
  dailyMinor: bigint;
  runDays: number;
  startMode: StartMode;
  startsAt?: Date | null;
  tz: string;
  now: Date;
  leftTodayMinor: bigint | null;
  leftMonthMinor: bigint | null;
  currency: string;
  versions?: number;
};

/** The longest run, from 2 days up to the chosen days, that fits at the chosen daily total. Null when even 2 days don't. */
export function maxFittingDays(i: DaysFitInput): number | null {
  const fitsFor = (days: number) => {
    const d = runDates({ runDays: days, startMode: i.startMode, startsAt: i.startsAt, tz: i.tz, now: i.now });
    return fitsHeadroom(figuresAt(i.dailyMinor, { ...i, startsAt: d.startsAt, endsAt: d.endsAt }), i.leftTodayMinor, i.leftMonthMinor);
  };
  if (i.runDays < MIN_RUN_DAYS || !fitsFor(MIN_RUN_DAYS)) return null;
  let lo = MIN_RUN_DAYS;
  let hi = i.runDays;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (fitsFor(mid)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// ===== One-tap fixes (3.3, 6.2) =====

/** A Phase 0 refusal code, or the promote-only "below Meta's minimum daily budget" (4.10). */
export type FixCode = SpendCopyCode | "promote.below_min";

export type FixInput = {
  /** The chosen daily total (before the split). */
  dailyMinor: bigint;
  runDays: number;
  startMode: StartMode;
  startsAt?: Date | null;
  tz: string;
  now: Date;
  leftTodayMinor: bigint | null;
  leftMonthMinor: bigint | null;
  currency: string;
  stepMinor: bigint;
  versions?: number;
  minDailyMinor?: bigint | null;
  /** spend.meta_rate: when Meta allows the next budget change. */
  retryAt?: Date | null;
  /** spend.meta_cap_too_low: minutes until a retry is worth it (Phase 0 default 20). */
  minutes?: number;
};

const LIMIT_CODES: ReadonlySet<string> = new Set(["spend.daily_limit", "spend.monthly_limit", "spend.probation"]);
const OWNER_CODES: ReadonlySet<string> = new Set(["spend.no_limit", "spend.currency", "spend.not_spending_account", "spend.only_owner_raise"]);

/**
 * The fixes for a refusal, only those that fit (3.3, 6.2):
 * - over a limit: [Lower to ₹X a day] (the largest daily total that fits), [Run N days instead] (the longest run that
 *   fits, never below 2 days), and always [Ask {owner} to raise the limit] (owners see [Spending limits]);
 * - spend.meta_cap_too_low and spend.meta_rate: only [Try again at {time}];
 * - spend.busy: [Try again];
 * - below Meta's minimum: [Raise to {amount}] when that fits, else the owner fix.
 */
export function fixesFor(code: FixCode, i: FixInput): Fix[] {
  if (code === "spend.busy") return [{ kind: "retry" }];
  if (code === "spend.meta_cap_too_low") return [{ kind: "retry_at", at: new Date(i.now.getTime() + (i.minutes ?? 20) * 60_000) }];
  if (code === "spend.meta_rate") return [{ kind: "retry_at", at: i.retryAt ?? new Date(i.now.getTime() + 60 * 60_000) }];
  if (OWNER_CODES.has(code)) return [{ kind: "ask_owner" }];
  const dates = runDates({ runDays: Math.max(i.runDays, 1), startMode: i.startMode, startsAt: i.startsAt, tz: i.tz, now: i.now });
  const fit: FitInput = { ...i, startsAt: dates.startsAt, endsAt: dates.endsAt };
  if (code === "promote.below_min") {
    if (!i.minDailyMinor || i.minDailyMinor <= 0n) return [];
    const n = Math.max(1, Math.min(MAX_VERSIONS, Math.floor(i.versions ?? 1)));
    let total = ceilTo(i.minDailyMinor * BigInt(n), i.stepMinor);
    for (let guard = 0; guard < 1_000 && splitDaily(total, n, i.currency).shareMinor < i.minDailyMinor; guard++) total += i.stepMinor;
    return dailyFits(total, fit) ? [{ kind: "raise_to_min", toMinor: total }] : [{ kind: "ask_owner" }];
  }
  if (!LIMIT_CODES.has(code)) return [];
  const out: Fix[] = [];
  const lower = maxFittingDaily(fit);
  if (lower !== null && lower < i.dailyMinor) out.push({ kind: "lower_daily", toMinor: lower });
  const days = maxFittingDays(i);
  if (days !== null && days >= MIN_RUN_DAYS && days < i.runDays) out.push({ kind: "fewer_days", days });
  out.push({ kind: "ask_owner" });
  return out;
}

/** A fix chip's label in the language (owners get [Spending limits] instead of "Ask {owner}"). */
export function fixLabel(fix: Fix, ctx: { currency: string; tz: string; lang?: PromoteLang; owner?: string; isOwner?: boolean }): string {
  const lang = ctx.lang ?? "en";
  switch (fix.kind) {
    case "lower_daily":
      return promoteText("fix.lower_daily", { amount: formatMoney(fix.toMinor, ctx.currency) }, lang);
    case "fewer_days":
      return promoteText("fix.fewer_days", { days: String(fix.days) }, lang);
    case "ask_owner":
      return ctx.isOwner ? promoteText("fix.spending_limits", {}, lang) : promoteText("fix.ask_owner", { owner: ctx.owner ?? "the owner" }, lang);
    case "retry_at":
      return promoteText("fix.retry_at", { time: formatTime(fix.at, ctx.tz) }, lang);
    case "retry":
      return promoteText("fix.retry", {}, lang);
    case "raise_to_min":
      return promoteText("fix.raise_to_min", { amount: formatMoney(fix.toMinor, ctx.currency) }, lang);
  }
}

// ===== Currency (3.1a, D8) =====

/** Phase 0's convertFromInr with a fresh rate (src/lib/spend/fx.ts), or null without one. Passed in, so this file stays pure. */
export type FromInr = (inrMinor: bigint) => bigint | null;

/**
 * The stepper step: ₹10 in INR; in another currency the FX equivalent of ₹10, rounded up to a whole major unit; with no
 * fresh FX rate, 1 major unit.
 */
export function budgetStep(currency: string, fromInr?: FromInr | null): bigint {
  if (currency.toUpperCase() === "INR") return INR_STEP_MINOR;
  const unit = majorUnit(currency);
  const converted = fromInr ? fromInr(INR_STEP_MINOR) : null;
  if (converted === null || converted <= 0n) return unit;
  return ceilTo(converted, unit);
}

export type DefaultDailyInput = {
  currency: string;
  fromInr?: FromInr | null;
  /** maxFittingDaily for the run; null when nothing fits or it is unknown. */
  maxFittingMinor?: bigint | null;
  /** Meta's minimum for the ad account (C5), when known. */
  minDailyMinor?: bigint | null;
};

/**
 * The default daily budget (D8, 3.1, 3.1a): min(₹300, the largest amount that fits), rounded down to ₹10, never below the
 * account minimum. Another currency: the FX equivalent of ₹300 rounded down to a whole unit, then the same rule. With no
 * fresh FX rate: Meta's minimum, or null when that is unknown too (the member types an amount).
 */
export function defaultDailyMinor(i: DefaultDailyInput): bigint | null {
  const inr = i.currency.toUpperCase() === "INR";
  const unit = majorUnit(i.currency);
  let base: bigint | null;
  if (inr) base = INR_DEFAULT_DAILY_MINOR;
  else {
    const converted = i.fromInr ? i.fromInr(INR_DEFAULT_DAILY_MINOR) : null;
    base = converted === null || converted <= 0n ? null : floorTo(converted, unit);
  }
  if (base === null || base <= 0n) return i.minDailyMinor && i.minDailyMinor > 0n ? i.minDailyMinor : null;
  let d = i.maxFittingMinor !== null && i.maxFittingMinor !== undefined && i.maxFittingMinor > 0n && i.maxFittingMinor < base ? i.maxFittingMinor : base;
  if (inr) d = floorTo(d, INR_STEP_MINOR);
  if (i.minDailyMinor && d < i.minDailyMinor) d = i.minDailyMinor;
  return d > 0n ? d : null;
}
