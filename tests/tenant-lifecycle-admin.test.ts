import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  adCampaign: { findMany: vi.fn(), updateMany: vi.fn(async () => ({ count: 1 })) },
  metaConnection: { findMany: vi.fn() },
  metaAsset: { findMany: vi.fn() },
  auditLog: { findFirst: vi.fn() },
  tenant: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn(async () => ({})) },
}));
/**
 * stopCommitments (src/lib/ads/stop.ts, through the Spend Book) is replaced by a stand-in that keeps its contract: it selects the
 * workspace's active campaigns that reached Meta, treats a campaign whose connection can no longer give a token as unreachable
 * (no Meta call), pauses the rest one by one (`ads.pause`), lists every campaign with its result, and never throws (a failed read
 * is one failure). The real one runs against the real book in tests/ads-actions.test.ts.
 */
const ads = vi.hoisted(() => ({ pause: vi.fn(), stopCommitments: vi.fn() }));
const svc = vi.hoisted(() => ({ disconnect: vi.fn() }));
const billing = vi.hoisted(() => ({ getBillingStatus: vi.fn() }));
const auditMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/ads/stop", () => ({ stopCommitments: ads.stopCommitments }));
vi.mock("@/lib/meta-connect/service", () => svc);
vi.mock("@/lib/billing", () => billing);
vi.mock("@/lib/auth/audit", () => ({ audit: auditMock }));
vi.mock("@/lib/tenant-state", () => ({ tenantMayRunBackground: async () => true }));

import { applyTenantAction } from "@/lib/admin/tenants";
import { pauseAdsForBlockedTenants } from "@/lib/optimizer/engine";
import { pauseAllCampaigns, revokeAllConnections } from "@/lib/meta-connect/revoke-all";

const auditActions = () => auditMock.mock.calls.map((c) => (c as unknown as [{ action: string }])[0].action);

/** pauseTenantAds selects { id, adAccountAssetId }; the "connections still in use" lookup selects only adAccountAssetId; the sweep uses distinct tenantId. */
const campaigns = (active: { id: string; adAccountAssetId: string }[]) =>
  db.adCampaign.findMany.mockImplementation(async (arg: { select?: Record<string, boolean>; distinct?: string[] }) => {
    if (arg.distinct) return active.length ? [{ tenantId: "t1" }] : [];
    return arg.select?.id ? active.map((c) => ({ id: c.id, adAccountAssetId: c.adAccountAssetId, lastError: lastError[c.id] ?? null })) : active.map((c) => ({ adAccountAssetId: c.adAccountAssetId }));
  });

/** What the campaign rows currently carry in lastError: written by the flag (updateMany with data.lastError), cleared by the sweep. */
const lastError: Record<string, string | null> = {};
const trackLastError = () =>
  db.adCampaign.updateMany.mockImplementation((async (arg: { where: { id?: string; lastError?: unknown }; data: { lastError?: string | null } }) => {
    if (arg.data.lastError === undefined) return { count: 1 };
    if (arg.where.id) lastError[arg.where.id] = arg.data.lastError;
    else for (const k of Object.keys(lastError)) lastError[k] = arg.data.lastError;
    return { count: 1 };
  }) as never);

/** Whether the Meta connection behind every ad account asset can still produce a token (the usability lookup selects `connection`). */
const meta = { usable: true };
const assetRows = async (arg: { select?: Record<string, unknown>; where: { tenantId?: string; id?: { in: string[] } } }) =>
  arg.select?.connection
    ? (arg.where.id?.in ?? []).map((id) => ({ id, connectionId: "m1", status: "active", connection: { tenantId: arg.where.tenantId, status: meta.usable ? "active" : "expired", tokenEnc: "x", tokenExpiresAt: null } }))
    : [{ connectionId: "m1" }];

type Item = { campaignId: string; campaignName: string; adAccountAssetId: string; metaObjectId: string; level: "campaign"; result: "done" | "failed" | "unreachable"; lastError: string | null };

