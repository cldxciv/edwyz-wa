import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  tenant: { findUnique: vi.fn(), findMany: vi.fn() },
  plan: { findUnique: vi.fn() },
  membership: { count: vi.fn(), findMany: vi.fn() },
  invite: { count: vi.fn() },
  contact: { count: vi.fn() },
  broadcastRecipient: { count: vi.fn() },
  usageLedger: { aggregate: vi.fn(), create: vi.fn() },
  adCampaign: { findMany: vi.fn() },
  scheduledPost: { count: vi.fn() },
  postTarget: { findMany: vi.fn() },
  platformSetting: { findUnique: vi.fn(), create: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
}));
const email = vi.hoisted(() => ({ queueEmail: vi.fn() }));
// reserveCredits() delegates to the AI gateway (docs/SPEND-CONTROLS-SPEC.md 4.10): the real gateway runs over the in-memory
// layers of tests/helpers/fake-ai-gateway.ts, whose AI counter rows sit behind prisma.spendCounter.
vi.mock("@/lib/db", async () => ({ prisma: Object.assign(db, { spendCounter: (await import("./helpers/fake-ai-gateway")).fakeAi.spendCounter }) }));
vi.mock("@/lib/email", () => email);
vi.mock("@/lib/spend/kill", async (orig) => (await import("./helpers/fake-ai-gateway")).fakeAiModule("kill", await orig()));
vi.mock("@/lib/spend/control", async (orig) => (await import("./helpers/fake-ai-gateway")).fakeAiModule("control", await orig()));
vi.mock("@/lib/spend/allowances", async (orig) => (await import("./helpers/fake-ai-gateway")).fakeAiModule("allowances", await orig()));
vi.mock("@/lib/spend/counters", async (orig) => (await import("./helpers/fake-ai-gateway")).fakeAiModule("counters", await orig()));
vi.mock("@/lib/spend/reservations", async (orig) => (await import("./helpers/fake-ai-gateway")).fakeAiModule("reservations", await orig()));
vi.mock("@/lib/spend/ledger", async (orig) => (await import("./helpers/fake-ai-gateway")).fakeAiModule("ledger", await orig()));
vi.mock("@/lib/spend/notify", async (orig) => (await import("./helpers/fake-ai-gateway")).fakeAiModule("notify", await orig()));
// @/lib/lifecycle/state stays real here: the usage alert tests below drive claimOnce through prisma.platformSetting.

import {
  adAccountsBlockedByPlan, assertAdAccountAllowed, assertChannelsAllowed, assertWithinLimit, limitFor, percentUsed, reserveCredits, resolveLimits, usageLines,
} from "@/lib/billing/limits";
import { alertLevel, alertsFrom, runUsageAlerts, sendUsageAlerts } from "@/lib/billing/usage-alerts";
import { registerAiAgentSeams, resetAiAgentSeams } from "@/lib/ai-agent/seams";
import { AI_AGENT_ACTOR } from "@/lib/spend/exec/ai";
import { fakeAi } from "./helpers/fake-ai-gateway";

const DAY = 86_400_000;
const NO_LIMITS: Record<"seatLimit" | "contactLimit" | "monthlyBroadcastLimit" | "adAccountLimit" | "scheduledPostLimit" | "connectedChannelLimit", number | null> = { seatLimit: null, contactLimit: null, monthlyBroadcastLimit: null, adAccountLimit: null, scheduledPostLimit: null, connectedChannelLimit: null };

function subscribed(plan: Partial<typeof NO_LIMITS> = {}, over: Record<string, unknown> = {}) {
  db.tenant.findUnique.mockResolvedValue({
    status: "active", suspendedReason: null, billingExempt: false, trialEndsAt: null,
    subscription: { status: "active", currentPeriodEnd: new Date(Date.now() + DAY), pastDueSince: null, planId: "p1", plan: { name: "Pro" } }, ...over,
  });
  db.plan.findUnique.mockResolvedValue({ ...NO_LIMITS, ...plan });
}

