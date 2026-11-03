import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  contact: { findMany: vi.fn(), count: vi.fn() },
  template: { findFirst: vi.fn() },
  phoneNumber: { findFirst: vi.fn() },
  broadcast: { create: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  platformSetting: { upsert: vi.fn(), deleteMany: vi.fn() },
  broadcastRecipient: { createMany: vi.fn(), count: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  message: { findMany: vi.fn(), findFirst: vi.fn() },
  tenant: { findUnique: vi.fn() },
}));
const queue = vi.hoisted(() => ({ enqueue: vi.fn(), runDueJobs: vi.fn() }));
const inbox = vi.hoisted(() => ({ sendTemplateMessage: vi.fn() }));
const tenant = vi.hoisted(() => ({ ok: true, canWrite: true }));
const auditMock = vi.hoisted(() => vi.fn(async () => {}));
const portfolio = vi.hoisted(() => ({ used: 0, oldest: null as Date | null, tier: null as string | null }));

vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/queue", () => queue);
vi.mock("@/lib/tenant-state", () => ({ tenantMayRunBackground: async () => tenant.ok }));
vi.mock("@/lib/auth/audit", () => ({ audit: auditMock }));
vi.mock("@/lib/inbox/service", () => inbox);
vi.mock("@/lib/billing", () => ({ assertWithinLimit: async () => undefined, getBillingStatus: async () => ({ canWrite: tenant.canWrite }) }));
vi.mock("@/lib/integrations/events", () => ({ emitEvent: async () => undefined }));
vi.mock("@/lib/broadcasts/portfolio", async () => {
  const { portfolioLimit } = await import("@/lib/broadcasts/throttle");
  return { portfolioUsage: async () => ({ limit: portfolioLimit([portfolio.tier]), used: portfolio.used, oldest: portfolio.oldest, phones: [] }) };
});

import { audienceWhere, freezeAudience } from "@/lib/broadcasts/audience";
import { RATE_CARD, estimateCost } from "@/lib/broadcasts/cost";
import { processBroadcast } from "@/lib/broadcasts/process";
import { createBroadcast, startBroadcast } from "@/lib/broadcasts/service";
import { allowedNow, tierLimit } from "@/lib/broadcasts/throttle";

const actor = { userId: "u1", tenantId: "t1", role: "admin" as const };
const now = new Date("2026-03-01T12:00:00Z");

describe("estimateCost", () => {
  it("ships with an empty rate card and reports not configured", () => {
    expect(RATE_CARD).toEqual({});
    expect(estimateCost({ category: "MARKETING", country: "IN", count: 100 })).toEqual({ configured: false });
  });
  it("computes when a rate is supplied", () => {
    const rateCard = { IN: { MARKETING: 100 } };
    expect(estimateCost({ category: "MARKETING", country: "in", count: 3, rateCard })).toEqual({
      configured: true,
      perMessagePaise: 100,
      totalPaise: 300,
      currency: "INR",
    });
    expect(estimateCost({ category: "UTILITY", country: "IN", count: 3, rateCard })).toEqual({ configured: false });
  });
});

describe("throttle", () => {
  it.each([
    ["TIER_250", 250],
    ["TIER_1K", 1000],
    ["TIER_10K", 10000],
    ["TIER_100K", 100000],
    ["UNLIMITED", Infinity],
    ["WHATEVER", 250],
    [null, 250],
    [undefined, 250],
  ])("tier %s -> %s", (tier, limit) => {
    expect(tierLimit(tier as string | null)).toBe(limit);
  });
  it("computes how many may be sent now", () => {
    expect(allowedNow({ tier: "TIER_250", sentLast24h: 0, batchSize: 20 })).toBe(20);
    expect(allowedNow({ tier: "TIER_250", sentLast24h: 245, batchSize: 20 })).toBe(5);
    expect(allowedNow({ tier: "TIER_250", sentLast24h: 300, batchSize: 20 })).toBe(0);
    expect(allowedNow({ tier: "TIER_1K", sentLast24h: 900, batchSize: 500 })).toBe(100);
    expect(allowedNow({ tier: "UNLIMITED", sentLast24h: 1e6, batchSize: 20 })).toBe(20);
    expect(allowedNow({ tier: null, sentLast24h: 250, batchSize: 20 })).toBe(0);
  });
});

