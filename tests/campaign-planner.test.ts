import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  template: { findFirst: vi.fn() },
  phoneNumber: { findFirst: vi.fn(), findMany: vi.fn() },
  broadcast: { create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn() },
  broadcastRecipient: { count: vi.fn(), groupBy: vi.fn() },
  waba: { findFirst: vi.fn() },
  $queryRaw: vi.fn(),
}));
const queue = vi.hoisted(() => ({ enqueue: vi.fn(), runDueJobs: vi.fn() }));

vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/queue", () => queue);
vi.mock("@/lib/billing", () => ({ assertWithinLimit: async () => undefined }));
vi.mock("@/lib/inbox/service", () => ({ sendTemplateMessage: vi.fn() }));
vi.mock("@/lib/integrations/events", () => ({ emitEvent: async () => undefined }));

import { bucketByDay, canPlanDay, gridRange, isPastDay, longDate, monthGrid, statusColour } from "@/lib/broadcasts/calendar";
import { buildFunnel, funnelRate, mergeCounts } from "@/lib/broadcasts/funnel";
import { meterView, qualityView } from "@/lib/broadcasts/limits";
import { broadcastFunnel, numberLimits } from "@/lib/broadcasts/overview";
import { assertValidRange, assertValidSchedule, parseRetryDays } from "@/lib/broadcasts/schedule";
import { listCalendar, updateBroadcastPlan } from "@/lib/broadcasts/scheduling";
import { createBroadcast } from "@/lib/broadcasts/service";