beforeEach(() => {
  vi.resetAllMocks();
  resetAiAgentSeams();
  delete process.env.AI_DEFAULT_MONTHLY_CREDITS;
  db.platformSetting.findUnique.mockResolvedValue(null);
  db.platformSetting.create.mockResolvedValue({});
  db.platformSetting.upsert.mockResolvedValue({});
  db.platformSetting.deleteMany.mockResolvedValue({ count: 0 });
  db.usageLedger.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
  db.adCampaign.findMany.mockResolvedValue([]);
  db.postTarget.findMany.mockResolvedValue([]);
  db.scheduledPost.count.mockResolvedValue(0);
});

// reserveCredits() keeps its signature but delegates to the AI gateway's reserveAi() (SPEND-CONTROLS-SPEC 4.10 and I5): the
// in-process holdCredits()/pendingCreditsFor() maps are retired, and the hold is a conditional reservation on the shared AI
// counter, so the guarantees below now hold across processes. A refusal is 402 ai_quota with the 4.13 copy.
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("AI credit reservations", () => {
  beforeEach(async () => {
    await fakeAi.reset();
    registerAiAgentSeams({ getMonthlyCreditLimit: async () => 10 });
    db.usageLedger.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
  });

  it("parallel calls cannot all pass the check and overshoot the allowance", async () => {
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => reserveCredits("t1", 4)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ status: 402, code: "ai_quota" });
    expect(fakeAi.counter("t1", "month").used).toBe(8n);
  });

  it("a released reservation frees its credits, and releasing twice frees them only once", async () => {
    const a = await reserveCredits("t1", 6);
    await expect(reserveCredits("t1", 6)).rejects.toMatchObject({ status: 402 });
    a();
    a();
    await flush();
    expect(fakeAi.counter("t1", "month").reserved).toBe(0n);
    const b = await reserveCredits("t1", 6);
    await expect(reserveCredits("t1", 6)).rejects.toMatchObject({ status: 402 });
    expect(fakeAi.counter("t1", "month").reserved).toBe(6n);
    b();
    await flush();
    expect(fakeAi.openHolds("t1")).toBe(0);
  });

  it("reservations are per workspace and add to the recorded usage", async () => {
    db.usageLedger.aggregate.mockResolvedValue({ _sum: { amount: 7 } });
    await expect(reserveCredits("t1", 4)).rejects.toMatchObject({ status: 402, message: expect.stringContaining("This month's AI limit is used up.") });
    const ok = await reserveCredits("t1", 3);
    await expect(reserveCredits("t2", 3)).resolves.toBeTypeOf("function");
    ok();
  });

  it("a cost of nothing holds nothing", async () => {
    const release = await reserveCredits("t1", 0);
    expect(release.hold).toBeNull();
    expect(fakeAi.openHolds("t1")).toBe(0);
  });
});

