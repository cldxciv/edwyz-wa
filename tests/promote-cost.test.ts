import fc from "fast-check";
import { describe, expect, it } from "vitest";

/**
 * The cost presenter (docs/IG-PAGE-ADS-SPEC.md 6.2, 3.1, 3.3, 3.8, D5, D32; PRM-02 acceptance 4 and 6): the pinned rows of
 * 6.2, maxFittingDaily's exactness (fast-check), the refusal example, only fixes that fit, and the version split.
 */
import { formatMinor } from "@/lib/spend/money";
import {
  dailyFits,
  type FitInput,
  fixesFor,
  fixLabel,
  INR_STEP_MINOR,
  maxFittingDaily,
  maxFittingDays,
  presentCost,
  splitDaily,
} from "@/lib/promote/cost";
import { runDates } from "@/lib/promote/dates";

const IST = "Asia/Kolkata";
const NY = "America/New_York";
/** A wall-clock time in Asia/Kolkata ("2026-10-28T10:05"). */
const ist = (local: string) => new Date(`${local}:00+05:30`);
const RS = (rupees: number) => BigInt(rupees) * 100n;
/** Started now: Wednesday 28 Oct 2026 at 10:05 in Kolkata. */
const NOW = ist("2026-10-28T10:05");
/** New-workspace limits with nothing else running: ₹2,000 a day, ₹20,000 a month. */
const FRESH = { currency: "INR", today: { left: RS(2_000) }, month: { left: RS(20_000) } };
const inr = (minor: bigint) => formatMinor(minor, "INR");

const cost = (dailyRupees: number[], endsLocal: string, over: Partial<Parameters<typeof presentCost>[0]> = {}) =>
  presentCost({ sets: dailyRupees.map((d) => ({ dailyMinor: RS(d) })), startsAt: NOW, endsAt: ist(endsLocal), tz: IST, headroom: FRESH, now: NOW, kind: "boost", ...over });

