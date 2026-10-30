import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  job: { findMany: vi.fn() },
  conversionEvent: { findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn(async () => ({})) },
}));
const queue = vi.hoisted(() => ({ enqueue: vi.fn(async () => ({})) }));
const state = vi.hoisted(() => ({ blocked: new Set<string>() }));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/queue", () => queue);
vi.mock("@/lib/tenant-state", () => ({ tenantMayRunBackground: async (id: string) => !state.blocked.has(id) }));
vi.mock("@/lib/meta-connect", () => ({ getAssetAccess: vi.fn(), listAssets: vi.fn(async () => []) }));
vi.mock("@/lib/graph", () => ({ graphFetchAs: vi.fn(), GraphError: class extends Error {} }));

import { sweepPendingConversions, worker } from "@/lib/conversions/worker";

const DAY = 86_400_000;
const now = new Date("2026-10-27T10:00:00Z");
const ev = (id: string, tenantId: string, over: Record<string, unknown> = {}) => ({ id, tenantId, eventTime: new Date(now.getTime() - 2 * 3_600_000), createdAt: new Date(now.getTime() - 2 * 3_600_000), ...over });

beforeEach(() => {
  vi.clearAllMocks();
  state.blocked = new Set();
  db.job.findMany.mockResolvedValue([]);
  db.conversionEvent.findMany.mockResolvedValue([]);
});

describe("conversion sweep", () => {
  it("is registered as a 15 minute periodic task", () => {
    const task = worker.periodic.find((p) => p.name === "conversions.sweep-pending");
    expect(task?.everyMs).toBe(15 * 60_000);
  });
  it("only looks at pending events older than 30 minutes, oldest first", async () => {
    await sweepPendingConversions(now);
    const arg = db.conversionEvent.findMany.mock.calls[0][0] as { where: { status: string; createdAt: { lt: Date } }; orderBy: unknown };
    expect(arg.where.status).toBe("pending");
    expect(arg.where.createdAt.lt.getTime()).toBe(now.getTime() - 30 * 60_000);
    expect(arg.orderBy).toEqual({ createdAt: "asc" });
  });
  it("re-enqueues a held event once its workspace is allowed again", async () => {
    db.conversionEvent.findMany.mockResolvedValueOnce([ev("e1", "t1")]);
    expect(await sweepPendingConversions(now)).toBe(1);
    expect(queue.enqueue).toHaveBeenCalledWith("conversions", { tenantId: "t1", conversionEventId: "e1" }, expect.objectContaining({ maxAttempts: 5 }));
  });
  it("leaves events of a still blocked workspace pending: nothing enqueued, nothing updated", async () => {
    state.blocked.add("t1");
    db.conversionEvent.findMany.mockResolvedValueOnce([ev("e1", "t1"), ev("e2", "t1")]);
    expect(await sweepPendingConversions(now)).toBe(0);
    expect(queue.enqueue).not.toHaveBeenCalled();
    expect(db.conversionEvent.update).not.toHaveBeenCalled();
  });
  it("skips a blocked workspace's event with tenant_blocked once it is older than 7 days, and keeps the younger ones", async () => {
    state.blocked.add("t1");
    db.conversionEvent.findMany.mockResolvedValueOnce([ev("old", "t1", { eventTime: new Date(now.getTime() - 8 * DAY) }), ev("young", "t1")]);
    await sweepPendingConversions(now);
    expect(db.conversionEvent.update).toHaveBeenCalledTimes(1);
    expect(db.conversionEvent.update).toHaveBeenCalledWith({ where: { id: "old" }, data: { status: "skipped", response: { reason: "tenant_blocked" } } });
  });
  it("does not double-enqueue an event that already has a delivery job in flight", async () => {
    db.job.findMany.mockResolvedValue([{ payload: { tenantId: "t1", conversionEventId: "e1" } }, { payload: null }, { payload: { conversionEventId: 5 } }]);
    db.conversionEvent.findMany.mockResolvedValueOnce([ev("e1", "t1"), ev("e2", "t1")]);
    expect(await sweepPendingConversions(now)).toBe(1);
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
    expect((queue.enqueue.mock.calls[0] as unknown[])[1]).toEqual({ tenantId: "t1", conversionEventId: "e2" });
    expect(db.job.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { queue: "conversions", status: { in: ["queued", "running"] } } }));
  });
  it("a large backlog of a blocked workspace does not starve a healthy one (blocked tenants are excluded from the next round)", async () => {
    state.blocked.add("blocked");
    const backlog = Array.from({ length: 200 }, (_, i) => ev(`b${i}`, "blocked"));
    db.conversionEvent.findMany.mockImplementation((async (arg: { where: { tenantId?: { notIn: string[] } } }) =>
      arg.where.tenantId?.notIn.includes("blocked") ? [ev("h1", "healthy")] : backlog) as never);
    expect(await sweepPendingConversions(now)).toBe(1);
    expect((queue.enqueue.mock.calls[0] as unknown[])[1]).toEqual({ tenantId: "healthy", conversionEventId: "h1" });
  });
});
