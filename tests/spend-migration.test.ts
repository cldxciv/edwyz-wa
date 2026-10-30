import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { migrationNames, needsNoTransaction, readMigration, splitSqlStatements, stripSqlComments } from "./helpers/pg";

/**
 * Static proof that migration 0009 is additive and safe on the live database, and that 0010 holds only the non-blocking
 * Message indexes (docs/SPEND-CONTROLS-SPEC.md 3.2, 3.2.1; docs/EDDY-SPEC.md 8.1). The database-level behaviour (triggers,
 * partial uniques, backfill rows) is proven in tests/db/schema-triggers.test.ts.
 */
const sql0009 = readMigration("0009_spend_controls");
const sql0010 = readMigration("0010_spend_message_indexes");
const statements = splitSqlStatements(sql0009);
const code0009 = stripSqlComments(sql0009);
const flat = (s: string) => s.replace(/\s+/g, " ").trim();

/** Tables that exist before 0009 (created by 0001-0008). */
const preExisting = new Set(
  migrationNames()
    .filter((n) => n < "0009")
    .flatMap((n) => [...readMigration(n).matchAll(/CREATE TABLE "(\w+)"/g)].map((m) => m[1])),
);
const created = statements.map((s) => /^CREATE TABLE "(\w+)"/.exec(s)?.[1]).filter((n): n is string => !!n);

const SPEND_TABLES = [
  "SpendControl", "SpendAllowance", "SpendCeiling", "SpendCommitment", "SpendCounter", "SpendReservation", "SpendDaily",
  "IntradaySpendSample", "SpendLedger", "MetaSpendLimit", "SpendConsent", "AssistantMandate", "SpendApproval", "SpendBreaker",
  "AssistantShadowRecord", "OwnerNotifyChannel",
];
const EDDY_TABLES = [
  "EddyWorkspaceSetting", "EddyUserPref", "EddyConversation", "EddyMessage", "EddyTurn", "ActionRecord", "ActionInvocation",
  "Notice", "NoticeReceipt", "NoticeScanState",
];

function tableBody(name: string): string {
  const s = statements.find((x) => x.startsWith(`CREATE TABLE "${name}"`));
  if (!s) throw new Error(`0009 does not create ${name}`);
  return flat(s);
}