async function fakeStop(tenantId: string) {
  try {
    const rows = ((await db.adCampaign.findMany({ where: { tenantId, status: "active", metaCampaignId: { not: null } }, select: { id: true, adAccountAssetId: true, lastError: true } })) ?? []) as { id: string; adAccountAssetId: string; lastError?: string | null }[];
    const ids = [...new Set(rows.map((r) => r.adAccountAssetId))];
    const assets = rows.length ? (((await db.metaAsset.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, connectionId: true, status: true, connection: { select: { tenantId: true, status: true, tokenEnc: true, tokenExpiresAt: true } } } })) ?? []) as { id: string; status: string; connection: { tenantId: string; status: string; tokenEnc: string | null; tokenExpiresAt: Date | null } }[]) : [];
    // Like getAssetAccess: a connection that can no longer give a token is unreachable; a row this stand-in cannot read is tried.
    let usable: Set<string> | null = null;
    try {
      usable = new Set(
        assets
          .filter((a) => {
            const c = a.connection;
            const lapsed = c.tokenExpiresAt != null && c.tokenExpiresAt.getTime() <= Date.now();
            return a.status === "active" && c.tenantId === tenantId && ["active", "expiring"].includes(c.status) && !lapsed && !!c.tokenEnc;
          })
          .map((a) => a.id),
      );
    } catch {
      usable = null;
    }
    const out = { done: 0, failed: 0, unreachable: 0, skipped: 0, total: rows.length, items: [] as Item[] };
    for (const c of rows) {
      const item = { campaignId: c.id, campaignName: c.id, adAccountAssetId: c.adAccountAssetId, metaObjectId: `m_${c.id}`, level: "campaign" as const, lastError: c.lastError ?? null };
      if (usable && !usable.has(c.adAccountAssetId)) {
        out.unreachable++;
        out.items.push({ ...item, result: "unreachable" });
        continue;
      }
      try {
        await ads.pause(tenantId, c.id);
        out.done++;
        out.items.push({ ...item, result: "done" });
      } catch {
        out.failed++;
        out.items.push({ ...item, result: "failed" });
      }
    }
    return out;
  } catch {
    return { done: 0, failed: 1, unreachable: 0, skipped: 0, total: 1, items: [] };
  }
}

beforeEach(() => {
  vi.resetAllMocks();
  ads.stopCommitments.mockImplementation(fakeStop);
  db.tenant.update.mockResolvedValue({});
  db.tenant.findUnique.mockResolvedValue({ id: "t1", name: "Acme", trialEndsAt: null, deletedAt: null });
  db.adCampaign.findMany.mockResolvedValue([]);
  db.adCampaign.updateMany.mockResolvedValue({ count: 1 });
  db.metaConnection.findMany.mockResolvedValue([]);
  meta.usable = true;
  for (const k of Object.keys(lastError)) delete lastError[k];
  db.tenant.findMany.mockResolvedValue([]);
  db.metaAsset.findMany.mockImplementation(assetRows);
  db.auditLog.findFirst.mockResolvedValue(null);
});

describe("pauseAllCampaigns", () => {
  it("pauses everything of the tenant that can spend through stopCommitments, as a system job", async () => {
    db.adCampaign.findMany.mockResolvedValue([{ id: "c1" }, { id: "c2" }]);
    ads.pause.mockResolvedValue({});
    expect(await pauseAllCampaigns("t1", "u1")).toEqual({ done: 2, failed: 0 });
    expect(ads.stopCommitments).toHaveBeenCalledWith("t1", { origin: "all" }, { type: "system", job: "meta-connect.revoke-all" }, expect.stringMatching(/\S/));
    expect(ads.pause.mock.calls).toEqual([
      ["t1", "c1"],
      ["t1", "c2"],
    ]);
  });
  it("counts a campaign whose connection can no longer give a token as failed, and flags it", async () => {
    campaigns([{ id: "c1", adAccountAssetId: "a1" }]);
    meta.usable = false;
    expect(await pauseAllCampaigns("t1", "u1")).toEqual({ done: 0, failed: 1 });
    expect(ads.pause).not.toHaveBeenCalled();
    expect(auditActions()).toEqual(["ads.campaign.pause_failed"]);
  });
  it("keeps going when one pause fails, audits the failure and never throws", async () => {
    db.adCampaign.findMany.mockResolvedValue([{ id: "c1" }, { id: "c2" }]);
    ads.pause.mockRejectedValueOnce(new Error("meta down")).mockResolvedValueOnce({});
    expect(await pauseAllCampaigns("t1", "u1")).toEqual({ done: 1, failed: 1 });
    expect(auditActions()).toEqual(["ads.campaign.pause_failed"]);
  });
  it("flags a campaign that cannot be paused only once, not on every retry (no unbounded audit growth)", async () => {
    db.adCampaign.findMany.mockResolvedValue([{ id: "c1" }]);
    ads.pause.mockRejectedValue(new Error("connection revoked"));
    await pauseAllCampaigns("t1", "u1");
    expect(auditActions()).toEqual(["ads.campaign.pause_failed"]);
    expect(db.adCampaign.updateMany).toHaveBeenCalledWith({ where: { id: "c1", tenantId: "t1", status: "active" }, data: { lastError: expect.stringContaining("Could not pause") } });
    auditMock.mockClear();
    db.adCampaign.updateMany.mockClear();
    db.auditLog.findFirst.mockResolvedValue({ id: "a1" });
    for (let i = 0; i < 3; i++) expect(await pauseAllCampaigns("t1", "u1")).toEqual({ done: 0, failed: 1 });
    expect(auditMock).not.toHaveBeenCalled();
    expect(db.adCampaign.updateMany).not.toHaveBeenCalled();
    expect(db.auditLog.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "t1", action: "ads.campaign.pause_failed", target: "c1" } }));
  });
  it("is idempotent: nothing active means nothing to do, and a database error does not throw", async () => {
    expect(await pauseAllCampaigns("t1", "u1")).toEqual({ done: 0, failed: 0 });
    db.adCampaign.findMany.mockRejectedValue(new Error("db"));
    await expect(pauseAllCampaigns("t1", "u1")).resolves.toEqual({ done: 0, failed: 1 });
    expect(ads.pause).not.toHaveBeenCalled();
  });
});