describe("the pinned rows of 6.2", () => {
  it("₹300 x 5 days: about ₹1,500, at most ₹2,625 (Oct ₹2,100, Nov ₹525), today ₹525", () => {
    const c = cost([300], "2026-11-01T23:59");
    expect(inr(c.aboutTotalMinor)).toBe("₹1,500");
    expect(inr(c.atMostMinor)).toBe("₹2,625");
    expect(c.byMonth.map((m) => [m.month, inr(m.minor)])).toEqual([
      ["2026-10", "₹2,100"],
      ["2026-11", "₹525"],
    ]);
    expect(inr(c.todayMinor)).toBe("₹525");
    expect(c.lines).toEqual({
      about: "About ₹1,500 in total.",
      atMost: "At most ₹2,625, because Meta can spend up to 75% more on a busy day.",
      byMonth: "Up to ₹2,100 in October and ₹525 in November.",
      left: "₹1,475 left today · ₹17,900 left this month",
      monthCross: "November's part is set aside on 1 Nov. If November's limit is lower, the boost may pause then.",
      setAside: null,
    });
    expect(c).toMatchObject({ crossesMonth: true, fits: true, typedConfirmRequired: false, setAsideFromToday: false, leftTodayMinor: RS(1_475), leftMonthMinor: RS(17_900), worstMonthMinor: RS(2_100) });
  });

  it("₹300 x 7 days: about ₹2,100, at most ₹3,675 (Oct ₹2,100, Nov ₹1,575), today ₹525", () => {
    const c = cost([300], "2026-11-03T23:59", { kind: "ads" });
    expect([c.aboutTotalMinor, c.atMostMinor, c.todayMinor]).toEqual([RS(2_100), RS(3_675), RS(525)]);
    expect(c.byMonth).toEqual([
      { month: "2026-10", minor: RS(2_100) },
      { month: "2026-11", minor: RS(1_575) },
    ]);
    expect(c.lines.monthCross).toBe("November's part is set aside on 1 Nov. If November's limit is lower, the ads may pause then.");
  });

  it("₹1,000 a day, 1 to 31 Oct (from 1 Oct): about ₹31,000, at most ₹33,250, all in October, today ₹1,750", () => {
    const start = ist("2026-10-01T10:05");
    const c = presentCost({ sets: [{ dailyMinor: RS(1_000) }], startsAt: start, endsAt: ist("2026-10-31T23:59"), tz: IST, headroom: { currency: "INR", today: { left: RS(5_000) }, month: { left: RS(50_000) } }, now: start });
    expect([c.aboutTotalMinor, c.atMostMinor, c.todayMinor]).toEqual([RS(31_000), RS(33_250), RS(1_750)]);
    expect(c.byMonth).toEqual([{ month: "2026-10", minor: RS(33_250) }]);
    expect(c.crossesMonth).toBe(false);
    expect(c.lines.byMonth).toBe("Up to ₹33,250 in October.");
    expect(c.lines.monthCross).toBeNull();
    // 33,250 is at least half of 50,000: typing the figure is required (D5).
    expect(c.typedConfirmRequired).toBe(true);
  });

  it("3 versions x ₹100 (₹300 in total) x 7 days: at most ₹3,675, the same as one ₹300 ad set", () => {
    const three = cost([100, 100, 100], "2026-11-03T23:59");
    const one = cost([300], "2026-11-03T23:59");
    expect([three.aboutTotalMinor, three.atMostMinor, three.todayMinor]).toEqual([RS(2_100), RS(3_675), RS(525)]);
    expect(three.byMonth).toEqual(one.byMonth);
  });

  it("says the 3.13 lines in Hindi and Hinglish", () => {
    const hi = cost([300], "2026-11-01T23:59", { lang: "hi" });
    expect(hi.lines.byMonth).toBe("अक्टूबर में अधिकतम ₹2,100 और नवंबर में ₹525।");
    expect(hi.lines.monthCross).toBe("नवंबर का हिस्सा 1 नवंबर को अलग रखा जाएगा। अगर नवंबर की सीमा कम है, तो बूस्ट तब रुक सकता है।");
    const hinglish = cost([300], "2026-11-01T23:59", { lang: "hinglish" });
    expect(hinglish.lines.byMonth).toBe("October mein zyada se zyada ₹2,100 aur November mein ₹525.");
    expect(hinglish.lines.monthCross).toBe("November ka hissa 1 Nov ko alag rakha jayega. Agar November ki limit kam hai, to boost tab ruk sakta hai.");
  });

  it("names three months in a list, and says a later start is counted from today (D32)", () => {
    const start = ist("2026-11-05T09:00");
    const c = presentCost({ sets: [{ dailyMinor: RS(300) }], startsAt: start, endsAt: ist("2026-12-02T23:59"), tz: IST, headroom: FRESH, now: NOW });
    expect(c.byMonth.map((m) => m.month)).toEqual(["2026-10", "2026-11", "2026-12"]);
    expect(c.lines.byMonth).toMatch(/^Up to ₹[\d,]+ in October, ₹[\d,]+ in November and ₹[\d,]+ in December\.$/);
    expect(c.setAsideFromToday).toBe(true);
    expect(c.lines.setAside).toBe("Money is set aside from today, although the ads start on 5 Nov.");
    // "About" counts from the start day; the worst case walks from today, exactly like Phase 0's remainingMonth.
    expect(c.aboutTotalMinor).toBe(RS(300 * 28));
    expect(c.todayMinor).toBe(RS(525));
  });

  it("requires typing the figure at 50% or more of what is left this month (D5)", () => {
    const at = (leftMonth: number) => cost([300], "2026-11-01T23:59", { headroom: { currency: "INR", today: { left: RS(2_000) }, month: { left: RS(leftMonth) } } });
    expect(at(4_200).typedConfirmRequired).toBe(true);
    expect(at(4_201).typedConfirmRequired).toBe(false);
    expect(cost([300], "2026-11-01T23:59", { headroom: { currency: "INR", today: { left: RS(2_000) }, month: { left: null } } }).typedConfirmRequired).toBe(false);
    expect(cost([300], "2026-11-01T23:59", { headroom: { currency: "INR", today: { left: RS(2_000) }, month: { left: null } } }).lines.left).toBe("₹1,475 left today");
    expect(cost([300], "2026-11-01T23:59", { headroom: { currency: "INR", today: { left: null }, month: { left: null } } })).toMatchObject({ fits: false, lines: { left: null } });
  });
});

