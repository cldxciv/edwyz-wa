import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  waba: { findFirst: vi.fn() },
  phoneNumber: { findMany: vi.fn() },
  platformSetting: { findUnique: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
  $queryRaw: vi.fn(),
}));
const auditMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/auth/audit", () => ({ audit: auditMock }));

import { RATECARD_KEY, clearRateCard, getRateCard, parseRateCard, rateFor, saveRateCard } from "@/lib/admin/ratecard";
import { countByCountry, estimateBreakdown } from "@/lib/broadcasts/cost";
import { callingCodesFor, countryOfPhone } from "@/lib/broadcasts/country";
import { portfolioPhones, portfolioUsage, uniqueRecipientsInWindow } from "@/lib/broadcasts/portfolio";
import { TIER_LIMITS, allowedNow, daysToReach, isKnownTier, portfolioLimit, scalingHint, tierLimit } from "@/lib/broadcasts/throttle";

beforeEach(() => {
  vi.resetAllMocks();
});

describe("messaging tiers", () => {
  it("knows Meta's real tier names", () => {
    expect(TIER_LIMITS).toMatchObject({ TIER_50: 50, TIER_250: 250, TIER_1K: 1000, TIER_2K: 2000, TIER_10K: 10_000, TIER_100K: 100_000 });
    expect(tierLimit("TIER_UNLIMITED")).toBe(Infinity);
    expect(tierLimit("UNLIMITED")).toBe(Infinity);
    expect(tierLimit("tier_50")).toBe(50);
  });
  it("treats an unknown or missing tier as the lowest known level", () => {
    expect(tierLimit("TIER_WEIRD")).toBe(250);
    expect(tierLimit(null)).toBe(250);
    expect(isKnownTier("TIER_2K")).toBe(true);
    expect(isKnownTier("TIER_WEIRD")).toBe(false);
  });
  it("shares the highest tier across a business portfolio", () => {
    expect(portfolioLimit(["TIER_250", "TIER_10K", null])).toBe(10_000);
    expect(portfolioLimit(["TIER_1K", "TIER_UNLIMITED"])).toBe(Infinity);
    expect(portfolioLimit([null, "junk"])).toBe(250);
    expect(portfolioLimit([])).toBe(250);
  });
  it("allows a batch only up to what is left in the rolling window", () => {
    expect(allowedNow({ tier: "TIER_250", limit: 2000, sentLast24h: 1990, batchSize: 20 })).toBe(10);
    expect(allowedNow({ tier: "TIER_250", limit: 2000, sentLast24h: 2000, batchSize: 20 })).toBe(0);
    expect(allowedNow({ tier: "TIER_50", sentLast24h: 49, batchSize: 20 })).toBe(1);
  });
  it("tells how many days a campaign needs and how the limit grows", () => {
    expect(daysToReach(0, 1000, 0)).toBe(0);
    expect(daysToReach(500, 1000, 0)).toBe(1);
    expect(daysToReach(2500, 1000, 400)).toBe(3);
    expect(daysToReach(10, Infinity, 5)).toBe(1);
    expect(scalingHint("TIER_250")).toMatch(/2,000/);
    expect(scalingHint("TIER_10K")).toMatch(/Meta raises/);
    expect(scalingHint("TIER_UNLIMITED")).toBeNull();
  });
});

describe("portfolio usage (unique recipients, rolling 24 hours)", () => {
  const now = new Date("2026-03-02T12:00:00Z");

  it("groups numbers by the Meta business portfolio, scoped to the tenant", async () => {
    db.waba.findFirst.mockResolvedValue({ businessId: "b1" });
    db.phoneNumber.findMany.mockResolvedValue([{ id: "p1" }, { id: "p2" }]);
    await portfolioPhones("t1", "w1");
    expect(db.waba.findFirst).toHaveBeenCalledWith({ where: { id: "w1", tenantId: "t1" }, select: { businessId: true } });
    expect(db.phoneNumber.findMany.mock.calls[0][0].where).toEqual({ tenantId: "t1", waba: { businessId: "b1" } });
  });
  it("falls back to the single account when the portfolio is unknown", async () => {
    db.waba.findFirst.mockResolvedValue({ businessId: null });
    db.phoneNumber.findMany.mockResolvedValue([]);
    await portfolioPhones("t1", "w1");
    expect(db.phoneNumber.findMany.mock.calls[0][0].where).toEqual({ tenantId: "t1", waba: { id: "w1" } });
  });
  it("counts distinct people and returns the oldest send, without touching the database for no numbers", async () => {
    expect(await uniqueRecipientsInWindow("t1", [], now)).toEqual({ count: 0, oldest: null });
    expect(db.$queryRaw).not.toHaveBeenCalled();
    const oldest = new Date("2026-03-02T01:00:00Z");
    db.$queryRaw.mockResolvedValue([{ n: BigInt(37), oldest }]);
    expect(await uniqueRecipientsInWindow("t1", ["p1"], now)).toEqual({ count: 37, oldest });
  });
  it("combines the portfolio limit with the unique count", async () => {
    db.waba.findFirst.mockResolvedValue({ businessId: "b1" });
    db.phoneNumber.findMany.mockResolvedValue([
      { id: "p1", messagingLimitTier: "TIER_1K", qualityRating: "GREEN" },
      { id: "p2", messagingLimitTier: "TIER_10K", qualityRating: "GREEN" },
    ]);
    db.$queryRaw.mockResolvedValue([{ n: 12, oldest: null }]);
    const usage = await portfolioUsage("t1", "w1", now);
    expect(usage).toMatchObject({ limit: 10_000, used: 12, oldest: null });
    expect(usage.phones).toHaveLength(2);
  });
});