describe("shared credit reservation", () => {
  beforeEach(async () => {
    await fakeAi.reset();
    registerAiAgentSeams({ getMonthlyCreditLimit: async () => 10 });
    db.usageLedger.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
  });

  it("every spender holds on the same counter: Creative Studio's hold is seen by the AI agent", async () => {
    const creative = await reserveCredits("t1", 8);
    await expect(reserveCredits("t1", 3, { feature: "agent_reply", actor: AI_AGENT_ACTOR })).rejects.toMatchObject({ status: 402, code: "ai_quota" });
    creative();
    await flush();
    await expect(reserveCredits("t1", 3, { feature: "agent_reply", actor: AI_AGENT_ACTOR })).resolves.toBeTypeOf("function");
  });

  it("settling the hold charges once: reserved moves to spent, the usage is recorded, and a later release does nothing", async () => {
    const release = await reserveCredits("t1", 4, { feature: "agent_reply", actor: AI_AGENT_ACTOR });
    await release.hold!.settle({ credits: 4, ref: { type: "ai_reply", id: "c1" } });
    release();
    await flush();
    expect(fakeAi.counter("t1", "month")).toEqual({ spent: 4n, reserved: 0n, used: 4n });
    expect(db.usageLedger.create).toHaveBeenCalledTimes(1);
    expect(db.usageLedger.create.mock.calls[0][0].data).toMatchObject({ tenantId: "t1", meter: "ai_credits", amount: 4, refType: "ai_reply", refId: "c1" });
  });

  it("passes the feature and who asked, so stopping spending stops automatic AI but not what a person asked for", async () => {
    fakeAi.freeze("all");
    await expect(reserveCredits("t1", 1, { feature: "agent_reply", actor: AI_AGENT_ACTOR })).rejects.toMatchObject({ code: "spend.frozen" });
    // Creative Studio (the default feature) is something a signed-in person asked for: it keeps working within the AI limit.
    await expect(reserveCredits("t1", 1)).resolves.toBeTypeOf("function");
  });
});

describe("ad accounts the plan does not cover", () => {
  it("names the accounts without a campaign once the limit is used up", async () => {
    subscribed({ adAccountLimit: 1 });
    db.adCampaign.findMany.mockResolvedValue([{ adAccountAssetId: "acc1" }]);
    expect([...(await adAccountsBlockedByPlan("t1", ["acc1", "acc2"]))]).toEqual(["acc2"]);
  });

  it("blocks nothing while there is room, or when the plan has no limit", async () => {
    subscribed({ adAccountLimit: 2 });
    db.adCampaign.findMany.mockResolvedValue([{ adAccountAssetId: "acc1" }]);
    expect((await adAccountsBlockedByPlan("t1", ["acc1", "acc2"])).size).toBe(0);
    subscribed({ adAccountLimit: null });
    expect((await adAccountsBlockedByPlan("t1", ["acc2"])).size).toBe(0);
  });
});

describe("AI credits", () => {
  it("uses the plan allotment when one is set", async () => {
    registerAiAgentSeams({ getMonthlyCreditLimit: async () => 50 });
    db.usageLedger.aggregate.mockResolvedValue({ _sum: { amount: 48 } });
    await expect(assertWithinLimit("t1", "aiCredits", 1)).resolves.toBeUndefined();
    await expect(assertWithinLimit("t1", "aiCredits", 5)).rejects.toMatchObject({ status: 402, message: expect.stringContaining("48 of your 50 AI credits") });
  });

  it("falls back to the platform ceiling and honours AI_DEFAULT_MONTHLY_CREDITS", async () => {
    registerAiAgentSeams({ getMonthlyCreditLimit: async () => null });
    // The platform ceiling is 1,500 credits a month (EDDY-SPEC 12.1a decision 2; it was 200 before Eddy).
    db.usageLedger.aggregate.mockResolvedValue({ _sum: { amount: 1499 } });
    await expect(assertWithinLimit("t1", "aiCredits", 1)).resolves.toBeUndefined();
    await expect(assertWithinLimit("t1", "aiCredits", 2)).rejects.toMatchObject({ status: 402 });
    process.env.AI_DEFAULT_MONTHLY_CREDITS = "10";
    db.usageLedger.aggregate.mockResolvedValue({ _sum: { amount: 10 } });
    await expect(assertWithinLimit("t1", "aiCredits", 1)).rejects.toMatchObject({ status: 402 });
  });

  it("an image costs more than a reply and is checked against the remaining credits", async () => {
    registerAiAgentSeams({ getMonthlyCreditLimit: async () => 10 });
    db.usageLedger.aggregate.mockResolvedValue({ _sum: { amount: 6 } });
    await expect(assertWithinLimit("t1", "aiCredits", 1)).resolves.toBeUndefined();
    await expect(assertWithinLimit("t1", "aiCredits", 5)).rejects.toMatchObject({ status: 402 });
  });

  it("reads this workspace's usage only", async () => {
    registerAiAgentSeams({ getMonthlyCreditLimit: async () => 5 });
    await assertWithinLimit("t1", "aiCredits", 1);
    expect(db.usageLedger.aggregate.mock.calls[0][0].where).toMatchObject({ tenantId: "t1", meter: "ai_credits" });
  });
});

