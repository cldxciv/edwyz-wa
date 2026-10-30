import { readFileSync } from "node:fs";
import path from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { formatMinor } from "@/lib/spend/money";
import { addDays, compareDays, monthEndDay, startOfLocalDay, weekStartOfDay } from "@/lib/spend/periods";
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
  weekCap,
  withBudgetChange,
  type CommitmentMath,
  type CommitmentSpend,
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
