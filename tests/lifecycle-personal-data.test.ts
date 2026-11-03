import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendOnlyPurgeTables,
  batchedTables,
  deletableTables,
  erasureTransactionTables,
  FIXED_RETENTION_DAYS,
  PERSONAL_DATA,
  PROMOTE_RETENTION_DAYS,
  RETENTION_DEFAULTS,
  RETENTION_LIMITS,
  RETENTION_SUMMARY,
  STUDIO_RETENTION,
} from "@/lib/lifecycle/personal-data";

const schema = readFileSync(path.resolve(__dirname, "../prisma/schema.prisma"), "utf8");

function parseModels(source: string): Map<string, string[]> {
  const models = new Map<string, string[]>();
  const re = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
  for (const m of source.matchAll(re)) {
    const fields = m[2]
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("//") && !l.startsWith("@@"))
      .map((l) => l.split(/\s+/)[0]);
    models.set(m[1], fields);
  }
  return models;
}

const models = parseModels(schema);
const listed = new Map(PERSONAL_DATA.map((e) => [e.id, e]));

describe("personal data registry", () => {
  it("reads the schema", () => {
    expect(models.size).toBeGreaterThan(40);
    expect(models.get("Lead")).toContain("tenantId");
  });

  it("lists every Prisma model that has a tenantId column", () => {
    const missing = [...models].filter(([, fields]) => fields.includes("tenantId")).map(([name]) => name).filter((name) => !listed.has(name));
    expect(missing, `Add these models to PERSONAL_DATA in src/lib/lifecycle/personal-data.ts: ${missing.join(", ")}`).toEqual([]);
  });

  it("lists the models the growth platform added", () => {
    for (const name of [
      "Lead", "LeadSequenceRun", "LeadForm", "ConversionEvent", "AbandonedCart", "ShopifyStore", "MetaConnection", "MetaAsset", "Brand",
      "CreativeBrief", "CreativeAngle", "CreativeAsset", "ScheduledPost", "PostTarget", "AiAgent", "AiKnowledgeSource", "McpConnection",
      "ChatbotSession", "UsageLedger", "InsightSnapshot", "OptimizerProposal", "ApprovalRequest", "files:creative", "files:content", "files:inbound-media",
    ]) {
      expect(listed.has(name), name).toBe(true);
    }
  });

  it("has no stale table entries and no duplicates", () => {
    expect(listed.size).toBe(PERSONAL_DATA.length);
    for (const e of PERSONAL_DATA.filter((x) => x.store === "table")) expect(models.has(e.id), `${e.id} is not in the schema`).toBe(true);
  });

  it("checks the tenant column and primary key named by each entry against the schema", () => {
    for (const e of deletableTables()) {
      const fields = models.get(e.id)!;
      expect(fields, e.id).toContain(e.tenantColumn ?? "tenantId");
      expect(fields, e.id).toContain(e.primaryKey ?? "id");
    }
  });

  it("describes every entry fully", () => {
    for (const e of PERSONAL_DATA) {
      expect(e.holds.length, e.id).toBeGreaterThan(10);
      expect(e.retention.length, e.id).toBeGreaterThan(10);
      expect(e.how.length, e.id).toBeGreaterThan(5);
      if (e.erase.method === "retain") expect(e.erase.reason.length).toBeGreaterThan(5);
    }
  });

  it("only keeps tax and payment records", () => {
    const retained = PERSONAL_DATA.filter((e) => e.erase.method === "retain").map((e) => e.id);
    expect(retained.sort()).toEqual(["Invoice", "PaymentEvent"]);
  });

  it("names the columns that are overwritten before secret rows are deleted", () => {
    const secrets = deletableTables().filter((e) => e.erase.method === "secrets-then-delete");
    expect(secrets.map((e) => e.id).sort()).toEqual(["AccessToken", "CanvaConnection", "McpConnection", "MetaAsset", "MetaConnection", "ShopifyStore", "WebhookEndpoint"]);
    for (const e of secrets) {
      if (e.erase.method !== "secrets-then-delete") continue;
      for (const column of Object.keys(e.erase.overwrite)) expect(models.get(e.id), `${e.id}.${column}`).toContain(column);
    }
  });

  it("orders children before parents where a foreign key would otherwise block the delete", () => {
    const order = PERSONAL_DATA.map((e) => e.id);
    const before = (child: string, parent: string) => expect(order.indexOf(child), `${child} before ${parent}`).toBeLessThan(order.indexOf(parent));
    before("Broadcast", "Template");
    before("Template", "Waba");
    before("PhoneNumber", "Waba");
    before("Lead", "LeadForm");
    before("Ad", "AdSet");
    before("AdSet", "AdCampaign");
    before("CreativeAsset", "CreativeBrief");
    before("CreativeBrief", "Brand");
    before("StudioItem", "Brand");
    before("MetaAsset", "MetaConnection");
    before("ChatbotSession", "Chatbot");
    before("AiKnowledgeSource", "AiAgent");
    before("AbandonedCart", "ShopifyStore");
  });

  it("covers every deletable model with the generic erase path or the append-only purge", () => {
    const names = deletableTables().map((e) => e.id);
    const purged = appendOnlyPurgeTables().map((e) => e.id);
    for (const [name, fields] of models) {
      if (!fields.includes("tenantId")) continue;
      if (listed.get(name)?.erase.method === "retain") continue;
      expect([...names, ...purged], name).toContain(name);
    }
    for (const name of purged) expect(names, name).not.toContain(name);
  });
});