describe("ad accounts", () => {
  it("lets an account that already carries a campaign keep going at the limit", async () => {
    subscribed({ adAccountLimit: 1 });
    db.adCampaign.findMany.mockResolvedValue([{ adAccountAssetId: "acc1" }]);
    await expect(assertAdAccountAllowed("t1", "acc1")).resolves.toBeUndefined();
  });

  it("refuses a second account with a clear 402", async () => {
    subscribed({ adAccountLimit: 1 });
    db.adCampaign.findMany.mockResolvedValue([{ adAccountAssetId: "acc1" }]);
    await expect(assertAdAccountAllowed("t1", "acc2")).rejects.toMatchObject({ status: 402, message: expect.stringContaining("up to 1 ad accounts") });
    expect(db.adCampaign.findMany.mock.calls[0][0].where).toMatchObject({ tenantId: "t1", status: { not: "archived" } });
  });

  it("does nothing when the plan sets no limit", async () => {
    subscribed();
    await assertAdAccountAllowed("t1", "acc9");
    expect(db.adCampaign.findMany).not.toHaveBeenCalled();
  });
});

describe("scheduled posts", () => {
  it("counts posts created this month except canceled ones", async () => {
    subscribed({ scheduledPostLimit: 10 });
    db.scheduledPost.count.mockResolvedValue(10);
    await expect(assertWithinLimit("t1", "scheduledPosts")).rejects.toMatchObject({ status: 402, message: expect.stringContaining("10 scheduled posts per month") });
    const where = db.scheduledPost.count.mock.calls[0][0].where;
    expect(where).toMatchObject({ tenantId: "t1", status: { not: "canceled" } });
    expect(where.createdAt.gte.getUTCDate()).toBe(1);
    db.scheduledPost.count.mockResolvedValue(9);
    await expect(assertWithinLimit("t1", "scheduledPosts")).resolves.toBeUndefined();
  });
});

describe("connected channels", () => {
  it("counts only channels that are new to this workspace", async () => {
    subscribed({ connectedChannelLimit: 2 });
    db.postTarget.findMany.mockResolvedValue([{ assetId: "a1" }, { assetId: "a2" }]);
    await expect(assertChannelsAllowed("t1", ["a1", "a2"])).resolves.toBeUndefined();
    await expect(assertChannelsAllowed("t1", ["a1", "a3"])).rejects.toMatchObject({ status: 402, message: expect.stringContaining("up to 2 connected social channels") });
  });

  it("ignores the post being edited, so swapping a channel is allowed at the limit", async () => {
    subscribed({ connectedChannelLimit: 1 });
    db.postTarget.findMany.mockResolvedValue([]);
    await assertChannelsAllowed("t1", ["a2"], { excludePostId: "post1" });
    expect(db.postTarget.findMany.mock.calls[0][0].where).toMatchObject({ tenantId: "t1", postId: { not: "post1" } });
  });

  it("skips the check when the plan has no limit", async () => {
    subscribed();
    await assertChannelsAllowed("t1", ["a1"]);
    expect(db.postTarget.findMany).not.toHaveBeenCalled();
  });
});

