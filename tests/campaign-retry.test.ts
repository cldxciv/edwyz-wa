import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  broadcast: { findUnique: vi.fn(), update: vi.fn() },
  broadcastRecipient: { count: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  message: { findMany: vi.fn() },
}));
const queue = vi.hoisted(() => ({ enqueue: vi.fn(), runDueJobs: vi.fn() }));
const inbox = vi.hoisted(() => ({ sendTemplateMessage: vi.fn() }));

vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/queue", () => queue);
// processBroadcast now gates on the workspace state; the blocked behaviour is covered in broadcasts.test.ts.
vi.mock("@/lib/tenant-state", () => ({ tenantMayRunBackground: async () => true }));
vi.mock("@/lib/inbox/service", () => inbox);
vi.mock("@/lib/billing", () => ({ assertWithinLimit: async () => undefined }));
vi.mock("@/lib/integrations/events", () => ({ emitEvent: async () => undefined }));
// The portfolio-wide 24 hour usage is covered in campaign-limits.test.ts; here the portfolio always has room.
vi.mock("@/lib/broadcasts/portfolio", () => ({ portfolioUsage: async () => ({ limit: 1000, used: 0, oldest: null, phones: [] }) }));

import { LATE_FAILURE_GRACE_MS, processBroadcast, recipientUpdateFromMessage, requeueDueRetries } from "@/lib/broadcasts/process";
import { failedRecipientData, isRetryableCode, planRetry, retryWindowEnd, retryWindowOpen } from "@/lib/broadcasts/retry";

const DAY = 24 * 60 * 60 * 1000;
const start = new Date("2026-03-01T00:00:00Z");
const now = new Date("2026-03-01T12:00:00Z");

describe("retry planning", () => {
  it("only the per-user marketing cap code is retryable", () => {
    expect(isRetryableCode("131049")).toBe(true);
    for (const c of ["130472", "131026", "131048", "send_failed", "", null, undefined]) expect(isRetryableCode(c as string)).toBe(false);
  });

  it("schedules the next day and counts the attempt", () => {
    const plan = planRetry({ errorCode: "131049", attempts: 0, retryDays: 3, startedAt: start, now });
    expect(plan).toEqual({ attempts: 1, retryAfter: new Date(now.getTime() + DAY) });
  });

  it("stops when attempts exceed retryDays", () => {
    expect(planRetry({ errorCode: "131049", attempts: 2, retryDays: 3, startedAt: start, now })?.retryAfter).toBeInstanceOf(Date);
    expect(planRetry({ errorCode: "131049", attempts: 3, retryDays: 3, startedAt: start, now })).toEqual({ attempts: 4, retryAfter: null });
  });

  it("stops at the end of the window", () => {
    const late = new Date(start.getTime() + 2.5 * DAY);
    expect(planRetry({ errorCode: "131049", attempts: 0, retryDays: 3, startedAt: start, now: late })?.retryAfter).toBeNull();
    expect(retryWindowEnd(start, 3)).toEqual(new Date(start.getTime() + 3 * DAY));
    expect(retryWindowOpen(start, 3, new Date(start.getTime() + 3 * DAY + 1))).toBe(false);
    expect(retryWindowOpen(start, 0, now)).toBe(false);
  });

  it("never plans for other errors or when retries are off", () => {
    expect(planRetry({ errorCode: "131026", attempts: 0, retryDays: 3, startedAt: start, now })).toBeNull();
    expect(planRetry({ errorCode: "131049", attempts: 0, retryDays: 0, startedAt: start, now })?.retryAfter).toBeNull();
  });

  it("failedRecipientData leaves other failures untouched", () => {
    const ctx = { attempts: 0, retryDays: 2, startedAt: start };
    expect(failedRecipientData("131026", ctx, now)).toEqual({ status: "failed", errorCode: "131026" });
    expect(failedRecipientData("131049", ctx, now)).toEqual({ status: "failed", errorCode: "131049", attempts: 1, retryAfter: new Date(now.getTime() + DAY) });
    expect(failedRecipientData("131049", undefined, now)).toEqual({ status: "failed", errorCode: "131049" });
  });

  it("recipientUpdateFromMessage applies retry bookkeeping for failed messages", () => {
    const m = { status: "failed", wamid: null, errorCode: "131049", statusTimeline: [] };
    expect(recipientUpdateFromMessage(m, now, { attempts: 0, retryDays: 2, startedAt: start })).toMatchObject({ attempts: 1, retryAfter: new Date(now.getTime() + DAY) });
    expect(recipientUpdateFromMessage(m, now)).toEqual({ status: "failed", errorCode: "131049" });
  });
});