describe("spend controls and Eddy registration (SPEND 3.5, EDDY 8.3)", () => {
  const SPEND = [
    "SpendLedger", "SpendConsent", "SpendControl", "SpendAllowance", "AssistantMandate", "MetaSpendLimit", "SpendCommitment", "SpendCounter",
    "SpendBreaker", "SpendReservation", "SpendDaily", "AssistantShadowRecord", "IntradaySpendSample", "SpendApproval", "OwnerNotifyChannel",
  ];
  const EDDY = ["NoticeReceipt", "Notice", "NoticeScanState", "ActionInvocation", "ActionRecord", "EddyMessage", "EddyTurn", "EddyConversation", "EddyUserPref", "EddyWorkspaceSetting"];

  it("lists the 15 spend tables that have a tenantId column", () => {
    expect(SPEND).toHaveLength(15);
    for (const name of SPEND) {
      expect(models.get(name), name).toContain("tenantId");
      expect(listed.get(name)?.store, name).toBe("table");
    }
    // SpendCeiling has no tenantId: erase-workspace.ts deletes its scope 'tenant' rows itself.
    expect(models.get("SpendCeiling")).not.toContain("tenantId");
    expect(listed.has("SpendCeiling")).toBe(false);
  });

  it("purges exactly SpendLedger and SpendConsent with the edwyz.purge GUC", () => {
    expect(appendOnlyPurgeTables().map((e) => e.id).sort()).toEqual(["SpendConsent", "SpendLedger"]);
    for (const e of appendOnlyPurgeTables()) expect(e.erase).toEqual({ method: "append-only-purge", guc: "edwyz.purge" });
  });

  it("lists the 10 Eddy tables children first, before the tombstone steps", () => {
    for (const name of EDDY) expect(models.get(name), name).toContain("tenantId");
    const order = PERSONAL_DATA.map((e) => e.id);
    const positions = EDDY.map((n) => order.indexOf(n));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    for (const p of positions) expect(p).toBeLessThan(order.indexOf("Membership"));
    for (const name of SPEND) expect(order.indexOf(name)).toBeLessThan(order.indexOf("Membership"));
  });

  it("names a real primary key for the tables without an id column", () => {
    expect(listed.get("SpendControl")?.primaryKey).toBe("tenantId");
    expect(listed.get("MetaSpendLimit")?.primaryKey).toBe("adAccountAssetId");
    expect(listed.get("EddyWorkspaceSetting")?.primaryKey).toBe("tenantId");
    for (const name of ["SpendCounter", "SpendDaily", "EddyUserPref", "NoticeReceipt", "NoticeScanState"]) {
      expect(models.get(name), name).not.toContain("id");
      expect(models.get(name), name).toContain(listed.get(name)!.primaryKey);
    }
  });

  it("uses the Eddy retention keys and the existing keys for the spend tables", () => {
    expect(listed.get("EddyMessage")?.retentionKey).toBe("eddyHistoryDays");
    expect(listed.get("EddyConversation")?.retentionKey).toBe("eddyHistoryDays");
    expect(listed.get("ActionRecord")?.retentionKey).toBe("actionRecordDays");
    expect(listed.get("ActionInvocation")?.retentionKey).toBe("actionInvocationDays");
    expect(listed.get("Notice")?.retentionKey).toBe("noticeDays");
    expect(listed.get("EddyTurn")?.retentionKey).toBe("usageLedgerDays");
    expect(listed.get("SpendApproval")?.retentionKey).toBe("approvalRequestDays");
    expect(listed.get("SpendDaily")?.retentionKey).toBe("insightSnapshotDays");
    expect(listed.get("AssistantShadowRecord")?.retentionKey).toBe("insightSnapshotDays");
    expect(listed.get("EddyMessage")?.holds).toContain("phone numbers");
  });
});