describe("revokeAllConnections", () => {
  it("disconnects every non-revoked connection of the tenant through the disconnect service", async () => {
    db.metaConnection.findMany.mockResolvedValue([{ id: "m1" }, { id: "m2" }]);
    svc.disconnect.mockResolvedValue(undefined);
    expect(await revokeAllConnections("t1", "u1")).toEqual({ done: 2, failed: 0, deferred: 0 });
    expect(db.metaConnection.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "t1", status: { not: "revoked" } } }));
    expect(svc.disconnect).toHaveBeenCalledWith({ userId: "u1", tenantId: "t1", role: "admin" }, "m1");
    expect(svc.disconnect).toHaveBeenCalledWith({ userId: "u1", tenantId: "t1", role: "admin" }, "m2");
  });
  it("continues after a failure, audits it and never throws", async () => {
    db.metaConnection.findMany.mockResolvedValue([{ id: "m1" }, { id: "m2" }]);
    svc.disconnect.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(undefined);
    expect(await revokeAllConnections("t1", "u1")).toEqual({ done: 1, failed: 1, deferred: 0 });
    expect(auditActions()).toEqual(["meta_connect.disconnect_failed"]);
    db.metaConnection.findMany.mockRejectedValue(new Error("db"));
    await expect(revokeAllConnections("t1", "u1")).resolves.toEqual({ done: 0, failed: 1, deferred: 0 });
  });
  it("keeps the connection that backs a campaign which is still active and revokes the others (a revoked token can never pause it)", async () => {
    db.metaConnection.findMany.mockResolvedValue([{ id: "m1" }, { id: "m2" }]);
    campaigns([{ id: "c1", adAccountAssetId: "a1" }]);
    db.metaAsset.findMany.mockResolvedValue([{ connectionId: "m1" }]);
    svc.disconnect.mockResolvedValue(undefined);
    expect(await revokeAllConnections("t1", "u1")).toEqual({ done: 1, failed: 0, deferred: 1 });
    expect(svc.disconnect).toHaveBeenCalledTimes(1);
    expect(svc.disconnect).toHaveBeenCalledWith(expect.anything(), "m2");
    expect(db.metaAsset.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "t1", id: { in: ["a1"] } } }));
  });
  it("keeps every connection when it cannot tell which are in use", async () => {
    db.metaConnection.findMany.mockResolvedValue([{ id: "m1" }]);
    db.adCampaign.findMany.mockRejectedValue(new Error("db"));
    expect(await revokeAllConnections("t1", "u1")).toEqual({ done: 0, failed: 0, deferred: 1 });
    expect(svc.disconnect).not.toHaveBeenCalled();
  });
});

