import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "Send now" on a broadcast that was already scheduled counted its own pending messages twice against the monthly broadcast
 * limit: once as waiting messages (frozen when it was scheduled) and once as the audience the start adds. The broadcast being
 * started is now left out of the month's use (broadcastQuotaWhere / usageFor / assertWithinLimit `excludeBroadcastId`).
 */

const db = vi.hoisted(() => ({
  tenant: { findUnique: vi.fn() },
  plan: { findUnique: vi.fn() },
  broadcastRecipient: { count: vi.fn() },
  broadcast: { findFirst: vi.fn() },
  platformSetting: { findUnique: vi.fn(async () => null) },
}));
vi.mock("@/lib/db", () => ({ prisma: db }));
const sentinel = vi.hoisted(() => new Error("stop after the limit check"));
const billing = vi.hoisted(() => ({ assertWithinLimit: vi.fn() }));
vi.mock("@/lib/billing", async (orig) => ({ ...(await orig<typeof import("@/lib/billing")>()), assertWithinLimit: billing.assertWithinLimit }));
vi.mock("@/lib/broadcasts/audience", async (orig) => ({ ...(await orig<typeof import("@/lib/broadcasts/audience")>()), countAudience: vi.fn(async () => 40) }));
vi.mock("@/lib/spend/kill", async (orig) => ({ ...(await orig<typeof import("@/lib/spend/kill")>()), spendState: vi.fn(async () => ({ workspace: "none", platform: "none" })) }));

import { assertWithinLimit, broadcastQuotaWhere, usageFor } from "@/lib/billing/limits";
import { startBroadcast } from "@/lib/broadcasts/service";

const now = new Date("2026-11-10T00:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("broadcastQuotaWhere leaves out the broadcast being started", () => {
  it("only its waiting and queued messages; what it already sent still counts", () => {
    const where = broadcastQuotaWhere("t1", now, { excludeBroadcastId: "b1" });
    const [sent, queued, pending] = where.OR;
    expect(sent).not.toHaveProperty("broadcastId");
    expect(queued).toMatchObject({ status: "queued", broadcastId: { not: "b1" } });
    expect(pending).toMatchObject({ status: "pending", broadcastId: { not: "b1" } });
  });

  it("without one, the query is what it always was", () => {
    const where = broadcastQuotaWhere("t1", now);
    expect(where.OR[1].broadcastId).toBeUndefined();
    expect(where.OR[2].broadcastId).toBeUndefined();
    expect(JSON.stringify(where)).not.toContain("broadcastId");
  });

  it("usageFor passes it to the count", async () => {
    db.broadcastRecipient.count.mockResolvedValue(5);
    await usageFor("t1", "broadcastContacts", now, { excludeBroadcastId: "b1" });
    expect(db.broadcastRecipient.count.mock.calls[0][0].where).toEqual(broadcastQuotaWhere("t1", now, { excludeBroadcastId: "b1" }));
  });
});

describe("the limit check", () => {
  // Limit 100. 70 messages held this month, 40 of them this scheduled broadcast's own waiting ones. Starting it adds its audience (40).
  const setup = () => {
    db.tenant.findUnique.mockResolvedValue({ status: "active", suspendedReason: null, billingExempt: false, trialEndsAt: null, subscription: { status: "active", currentPeriodEnd: new Date(Date.now() + 86_400_000), pastDueSince: null, planId: "p1", razorpaySubscriptionId: "sub_1", plan: { name: "Growth" } } });
    db.plan.findUnique.mockResolvedValue({ name: "Growth", seatLimit: null, contactLimit: null, monthlyBroadcastLimit: 100, adAccountLimit: null, scheduledPostLimit: null, connectedChannelLimit: null });
    db.broadcastRecipient.count.mockImplementation(async ({ where }: { where: ReturnType<typeof broadcastQuotaWhere> }) => (where.OR[2].broadcastId?.not === "b1" ? 30 : 70));
  };

  it("counted twice before: 70 + 40 is over 100, so Send now was refused below the limit", async () => {
    setup();
    await expect(assertWithinLimit("t1", "broadcastContacts", 40)).rejects.toMatchObject({ status: 402 });
  });

  it("leaving the broadcast out: 30 + 40 fits", async () => {
    setup();
    await expect(assertWithinLimit("t1", "broadcastContacts", 40, { excludeBroadcastId: "b1" })).resolves.toBeUndefined();
  });

  it("other broadcasts still count: 30 others plus 80 is over 100", async () => {
    setup();
    await expect(assertWithinLimit("t1", "broadcastContacts", 80, { excludeBroadcastId: "b1" })).rejects.toMatchObject({ status: 402 });
  });
});

describe("startBroadcast", () => {
  it("Send now on a scheduled broadcast checks its audience with the broadcast itself left out", async () => {
    billing.assertWithinLimit.mockRejectedValue(sentinel);
    db.broadcast.findFirst.mockResolvedValue({
      id: "b1", tenantId: "t1", name: "Diwali", status: "scheduled", segmentTags: [], audienceFilter: null, scheduledAt: new Date(Date.now() - 60_000), startedAt: null,
      missingValuePolicy: "skip", variableMap: null, phoneNumberId: "ph1", template: { status: "approved", category: "MARKETING", components: [] },
    });
    await expect(startBroadcast({ userId: "u1", tenantId: "t1", role: "owner" }, "b1")).rejects.toBe(sentinel);
    expect(billing.assertWithinLimit).toHaveBeenCalledWith("t1", "broadcastContacts", 40, { excludeBroadcastId: "b1" });
  });
});