describe("the refusal example (6.2)", () => {
  // Daily limit ₹2,000 with ₹1,500 of today already used: ₹500 left.
  const base = { dailyMinor: RS(300), runDays: 5, startMode: "now" as const, tz: IST, now: NOW, leftTodayMinor: RS(500), leftMonthMinor: RS(18_000), currency: "INR", stepMinor: INR_STEP_MINOR };

  it("₹300 a day needs ₹525 today, so it does not fit", () => {
    const d = runDates({ runDays: 5, startMode: "now", tz: IST, now: NOW });
    expect(presentCost({ sets: [{ dailyMinor: RS(300) }], startsAt: d.startsAt, endsAt: d.endsAt, tz: IST, now: NOW, headroom: { currency: "INR", today: { left: RS(500) }, month: { left: RS(18_000) } } }).fits).toBe(false);
  });

  it("offers [Lower to ₹280 a day] and the owner fix, and no fewer days (today doesn't change)", () => {
    const fixes = fixesFor("spend.daily_limit", base);
    expect(fixes).toEqual([{ kind: "lower_daily", toMinor: RS(280) }, { kind: "ask_owner" }]);
    expect(fixLabel(fixes[0], { currency: "INR", tz: IST })).toBe("Lower to ₹280 a day");
    expect(fixLabel(fixes[1], { currency: "INR", tz: IST, owner: "Priya" })).toBe("Ask Priya to raise the limit");
    expect(fixLabel(fixes[1], { currency: "INR", tz: IST, isOwner: true })).toBe("Spending limits");
    expect(maxFittingDays(base)).toBeNull();
  });

  it("offers fewer days when this month's limit is the problem (the longest run that fits)", () => {
    const monthBound = { ...base, runDays: 7, leftTodayMinor: RS(2_000), leftMonthMinor: RS(1_600) };
    expect(maxFittingDays(monthBound)).toBe(3);
    expect(maxFittingDaily({ ...monthBound, ...runDates({ runDays: 7, startMode: "now", tz: IST, now: NOW }) })).toBe(RS(220));
    const fixes = fixesFor("spend.monthly_limit", monthBound);
    expect(fixes).toEqual([{ kind: "lower_daily", toMinor: RS(220) }, { kind: "fewer_days", days: 3 }, { kind: "ask_owner" }]);
    expect(fixLabel(fixes[1], { currency: "INR", tz: IST })).toBe("Run 3 days instead");
  });

  it("never offers fewer than 2 days (D31)", () => {
    // Only 1 day's worth of room is left this month: no 2-day run fits.
    expect(maxFittingDays({ ...base, leftTodayMinor: RS(2_000), leftMonthMinor: RS(600) })).toBeNull();
    expect(fixesFor("spend.monthly_limit", { ...base, leftTodayMinor: RS(2_000), leftMonthMinor: RS(600) }).some((f) => f.kind === "fewer_days")).toBe(false);
  });

  it("gives only [Try again at] for Meta's limit and rate, [Try again] when busy, the owner fix for a missing limit", () => {
    expect(fixesFor("spend.meta_cap_too_low", base)).toEqual([{ kind: "retry_at", at: new Date(NOW.getTime() + 20 * 60_000) }]);
    const at = ist("2026-10-28T11:30");
    expect(fixesFor("spend.meta_rate", { ...base, retryAt: at })).toEqual([{ kind: "retry_at", at }]);
    expect(fixLabel({ kind: "retry_at", at }, { currency: "INR", tz: IST })).toBe("Try again at 11:30 am");
    expect(fixesFor("spend.busy", base)).toEqual([{ kind: "retry" }]);
    expect(fixLabel({ kind: "retry" }, { currency: "INR", tz: IST, lang: "hi" })).toBe("फिर कोशिश करें");
    expect(fixesFor("spend.no_limit", base)).toEqual([{ kind: "ask_owner" }]);
    expect(fixesFor("spend.frozen", base)).toEqual([]);
  });

  it("offers [Raise to] Meta's minimum only when it fits", () => {
    const below = { ...base, dailyMinor: RS(30), versions: 2, leftTodayMinor: RS(2_000), minDailyMinor: RS(40) };
    expect(fixesFor("promote.below_min", below)).toEqual([{ kind: "raise_to_min", toMinor: RS(80) }]);
    expect(fixLabel({ kind: "raise_to_min", toMinor: RS(80) }, { currency: "INR", tz: IST })).toBe("Raise to ₹80");
    expect(fixesFor("promote.below_min", { ...below, leftTodayMinor: RS(100) })).toEqual([{ kind: "ask_owner" }]);
    // A fitting total whose share is below the minimum is not offered as a lower budget.
    expect(maxFittingDaily({ ...base, ...runDates({ runDays: 5, startMode: "now", tz: IST, now: NOW }), leftTodayMinor: RS(100), minDailyMinor: RS(100) })).toBeNull();
  });
});

describe("splitDaily (3.8)", () => {
  it("₹290 split 3 ways is ₹96 each, with a confirmed total of ₹288", () => {
    expect(splitDaily(RS(290), 3, "INR")).toEqual({ shares: [RS(96), RS(96), RS(96)], shareMinor: RS(96), confirmedTotalMinor: RS(288) });
    expect(splitDaily(RS(300), 2, "INR")).toEqual({ shares: [RS(150), RS(150)], shareMinor: RS(150), confirmedTotalMinor: RS(300) });
    expect(splitDaily(RS(299), 1, "INR").confirmedTotalMinor).toBe(RS(299));
    expect(splitDaily(290n, 3, "JPY")).toEqual({ shares: [96n, 96n, 96n], shareMinor: 96n, confirmedTotalMinor: 288n });
    expect(splitDaily(RS(300), 5, "INR").shares).toHaveLength(3);
  });

  it("counts the shares, never the typed total, in the cost", () => {
    const shares = splitDaily(RS(290), 3, "INR").shares;
    const c = cost(shares.map((s) => Number(s / 100n)), "2026-11-03T23:59");
    expect(c.aboutTotalMinor).toBe(RS(288 * 7));
  });
});

