import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  tenant: { count: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() },
  platformSetting: { findMany: vi.fn() },
  invoice: { findMany: vi.fn() },
  contact: { count: vi.fn() },
  conversation: { count: vi.fn() },
  message: { count: vi.fn() },
  broadcast: { count: vi.fn() },
  auditLog: { findMany: vi.fn() },
  onboardingLog: { findMany: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: db }));
const billing = vi.hoisted(() => ({ getBillingStatus: vi.fn() }));
vi.mock("@/lib/billing", () => billing);
vi.mock("@/lib/tenant-lifecycle", () => ({ windDownTenant: vi.fn() }));

import { getTenantDetail, listTenants, pendingDeletionRequests, TENANT_FILTERS } from "@/lib/admin/tenants";

const row = (id: string) => ({ id, name: `W ${id}`, slug: id, createdAt: new Date(), status: "active", deletedAt: null, trialEndsAt: null, billingExempt: false, onboardingStatus: "none", _count: { memberships: 1 }, subscription: null });
const request = { status: "requested", requestedAt: "2026-11-01T00:00:00.000Z", requestedByUserId: "u1", deleteBy: "2026-12-01T00:00:00.000Z" };

beforeEach(() => {
  vi.resetAllMocks();
  billing.getBillingStatus.mockResolvedValue({ state: "trialing" });
  db.tenant.count.mockResolvedValue(1);
  db.tenant.findMany.mockResolvedValue([row("t1"), row("t2")]);
});

describe("pending workspace deletion requests are visible to the platform team", () => {
  it("flags the workspaces whose owner asked for deletion, with the date the promise runs out", async () => {
    db.platformSetting.findMany.mockResolvedValue([{ key: "workspace-deletion:t2", value: request }]);
    const { items } = await listTenants({ filter: "all", q: "", page: 1 });
    expect(items.find((t) => t.id === "t1")?.deletionRequest).toBeNull();
    expect(items.find((t) => t.id === "t2")?.deletionRequest).toEqual({ requestedAt: request.requestedAt, deleteBy: request.deleteBy });
  });

  it("only reads requests that are still waiting, never cancelled or finished ones", async () => {
    db.platformSetting.findMany.mockResolvedValue([]);
    await listTenants({ filter: "all", q: "", page: 1 });
    expect(db.platformSetting.findMany.mock.calls[0][0].where).toEqual({ key: { startsWith: "workspace-deletion:" }, value: { path: ["status"], equals: "requested" } });
  });

  it("has a filter that lists only those workspaces", async () => {
    expect(TENANT_FILTERS).toContain("deletion_requested");
    db.platformSetting.findMany.mockResolvedValue([{ key: "workspace-deletion:t2", value: request }]);
    await listTenants({ filter: "deletion_requested", q: "", page: 1 });
    expect(db.tenant.findMany.mock.calls[0][0].where).toEqual({ id: { in: ["t2"] } });
  });

  it("lists every workspace the overview counts, including one already soft-deleted or whose erase stopped partway", async () => {
    // A tiny tenant table that honours the two conditions listTenants uses, so the count and the rows play out for real.
    const tenants = [row("t1"), row("t2"), { ...row("t3"), status: "suspended", deletedAt: new Date("2026-11-02T00:00:00Z") }];
    const pick = ({ where }: { where: { id?: { in: string[] }; deletedAt?: null | { not: null } } }) =>
      tenants.filter((t) => (!where.id || where.id.in.includes(t.id)) && (where.deletedAt === undefined || (where.deletedAt === null ? t.deletedAt === null : t.deletedAt !== null)));
    db.tenant.findMany.mockImplementation(async (args) => pick(args));
    db.tenant.count.mockImplementation(async (args) => pick(args).length);
    db.platformSetting.findMany.mockResolvedValue([
      { key: "workspace-deletion:t2", value: request },
      { key: "workspace-deletion:t3", value: request },
    ]);
    const counted = (await pendingDeletionRequests()).size;
    const listed = await listTenants({ filter: "deletion_requested", q: "", page: 1 });
    expect(counted).toBe(2);
    expect(listed.total).toBe(counted);
    expect(listed.items.map((t) => t.id)).toEqual(["t2", "t3"]);
    // The ordinary filters still leave deleted workspaces out.
    expect((await listTenants({ filter: "all", q: "", page: 1 })).items.map((t) => t.id)).toEqual(["t1", "t2"]);
  });

  it("the filter is empty, not 'everything', when no one has asked", async () => {
    db.platformSetting.findMany.mockResolvedValue([]);
    await listTenants({ filter: "deletion_requested", q: "", page: 1 });
    expect(db.tenant.findMany.mock.calls[0][0].where.id).toEqual({ in: [] });
  });

  it("the workspace page gets the request too", async () => {
    db.tenant.findUnique.mockResolvedValue({ id: "t2", memberships: [], subscription: null, wabas: [] });
    db.invoice.findMany.mockResolvedValue([]);
    db.contact.count.mockResolvedValue(0);
    db.conversation.count.mockResolvedValue(0);
    db.message.count.mockResolvedValue(0);
    db.broadcast.count.mockResolvedValue(0);
    db.auditLog.findMany.mockResolvedValue([]);
    db.onboardingLog.findMany.mockResolvedValue([]);
    db.platformSetting.findMany.mockResolvedValue([{ key: "workspace-deletion:t2", value: request }]);
    const detail = await getTenantDetail("t2");
    expect(detail?.deletionRequest?.deleteBy).toBe(request.deleteBy);
  });
});
