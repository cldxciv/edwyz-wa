import { createHmac } from "node:crypto";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeSpendDb } from "./helpers/fake-spend-db";

const h = vi.hoisted(() => ({
  db: null as unknown as FakeSpendDb,
  disconnect: vi.fn(),
  anonymise: vi.fn(),
  fs: { lstat: vi.fn(), readdir: vi.fn(), rm: vi.fn(), unlink: vi.fn(), realpath: vi.fn() },
}));

vi.mock("@/lib/db", async () => {
  // The spend-aware fake wraps fake-db (same tables and events) and models the append-only triggers of 0009.
  const { createFakeSpendDb } = await import("./helpers/fake-spend-db");
  h.db = createFakeSpendDb();
  return { prisma: h.db.prisma };
});
vi.mock("@/lib/meta-connect/service", () => ({ disconnect: h.disconnect }));
vi.mock("@/lib/lifecycle/erasure", () => ({ anonymiseUser: h.anonymise }));
vi.mock("@/lib/admin/auth", () => ({
  isPlatformAdminEmail: (email: string) => email === "admin@edwyz.test",
  requirePlatformAdmin: async () => ({ actor: { userId: "admin1", tenantId: "t-admin", role: "owner" }, email: "admin@edwyz.test" }),
}));
vi.mock("node:fs/promises", () => ({ default: h.fs, ...h.fs }));

import { POST as eraseRoute } from "@/app/api/admin/tenants/[id]/erase/route";
import { POST as deletionCallback } from "@/app/api/meta/data-deletion/route";
import { processDeletionRequest, runDeletionRequestSweep } from "@/lib/lifecycle/deletion-requests";
import { eraseMetaConnectionData, eraseMetaUserData } from "@/lib/lifecycle/erase-meta";
import { eraseWorkspaceData, purgeAppendOnly, purgeGucValue, PURGE_GUC, tombstoneKey } from "@/lib/lifecycle/erase-workspace";
import { cleanupOrphanCreativeFiles, removeTenantFiles, resolveTenantDir } from "@/lib/lifecycle/files";
import { appendOnlyPurgeTables, deletableTables, lowerFirst } from "@/lib/lifecycle/personal-data";
import { worker } from "@/lib/lifecycle/worker";

process.env.DATA_DIR = path.resolve("/srv/wa-data");
process.env.SITE_URL = "https://wa.edwyz.com";
process.env.META_APP_SECRET = "app-secret";

const ISO = new Date("2026-10-27T00:00:00Z");

function seedTwoWorkspaces() {
  const { db } = h;
  for (const tenantId of ["t1", "t2"]) {
    db.seed("tenant", [{ id: tenantId, slug: `slug-${tenantId}`, deletedAt: null, status: "active" }]);
    for (const e of deletableTables()) {
      if (e.id === "Tenant") continue;
      const column = e.tenantColumn ?? "tenantId";
      db.seed(lowerFirst(e.id), [{ id: `${e.id}-${tenantId}`, [column]: tenantId }]);
    }
    db.seed("invoice", [{ id: `inv-${tenantId}`, tenantId }]);
    db.seed("spendLedger", [
      { id: `led-${tenantId}-1`, tenantId, phase: "requested", correlationId: `c-${tenantId}` },
      { id: `led-${tenantId}-2`, tenantId, phase: "applied", correlationId: `c-${tenantId}` },
    ]);
    db.seed("spendConsent", [{ id: `con-${tenantId}`, tenantId, userId: "u", kind: "meta_spend_cap", granted: true }]);
    db.seed("spendCeiling", [{ id: `ceil-${tenantId}`, scope: "tenant", scopeId: tenantId, pot: "ads", currency: "INR", dailyMinor: 100n }]);
  }
  db.seed("spendCeiling", [
    { id: "sc_probation_ads_inr", scope: "probation", scopeId: "*", pot: "ads", currency: "INR" },
    { id: "plan-t1", scope: "plan", scopeId: "t1", pot: "ads", currency: "INR" },
  ]);
}

beforeEach(() => {
  for (const k of Object.keys(h.db.tables)) delete h.db.tables[k];
  h.db.events.length = 0;
  h.db.raw.length = 0;
  h.db.transactions.length = 0;
  for (const fn of [h.disconnect, h.anonymise, ...Object.values(h.fs)]) fn.mockReset();
  h.disconnect.mockResolvedValue(undefined);
  h.anonymise.mockResolvedValue({ found: true, retainedWorkspaceIds: [] });
  h.fs.lstat.mockRejectedValue(new Error("ENOENT"));
  h.fs.readdir.mockResolvedValue([]);
  h.fs.realpath.mockImplementation(async (p: string) => p);
  h.fs.rm.mockResolvedValue(undefined);
  h.fs.unlink.mockResolvedValue(undefined);
});