describe("retention settings", () => {
  it("has safe defaults inside their own limits", () => {
    for (const key of Object.keys(RETENTION_DEFAULTS) as (keyof typeof RETENTION_DEFAULTS)[]) {
      expect(RETENTION_DEFAULTS[key]).toBeGreaterThanOrEqual(RETENTION_LIMITS[key].min);
      expect(RETENTION_DEFAULTS[key]).toBeLessThanOrEqual(RETENTION_LIMITS[key].max);
    }
  });

  it("uses the periods the policy commits to", () => {
    expect(RETENTION_DEFAULTS).toMatchObject({
      insightSnapshotDays: 400,
      conversionEventDays: 90,
      approvalRequestDays: 90,
      chatbotSessionDays: 90,
      usageLedgerDays: 400,
      leadMonths: 24,
      eddyHistoryDays: 90,
      actionRecordDays: 90,
      actionInvocationDays: 400,
      noticeDays: 30,
    });
    expect(RETENTION_LIMITS).toMatchObject({
      eddyHistoryDays: { min: 30, max: 365 },
      actionRecordDays: { min: 30, max: 365 },
      actionInvocationDays: { min: 90, max: 730 },
      noticeDays: { min: 7, max: 180 },
    });
    expect(FIXED_RETENTION_DAYS).toMatchObject({ webhookEvents: 30, doneJobs: 7, sessions: 30, emailTokens: 7, automationRuns: 90 });
  });

  it("points every retentionKey at a real setting and summarises each one", () => {
    for (const e of PERSONAL_DATA) if (e.retentionKey) expect(RETENTION_DEFAULTS).toHaveProperty(e.retentionKey);
    expect(RETENTION_SUMMARY.length).toBeGreaterThanOrEqual(13);
  });
});