describe("suspend and soft delete wind the workspace down", () => {
  it("suspend pauses ads first, then revokes the connections", async () => {
    campaigns([{ id: "c1", adAccountAssetId: "a1" }]);
    db.metaConnection.findMany.mockResolvedValue([{ id: "m1" }]);
    const order: string[] = [];
    let paused = false;
    ads.pause.mockImplementation(async () => {
      order.push("pause");
      paused = true;
      campaigns([]);
    });
    svc.disconnect.mockImplementation(async () => {
      order.push(paused ? "disconnect" : "disconnect-too-early");
    });
    await expect(applyTenantAction("admin", "t1", { action: "suspend", reason: "abuse", confirm: "Acme" })).resolves.toEqual({ ok: true });
    expect(order).toEqual(["pause", "disconnect"]);
    // Through the Spend Book's stopCommitments, every campaign, recorded as the tenant-state job (docs/SPEND-CONTROLS-SPEC.md 4.8).
    expect(ads.stopCommitments).toHaveBeenCalledWith("t1", { origin: "all" }, { type: "system", job: "tenant-state" }, expect.stringContaining("locked, suspended or closing"));
  });
  it("stopCommitments failing outright counts as one failed pause and never throws", async () => {
    ads.stopCommitments.mockRejectedValue(new Error("db down"));
    const { pauseTenantAds } = await import("@/lib/tenant-lifecycle");
    await expect(pauseTenantAds("t1")).resolves.toEqual({ done: 0, failed: 1, unreachable: 0 });
  });
  it("suspend does NOT revoke the connection of a campaign whose pause failed, and tells the admin", async () => {
    campaigns([{ id: "c1", adAccountAssetId: "a1" }]);
    db.metaConnection.findMany.mockResolvedValue([{ id: "m1" }]);
    db.metaAsset.findMany.mockResolvedValue([{ connectionId: "m1" }]);
    ads.pause.mockRejectedValue(new Error("meta 5xx"));
    svc.disconnect.mockResolvedValue(undefined);
    const res = await applyTenantAction("admin", "t1", { action: "suspend", reason: "abuse", confirm: "Acme" });
    expect(res).toMatchObject({ ok: true, warning: expect.stringContaining("could not be paused") });
    expect(svc.disconnect).not.toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "admin.tenant.suspend", meta: expect.objectContaining({ adsPauseFailed: 1, connectionsRevoked: 0, connectionsDeferred: 1 }) }),
    );
  });
  it("suspend still succeeds when the wind-down helpers hit database errors", async () => {
    db.adCampaign.findMany.mockRejectedValue(new Error("db"));
    db.metaConnection.findMany.mockRejectedValue(new Error("db"));
    await expect(applyTenantAction("admin", "t1", { action: "suspend", reason: "abuse", confirm: "Acme" })).resolves.toMatchObject({ ok: true });
  });
  it("soft delete does the same, and repeating it is harmless", async () => {
    ads.pause.mockResolvedValue({});
    svc.disconnect.mockResolvedValue(undefined);
    db.adCampaign.findMany.mockResolvedValueOnce([{ id: "c1" }]).mockResolvedValue([]);
    db.metaConnection.findMany.mockResolvedValueOnce([{ id: "m1" }]).mockResolvedValue([]);
    await applyTenantAction("admin", "t1", { action: "soft_delete", reason: "closed", confirm: "Acme" });
    await applyTenantAction("admin", "t1", { action: "soft_delete", reason: "closed", confirm: "Acme" });
    expect(ads.pause).toHaveBeenCalledTimes(1);
    expect(svc.disconnect).toHaveBeenCalledTimes(1);
  });
});

describe("pauseAdsForBlockedTenants (billing lock safety net)", () => {
  beforeEach(() => {
    db.adCampaign.findMany.mockImplementation(async (arg: { distinct?: string[] }) => (arg.distinct ? [{ tenantId: "locked" }, { tenantId: "ok" }, { tenantId: "flaky" }] : [{ id: "c1" }]));
    ads.pause.mockResolvedValue({});
    db.tenant.findUnique.mockResolvedValue({ status: "active", deletedAt: null });
    billing.getBillingStatus.mockImplementation(async (id: string) => {
      if (id === "flaky") throw new Error("billing read failed");
      return { canWrite: id !== "locked" };
    });
  });
  it("pauses only the workspace whose billing is locked, and leaves one alone when billing cannot be read", async () => {
    expect(await pauseAdsForBlockedTenants()).toMatchObject({ tenants: 1, paused: 1 });
    expect(ads.pause).toHaveBeenCalledTimes(1);
    expect(ads.pause.mock.calls[0][0]).toBe("locked");
  });
  it("pauses a suspended workspace even if the admin action failed earlier", async () => {
    db.tenant.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({ status: where.id === "ok" ? "suspended" : "active", deletedAt: null }));
    await pauseAdsForBlockedTenants();
    expect(ads.pause.mock.calls.map((c) => c[0])).toContain("ok");
  });
});

