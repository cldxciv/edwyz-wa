import { readFileSync } from "node:fs";
import path from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { formatMinor } from "@/lib/spend/money";
import { addDays, compareDays, dayKey, monthEndDay, startOfLocalDay, weekStartOfDay } from "@/lib/spend/periods";
import {
  ceil175,
  ceil210,
  commitmentWorstCase,
  dayCap,
  dayRisk,
  externalRisk,
  hasEnded,
  maxDailyBudgetWithin,
  NO_SPEND,
  remainingMonth,
  RUN_MAX_DAYS,
  runWorstCase,
  weekCap,
  withBudgetChange,
  type CommitmentMath,
  type CommitmentSpend,
  type RunWorstCaseInput,
} from "@/lib/spend/worstcase";

/** docs/SPEND-CONTROLS-SPEC.md 4.5 and 10.1 (spend-worstcase.test.ts). */

const IST = "Asia/Kolkata";
const NY = "America/New_York";
const HOUR = 3_600_000;
const at = (day: string, tz: string, hours = 1) => new Date(startOfLocalDay(day, tz).getTime() + hours * HOUR);
const daily = (d: bigint, over: Partial<CommitmentMath> = {}): CommitmentMath => ({ dailyBudgetMinor: d, lifetimeBudgetMinor: null, peakToday: d, weekPeak: d, endsAt: null, ...over });
const spend = (over: Partial<CommitmentSpend> = {}): CommitmentSpend => ({ byDay: new Map(), lifetime: 0n, today: 0n, ...over });
const RS_1000 = 100_000n; // ₹1,000 a day in paise

describe("integer rounding (3.1: worst case rounds up)", () => {
  it("ceil175 is (7x + 3) / 4 and never rounds down", () => {
    expect(ceil175(100_000n)).toBe(175_000n);
    expect(ceil175(1n)).toBe(2n); // 1.75 -> 2
    expect(ceil175(3n)).toBe(6n); // 5.25 -> 6
    expect(ceil175(999n)).toBe(1749n); // 1748.25 -> 1749
    expect(ceil175(0n)).toBe(0n);
    expect(ceil175(-5n)).toBe(0n);
    for (let x = 0n; x < 500n; x++) {
      expect(ceil175(x) * 4n >= 7n * x).toBe(true);
      expect((ceil175(x) - 1n) * 4n < 7n * x || x === 0n).toBe(true);
    }
  });

  it("ceil210 is (21x + 9) / 10 for budget sharing, and the week cap is 7x or ceil(8.4x)", () => {
    expect(ceil210(1000n)).toBe(2100n);
    expect(ceil210(1n)).toBe(3n); // 2.1 -> 3
    expect(dayCap(1000n, true)).toBe(2100n);
    expect(dayCap(1000n)).toBe(1750n);
    expect(weekCap(1000n)).toBe(7000n);
    expect(weekCap(1000n, true)).toBe(8400n);
    expect(weekCap(1n, true)).toBe(9n); // 8.4 -> 9
  });

  it("maxDailyBudgetWithin is the largest budget whose worst case fits, and round-trips the old cap meaning (4.8)", () => {
    for (const c of [1n, 571n, 1000n, 1142n, 10n ** 9n]) expect(maxDailyBudgetWithin(ceil175(c))).toBe(c);
    for (let limit = 0n; limit < 400n; limit++) {
      const c = maxDailyBudgetWithin(limit);
      expect(ceil175(c) <= limit).toBe(true);
      expect(ceil175(c + 1n) > limit).toBe(true);
    }
    // The new-workspace note: ₹2,000 a day of worst case allows ₹1,142 a day of budgets.
    expect(formatMinor(maxDailyBudgetWithin(200_000n), "INR")).toBe("₹1,142.85");
  });
});

