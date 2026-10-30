import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ tenant: { findUnique: vi.fn() } }));
const billing = vi.hoisted(() => ({ getBillingStatus: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/billing", () => billing);

import { resetTenantStateCache, tenantMayRunBackground } from "@/lib/tenant-state";

beforeEach(() => {
  vi.clearAllMocks();
  resetTenantStateCache();
});

describe("tenantMayRunBackground", () => {
  it("allows an active, paid workspace", async () => {
    db.tenant.findUnique.mockResolvedValue({ status: "active", deletedAt: null });
    billing.getBillingStatus.mockResolvedValue({ canWrite: true });
    expect(await tenantMayRunBackground("t1")).toBe(true);
  });
  it("refuses suspended, deleted, locked and unknown workspaces", async () => {
    db.tenant.findUnique.mockResolvedValueOnce({ status: "suspended", deletedAt: null });
    expect(await tenantMayRunBackground("a")).toBe(false);
    db.tenant.findUnique.mockResolvedValueOnce({ status: "active", deletedAt: new Date() });
    expect(await tenantMayRunBackground("b")).toBe(false);
    db.tenant.findUnique.mockResolvedValueOnce({ status: "active", deletedAt: null });
    billing.getBillingStatus.mockResolvedValueOnce({ canWrite: false });
    expect(await tenantMayRunBackground("c")).toBe(false);
    db.tenant.findUnique.mockResolvedValueOnce(null);
    expect(await tenantMayRunBackground("d")).toBe(false);
  });
  it("fails closed on errors and caches the answer briefly", async () => {
    db.tenant.findUnique.mockRejectedValueOnce(new Error("db down"));
    expect(await tenantMayRunBackground("e", 1000)).toBe(false);
    expect(await tenantMayRunBackground("e", 2000)).toBe(false);
    expect(db.tenant.findUnique).toHaveBeenCalledTimes(1);
  });
  it("race window, accepted and documented: a suspension is not seen until the 30 second cache entry expires", async () => {
    db.tenant.findUnique.mockResolvedValue({ status: "active", deletedAt: null });
    billing.getBillingStatus.mockResolvedValue({ canWrite: true });
    expect(await tenantMayRunBackground("r", 1000)).toBe(true);
    db.tenant.findUnique.mockResolvedValue({ status: "suspended", deletedAt: null });
    expect(await tenantMayRunBackground("r", 1000 + 29_000)).toBe(true);
    expect(await tenantMayRunBackground("r", 1000 + 30_001)).toBe(false);
  });
});