const actor = { userId: "u1", tenantId: "t1", role: "admin" as const };
const now = new Date("2026-03-01T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

describe("schedule validation", () => {
  it("accepts the future up to 90 days", () => {
    expect(() => assertValidSchedule(new Date(now.getTime() + 1000), now)).not.toThrow();
    expect(() => assertValidSchedule(new Date(now.getTime() + 90 * DAY), now)).not.toThrow();
  });
  it("rejects the past and beyond 90 days", () => {
    expect(() => assertValidSchedule(new Date(now.getTime() - 1), now)).toThrow(/future/);
    expect(() => assertValidSchedule(now, now)).toThrow(/future/);
    expect(() => assertValidSchedule(new Date(now.getTime() + 90 * DAY + 1), now)).toThrow(/90 days/);
  });
  it("validates retryDays and ranges", () => {
    expect(parseRetryDays(undefined)).toBe(0);
    expect(parseRetryDays(7)).toBe(7);
    for (const bad of [8, -1, 1.5, "2"]) expect(() => parseRetryDays(bad)).toThrow();
    expect(() => assertValidRange(now, new Date(now.getTime() + 63 * DAY))).toThrow();
    expect(() => assertValidRange(now, now)).toThrow();
    expect(() => assertValidRange(now, new Date(now.getTime() + 42 * DAY))).not.toThrow();
  });
});

describe("calendar helpers", () => {
  it("builds whole weeks that cover the month", () => {
    const weeks = monthGrid(2026, 2);
    expect(weeks.every((w) => w.length === 7)).toBe(true);
    expect(weeks[0][0].date.getDay()).toBe(0);
    const days = weeks.flat().filter((c) => c.inMonth);
    expect(days).toHaveLength(31);
    const { from, to } = gridRange(weeks);
    expect(from.getTime()).toBeLessThanOrEqual(new Date(2026, 2, 1).getTime());
    expect(to.getTime()).toBeGreaterThan(new Date(2026, 2, 31).getTime());
  });
  it("buckets items by local day, sorted by time", () => {
    const a = new Date(2026, 2, 5, 15, 0).toISOString();
    const b = new Date(2026, 2, 5, 9, 0).toISOString();
    const map = bucketByDay([{ id: "a", name: "A", status: "scheduled", at: a }, { id: "b", name: "B", status: "completed", at: b }]);
    expect(map.get("2026-03-05")?.map((i) => i.id)).toEqual(["b", "a"]);
  });
  it("maps statuses to colours and detects past days", () => {
    expect(statusColour("scheduled")).toBe("scheduled");
    expect(statusColour("completed")).toBe("sent");
    expect(statusColour("failed")).toBe("attention");
    expect(statusColour("canceled")).toBe("inactive");
    expect(isPastDay(new Date(2026, 0, 1), new Date(2026, 0, 2))).toBe(true);
    expect(isPastDay(new Date(2026, 0, 2, 23), new Date(2026, 0, 2, 1))).toBe(false);
  });
  it("offers planning only from today to the last day of the 90-day window", () => {
    const now = new Date(2026, 9, 30, 15, 0);
    expect(canPlanDay(new Date(2026, 9, 29), 90, now)).toBe(false);
    expect(canPlanDay(new Date(2026, 9, 30), 90, now)).toBe(true);
    expect(canPlanDay(new Date(2027, 0, 28), 90, now)).toBe(true);
    expect(canPlanDay(new Date(2027, 0, 29), 90, now)).toBe(false);
    expect(canPlanDay(new Date(2027, 2, 15), 90, now)).toBe(false);
  });
  it("names a day in full words, not Date.toDateString", () => {
    const label = longDate(new Date(2026, 9, 30));
    expect(label).toContain("2026");
    expect(label).not.toBe(new Date(2026, 9, 30).toDateString());
  });
});

describe("funnel and meter helpers", () => {
  it("builds the funnel; sent includes delivered and read", () => {
    const counts = mergeCounts([
      { status: "sent", _count: { _all: 2 } },
      { status: "delivered", _count: { _all: 3 } },
      { status: "read", _count: { _all: 5 } },
      { status: "failed", _count: { _all: 1 } },
      { status: "skipped", _count: { _all: 4 } },
    ]);
    expect(buildFunnel(counts, 2)).toEqual({ sent: 10, delivered: 8, read: 5, replied: 2, failed: 1, total: 15 });
    expect(funnelRate(1, 3)).toBe(33.3);
    expect(funnelRate(1, 0)).toBe(0);
  });
  it("shows unknown when the tier is not stored", () => {
    expect(meterView(null, 10)).toEqual({ known: false, label: "Messaging limit unknown" });
    expect(meterView("TIER_WEIRD", 10).known).toBe(false);
    expect(meterView("TIER_1K", 250)).toMatchObject({ known: true, limit: 1000, percent: 25 });
    expect(meterView("TIER_250", 999)).toMatchObject({ percent: 100 });
    expect(meterView("UNLIMITED", 5)).toMatchObject({ unlimited: true });
    expect(qualityView(null).label).toBe("Unknown");
    expect(qualityView("GREEN").tone).toBe("good");
    expect(qualityView("RED").tone).toBe("bad");
  });
});

describe("createBroadcast scheduling", () => {
  beforeEach(() => vi.resetAllMocks());
  const input = { name: "n", phoneNumberId: "p1", templateId: "tpl1" };
  const ok = () => {
    db.template.findFirst.mockResolvedValue({ id: "tpl1", status: "approved", wabaRefId: "w1", components: [{ type: "BODY", text: "Hi" }] });
    db.phoneNumber.findFirst.mockResolvedValue({ id: "p1", wabaRefId: "w1" });
    db.broadcast.create.mockResolvedValue({ id: "b1" });
  };

  it("rejects past and over-90-day schedules", async () => {
    ok();
    await expect(createBroadcast(actor, { ...input, scheduledAt: new Date(Date.now() - 1000) })).rejects.toMatchObject({ status: 400 });
    await expect(createBroadcast(actor, { ...input, scheduledAt: new Date(Date.now() + 91 * DAY) })).rejects.toMatchObject({ status: 400 });
    expect(db.broadcast.create).not.toHaveBeenCalled();
  });
  it("stores scheduledAt and retryDays", async () => {
    ok();
    const at = new Date(Date.now() + 2 * DAY);
    await createBroadcast(actor, { ...input, scheduledAt: at, retryDays: 3 });
    expect(db.broadcast.create.mock.calls[0][0].data).toMatchObject({ tenantId: "t1", scheduledAt: at, retryDays: 3 });
  });
  it("rejects an invalid retryDays", async () => {
    ok();
    await expect(createBroadcast(actor, { ...input, retryDays: 30 })).rejects.toMatchObject({ status: 400 });
  });
});

describe("updateBroadcastPlan", () => {
  beforeEach(() => vi.resetAllMocks());
  const found = (status: string) => db.broadcast.findFirst.mockResolvedValue({ id: "b1", tenantId: "t1", status, template: {} });

  it("reschedules a scheduled broadcast and enqueues the new time", async () => {
    found("scheduled");
    db.broadcast.update.mockResolvedValue({ id: "b1" });
    const at = new Date(now.getTime() + DAY);
    await updateBroadcastPlan(actor, "b1", { scheduledAt: at }, now);
    expect(db.broadcast.findFirst.mock.calls[0][0].where).toEqual({ id: "b1", tenantId: "t1" });
    expect(db.broadcast.update.mock.calls[0][0]).toMatchObject({ where: { id: "b1", tenantId: "t1" }, data: { scheduledAt: at } });
    expect(queue.enqueue).toHaveBeenCalledWith("broadcast", { broadcastId: "b1" }, { runAt: at });
  });
  it("updates a draft without enqueueing", async () => {
    found("draft");
    db.broadcast.update.mockResolvedValue({ id: "b1" });
    await updateBroadcastPlan(actor, "b1", { scheduledAt: new Date(now.getTime() + DAY) }, now);
    expect(queue.enqueue).not.toHaveBeenCalled();
  });
  it("refuses started or finished broadcasts, past dates and clearing a live schedule", async () => {
    found("sending");
    await expect(updateBroadcastPlan(actor, "b1", { scheduledAt: new Date(now.getTime() + DAY) }, now)).rejects.toMatchObject({ status: 409 });
    found("scheduled");
    await expect(updateBroadcastPlan(actor, "b1", { scheduledAt: new Date(now.getTime() - 1) }, now)).rejects.toMatchObject({ status: 400 });
    await expect(updateBroadcastPlan(actor, "b1", { scheduledAt: null }, now)).rejects.toMatchObject({ status: 400 });
    found("completed");
    await expect(updateBroadcastPlan(actor, "b1", { retryDays: 2 }, now)).rejects.toMatchObject({ status: 409 });
    expect(db.broadcast.update).not.toHaveBeenCalled();
  });
  it("404s for another tenant's broadcast", async () => {
    db.broadcast.findFirst.mockResolvedValue(null);
    await expect(updateBroadcastPlan(actor, "other", { retryDays: 1 }, now)).rejects.toMatchObject({ status: 404 });
  });
});

describe("listCalendar", () => {
  beforeEach(() => vi.resetAllMocks());
  it("is tenant scoped and returns the send time for started or scheduled items", async () => {
    const from = new Date("2026-03-01T00:00:00Z");
    const to = new Date("2026-04-01T00:00:00Z");
    db.broadcast.findMany.mockResolvedValue([
      { id: "a", name: "A", status: "scheduled", scheduledAt: new Date("2026-03-10T09:00:00Z"), startedAt: null },
      { id: "b", name: "B", status: "completed", scheduledAt: new Date("2026-03-02T09:00:00Z"), startedAt: new Date("2026-03-02T09:00:05Z") },
    ]);
    const items = await listCalendar(actor, from, to);
    expect(db.broadcast.findMany.mock.calls[0][0].where.tenantId).toBe("t1");
    expect(items).toEqual([
      { id: "a", name: "A", status: "scheduled", at: "2026-03-10T09:00:00.000Z" },
      { id: "b", name: "B", status: "completed", at: "2026-03-02T09:00:05.000Z" },
    ]);
    await expect(listCalendar(actor, from, new Date(from.getTime() + 100 * DAY))).rejects.toMatchObject({ status: 400 });
  });
});

describe("overview queries", () => {
  beforeEach(() => vi.resetAllMocks());
  it("funnel is tenant scoped and replies come from the raw query", async () => {
    db.broadcast.findFirst.mockResolvedValue({ id: "b1", template: {} });
    db.broadcastRecipient.groupBy.mockResolvedValue([{ status: "read", _count: { _all: 4 } }, { status: "failed", _count: { _all: 1 } }]);
    db.$queryRaw.mockResolvedValue([{ n: BigInt(2) }]);
    const funnel = await broadcastFunnel(actor, "b1");
    expect(funnel).toEqual({ sent: 4, delivered: 4, read: 4, replied: 2, failed: 1, total: 5 });
    expect(db.broadcastRecipient.groupBy.mock.calls[0][0].where).toEqual({ tenantId: "t1", broadcastId: "b1" });
    const call = db.$queryRaw.mock.calls[0];
    expect(call[0].join("?")).toContain('r."tenantId"');
    expect(call.slice(1)).toEqual(["t1", "b1"]);
  });
  it("number limits report the portfolio tier and unique people messaged in the last 24 hours", async () => {
    db.phoneNumber.findMany.mockResolvedValue([{ id: "p1", wabaRefId: "w1", displayPhone: "+91", verifiedName: null, qualityRating: null, messagingLimitTier: null }]);
    db.waba.findFirst.mockResolvedValue({ businessId: "biz1" });
    db.$queryRaw.mockResolvedValue([{ n: 7n, oldest: null }]);
    const [p] = await numberLimits(actor, now);
    expect(p).toMatchObject({ qualityRating: null, messagingLimitTier: null, portfolioTier: null, sentLast24h: 7 });
    expect(db.phoneNumber.findMany.mock.calls[0][0].where).toEqual({ tenantId: "t1" });
    expect(db.waba.findFirst.mock.calls[0][0].where).toEqual({ id: "w1", tenantId: "t1" });
    expect(db.phoneNumber.findMany.mock.calls[1][0].where).toEqual({ tenantId: "t1", waba: { businessId: "biz1" } });
  });
});