describe("the October 2026 table (4.5; 1 Oct is a Thursday; ₹1,000 a day; nothing spent)", () => {
  it("all of October: 3 x ₹1,750 then four full weeks at ₹7,000 = ₹33,250", () => {
    const v = remainingMonth(daily(RS_1000), at("2026-10-01", IST), IST, NO_SPEND);
    expect(v).toBe(3_325_000n);
    expect(formatMinor(v, "INR")).toBe("₹33,250");
  });

  it("ends 14 Oct: ₹5,250 + ₹7,000 + min(4 x ₹1,750, ₹7,000) = ₹19,250", () => {
    const endsAt = at("2026-10-14", IST, 20);
    const v = remainingMonth(daily(RS_1000, { endsAt }), at("2026-10-01", IST), IST, NO_SPEND);
    expect(formatMinor(v, "INR")).toBe("₹19,250");
  });

  it("launched Wed 28 Oct, runs to month end: min(4 x ₹1,750, ₹7,000) = ₹7,000", () => {
    const v = remainingMonth(daily(RS_1000), at("2026-10-28", IST, 9), IST, NO_SPEND);
    expect(formatMinor(v, "INR")).toBe("₹7,000");
  });

  it("an end date in the next month still stops the walk at this month's end (the next month reserves at rollover)", () => {
    const endsAt = at("2026-11-20", IST);
    expect(remainingMonth(daily(RS_1000, { endsAt }), at("2026-10-28", IST), IST, NO_SPEND)).toBe(700_000n);
  });

  it("a campaign whose end has passed adds nothing", () => {
    const c = daily(RS_1000, { endsAt: at("2026-10-10", IST, 12) });
    const now = at("2026-10-11", IST, 2);
    expect(hasEnded(c, now)).toBe(true);
    expect(commitmentWorstCase(c, now, IST)).toEqual({ dayRisk: 0n, remainingMonth: 0n });
  });
});

describe("mid-day budget changes", () => {
  it("a mid-day raise uses the day's peak for today and the new budget for later days", () => {
    const before = daily(RS_1000);
    const raised = withBudgetChange(before, 150_000n);
    expect(raised).toMatchObject({ dailyBudgetMinor: 150_000n, peakToday: 150_000n, weekPeak: 150_000n });
    const now = at("2026-10-28", IST, 13);
    const s = spend({ today: 60_000n });
    expect(dayRisk(raised, s, now)).toBe(ceil175(150_000n) - 60_000n);
    // 28-31 Oct, week room 7 x 1,500 = 10,500: today 2,625 - 600, then 3 x 2,625; all inside the room.
    expect(remainingMonth(raised, now, IST, s)).toBe(ceil175(150_000n) - 60_000n + 3n * ceil175(150_000n));
  });

  it("a mid-day cut does not lower today's worst case (Meta's 175% rule uses the day's highest budget)", () => {
    const cut = withBudgetChange(daily(RS_1000), 50_000n);
    expect(cut).toMatchObject({ dailyBudgetMinor: 50_000n, peakToday: RS_1000, weekPeak: RS_1000 });
    const now = at("2026-10-28", IST, 15);
    const s = spend({ today: 40_000n });
    expect(dayRisk(cut, s, now)).toBe(175_000n - 40_000n);
    expect(dayRisk(cut, s, now)).toBe(dayRisk(daily(RS_1000), s, now));
    // Later days use the new ₹500: today 1,750 - 400 = 1,350, then 3 x 875 = 2,625; week room 7 x 1,000 - 400 is not binding.
    expect(remainingMonth(cut, now, IST, s)).toBe(135_000n + 3n * 87_500n);
  });
});