describe("Instagram and Facebook Page ads registration (docs/IG-PAGE-ADS-SPEC.md 5.5)", () => {
  const PROMOTE = ["InsightBreakdown", "AdTest", "AdMedia", "AdAudienceUpload", "AdAudience"];

  it("lists the five new tables with the purposes of the 5.5 table", () => {
    expect(Object.fromEntries(PROMOTE.map((id) => [id, listed.get(id)?.category]))).toEqual({
      AdMedia: "user_content",
      AdAudience: "no_personal_data",
      AdAudienceUpload: "counts_only",
      AdTest: "no_personal_data",
      InsightBreakdown: "aggregates",
    });
    for (const id of PROMOTE) {
      expect(models.get(id), id).toContain("tenantId");
      expect(listed.get(id)?.store, id).toBe("table");
      expect(listed.get(id)?.erase, id).toEqual({ method: "delete" });
    }
    expect(listed.get("AdAudience")?.holds).toContain("consentBasis");
    expect(listed.get("AdAudienceUpload")?.holds).toMatch(/no hashes, no identifiers/);
  });

  it("deletes exactly those tables in the erasure's final transaction, children first, and nothing else there", () => {
    expect(erasureTransactionTables().map((e) => e.id)).toEqual(PROMOTE);
    for (const id of PROMOTE) expect(batchedTables().map((e) => e.id), id).not.toContain(id);
    expect([...batchedTables(), ...erasureTransactionTables()].map((e) => e.id).sort()).toEqual(deletableTables().map((e) => e.id).sort());
    for (const e of erasureTransactionTables()) expect(e.how).toContain("final transaction");
    const order = PERSONAL_DATA.map((e) => e.id);
    expect(order.indexOf("AdAudienceUpload")).toBeLessThan(order.indexOf("AdAudience"));
    expect(order.indexOf("AdTest")).toBeLessThan(order.indexOf("AdCampaign"));
  });

  it("registers the new Lead columns under the Lead rules and LeadForm.spec as no personal data, each a real column", () => {
    const lead = listed.get("Lead")!;
    expect(Object.keys(lead.columns ?? {}).sort()).toEqual(["adsetMetaId", "conversationId", "isOrganic", "isTest", "platform", "source"]);
    for (const [column, rule] of Object.entries(lead.columns!)) {
      expect(models.get("Lead"), column).toContain(column);
      expect(rule).toBe("The same rules as the rest of the lead.");
    }
    const form = listed.get("LeadForm")!;
    expect(form.columns?.spec).toMatch(/^No personal data/);
    for (const column of Object.keys(form.columns ?? {})) expect(models.get("LeadForm"), column).toContain(column);
    expect(Object.keys(form.columns ?? {})).toHaveLength(10);
    // Every column any entry registers exists on its model.
    for (const e of PERSONAL_DATA) for (const column of Object.keys(e.columns ?? {})) expect(models.get(e.id), `${e.id}.${column}`).toContain(column);
  });

  it("states the fixed retention periods of 5.5 and quotes them in the registry", () => {
    expect(PROMOTE_RETENTION_DAYS).toEqual({ insightBreakdowns: 400, audienceUploads: 180, adOnlyMedia: 30, processedVideoOriginals: 30, testLeads: 30, discardedDrafts: 30 });
    expect(listed.get("InsightBreakdown")?.retention).toBe("400 days after the day they describe, or the ad performance period if that is shorter (configurable).");
    expect(listed.get("AdAudienceUpload")?.retention).toBe("180 days after the upload.");
    expect(listed.get("AdMedia")?.retention).toContain("30 days after their last use");
    expect(listed.get("AdMedia")?.retention).toContain("lose their local file 30 days after they were ready");
    expect(listed.get("Lead")?.retention).toContain("Test leads are removed after 30 days.");
    expect(listed.get("AdCampaign")?.retention).toContain("Discarded drafts are removed 30 days after they were discarded.");
  });

  it("results by placement follow the ad performance period, and the privacy summary names them with it", () => {
    expect(listed.get("InsightBreakdown")?.retentionKey).toBe("insightSnapshotDays");
    expect(listed.get("InsightSnapshot")?.retentionKey).toBe("insightSnapshotDays");
    const line = RETENTION_SUMMARY.find((r) => r.label.startsWith("Ad performance data"))!;
    expect(line.label).toContain("results by placement, version, age and gender, and region");
    expect(line.period).toBe(`${RETENTION_DEFAULTS.insightSnapshotDays} days`);
  });

  it("marks all five tables as data of the Meta connection, as InsightSnapshot and the campaigns are", () => {
    for (const id of [...PROMOTE, "InsightSnapshot", "AdCampaign", "AdSet", "Ad"]) expect(listed.get(id)?.metaDerived, id).toBe(true);
    expect(listed.get("AdAudience")?.retention).toContain("Meta connection of their ad account");
  });
});