describe("pauseAdsForBlockedTenants retry path after a failed pause", () => {
  const suspended = () => db.tenant.findUnique.mockResolvedValue({ status: "suspended", deletedAt: null });
  it("pauses the campaign on the next run and only then revokes the connection that had been kept", async () => {
    suspended();
    campaigns([{ id: "c1", adAccountAssetId: "a1" }]);
    db.metaConnection.findMany.mockResolvedValue([{ id: "m1" }]);
    db.metaAsset.findMany.mockResolvedValue([{ connectionId: "m1" }]);
    ads.pause.mockRejectedValueOnce(new Error("transient"));
    svc.disconnect.mockResolvedValue(undefined);
    expect(await pauseAdsForBlockedTenants()).toMatchObject({ tenants: 1, paused: 0, revoked: 0 });
    expect(svc.disconnect).not.toHaveBeenCalled();
    ads.pause.mockImplementation(async () => campaigns([]));
    expect(await pauseAdsForBlockedTenants()).toMatchObject({ tenants: 1, paused: 1, revoked: 1 });
    expect(svc.disconnect).toHaveBeenCalledTimes(1);
  });
  it("a billing-locked workspace gets its ads paused but keeps its connections so it can resume after paying", async () => {
    db.tenant.findUnique.mockResolvedValue({ status: "active", deletedAt: null });
    billing.getBillingStatus.mockResolvedValue({ canWrite: false });
    campaigns([{ id: "c1", adAccountAssetId: "a1" }]);
    ads.pause.mockResolvedValue({});
    db.metaConnection.findMany.mockResolvedValue([{ id: "m1" }]);
    await pauseAdsForBlockedTenants();
    expect(ads.pause).toHaveBeenCalledTimes(1);
    expect(svc.disconnect).not.toHaveBeenCalled();
  });
  it("a campaign that can never be paused adds one audit row in total, however many sweeps run", async () => {
    suspended();
    campaigns([{ id: "c1", adAccountAssetId: "a1" }]);
    ads.pause.mockRejectedValue(new Error("409 connection revoked"));
    let flagged = false;
    db.auditLog.findFirst.mockImplementation(async () => (flagged ? { id: "x" } : null));
    auditMock.mockImplementation(async () => {
      flagged = true;
    });
    for (let i = 0; i < 5; i++) await pauseAdsForBlockedTenants();
    expect(auditActions().filter((a) => a === "ads.campaign.pause_failed")).toHaveLength(1);
  });
  it("the sweep is registered as a 15 minute periodic task next to the daily optimizer run", async () => {
    const { worker } = await import("@/lib/optimizer/worker");
    const sweep = worker.periodic?.find((p) => p.name === "ads.pause-blocked");
    expect(sweep?.everyMs).toBe(15 * 60_000);
    expect(worker.periodic?.some((p) => p.name === "optimizer.daily")).toBe(true);
  });
});

