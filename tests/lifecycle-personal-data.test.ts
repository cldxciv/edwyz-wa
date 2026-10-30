import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendOnlyPurgeTables,
  deletableTables,
  FIXED_RETENTION_DAYS,
  PERSONAL_DATA,
  RETENTION_DEFAULTS,
  RETENTION_LIMITS,
  RETENTION_SUMMARY,
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
    expect(secrets.map((e) => e.id).sort()).toEqual(["AccessToken", "McpConnection", "MetaAsset", "MetaConnection", "ShopifyStore", "WebhookEndpoint"]);
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
