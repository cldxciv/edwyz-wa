import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeDb } from "./helpers/fake-db";

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb, orphans: vi.fn() }));

vi.mock("@/lib/db", async () => {
  const { createFakeDb } = await import("./helpers/fake-db");
  h.db = createFakeDb();
  return { prisma: h.db.prisma };
});
vi.mock("@/lib/lifecycle/files", () => ({ cleanupOrphanCreativeFiles: h.orphans }));

import { RETENTION_DEFAULTS } from "@/lib/lifecycle/personal-data";
import { getRetentionConfig, resolveRetentionConfig, runPersonalDataRetention } from "@/lib/lifecycle/retention";

const NOW = Date.parse("2026-10-27T00:00:00Z");
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW - days * DAY);
const ids = (name: string) => h.db.rows(name).map((r) => r.id).sort();

beforeEach(() => {
  for (const k of Object.keys(h.db.tables)) delete h.db.tables[k];
  h.orphans.mockReset();
  h.orphans.mockResolvedValue({ tenants: 0, filesDeleted: 0 });
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

describe("retention config", () => {
  it("falls back to the defaults and ignores unsafe overrides", () => {
    expect(resolveRetentionConfig(undefined)).toEqual(RETENTION_DEFAULTS);
    expect(resolveRetentionConfig({ insightSnapshotDays: 5, conversionEventDays: "30", leadMonths: 1.5, usageLedgerDays: 99999 })).toEqual(RETENTION_DEFAULTS);
    expect(resolveRetentionConfig({ insightSnapshotDays: 200, leadMonths: 36 })).toMatchObject({ insightSnapshotDays: 200, leadMonths: 36, conversionEventDays: 90 });
  });

  it("reads overrides from PlatformSetting", async () => {
    h.db.seed("platformSetting", [{ key: "retention:config", value: { conversionEventDays: 45 } }]);
    expect(await getRetentionConfig()).toMatchObject({ conversionEventDays: 45, insightSnapshotDays: 400 });
  });
});

describe("runPersonalDataRetention", () => {
  it("applies each default period", async () => {
    h.db.seed("insightSnapshot", [{ id: "i-old", date: ago(401) }, { id: "i-new", date: ago(399) }]);
    h.db.seed("optimizerProposal", [
      { id: "o-old", status: "applied", createdAt: ago(401) },
      { id: "o-open", status: "proposed", createdAt: ago(401) },
      { id: "o-new", status: "applied", createdAt: ago(10) },
    ]);
    h.db.seed("conversionEvent", [{ id: "c-old", createdAt: ago(91) }, { id: "c-new", createdAt: ago(89) }]);
    h.db.seed("approvalRequest", [
      { id: "a-old", decidedAt: ago(91), expiresAt: ago(100) },
      { id: "a-new", decidedAt: ago(89), expiresAt: ago(100) },
      { id: "a-undecided-old", decidedAt: null, expiresAt: ago(91) },
      { id: "a-pending", decidedAt: null, expiresAt: new Date(NOW + DAY) },
    ]);
    h.db.seed("chatbotSession", [
      { id: "s-old", status: "completed", updatedAt: ago(91) },
      { id: "s-active-old", status: "active", updatedAt: ago(200) },
      { id: "s-new", status: "completed", updatedAt: ago(1) },
    ]);
    h.db.seed("usageLedger", [{ id: "u-old", createdAt: ago(401) }, { id: "u-new", createdAt: ago(399) }]);
    h.db.seed("abandonedCart", [{ id: "ac-old", createdAt: ago(91) }, { id: "ac-new", createdAt: ago(5) }]);
    h.db.seed("webhookDelivery", [{ id: "w-old", createdAt: ago(31) }, { id: "w-new", createdAt: ago(29) }]);

    const counts = await runPersonalDataRetention(NOW);

    expect(ids("insightSnapshot")).toEqual(["i-new"]);
    expect(ids("optimizerProposal")).toEqual(["o-new", "o-open"]);
    expect(ids("conversionEvent")).toEqual(["c-new"]);
    expect(ids("approvalRequest")).toEqual(["a-new", "a-pending"]);
    expect(ids("chatbotSession")).toEqual(["s-active-old", "s-new"]);
    expect(ids("usageLedger")).toEqual(["u-new"]);
    expect(ids("abandonedCart")).toEqual(["ac-new"]);
    expect(ids("webhookDelivery")).toEqual(["w-new"]);
    expect(counts).toMatchObject({ insightSnapshots: 1, optimizerProposals: 1, conversionEvents: 1, approvalRequests: 2, chatbotSessions: 1, usageLedger: 1 });
  });

  it("applies the spend controls rules (3.5): stopped, cleared and closed rows age out, open ones never", async () => {
    h.db.seed("spendCommitment", [
      { id: "cm-stopped-old", status: "stopped", updatedAt: ago(401) },
      { id: "cm-stopped-new", status: "stopped", updatedAt: ago(399) },
      { id: "cm-live-old", status: "live", updatedAt: ago(900) },
      { id: "cm-reserved-old", status: "reserved", updatedAt: ago(900) },
    ]);
    h.db.seed("spendBreaker", [
      { id: "b-cleared-old", state: "cleared", clearedAt: ago(401) },
      { id: "b-cleared-new", state: "cleared", clearedAt: ago(10) },
      { id: "b-open-old", state: "tripped", clearedAt: null, trippedAt: ago(900) },
    ]);
    h.db.seed("spendReservation", [
      { id: "r-settled-old", status: "settled", closedAt: ago(91) },
      { id: "r-released-old", status: "released", closedAt: ago(200) },
      { id: "r-expired-new", status: "expired", closedAt: ago(30) },
      { id: "r-held-old", status: "held", closedAt: null, createdAt: ago(200) },
    ]);
    h.db.seed("intradaySpendSample", [
      { id: "i-old", sampledAt: ago(36) },
      { id: "i-new", sampledAt: ago(34) },
    ]);
    h.db.seed("spendDaily", [
      { scopeId: "sd-old", day: ago(401) },
      { scopeId: "sd-new", day: ago(399) },
    ]);
    h.db.seed("assistantShadowRecord", [
      { id: "sh-old", createdAt: ago(401) },
      { id: "sh-new", createdAt: ago(5) },
    ]);
    h.db.seed("spendApproval", [
      { id: "ap-old", status: "applied", decidedAt: ago(91), expiresAt: ago(92) },
      { id: "ap-new", status: "declined", decidedAt: ago(10), expiresAt: ago(11) },
      { id: "ap-expired-old", status: "pending", decidedAt: null, expiresAt: ago(91) },
      { id: "ap-pending", status: "pending", decidedAt: null, expiresAt: new Date(NOW + DAY) },
    ]);
    // The append-only ledger and consents are never aged out.
    h.db.seed("spendLedger", [{ id: "l-old", createdAt: ago(5_000) }]);

    const counts = await runPersonalDataRetention(NOW);

    expect(ids("spendCommitment")).toEqual(["cm-live-old", "cm-reserved-old", "cm-stopped-new"]);
    expect(ids("spendBreaker")).toEqual(["b-cleared-new", "b-open-old"]);
    expect(ids("spendReservation")).toEqual(["r-expired-new", "r-held-old"]);
    expect(ids("intradaySpendSample")).toEqual(["i-new"]);
    expect(h.db.rows("spendDaily").map((r) => r.scopeId)).toEqual(["sd-new"]);
    expect(ids("assistantShadowRecord")).toEqual(["sh-new"]);
    expect(ids("spendApproval")).toEqual(["ap-new", "ap-pending"]);
    expect(ids("spendLedger")).toEqual(["l-old"]);
    expect(counts).toMatchObject({
      spendCommitmentsStopped: 1,
      spendBreakersCleared: 1,
      spendReservationsClosed: 2,
      intradaySpendSamples: 1,
      spendDaily: 1,
      assistantShadowRecords: 1,
      spendApprovals: 2,
    });
  });

  it("the spend rules follow the configured ad data and approval periods", async () => {
    h.db.seed("platformSetting", [{ key: "retention:config", value: { insightSnapshotDays: 100, approvalRequestDays: 30 } }]);
    h.db.seed("spendDaily", [{ scopeId: "a", day: ago(101) }, { scopeId: "b", day: ago(99) }]);
    h.db.seed("assistantShadowRecord", [{ id: "s1", createdAt: ago(101) }]);
    h.db.seed("spendApproval", [{ id: "p1", decidedAt: ago(31), expiresAt: ago(40) }, { id: "p2", decidedAt: ago(29), expiresAt: ago(40) }]);
    await runPersonalDataRetention(NOW);
    expect(h.db.rows("spendDaily").map((r) => r.scopeId)).toEqual(["b"]);
    expect(ids("assistantShadowRecord")).toEqual([]);
    expect(ids("spendApproval")).toEqual(["p2"]);
  });

  it("uses configured periods", async () => {
    h.db.seed("platformSetting", [{ key: "retention:config", value: { conversionEventDays: 30 } }]);
    h.db.seed("conversionEvent", [{ id: "c1", createdAt: ago(31) }, { id: "c2", createdAt: ago(29) }]);
    await runPersonalDataRetention(NOW);
    expect(ids("conversionEvent")).toEqual(["c2"]);
  });

  it("deletes leads 24 months after last activity, not before, and keeps leads that are still active", async () => {
    const old = ago(800);
    h.db.seed("lead", [
      { id: "l-old", tenantId: "t1", contactId: null, createdAt: old, firstResponseAt: null },
      { id: "l-responded-recently", tenantId: "t1", contactId: null, createdAt: old, firstResponseAt: ago(100) },
      { id: "l-chat-recent", tenantId: "t1", contactId: "k1", createdAt: old, firstResponseAt: old },
      { id: "l-chat-old", tenantId: "t1", contactId: "k2", createdAt: old, firstResponseAt: old },
      { id: "l-other-tenant-contact", tenantId: "t2", contactId: "k1", createdAt: old, firstResponseAt: null },
      { id: "l-sequence", tenantId: "t1", contactId: null, createdAt: old, firstResponseAt: null },
      { id: "l-young", tenantId: "t1", contactId: null, createdAt: ago(300), firstResponseAt: null },
    ]);
    h.db.seed("conversation", [
      { id: "v1", tenantId: "t1", contactId: "k1", lastMessageAt: ago(30) },
      { id: "v2", tenantId: "t1", contactId: "k2", lastMessageAt: ago(900) },
    ]);
    h.db.seed("leadSequenceRun", [
      { id: "r1", leadId: "l-old", status: "completed" },
      { id: "r2", leadId: "l-sequence", status: "active" },
    ]);

    const counts = await runPersonalDataRetention(NOW);

    expect(ids("lead")).toEqual(["l-chat-recent", "l-responded-recently", "l-sequence", "l-young"]);
    expect(ids("leadSequenceRun")).toEqual(["r2"]);
    expect(counts.leads).toBe(3);
  });

  it("is a no-op on empty tables and reports orphan file cleanup", async () => {
    h.orphans.mockResolvedValue({ tenants: 3, filesDeleted: 4 });
    const counts = await runPersonalDataRetention(NOW);
    expect(Object.values(counts).filter((v) => v !== 4)).toEqual(Array(17).fill(0));
    expect(counts.creativeFilesOrphaned).toBe(4);
  });

  it("prunes compat idempotency claims older than 48 hours and nothing else in PlatformSetting", async () => {
    h.db.seed("platformSetting", [
      { key: "compat:idem:t1:old", value: { state: "done" }, updatedAt: ago(2.1) },
      { key: "compat:idem:t1:pending-old", value: { state: "pending" }, updatedAt: ago(30) },
      { key: "compat:idem:t1:recent", value: { state: "done" }, updatedAt: ago(1.5) },
      { key: "compat:idem:t1:today", value: { state: "done" }, updatedAt: ago(0.1) },
      { key: "retention:config", value: {}, updatedAt: ago(500) },
      { key: "rl:login:abc", value: { count: 1 }, updatedAt: ago(500) },
    ]);
    const counts = await runPersonalDataRetention(NOW);
    expect(counts.compatIdempotencyClaims).toBe(2);
    expect(h.db.rows("platformSetting").map((r) => r.key).sort()).toEqual(["compat:idem:t1:recent", "compat:idem:t1:today", "rl:login:abc", "retention:config"].sort());
  });

  it("deletes idempotency claims in batches of 1000 and logs only the count", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    h.db.seed("platformSetting", Array.from({ length: 2500 }, (_, i) => ({ key: `compat:idem:t1:${i}`, value: { state: "done" }, updatedAt: ago(3) })));
    const counts = await runPersonalDataRetention(NOW);
    expect(counts.compatIdempotencyClaims).toBe(2500);
    expect(h.db.rows("platformSetting")).toHaveLength(0);
    expect(info.mock.calls.flat().join(" ")).not.toContain("compat:idem:t1:");
  });

  it("logs counts only", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    h.db.seed("lead", [{ id: "l1", tenantId: "t1", contactId: null, createdAt: ago(900), firstResponseAt: null, fields: { email: "secret@example.com" } }]);
    await runPersonalDataRetention(NOW);
    const logged = info.mock.calls.flat().join(" ");
    expect(logged).toContain("leads");
    expect(logged).not.toContain("secret@example.com");
    expect(logged).not.toContain("l1");
  });
});
