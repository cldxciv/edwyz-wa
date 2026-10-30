import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ message: { findFirst: vi.fn(), updateMany: vi.fn() } }));
const enqueue = vi.hoisted(() => vi.fn());
const graphFetch = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({ ok: false }));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/queue", () => ({ enqueue }));
vi.mock("@/lib/tenant-state", () => ({ tenantMayRunBackground: async () => state.ok }));
vi.mock("@/lib/integrations/events", () => ({ emitEvent: vi.fn(async () => undefined) }));
vi.mock("@/lib/graph", () => {
  class GraphError extends Error {}
  return { GraphError, graphFetch };
});
// The spend gate itself is covered by spend-messaging.test.ts and inbox-send.test.ts; here it either lets the send through or holds it.
const gate = vi.hoisted(() => ({
  messagingGate: vi.fn(),
  finishSend: vi.fn(async () => undefined),
  releaseMessageSpend: vi.fn(async () => true),
  open: () => ({ action: "send", origin: "automation", category: "MARKETING", overLimit: false, observed: false, spend: { mode: "none" }, run: (fn: () => Promise<unknown>) => fn() }),
}));
vi.mock("@/lib/spend/messaging/gate", () => ({ messagingGate: gate.messagingGate, finishSend: gate.finishSend, releaseMessageSpend: gate.releaseMessageSpend }));

import { processSendJob } from "@/lib/inbox/send";

const DAY = 86_400_000;
const job = { messageId: "m1", tenantId: "t1", template: { name: "promo", language: "en", components: [] } };
const queued = { id: "m1", type: "template", status: "queued", wamid: null, statusTimeline: [], conversationId: "cv1" };

beforeEach(() => {
  vi.clearAllMocks();
  state.ok = false;
  db.message.findFirst.mockResolvedValue(queued);
  gate.messagingGate.mockImplementation(async () => gate.open());
});

describe("outbound send queue for a suspended, deleted or billing-locked workspace", () => {
  it("sends nothing and sends no message to Meta: the job is put back 15 minutes later with its full payload", async () => {
    const before = Date.now();
    await processSendJob(job);
    expect(graphFetch).not.toHaveBeenCalled();
    expect(db.message.updateMany).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledTimes(1);
    const [queue, payload, opts] = enqueue.mock.calls[0] as [string, Record<string, unknown>, { runAt: Date }];
    expect(queue).toBe("send");
    expect(payload).toMatchObject({ messageId: "m1", tenantId: "t1", template: job.template });
    expect(typeof payload.blockedSince).toBe("string");
    expect(opts.runAt.getTime() - before).toBeGreaterThanOrEqual(15 * 60_000 - 50);
    expect(opts.runAt.getTime() - before).toBeLessThan(15 * 60_000 + 5_000);
  });
  it("keeps the original blockedSince across deferrals", async () => {
    const since = new Date(Date.now() - 3 * DAY).toISOString();
    await processSendJob({ ...job, blockedSince: since });
    expect((enqueue.mock.calls[0][1] as { blockedSince: string }).blockedSince).toBe(since);
  });
  it("after 7 days the message ends as failed with tenant_blocked instead of waiting forever", async () => {
    await processSendJob({ ...job, blockedSince: new Date(Date.now() - 8 * DAY).toISOString() });
    expect(enqueue).not.toHaveBeenCalled();
    expect(graphFetch).not.toHaveBeenCalled();
    expect(db.message.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "m1", tenantId: "t1" }, data: expect.objectContaining({ status: "failed", errorCode: "tenant_blocked" }) }),
    );
  });
  it("free-form text and media are not held for a week: after 24 hours they end as failed with tenant_blocked, templates keep waiting", async () => {
    const stale = new Date(Date.now() - 2 * DAY).toISOString();
    db.message.findFirst.mockResolvedValue({ ...queued, type: "text" });
    await processSendJob({ ...job, blockedSince: stale });
    expect(enqueue).not.toHaveBeenCalled();
    expect(db.message.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "failed", errorCode: "tenant_blocked" }) }));
    db.message.updateMany.mockClear();
    db.message.findFirst.mockResolvedValue({ ...queued, type: "template" });
    await processSendJob({ ...job, blockedSince: stale });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(db.message.updateMany).not.toHaveBeenCalled();
  });
  it("a young text message is still held (not failed)", async () => {
    db.message.findFirst.mockResolvedValue({ ...queued, type: "text" });
    await processSendJob({ ...job, blockedSince: new Date(Date.now() - 3_600_000).toISOString() });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(db.message.updateMany).not.toHaveBeenCalled();
  });
  it("a message that is gone, already sent or no longer queued is dropped, not re-queued every 15 minutes", async () => {
    db.message.findFirst.mockResolvedValue(null);
    await processSendJob(job);
    db.message.findFirst.mockResolvedValue({ ...queued, status: "sent", wamid: "w" });
    await processSendJob(job);
    db.message.findFirst.mockResolvedValue({ ...queued, status: "failed" });
    await processSendJob(job);
    expect(enqueue).not.toHaveBeenCalled();
    expect(db.message.updateMany).not.toHaveBeenCalled();
  });
  it("when the hold cannot be re-queued the error propagates so the queue retries it", async () => {
    enqueue.mockRejectedValueOnce(new Error("db down"));
    await expect(processSendJob(job, { attempt: 1, maxAttempts: 5, isLastAttempt: false })).rejects.toThrow("db down");
    expect(db.message.updateMany).not.toHaveBeenCalled();
  });
  it("on the last attempt a hold that cannot be re-queued fails the message instead of leaving it queued with no job", async () => {
    enqueue.mockRejectedValueOnce(new Error("db down"));
    await processSendJob(job, { attempt: 5, maxAttempts: 5, isLastAttempt: true });
    expect(db.message.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "failed", errorCode: "tenant_blocked" }) }));
  });
  it("does not touch a message that is no longer queued when the cap is reached", async () => {
    db.message.findFirst.mockResolvedValue({ ...queued, status: "sent", wamid: "w" });
    await processSendJob({ ...job, blockedSince: new Date(Date.now() - 8 * DAY).toISOString() });
    expect(db.message.updateMany).not.toHaveBeenCalled();
  });
  it("an unparseable blockedSince restarts the clock instead of failing the message", async () => {
    await processSendJob({ ...job, blockedSince: "garbage" });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(db.message.updateMany).not.toHaveBeenCalled();
  });
  it("sends normally once the workspace is allowed again", async () => {
    state.ok = true;
    db.message.findFirst.mockResolvedValue({
      ...queued,
      type: "template",
      body: "[template] promo",
      mediaUrl: null,
      mediaMime: null,
      conversation: { contact: { phone: "+919876543210" }, phoneNumber: { phoneNumberId: "pn" } },
    });
    graphFetch.mockResolvedValue({ messages: [{ id: "wamid.1" }] });
    await processSendJob({ ...job, blockedSince: new Date(Date.now() - DAY).toISOString() });
    expect(graphFetch).toHaveBeenCalledTimes(1);
    expect(enqueue).not.toHaveBeenCalled();
    expect(db.message.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "sent", wamid: "wamid.1" }) }));
  });
  it("ignores malformed jobs without re-queueing them", async () => {
    await processSendJob({});
    await processSendJob(null);
    expect(enqueue).not.toHaveBeenCalled();
  });
  it("does not ask the spend gate while the workspace is blocked (nothing is reserved for a message that waits)", async () => {
    await processSendJob(job);
    expect(gate.messagingGate).not.toHaveBeenCalled();
  });
  it("a message that still holds an earlier attempt's reservation gives it back when it expires unsent", async () => {
    const spend = { spendState: "reserved", spendDay: new Date("2026-10-20T00:00:00Z"), estCostMinor: 100n, reservationId: null };
    db.message.findFirst.mockResolvedValue({ ...queued, ...spend });
    await processSendJob({ ...job, blockedSince: new Date(Date.now() - 8 * DAY).toISOString() });
    expect(gate.releaseMessageSpend).toHaveBeenCalledWith("t1", { id: "m1", ...spend });
    expect(db.message.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "failed", errorCode: "tenant_blocked", spendState: "released" }) }));
  });
  it("a message with nothing reserved ends without touching the counters", async () => {
    await processSendJob({ ...job, blockedSince: new Date(Date.now() - 8 * DAY).toISOString() });
    expect(gate.releaseMessageSpend).not.toHaveBeenCalled();
    expect(db.message.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.not.objectContaining({ spendState: expect.anything() }) }));
  });
});

