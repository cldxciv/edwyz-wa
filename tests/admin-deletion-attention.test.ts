import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  tenant: { findMany: vi.fn(), count: vi.fn() },
  subscription: { findMany: vi.fn() },
  user: { count: vi.fn() },
  message: { count: vi.fn() },
  phoneNumber: { groupBy: vi.fn() },
  job: { groupBy: vi.fn() },
  webhookEvent: { findMany: vi.fn() },
  platformSetting: { findMany: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/billing", () => ({ getBillingStatus: vi.fn(async () => ({ state: "active" })) }));

import { DELETION_URGENT_DAYS, attentionItems, deletionAttention } from "@/components/admin/helpers";
import { deletionSummary, getPlatformMetrics } from "@/lib/admin/queries";

const DAY = 86_400_000;
const now = new Date("2026-11-01T00:00:00Z");
const healthy = { tenantsByState: { active: 4 }, quality: [], jobs: {}, failedEvents: [] };

beforeEach(() => {
  vi.clearAllMocks();
  db.tenant.findMany.mockResolvedValue([]);
  db.tenant.count.mockResolvedValue(0);
  db.subscription.findMany.mockResolvedValue([]);
  db.user.count.mockResolvedValue(0);
  db.message.count.mockResolvedValue(0);
  db.phoneNumber.groupBy.mockResolvedValue([]);
  db.job.groupBy.mockResolvedValue([]);
  db.webhookEvent.findMany.mockResolvedValue([]);
  db.platformSetting.findMany.mockResolvedValue([]);
});

describe("workspace deletion requests on the admin overview", () => {
  it("counts open requests and finds the earliest due date", () => {
    expect(deletionSummary([])).toEqual({ pending: 0, nearestDeleteBy: null });
    expect(deletionSummary([{ deleteBy: "2026-11-20T00:00:00.000Z" }, { deleteBy: "2026-11-05T10:00:00.000Z" }, { deleteBy: "not a date" }])).toEqual({
      pending: 3,
      nearestDeleteBy: "2026-11-05T10:00:00.000Z",
    });
  });

  it("getPlatformMetrics reports them from the pending deletion records", async () => {
    db.platformSetting.findMany.mockResolvedValue([
      { key: "workspace-deletion:t1", value: { status: "requested", requestedAt: "2026-10-10T00:00:00.000Z", deleteBy: "2026-11-09T00:00:00.000Z" } },
      { key: "workspace-deletion:t2", value: { status: "requested", requestedAt: "2026-10-20T00:00:00.000Z", deleteBy: "2026-11-19T00:00:00.000Z" } },
    ]);
    const m = await getPlatformMetrics(now);
    expect(m.deletionRequests).toEqual({ pending: 2, nearestDeleteBy: "2026-11-09T00:00:00.000Z" });
    expect(db.platformSetting.findMany.mock.calls[0][0].where).toMatchObject({ key: { startsWith: "workspace-deletion:" }, value: { path: ["status"], equals: "requested" } });
  });

  it("a failing read of the requests does not break the overview", async () => {
    db.platformSetting.findMany.mockRejectedValue(new Error("db down"));
    expect((await getPlatformMetrics(now)).deletionRequests).toEqual({ pending: 0, nearestDeleteBy: null });
  });

  it("shows nothing when there are none", () => {
    expect(deletionAttention(undefined, now)).toBeNull();
    expect(deletionAttention({ pending: 0, nearestDeleteBy: null }, now)).toBeNull();
    expect(attentionItems({ ...healthy, deletionRequests: { pending: 0, nearestDeleteBy: null } }, now)).toEqual([]);
  });

  it("is amber while there is time, links to the filtered list, and names the due date", () => {
    const item = deletionAttention({ pending: 2, nearestDeleteBy: new Date(now.getTime() + 20 * DAY).toISOString() }, now)!;
    expect(item).toMatchObject({ id: "deletion", tone: "warn", title: "2 workspaces have asked to be deleted", href: "/admin/tenants?filter=deletion_requested", linkLabel: "Open deletion requests" });
    expect(item.body).toBe("The earliest must be erased by 2026-11-21, 20 days from now. We promise deletion within 30 days of the request.");
  });

  it(`turns red within ${DELETION_URGENT_DAYS} days of the earliest due date, and when it is overdue`, () => {
    const due = (days: number) => deletionAttention({ pending: 1, nearestDeleteBy: new Date(now.getTime() + days * DAY).toISOString() }, now)!;
    expect(due(DELETION_URGENT_DAYS + 1).tone).toBe("warn");
    expect(due(DELETION_URGENT_DAYS).tone).toBe("bad");
    expect(due(1)).toMatchObject({ tone: "bad", title: "1 workspace has asked to be deleted" });
    expect(due(1).body).toContain("1 day from now");
    const overdue = due(-2);
    expect(overdue.tone).toBe("bad");
    expect(overdue.body).toBe("The earliest was due to be erased by 2026-10-30. We promise deletion within 30 days of the request.");
  });

  it("sits with the red items when urgent and after the amber ones otherwise", () => {
    const base = { tenantsByState: { locked: 1 }, quality: [], jobs: { failed: 1 }, failedEvents: [] };
    const urgent = attentionItems({ ...base, deletionRequests: { pending: 1, nearestDeleteBy: new Date(now.getTime() + 2 * DAY).toISOString() } }, now);
    expect(urgent.map((i) => i.id)).toEqual(["jobs", "deletion", "locked"]);
    const calm = attentionItems({ ...base, deletionRequests: { pending: 1, nearestDeleteBy: new Date(now.getTime() + 25 * DAY).toISOString() } }, now);
    expect(calm.map((i) => i.id)).toEqual(["jobs", "locked", "deletion"]);
  });
});