describe("audience", () => {
  beforeEach(() => vi.resetAllMocks());

  const notBlocked = { conversations: { none: { status: "blocked" } } };
  it("selects opted-in, not opted-out, not blocked contacts matching ANY tag", () => {
    expect(audienceWhere("t1", ["a", "b"])).toEqual({ tenantId: "t1", optIn: true, optedOutAt: null, ...notBlocked, tags: { hasSome: ["a", "b"] } });
  });
  it("empty tags means all opted-in contacts that nobody blocked", () => {
    expect(audienceWhere("t1", [])).toEqual({ tenantId: "t1", optIn: true, optedOutAt: null, ...notBlocked });
    // The opt-out filter is the marketing one unless the template's kind is passed (lib/contacts/opt-out.ts).
    expect(audienceWhere("t1", [], "utility")).toEqual({ tenantId: "t1", optIn: true, ...notBlocked });
  });
  it("counting and freezing never include a blocked contact", async () => {
    db.contact.count.mockResolvedValue(3);
    db.contact.findMany.mockResolvedValue([{ id: "c1" }]);
    db.broadcastRecipient.count.mockResolvedValue(1);
    await freezeAudience("t1", "b1", []);
    expect(db.contact.findMany.mock.calls[0][0].where).toMatchObject(notBlocked);
  });
  it("freezes the audience into recipient rows", async () => {
    db.contact.findMany.mockResolvedValue([{ id: "c1" }, { id: "c2" }]);
    db.broadcastRecipient.count.mockResolvedValue(2);
    expect(await freezeAudience("t1", "b1", ["a"])).toBe(2);
    expect(db.broadcastRecipient.createMany).toHaveBeenCalledWith({
      data: [
        { tenantId: "t1", broadcastId: "b1", contactId: "c1" },
        { tenantId: "t1", broadcastId: "b1", contactId: "c2" },
      ],
      skipDuplicates: true,
    });
  });
  it("start freezes once and enqueues; later contact changes do not affect recipients", async () => {
    db.broadcast.findFirst.mockResolvedValue({
      id: "b1",
      status: "draft",
      segmentTags: [],
      scheduledAt: null,
      startedAt: null,
      template: { status: "approved", category: "MARKETING" },
    });
    db.contact.findMany.mockResolvedValue([{ id: "c1" }]);
    db.broadcastRecipient.count.mockResolvedValue(1);
    db.broadcast.update.mockResolvedValue({ id: "b1", status: "sending" });
    await startBroadcast(actor, "b1");
    expect(db.broadcastRecipient.createMany).toHaveBeenCalledTimes(1);
    expect(queue.enqueue).toHaveBeenCalledWith("broadcast", { broadcastId: "b1" }, expect.anything());
    expect(db.broadcast.update.mock.calls[0][0].data.estimatedCostPaise).toBeNull();
  });
});

describe("createBroadcast tenant isolation", () => {
  beforeEach(() => vi.resetAllMocks());
  const input = { name: "n", phoneNumberId: "p1", templateId: "tpl1" };

  it("rejects another tenant's template or phone number", async () => {
    db.template.findFirst.mockResolvedValue(null);
    db.phoneNumber.findFirst.mockResolvedValue({ id: "p1", wabaRefId: "w1" });
    await expect(createBroadcast(actor, input)).rejects.toMatchObject({ status: 404 });
    expect(db.template.findFirst.mock.calls[0][0].where).toEqual({ id: "tpl1", tenantId: "t1" });

    db.template.findFirst.mockResolvedValue({ id: "tpl1", status: "approved", wabaRefId: "w1", components: [] });
    db.phoneNumber.findFirst.mockResolvedValue(null);
    await expect(createBroadcast(actor, input)).rejects.toMatchObject({ status: 404 });
    expect(db.phoneNumber.findFirst.mock.calls[1][0].where).toEqual({ id: "p1", tenantId: "t1" });
    expect(db.broadcast.create).not.toHaveBeenCalled();
  });

  it("requires an approved template", async () => {
    db.template.findFirst.mockResolvedValue({ id: "tpl1", status: "pending", wabaRefId: "w1", components: [] });
    db.phoneNumber.findFirst.mockResolvedValue({ id: "p1", wabaRefId: "w1" });
    await expect(createBroadcast(actor, input)).rejects.toMatchObject({ status: 400 });
  });
});