describe("holds from the spend gate reuse the same queue mechanics", () => {
  const ready = { ...queued, body: "[template] promo", mediaUrl: null, mediaMime: null, conversation: { contact: { phone: "+919876543210" }, phoneNumber: { phoneNumberId: "pn" } } };
  beforeEach(() => {
    state.ok = true;
    db.message.findFirst.mockResolvedValue(ready);
  });

  it("re-queues at the gate's retry time when that is sooner than 15 minutes, with the reason on the job", async () => {
    const retryAt = new Date(Date.now() + 5 * 60_000);
    gate.messagingGate.mockResolvedValue({ action: "hold", reason: "messaging_limit", retryAt });
    await processSendJob(job);
    expect(graphFetch).not.toHaveBeenCalled();
    const [queue, payload, opts] = enqueue.mock.calls[0] as [string, Record<string, unknown>, { runAt: Date }];
    expect(queue).toBe("send");
    expect(payload).toMatchObject({ messageId: "m1", tenantId: "t1", heldReason: "messaging_limit", template: job.template });
    expect(opts.runAt.getTime()).toBe(retryAt.getTime());
    expect(db.message.updateMany).not.toHaveBeenCalled();
  });

  it("never waits longer than 15 minutes between checks, so a raised limit or a lifted stop releases the message soon", async () => {
    const before = Date.now();
    gate.messagingGate.mockResolvedValue({ action: "hold", reason: "spending_stopped", retryAt: new Date(before + 30 * DAY) });
    await processSendJob(job);
    const opts = enqueue.mock.calls[0][2] as { runAt: Date };
    expect(opts.runAt.getTime() - before).toBeLessThanOrEqual(15 * 60_000 + 50);
  });

  it("a template held for 7 days ends as failed with the gate's reason", async () => {
    gate.messagingGate.mockResolvedValue({ action: "hold", reason: "number_quality", retryAt: new Date() });
    await processSendJob({ ...job, blockedSince: new Date(Date.now() - 8 * DAY).toISOString() });
    expect(enqueue).not.toHaveBeenCalled();
    expect(db.message.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "failed", errorCode: "number_quality" }) }));
  });

  it("a refusal from the gate fails the message with its code and sends nothing", async () => {
    gate.messagingGate.mockResolvedValue({ action: "fail", code: "template_blocked", handoff: false, period: null });
    await processSendJob(job);
    expect(graphFetch).not.toHaveBeenCalled();
    expect(db.message.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "failed", errorCode: "template_blocked" }) }));
  });

  it("settles the gate's reservation after an accepted send", async () => {
    graphFetch.mockResolvedValue({ messages: [{ id: "wamid.2" }] });
    await processSendJob(job);
    expect(db.message.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "sent", wamid: "wamid.2", spendState: "settled" }) }));
    expect(gate.finishSend).toHaveBeenCalledWith({ mode: "none" }, "sent");
  });
});