describe("campaigns whose Meta connection is unusable (no usable connection: stop retrying, one audit row per failure state)", () => {
  const suspended = () => db.tenant.findUnique.mockResolvedValue({ status: "suspended", deletedAt: null });
  const unreachableAudits = () => auditActions().filter((a) => a === "ads.campaign.pause_unreachable");
  it("never calls Meta for them and flags each campaign exactly once however many sweeps run", async () => {
    trackLastError();
    suspended();
    meta.usable = false;
    campaigns([{ id: "c1", adAccountAssetId: "a1" }]);
    let flagged = false;
    db.auditLog.findFirst.mockImplementation(async () => (flagged ? { id: "x" } : null));
    auditMock.mockImplementation(async () => {
      flagged = true;
    });
    for (let i = 0; i < 6; i++) expect(await pauseAdsForBlockedTenants()).toMatchObject({ tenants: 1, paused: 0, unreachable: 1 });
    expect(ads.pause).not.toHaveBeenCalled();
    expect(unreachableAudits()).toHaveLength(1);
    // The audit lookup is bounded in time (a later episode is not hidden by an old row) and runs once: afterwards the campaign's own message is the marker.
    expect(db.auditLog.findFirst).toHaveBeenCalledTimes(1);
    expect(db.auditLog.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ tenantId: "t1", action: "ads.campaign.pause_unreachable", target: "c1", createdAt: { gte: expect.any(Date) } }) }));
    expect(db.adCampaign.updateMany).toHaveBeenCalledTimes(1);
  });
  it("a campaign that failed transiently and later lost its connection is two distinct states, so two audit rows in total", async () => {
    suspended();
    campaigns([{ id: "c1", adAccountAssetId: "a1" }]);
    ads.pause.mockRejectedValue(new Error("meta 5xx"));
    const flagged = new Set<string>();
    db.auditLog.findFirst.mockImplementation(async (arg: { where: { action: string } }) => (flagged.has(arg.where.action) ? { id: "x" } : null));
    auditMock.mockImplementation((async (e: { action: string }) => void flagged.add(e.action)) as never);
    await pauseAdsForBlockedTenants();
    await pauseAdsForBlockedTenants();
    meta.usable = false;
    await pauseAdsForBlockedTenants();
    await pauseAdsForBlockedTenants();
    expect(auditActions().filter((a) => a === "ads.campaign.pause_failed")).toHaveLength(1);
    expect(unreachableAudits()).toHaveLength(1);
    expect(ads.pause).toHaveBeenCalledTimes(2);
  });
  it("only the unreachable campaign is skipped: the other campaigns of the workspace are still paused", async () => {
    suspended();
    campaigns([
      { id: "c1", adAccountAssetId: "gone" },
      { id: "c2", adAccountAssetId: "ok" },
    ]);
    db.metaAsset.findMany.mockImplementation((async (arg: { select?: Record<string, unknown> }) =>
      arg.select?.connection
        ? [
            { id: "gone", status: "active", connection: { tenantId: "t1", status: "revoked", tokenEnc: "x", tokenExpiresAt: null } },
            { id: "ok", status: "active", connection: { tenantId: "t1", status: "active", tokenEnc: "x", tokenExpiresAt: null } },
          ]
        : [{ connectionId: "m1" }]) as never);
    ads.pause.mockResolvedValue({});
    await pauseAdsForBlockedTenants();
    expect(ads.pause).toHaveBeenCalledTimes(1);
    expect(ads.pause.mock.calls[0][1]).toBe("c2");
  });
  it("a lapsed token or a campaign that never reached Meta is handled without a pause call", async () => {
    suspended();
    campaigns([{ id: "c1", adAccountAssetId: "a1" }]);
    db.metaAsset.findMany.mockImplementation((async (arg: { select?: Record<string, unknown> }) =>
      arg.select?.connection ? [{ id: "a1", status: "active", connection: { tenantId: "t1", status: "active", tokenEnc: "x", tokenExpiresAt: new Date(Date.now() - 1000) } }] : []) as never);
    await pauseAdsForBlockedTenants();
    expect(ads.pause).not.toHaveBeenCalled();
    expect(db.adCampaign.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "t1", status: "active", metaCampaignId: { not: null } } }));
  });
  it("suspend reports it to the admin, and revokes the dead connection (nothing can be paused through it, so it does not keep the token alive)", async () => {
    meta.usable = false;
    campaigns([{ id: "c1", adAccountAssetId: "a1" }]);
    db.metaConnection.findMany.mockResolvedValue([{ id: "m1" }]);
    svc.disconnect.mockResolvedValue(undefined);
    const res = await applyTenantAction("admin", "t1", { action: "suspend", reason: "abuse", confirm: "Acme" });
    expect(res).toMatchObject({ ok: true, warning: expect.stringContaining("could not be paused") });
    expect(ads.pause).not.toHaveBeenCalled();
    expect(svc.disconnect).toHaveBeenCalledTimes(1);
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "admin.tenant.suspend", meta: expect.objectContaining({ adsPauseFailed: 1, connectionsRevoked: 1, connectionsDeferred: 0 }) }));
  });
  it("a connection with an unreachable campaign AND a reachable one is kept until the reachable one is paused", async () => {
    suspended();
    campaigns([
      { id: "c1", adAccountAssetId: "gone" },
      { id: "c2", adAccountAssetId: "ok" },
    ]);
    db.metaAsset.findMany.mockImplementation((async (arg: { select?: Record<string, unknown> }) =>
      arg.select?.connection
        ? [
            { id: "gone", connectionId: "dead", status: "active", connection: { tenantId: "t1", status: "revoked", tokenEnc: "x", tokenExpiresAt: null } },
            { id: "ok", connectionId: "live", status: "active", connection: { tenantId: "t1", status: "active", tokenEnc: "x", tokenExpiresAt: null } },
          ]
        : []) as never);
    db.metaConnection.findMany.mockResolvedValue([{ id: "dead" }, { id: "live" }]);
    ads.pause.mockRejectedValue(new Error("meta 5xx"));
    svc.disconnect.mockResolvedValue(undefined);
    await pauseAdsForBlockedTenants();
    expect(svc.disconnect.mock.calls.map((c) => c[1])).toEqual(["dead"]);
  });
});