describe("0009_spend_controls is safe on the live database", () => {
  it("is numbered after 0008 and folds Eddy in (no separate 0011_eddy)", () => {
    const names = migrationNames();
    // Later migrations may follow (0011_template_flagged, spend spec 6.3); 0009 and 0010 come straight after 0008.
    const at = names.indexOf("0008_agent_reply_backfill");
    expect(names.slice(at, at + 3)).toEqual(["0008_agent_reply_backfill", "0009_spend_controls", "0010_spend_message_indexes"]);
    expect(existsSync(path.resolve(__dirname, "../prisma/migrations/0011_eddy"))).toBe(false);
  });

  it("starts with both SET LOCAL timeouts, before any other statement", () => {
    expect(flat(statements[0])).toBe("SET LOCAL lock_timeout = '5s'");
    expect(flat(statements[1])).toBe("SET LOCAL statement_timeout = '120s'");
    expect(statements.filter((s) => /^SET\b/i.test(s))).toHaveLength(2);
  });

  it("drops, renames and retypes nothing", () => {
    for (const s of statements) {
      expect(s, s).not.toMatch(/^\s*DROP\b/i);
      expect(s, s).not.toMatch(/\bRENAME\b/i);
      expect(s, s).not.toMatch(/\bALTER\s+COLUMN\b/i);
      expect(s, s).not.toMatch(/\bSET\s+DATA\s+TYPE\b/i);
      expect(s, s).not.toMatch(/^\s*TRUNCATE\b/i);
    }
    expect(code0009).not.toMatch(/\bDROP\s+(TABLE|COLUMN|INDEX|CONSTRAINT|TRIGGER|FUNCTION|TYPE)\b/i);
  });

  it("never updates or deletes rows, and inserts only into tables it creates", () => {
    for (const s of statements) {
      expect(s, s).not.toMatch(/^\s*(UPDATE|DELETE)\b/i);
      expect(s, s).not.toMatch(/;\s*(UPDATE|DELETE)\s/i);
      const insert = /^INSERT INTO "(\w+)"/.exec(s);
      if (insert) {
        expect(preExisting.has(insert[1]), `insert into existing ${insert[1]}`).toBe(false);
        expect(created).toContain(insert[1]);
      }
    }
    // No data-modifying CTE either.
    expect(code0009).not.toMatch(/\bWITH\b[\s\S]*\b(UPDATE|DELETE)\s+"/i);
  });

  it("only adds columns and constraints to existing tables, each nullable or with a constant default", () => {
    const alters = statements.filter((s) => /^ALTER TABLE/i.test(s));
    expect(alters.length).toBeGreaterThan(0);
    for (const s of alters) {
      const table = /^ALTER TABLE "(\w+)"/.exec(s)![1];
      expect(preExisting.has(table), table).toBe(true);
      const actions = flat(s).replace(/^ALTER TABLE "\w+" /, "").split(/,\s*(?=ADD )/);
      for (const action of actions) {
        expect(action, action).toMatch(/^ADD (COLUMN|CONSTRAINT) /);
        if (/^ADD COLUMN/.test(action) && /\bNOT NULL\b/.test(action)) expect(action, action).toMatch(/\bDEFAULT (false|true|'[^']*'|\d+)(\s|$)/);
      }
    }
    expect(alters.map((s) => /^ALTER TABLE "(\w+)"/.exec(s)![1]).sort()).toEqual(["AdCampaign", "AdCampaign", "AdCampaign", "AdSet", "Message", "Message", "MetaAsset", "UsageLedger"]);
  });

  it("adds the Message CHECK as NOT VALID and builds no index on Message", () => {
    const check = statements.find((s) => s.includes('"Message_spendState_check"'));
    expect(flat(check!)).toMatch(/CHECK \("spendState" IS NULL OR "spendState" IN \('reserved','settled','released'\)\) NOT VALID$/);
    expect(code0009).not.toMatch(/CREATE (UNIQUE )?INDEX[^;]*ON "Message"/i);
    expect(code0009).not.toMatch(/\bCONCURRENTLY\b/i);
    expect(needsNoTransaction(sql0009)).toBe(false);
  });

  it("creates every spend and Eddy table, and no table that already exists", () => {
    expect(created.sort()).toEqual([...SPEND_TABLES, ...EDDY_TABLES].sort());
    for (const name of created) expect(preExisting.has(name), name).toBe(false);
  });

  it("has the critic fixes: SpendDaily key with origin, the external actor, MetaSpendLimit columns and the one-manager index", () => {
    expect(tableBody("SpendDaily")).toContain('CONSTRAINT "SpendDaily_pkey" PRIMARY KEY ("tenantId","pot","scopeType","scopeId","day","origin")');
    expect(tableBody("SpendLedger")).toContain(`CHECK ("actorType" IN ('user','assistant','system','breaker','platform_admin','api','external'))`);
    const limit = tableBody("MetaSpendLimit");
    expect(limit).toContain('"accountExternalId" TEXT NOT NULL');
    expect(limit).toContain('"spentAtLastWriteMinor" BIGINT');
    expect(limit).toContain("'other_workspace'");
    // (repair) Decision 11: only an owner's consent ('managed') holds the one-manager slot; pending_owner never expires.
    expect(code0009).toContain(`CREATE UNIQUE INDEX "MetaSpendLimit_one_manager_key" ON "MetaSpendLimit"("accountExternalId") WHERE "mode" = 'managed';`);
    expect(code0009).not.toMatch(/one_manager_key[^;]*pending_owner/);
    expect(code0009).toContain(`CREATE UNIQUE INDEX "SpendLedger_idem_key" ON "SpendLedger"("tenantId","idempotencyKey","phase") WHERE "idempotencyKey" IS NOT NULL;`);
  });

  it("lets the database enforce exactly one outcome and one reconciled row per request (repair)", () => {
    expect(code0009).toContain(`CREATE UNIQUE INDEX "SpendLedger_one_outcome_key" ON "SpendLedger"("tenantId","correlationId") WHERE "phase" IN ('applied','failed','unconfirmed','refused');`);
    expect(code0009).toContain(`CREATE UNIQUE INDEX "SpendLedger_one_reconciled_key" ON "SpendLedger"("tenantId","correlationId") WHERE "phase" = 'reconciled';`);
  });

  it("makes SpendLedger and SpendConsent append-only with a purge exception for DELETE only, for one workspace", () => {
    const fn = flat(statements.find((s) => s.startsWith("CREATE OR REPLACE FUNCTION edwyz_append_only()") || s.includes("CREATE OR REPLACE FUNCTION edwyz_append_only()"))!);
    expect(fn).toContain("IF TG_OP = 'DELETE' AND TG_LEVEL = 'ROW' THEN");
    expect(fn).toContain("IF current_setting('edwyz.purge', true) = TG_TABLE_NAME || ':' || COALESCE(to_jsonb(OLD)->>'tenantId', '') THEN RETURN OLD;");
    expect(fn).not.toContain("current_setting('edwyz.purge', true) = TG_TABLE_NAME THEN");
    expect(fn).toContain("USING ERRCODE = '42501'");
    for (const table of ["SpendLedger", "SpendConsent"]) {
      expect(code0009).toContain(`CREATE TRIGGER "${table}_append_only" BEFORE UPDATE OR DELETE ON "${table}" FOR EACH ROW EXECUTE FUNCTION edwyz_append_only();`);
      expect(code0009).toContain(`CREATE TRIGGER "${table}_no_truncate" BEFORE TRUNCATE ON "${table}" FOR EACH STATEMENT EXECUTE FUNCTION edwyz_append_only();`);
    }
  });

  it("guards EddyMessage and ActionInvocation (the only allowed change: userId to NULL)", () => {
    expect(code0009).toContain('CREATE TRIGGER "EddyMessage_append_only" BEFORE UPDATE ON "EddyMessage" FOR EACH ROW EXECUTE FUNCTION edwyz_append_only();');
    const guard = flat(statements.find((s) => s.startsWith("CREATE OR REPLACE FUNCTION edwyz_action_invocation_guard()"))!);
    expect(guard).toContain(`IF NEW."userId" IS NULL AND OLD."userId" IS NOT NULL AND (to_jsonb(NEW) - 'userId') = (to_jsonb(OLD) - 'userId') THEN RETURN NEW;`);
    expect(code0009).toContain('CREATE TRIGGER "ActionInvocation_append_only" BEFORE UPDATE ON "ActionInvocation" FOR EACH ROW EXECUTE FUNCTION edwyz_action_invocation_guard();');
    expect(code0009).toContain('CREATE TRIGGER "ActionInvocation_no_truncate" BEFORE TRUNCATE ON "ActionInvocation" FOR EACH STATEMENT EXECUTE FUNCTION edwyz_append_only();');
    // The Eddy part reuses the function created earlier in the same file.
    expect(sql0009.indexOf("CREATE OR REPLACE FUNCTION edwyz_append_only()")).toBeLessThan(sql0009.indexOf('CREATE TABLE "EddyMessage"'));
    expect(tableBody("EddyConversation")).toContain('"visibilityHash" TEXT NOT NULL');
    expect(tableBody("EddyTurn")).toContain('"platformMicroUsd" BIGINT NOT NULL DEFAULT 0');
  });

  it("backfills the old cap as ceil(1.75 C) and keeps C, with C rescaled to the current exponent like getCaps (repair)", () => {
    const fill = flat(stripSqlComments(statements.find((s) => s.startsWith('INSERT INTO "SpendAllowance"') || /^(--[^\n]*\n\s*)*INSERT INTO "SpendAllowance"/.test(s))!));
    expect(fill).toContain(`CEIL(1.75 * c."capMinor")::bigint, NULL, c."capMinor"::bigint`);
    expect(fill).toContain(`FLOOR((p."value"->>'maxDailyBudgetMinor')::numeric * power(10::numeric, e."current" - COALESCE(e."stored", e."current")))`);
    // The cast is guarded by the regex inside a CASE, so a non-numeric cap can never fail the migration.
    expect(fill).toContain(`CASE WHEN (p."value"->>'maxDailyBudgetMinor') ~ '^[0-9]+$' THEN FLOOR(`);
    expect(fill).toContain(`WHERE p."key" LIKE 'ads:caps:%'`);
    expect(fill).toContain(`substr(p."key",10)`);
    expect(fill).toContain(`WHERE c."capMinor" > 0`);
    expect("ads:caps:".length + 1).toBe(10);
  });

  it("mirrors src/lib/ads/insights-money.ts in the backfill's exponent CASE (repair)", async () => {
    const { currencyExponent } = await import("@/lib/ads/insights-money");
    const fill = flat(stripSqlComments(statements.find((s) => s.includes('INSERT INTO "SpendAllowance"'))!));
    const zero = /IN \(([^)]*)\) THEN 0/.exec(fill)![1].match(/[A-Z]{3}/g)!;
    const three = /IN \(([^)]*)\) THEN 3/.exec(fill)![1].match(/[A-Z]{3}/g)!;
    for (const c of zero) expect(currencyExponent(c), c).toBe(0);
    for (const c of three) expect(currencyExponent(c), c).toBe(3);
    for (const c of ["INR", "USD", "EUR"]) expect(currencyExponent(c), c).toBe(2);
    expect(zero).toHaveLength(16);
    expect(three).toHaveLength(5);
  });

  it("stores EddyMessage.content as JSON, not JSONB, so replayed blocks stay byte-exact (repair)", () => {
    expect(tableBody("EddyMessage")).toMatch(/"content" JSON NOT NULL/);
    expect(tableBody("EddyMessage")).not.toMatch(/"content" JSONB/);
    const schema = readFileSync(path.resolve(__dirname, "../prisma/schema.prisma"), "utf8");
    const model = schema.slice(schema.indexOf("model EddyMessage {"), schema.indexOf("}", schema.indexOf("model EddyMessage {")));
    expect(model).toMatch(/content\s+Json\s+@db\.Json\b/);
  });

  it("backfills a SpendControl row per tenant with probation auto and the time zone fallback order", () => {
    const fill = flat(statements.find((s) => s.startsWith('INSERT INTO "SpendControl"'))!);
    expect(fill).toContain("'auto'");
    expect(fill).not.toContain("'lifted'");
    const ad = fill.indexOf(`a."meta"->>'timezone'`);
    const routing = fill.indexOf(`r."timezone" FROM "RoutingConfig"`);
    const fallback = fill.indexOf("'Asia/Kolkata')");
    expect(ad).toBeGreaterThan(0);
    expect(routing).toBeGreaterThan(ad);
    expect(fallback).toBeGreaterThan(routing);
    expect(fill).toContain("HAVING count(*) = 1");
    expect(fill).toContain('ON CONFLICT ("tenantId") DO NOTHING');
  });

  it("caps all three pots for new workspaces (decision 3): ads 2,000/20,000 INR, WhatsApp 500/5,000 INR, AI 500 credits a month", () => {
    const fill = flat(statements.find((s) => s.startsWith('INSERT INTO "SpendCeiling"'))!);
    const rows = [...fill.matchAll(/\('(sc_[a-z_]+)','(\w+)','(\*)','(\w+)','([A-Z]{3})',(NULL|\d+),(NULL|\d+),'[^']+',CURRENT_TIMESTAMP\)/g)].map((m) => m.slice(1, 8));
    expect(rows).toEqual([
      ["sc_probation_ads_inr", "probation", "*", "ads", "INR", "200000", "2000000"],
      ["sc_probation_messaging_inr", "probation", "*", "messaging", "INR", "50000", "500000"],
      ["sc_probation_ai_crd", "probation", "*", "ai", "CRD", "NULL", "500"],
    ]);
    for (const reason of fill.matchAll(/,'([^']+)',CURRENT_TIMESTAMP\)/g)) expect(reason[1].toLowerCase()).not.toContain("probation");
  });

  it("matches the Prisma schema: every table has a model, and the SQL-only objects are noted there", () => {
    const schema = readFileSync(path.resolve(__dirname, "../prisma/schema.prisma"), "utf8");
    for (const name of created) expect(schema, name).toMatch(new RegExp(`^model ${name} \\{`, "m"));
    expect(schema).toContain("NOTE: the partial indexes, CHECK constraints and append-only triggers in 0009 exist only in SQL.");
    expect(schema).toContain("Partial unique indexes, GIN indexes, CHECK constraints and the append-only triggers exist only in SQL.");
  });
});

describe("0010_spend_message_indexes runs outside a transaction", () => {
  const parts = splitSqlStatements(sql0010);

  it("says in its header to apply it without -1, off-peak", () => {
    const header = sql0010.split("\n").slice(0, 3).join("\n");
    expect(header).toContain("Apply with: psql -v ON_ERROR_STOP=1 -f migration.sql (no -1).");
    expect(header).toMatch(/WITHOUT -1, off-peak/);
    expect(needsNoTransaction(sql0010)).toBe(true);
  });

  it("holds only the two CONCURRENTLY IF NOT EXISTS Message indexes and the VALIDATE", () => {
    expect(parts.map(flat)).toEqual([
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "Message_spend_open_idx" ON "Message"("tenantId","spendDay") WHERE "spendState" = 'reserved'`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "Message_pricing_unsettled_idx" ON "Message"("tenantId","createdAt") WHERE "spendState" = 'settled' AND "pricingSettledAt" IS NULL`,
      `ALTER TABLE "Message" VALIDATE CONSTRAINT "Message_spendState_check"`,
    ]);
  });

  it("has no transaction control and nothing else", () => {
    const code = stripSqlComments(sql0010);
    expect(code).not.toMatch(/\b(BEGIN|COMMIT|ROLLBACK|START TRANSACTION|SET LOCAL)\b/i);
    expect(code).not.toMatch(/\b(DROP|DELETE|UPDATE|INSERT|TRUNCATE)\b/i);
  });
});

describe("the SQL splitter used by the db helper", () => {
  it("keeps dollar-quoted function bodies and quoted semicolons whole", () => {
    const parts = splitSqlStatements(`-- c; x\nCREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END $$;\nSELECT 'a;b'; SELECT "x;y" FROM t;`);
    expect(parts).toEqual(["CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END $$", "SELECT 'a;b'", 'SELECT "x;y" FROM t']);
  });
});