describe("requeueDueRetries", () => {
  beforeEach(() => vi.resetAllMocks());
  const b = { id: "b1", tenantId: "t1", retryDays: 3, startedAt: start };

  it("does nothing when retries are off", async () => {
    expect(await requeueDueRetries({ ...b, retryDays: 0 }, now)).toBe(0);
    expect(db.broadcastRecipient.updateMany).not.toHaveBeenCalled();
  });

  it("re-queues due cap failures of opted-in contacts, tenant scoped", async () => {
    db.broadcastRecipient.updateMany.mockResolvedValue({ count: 2 });
    const later = new Date(start.getTime() + 1.5 * DAY);
    expect(await requeueDueRetries(b, later)).toBe(2);
    const calls = db.broadcastRecipient.updateMany.mock.calls.map((c: any) => c[0]);
    const requeue = calls.find((c: any) => c.data.status === "pending");
    expect(requeue.where).toMatchObject({ tenantId: "t1", broadcastId: "b1", status: "failed", errorCode: "131049", retryAfter: { lte: later }, contact: { optIn: true, optedOutAt: null } });
    const optOut = calls[0];
    expect(optOut.data).toEqual({ retryAfter: null });
    expect(JSON.stringify(optOut.where)).toContain("optedOutAt");
  });

  it("clears retries and re-queues nothing once the window has ended", async () => {
    db.broadcastRecipient.updateMany.mockResolvedValue({ count: 0 });
    const over = new Date(start.getTime() + 4 * DAY);
    expect(await requeueDueRetries(b, over)).toBe(0);
    const calls = db.broadcastRecipient.updateMany.mock.calls.map((c: any) => c[0]);
    expect(calls.some((c: any) => c.data.status === "pending")).toBe(false);
    expect(calls.at(-1).data).toEqual({ retryAfter: null });
  });
});