describe("revoke failures and leftover connections are retried by the sweep", () => {
  const suspended = () => db.tenant.findUnique.mockResolvedValue({ status: "suspended", deletedAt: null });
  const noCampaigns = () => db.adCampaign.findMany.mockResolvedValue([]);
  it("a suspended workspace with every campaign paused but a connection that failed to revoke is visited again and the connection is revoked", async () => {
    suspended();
    noCampaigns();
    db.metaConnection.findMany.mockResolvedValue([{ id: "m1", tenantId: "t1" }]);
    db.tenant.findMany.mockResolvedValue([{ id: "t1" }]);
    svc.disconnect.mockRejectedValueOnce(new Error("meta down")).mockResolvedValue(undefined);
    expect(await pauseAdsForBlockedTenants()).toMatchObject({ tenants: 1, revoked: 0 });
    expect(await pauseAdsForBlockedTenants()).toMatchObject({ tenants: 1, revoked: 1 });
    expect(svc.disconnect).toHaveBeenCalledTimes(2);
    expect(db.tenant.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ OR: [{ status: "suspended" }, { deletedAt: { not: null } }] }) }));
  });
  it("only workspaces that are actually suspended or deleted are picked up that way (the filter is applied in the query)", async () => {
    noCampaigns();
    db.metaConnection.findMany.mockResolvedValue([{ tenantId: "t1" }]);
    db.tenant.findMany.mockResolvedValue([]);
    await pauseAdsForBlockedTenants();
    expect(svc.disconnect).not.toHaveBeenCalled();
    expect(ads.pause).not.toHaveBeenCalled();
  });
  it("a revoke that keeps failing writes one audit row, not one per sweep", async () => {
    suspended();
    noCampaigns();
    db.metaConnection.findMany.mockResolvedValue([{ id: "m1", tenantId: "t1" }]);
    db.tenant.findMany.mockResolvedValue([{ id: "t1" }]);
    svc.disconnect.mockRejectedValue(new Error("meta down"));
    let flagged = false;
    db.auditLog.findFirst.mockImplementation(async () => (flagged ? { id: "x" } : null));
    auditMock.mockImplementation((async () => void (flagged = true)) as never);
    for (let i = 0; i < 5; i++) await pauseAdsForBlockedTenants();
    expect(svc.disconnect).toHaveBeenCalledTimes(5);
    expect(auditActions().filter((a) => a === "meta_connect.disconnect_failed")).toHaveLength(1);
  });
  it("an unusable connection behind an unreachable campaign of a suspended workspace is revoked by the sweep; the campaign is not paused or retried", async () => {
    suspended();
    meta.usable = false;
    campaigns([{ id: "c1", adAccountAssetId: "a1" }]);
    db.metaConnection.findMany.mockResolvedValue([{ id: "m1", tenantId: "t1" }]);
    svc.disconnect.mockResolvedValue(undefined);
    expect(await pauseAdsForBlockedTenants()).toMatchObject({ tenants: 1, paused: 0, revoked: 1, unreachable: 1 });
    expect(ads.pause).not.toHaveBeenCalled();
  });
  it("a billing-locked workspace is never visited through its connections (it keeps them to resume after paying)", async () => {
    db.tenant.findUnique.mockResolvedValue({ status: "active", deletedAt: null });
    billing.getBillingStatus.mockResolvedValue({ canWrite: false });
    noCampaigns();
    db.metaConnection.findMany.mockResolvedValue([{ id: "m1", tenantId: "t1" }]);
    db.tenant.findMany.mockResolvedValue([]);
    await pauseAdsForBlockedTenants();
    expect(svc.disconnect).not.toHaveBeenCalled();
  });
  it("a failing connection read in the sweep does not stop the campaign part", async () => {
    suspended();
    campaigns([{ id: "c1", adAccountAssetId: "a1" }]);
    db.tenant.findMany.mockRejectedValue(new Error("db"));
    ads.pause.mockResolvedValue({});
    expect(await pauseAdsForBlockedTenants()).toMatchObject({ tenants: 1, paused: 1 });
  });
});

