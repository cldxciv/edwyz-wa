import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { migrationNames, needsNoTransaction, readMigration, splitSqlStatements, stripSqlComments } from "./helpers/pg";

/**
 * Static proof that 0012_ig_page_ads and 0013_ig_page_ads_indexes are additive, safe on the live database and mirrored in
 * prisma/schema.prisma (docs/IG-PAGE-ADS-SPEC.md 5, 5.1, 5.2, 5.3; PRM-00 acceptance 1). What the CHECKs reject on a real
 * Postgres is proven in tests/db/promote-migration.test.ts.
 */
const sql0012 = readMigration("0012_ig_page_ads");
const sql0013 = readMigration("0013_ig_page_ads_indexes");
const statements = splitSqlStatements(sql0012);
const code0012 = stripSqlComments(sql0012);
const flat = (s: string) => s.replace(/\s+/g, " ").trim();
const schema = readFileSync(path.resolve(__dirname, "../prisma/schema.prisma"), "utf8");

/** Tables that exist before 0012. */
const preExisting = new Set(
  migrationNames()
    .filter((n) => n < "0012")
    .flatMap((n) => [...readMigration(n).matchAll(/CREATE TABLE "(\w+)"/g)].map((m) => m[1])),
);

const NEW_TABLES = ["AdMedia", "AdAudience", "AdAudienceUpload", "AdTest", "InsightBreakdown"];
const ALTERED = ["AdCampaign", "AdSet", "Ad", "Lead", "LeadForm", "InsightSnapshot"];

// ---------------------------------------------------------------------------------------------------------------------
// A small reader for the SQL column definitions and the Prisma fields they must match.
// ---------------------------------------------------------------------------------------------------------------------

type SqlColumn = { table: string; name: string; type: string; notNull: boolean; default: string | null };
type PrismaField = { name: string; type: string; list: boolean; optional: boolean; attrs: string };

function parseColumn(table: string, def: string): SqlColumn {
  const m = /^"(\w+)" (TEXT\[\]|TEXT|INTEGER|BIGINT|BOOLEAN|TIMESTAMP\(3\)|JSONB|DATE|CHAR\(64\))( NOT NULL)?(?: DEFAULT (.+))?$/.exec(def.trim());
  if (!m) throw new Error(`unparsed column in ${table}: ${def}`);
  return { table, name: m[1], type: m[2], notNull: !!m[3], default: m[4] ?? null };
}