describe("eraseWorkspaceData", () => {
  it("deletes every listed table for the workspace and leaves other workspaces and invoices alone", async () => {
    seedTwoWorkspaces();
    h.db.seed("platformSetting", [
      { key: "ads:caps:t1", value: {} },
      { key: "ads:caps:t2", value: {} },
      { key: "meta-connect-state:n1", value: { tenantId: "t1", userId: "u" } },
      { key: "meta-connect-state:n2", value: { tenantId: "t2", userId: "u" } },
      { key: "settings", value: {} },
    ]);
    h.db.seed("job", [
      { id: "j1", payload: { tenantId: "t1" } },
      { id: "j2", payload: { tenantId: "t2" } },
      { id: "j3", payload: { eventId: "e" } },
    ]);

    const result = await eraseWorkspaceData("t1", { now: ISO });

    for (const e of deletableTables()) {
      if (e.id === "Tenant") continue;
      const rows = h.db.rows(lowerFirst(e.id));
      const column = e.tenantColumn ?? "tenantId";
      expect(rows.filter((r) => r[column] === "t1"), `${e.id} still has t1 rows`).toEqual([]);
      expect(rows.filter((r) => r[column] === "t2"), `${e.id} lost t2 rows`).toHaveLength(1);
      expect(result.counts[e.id], e.id).toBeGreaterThanOrEqual(1);
    }
    expect(h.db.rows("invoice").map((r) => r.id).sort()).toEqual(["inv-t1", "inv-t2"]);
    expect(h.db.rows("platformSetting").map((r) => r.key).filter((k) => !String(k).startsWith("erasure:")).sort()).toEqual(["ads:caps:t2", "meta-connect-state:n2", "settings"]);
    expect(h.db.rows("job").map((r) => r.id).sort()).toEqual(["j2", "j3"]);
    expect(h.db.rows("tenant").map((r) => r.id)).toEqual(["t2"]);
    expect(result.tenantFound).toBe(true);
    // The append-only spend tables are purged too, for this workspace only.
    for (const e of appendOnlyPurgeTables()) {
      const rows = h.db.rows(lowerFirst(e.id));
      expect(rows.filter((r) => r.tenantId === "t1"), e.id).toEqual([]);
      expect(rows.filter((r) => r.tenantId === "t2").length, e.id).toBeGreaterThan(0);
    }
    expect(result.counts).toMatchObject({ SpendLedger: 2, SpendConsent: 1, SpendCeiling: 1 });
  });

  it("purges SpendLedger and SpendConsent inside ONE transaction, setting edwyz.purge before each delete", async () => {
    seedTwoWorkspaces();
    await eraseWorkspaceData("t1", { now: ISO });
    const purgeTx = h.db.transactions.find((t) => h.db.raw.some((r) => r.tx === t.id));
    expect(purgeTx?.status).toBe("committed");
    const calls = h.db.raw.filter((r) => r.tx === purgeTx!.id);
    expect(calls.map((c) => [c.sql.replace(/\s+/g, " "), c.values])).toEqual([
      ["SELECT set_config('edwyz.purge', $?, true)", ["SpendLedger:t1"]],
      ["SELECT set_config('edwyz.purge', $?, true)", ["SpendConsent:t1"]],
    ]);
    const from = h.db.events.indexOf(`tx:begin:${purgeTx!.id}`);
    const to = h.db.events.indexOf(`tx:commit:${purgeTx!.id}`);
    expect(h.db.events.slice(from + 1, to)).toEqual([
      "raw:SELECT set_config('edwyz.purge', $?, true)",
      "delete:spendLedger",
      "raw:SELECT set_config('edwyz.purge', $?, true)",
      "delete:spendConsent",
    ]);
    expect(PURGE_GUC).toBe("edwyz.purge");
  });

  it("cannot delete ledger or consent rows outside that transaction (the fake models the 0009 trigger)", async () => {
    seedTwoWorkspaces();
    await expect(h.db.model("spendLedger").deleteMany({ where: { tenantId: "t1" } })).rejects.toMatchObject({ sqlState: "42501" });
    await expect(h.db.model("spendConsent").updateMany({ where: { tenantId: "t1" }, data: { granted: false } })).rejects.toMatchObject({ sqlState: "42501" });
    // set_config(..., true) outside a transaction lasts for one statement only, so it opens nothing.
    await (h.db.prisma as unknown as { $executeRaw: (s: TemplateStringsArray, ...v: unknown[]) => Promise<number> }).$executeRaw`SELECT set_config('edwyz.purge', ${"SpendLedger:t1"}, true)`;
    await expect(h.db.model("spendLedger").deleteMany({ where: { tenantId: "t1" } })).rejects.toMatchObject({ sqlState: "42501" });
    expect(h.db.rows("spendLedger").filter((r) => r.tenantId === "t1")).toHaveLength(2);
  });

  it("opens the purge for ONE workspace: a delete that reaches another workspace's rows is refused (repair)", async () => {
    seedTwoWorkspaces();
    const prisma = h.db.prisma as unknown as {
      $transaction: <T>(fn: (tx: { $executeRaw: (s: TemplateStringsArray, ...v: unknown[]) => Promise<number>; spendLedger: { deleteMany: (a: unknown) => Promise<{ count: number }> } }) => Promise<T>) => Promise<T>;
    };
    // The old table-only value no longer opens anything.
    await expect(prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('edwyz.purge', ${"SpendLedger"}, true)`;
      return tx.spendLedger.deleteMany({ where: { tenantId: "t1" } });
    })).rejects.toMatchObject({ sqlState: "42501" });
    // An erasure query that lost its tenant filter fails on t2's rows instead of wiping them.
    await expect(prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('edwyz.purge', ${purgeGucValue("SpendLedger", "t1")}, true)`;
      return tx.spendLedger.deleteMany({});
    })).rejects.toMatchObject({ sqlState: "42501" });
    expect(h.db.rows("spendLedger").filter((r) => r.tenantId === "t2").length).toBeGreaterThan(0);
    expect(h.db.rows("spendLedger").filter((r) => r.tenantId === "t1")).toHaveLength(2);
    expect(purgeGucValue("SpendConsent", "t9")).toBe("SpendConsent:t9");
  });

  it("rolls the purge back as a whole and stops the erasure when a delete fails", async () => {
    seedTwoWorkspaces();
    h.db.failNext("spendConsent", "deleteMany", new Error("lock timeout"));
    await expect(eraseWorkspaceData("t1", { now: ISO })).rejects.toThrow("lock timeout");
    expect(h.db.rows("spendLedger").filter((r) => r.tenantId === "t1")).toHaveLength(2);
    expect(h.db.rows("tenant").map((r) => r.id).sort()).toEqual(["t1", "t2"]);
    expect(h.db.transactions.at(-1)?.status).toBe("rolled_back");
    // A second run finishes the job.
    await eraseWorkspaceData("t1", { now: ISO });
    expect(h.db.rows("spendLedger").filter((r) => r.tenantId === "t1")).toEqual([]);
  });

  it("deletes only the workspace's own scope 'tenant' SpendCeiling rows", async () => {
    seedTwoWorkspaces();
    const result = await eraseWorkspaceData("t1", { now: ISO });
    expect(h.db.rows("spendCeiling").map((r) => r.id).sort()).toEqual(["ceil-t2", "plan-t1", "sc_probation_ads_inr"]);
    expect(result.counts.SpendCeiling).toBe(1);
  });

  it("purgeAppendOnly refuses unsafe ids and reports counts", async () => {
    await expect(purgeAppendOnly("../t1")).rejects.toMatchObject({ status: 400 });
    seedTwoWorkspaces();
    expect(await purgeAppendOnly("t2")).toEqual({ SpendLedger: 2, SpendConsent: 1 });
    expect(await purgeAppendOnly("t2")).toEqual({ SpendLedger: 0, SpendConsent: 0 });
  });

  it("erases the workspace's API keys explicitly, so an erased workspace's tokens cannot authenticate (no separate revoke step is needed)", async () => {
    expect(deletableTables().map((e) => e.id)).toContain("ApiKey");
    h.db.seed("tenant", [{ id: "t1", slug: "s1", deletedAt: null, status: "active" }, { id: "t2", slug: "s2", deletedAt: null, status: "active" }]);
    h.db.seed("apiKey", [
      { id: "k1", tenantId: "t1", keyHash: "h1", revokedAt: null },
      { id: "k2", tenantId: "t2", keyHash: "h2", revokedAt: null },
    ]);
    const result = await eraseWorkspaceData("t1", { now: ISO });
    expect(h.db.rows("apiKey").map((r) => r.id)).toEqual(["k2"]);
    expect(result.counts.ApiKey).toBe(1);
  });

  it("writes a tombstone with a hash and a date only", async () => {
    seedTwoWorkspaces();
    await eraseWorkspaceData("t1", { now: ISO });
    const tomb = h.db.rows("platformSetting").find((r) => String(r.key).startsWith("erasure:"))!;
    expect(tomb.key).toBe(tombstoneKey("t1"));
    expect(tomb.key).toMatch(/^erasure:tenant:[0-9a-f]{32}$/);
    expect(tomb.value).toEqual({ erasedAt: ISO.toISOString() });
    expect(JSON.stringify(tomb)).not.toContain("t1\"");
    expect(h.db.rows("auditLog").filter((r) => r.tenantId === "t1")).toEqual([]);
  });

  it("revokes active Meta connections before any row is deleted", async () => {
    h.db.seed("tenant", [{ id: "t1", slug: "s1" }]);
    h.db.seed("metaConnection", [
      { id: "c1", tenantId: "t1", status: "active", tokenEnc: "x" },
      { id: "c2", tenantId: "t1", status: "revoked", tokenEnc: "" },
      { id: "c3", tenantId: "t1", status: "expiring", tokenEnc: "y" },
      { id: "c9", tenantId: "t2", status: "active", tokenEnc: "z" },
    ]);
    h.disconnect.mockImplementation(async (_a: unknown, id: string) => {
      h.db.events.push(`disconnect:${id}`);
      if (id === "c3") throw new Error("meta down");
    });
    const result = await eraseWorkspaceData("t1");
    expect(h.disconnect.mock.calls.map((c) => c[1]).sort()).toEqual(["c1", "c3"]);
    expect(h.disconnect.mock.calls[0][0]).toMatchObject({ tenantId: "t1", userId: "system" });
    const firstDelete = h.db.events.findIndex((e) => e.startsWith("delete:"));
    const lastDisconnect = h.db.events.map((e) => e.startsWith("disconnect:")).lastIndexOf(true);
    expect(lastDisconnect).toBeLessThan(firstDelete);
    expect(result.connectionsRevoked).toBe(1);
    expect(result.connectionsRevokeFailed).toBe(1);
    expect(h.db.rows("metaConnection").map((r) => r.id)).toEqual(["c9"]);
  });

  it("overwrites sealed secrets before deleting their rows", async () => {
    h.db.seed("tenant", [{ id: "t1", slug: "s1" }]);
    h.db.seed("accessToken", [{ id: "a1", tenantId: "t1", tokenCiphertext: "cipher", iv: "iv", authTag: "tag" }]);
    h.db.seed("shopifyStore", [{ id: "s1", tenantId: "t1", tokenEnc: "tok", webhookSecretEnc: "sec" }]);
    const snapshots: Record<string, unknown>[] = [];
    const rows = h.db.rows("accessToken");
    const original = h.db.prisma.accessToken as { deleteMany: (a: unknown) => Promise<unknown> };
    const del = original.deleteMany.bind(original);
    original.deleteMany = async (a: unknown) => {
      snapshots.push({ ...rows[0] });
      return del(a);
    };
    await eraseWorkspaceData("t1");
    expect(snapshots[0]).toMatchObject({ tokenCiphertext: "", iv: "", authTag: "" });
    expect(h.db.events.indexOf("update:accessToken")).toBeLessThan(h.db.events.indexOf("delete:accessToken"));
    expect(h.db.events.indexOf("update:shopifyStore")).toBeLessThan(h.db.events.indexOf("delete:shopifyStore"));
  });

  it("removes the workspace's files only after the rows are gone", async () => {
    h.db.seed("tenant", [{ id: "t1", slug: "s1" }]);
    await eraseWorkspaceData("t1");
    const removed = h.fs.rm.mock.calls.map((c) => c[0]);
    expect(removed).toEqual([]);
    h.fs.lstat.mockResolvedValue({ isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false });
    h.fs.readdir.mockResolvedValue(["a.png", "b.png"]);
    h.db.seed("tenant", [{ id: "t1", slug: "s1" }]);
    const result = await eraseWorkspaceData("t1");
    expect(h.fs.rm.mock.calls.map((c) => c[0])).toEqual([
      path.resolve(process.env.DATA_DIR!, "creative", "t1"),
      path.resolve(process.env.DATA_DIR!, "content", "t1"),
      path.resolve(process.env.DATA_DIR!, "inbound-media", "t1"),
    ]);
    expect(result.files).toEqual({ creative: 2, content: 2, "inbound-media": 2 });
  });

  it("refuses unsafe ids", async () => {
    for (const bad of ["", "../t1", "a/b", "t1;drop", "x".repeat(65)]) {
      await expect(eraseWorkspaceData(bad)).rejects.toMatchObject({ status: 400 });
    }
    expect(h.db.events).toEqual([]);
  });

  it("stops while a Razorpay subscription is active unless the operator confirms", async () => {
    seedTwoWorkspaces();
    h.db.tables.subscription = [{ id: "s", tenantId: "t1", status: "active", razorpaySubscriptionId: "sub_1" }, { id: "s2", tenantId: "t2" }];
    await expect(eraseWorkspaceData("t1")).rejects.toMatchObject({ status: 409 });
    expect(h.db.rows("contact")).toHaveLength(2);
    await eraseWorkspaceData("t1", { allowActiveSubscription: true });
    expect(h.db.rows("contact")).toHaveLength(1);
  });

  it("anonymises members left without a workspace, but not admins or members of other workspaces", async () => {
    h.db.seed("tenant", [{ id: "t1", slug: "s1" }, { id: "t2", slug: "s2" }]);
    h.db.seed("user", [
      { id: "u-orphan", email: "o@x.test" },
      { id: "u-admin", email: "admin@edwyz.test" },
      { id: "u-multi", email: "m@x.test" },
    ]);
    h.db.seed("membership", [
      { id: "m1", tenantId: "t1", userId: "u-orphan" },
      { id: "m2", tenantId: "t1", userId: "u-admin" },
      { id: "m3", tenantId: "t1", userId: "u-multi" },
      { id: "m4", tenantId: "t2", userId: "u-multi" },
    ]);
    const result = await eraseWorkspaceData("t1");
    expect(h.anonymise.mock.calls).toEqual([["u-orphan"]]);
    expect(result.usersAnonymised).toBe(1);
    expect(h.db.rows("membership").map((r) => r.id)).toEqual(["m4"]);
  });

  it("removes webhook events that carry only the workspace's WhatsApp account or number", async () => {
    h.db.seed("tenant", [{ id: "t1", slug: "s1" }]);
    h.db.seed("waba", [{ id: "w1", tenantId: "t1", wabaId: "waba-1" }]);
    h.db.seed("phoneNumber", [{ id: "p1", tenantId: "t1", phoneNumberId: "pn-1" }]);
    h.db.seed("webhookEvent", [
      { id: "e1", tenantId: null, wabaId: "waba-1", phoneNumberId: null },
      { id: "e2", tenantId: null, wabaId: null, phoneNumberId: "pn-1" },
      { id: "e3", tenantId: null, wabaId: "waba-9", phoneNumberId: "pn-9" },
    ]);
    await eraseWorkspaceData("t1");
    expect(h.db.rows("webhookEvent").map((r) => r.id)).toEqual(["e3"]);
  });

  it("can be run again after the workspace row is gone", async () => {
    seedTwoWorkspaces();
    await eraseWorkspaceData("t1");
    const again = await eraseWorkspaceData("t1");
    expect(again.tenantFound).toBe(false);
    expect(h.db.rows("contact")).toHaveLength(1);
  });
});