describe("Studio images and Canva registration (docs/specs/ADS-MCP-CANVA-CREATIVE-SPEC.md 4.4, MCC-00)", () => {
  const STUDIO = ["StudioItem", "StudioJob", "CanvaReturnState", "CanvaConnection"];

  it("lists the four new tables, each with a tenantId, in the batched erasure and none as data of the Meta connection", () => {
    for (const id of STUDIO) {
      expect(models.get(id), id).toContain("tenantId");
      expect(listed.get(id)?.store, id).toBe("table");
      expect(listed.get(id)?.metaDerived, id).toBeUndefined();
      expect(listed.get(id)?.retentionKey, id).toBeUndefined();
      expect(batchedTables().map((e) => e.id), id).toContain(id);
      expect(erasureTransactionTables().map((e) => e.id), id).not.toContain(id);
    }
  });

  it("deletes StudioItem, StudioJob and CanvaReturnState by workspace id, and overwrites both Canva tokens before CanvaConnection rows go", () => {
    for (const id of ["StudioItem", "StudioJob", "CanvaReturnState"]) expect(listed.get(id)?.erase, id).toEqual({ method: "delete" });
    expect(listed.get("CanvaConnection")?.erase).toEqual({ method: "secrets-then-delete", overwrite: { accessTokenEnc: null, refreshTokenEnc: null } });
    expect(listed.get("CanvaConnection")?.how).toMatch(/revoked at Canva \(best effort\), then overwritten, then rows deleted by workspace id/);
    expect(listed.get("StudioItem")?.how).toContain("files:content");
    // StudioItem.brandId points at Brand (ON DELETE SET NULL): the child still goes first.
    const order = PERSONAL_DATA.map((e) => e.id);
    for (const id of STUDIO) expect(order.indexOf(id), id).toBeLessThan(order.indexOf("Brand"));
  });

  it("says what each holds and keeps the periods of 4.4", () => {
    expect(STUDIO_RETENTION).toEqual({ sweepHours: 6, finishedJobDays: 7, unfinishedJobDays: 1, usedReturnStateDays: 2, returnStateDays: 30 });
    expect(listed.get("StudioItem")?.holds).toMatch(/file key.*template inputs.*business contact line.*Canva design id.*creating user id/);
    expect(listed.get("StudioItem")?.retention).toBe("While its Library file exists. A row whose file is gone is removed by the sweep within 6 hours.");
    expect(listed.get("StudioJob")?.holds).toMatch(/design or template id.*pages and format.*error text.*user id/);
    expect(listed.get("StudioJob")?.retention).toBe("7 days after it finishes (done or failed). Unfinished jobs older than 1 day are failed, then removed.");
    expect(listed.get("CanvaReturnState")?.holds).toMatch(/design id.*user id.*export settings/);
    expect(listed.get("CanvaReturnState")?.retention).toBe("Until used plus 2 days, or its expiry (30 days, the life of a Canva edit link).");
    expect(listed.get("CanvaConnection")?.holds).toMatch(/Canva user id, team id and display name.*sealed Canva access and refresh tokens/);
    expect(listed.get("CanvaConnection")?.retention).toContain("leaves the workspace (removed by the sweep within 6 hours)");
  });

  it("the Brand entry names the new columns' data: the logo file key, the tagline and the contact line", () => {
    const brand = listed.get("Brand")!.holds;
    for (const words of ["logo file key", "tagline", "contact line"]) expect(brand, words).toContain(words);
    for (const column of ["logoMediaKey", "fontStyle", "defaultLanguage", "tagline", "contactLine", "isDefault"]) expect(models.get("Brand"), column).toContain(column);
  });
});