describe("limitFor", () => {
  it("reads the new plan columns, applies the trial plan while trialing, and nothing for exempt workspaces", async () => {
    subscribed({ adAccountLimit: 3, scheduledPostLimit: 40, connectedChannelLimit: 5 });
    expect(await limitFor("t1", "adAccounts")).toBe(3);
    expect(await limitFor("t1", "scheduledPosts")).toBe(40);
    expect(await limitFor("t1", "channels")).toBe(5);
    db.tenant.findUnique.mockResolvedValue({ status: "active", suspendedReason: null, billingExempt: true, trialEndsAt: null, subscription: null });
    expect(await limitFor("t1", "adAccounts")).toBeNull();
  });

  it("resolveLimits says where the limits come from, for the meter and enforcement alike", async () => {
    subscribed({ contactLimit: 500 });
    db.plan.findUnique.mockResolvedValue({ ...NO_LIMITS, contactLimit: 500, name: "Pro" });
    expect(await resolveLimits("t1")).toMatchObject({ from: "plan", planName: "Pro", limits: { contactLimit: 500 } });
    expect((await resolveLimits("t1")).limits).not.toHaveProperty("name");
    db.tenant.findUnique.mockResolvedValue({ status: "active", suspendedReason: null, billingExempt: false, trialEndsAt: new Date(Date.now() + DAY), subscription: null });
    db.plan.findUnique.mockResolvedValue({ ...NO_LIMITS, contactLimit: 50, name: "Free trial" });
    expect(await resolveLimits("t1")).toMatchObject({ from: "trial", planName: "Free trial", limits: { contactLimit: 50 }, status: { state: "trialing" } });
    expect(db.plan.findUnique).toHaveBeenLastCalledWith(expect.objectContaining({ where: { code: "trial" } }));
    db.plan.findUnique.mockResolvedValue(null);
    expect(await resolveLimits("t1")).toMatchObject({ from: null, planName: null, limits: null });
    db.tenant.findUnique.mockResolvedValue({ status: "active", suspendedReason: null, billingExempt: true, trialEndsAt: null, subscription: null });
    expect(await resolveLimits("t1")).toMatchObject({ from: null, limits: null, status: { state: "exempt" } });
  });

  it("a trial whose checkout was opened but never paid keeps the trial allowance, not the chosen plan's", async () => {
    // startSubscription writes the row (status expired, no period, the chosen plan) before the payment window opens.
    db.tenant.findUnique.mockResolvedValue({
      status: "active", suspendedReason: null, billingExempt: false, trialEndsAt: new Date(Date.now() + DAY),
      subscription: { status: "expired", currentPeriodEnd: null, pastDueSince: null, planId: "p_agency", razorpaySubscriptionId: "sub_1", plan: { name: "Agency" } },
    });
    db.plan.findUnique.mockImplementation(async ({ where }: { where: { id?: string; code?: string } }) =>
      where.code === "trial" ? { ...NO_LIMITS, contactLimit: 50, name: "Free trial" } : { ...NO_LIMITS, contactLimit: null, name: "Agency" },
    );
    expect(await resolveLimits("t1")).toMatchObject({ from: "trial", planName: "Free trial", limits: { contactLimit: 50 }, status: { state: "trialing" } });
    expect(db.plan.findUnique).not.toHaveBeenCalledWith(expect.objectContaining({ where: { id: "p_agency" } }));
  });
});