describe("countries", () => {
  it("finds the country from the calling code", () => {
    expect(countryOfPhone("+919876543210")).toBe("IN");
    expect(countryOfPhone("+971501234567")).toBe("AE");
    expect(countryOfPhone("+14155550123")).toBe("US");
    expect(countryOfPhone("+999123")).toBeNull();
    expect(callingCodesFor("in")).toEqual(["91"]);
    expect(callingCodesFor("CA")).toEqual(["1"]);
    expect(callingCodesFor("ZZ")).toEqual([]);
  });
});

describe("rate card", () => {
  const body = { currency: "inr", note: " from the Meta list ", rates: { in: { MARKETING: 88, UTILITY: "12" }, "*": { MARKETING: 500 } } };

  it("validates and normalises the admin form", () => {
    const card = parseRateCard(body, new Date("2026-03-01T00:00:00Z"));
    expect(card).toEqual({ currency: "INR", note: "from the Meta list", rates: { IN: { MARKETING: 88, UTILITY: 12 }, "*": { MARKETING: 500 } }, updatedAt: "2026-03-01T00:00:00.000Z", scale: 0 });
  });
  it.each([
    [{ ...body, currency: "rupees" }, /three-letter/],
    [{ ...body, rates: { IND: { MARKETING: 1 } } }, /two-letter/],
    [{ ...body, rates: { IN: { MARKETING: 1.5 } } }, /whole number/],
    [{ ...body, rates: { IN: { MARKETING: -1 } } }, /whole number/],
    [{ ...body, rates: { IN: { MARKETING: 99_999_999 } } }, /whole number/],
    [{ ...body, rates: { IN: {}, US: { UTILITY: "" } } }, /at least one rate/],
    [{ ...body, rates: { IN: { MARKETING: 1 }, in: { MARKETING: 2 } } }, /twice/],
    [{ ...body, rates: [] }, /list of countries/],
  ])("rejects %j", (input, message) => {
    expect(() => parseRateCard(input as Record<string, unknown>)).toThrow(message);
  });
  it("is unconfigured until saved, and ignores a corrupt stored value", async () => {
    db.platformSetting.findUnique.mockResolvedValue(null);
    expect(await getRateCard()).toBeNull();
    db.platformSetting.findUnique.mockResolvedValue({ value: { currency: "INR", rates: { IN: { MARKETING: "x" } } } });
    expect(await getRateCard()).toBeNull();
    db.platformSetting.findUnique.mockRejectedValue(new Error("db down"));
    expect(await getRateCard()).toBeNull();
  });
  it("saves and clears under one platform setting key and audits both", async () => {
    const card = await saveRateCard("admin1", body);
    expect(db.platformSetting.upsert).toHaveBeenCalledWith({ where: { key: RATECARD_KEY }, create: { key: RATECARD_KEY, value: card }, update: { value: card } });
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ userId: "admin1", action: "admin.ratecard.update" }));
    await clearRateCard("admin1");
    expect(db.platformSetting.deleteMany).toHaveBeenCalledWith({ where: { key: RATECARD_KEY } });
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "admin.ratecard.clear" }));
  });
  it("prefers a country's own price and falls back to the star row", () => {
    const card = parseRateCard(body);
    expect(rateFor(card, "IN", "marketing")).toBe(88);
    expect(rateFor(card, "BR", "MARKETING")).toBe(500);
    expect(rateFor(card, "BR", "UTILITY")).toBeUndefined();
    expect(rateFor(card, null, "MARKETING")).toBe(500);
  });
});

describe("estimateBreakdown", () => {
  const card = parseRateCard({ currency: "INR", rates: { IN: { MARKETING: 100 }, US: { MARKETING: 300 } } });
  const countries = countByCountry(["+919800000001", "+919800000002", "+14155550123", "+999000"]);

  it("never invents prices: no card means not configured", () => {
    const out = estimateBreakdown({ category: "MARKETING", countries, card: null });
    expect(out.configured).toBe(false);
    expect(out.count).toBe(4);
  });
  // The conservative estimate (docs/SPEND-CONTROLS-SPEC.md 4.9): a country without a price costs the card's highest rate for the
  // category (a +1 number too, while not every +1 country is priced), so a bulk hold is never too low.
  it("totals every recipient, pricing a country without a price at the card's highest rate", () => {
    const out = estimateBreakdown({ category: "MARKETING", countries, card });
    expect(out).toMatchObject({ configured: true, currency: "INR", totalMinor: 800, unpricedCount: 0, highestRateCount: 2, count: 4 });
    expect(out.lines[0]).toEqual({ country: "IN", count: 2, perMessageMinor: 100, totalMinor: 200 });
  });
  it("prices a category the card does not list at the card's highest rate of any category", () => {
    expect(estimateBreakdown({ category: "UTILITY", countries, card })).toMatchObject({ configured: true, totalMinor: 1200 });
  });
});