/** Splits a CREATE TABLE body on top-level commas (CHECK lists hold commas inside parentheses). */
function splitTopLevel(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  let quote = false;
  for (const ch of body) {
    if (ch === "'") quote = !quote;
    if (!quote && ch === "(") depth++;
    if (!quote && ch === ")") depth--;
    if (!quote && ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const added: SqlColumn[] = statements
  .filter((s) => /^ALTER TABLE "\w+"\s+ADD COLUMN/.test(s))
  .flatMap((s) => {
    const table = /^ALTER TABLE "(\w+)"/.exec(s)![1];
    return flat(s)
      .replace(/^ALTER TABLE "\w+" /, "")
      .split(/,\s*(?=ADD COLUMN )/)
      .map((a) => parseColumn(table, a.replace(/^ADD COLUMN /, "")));
  });

const createdTables = new Map<string, { columns: SqlColumn[]; constraints: string[] }>();
for (const s of statements.filter((x) => x.startsWith("CREATE TABLE"))) {
  const table = /^CREATE TABLE "(\w+)"/.exec(s)![1];
  const body = flat(s).slice(flat(s).indexOf("(") + 1, flat(s).lastIndexOf(")"));
  const parts = splitTopLevel(body);
  createdTables.set(table, {
    columns: parts.filter((p) => p.startsWith('"')).map((p) => parseColumn(table, p)),
    constraints: parts.filter((p) => p.startsWith("CONSTRAINT")),
  });
}

function prismaModel(name: string): Map<string, PrismaField> {
  const m = new RegExp(`^model ${name} \\{([\\s\\S]*?)^\\}`, "m").exec(schema);
  if (!m) throw new Error(`schema.prisma has no model ${name}`);
  const fields = new Map<string, PrismaField>();
  for (const line of m[1].split("\n").map((l) => l.trim())) {
    if (!line || line.startsWith("//") || line.startsWith("@@")) continue;
    const f = /^(\w+)\s+(\w+)(\[\])?(\?)?\s*(.*)$/.exec(line);
    if (f) fields.set(f[1], { name: f[1], type: f[2], list: !!f[3], optional: !!f[4], attrs: f[5] });
  }
  return fields;
}

const PRISMA_TYPE: Record<string, { type: string; list?: true; native?: string }> = {
  TEXT: { type: "String" },
  "TEXT[]": { type: "String", list: true },
  INTEGER: { type: "Int" },
  BIGINT: { type: "BigInt" },
  BOOLEAN: { type: "Boolean" },
  "TIMESTAMP(3)": { type: "DateTime" },
  JSONB: { type: "Json" },
  DATE: { type: "DateTime", native: "@db.Date" },
  "CHAR(64)": { type: "String", native: "@db.Char(64)" },
};

/** The Prisma @default that matches a SQL DEFAULT. */
function prismaDefault(sqlDefault: string): string {
  if (sqlDefault === "CURRENT_TIMESTAMP") return "@default(now())";
  if (sqlDefault === "ARRAY[]::TEXT[]") return "@default([])";
  const text = /^'(.*)'$/.exec(sqlDefault);
  if (text) return `@default("${text[1]}")`;
  return `@default(${sqlDefault})`;
}

function expectMirrored(col: SqlColumn) {
  const field = prismaModel(col.table).get(col.name);
  const where = `${col.table}.${col.name}`;
  expect(field, `${where} is missing from schema.prisma`).toBeDefined();
  const want = PRISMA_TYPE[col.type];
  expect(field!.type, where).toBe(want.type);
  expect(field!.list, where).toBe(!!want.list);
  if (want.native) expect(field!.attrs, where).toContain(want.native);
  else expect(field!.attrs, where).not.toMatch(/@db\./);
  // A list is never optional in Prisma; every other column is optional exactly when SQL allows NULL.
  if (!want.list) expect(field!.optional, where).toBe(!col.notNull);
  if (col.default) expect(field!.attrs, where).toContain(prismaDefault(col.default));
  // The id's cuid() is made by the Prisma client, not by the database, so it has no SQL DEFAULT.
  else expect(field!.attrs.replace(/^@id @default\(cuid\(\)\)$/, "@id"), where).not.toContain("@default(");
}

// ---------------------------------------------------------------------------------------------------------------------

describe("0012_ig_page_ads is additive and safe on the live database (5.1)", () => {
  it("is numbered straight after 0011, with 0013 next, and 0001 to 0011 are unchanged", () => {
    const names = migrationNames();
    const at = names.indexOf("0011_template_flagged");
    expect(names.slice(at, at + 3)).toEqual(["0011_template_flagged", "0012_ig_page_ads", "0013_ig_page_ads_indexes"]);
    // Content hashes of the applied files (line endings normalised): never edit an applied migration.
    const PINNED: Record<string, string> = {
      "0001_init": "79babee5e01b107aab238e78e9e9c3e7848dc898a353851463e34a73ea5c01a8",
      "0002_platform": "1765206e6aa61b2d5a033d9088614c5db6cc8124cded911514d6e869285ee95e",
      "0003_security_accounts": "212c1fbbd007fa054b7248943c493d80efae8547b02096ccaa5ccf03ee990f72",
      "0004_phase2": "48a49768cd81a643eee585680290ecd238b053f8ebdf74d2cb9dd91d686b76c2",
      "0005_growth": "ba979ddca53d2c6561a8fda209a4e4e6685fd759c0d5454083940edc943104e9",
      "0006_gap_closure": "cbfe26cd8d575b825c2d4ab183d96c4b7c95a5c3601b748e3bed3bbd7d70a453",
      "0007_bsuid": "fd50ba95b687d08a61033e4b8ca68b89135ccd6526769dcf1609c4c7d01d6000",
      "0008_agent_reply_backfill": "47c7355e0fa5c24d3cd0d4981c0d3f753d8af7e5af87d1afa7853d65664242b8",
      "0009_spend_controls": "792e042b87b6a3e27ce0a295bfe758d3aa36299fe8210a6af8b02438a70518e2",
      "0010_spend_message_indexes": "ce9ac2e59c2d05f835ab795d2d9dd2354faf26703f97cb5a60d73b72d75c1df1",
      "0011_template_flagged": "33f915d6c83b43a9681714bd48513d603be007565e733fa2ceab0b887cc24e0e",
    };
    expect(names.slice(0, 11)).toEqual(Object.keys(PINNED));
    for (const [name, hash] of Object.entries(PINNED)) {
      expect(createHash("sha256").update(readMigration(name).replace(/\r\n/g, "\n")).digest("hex"), name).toBe(hash);
    }
  });

  it("keeps the header and starts with both SET LOCAL timeouts, before any other statement", () => {
    expect(sql0012.split("\n")[0]).toBe("-- 0012_ig_page_ads. Instagram and Facebook Page ads. See docs/IG-PAGE-ADS-SPEC.md section 5.");
    expect(sql0012).toContain("-- Apply: psql -1 -v ON_ERROR_STOP=1 -f migration.sql (as edwyz_wa_app)");
    expect(flat(statements[0])).toBe("SET LOCAL lock_timeout = '5s'");
    expect(flat(statements[1])).toBe("SET LOCAL statement_timeout = '120s'");
    expect(statements.filter((s) => /^SET\b/i.test(s))).toHaveLength(2);
    expect(needsNoTransaction(sql0012)).toBe(false);
  });

  it("has no DROP, RENAME, ALTER TYPE, ALTER COLUMN, UPDATE, DELETE, INSERT or TRUNCATE", () => {
    expect(code0012).not.toMatch(/\bDROP\b/i);
    expect(code0012).not.toMatch(/\bRENAME\b/i);
    expect(code0012).not.toMatch(/\bALTER\s+TYPE\b/i);
    expect(code0012).not.toMatch(/\bALTER\s+COLUMN\b/i);
    expect(code0012).not.toMatch(/\bUPDATE\b/i);
    expect(code0012).not.toMatch(/\bTRUNCATE\b/i);
    expect(code0012).not.toMatch(/\bINSERT\b/i);
    for (const s of statements) expect(s, s).not.toMatch(/^\s*DELETE\b/i);
    expect(code0012).not.toMatch(/\b(BEGIN|COMMIT|ROLLBACK)\b/i);
    expect(code0012).not.toMatch(/\bCONCURRENTLY\b/i);
  });

  it("only adds columns and NOT VALID constraints to existing tables, each column nullable or with a constant default", () => {
    const alters = statements.filter((s) => /^ALTER TABLE/i.test(s));
    for (const s of alters) {
      const table = /^ALTER TABLE "(\w+)"/.exec(s)![1];
      expect(preExisting.has(table), table).toBe(true);
      expect(ALTERED, table).toContain(table);
      for (const action of flat(s).replace(/^ALTER TABLE "\w+" /, "").split(/,\s*(?=ADD )/)) expect(action, action).toMatch(/^ADD (COLUMN|CONSTRAINT) /);
    }
    for (const col of added) {
      if (col.notNull) expect(col.default, `${col.table}.${col.name}`).toMatch(/^('[^']*'|\d+|false|true|ARRAY\[\]::TEXT\[\])$/);
    }
    expect([...new Set(added.map((c) => c.table))].sort()).toEqual([...ALTERED].sort());
  });

  it("adds every CHECK on an existing table as NOT VALID", () => {
    const checks = statements.filter((s) => /^ALTER TABLE "\w+" ADD CONSTRAINT/.test(s));
    expect(checks.length).toBe(16);
    for (const s of checks) {
      expect(flat(s), s).toMatch(/ CHECK \(.*\) NOT VALID$/);
      expect(preExisting.has(/^ALTER TABLE "(\w+)"/.exec(s)![1])).toBe(true);
    }
  });

  it("has the critic columns runDays and startMode with their CHECKs, and the run_total dimension", () => {
    expect(added).toContainEqual({ table: "AdCampaign", name: "runDays", type: "INTEGER", notNull: false, default: null });
    expect(added).toContainEqual({ table: "AdCampaign", name: "startMode", type: "TEXT", notNull: false, default: null });
    expect(code0012).toContain(`CHECK ("runDays" IS NULL OR "runDays" BETWEEN 2 AND 90) NOT VALID`);
    expect(code0012).toContain(`CHECK ("startMode" IS NULL OR "startMode" IN ('now','at')) NOT VALID`);
    expect(code0012).toContain(`CHECK ("surface" NOT IN ('promote','eddy') OR "endsAt" IS NOT NULL OR "lifetimeBudgetMinor" IS NOT NULL) NOT VALID`);
    expect(code0012).toContain(`CHECK ("schedule" IS NULL OR "lifetimeBudgetMinor" IS NOT NULL) NOT VALID`);
    expect(flat(createdTables.get("InsightBreakdown")!.constraints.find((c) => c.includes("InsightBreakdown_dimension_check"))!)).toContain("'run_total'");
  });

  it("creates exactly the five new tables, none of which existed, with their keys and the cascade relations", () => {
    expect([...createdTables.keys()].sort()).toEqual([...NEW_TABLES].sort());
    for (const t of NEW_TABLES) expect(preExisting.has(t), t).toBe(false);
    expect(code0012).toContain(`CONSTRAINT "AdAudienceUpload_audience_fkey" FOREIGN KEY ("audienceId") REFERENCES "AdAudience"("id") ON DELETE CASCADE`);
    expect(code0012).toContain(`CONSTRAINT "AdTest_campaign_fkey" FOREIGN KEY ("campaignId") REFERENCES "AdCampaign"("id") ON DELETE CASCADE`);
    expect(code0012).toContain(`CREATE UNIQUE INDEX "AdTest_campaign_key" ON "AdTest"("campaignId");`);
    expect(code0012).toContain(`CREATE UNIQUE INDEX "InsightBreakdown_key" ON "InsightBreakdown"("tenantId","entityType","entityMetaId","date","dimension","dimKey");`);
    // No foreign key to Tenant (5.3): erasure goes through PERSONAL_DATA.
    expect(code0012).not.toMatch(/REFERENCES "Tenant"/);
    // AdAudienceUpload holds counts only: no hash or identifier column.
    expect(createdTables.get("AdAudienceUpload")!.columns.map((c) => c.name)).not.toEqual(expect.arrayContaining(["hash"]));
    for (const c of createdTables.get("AdAudienceUpload")!.columns) expect(c.name, c.name).not.toMatch(/hash|phone|email/i);
  });
});

describe("prisma/schema.prisma mirrors 0012 (5.3)", () => {
  it("has every added column on the six existing models with a matching type, nullability and default", () => {
    expect(added.length).toBe(12 + 9 + 7 + 6 + 10 + 8);
    for (const col of added) expectMirrored(col);
  });

  it("has a model for every new table, with every column matching", () => {
    for (const [table, { columns }] of createdTables) {
      const model = prismaModel(table);
      for (const col of columns) expectMirrored(col);
      // No field without a column, except the relation fields.
      const scalar = [...model.values()].filter((f) => !/^[A-Z]/.test(f.type) || ["String", "Int", "BigInt", "Boolean", "DateTime", "Json"].includes(f.type));
      expect(scalar.map((f) => f.name).sort(), table).toEqual(columns.map((c) => c.name).sort());
    }
  });

  it("keeps the relations, the unique keys and the back-relation, and no relation to Tenant", () => {
    expect(prismaModel("AdAudienceUpload").get("audience")?.attrs).toMatch(/@relation\(fields: \[audienceId\], references: \[id\], onDelete: Cascade/);
    expect(prismaModel("AdTest").get("campaign")?.attrs).toMatch(/@relation\(fields: \[campaignId\], references: \[id\], onDelete: Cascade/);
    expect(prismaModel("AdCampaign").get("adTest")).toMatchObject({ type: "AdTest", optional: true });
    expect(prismaModel("AdAudience").get("uploads")).toMatchObject({ type: "AdAudienceUpload", list: true });
    const block = schema.slice(schema.indexOf("model AdMedia {"));
    expect(block).toMatch(/@@unique\(\[campaignId\], map: "AdTest_campaign_key"\)/);
    expect(block).toMatch(/@@unique\(\[tenantId, entityType, entityMetaId, date, dimension, dimKey\], map: "InsightBreakdown_key"\)/);
    expect(block).toMatch(/@@unique\(\[tenantId, adAccountAssetId, sha256\], map: "AdMedia_tenant_account_sha_key"\)/);
    for (const t of NEW_TABLES) expect([...prismaModel(t).values()].some((f) => f.type === "Tenant"), t).toBe(false);
  });

  it("names every CHECK and the partial unique index of 0012 in the schema, as SQL-only objects", () => {
    const names = [...code0012.matchAll(/CONSTRAINT "(\w+_check)"/g)].map((m) => m[1]);
    expect(names.length).toBe(16 + 16);
    for (const name of names) expect(schema, name).toContain(name);
    expect(schema).toContain("AdAudience_meta_key");
    // Partial indexes stay SQL only: Prisma cannot express them.
    expect(schema).not.toMatch(/map: "AdAudience_meta_key"/);
  });
});

describe("0013_ig_page_ads_indexes runs outside a transaction (5.2)", () => {
  const parts = splitSqlStatements(sql0013).map(flat);
  const notValid = statements
    .filter((s) => / NOT VALID$/.test(flat(s)))
    .map((s) => {
      const m = /^ALTER TABLE "(\w+)" ADD CONSTRAINT "(\w+)"/.exec(flat(s))!;
      return `${m[1]}.${m[2]}`;
    });

  it("says in its header to apply it WITHOUT -1, off-peak, after 0012", () => {
    expect(sql0013.split("\n")[0]).toBe("-- 0013_ig_page_ads_indexes. Apply with: psql -v ON_ERROR_STOP=1 -f migration.sql (NO -1), off-peak, after 0012.");
    expect(needsNoTransaction(sql0013)).toBe(true);
  });

  it("holds only CREATE INDEX CONCURRENTLY IF NOT EXISTS and VALIDATE CONSTRAINT statements", () => {
    expect(parts.length).toBe(5 + 16);
    for (const s of parts) expect(s, s).toMatch(/^(CREATE INDEX CONCURRENTLY IF NOT EXISTS "\w+" ON "\w+"\(.+\)( WHERE .+)?|ALTER TABLE "\w+" VALIDATE CONSTRAINT "\w+")$/);
    const code = stripSqlComments(sql0013);
    expect(code).not.toMatch(/\b(BEGIN|COMMIT|ROLLBACK|START TRANSACTION|SET LOCAL|DROP|DELETE|UPDATE|INSERT|TRUNCATE|RENAME)\b/i);
  });

  it("validates each NOT VALID constraint of 0012 exactly once, on its own table, and nothing else", () => {
    const validated = parts.filter((s) => s.startsWith("ALTER TABLE")).map((s) => {
      const m = /^ALTER TABLE "(\w+)" VALIDATE CONSTRAINT "(\w+)"$/.exec(s)!;
      return `${m[1]}.${m[2]}`;
    });
    expect(notValid.length).toBe(16);
    expect([...validated].sort()).toEqual([...notValid].sort());
    expect(new Set(validated).size).toBe(validated.length);
  });

  it("builds the five indexes of 5.2, two of them partial", () => {
    const indexes = parts.filter((s) => s.startsWith("CREATE INDEX")).map((s) => /"(\w+)"/.exec(s)![1]);
    expect(indexes).toEqual(["Lead_tenant_source_created_idx", "Lead_tenant_ad_idx", "Lead_tenant_conversation_idx", "AdCampaign_tenant_surface_idx", "Ad_review_open_idx"]);
    expect(parts.find((s) => s.includes('"Ad_review_open_idx"'))).toContain(`WHERE "effectiveStatus" IN ('PENDING_REVIEW','IN_PROCESS','WITH_ISSUES','DISAPPROVED')`);
    expect(parts.find((s) => s.includes('"Lead_tenant_conversation_idx"'))).toContain(`WHERE "conversationId" IS NOT NULL`);
  });
});
