import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeDb } from "./helpers/fake-db";

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb, orphans: vi.fn(), deleteMedia: vi.fn() }));

vi.mock("@/lib/db", async () => {
  const { createFakeDb } = await import("./helpers/fake-db");
  h.db = createFakeDb();
  return { prisma: h.db.prisma };
});
vi.mock("@/lib/lifecycle/files", () => ({ cleanupOrphanCreativeFiles: h.orphans }));
vi.mock("@/lib/inbox/media", () => ({ sweepPendingUploads: vi.fn(async () => ({ tenants: 0, files: 0, bytes: 0 })) }));
vi.mock("@/lib/content/media", () => ({ deleteMedia: h.deleteMedia }));

import { PROMOTE_RETENTION_DAYS, RETENTION_DEFAULTS } from "@/lib/lifecycle/personal-data";
import { getRetentionConfig, resolveRetentionConfig, runPersonalDataRetention, runPromoteRetention } from "@/lib/lifecycle/retention";

const NOW = Date.parse("2026-10-27T00:00:00Z");
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW - days * DAY);
const ids = (name: string) => h.db.rows(name).map((r) => r.id).sort();

beforeEach(() => {
  for (const k of Object.keys(h.db.tables)) delete h.db.tables[k];
  h.orphans.mockReset();
  h.orphans.mockResolvedValue({ tenants: 0, filesDeleted: 0 });
  h.deleteMedia.mockReset();
  h.deleteMedia.mockResolvedValue(true);
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
    expect(Object.values(counts).filter((v) => v !== 4)).toEqual(Array(25).fill(0));
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

describe("Instagram and Facebook Page ads retention (docs/IG-PAGE-ADS-SPEC.md 5.5)", () => {
  it("has the six fixed periods of 5.5", () => {
    expect(PROMOTE_RETENTION_DAYS).toEqual({ insightBreakdowns: 400, audienceUploads: 180, adOnlyMedia: 30, processedVideoOriginals: 30, testLeads: 30, discardedDrafts: 30 });
  });

  it("drops results by placement after 400 days and customer-list upload records after 180", async () => {
    h.db.seed("insightBreakdown", [{ id: "ib-old", tenantId: "t1", date: ago(401) }, { id: "ib-new", tenantId: "t1", date: ago(399) }]);
    h.db.seed("adAudienceUpload", [{ id: "up-old", tenantId: "t1", createdAt: ago(181) }, { id: "up-new", tenantId: "t1", createdAt: ago(179) }]);
    const counts = await runPromoteRetention(NOW);
    expect(ids("insightBreakdown")).toEqual(["ib-new"]);
    expect(ids("adAudienceUpload")).toEqual(["up-new"]);
    expect(counts).toMatchObject({ insightBreakdowns: 1, adAudienceUploads: 1 });
  });

  it("drops results by placement with the ad performance data when that period is set shorter, and never keeps them past 400 days", async () => {
    h.db.seed("platformSetting", [{ key: "retention:config", value: { insightSnapshotDays: 120 } }]);
    h.db.seed("insightBreakdown", [{ id: "ib-121", tenantId: "t1", date: ago(121) }, { id: "ib-119", tenantId: "t1", date: ago(119) }]);
    h.db.seed("insightSnapshot", [{ id: "is-121", tenantId: "t1", date: ago(121) }]);
    const counts = await runPersonalDataRetention(NOW);
    expect(ids("insightBreakdown")).toEqual(["ib-119"]);
    expect(ids("insightSnapshot")).toEqual([]);
    expect(counts).toMatchObject({ insightBreakdowns: 1, insightSnapshots: 1 });

    // A longer ad performance period does not stretch the 400 days.
    h.db.seed("insightBreakdown", [{ id: "ib-401", tenantId: "t1", date: ago(401) }, { id: "ib-500", tenantId: "t1", date: ago(500) }]);
    await runPromoteRetention(NOW, { ...RETENTION_DEFAULTS, insightSnapshotDays: 900 });
    expect(ids("insightBreakdown")).toEqual(["ib-119"]);
  });

  it("drops test leads after 30 days with their sequence runs, and never a real lead of the same age", async () => {
    h.db.seed("lead", [
      { id: "test-old", tenantId: "t1", isTest: true, createdAt: ago(31) },
      { id: "test-new", tenantId: "t1", isTest: true, createdAt: ago(29) },
      { id: "real-old", tenantId: "t1", isTest: false, createdAt: ago(31) },
      { id: "legacy", tenantId: "t1", createdAt: ago(60) },
    ]);
    h.db.seed("leadSequenceRun", [{ id: "r-test", leadId: "test-old", status: "completed" }, { id: "r-real", leadId: "real-old", status: "active" }]);
    const counts = await runPromoteRetention(NOW);
    expect(ids("lead")).toEqual(["legacy", "real-old", "test-new"]);
    expect(ids("leadSequenceRun")).toEqual(["r-real"]);
    expect(counts.testLeads).toBe(1);
  });

  it("drops discarded drafts 30 days after discarding, only while they are drafts that never reached Meta", async () => {
    h.db.seed("adCampaign", [
      { id: "d-old", tenantId: "t1", status: "draft", metaCampaignId: null, discardedAt: ago(31) },
      { id: "d-new", tenantId: "t1", status: "draft", metaCampaignId: null, discardedAt: ago(29) },
      { id: "d-on-meta", tenantId: "t1", status: "draft", metaCampaignId: "MC1", discardedAt: ago(60) },
      { id: "paused", tenantId: "t1", status: "paused", metaCampaignId: null, discardedAt: ago(60) },
      { id: "kept-draft", tenantId: "t1", status: "draft", metaCampaignId: null, discardedAt: null },
    ]);
    const counts = await runPromoteRetention(NOW);
    expect(ids("adCampaign")).toEqual(["d-new", "d-on-meta", "kept-draft", "paused"]);
    expect(counts.discardedDrafts).toBe(1);
  });

  it("also drops a discarded start that failed before Meta made the campaign, but never one Meta has", async () => {
    h.db.seed("adCampaign", [
      { id: "e-old", tenantId: "t1", status: "error", metaCampaignId: null, discardedAt: ago(31) },
      { id: "e-on-meta", tenantId: "t1", status: "error", metaCampaignId: "MC2", discardedAt: ago(31) },
      { id: "e-new", tenantId: "t1", status: "error", metaCampaignId: null, discardedAt: ago(29) },
      { id: "launching", tenantId: "t1", status: "launching", metaCampaignId: null, discardedAt: ago(60) },
    ]);
    const counts = await runPromoteRetention(NOW);
    expect(ids("adCampaign")).toEqual(["e-new", "e-on-meta", "launching"]);
    expect(counts.discardedDrafts).toBe(1);
  });

  it("removes a dropped draft's client approval records with it, and nothing of a kept campaign or another workspace", async () => {
    h.db.seed("adCampaign", [
      { id: "gone", tenantId: "t1", status: "draft", metaCampaignId: null, discardedAt: ago(40) },
      { id: "gone2", tenantId: "t2", status: "error", metaCampaignId: null, discardedAt: ago(40) },
      { id: "kept", tenantId: "t1", status: "draft", metaCampaignId: null, discardedAt: ago(2) },
    ]);
    h.db.seed("approvalRequest", [
      { id: "ap-gone", tenantId: "t1", subjectType: "ad_campaign", subjectId: "gone", decidedAt: null, expiresAt: new Date(NOW + DAY) },
      { id: "ap-gone2", tenantId: "t2", subjectType: "ad_campaign", subjectId: "gone2", decidedAt: null, expiresAt: new Date(NOW + DAY) },
      { id: "ap-kept", tenantId: "t1", subjectType: "ad_campaign", subjectId: "kept", decidedAt: null, expiresAt: new Date(NOW + DAY) },
      // Same id under another subject type, or named by another workspace: not this draft's record.
      { id: "ap-creative", tenantId: "t1", subjectType: "creative_asset", subjectId: "gone", decidedAt: null, expiresAt: new Date(NOW + DAY) },
      { id: "ap-other-ws", tenantId: "t2", subjectType: "ad_campaign", subjectId: "gone", decidedAt: null, expiresAt: new Date(NOW + DAY) },
    ]);
    h.db.seed("platformSetting", [
      { key: "approval:ad_campaign:t1:gone", value: {} },
      { key: "approval:ad_campaign:t2:gone2", value: {} },
      { key: "approval:ad_campaign:t1:kept", value: {} },
      { key: "approval:ad_campaign:t2:gone", value: {} },
    ]);
    const counts = await runPromoteRetention(NOW);
    expect(ids("adCampaign")).toEqual(["kept"]);
    expect(ids("approvalRequest")).toEqual(["ap-creative", "ap-kept", "ap-other-ws"]);
    expect(h.db.rows("platformSetting").map((r) => r.key).sort()).toEqual(["approval:ad_campaign:t1:kept", "approval:ad_campaign:t2:gone"]);
    expect(counts.discardedDrafts).toBe(2);
  });

  it("removes the local file of an Instagram video copy 30 days after Meta processed it, once nothing uses it, and keeps the row", async () => {
    const video = (id: string, extra: Record<string, unknown>) => ({
      id, tenantId: "t1", adAccountAssetId: "as1", kind: "video", source: "ig_copy", sourceKey: `${id}.mp4`, adOnly: false,
      status: "ready", metaVideoId: `V-${id}`, metaThumbHash: `th-${id}`, updatedAt: ago(31), lastUsedAt: ago(100), createdAt: ago(100), ...extra,
    });
    h.db.seed("adMedia", [
      video("v-old", {}),
      video("v-recent", { updatedAt: ago(29) }),
      video("v-live", {}),
      video("v-draft", {}),
      video("v-processing", { status: "processing", metaVideoId: "V-p" }),
      video("v-no-meta-id", { metaVideoId: null }),
      // The customer's own library video and a generated creative are theirs: never removed by this rule.
      video("v-library", { source: "content" }),
      video("v-creative", { source: "creative" }),
      video("i-image", { kind: "image", metaVideoId: null, metaImageHash: "h" }),
      // The same file sent to a second ad account that Meta has not processed yet still needs it.
      video("v-shared-a", { sourceKey: "shared.mp4" }),
      video("v-shared-b", { adAccountAssetId: "as2", sourceKey: "shared.mp4", status: "uploading", metaVideoId: null, updatedAt: ago(1) }),
      // Both rows of this file are processed and unused: the file goes once.
      video("v-both-a", { sourceKey: "both.mp4" }),
      video("v-both-b", { adAccountAssetId: "as2", sourceKey: "both.mp4", updatedAt: ago(5) }),
      video("v-t2", { tenantId: "t2" }),
    ]);
    h.db.seed("ad", [
      { id: "a1", tenantId: "t1", status: "active", mediaIds: ["v-live"] },
      { id: "a2", tenantId: "t1", status: "draft", mediaIds: ["v-draft"] },
      { id: "a3", tenantId: "t1", status: "archived", mediaIds: ["v-old"] },
      // Another workspace naming t1's ids never keeps them.
      { id: "a4", tenantId: "t2", status: "active", mediaIds: ["v-both-a"] },
    ]);
    const counts = await runPromoteRetention(NOW);
    expect(h.deleteMedia.mock.calls.map(([t, k]) => `${t}:${k}`).sort()).toEqual(["t1:both.mp4", "t1:v-old.mp4", "t2:v-t2.mp4"]);
    expect(counts.processedVideoOriginalFiles).toBe(3);
    // Every row stays, with Meta's video id and thumbnail.
    expect(h.db.rows("adMedia")).toHaveLength(14);
    expect(h.db.rows("adMedia").find((r) => r.id === "v-old")).toMatchObject({ metaVideoId: "V-v-old", metaThumbHash: "th-v-old", status: "ready" });
  });

  it("counts only video files the content store really removed, and a failed delete never stops the sweep", async () => {
    const video = (id: string) => ({ id, tenantId: "t1", kind: "video", source: "ig_copy", sourceKey: `${id}.mp4`, status: "ready", metaVideoId: `V-${id}`, updatedAt: ago(40) });
    h.db.seed("adMedia", [video("gone"), video("err"), video("ok")]);
    h.deleteMedia.mockImplementation(async (_t: string, key: string) => {
      if (key === "err.mp4") throw new Error("EACCES");
      return key === "ok.mp4";
    });
    const counts = await runPromoteRetention(NOW);
    expect(h.deleteMedia).toHaveBeenCalledTimes(3);
    expect(counts.processedVideoOriginalFiles).toBe(1);
  });

  it("drops ad-only media 30 days after last use once no live ad uses it, with its file, and leaves library media alone", async () => {
    const media = (id: string, extra: Record<string, unknown>) => ({ id, tenantId: "t1", adAccountAssetId: "as1", adOnly: true, source: "crop", sourceKey: `${id}.jpg`, lastUsedAt: ago(31), createdAt: ago(90), ...extra });
    h.db.seed("adMedia", [
      media("m-unused", {}),
      media("m-live", {}),
      media("m-archived-only", { source: "ig_copy" }),
      media("m-recent", { lastUsedAt: ago(29) }),
      media("m-never-used", { lastUsedAt: null, createdAt: ago(31) }),
      media("m-never-used-new", { lastUsedAt: null, createdAt: ago(10) }),
      media("m-library", { adOnly: false, source: "content", lastUsedAt: ago(400) }),
      media("m-shared-a", { sourceKey: "shared.jpg" }),
      media("m-shared-b", { adAccountAssetId: "as2", sourceKey: "shared.jpg", lastUsedAt: ago(2) }),
      media("m-creative", { source: "creative", sourceKey: "asset_1" }),
      media("m-t2", { tenantId: "t2", sourceKey: "m-unused.jpg" }),
    ]);
    h.db.seed("ad", [
      { id: "a1", tenantId: "t1", status: "paused", mediaIds: ["m-live"] },
      { id: "a2", tenantId: "t1", status: "archived", mediaIds: ["m-archived-only", "m-live"] },
      { id: "a3", tenantId: "t1", status: "draft", mediaIds: ["m-recent"] },
      // Another workspace naming t1's ids never keeps them.
      { id: "a4", tenantId: "t2", status: "active", mediaIds: ["m-unused", "m-creative"] },
      { id: "a5", tenantId: "t1", status: "active" },
    ]);
    const counts = await runPromoteRetention(NOW);
    expect(ids("adMedia")).toEqual(["m-library", "m-live", "m-never-used-new", "m-recent", "m-shared-b"]);
    expect(h.deleteMedia.mock.calls.map(([t, k]) => `${t}:${k}`).sort()).toEqual(["t1:m-archived-only.jpg", "t1:m-never-used.jpg", "t1:m-unused.jpg", "t2:m-unused.jpg"]);
    expect(counts).toMatchObject({ adOnlyMedia: 6, adOnlyMediaFiles: 4 });
  });

  it("counts only the files the content store really removed, and a failed file delete never stops the sweep", async () => {
    h.db.seed("adMedia", [
      { id: "m1", tenantId: "t1", adOnly: true, source: "crop", sourceKey: "gone.jpg", lastUsedAt: ago(40) },
      { id: "m2", tenantId: "t1", adOnly: true, source: "crop", sourceKey: "err.jpg", lastUsedAt: ago(40) },
    ]);
    h.deleteMedia.mockImplementation(async (_t: string, key: string) => {
      if (key === "err.jpg") throw new Error("EACCES");
      return false;
    });
    const counts = await runPromoteRetention(NOW);
    expect(ids("adMedia")).toEqual([]);
    expect(counts).toMatchObject({ adOnlyMedia: 2, adOnlyMediaFiles: 0 });
  });

  it("runs as part of the daily personal-data retention", async () => {
    h.db.seed("insightBreakdown", [{ id: "ib-old", tenantId: "t1", date: ago(500) }]);
    const counts = await runPersonalDataRetention(NOW);
    expect(counts).toMatchObject({ insightBreakdowns: 1, adAudienceUploads: 0, adOnlyMedia: 0, adOnlyMediaFiles: 0, processedVideoOriginalFiles: 0, testLeads: 0, discardedDrafts: 0 });
    expect(ids("insightBreakdown")).toEqual([]);
  });
});
