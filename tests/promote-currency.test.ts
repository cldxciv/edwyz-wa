import { describe, expect, it, vi } from "vitest";

/**
 * The account currency everywhere (docs/IG-PAGE-ADS-SPEC.md 3.1a, D8; PRM-02 acceptance 8): the stepper step and the
 * default daily budget in USD and JPY through Phase 0's FX conversion, money formatting with the currency's exponent and
 * Indian grouping, and a step of 1 major unit when there is no fresh FX rate.
 */
vi.mock("@/lib/db", () => ({ prisma: {} }));

import { formatCount, formatMoney, promoteText } from "@/lib/promote/copy";
import { budgetStep, dailyFits, defaultDailyMinor, type FromInr, INR_DEFAULT_DAILY_MINOR, INR_STEP_MINOR, majorUnit, maxFittingDaily, presentCost, splitDaily } from "@/lib/promote/cost";
import { runDates } from "@/lib/promote/dates";
import { convertFromInr, parseFxTable } from "@/lib/spend/fx";

const NOW = new Date("2026-10-28T14:00:00Z");
/** Phase 0's FX table: INR per unit, fresh as of last week. */
const TABLE = parseFxTable({ rates: { USD: "84.10", JPY: "0.56" }, updatedAt: "2026-10-21T00:00:00Z" });
const STALE = parseFxTable({ rates: { USD: "84.10", JPY: "0.56" }, updatedAt: "2026-08-01T00:00:00Z" });
const fx =
  (currency: string, table = TABLE): FromInr =>
  (inrMinor) =>
    convertFromInr(inrMinor, currency, table, NOW);

describe("INR (3.1, D8)", () => {
  it("steps by ₹10 and defaults to min(₹300, what fits), rounded down to ₹10, never below Meta's minimum", () => {
    expect(budgetStep("INR")).toBe(1_000n);
    expect(INR_STEP_MINOR).toBe(1_000n);
    expect(defaultDailyMinor({ currency: "INR" })).toBe(INR_DEFAULT_DAILY_MINOR);
    expect(defaultDailyMinor({ currency: "INR", maxFittingMinor: 28_000n })).toBe(28_000n);
    expect(defaultDailyMinor({ currency: "INR", maxFittingMinor: 28_550n })).toBe(28_000n);
    expect(defaultDailyMinor({ currency: "INR", maxFittingMinor: 90_000n })).toBe(30_000n);
    expect(defaultDailyMinor({ currency: "INR", maxFittingMinor: 28_000n, minDailyMinor: 40_000n })).toBe(40_000n);
    expect(formatMoney(15_000_000n, "INR")).toBe("₹1,50,000");
    expect(formatCount(150_000)).toBe("1,50,000");
  });
});

describe("USD", () => {
  it("steps by the FX equivalent of ₹10 rounded up to a whole dollar, and defaults to ₹300's equivalent rounded down", () => {
    // ₹10 = 11 cents at 84.10, rounded up to $1. ₹300 = 356 cents, rounded down to $3.
    expect(convertFromInr(1_000n, "USD", TABLE, NOW)).toBe(11n);
    expect(budgetStep("USD", fx("USD"))).toBe(100n);
    expect(defaultDailyMinor({ currency: "USD", fromInr: fx("USD") })).toBe(300n);
    expect(defaultDailyMinor({ currency: "USD", fromInr: fx("USD"), maxFittingMinor: 200n })).toBe(200n);
    expect(defaultDailyMinor({ currency: "USD", fromInr: fx("USD"), minDailyMinor: 500n })).toBe(500n);
  });

  it("formats every cost line in dollars", () => {
    const d = runDates({ runDays: 5, startMode: "now", tz: "America/New_York", now: NOW });
    const c = presentCost({ sets: [{ dailyMinor: 300n }], startsAt: d.startsAt, endsAt: d.endsAt, tz: "America/New_York", now: NOW, headroom: { currency: "USD", today: { left: 2_000n }, month: { left: 20_000n } } });
    expect(c.currency).toBe("USD");
    expect(c.lines.about).toBe("About $15 in total.");
    expect(c.lines.atMost).toMatch(/^At most \$[\d,.]+, because Meta can spend up to 75% more on a busy day\.$/);
    expect(c.lines.left).toMatch(/^\$[\d,.]+ left today · \$[\d,.]+ left this month$/);
    expect(promoteText("card.boost.start", { amount: { minor: c.atMostMinor, currency: "USD" } })).toMatch(/^Start boost · up to \$/);
    expect(formatMoney(123_456_789n, "USD")).toBe("$12,34,567.89");
  });

  it("splits a fair test to whole dollars, and finds the largest fitting total in dollar steps", () => {
    expect(splitDaily(1_000n, 3, "USD")).toEqual({ shares: [300n, 300n, 300n], shareMinor: 300n, confirmedTotalMinor: 900n });
    const d = runDates({ runDays: 7, startMode: "now", tz: "America/New_York", now: NOW });
    const fit = { startsAt: d.startsAt, endsAt: d.endsAt, tz: "America/New_York", now: NOW, leftTodayMinor: 1_000n, leftMonthMinor: null, stepMinor: budgetStep("USD", fx("USD")), currency: "USD" };
    const best = maxFittingDaily(fit)!;
    expect(best % 100n).toBe(0n);
    expect(dailyFits(best, fit)).toBe(true);
    expect(dailyFits(best + 100n, fit)).toBe(false);
  });
});

describe("JPY (no minor unit)", () => {
  it("steps by the FX equivalent of ₹10 in whole yen, and defaults to ₹300's equivalent", () => {
    expect(majorUnit("JPY")).toBe(1n);
    expect(budgetStep("JPY", fx("JPY"))).toBe(17n);
    expect(defaultDailyMinor({ currency: "JPY", fromInr: fx("JPY") })).toBe(535n);
    expect(formatMoney(535n, "JPY")).toBe("¥535");
    expect(formatMoney(150_000n, "JPY")).toBe("¥1,50,000");
    expect(splitDaily(290n, 3, "JPY").confirmedTotalMinor).toBe(288n);
  });

  it("formats the cost lines in yen", () => {
    const d = runDates({ runDays: 5, startMode: "now", tz: "Asia/Tokyo", now: NOW });
    const c = presentCost({ sets: [{ dailyMinor: 535n }], startsAt: d.startsAt, endsAt: d.endsAt, tz: "Asia/Tokyo", now: NOW, headroom: { currency: "JPY", today: { left: 5_000n }, month: { left: 50_000n } } });
    expect(c.lines.about).toBe("About ¥2,675 in total.");
    expect(c.lines.atMost).toMatch(/^At most ¥[\d,]+,/);
  });
});

describe("no fresh FX rate (3.1a)", () => {
  it("steps by 1 major unit and defaults to Meta's minimum (or nothing when that is unknown)", () => {
    expect(convertFromInr(1_000n, "USD", STALE, NOW)).toBeNull();
    expect(budgetStep("USD", fx("USD", STALE))).toBe(100n);
    expect(budgetStep("JPY", fx("JPY", STALE))).toBe(1n);
    expect(budgetStep("USD")).toBe(100n);
    expect(budgetStep("KWD", null)).toBe(1_000n);
    expect(defaultDailyMinor({ currency: "USD", fromInr: fx("USD", STALE), minDailyMinor: 100n })).toBe(100n);
    expect(defaultDailyMinor({ currency: "USD", fromInr: fx("USD", STALE) })).toBeNull();
    expect(defaultDailyMinor({ currency: "EUR" })).toBeNull();
  });
});