describe("maxFittingDaily is exact (fast-check)", () => {
  const caseArb = fc.record({
    tz: fc.constantFrom(IST, NY, "UTC", "Asia/Tokyo"),
    nowMs: fc.integer({ min: Date.UTC(2026, 0, 1), max: Date.UTC(2027, 11, 1) }),
    runDays: fc.integer({ min: 2, max: 90 }),
    leftToday: fc.integer({ min: 0, max: 2_000_000 }).map(BigInt),
    leftMonth: fc.option(fc.integer({ min: 0, max: 20_000_000 }).map(BigInt), { nil: null }),
    versions: fc.integer({ min: 1, max: 3 }),
    step: fc.constantFrom(1_000n, 100n, 2_500n),
    laterStartDays: fc.integer({ min: 0, max: 14 }),
  });

  type Case = { tz: string; nowMs: number; runDays: number; leftToday: bigint; leftMonth: bigint | null; versions: number; step: bigint; laterStartDays: number };
  const fitOf = (k: Case): FitInput => {
    const now = new Date(k.nowMs);
    const d = runDates({ runDays: k.runDays, startMode: k.laterStartDays === 0 ? "now" : "at", startsAt: new Date(k.nowMs + k.laterStartDays * 86_400_000), tz: k.tz, now });
    return { startsAt: d.startsAt, endsAt: d.endsAt, tz: k.tz, now, leftTodayMinor: k.leftToday, leftMonthMinor: k.leftMonth, stepMinor: k.step, currency: "INR", versions: k.versions };
  };

  it("D fits and D + step does not; null means not even one step fits", () => {
    fc.assert(
      fc.property(caseArb, (k) => {
        const fit = fitOf(k);
        const d = maxFittingDaily(fit);
        if (d === null) {
          expect(dailyFits(fit.stepMinor, fit)).toBe(false);
          return;
        }
        expect(d % fit.stepMinor).toBe(0n);
        expect(dailyFits(d, fit)).toBe(true);
        expect(dailyFits(d + fit.stepMinor, fit)).toBe(false);
        // The presenter agrees: the split at D fits the same headroom.
        const shares = splitDaily(d, k.versions, "INR").shares.map((s) => ({ dailyMinor: s }));
        expect(presentCost({ sets: shares, startsAt: fit.startsAt, endsAt: fit.endsAt, tz: k.tz, now: fit.now, headroom: { currency: "INR", today: { left: k.leftToday }, month: { left: k.leftMonth } } }).fits).toBe(true);
      }),
      { numRuns: 150 },
    );
  });

  it("fixesFor offers only fixes that fit", () => {
    fc.assert(
      fc.property(caseArb, fc.integer({ min: 10, max: 5_000 }), fc.constantFrom("spend.daily_limit" as const, "spend.monthly_limit" as const, "spend.probation" as const), (k, dailyRupees, code) => {
        const fit = fitOf(k);
        const input = {
          dailyMinor: RS(dailyRupees),
          runDays: k.runDays,
          startMode: k.laterStartDays === 0 ? ("now" as const) : ("at" as const),
          startsAt: fit.startsAt,
          tz: k.tz,
          now: fit.now,
          leftTodayMinor: k.leftToday,
          leftMonthMinor: k.leftMonth,
          currency: "INR",
          stepMinor: k.step,
          versions: k.versions,
        };
        const fixes = fixesFor(code, input);
        expect(fixes[fixes.length - 1]).toEqual({ kind: "ask_owner" });
        for (const f of fixes) {
          if (f.kind === "lower_daily") {
            expect(f.toMinor < input.dailyMinor).toBe(true);
            expect(dailyFits(f.toMinor, fit)).toBe(true);
          }
          if (f.kind === "fewer_days") {
            expect(f.days).toBeGreaterThanOrEqual(2);
            expect(f.days).toBeLessThan(k.runDays);
            const d = runDates({ runDays: f.days, startMode: input.startMode, startsAt: input.startsAt, tz: k.tz, now: fit.now });
            expect(dailyFits(input.dailyMinor, { ...fit, startsAt: d.startsAt, endsAt: d.endsAt })).toBe(true);
          }
        }
      }),
      { numRuns: 120 },
    );
  });
});
