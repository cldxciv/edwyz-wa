import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const model = () => ({ findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), upsert: vi.fn() });
  return { webhookEvent: model(), phoneNumber: model(), waba: model(), contact: model(), conversation: model(), message: model(), template: model(), broadcastRecipient: model(), auditLog: model() };
});
const actorMock = vi.hoisted(() => ({ role: "admin" as string }));
const overview = vi.hoisted(() => ({ numberLimits: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/automation/engine", () => ({ runAutomationsForInbound: vi.fn().mockResolvedValue({ replied: false }) }));
vi.mock("@/lib/integrations/events", () => ({ emitEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/auth", () => ({ getActor: vi.fn(async () => ({ userId: "u1", tenantId: "t1", role: actorMock.role })) }));
vi.mock("@/lib/broadcasts/overview", () => overview);

import { GET as limitsGet } from "@/app/api/workspace/messaging-limits/route";
import { CANONICAL_TIERS, higherTier, isCanonicalTier, normalizeTier, TIER_PEOPLE, tierLabel, tierPeople } from "@/lib/messaging-limit";
import { daysToReach, portfolioLimit, tierLimit } from "@/lib/broadcasts/throttle";
import { meterView } from "@/lib/broadcasts/limits";
import { processWebhookEvent } from "@/lib/webhooks/processor";

describe("tier names", () => {
  it("knows every level Meta uses, including 50, 2,000 and unlimited", () => {
    expect([...CANONICAL_TIERS]).toEqual(["TIER_50", "TIER_250", "TIER_1K", "TIER_2K", "TIER_10K", "TIER_100K", "TIER_UNLIMITED"]);
    expect(TIER_PEOPLE.TIER_2K).toBe(2000);
    expect(isCanonicalTier("TIER_2K")).toBe(true);
    expect(isCanonicalTier("TIER_3K")).toBe(false);
  });

  it("stores one canonical name whatever spelling arrives", () => {
    for (const raw of ["TIER_UNLIMITED", "UNLIMITED", "tier_unlimited", " Unlimited "]) expect(normalizeTier(raw)).toBe("TIER_UNLIMITED");
    for (const raw of ["TIER_1K", "tier_1k", "TIER_1000", "1000", 1000, "1k"]) expect(normalizeTier(raw)).toBe("TIER_1K");
    expect(normalizeTier("TIER_2K")).toBe("TIER_2K");
    expect(normalizeTier(2000)).toBe("TIER_2K");
    expect(normalizeTier("TIER-100K")).toBe("TIER_100K");
    expect(normalizeTier(50)).toBe("TIER_50");
  });

  it("reads 'not set' as nothing and keeps an unrecognised name visible instead of guessing", () => {
    for (const raw of [null, undefined, "", "TIER_NOT_SET", "NONE", {}, true]) expect(normalizeTier(raw)).toBeNull();
    expect(normalizeTier("tier_weird")).toBe("TIER_WEIRD");
    expect(tierPeople("TIER_WEIRD")).toBeNull();
    expect(tierLabel("TIER_WEIRD")).toBe("Not recognised yet");
    expect(tierLabel(null)).toBe("Not reported yet");
  });

  it("words limits for people", () => {
    expect(tierLabel("TIER_250")).toBe("250 customers a day");
    expect(tierLabel("TIER_2K")).toBe("2,000 customers a day");
    expect(tierLabel("TIER_UNLIMITED")).toBe("No daily limit");
  });

  it("keeps the larger limit and lets unknown tiers lose against known ones", () => {
    expect(higherTier("TIER_250", "TIER_2K")).toBe("TIER_2K");
    expect(higherTier("TIER_UNLIMITED", "TIER_100K")).toBe("TIER_UNLIMITED");
    expect(higherTier("TIER_WEIRD", "TIER_250")).toBe("TIER_250");
    expect(higherTier("TIER_250", null)).toBe("TIER_250");
    expect(higherTier(null, null)).toBeNull();
  });
});

describe("portfolio tier helper", () => {
  it("picks the highest known tier and ignores unknown ones", async () => {
    const { topTier } = await import("@/lib/broadcasts/throttle");
    expect(topTier([{ messagingLimitTier: "TIER_250" }, { messagingLimitTier: "TIER_10K" }, { messagingLimitTier: "TIER_WEIRD" }])).toBe("TIER_10K");
    expect(topTier([{ messagingLimitTier: null }])).toBeNull();
  });
});

describe("the sending throttle agrees with the stored names", () => {
  it("throttles Meta's real names correctly and never silently drops to 250 for a known tier", () => {
    for (const tier of CANONICAL_TIERS) expect(tierLimit(tier)).toBe(TIER_PEOPLE[tier]);
    expect(tierLimit("TIER_UNLIMITED")).toBe(Infinity);
    expect(tierLimit("TIER_2K")).toBe(2000);
    expect(tierLimit("TIER_50")).toBe(50);
  });

  it("shares one limit across a portfolio (the highest tier any number reports)", () => {
    expect(portfolioLimit(["TIER_250", "TIER_2K"])).toBe(2000);
    expect(portfolioLimit(["TIER_250", "TIER_UNLIMITED"])).toBe(Infinity);
    expect(daysToReach(5000, 2000, 500)).toBe(3);
  });

  it("the meter on the campaign screen reads the same names", () => {
    expect(meterView("TIER_2K", 500)).toMatchObject({ known: true, limit: 2000, percent: 25 });
    expect(meterView("TIER_UNLIMITED", 500)).toMatchObject({ known: true, unlimited: true });
    expect(meterView("TIER_WEIRD", 5)).toMatchObject({ known: false });
  });
});

describe("GET /api/workspace/messaging-limits (connect screen)", () => {
  beforeEach(() => {
    actorMock.role = "admin";
    overview.numberLimits.mockReset();
  });

  it("shows each number with the portfolio's tier, label, usage and a hint", async () => {
    overview.numberLimits.mockResolvedValue([
      { id: "p1", displayPhone: "+91 98765 43210", verifiedName: "Acme", qualityRating: "GREEN", messagingLimitTier: "TIER_250", portfolioTier: "TIER_2K", sentLast24h: 500 },
      { id: "p2", displayPhone: "+91 91234 56789", verifiedName: null, qualityRating: null, messagingLimitTier: "UNLIMITED", portfolioTier: null, sentLast24h: 7 },
      { id: "p3", displayPhone: "+91 90000 00000", verifiedName: null, qualityRating: null, messagingLimitTier: null, portfolioTier: null, sentLast24h: 0 },
    ]);
    const res = await limitsGet(new Request("https://wa.test/api/workspace/messaging-limits"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { numbers } = await res.json();
    expect(numbers[0]).toMatchObject({ id: "p1", tier: "TIER_2K", tierLabel: "2,000 customers a day", dailyLimit: 2000, unlimited: false, sentLast24h: 500 });
    expect(numbers[0].meter).toContain("500 of 2,000");
    expect(numbers[1]).toMatchObject({ tier: "TIER_UNLIMITED", tierLabel: "No daily limit", dailyLimit: null, unlimited: true });
    expect(numbers[1].hint).toBeNull();
    expect(numbers[2]).toMatchObject({ tier: null, tierLabel: "Not reported yet", dailyLimit: null });
  });

  it("is for owners and admins only", async () => {
    actorMock.role = "agent";
    expect((await limitsGet(new Request("https://wa.test/api/workspace/messaging-limits"))).status).toBe(403);
    expect(overview.numberLimits).not.toHaveBeenCalled();
  });
});

describe("Meta reports a change of the portfolio limit", () => {
  const event = (field: string, value: Record<string, unknown>) =>
    db.webhookEvent.findUnique.mockResolvedValue({ id: "e1", payload: { object: "whatsapp_business_account", entry: [{ id: "waba1", changes: [{ field, value }] }] }, processedAt: null });

  beforeEach(() => {
    vi.clearAllMocks();
    db.waba.findUnique.mockResolvedValue({ id: "waba_row", tenantId: "t1" });
    db.waba.findFirst.mockResolvedValue({ businessId: "biz1" });
  });

  it("stores the canonical tier on every number of that business portfolio, scoped to the workspace", async () => {
    event("business_capability_update", { max_daily_conversations_per_business: "TIER_2K" });
    await processWebhookEvent("e1");
    expect(db.phoneNumber.updateMany).toHaveBeenCalledWith({ where: { tenantId: "t1", waba: { businessId: "biz1" } }, data: { messagingLimitTier: "TIER_2K" } });
    expect(db.waba.findFirst).toHaveBeenCalledWith({ where: { id: "waba_row", tenantId: "t1" }, select: { businessId: true } });
  });

  it("a downgrade reported for one number is stored on every number of its portfolio, so a sibling's older tier cannot mask it", async () => {
    db.phoneNumber.findUnique.mockResolvedValue({ id: "ph_row", tenantId: "t1" });
    db.phoneNumber.findFirst.mockResolvedValue({ wabaRefId: "waba_row" });
    event("phone_number_quality_update", { phone_number_id: "meta_phone_1", quality_rating: "YELLOW", current_limit: "TIER_250" });
    await processWebhookEvent("e1");
    expect(db.phoneNumber.updateMany).toHaveBeenCalledWith({ where: { id: "ph_row", tenantId: "t1" }, data: { qualityRating: "YELLOW", messagingLimitTier: "TIER_250" } });
    expect(db.phoneNumber.updateMany).toHaveBeenCalledWith({ where: { tenantId: "t1", waba: { businessId: "biz1" } }, data: { messagingLimitTier: "TIER_250" } });
    expect(db.phoneNumber.findFirst).toHaveBeenCalledWith({ where: { id: "ph_row", tenantId: "t1" }, select: { wabaRefId: true } });
  });

  it("a quality change without a limit touches only that number", async () => {
    db.phoneNumber.findUnique.mockResolvedValue({ id: "ph_row", tenantId: "t1" });
    event("phone_number_quality_update", { phone_number_id: "meta_phone_1", quality_rating: "RED" });
    await processWebhookEvent("e1");
    expect(db.phoneNumber.updateMany).toHaveBeenCalledTimes(1);
  });

  it("accepts the older numeric field and falls back to the single account when the portfolio is unknown", async () => {
    db.waba.findFirst.mockResolvedValue({ businessId: null });
    event("business_capability_update", { max_daily_conversation_per_phone: 10000, max_phone_numbers_per_business: 25 });
    await processWebhookEvent("e1");
    expect(db.phoneNumber.updateMany).toHaveBeenCalledWith({ where: { tenantId: "t1", waba: { id: "waba_row" } }, data: { messagingLimitTier: "TIER_10K" } });
  });

  it("changes nothing when the update carries no limit, and still records the event", async () => {
    event("business_capability_update", { max_phone_numbers_per_business: 25 });
    await processWebhookEvent("e1");
    expect(db.phoneNumber.updateMany).not.toHaveBeenCalled();
    expect(db.auditLog.create).toHaveBeenCalled();
  });

  it("does not apply a limit from other account events", async () => {
    event("account_update", { event: "VERIFIED_ACCOUNT", max_daily_conversation_per_phone: 10000 });
    await processWebhookEvent("e1");
    expect(db.phoneNumber.updateMany).not.toHaveBeenCalled();
  });
});