describe("usage lines and alerts", () => {
  it("percentages never exceed 100 and a zero limit counts as full", () => {
    expect(percentUsed(5, 10)).toBe(50);
    expect(percentUsed(15, 10)).toBe(100);
    expect(percentUsed(3, null)).toBeNull();
    expect(percentUsed(0, 0)).toBe(100);
  });

  it("alerts at 80 and 100 percent only", () => {
    expect(alertLevel(79, 100)).toBeNull();
    expect(alertLevel(80, 100)).toBe(80);
    expect(alertLevel(99, 100)).toBe(80);
    expect(alertLevel(100, 100)).toBe(100);
    expect(alertLevel(5, null)).toBeNull();
    expect(alertLevel(0, 0)).toBe(100);
  });

  it("lists every limit and puts the fullest alert first", async () => {
    registerAiAgentSeams({ getMonthlyCreditLimit: async () => 100 });
    subscribed({ seatLimit: 10, adAccountLimit: 1, scheduledPostLimit: 10 });
    db.usageLedger.aggregate.mockResolvedValue({ _sum: { amount: 85 } });
    db.membership.count.mockResolvedValue(2);
    db.invite.count.mockResolvedValue(0);
    db.contact.count.mockResolvedValue(7);
    db.broadcastRecipient.count.mockResolvedValue(0);
    db.adCampaign.findMany.mockResolvedValue([{ adAccountAssetId: "acc1" }]);
    db.scheduledPost.count.mockResolvedValue(3);
    const lines = await usageLines("t1");
    expect(lines.map((l) => l.kind)).toEqual(["seats", "contacts", "broadcastContacts", "aiCredits", "adAccounts", "scheduledPosts", "channels"]);
    expect(lines.find((l) => l.kind === "aiCredits")).toMatchObject({ used: 85, limit: 100, percent: 85, monthly: true });
    expect(lines.find((l) => l.kind === "contacts")).toMatchObject({ limit: null, percent: null });
    expect(alertsFrom(lines).map((a) => [a.kind, a.level])).toEqual([["adAccounts", 100], ["aiCredits", 80]]);
  });

  it("emails the owners once per level and period, and sends only the 100 percent mail when a limit is crossed in one jump", async () => {
    registerAiAgentSeams({ getMonthlyCreditLimit: async () => 100 });
    subscribed();
    db.membership.count.mockResolvedValue(1);
    db.invite.count.mockResolvedValue(0);
    db.contact.count.mockResolvedValue(0);
    db.broadcastRecipient.count.mockResolvedValue(0);
    db.membership.findMany.mockResolvedValue([{ user: { email: "owner@example.com", name: "Owner" } }]);
    const claimed = new Set<string>();
    db.platformSetting.create.mockImplementation(async ({ data }: { data: { key: string } }) => {
      if (claimed.has(data.key)) throw new Error("unique");
      claimed.add(data.key);
      return {};
    });
    db.usageLedger.aggregate.mockResolvedValue({ _sum: { amount: 100 } });
    const now = new Date("2026-11-10T00:00:00Z");
    expect(await sendUsageAlerts("t1", "Acme", now)).toBe(1);
    expect(email.queueEmail).toHaveBeenCalledTimes(1);
    expect(email.queueEmail.mock.calls[0][0]).toMatchObject({ to: "owner@example.com", subject: expect.stringContaining("reached your plan limit") });
    expect([...claimed]).toEqual(expect.arrayContaining(["usage-alert:aiCredits:2026-11:80:t1", "usage-alert:aiCredits:2026-11:100:t1"]));
    // erase-workspace deletes PlatformSetting rows whose key contains the workspace id, so every marker must carry it
    expect([...claimed].every((k) => k.includes("t1"))).toBe(true);
    expect(await sendUsageAlerts("t1", "Acme", now)).toBe(0);
    expect(email.queueEmail).toHaveBeenCalledTimes(1);
    // next month the marker is new again
    expect(await sendUsageAlerts("t1", "Acme", new Date("2026-12-02T00:00:00Z"))).toBe(1);
  });

  it("sends the 80 percent mail first, then the 100 percent mail later", async () => {
    registerAiAgentSeams({ getMonthlyCreditLimit: async () => 100 });
    subscribed();
    db.membership.count.mockResolvedValue(1);
    db.invite.count.mockResolvedValue(0);
    db.contact.count.mockResolvedValue(0);
    db.broadcastRecipient.count.mockResolvedValue(0);
    db.membership.findMany.mockResolvedValue([{ user: { email: "owner@example.com", name: "Owner" } }]);
    const claimed = new Set<string>();
    db.platformSetting.create.mockImplementation(async ({ data }: { data: { key: string } }) => {
      if (claimed.has(data.key)) throw new Error("unique");
      claimed.add(data.key);
      return {};
    });
    db.usageLedger.aggregate.mockResolvedValue({ _sum: { amount: 80 } });
    expect(await sendUsageAlerts("t1", "Acme")).toBe(1);
    expect(email.queueEmail.mock.calls[0][0].subject).toContain("80%");
    db.usageLedger.aggregate.mockResolvedValue({ _sum: { amount: 100 } });
    expect(await sendUsageAlerts("t1", "Acme")).toBe(1);
    expect(email.queueEmail.mock.calls[1][0].subject).toContain("reached");
  });

  function alertSetup(amount: number) {
    registerAiAgentSeams({ getMonthlyCreditLimit: async () => 100 });
    subscribed();
    db.membership.count.mockResolvedValue(1);
    db.invite.count.mockResolvedValue(0);
    db.contact.count.mockResolvedValue(0);
    db.broadcastRecipient.count.mockResolvedValue(0);
    db.usageLedger.aggregate.mockResolvedValue({ _sum: { amount } });
    const claimed = new Set<string>();
    db.platformSetting.create.mockImplementation(async ({ data }: { data: { key: string } }) => {
      if (claimed.has(data.key)) throw new Error("unique");
      claimed.add(data.key);
      return {};
    });
    db.platformSetting.deleteMany.mockImplementation(async ({ where }: { where: { key: { in: string[] } } }) => {
      for (const k of where.key.in) claimed.delete(k);
      return { count: 0 };
    });
    return claimed;
  }

  it("a send that fails, or a workspace with no owner, gives the markers back so the next sweep retries", async () => {
    const claimed = alertSetup(100);
    db.membership.findMany.mockResolvedValue([]);
    expect(await sendUsageAlerts("t1", "Acme")).toBe(0);
    expect(claimed.size).toBe(0);
    db.membership.findMany.mockResolvedValue([{ user: { email: "owner@example.com", name: "Owner" } }]);
    email.queueEmail.mockRejectedValueOnce(new Error("smtp down"));
    expect(await sendUsageAlerts("t1", "Acme")).toBe(0);
    expect(claimed.size).toBe(0);
    expect(await sendUsageAlerts("t1", "Acme")).toBe(1);
    expect(claimed.size).toBe(2);
  });

  it("a total meter that drops back below its level alerts again when it is crossed later", async () => {
    const claimed = alertSetup(0);
    subscribed({ adAccountLimit: 1 });
    db.membership.findMany.mockResolvedValue([{ user: { email: "owner@example.com", name: "Owner" } }]);
    db.adCampaign.findMany.mockResolvedValue([{ adAccountAssetId: "acc1" }]);
    expect(await sendUsageAlerts("t1", "Acme")).toBe(1);
    expect(await sendUsageAlerts("t1", "Acme")).toBe(0);
    db.adCampaign.findMany.mockResolvedValue([]);
    expect(await sendUsageAlerts("t1", "Acme")).toBe(0);
    expect([...claimed].some((k) => k.startsWith("usage-alert:adAccounts"))).toBe(false);
    db.adCampaign.findMany.mockResolvedValue([{ adAccountAssetId: "acc1" }]);
    expect(await sendUsageAlerts("t1", "Acme")).toBe(1);
  });

  it("the sweep remembers where it stopped and survives one workspace failing", async () => {
    db.platformSetting.findUnique.mockResolvedValue(null);
    db.tenant.findMany.mockResolvedValue([{ id: "t1", name: "A" }]);
    db.tenant.findUnique.mockRejectedValue(new Error("boom"));
    registerAiAgentSeams({ getMonthlyCreditLimit: async () => 100 });
    await expect(runUsageAlerts()).resolves.toBe(0);
    expect(db.tenant.findMany.mock.calls[0][0].where).toMatchObject({ status: "active", deletedAt: null });
    expect(db.platformSetting.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { key: "usage-alert:cursor" } }));
  });
});