function seedMeta() {
  const { db } = h;
  db.seed("metaConnection", [
    { id: "c1", tenantId: "t1", metaUserId: "fb1", status: "active", tokenEnc: "x" },
    { id: "c2", tenantId: "t1", metaUserId: "fb2", status: "active", tokenEnc: "y" },
    { id: "c3", tenantId: "t2", metaUserId: "fb1", status: "revoked", tokenEnc: "" },
  ]);
  db.seed("metaAsset", [
    { id: "pg1", tenantId: "t1", connectionId: "c1", type: "page", externalId: "P1" },
    { id: "ac1", tenantId: "t1", connectionId: "c1", type: "ad_account", externalId: "A1" },
    { id: "ds1", tenantId: "t1", connectionId: "c1", type: "dataset", externalId: "D1" },
    { id: "pg2", tenantId: "t1", connectionId: "c2", type: "page", externalId: "P2" },
    { id: "ac2", tenantId: "t1", connectionId: "c2", type: "ad_account", externalId: "A2" },
    { id: "pg3", tenantId: "t2", connectionId: "c3", type: "page", externalId: "P3" },
  ]);
  db.seed("leadForm", [
    { id: "f1", tenantId: "t1", pageAssetId: "pg1" },
    { id: "f2", tenantId: "t1", pageAssetId: "pg2" },
    { id: "f3", tenantId: "t2", pageAssetId: "pg3" },
  ]);
  db.seed("lead", [
    { id: "l1", tenantId: "t1", leadFormId: "f1", contactId: "k-lead" },
    { id: "l2", tenantId: "t1", leadFormId: "f1", contactId: "k-chatty" },
    { id: "l3", tenantId: "t1", leadFormId: "f2", contactId: "k-other" },
    { id: "l4", tenantId: "t2", leadFormId: "f3", contactId: null },
  ]);
  db.seed("contact", [
    { id: "k-lead", tenantId: "t1", optInSource: "lead_form" },
    { id: "k-chatty", tenantId: "t1", optInSource: "lead_form" },
    { id: "k-other", tenantId: "t1", optInSource: "lead_form" },
    { id: "k-wa", tenantId: "t1", optInSource: "whatsapp" },
  ]);
  db.seed("conversation", [{ id: "v1", tenantId: "t1", contactId: "k-chatty" }]);
  db.seed("message", [{ id: "msg1", tenantId: "t1", conversationId: "v1" }]);
  db.seed("leadSequenceRun", [
    { id: "r1", tenantId: "t1", leadId: "l1" },
    { id: "r3", tenantId: "t1", leadId: "l3" },
  ]);
  db.seed("conversionEvent", [
    { id: "ce1", tenantId: "t1", leadId: "l1", datasetId: "" },
    { id: "ce2", tenantId: "t1", leadId: null, datasetId: "D1" },
    { id: "ce3", tenantId: "t1", leadId: "l3", datasetId: "D2" },
  ]);
  db.seed("adCampaign", [
    { id: "ca1", tenantId: "t1", adAccountAssetId: "ac1", metaCampaignId: "MC1" },
    { id: "ca2", tenantId: "t1", adAccountAssetId: "ac2", metaCampaignId: "MC2" },
  ]);
  db.seed("adSet", [
    { id: "as1", tenantId: "t1", campaignId: "ca1", metaAdSetId: "MS1" },
    { id: "as2", tenantId: "t1", campaignId: "ca2", metaAdSetId: "MS2" },
  ]);
  db.seed("ad", [
    { id: "ad1", tenantId: "t1", adSetId: "as1", metaAdId: "MA1" },
    { id: "ad2", tenantId: "t1", adSetId: "as2", metaAdId: "MA2" },
  ]);
  db.seed("insightSnapshot", [
    { id: "i1", tenantId: "t1", entityMetaId: "MC1" },
    { id: "i2", tenantId: "t1", entityMetaId: "MA1" },
    { id: "i3", tenantId: "t1", entityMetaId: "MC2" },
  ]);
  db.seed("optimizerProposal", [
    { id: "o1", tenantId: "t1", targetMetaId: "MS1" },
    { id: "o2", tenantId: "t1", targetMetaId: "MS2" },
  ]);
  db.seed("approvalRequest", [
    { id: "ap1", tenantId: "t1", subjectType: "ad_campaign", subjectId: "ca1" },
    { id: "ap2", tenantId: "t1", subjectType: "ad_campaign", subjectId: "ca2" },
    { id: "ap3", tenantId: "t1", subjectType: "creative_asset", subjectId: "ca1" },
  ]);
  db.seed("platformSetting", [
    { key: "approval:ad_campaign:t1:ca1", value: {} },
    { key: "approval:ad_campaign:t1:ca2", value: {} },
  ]);
  db.seed("postTarget", [
    { id: "pt1", tenantId: "t1", assetId: "pg1" },
    { id: "pt2", tenantId: "t1", assetId: "pg2" },
  ]);
  db.seed("scheduledPost", [{ id: "sp1", tenantId: "t1" }]);
  db.seed("broadcastRecipient", []);
}