describe("caps, floors and edges", () => {
  it("a lifetime budget caps the month (Meta never spends past it)", () => {
    const c = daily(RS_1000, { lifetimeBudgetMinor: 2_000_000n });
    expect(remainingMonth(c, at("2026-10-01", IST), IST, spend({ lifetime: 500_000n }))).toBe(1_500_000n);
    expect(remainingMonth(c, at("2026-10-01", IST), IST, spend({ lifetime: 2_500_000n }))).toBe(0n);
  });

  it("(critic) a lifetime-only commitment's dayRisk and remainingMonth are both its remaining lifetime budget", () => {
    const c: CommitmentMath = { dailyBudgetMinor: null, lifetimeBudgetMinor: 5_000_000n, peakToday: 0n, weekPeak: 0n, endsAt: at("2026-12-31", IST) };
    const s = spend({ lifetime: 2_000_000n, today: 100_000n });
    const now = at("2026-10-20", IST);
    expect(dayRisk(c, s, now)).toBe(3_000_000n);
    expect(remainingMonth(c, now, IST, s)).toBe(3_000_000n);
    expect(dayRisk({ ...c, endsAt: at("2026-10-01", IST) }, s, now)).toBe(0n);
  });

  it("(critic) budget sharing uses 2.1x a day and 8.4x a week", () => {
    const c = daily(1000n, { sharing: true });
    // 1-3 Oct: 3 x 2,100 = 6,300 (room 8,400); then four full weeks at 8,400.
    expect(remainingMonth(c, at("2026-10-01", IST), IST, NO_SPEND)).toBe(6300n + 4n * 8400n);
    expect(dayRisk(c, spend({ today: 100n }), at("2026-10-01", IST))).toBe(2000n);
  });

  it("a week straddling the month boundary counts the previous month's spend in that week", () => {
    const byDay = new Map<string, bigint>([
      ["2026-09-27", 175_000n],
      ["2026-09-28", 175_000n],
      ["2026-09-29", 175_000n],
      ["2026-09-30", 175_000n],
    ]);
    // The week of Sun 27 Sep already spent 7 x ₹1,000, so 1-3 Oct add nothing; then four full weeks.
    expect(remainingMonth(daily(RS_1000), at("2026-10-01", IST), IST, spend({ byDay }))).toBe(4n * 700_000n);
    const partial = new Map<string, bigint>([["2026-09-28", 100_000n], ["2026-09-29", 100_000n], ["2026-09-30", 100_000n]]);
    // Room 7,000 - 3,000 = 4,000 for 1-3 Oct (which could otherwise take 5,250).
    expect(remainingMonth(daily(RS_1000), at("2026-10-01", IST), IST, spend({ byDay: partial }))).toBe(400_000n + 4n * 700_000n);
    // Spend before the week started (26 Sep is a Saturday of the week before) does not count.
    const older = new Map<string, bigint>([["2026-09-26", 9_999_999n]]);
    expect(remainingMonth(daily(RS_1000), at("2026-10-01", IST), IST, spend({ byDay: older }))).toBe(3_325_000n);
    // The last day of the month: only 31 Oct, and November's week (Sun 1 Nov) is not this month's.
    expect(weekStartOfDay("2026-11-01")).toBe("2026-11-01");
    expect(remainingMonth(daily(RS_1000), at("2026-10-31", IST), IST, NO_SPEND)).toBe(175_000n);
  });

  it("spend above 1.75x today gives 0, never a negative number", () => {
    const now = at("2026-10-28", IST, 22);
    const s = spend({ today: 200_000n });
    expect(dayRisk(daily(RS_1000), s, now)).toBe(0n);
    // Today adds 0; the week room is 7,000 - 2,000 = 5,000 for 29-31 Oct (3 x 1,750 = 5,250 would not fit).
    expect(remainingMonth(daily(RS_1000), now, IST, s)).toBe(500_000n);
    const huge = spend({ today: 10n ** 12n, byDay: new Map([["2026-10-26", 10n ** 12n]]) });
    expect(remainingMonth(daily(RS_1000), now, IST, huge)).toBe(0n);
  });

  it("unknown spend today (stale data) counts the whole day", () => {
    const now = at("2026-10-28", IST, 18);
    expect(dayRisk(daily(RS_1000), spend({ today: null }), now)).toBe(175_000n);
  });

  it("America/New_York across the DST change (1 Nov 2026) keeps calendar days in the account's zone", () => {
    // 31 Oct 23:30 EDT is 1 Nov 03:30Z: still October in New York, already November in Kolkata.
    const lateOct = new Date("2026-11-01T03:30:00Z");
    expect(remainingMonth(daily(RS_1000), lateOct, NY, NO_SPEND)).toBe(175_000n);
    expect(remainingMonth(daily(RS_1000), lateOct, IST, NO_SPEND)).toBe(4n * 700_000n + 2n * 175_000n);
    // Before (01:59 EDT) and after (01:30 EST) the clocks go back: the same 25-hour day 1 Nov, the whole of November.
    const before = new Date("2026-11-01T05:59:00Z");
    const after = new Date("2026-11-01T06:30:00Z");
    const november = 4n * 700_000n + 2n * 175_000n; // four full weeks from Sun 1 Nov, then 29-30 Nov
    expect(remainingMonth(daily(RS_1000), before, NY, NO_SPEND)).toBe(november);
    expect(remainingMonth(daily(RS_1000), after, NY, NO_SPEND)).toBe(november);
    // The 23-hour spring-forward day (8 Mar 2026) is still one day.
    const march = remainingMonth(daily(RS_1000), new Date("2026-03-08T12:00:00Z"), NY, NO_SPEND);
    expect(march).toBe(3n * 700_000n + 3n * 175_000n); // 8-14, 15-21, 22-28, then 29-31 Mar
  });

  it("JPY (0 decimals) and KWD (3 decimals) work in their own minor units", () => {
    const jpy = remainingMonth(daily(10_000n), at("2026-10-01", "Asia/Tokyo"), "Asia/Tokyo", NO_SPEND);
    expect(jpy).toBe(332_500n);
    expect(formatMinor(jpy, "JPY")).toBe("¥3,32,500");
    const kwd = remainingMonth(daily(10_500n), at("2026-10-01", "Asia/Kuwait"), "Asia/Kuwait", NO_SPEND);
    expect(kwd).toBe(3n * 18_375n + 4n * 73_500n);
    expect(formatMinor(kwd, "KWD")).toContain("349.125");
    expect(dayRisk(daily(999n), NO_SPEND, at("2026-10-01", "Asia/Tokyo"))).toBe(1749n);
  });

  it("10^15 minor units do not overflow", () => {
    const big = 10n ** 15n;
    const v = remainingMonth(daily(big), at("2026-10-01", IST), IST, NO_SPEND);
    expect(v).toBe(33_250_000_000_000_000n);
    expect(v > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(dayRisk(daily(big), NO_SPEND, at("2026-10-01", IST))).toBe(1_750_000_000_000_000n);
  });

  it("external risk: E is the highest outside day of the last 7, the day risk E - today, the month walk with D = E", () => {
    const byDay = new Map<string, bigint>([
      ["2026-10-21", 300_000n],
      ["2026-10-24", 100_000n],
      ["2026-10-28", 100_000n],
      ["2026-10-10", 9_000_000n], // older than 7 days: ignored
    ]);
    const now = at("2026-10-28", IST, 12);
    const r = externalRisk(byDay, now, IST);
    expect(r).toMatchObject({ e: 300_000n, day: 200_000n, spentToday: 100_000n, estimated: true });
    // Week of Sun 25 Oct: room 7 x 3,000 - (spent 25-27 = 0, today 1,000) = 20,000; today 5,250 - 1,000, then 3 x 5,250.
    expect(r.month).toBe(ceil175(300_000n) - 100_000n + 3n * ceil175(300_000n));
    expect(externalRisk(new Map(), now, IST)).toMatchObject({ e: 0n, day: 0n, month: 0n });
  });
});

// =====================================================================================================================
// Property test (10.1): a Meta adversary spends the maximum the rules allow (<= 1.75 x the day's peak, <= 7 x the week's peak,
// Sunday to Saturday in the account zone) over random budget schedules with mid-day changes. At every earlier point, what the
// book would have counted (spent this month + remainingMonth) is never below what is actually spent this month, and today's
// spend never exceeds spent today + dayRisk. A raise after the checkpoint is a new reservation, so from each checkpoint on the
// schedule may only cut (later raises are clamped to the budget at the checkpoint).
// =====================================================================================================================

type DayPlan = { start: bigint; mid: bigint | null; f: number; g: number };

const floor175 = (x: bigint) => (7n * x) / 4n;
const pct = (x: bigint, p: number) => (x * BigInt(p)) / 100n;
const maxOf = (a: bigint, b: bigint) => (a > b ? a : b);
const minOf = (a: bigint, b: bigint) => (a < b ? a : b);

describe("fast-check adversary (1.75x a day, 7x a week)", () => {
  const dayArb = fc.record({
    start: fc.integer({ min: 1, max: 2_000_000 }).map(BigInt),
    mid: fc.option(fc.integer({ min: 1, max: 2_000_000 }).map(BigInt), { nil: null }),
    f: fc.oneof(fc.constant(100), fc.integer({ min: 0, max: 100 })),
    g: fc.integer({ min: 0, max: 100 }),
  });
  const runArb = fc.record({
    tz: fc.constantFrom(IST, NY, "UTC", "Asia/Tokyo", "Australia/Sydney"),
    month: fc.constantFrom("2026-10", "2026-11", "2026-03", "2027-02"),
    lead: fc.integer({ min: 0, max: 6 }),
    extra: fc.integer({ min: 0, max: 40 }),
    hasEnd: fc.boolean(),
    days: fc.array(dayArb, { minLength: 48, maxLength: 48 }),
  });

  it("never lets actual month spend exceed spent + committed computed at any earlier point", () => {
    fc.assert(
      fc.property(runArb, ({ tz, month, lead, extra, hasEnd, days }) => {
        const monthStart = `${month}-01`;
        const monthEnd = monthEndDay(month);
        const first = addDays(monthStart, -lead);
        const endDay = hasEnd ? addDays(first, lead + extra) : null;
        const lastDay = endDay && compareDays(endDay, monthEnd) < 0 ? endDay : monthEnd;
        const endsAt = endDay ? new Date(startOfLocalDay(addDays(endDay, 1), tz).getTime() - 60_000) : null;
        const keys: string[] = [];
        for (let d = first; compareDays(d, lastDay) <= 0; d = addDays(d, 1)) keys.push(d);
        const weekOf = keys.map((k) => weekStartOfDay(k));
        const weekFirst = keys.map((_, i) => weekOf.indexOf(weekOf[i]));
        const plan = (i: number): DayPlan => days[i % days.length];
        const inMonth = (k: string) => k.startsWith(month);

        /** Runs Meta's adversary over days[from..] with the budgets given, continuing a week already spent in. */
        const adversary = (budgetOf: (i: number) => { start: bigint; mid: bigint | null }, history: Map<string, bigint>, from: number, todayAlready: bigint | null) => {
          const spent = new Map(history);
          for (let i = from; i < keys.length; i++) {
            const k = keys[i];
            const b = budgetOf(i);
            const peak = maxOf(b.start, b.mid ?? b.start);
            let weekMax = 0n;
            let weekSpent = 0n;
            for (let j = weekFirst[i]; j <= i; j++) {
              const bj = j === i ? b : budgetOf(j);
              weekMax = maxOf(weekMax, maxOf(bj.start, bj.mid ?? bj.start));
              if (j < i) weekSpent += spent.get(keys[j]) ?? 0n;
            }
            const already = i === from && todayAlready !== null ? todayAlready : 0n;
            const allowed = minOf(floor175(peak), 7n * weekMax - weekSpent);
            const more = allowed - already > 0n ? pct(allowed - already, plan(i).f) : 0n;
            spent.set(k, already + more);
          }
          return spent;
        };

        // The real history (no clamping): budgets as planned.
        const real = (i: number) => ({ start: plan(i).start, mid: plan(i).mid });
        const history = adversary(real, new Map(), 0, null);

        for (let t = 0; t < keys.length; t++) {
          const day = keys[t];
          if (!inMonth(day)) continue;
          for (const phase of ["start", "mid"] as const) {
            const p = plan(t);
            if (phase === "mid" && p.mid === null) continue;
            const before = new Map<string, bigint>();
            for (let j = 0; j < t; j++) before.set(keys[j], history.get(keys[j]) ?? 0n);
            const spentToday = phase === "mid" ? pct(history.get(day) ?? 0n, p.g) : 0n;
            const dNow = phase === "mid" ? (p.mid as bigint) : p.start;
            const peakToday = phase === "mid" ? maxOf(p.start, p.mid as bigint) : p.start;
            let weekPeak = peakToday;
            for (let j = weekFirst[t]; j < t; j++) weekPeak = maxOf(weekPeak, maxOf(plan(j).start, plan(j).mid ?? plan(j).start));
            let lifetime = spentToday;
            for (const v of before.values()) lifetime += v;
            const c: CommitmentMath = { dailyBudgetMinor: dNow, lifetimeBudgetMinor: null, peakToday, weekPeak, endsAt };
            const s: CommitmentSpend = { byDay: before, lifetime, today: spentToday };
            const now = new Date(startOfLocalDay(day, tz).getTime() + (phase === "mid" ? 12 * HOUR : 60_000));
            let spentMonthSoFar = spentToday;
            for (const [k, v] of before) if (inMonth(k)) spentMonthSoFar += v;
            const estimateMonth = spentMonthSoFar + remainingMonth(c, now, tz, s);
            const estimateToday = spentToday + dayRisk(c, s, now);

            // From here on: cuts only. Today keeps its peak; a later raise is clamped to the budget at this checkpoint.
            const frozen = (i: number) => {
              if (i < t) return real(i);
              if (i === t) return phase === "mid" ? { start: p.start, mid: p.mid } : { start: p.start, mid: p.mid === null ? null : minOf(p.mid, dNow) };
              return { start: minOf(plan(i).start, dNow), mid: plan(i).mid === null ? null : minOf(plan(i).mid as bigint, dNow) };
            };
            const actual = adversary(frozen, before, t, phase === "mid" ? spentToday : null);
            let actualMonth = 0n;
            for (const [k, v] of actual) if (inMonth(k)) actualMonth += v;
            if (actualMonth > estimateMonth) return false;
            if ((actual.get(day) ?? 0n) > estimateToday) return false;
          }
        }
        return true;
      }),
      { numRuns: 80 },
    );
  }, 120_000);
});

// =====================================================================================================================
// runWorstCase: the cost card's run (docs/IG-PAGE-ADS-SPEC.md 6.2, request P0-5, PRM-01 acceptance 6)
// =====================================================================================================================

/** A wall-clock time in Asia/Kolkata ("2026-10-28T10:05"). */
const ist = (local: string) => new Date(`${local}:00+05:30`);
const RS = (rupees: number) => BigInt(rupees) * 100n;
const months = (r: { byMonth: { month: string; minor: bigint }[] }) => Object.fromEntries(r.byMonth.map((m) => [m.month, formatMinor(m.minor, "INR")]));
/** Started now: Wednesday 28 Oct 2026 at 10:05 in Kolkata. */
const NOW_28_OCT = ist("2026-10-28T10:05");
const run = (dailyRupees: number, endsLocal: string, over: Partial<RunWorstCaseInput> = {}) =>
  runWorstCase({ dailyMinor: RS(dailyRupees), startsAt: NOW_28_OCT, endsAt: ist(endsLocal), tz: IST, now: NOW_28_OCT, ...over });
const addRuns = (rs: ReturnType<typeof runWorstCase>[]) => ({
  aboutMinor: rs.reduce((s, r) => s + r.aboutMinor, 0n),
  totalMinor: rs.reduce((s, r) => s + r.totalMinor, 0n),
  todayMinor: rs.reduce((s, r) => s + r.todayMinor, 0n),
  byMonth: rs[0].byMonth.map((m, i) => ({ month: m.month, minor: rs.reduce((s, r) => s + r.byMonth[i].minor, 0n) })),
});

describe("runWorstCase: the pinned examples of 6.2", () => {
  it("₹300 x 5 days: about ₹1,500; at most ₹2,625 (Oct ₹2,100, Nov ₹525); today ₹525", () => {
    const r = run(300, "2026-11-01T23:59");
    expect(formatMinor(r.aboutMinor, "INR")).toBe("₹1,500");
    expect(formatMinor(r.totalMinor, "INR")).toBe("₹2,625");
    expect(months(r)).toEqual({ "2026-10": "₹2,100", "2026-11": "₹525" });
    expect(formatMinor(r.todayMinor, "INR")).toBe("₹525");
    expect(r.byMonth.map((m) => m.month)).toEqual(["2026-10", "2026-11"]);
  });

  it("₹300 x 7 days: about ₹2,100; at most ₹3,675 (Oct ₹2,100, Nov ₹1,575); today ₹525", () => {
    const r = run(300, "2026-11-03T23:59");
    expect(r).toMatchObject({ aboutMinor: RS(2_100), totalMinor: RS(3_675), todayMinor: RS(525) });
    expect(months(r)).toEqual({ "2026-10": "₹2,100", "2026-11": "₹1,575" });
  });

  it("₹1,000 a day, 1 to 31 Oct (from 1 Oct): about ₹31,000; at most ₹33,250 (all in Oct); today ₹1,750", () => {
    const start = ist("2026-10-01T10:05");
    const r = runWorstCase({ dailyMinor: RS(1_000), startsAt: start, endsAt: ist("2026-10-31T23:59"), tz: IST, now: start });
    expect(r).toEqual({ aboutMinor: RS(31_000), totalMinor: RS(33_250), byMonth: [{ month: "2026-10", minor: RS(33_250) }], todayMinor: RS(1_750) });
    // The third row is Phase 0's 4.5 table.
    expect(r.byMonth[0].minor).toBe(remainingMonth(daily(RS(1_000), { endsAt: ist("2026-10-31T23:59") }), start, IST, NO_SPEND));
  });

  it("3 versions x ₹100 (₹300 in total) x 7 days: at most ₹3,675, the same as one ₹300 ad set (3.8)", () => {
    const versions = [run(100, "2026-11-03T23:59"), run(100, "2026-11-03T23:59"), run(100, "2026-11-03T23:59")];
    const sum = addRuns(versions);
    expect(sum).toEqual({ aboutMinor: RS(2_100), totalMinor: RS(3_675), todayMinor: RS(525), byMonth: [{ month: "2026-10", minor: RS(2_100) }, { month: "2026-11", minor: RS(1_575) }] });
    const single = run(300, "2026-11-03T23:59");
    expect(sum.totalMinor).toBe(single.totalMinor);
    expect(sum.byMonth).toEqual(single.byMonth);
  });
});

describe("runWorstCase: Phase 0 parity and edges", () => {
  it("a later start is counted from today until P0-10 (D32): only 'about' uses the start date", () => {
    const fromToday = run(300, "2026-11-09T23:59");
    const from5Nov = run(300, "2026-11-09T23:59", { startsAt: ist("2026-11-05T10:00") });
    // 28-31 Oct ₹2,100; week of Sun 1 Nov: 7 x ₹525 capped at 7 x ₹300 = ₹2,100; 8-9 Nov ₹1,050.
    expect(from5Nov.totalMinor).toBe(RS(5_250));
    expect(from5Nov).toEqual({ ...fromToday, aboutMinor: RS(1_500) });
    expect(fromToday.aboutMinor).toBe(RS(300 * 13));
    expect(months(from5Nov)).toEqual({ "2026-10": "₹2,100", "2026-11": "₹3,150" });
  });

  it("this month's part is remainingMonth and today's is dayRisk, with peaks and spend already made", () => {
    const now = ist("2026-10-28T15:00");
    const endsAt = ist("2026-11-12T23:59");
    const byDay = new Map<string, bigint>([["2026-10-25", RS(1_500)], ["2026-10-27", RS(2_000)], ["2026-10-28", RS(600)]]);
    const r = runWorstCase({ dailyMinor: RS(1_000), startsAt: now, endsAt, tz: IST, now, peakTodayMinor: RS(1_500), weekPeakMinor: RS(2_000), spentByDay: byDay });
    const c: CommitmentMath = { dailyBudgetMinor: RS(1_000), lifetimeBudgetMinor: null, peakToday: RS(1_500), weekPeak: RS(2_000), endsAt };
    const s: CommitmentSpend = { byDay, lifetime: 0n, today: RS(600) };
    expect(r.byMonth[0]).toEqual({ month: "2026-10", minor: remainingMonth(c, now, IST, s) });
    expect(r.todayMinor).toBe(dayRisk(c, s, now));
    expect(r.todayMinor).toBe(ceil175(RS(1_500)) - RS(600));
  });

  it("a week across a month boundary: each month shows its own maximum, and the total is one walk", () => {
    // Sun 29 Nov to Sat 5 Dec 2026 at ₹1,000: one Sunday week, so Meta can spend at most 7 x ₹1,000 in all.
    const now = ist("2026-11-29T09:00");
    const r = runWorstCase({ dailyMinor: RS(1_000), startsAt: now, endsAt: ist("2026-12-05T23:59"), tz: IST, now });
    expect(r.totalMinor).toBe(RS(7_000));
    // November can take 2 x ₹1,750; if November spends nothing, December's rollover can set aside the whole week's ₹7,000.
    expect(months(r)).toEqual({ "2026-11": "₹3,500", "2026-12": "₹7,000" });
    // Spend already made this week lowers the December rollover too.
    const mon = ist("2026-11-30T12:00");
    const spent = new Map<string, bigint>([["2026-11-29", RS(1_750)], ["2026-11-30", RS(1_000)]]);
    const r2 = runWorstCase({ dailyMinor: RS(1_000), startsAt: mon, endsAt: ist("2026-12-05T23:59"), tz: IST, now: mon, spentByDay: spent });
    expect(r2.byMonth).toEqual([
      { month: "2026-11", minor: RS(750) },
      { month: "2026-12", minor: RS(4_250) },
    ]);
    expect(r2.totalMinor).toBe(RS(4_250));
    expect(r2.todayMinor).toBe(RS(750));
  });

  it("an ended run adds nothing; a bad end date or a run past RUN_MAX_DAYS is refused", () => {
    const now = ist("2026-10-28T10:05");
    expect(runWorstCase({ dailyMinor: RS(300), startsAt: ist("2026-10-20T10:00"), endsAt: ist("2026-10-27T23:59"), tz: IST, now })).toEqual({ totalMinor: 0n, byMonth: [], todayMinor: 0n, aboutMinor: 0n });
    expect(() => runWorstCase({ dailyMinor: RS(300), startsAt: now, endsAt: new Date(Number.NaN), tz: IST, now })).toThrow(RangeError);
    expect(() => runWorstCase({ dailyMinor: RS(300), startsAt: now, endsAt: new Date(now.getTime() + (RUN_MAX_DAYS + 2) * 24 * HOUR), tz: IST, now })).toThrow(/at most/);
    // 90 days, the longest promotion (to Tue 26 Jan 2027): four months of figures. 1 Dec and 1 Jan fall mid-week, so each of
    // those months may take the whole of its first week's ₹2,100 if the month before spent nothing in that week.
    const long = runWorstCase({ dailyMinor: RS(300), startsAt: now, endsAt: new Date(now.getTime() + 90 * 24 * HOUR), tz: IST, now });
    expect(months(long)).toEqual({ "2026-10": "₹2,100", "2026-11": "₹9,450", "2026-12": "₹10,500", "2027-01": "₹8,925" });
    // One walk: 28-31 Oct, 12 full weeks and Sun 24 to Tue 26 Jan.
    expect(long.totalMinor).toBe(RS(2_100 + 12 * 2_100 + 3 * 525));
    expect(long.aboutMinor).toBe(RS(300 * 91));
  });

  it("an unknown zone falls back to Asia/Kolkata, like remainingMonth", () => {
    expect(run(300, "2026-11-01T23:59", { tz: "Mars/Olympus" })).toEqual(run(300, "2026-11-01T23:59"));
  });
});

describe("runWorstCase: fast-check parity with remainingMonth and dayRisk (6.1 rule 16)", () => {
  const caseArb = fc.record({
    tz: fc.constantFrom(IST, NY, "UTC", "Asia/Tokyo", "Australia/Sydney"),
    month: fc.constantFrom("2026-10", "2026-11", "2026-12", "2026-03", "2027-02"),
    dayOfMonth: fc.integer({ min: 1, max: 28 }),
    minuteOfDay: fc.integer({ min: 0, max: 24 * 60 - 1 }),
    daily: fc.integer({ min: 1, max: 5_000_000 }).map(BigInt),
    peakExtra: fc.option(fc.integer({ min: 0, max: 5_000_000 }).map(BigInt), { nil: undefined }),
    weekExtra: fc.option(fc.integer({ min: 0, max: 5_000_000 }).map(BigInt), { nil: undefined }),
    runMinutes: fc.integer({ min: -60, max: 100 * 24 * 60 }),
    spent: fc.array(fc.integer({ min: 0, max: 9_000_000 }).map(BigInt), { minLength: 8, maxLength: 8 }),
    startShiftMinutes: fc.integer({ min: 0, max: 30 * 24 * 60 }),
  });

  it("this month's part equals remainingMonth, today equals dayRisk, and a later startsAt never changes the walk", () => {
    fc.assert(
      fc.property(caseArb, (k) => {
        const day = `${k.month}-${String(k.dayOfMonth).padStart(2, "0")}`;
        const now = new Date(startOfLocalDay(day, k.tz).getTime() + k.minuteOfDay * 60_000);
        const today = dayKey(now, k.tz);
        const endsAt = new Date(now.getTime() + k.runMinutes * 60_000);
        const peakTodayMinor = k.peakExtra === undefined ? undefined : k.daily + k.peakExtra;
        const weekPeakMinor = k.weekExtra === undefined ? undefined : (peakTodayMinor ?? k.daily) + k.weekExtra;
        // Spend on today and the 7 days before it (the current week, and days before it that must not count).
        const spentByDay = new Map<string, bigint>(k.spent.map((v, i) => [addDays(today, -i), v]));
        const input: RunWorstCaseInput = { dailyMinor: k.daily, startsAt: now, endsAt, tz: k.tz, now, peakTodayMinor, weekPeakMinor, spentByDay };
        const r = runWorstCase(input);

        const peakToday = peakTodayMinor ?? k.daily;
        const c: CommitmentMath = { dailyBudgetMinor: k.daily, lifetimeBudgetMinor: null, peakToday, weekPeak: weekPeakMinor ?? peakToday, endsAt };
        const s: CommitmentSpend = { byDay: spentByDay, lifetime: 0n, today: spentByDay.get(today) ?? 0n };
        if (hasEnded(c, now)) return r.byMonth.length === 0 && r.totalMinor === 0n && r.todayMinor === 0n;
        if (r.byMonth[0].month !== today.slice(0, 7)) return false;
        if (r.byMonth[0].minor !== remainingMonth(c, now, k.tz, s)) return false;
        if (r.todayMinor !== dayRisk(c, s, now)) return false;
        // The walk covers this month's part, and no month's figure is more than the whole run can spend.
        if (r.totalMinor < r.byMonth[0].minor) return false;
        if (r.byMonth.some((m) => m.minor > r.totalMinor || m.minor < 0n)) return false;
        if (r.byMonth.reduce((sum, m) => sum + m.minor, 0n) < r.totalMinor) return false;

        const later = runWorstCase({ ...input, startsAt: new Date(now.getTime() + k.startShiftMinutes * 60_000) });
        return later.totalMinor === r.totalMinor && later.todayMinor === r.todayMinor && JSON.stringify(later.byMonth, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) === JSON.stringify(r.byMonth, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
      }),
      { numRuns: 300 },
    );
  }, 120_000);
});

describe("purity (WP-01 acceptance 1)", () => {
  it("worstcase.ts imports neither prisma nor fetch, directly or through its imports", () => {
    const seen = new Set<string>();
    const visit = (rel: string) => {
      if (seen.has(rel)) return;
      seen.add(rel);
      const text = readFileSync(path.join(process.cwd(), "src", rel), "utf8");
      for (const m of text.matchAll(/^import\s[^;]*?from\s+["']([^"']+)["']/gm)) expect(m[1], rel).not.toMatch(/^@\/lib\/db$|^@prisma\/|generated\/prisma|^node:(http|https|net)$/);
      expect(text, rel).not.toMatch(/(?<![\w.])fetch\s*\(/);
      for (const m of text.matchAll(/^import\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/gm)) {
        const spec = m[1];
        if (spec.startsWith("./")) visit(path.posix.join(path.posix.dirname(rel), spec.slice(2)) + ".ts");
        else if (spec.startsWith("@/")) visit(spec.slice(2) + ".ts");
      }
    };
    visit("lib/spend/worstcase.ts");
    expect([...seen]).toContain("lib/spend/periods.ts");
  });
});