describe("processBroadcast", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    tenant.ok = true;
  });

  const broadcast = (over: Record<string, unknown> = {}, phone: Record<string, unknown> = {}) => {
    portfolio.tier = "messagingLimitTier" in phone ? (phone.messagingLimitTier as string | null) : "TIER_1K";
    return base(over, phone);
  };
  const base = (over: Record<string, unknown> = {}, phone: Record<string, unknown> = {}) => ({
    id: "b1",
    tenantId: "t1",
    phoneNumberId: "p1",
    status: "sending",
    scheduledAt: null,
    startedAt: now,
    template: { name: "promo", language: "en", components: [{ type: "BODY", text: "Hello" }] },
    phoneNumber: { qualityRating: "GREEN", messagingLimitTier: "TIER_1K", wabaRefId: "w1", ...phone },
    ...over,
  });
  const recipient = (id: string, contact: Record<string, unknown> = {}) => ({
    id: `r${id}`,
    contact: { id: `c${id}`, name: "A", attributes: {}, optIn: true, optedOutAt: null, ...contact },
  });

  function setup(opts: {
    sent?: number;
    oldest?: Date | null;
    pending: ReturnType<typeof recipient>[];
    remaining?: number;
    inFlight?: number;
    queuedRecipients?: { id: string; messageId: string }[];
  }) {
    portfolio.used = (opts.sent ?? 0) + (opts.inFlight ?? 0);
    portfolio.oldest = opts.oldest ?? null;
    db.broadcastRecipient.count.mockImplementation(async ({ where }: any) => {
      if (where.status === "pending") return opts.remaining ?? 0;
      if (where.status === "queued") return opts.inFlight ?? 0;
      return opts.sent ?? 0;
    });
    db.broadcastRecipient.findFirst.mockResolvedValue(opts.oldest ? { sentAt: opts.oldest } : null);
    db.broadcastRecipient.findMany.mockImplementation(async ({ where }: any) => (where.status === "queued" ? (opts.queuedRecipients ?? []) : opts.pending));
    db.broadcastRecipient.updateMany.mockResolvedValue({ count: 1 });
    db.broadcastRecipient.update.mockResolvedValue({});
    db.message.findMany.mockResolvedValue([]);
    inbox.sendTemplateMessage.mockResolvedValue({ id: "m1", wamid: null, status: "queued" });
  }

  it("queues a batch via the inbox service, stores messageId and never marks sent without a wamid", async () => {
    db.broadcast.findUnique.mockResolvedValue(broadcast());
    setup({ pending: [recipient("1"), recipient("2")], inFlight: 2 });
    await processBroadcast("b1", now);
    expect(inbox.sendTemplateMessage).toHaveBeenCalledTimes(2);
    expect(inbox.sendTemplateMessage).toHaveBeenCalledWith({
      tenantId: "t1",
      phoneNumberId: "p1",
      contactId: "c1",
      templateName: "promo",
      language: "en",
      components: [],
      origin: "broadcast",
    });
    expect(db.broadcastRecipient.update.mock.calls[0][0].data).toEqual({ messageId: "m1" });
    for (const call of db.broadcastRecipient.update.mock.calls) expect(call[0].data.status).not.toBe("sent");
    expect(db.broadcast.update).not.toHaveBeenCalled();
    expect(queue.enqueue).toHaveBeenCalledWith("broadcast", { broadcastId: "b1" }, { runAt: new Date(now.getTime() + 30_000) });
  });

  it("completes once nothing is pending and every queued message has settled", async () => {
    db.broadcast.findUnique.mockResolvedValue(broadcast());
    setup({ pending: [recipient("1")], inFlight: 0 });
    await processBroadcast("b1", now);
    expect(db.broadcast.update.mock.calls.at(-1)![0].data.status).toBe("completed");
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it("reconcile copies sent and failed outcomes from messages, only for queued recipients with a wamid when sent", async () => {
    db.broadcast.findUnique.mockResolvedValue(broadcast());
    setup({
      pending: [],
      queuedRecipients: [
        { id: "r1", messageId: "m1" },
        { id: "r2", messageId: "m2" },
        { id: "r3", messageId: "m3" },
        { id: "r4", messageId: "m4" },
      ],
    });
    db.message.findMany.mockResolvedValue([
      { id: "m1", status: "sent", wamid: "w1", errorCode: null, statusTimeline: [{ status: "sent", at: "2026-03-01T11:59:00Z" }] },
      { id: "m2", status: "failed", wamid: null, errorCode: "131026", statusTimeline: [] },
      { id: "m3", status: "queued", wamid: null, errorCode: null, statusTimeline: [] },
      { id: "m4", status: "sent", wamid: null, errorCode: null, statusTimeline: [] },
    ]);
    await processBroadcast("b1", now);
    const writes = db.broadcastRecipient.updateMany.mock.calls.map((c: any) => c[0]).filter((c: any) => c.where.status === "queued" && c.data.status);
    expect(writes).toHaveLength(2);
    expect(writes[0]).toMatchObject({ where: { id: "r1", tenantId: "t1" }, data: { status: "sent", wamid: "w1", sentAt: new Date("2026-03-01T11:59:00Z") } });
    expect(writes[1].data).toMatchObject({ status: "failed", errorCode: "131026" });
    expect(db.message.findMany.mock.calls[0][0].where.tenantId).toBe("t1");
  });

  it("counts in-flight queued sends against the tier quota", async () => {
    db.broadcast.findUnique.mockResolvedValue(broadcast({}, { messagingLimitTier: "TIER_250" }));
    setup({ sent: 100, inFlight: 150, pending: [], remaining: 5 });
    await processBroadcast("b1", now);
    expect(inbox.sendTemplateMessage).not.toHaveBeenCalled();
    expect(queue.enqueue).toHaveBeenCalled();
  });

  it("re-enqueues itself when more recipients remain", async () => {
    db.broadcast.findUnique.mockResolvedValue(broadcast());
    setup({ pending: [recipient("1")], remaining: 5 });
    await processBroadcast("b1", now);
    expect(queue.enqueue).toHaveBeenCalledWith("broadcast", { broadcastId: "b1" }, { runAt: now });
  });

  it("re-enqueues with a later runAt when the tier quota is used up", async () => {
    db.broadcast.findUnique.mockResolvedValue(broadcast({}, { messagingLimitTier: "TIER_250" }));
    const oldest = new Date("2026-03-01T03:00:00Z");
    setup({ sent: 250, oldest, pending: [], remaining: 40 });
    await processBroadcast("b1", now);
    expect(inbox.sendTemplateMessage).not.toHaveBeenCalled();
    expect(queue.enqueue).toHaveBeenCalledWith("broadcast", { broadcastId: "b1" }, { runAt: new Date("2026-03-02T03:00:00Z") });
  });

  it("treats a missing tier as the lowest tier", async () => {
    db.broadcast.findUnique.mockResolvedValue(broadcast({}, { messagingLimitTier: null }));
    setup({ sent: 250, pending: [], remaining: 1 });
    await processBroadcast("b1", now);
    expect(inbox.sendTemplateMessage).not.toHaveBeenCalled();
    expect(queue.enqueue).toHaveBeenCalled();
  });

  it("skips contacts who opted out after the audience was frozen", async () => {
    db.broadcast.findUnique.mockResolvedValue(broadcast());
    setup({ pending: [recipient("1", { optedOutAt: new Date() }), recipient("2")] });
    await processBroadcast("b1", now);
    expect(inbox.sendTemplateMessage).toHaveBeenCalledTimes(1);
    expect(db.broadcastRecipient.update.mock.calls[0][0].data).toEqual({ status: "skipped" });
  });

  it("an opt-out skips a marketing broadcast (or one whose category is unknown) but not a utility one; a broadcast still needs an opt-in", async () => {
    db.broadcast.findUnique.mockResolvedValue(broadcast({ template: { name: "promo", language: "en", category: "MARKETING", components: [{ type: "BODY", text: "Hello" }] } }));
    setup({ pending: [recipient("1", { optedOutAt: new Date() })] });
    await processBroadcast("b1", now);
    expect(inbox.sendTemplateMessage).not.toHaveBeenCalled();

    db.broadcast.findUnique.mockResolvedValue(broadcast({ template: { name: "notice", language: "en", category: "UTILITY", components: [{ type: "BODY", text: "Hello" }] } }));
    setup({ pending: [recipient("2", { optedOutAt: new Date() }), recipient("3", { optIn: false, optedOutAt: new Date() })] });
    await processBroadcast("b1", now);
    expect(inbox.sendTemplateMessage).toHaveBeenCalledTimes(1);
    expect(inbox.sendTemplateMessage.mock.calls[0][0]).toMatchObject({ contactId: "c2" });
  });

  it("syncRecipientFromMessage is tenant-scoped through the recipient and ignores unsettled messages", async () => {
    const { syncRecipientFromMessage, recipientUpdateFromMessage } = await import("@/lib/broadcasts/process");
    db.broadcastRecipient.findUnique.mockResolvedValue({ id: "r1", tenantId: "t1", status: "queued" });
    db.message.findFirst.mockResolvedValue({ status: "sent", wamid: "w9", errorCode: null, statusTimeline: [] });
    db.broadcastRecipient.updateMany.mockResolvedValue({ count: 1 });
    expect(await syncRecipientFromMessage("m1")).toBe(true);
    expect(db.message.findFirst.mock.calls[0][0].where).toEqual({ id: "m1", tenantId: "t1" });
    db.message.findFirst.mockResolvedValue({ status: "sent", wamid: null, errorCode: null, statusTimeline: [] });
    expect(await syncRecipientFromMessage("m1")).toBe(false);
    db.broadcastRecipient.findUnique.mockResolvedValue({ id: "r1", tenantId: "t1", status: "sent" });
    expect(await syncRecipientFromMessage("m1")).toBe(false);
    expect(recipientUpdateFromMessage({ status: "read", wamid: "w", errorCode: null, statusTimeline: [] })).toMatchObject({ status: "read", wamid: "w" });
    expect(recipientUpdateFromMessage({ status: "queued", wamid: null, errorCode: null, statusTimeline: [] })).toBeNull();
  });

  it("pauses when the number's quality is RED or LOW", async () => {
    for (const rating of ["RED", "LOW"]) {
      vi.resetAllMocks();
      db.broadcast.findUnique.mockResolvedValue(broadcast({}, { qualityRating: rating }));
      setup({ pending: [recipient("1")] });
      await processBroadcast("b1", now);
      expect(db.broadcast.update).toHaveBeenCalledWith({ where: { id: "b1", tenantId: "t1" }, data: { status: "paused" } });
      expect(inbox.sendTemplateMessage).not.toHaveBeenCalled();
    }
  });

  it("does nothing for a paused broadcast", async () => {
    db.broadcast.findUnique.mockResolvedValue(broadcast({ status: "paused" }));
    setup({ pending: [recipient("1")] });
    await processBroadcast("b1", now);
    expect(inbox.sendTemplateMessage).not.toHaveBeenCalled();
  });

  it("skips a recipient whose variable is missing and fails one whose send throws", async () => {
    db.broadcast.findUnique.mockResolvedValue(
      broadcast({ template: { name: "t", language: "en", components: [{ type: "BODY", text: "Hi {{1}} {{2}}" }] } }),
    );
    setup({ pending: [recipient("1")] });
    await processBroadcast("b1", now);
    expect(db.broadcastRecipient.update.mock.calls[0][0].data).toMatchObject({ status: "skipped", errorCode: "missing_variable" });

    vi.resetAllMocks();
    db.broadcast.findUnique.mockResolvedValue(broadcast());
    setup({ pending: [recipient("1")] });
    inbox.sendTemplateMessage.mockRejectedValue(Object.assign(new Error("boom"), { code: 131026 }));
    await processBroadcast("b1", now);
    expect(db.broadcastRecipient.update.mock.calls[0][0].data).toMatchObject({ status: "failed", errorCode: "131026" });
  });

  describe("workspace suspended, deleted or billing-locked", () => {
    beforeEach(() => {
      tenant.ok = false;
      // tenantMayRunBackground said no; a fresh read confirms the workspace really is suspended (an unconfirmed no is tested below).
      db.tenant.findUnique.mockResolvedValue({ status: "suspended", deletedAt: null });
      db.broadcast.updateMany.mockResolvedValue({ count: 1 });
      db.platformSetting.upsert.mockResolvedValue({});
    });
    describe("a no that cannot be confirmed (the state read failed) never pauses anything", () => {
      beforeEach(() => {
        db.tenant.findUnique.mockRejectedValue(new Error("db blip"));
      });
      it("processBroadcast requeues 30 seconds later: no pause, no reason, no audit row, no send", async () => {
        db.broadcast.findUnique.mockResolvedValue(broadcast());
        setup({ pending: [recipient("1")] });
        await processBroadcast("b1", now);
        expect(db.broadcast.updateMany).not.toHaveBeenCalled();
        expect(db.platformSetting.upsert).not.toHaveBeenCalled();
        expect(auditMock).not.toHaveBeenCalled();
        expect(inbox.sendTemplateMessage).not.toHaveBeenCalled();
        expect(queue.enqueue).toHaveBeenCalledWith("broadcast", { broadcastId: "b1" }, { runAt: new Date(now.getTime() + 30_000) });
      });
      it("a due scheduled broadcast stays scheduled", async () => {
        db.broadcast.findUnique.mockResolvedValue(broadcast({ status: "scheduled", scheduledAt: new Date(now.getTime() - 1000), startedAt: null }));
        setup({ pending: [recipient("1")] });
        await processBroadcast("b1", now);
        expect(db.broadcast.update).not.toHaveBeenCalled();
        expect(db.broadcast.updateMany).not.toHaveBeenCalled();
        expect(queue.enqueue).toHaveBeenCalledWith("broadcast", { broadcastId: "b1" }, { runAt: new Date(now.getTime() + 30_000) });
      });
      it("sendOne answers retry and touches nothing", async () => {
        const { sendOne } = await import("@/lib/broadcasts/process");
        setup({ pending: [] });
        expect(await sendOne(broadcast() as Parameters<typeof sendOne>[0], recipient("1"))).toBe("retry");
        expect(db.broadcastRecipient.updateMany).not.toHaveBeenCalled();
        expect(inbox.sendTemplateMessage).not.toHaveBeenCalled();
      });
      it("a gate that flips to unknown in the middle of a batch requeues instead of pausing", async () => {
        db.broadcast.findUnique.mockResolvedValue(broadcast());
        setup({ pending: [recipient("1"), recipient("2")], remaining: 2 });
        tenant.ok = true;
        inbox.sendTemplateMessage.mockImplementation(async () => {
          tenant.ok = false;
          return { id: "m1" };
        });
        await processBroadcast("b1", now);
        expect(inbox.sendTemplateMessage).toHaveBeenCalledTimes(1);
        expect(db.broadcast.updateMany).not.toHaveBeenCalled();
        expect(queue.enqueue).toHaveBeenCalledWith("broadcast", { broadcastId: "b1" }, { runAt: new Date(now.getTime() + 30_000) });
      });
      it("a workspace that has just recovered (fresh read says usable) is also only requeued", async () => {
        db.tenant.findUnique.mockResolvedValue({ status: "active", deletedAt: null });
        db.broadcast.findUnique.mockResolvedValue(broadcast());
        setup({ pending: [recipient("1")] });
        await processBroadcast("b1", now);
        expect(db.broadcast.updateMany).not.toHaveBeenCalled();
        expect(queue.enqueue).toHaveBeenCalledWith("broadcast", { broadcastId: "b1" }, { runAt: new Date(now.getTime() + 30_000) });
      });
    });
    it("sends nothing, leaves every recipient untouched and pauses the broadcast with a stored reason", async () => {
      db.broadcast.findUnique.mockResolvedValue(broadcast());
      setup({ pending: [recipient("1"), recipient("2")] });
      await processBroadcast("b1", now);
      expect(inbox.sendTemplateMessage).not.toHaveBeenCalled();
      expect(db.broadcastRecipient.updateMany).not.toHaveBeenCalled();
      expect(db.broadcastRecipient.update).not.toHaveBeenCalled();
      expect(db.broadcast.updateMany).toHaveBeenCalledWith({ where: { id: "b1", tenantId: "t1", status: { in: ["scheduled", "sending"] } }, data: { status: "paused" } });
      expect(db.platformSetting.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ where: { key: "broadcast.pause_reason.b1" }, create: expect.objectContaining({ value: expect.objectContaining({ reason: "tenant_blocked" }) }) }),
      );
      expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "t1", action: "broadcast.paused_tenant_blocked", target: "b1" }));
      expect(queue.enqueue).not.toHaveBeenCalled();
    });
    it("a billing-locked (not suspended) workspace is confirmed blocked too", async () => {
      db.tenant.findUnique.mockResolvedValue({ status: "active", deletedAt: null });
      tenant.canWrite = false;
      db.broadcast.findUnique.mockResolvedValue(broadcast());
      setup({ pending: [recipient("1")] });
      await processBroadcast("b1", now);
      tenant.canWrite = true;
      expect(db.broadcast.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "paused" } }));
      expect(inbox.sendTemplateMessage).not.toHaveBeenCalled();
    });
    it("a due scheduled broadcast is paused instead of starting to send", async () => {
      db.broadcast.findUnique.mockResolvedValue(broadcast({ status: "scheduled", scheduledAt: new Date(now.getTime() - 1000), startedAt: null }));
      setup({ pending: [recipient("1")] });
      await processBroadcast("b1", now);
      expect(db.broadcast.update).not.toHaveBeenCalled();
      expect(db.broadcast.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "paused" } }));
      expect(inbox.sendTemplateMessage).not.toHaveBeenCalled();
    });
    it("is idempotent: a broadcast that is already paused is not paused or audited again", async () => {
      db.broadcast.findUnique.mockResolvedValue(broadcast());
      setup({ pending: [recipient("1")] });
      db.broadcast.updateMany.mockResolvedValue({ count: 0 });
      await processBroadcast("b1", now);
      expect(db.platformSetting.upsert).not.toHaveBeenCalled();
      expect(auditMock).not.toHaveBeenCalled();
    });
    it("sendOne refuses to claim or send for a blocked workspace", async () => {
      const { sendOne } = await import("@/lib/broadcasts/process");
      setup({ pending: [] });
      const b = broadcast() as Parameters<typeof sendOne>[0];
      expect(await sendOne(b, recipient("1"))).toBe("blocked");
      expect(db.broadcastRecipient.updateMany).not.toHaveBeenCalled();
      expect(inbox.sendTemplateMessage).not.toHaveBeenCalled();
    });
    it("a workspace blocked in the middle of a batch stops after the recipient being processed and pauses", async () => {
      db.broadcast.findUnique.mockResolvedValue(broadcast());
      setup({ pending: [recipient("1"), recipient("2"), recipient("3")], remaining: 3 });
      tenant.ok = true;
      let calls = 0;
      inbox.sendTemplateMessage.mockImplementation(async () => {
        if (++calls === 1) tenant.ok = false;
        return { id: "m1" };
      });
      await processBroadcast("b1", now);
      expect(inbox.sendTemplateMessage).toHaveBeenCalledTimes(1);
      expect(db.broadcast.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "paused" } }));
    });
    it("runBroadcastQueue goes through the same gate", async () => {
      const { runBroadcastQueue } = await import("@/lib/broadcasts/process");
      db.broadcast.findUnique.mockResolvedValue(broadcast());
      setup({ pending: [recipient("1")] });
      queue.runDueJobs.mockImplementation(async (_q: string, handler: (p: unknown) => Promise<void>) => {
        await handler({ broadcastId: "b1" });
        return 1;
      });
      expect(await runBroadcastQueue()).toBe(1);
      expect(inbox.sendTemplateMessage).not.toHaveBeenCalled();
      expect(db.broadcast.updateMany).toHaveBeenCalled();
    });
    it("stays resumable: the normal start action takes a paused broadcast back to sending and clears the reason", async () => {
      tenant.ok = true;
      db.broadcast.findFirst.mockResolvedValue({ id: "b1", tenantId: "t1", status: "paused", scheduledAt: null, startedAt: now, segmentTags: [], template: { status: "approved", category: "MARKETING" } });
      db.contact.findMany.mockResolvedValue([{ id: "c1" }]);
      db.broadcastRecipient.count.mockResolvedValue(3);
      db.broadcast.update.mockResolvedValue({ id: "b1", status: "sending" });
      db.platformSetting.deleteMany.mockResolvedValue({ count: 1 });
      await startBroadcast(actor, "b1");
      expect(db.broadcast.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "sending" }) }));
      expect(db.platformSetting.deleteMany).toHaveBeenCalledWith({ where: { key: "broadcast.pause_reason.b1" } });
      expect(queue.enqueue).toHaveBeenCalledWith("broadcast", { broadcastId: "b1" }, expect.anything());
    });
  });
});