const ids = (name: string) => h.db.rows(name).map((r) => r.id).sort();

describe("eraseMetaConnectionData", () => {
  it("erases one connection, its assets and what came only from it", async () => {
    seedMeta();
    const counts = await eraseMetaConnectionData("t1", "c1");

    expect(h.disconnect).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "t1" }), "c1");
    expect(ids("metaConnection")).toEqual(["c2", "c3"]);
    expect(ids("metaAsset")).toEqual(["ac2", "pg2", "pg3"]);
    expect(ids("leadForm")).toEqual(["f2", "f3"]);
    expect(ids("lead")).toEqual(["l3", "l4"]);
    expect(ids("leadSequenceRun")).toEqual(["r3"]);
    expect(ids("conversionEvent")).toEqual(["ce3"]);
    expect(ids("adCampaign")).toEqual(["ca2"]);
    expect(ids("adSet")).toEqual(["as2"]);
    expect(ids("ad")).toEqual(["ad2"]);
    expect(ids("insightSnapshot")).toEqual(["i3"]);
    expect(ids("optimizerProposal")).toEqual(["o2"]);
    expect(ids("approvalRequest")).toEqual(["ap2", "ap3"]);
    expect(h.db.rows("platformSetting").map((r) => r.key)).toEqual(["approval:ad_campaign:t1:ca2"]);
    expect(ids("postTarget")).toEqual(["pt2"]);
    expect(counts).toMatchObject({ MetaConnection: 1, MetaAsset: 3, Lead: 2, LeadForm: 1, AdCampaign: 1 });
  });

  it("keeps WhatsApp data, posts and contacts that are used elsewhere", async () => {
    seedMeta();
    await eraseMetaConnectionData("t1", "c1");
    expect(ids("contact")).toEqual(["k-chatty", "k-other", "k-wa"]);
    expect(ids("conversation")).toEqual(["v1"]);
    expect(ids("message")).toEqual(["msg1"]);
    expect(ids("scheduledPost")).toEqual(["sp1"]);
  });

  it("still erases when Meta cannot be reached, and does nothing for another workspace's connection id", async () => {
    seedMeta();
    h.disconnect.mockRejectedValue(new Error("down"));
    expect(await eraseMetaConnectionData("t2", "c1")).toEqual({});
    expect(ids("metaConnection")).toEqual(["c1", "c2", "c3"]);
    await eraseMetaConnectionData("t1", "c1");
    expect(ids("metaConnection")).toEqual(["c2", "c3"]);
  });

  it("does not call disconnect for an already revoked connection", async () => {
    seedMeta();
    await eraseMetaConnectionData("t2", "c3");
    expect(h.disconnect).not.toHaveBeenCalled();
    expect(ids("lead")).toEqual(["l1", "l2", "l3"]);
  });
});