describe("a failure is flagged again in a later episode (suspend, recover, suspend again)", () => {
  it("the campaign's flag is cleared when the workspace is usable again, so the next failure writes a new audit row and message", async () => {
    trackLastError();
    campaigns([{ id: "c1", adAccountAssetId: "a1" }]);
    ads.pause.mockRejectedValue(new Error("meta 5xx"));
    // The audit row stays in the log, but it is older than the 24 hour window by the time of the second episode.
    const rows: Date[] = [];
    db.auditLog.findFirst.mockImplementation((async (arg: { where: { createdAt: { gte: Date } } }) => (rows.some((d) => d >= arg.where.createdAt.gte) ? { id: "x" } : null)) as never);
    auditMock.mockImplementation((async () => void rows.push(new Date())) as never);
    db.tenant.findUnique.mockResolvedValue({ status: "suspended", deletedAt: null });
    await pauseAdsForBlockedTenants();
    await pauseAdsForBlockedTenants();
    expect(auditActions().filter((a) => a === "ads.campaign.pause_failed")).toHaveLength(1);
    expect(lastError.c1).toContain("Could not pause");
    // unsuspended: the sweep sees a usable workspace and clears our message from its campaigns
    db.tenant.findUnique.mockResolvedValue({ status: "active", deletedAt: null });
    billing.getBillingStatus.mockResolvedValue({ canWrite: true });
    await pauseAdsForBlockedTenants();
    expect(lastError.c1).toBeNull();
    expect(db.adCampaign.updateMany).toHaveBeenCalledWith({ where: { tenantId: { in: ["t1"] }, status: "active", lastError: { in: expect.arrayContaining([expect.stringContaining("Could not pause")]) } }, data: { lastError: null } });
    // second episode, two days later
    rows.splice(0, rows.length, new Date(Date.now() - 2 * 86_400_000));
    db.tenant.findUnique.mockResolvedValue({ status: "suspended", deletedAt: null });
    await pauseAdsForBlockedTenants();
    expect(auditActions().filter((a) => a === "ads.campaign.pause_failed")).toHaveLength(2);
    expect(lastError.c1).toContain("Could not pause");
  });
  it("a failure message that someone else overwrote is not re-audited inside 24 hours", async () => {
    trackLastError();
    campaigns([{ id: "c1", adAccountAssetId: "a1" }]);
    ads.pause.mockRejectedValue(new Error("meta 5xx"));
    db.tenant.findUnique.mockResolvedValue({ status: "suspended", deletedAt: null });
    db.auditLog.findFirst.mockResolvedValue({ id: "recent" });
    lastError.c1 = "Some other error";
    await pauseAdsForBlockedTenants();
    expect(auditMock).not.toHaveBeenCalled();
  });
});

describe("billing lock pauses ads promptly (billing worker)", () => {
  it("registers a 5 minute lock sweep next to the reconcile task", async () => {
    const { worker } = await import("@/lib/billing/worker");
    const sweep = worker.periodic.find((p) => p.name === "billing.lock-pause-ads");
    expect(sweep?.everyMs).toBe(5 * 60_000);
    expect(worker.periodic.some((p) => p.name === "billing-reconcile")).toBe(true);
  });
  it("the sweep pauses a freshly locked workspace once, keeps its connections, and does nothing on the next run", async () => {
    const { worker } = await import("@/lib/billing/worker");
    const run = worker.periodic.find((p) => p.name === "billing.lock-pause-ads")!.run;
    db.tenant.findUnique.mockResolvedValue({ status: "active", deletedAt: null });
    billing.getBillingStatus.mockResolvedValue({ canWrite: false });
    let live = [{ id: "c1", adAccountAssetId: "a1" }];
    db.adCampaign.findMany.mockImplementation(async (arg: { select?: Record<string, boolean>; distinct?: string[] }) => {
      if (arg.distinct) return live.length ? [{ tenantId: "t1" }] : [];
      return arg.select?.id ? live : live.map((c) => ({ adAccountAssetId: c.adAccountAssetId }));
    });
    ads.pause.mockImplementation(async () => {
      live = [];
    });
    db.metaConnection.findMany.mockResolvedValue([{ id: "m1" }]);
    await run();
    await run();
    await run();
    expect(ads.pause).toHaveBeenCalledTimes(1);
    expect(svc.disconnect).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });
});