describe("processBroadcast with retries", () => {
  beforeEach(() => vi.resetAllMocks());
  const broadcast = (over: Record<string, unknown> = {}) => ({
    id: "b1",
    tenantId: "t1",
    phoneNumberId: "p1",
    status: "sending",
    scheduledAt: null,
    startedAt: start,
    retryDays: 3,
    template: { name: "promo", language: "en", components: [{ type: "BODY", text: "Hello" }] },
    phoneNumber: { qualityRating: "GREEN", messagingLimitTier: "TIER_1K" },
    ...over,
  });

  function setup(retryAt: Date | null) {
    db.broadcastRecipient.count.mockResolvedValue(0);
    db.broadcastRecipient.findMany.mockResolvedValue([]);
    db.broadcastRecipient.findFirst.mockImplementation(async ({ where }: any) => (where.retryAfter ? (retryAt ? { retryAfter: retryAt } : null) : null));
    db.broadcastRecipient.updateMany.mockResolvedValue({ count: 0 });
    db.message.findMany.mockResolvedValue([]);
  }

  it("does not complete while a retry is waiting; wakes at retryAfter", async () => {
    const retryAt = new Date(now.getTime() + DAY);
    db.broadcast.findUnique.mockResolvedValue(broadcast());
    setup(retryAt);
    await processBroadcast("b1", now);
    expect(db.broadcast.update).not.toHaveBeenCalled();
    expect(queue.enqueue).toHaveBeenCalledWith("broadcast", { broadcastId: "b1" }, { runAt: retryAt });
  });

  it("completes when no retry is waiting", async () => {
    db.broadcast.findUnique.mockResolvedValue(broadcast());
    setup(null);
    await processBroadcast("b1", now);
    expect(db.broadcast.update.mock.calls.at(-1)![0].data.status).toBe("completed");
  });

  it("stays open a few minutes after the last send, so a 131049 that Meta reports late is still retried", async () => {
    const lastSent = new Date(now.getTime() - 2 * 60_000);
    db.broadcast.findUnique.mockResolvedValue(broadcast());
    setup(null);
    db.broadcastRecipient.findFirst.mockImplementation(async ({ where }: any) => (where.retryAfter ? null : where.sentAt ? { sentAt: lastSent } : null));
    await processBroadcast("b1", now);
    expect(db.broadcast.update).not.toHaveBeenCalled();
    expect(queue.enqueue).toHaveBeenCalledWith("broadcast", { broadcastId: "b1" }, { runAt: new Date(lastSent.getTime() + LATE_FAILURE_GRACE_MS) });
    const lookup = db.broadcastRecipient.findFirst.mock.calls.map((c: any) => c[0]).find((q: any) => q.where.sentAt);
    expect(lookup).toMatchObject({ where: { tenantId: "t1", broadcastId: "b1", sentAt: { not: null } }, orderBy: { sentAt: "desc" } });

    // Once the grace has passed it completes; with retries off it never waits.
    vi.clearAllMocks();
    db.broadcast.findUnique.mockResolvedValue(broadcast());
    await processBroadcast("b1", new Date(lastSent.getTime() + LATE_FAILURE_GRACE_MS + 1));
    expect(db.broadcast.update.mock.calls.at(-1)![0].data.status).toBe("completed");
    vi.clearAllMocks();
    db.broadcast.findUnique.mockResolvedValue(broadcast({ retryDays: 0 }));
    await processBroadcast("b1", now);
    expect(db.broadcast.update.mock.calls.at(-1)![0].data.status).toBe("completed");
  });

  it("a thrown 131049 on send records the attempt and retryAfter", async () => {
    db.broadcast.findUnique.mockResolvedValue(broadcast({ startedAt: new Date() }));
    setup(null);
    db.broadcastRecipient.count.mockImplementation(async ({ where }: any) => (where.status === "pending" ? 0 : 0));
    db.broadcastRecipient.findMany.mockImplementation(async ({ where }: any) =>
      where.status === "pending" ? [{ id: "r1", attempts: 0, contact: { id: "c1", name: "A", attributes: {}, optIn: true, optedOutAt: null } }] : [],
    );
    db.broadcastRecipient.updateMany.mockResolvedValue({ count: 1 });
    inbox.sendTemplateMessage.mockRejectedValue({ code: 131049 });
    await processBroadcast("b1", now);
    const failed = db.broadcastRecipient.update.mock.calls.map((c: any) => c[0].data).find((d: any) => d.status === "failed");
    expect(failed).toEqual({ status: "failed", errorCode: "131049", attempts: 1, retryAfter: expect.any(Date) });
  });

  it("a thrown opted-out or other error is never given a retryAfter", async () => {
    db.broadcast.findUnique.mockResolvedValue(broadcast());
    setup(null);
    db.broadcastRecipient.findMany.mockImplementation(async ({ where }: any) =>
      where.status === "pending" ? [{ id: "r1", attempts: 0, contact: { id: "c1", name: "A", attributes: {}, optIn: true, optedOutAt: null } }] : [],
    );
    db.broadcastRecipient.updateMany.mockResolvedValue({ count: 1 });
    inbox.sendTemplateMessage.mockRejectedValue({ code: 131026 });
    await processBroadcast("b1", now);
    const failed = db.broadcastRecipient.update.mock.calls.map((c: any) => c[0].data).find((d: any) => d.status === "failed");
    expect(failed).toEqual({ status: "failed", errorCode: "131026" });
  });
});