describe("eraseMetaUserData", () => {
  it("finds every workspace that connected this Facebook user and leaves other users' connections", async () => {
    seedMeta();
    const out = await eraseMetaUserData("fb1");
    expect(out).toMatchObject({ connections: 2, workspaces: 2 });
    expect(ids("metaConnection")).toEqual(["c2"]);
    expect(ids("metaAsset")).toEqual(["ac2", "pg2"]);
    expect(ids("lead")).toEqual(["l3"]);
  });

  it("matches nothing for an unknown user", async () => {
    seedMeta();
    expect(await eraseMetaUserData("nobody")).toEqual({ connections: 0, workspaces: 0, counts: {} });
    expect(ids("metaConnection")).toEqual(["c1", "c2", "c3"]);
  });
});

describe("Meta data-deletion requests", () => {
  beforeEach(() => {
    process.env.META_APP_SECRET = "app-secret";
  });

  it("erases the user's connections and completes the request without keeping the user id", async () => {
    seedMeta();
    const code = "0123456789abcdef01";
    h.db.seed("platformSetting", [{ key: `deletion:${code}`, value: { code, userId: "fb1", receivedAt: "2026-10-27T00:00:00Z", status: "received" } }]);
    expect(await processDeletionRequest(code, ISO)).toBe("completed");
    const value = h.db.rows("platformSetting").find((r) => r.key === `deletion:${code}`)!.value as Record<string, unknown>;
    expect(value).toMatchObject({ status: "completed", outcome: { connections: 2, workspaces: 2 }, completedAt: ISO.toISOString() });
    expect(String(value.userId)).toMatch(/^erased:[0-9a-f]{16}$/);
    expect(await processDeletionRequest(code)).toBe("skipped");
  });

  it("completes with zero connections when nothing is stored under that user id", async () => {
    const code = "0123456789abcdef02";
    h.db.seed("platformSetting", [{ key: `deletion:${code}`, value: { code, userId: "ghost", receivedAt: "x", status: "received" } }]);
    expect(await processDeletionRequest(code)).toBe("completed");
    const value = h.db.rows("platformSetting").find((r) => r.key === `deletion:${code}`)!.value as Record<string, unknown>;
    expect(value).toMatchObject({ status: "completed", outcome: { connections: 0, workspaces: 0 } });
  });

  it("stays received and counts the failure when erasure throws", async () => {
    seedMeta();
    h.db.seed("platformSetting", [{ key: "deletion:0123456789abcdef03", value: { code: "0123456789abcdef03", userId: "fb1", receivedAt: "x", status: "received" } }]);
    const finder = h.db.prisma.metaConnection as { findMany: () => Promise<unknown> };
    const original = finder.findMany;
    finder.findMany = async () => {
      throw new Error("db");
    };
    expect(await processDeletionRequest("0123456789abcdef03")).toBe("failed");
    finder.findMany = original;
    const value = h.db.rows("platformSetting").find((r) => r.key === "deletion:0123456789abcdef03")!.value as Record<string, unknown>;
    expect(value).toMatchObject({ status: "received", failedAttempts: 1 });
  });

  it("sweeps received requests and skips ones that failed too often", async () => {
    seedMeta();
    h.db.seed("platformSetting", [
      { key: "deletion:0123456789abcdef04", value: { code: "0123456789abcdef04", userId: "fb2", receivedAt: "x", status: "received" } },
      { key: "deletion:0123456789abcdef05", value: { code: "0123456789abcdef05", userId: "fb1", receivedAt: "x", status: "received", failedAttempts: 10 } },
      { key: "deletion:0123456789abcdef06", value: { code: "0123456789abcdef06", userId: "fb1", receivedAt: "x", status: "completed" } },
    ]);
    expect(await runDeletionRequestSweep()).toEqual({ completed: 1, failed: 0 });
    expect(ids("metaConnection")).toEqual(["c1", "c3"]);
  });

  it("is registered as a periodic worker task next to the personal-data retention", () => {
    const names = worker.periodic.map((p) => p.name);
    expect(names).toContain("lifecycle.deletion-requests");
    expect(names).toContain("lifecycle.retention-personal-data");
    expect(Object.keys(worker.queues)).toEqual(["email"]);
  });

  it("the callback records the request, answers with a code and starts the erasure", async () => {
    seedMeta();
    const payload = Buffer.from(JSON.stringify({ algorithm: "HMAC-SHA256", user_id: "fb2" })).toString("base64url");
    const sig = createHmac("sha256", "app-secret").update(payload).digest("base64url");
    const body = new URLSearchParams({ signed_request: `${sig}.${payload}` });
    const res = await deletionCallback(new Request("https://wa.edwyz.com/api/meta/data-deletion", { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" } }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { confirmation_code: string; url: string };
    expect(json.confirmation_code).toMatch(/^[0-9a-f]{18}$/);
    expect(json.url).toContain(`/data-deletion/status?code=${json.confirmation_code}`);
    await vi.waitFor(() => expect(ids("metaConnection")).toEqual(["c1", "c3"]));
    await vi.waitFor(() => expect((h.db.rows("platformSetting").find((r) => r.key === `deletion:${json.confirmation_code}`)!.value as { status: string }).status).toBe("completed"));
  });
});

describe("admin erase route", () => {
  const call = (id: string, body: object, origin = "https://wa.edwyz.com") =>
    eraseRoute(new Request(`https://wa.edwyz.com/api/admin/tenants/${id}/erase`, { method: "POST", body: JSON.stringify(body), headers: { origin, "content-type": "application/json" } }), {
      params: Promise.resolve({ id }),
    });

  it("needs the workspace slug typed back", async () => {
    seedTwoWorkspaces();
    const wrong = await call("t1", { reason: "customer request", confirm: "t1" });
    expect(wrong.status).toBe(400);
    const missing = await call("t1", { reason: "customer request" });
    expect(missing.status).toBe(400);
    expect(h.db.rows("contact")).toHaveLength(2);
  });

  it("needs a reason, a same-origin request and an existing workspace", async () => {
    seedTwoWorkspaces();
    expect((await call("t1", { confirm: "slug-t1" })).status).toBe(400);
    expect((await call("t1", { reason: "r", confirm: "slug-t1" }, "https://evil.example")).status).toBe(403);
    expect((await call("nope", { reason: "r", confirm: "x" })).status).toBe(404);
    expect(h.db.rows("contact")).toHaveLength(2);
  });

  it("erases with the right slug and audits without the workspace id or counts of personal data", async () => {
    seedTwoWorkspaces();
    const res = await call("t1", { reason: "customer request", confirm: "slug-t1" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, erased: true });
    expect(h.db.rows("contact").map((r) => r.tenantId)).toEqual(["t2"]);
    const audits = h.db.rows("auditLog").filter((r) => String(r.action).startsWith("admin.tenant.erase"));
    expect(audits.map((a) => a.action)).toEqual(["admin.tenant.erase_started", "admin.tenant.erased"]);
    for (const a of audits) {
      expect(a.tenantId).toBeNull();
      expect(JSON.stringify(a)).not.toContain('"t1"');
    }
  });

  it("reports a failure to the admin and audits it", async () => {
    seedTwoWorkspaces();
    h.db.tables.subscription = [{ id: "s", tenantId: "t1", status: "past_due", razorpaySubscriptionId: "sub_1" }];
    const res = await call("t1", { reason: "r", confirm: "slug-t1" });
    expect(res.status).toBe(409);
    expect(h.db.rows("auditLog").map((a) => a.action)).toContain("admin.tenant.erase_failed");
    const ok = await call("t1", { reason: "r", confirm: "slug-t1", subscription: "cancelled" });
    expect(ok.status).toBe(200);
  });
});

describe("file removal", () => {
  const root = (store: string, tenant = "") => path.resolve(process.env.DATA_DIR!, store, tenant);
  const dirStat = { isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false };

  it("resolves only plain ids to a direct child of the store directory", () => {
    expect(resolveTenantDir("creative", "tenant_1-A")).toBe(root("creative", "tenant_1-A"));
    for (const bad of ["", ".", "..", "../content/t1", "a/b", "a\\b", "t1/..", "%2e%2e", "t 1", "x".repeat(65)]) {
      expect(resolveTenantDir("creative", bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("removes all three store directories of the workspace (including cached customer media) and nothing else", async () => {
    h.fs.lstat.mockResolvedValue(dirStat);
    h.fs.readdir.mockResolvedValue(["x.png"]);
    const out = await removeTenantFiles("t1");
    expect(out).toEqual({ creative: 1, content: 1, "inbound-media": 1 });
    expect(h.fs.rm).toHaveBeenCalledTimes(3);
    expect(h.fs.rm).toHaveBeenCalledWith(root("creative", "t1"), { recursive: true, force: true });
    expect(h.fs.rm).toHaveBeenCalledWith(root("content", "t1"), { recursive: true, force: true });
    expect(h.fs.rm).toHaveBeenCalledWith(root("inbound-media", "t1"), { recursive: true, force: true });
  });

  it("does nothing when the directory does not exist", async () => {
    expect(await removeTenantFiles("t1")).toEqual({ creative: 0, content: 0, "inbound-media": 0 });
    expect(h.fs.rm).not.toHaveBeenCalled();
  });

  it("unlinks a symlink instead of following it", async () => {
    h.fs.lstat.mockResolvedValue({ isSymbolicLink: () => true, isDirectory: () => false, isFile: () => false });
    await removeTenantFiles("t1");
    expect(h.fs.rm).not.toHaveBeenCalled();
    expect(h.fs.unlink).toHaveBeenCalledTimes(3);
  });

  it("refuses a directory whose real path leaves the data directory", async () => {
    h.fs.lstat.mockResolvedValue(dirStat);
    h.fs.realpath.mockImplementation(async (p: string) => (p === root("creative", "t1") ? path.resolve("/etc/elsewhere") : p));
    await expect(removeTenantFiles("t1")).rejects.toThrow(/outside the data directory/);
    expect(h.fs.rm).not.toHaveBeenCalled();
  });

  it("rejects an unsafe workspace id before touching the disk", async () => {
    await expect(removeTenantFiles("../x")).rejects.toThrow();
    expect(h.fs.lstat).not.toHaveBeenCalled();
  });

  it("deletes only unreferenced creative files older than the grace period", async () => {
    const now = Date.now();
    const old = now - 3 * 86_400_000;
    h.fs.readdir.mockImplementation(async (p: string) => (p === root("creative") ? ["t1"] : p === root("creative", "t1") ? ["keep.png", "orphan.png", "fresh.png", "../evil.png", "bad name.png"] : []));
    h.fs.lstat.mockImplementation(async (p: string) => {
      if (p === root("creative", "t1")) return dirStat;
      const fresh = p.endsWith("fresh.png");
      return { isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true, mtimeMs: fresh ? now - 1000 : old };
    });
    h.db.seed("creativeAsset", [{ id: "a1", tenantId: "t1", storageKey: "keep.png" }, { id: "a2", tenantId: "t2", storageKey: "orphan.png" }]);
    const out = await cleanupOrphanCreativeFiles(now);
    expect(out).toEqual({ tenants: 1, filesDeleted: 1 });
    expect(h.fs.rm.mock.calls.map((c) => c[0])).toEqual([path.resolve(root("creative", "t1"), "orphan.png")]);
  });
});
