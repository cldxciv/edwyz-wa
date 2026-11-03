import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { migrationNames, needsNoTransaction, readMigration, splitSqlStatements, stripSqlComments } from "./helpers/pg";

/**
 * Static proof that 0015_studio_canva is additive, safe to run twice inside one transaction (psql -1) and mirrored in
 * prisma/schema.prisma (docs/specs/ADS-MCP-CANVA-CREATIVE-SPEC.md 4.1, 4.2; MCC-00 acceptance 1). What the CHECKs, the partial
 * index and the foreign key do on a real Postgres is proven in tests/db/studio-migration.test.ts.
 */
const NAME = "0015_studio_canva";
const sql = readMigration(NAME);
const statements = splitSqlStatements(sql);
const code = stripSqlComments(sql);
const flat = (s: string) => s.replace(/\s+/g, " ").trim();
const schema = readFileSync(path.resolve(__dirname, "../prisma/schema.prisma"), "utf8");

/** Tables that exist before 0015. */
const preExisting = new Set(
  migrationNames()
    .filter((n) => n < "0015")
    .flatMap((n) => [...readMigration(n).matchAll(/CREATE TABLE (?:IF NOT EXISTS )?"(\w+)"/g)].map((m) => m[1])),
);

const NEW_TABLES = ["StudioItem", "StudioJob", "CanvaConnection", "CanvaReturnState"];

// ---------------------------------------------------------------------------------------------------------------------
// A small reader for the SQL column definitions and the Prisma fields they must match (as tests/promote-migration.test.ts).
// ---------------------------------------------------------------------------------------------------------------------

type SqlColumn = { table: string; name: string; type: string; notNull: boolean; default: string | null };
type PrismaField = { name: string; type: string; list: boolean; optional: boolean; attrs: string };

function parseColumn(table: string, def: string): SqlColumn {
  const m = /^"(\w+)" (TEXT\[\]|TEXT|INTEGER|BOOLEAN|TIMESTAMP\(3\)|JSONB|CHAR\(64\))( NOT NULL)?(?: DEFAULT (.+))?$/.exec(def.trim());
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
      .map((a) => parseColumn(table, a.replace(/^ADD COLUMN IF NOT EXISTS /, "")));
  });

const createdTables = new Map<string, { columns: SqlColumn[]; constraints: string[] }>();
for (const s of statements.filter((x) => x.startsWith("CREATE TABLE"))) {
  const table = /^CREATE TABLE IF NOT EXISTS "(\w+)"/.exec(s)![1];
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

const modelBlock = (name: string) => new RegExp(`^model ${name} \\{([\\s\\S]*?)^\\}`, "m").exec(schema)![1];

const PRISMA_TYPE: Record<string, { type: string; list?: true; native?: string }> = {
  TEXT: { type: "String" },
  "TEXT[]": { type: "String", list: true },
  INTEGER: { type: "Int" },
  BOOLEAN: { type: "Boolean" },
  "TIMESTAMP(3)": { type: "DateTime" },
  JSONB: { type: "Json" },
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

/** The guarded ADD CONSTRAINT of a DO block, or null for any other statement. */
const guarded = (s: string) => /^DO \$\$ BEGIN ALTER TABLE "(\w+)" ADD CONSTRAINT "(\w+)" (CHECK \(.*\)) NOT VALID; EXCEPTION WHEN duplicate_object THEN NULL; END \$\$$/.exec(flat(s));

// ---------------------------------------------------------------------------------------------------------------------

describe("0015_studio_canva is additive and safe to run twice (4.1)", () => {
  it("comes after 0013, with 0014 left unused, and 0012 and 0013 are unchanged", () => {
    const names = migrationNames();
    const at = names.indexOf("0013_ig_page_ads_indexes");
    expect(names[at + 1]).toBe(NAME);
    expect(names).not.toContain("0014");
    expect(names.some((n) => n.startsWith("0014_"))).toBe(false);
    // Never edit an applied migration (0001 to 0011 are pinned by tests/promote-migration.test.ts).
    const PINNED: Record<string, string> = {
      "0012_ig_page_ads": "83d4748979b1d3ad1d977d2318d3c57cbf268e79aa18f4df65897af6c9d74440",
      "0013_ig_page_ads_indexes": "97215819fc60f74f94f6c0f2774af6d157770c68ea50861f159e3c953809f1b1",
    };
    for (const [name, hash] of Object.entries(PINNED)) {
      expect(createHash("sha256").update(readMigration(name).replace(/\r\n/g, "\n")).digest("hex"), name).toBe(hash);
    }
  });

  it("keeps the header (apply with psql -1) and starts with SET LOCAL lock_timeout, before any other statement", () => {
    expect(sql.split("\n")[0]).toBe("-- 0015_studio_canva. Apply with: psql -v ON_ERROR_STOP=1 -1 -f migration.sql (deploy/README-deploy.md A step 5).");
    expect(sql).toContain("-- Additive only: four new tables and six new Brand columns with defaults. No existing row changes meaning.");
    expect(sql).toContain("Safe to run again (IF NOT EXISTS, guarded constraints).");
    expect(flat(statements[0])).toBe("SET LOCAL lock_timeout = '5s'");
    expect(statements.filter((s) => /^SET\b/i.test(s))).toHaveLength(1);
    // One transaction: no CONCURRENTLY, so the release applies it with -1 and before the restart.
    expect(needsNoTransaction(sql)).toBe(false);
  });

  it("has no DROP, RENAME, ALTER TYPE, ALTER COLUMN, UPDATE, DELETE, INSERT, TRUNCATE or transaction statement", () => {
    // The foreign key's ON DELETE SET NULL and ON UPDATE CASCADE are rules, not statements.
    const body = code.replace(/\bON (DELETE|UPDATE) (SET NULL|CASCADE)\b/g, "");
    expect(body).not.toMatch(/\bDROP\b/i);
    expect(body).not.toMatch(/\bRENAME\b/i);
    expect(body).not.toMatch(/\bALTER\s+TYPE\b/i);
    expect(body).not.toMatch(/\bALTER\s+COLUMN\b/i);
    expect(body).not.toMatch(/\bUPDATE\b/i);
    expect(body).not.toMatch(/\bDELETE\b/i);
    expect(body).not.toMatch(/\bINSERT\b/i);
    expect(body).not.toMatch(/\bTRUNCATE\b/i);
    expect(body).not.toMatch(/\bCONCURRENTLY\b/i);
    for (const s of statements) expect(flat(s), s).not.toMatch(/^(BEGIN|COMMIT|ROLLBACK|START TRANSACTION)\b/i);
  });

  it("is made only of statements that can run again: IF NOT EXISTS everywhere, constraints in duplicate_object guards", () => {
    const shapes = [
      /^SET LOCAL lock_timeout = '5s'$/,
      /^ALTER TABLE "Brand" ADD COLUMN IF NOT EXISTS .+$/,
      /^DO \$\$ BEGIN ALTER TABLE "Brand" ADD CONSTRAINT "\w+" CHECK \(.+\) NOT VALID; EXCEPTION WHEN duplicate_object THEN NULL; END \$\$$/,
      /^ALTER TABLE "Brand" VALIDATE CONSTRAINT "\w+"$/,
      /^CREATE TABLE IF NOT EXISTS "\w+" \(.+\)$/,
      /^CREATE (UNIQUE )?INDEX IF NOT EXISTS "\w+" ON "\w+"\(.+\)( WHERE .+)?$/,
    ];
    for (const s of statements) expect(shapes.some((re) => re.test(flat(s))), flat(s)).toBe(true);
    // Every ADD COLUMN in the ALTER, not only the first, carries IF NOT EXISTS.
    const alter = flat(statements.find((s) => s.includes("ADD COLUMN"))!);
    expect(alter.match(/ADD COLUMN/g)).toHaveLength(6);
    expect(alter.match(/ADD COLUMN IF NOT EXISTS/g)).toHaveLength(6);
  });

  it("only adds columns to Brand, each nullable or with a constant default, and guards and validates its four CHECKs", () => {
    expect([...new Set(added.map((c) => c.table))]).toEqual(["Brand"]);
    expect(preExisting.has("Brand")).toBe(true);
    expect(added.map((c) => c.name)).toEqual(["logoMediaKey", "fontStyle", "defaultLanguage", "tagline", "contactLine", "isDefault"]);
    for (const col of added) if (col.notNull) expect(col.default, `${col.table}.${col.name}`).toMatch(/^('[^']*'|\d+|false|true)$/);
    expect(added.find((c) => c.name === "fontStyle")).toMatchObject({ type: "TEXT", notNull: true, default: "'simple'" });
    expect(added.find((c) => c.name === "defaultLanguage")).toMatchObject({ type: "TEXT", notNull: true, default: "'en'" });
    expect(added.find((c) => c.name === "isDefault")).toMatchObject({ type: "BOOLEAN", notNull: true, default: "false" });

    const checks = statements.map(guarded).filter((m): m is RegExpExecArray => m !== null);
    expect(checks.map((m) => m[2])).toEqual(["Brand_fontStyle_check", "Brand_defaultLanguage_check", "Brand_logoMediaKey_check", "Brand_text_len_check"]);
    for (const m of checks) expect(m[1]).toBe("Brand");
    expect(checks.find((m) => m[2] === "Brand_fontStyle_check")![3]).toBe(`CHECK ("fontStyle" IN ('simple','festive','modern'))`);
    expect(checks.find((m) => m[2] === "Brand_defaultLanguage_check")![3]).toBe(`CHECK ("defaultLanguage" IN ('en','hi','both'))`);
    expect(checks.find((m) => m[2] === "Brand_logoMediaKey_check")![3]).toBe(`CHECK ("logoMediaKey" IS NULL OR "logoMediaKey" ~ '^[a-f0-9]{32}\\.(jpg|png)$')`);
    expect(checks.find((m) => m[2] === "Brand_text_len_check")![3]).toBe(`CHECK (coalesce(length("tagline"),0) <= 80 AND coalesce(length("contactLine"),0) <= 60)`);
    // Each NOT VALID constraint is validated once, after its guard, in this same file (Brand is small).
    const validated = statements.map(flat).filter((s) => s.includes("VALIDATE CONSTRAINT")).map((s) => /"(\w+)"$/.exec(s)![1]);
    expect(validated).toEqual(checks.map((m) => m[2]));
    for (const name of validated) {
      expect(statements.findIndex((s) => flat(s).endsWith(`VALIDATE CONSTRAINT "${name}"`))).toBeGreaterThan(statements.findIndex((s) => s.includes(`"${name}" CHECK`)));
    }
  });

  it("builds the partial unique index Brand_tenant_default_key: one default brand per workspace", () => {
    expect(statements.map(flat)).toContain(`CREATE UNIQUE INDEX IF NOT EXISTS "Brand_tenant_default_key" ON "Brand"("tenantId") WHERE "isDefault"`);
  });

  it("creates exactly the four new tables, none of which existed, with every CHECK, the keys and the brand link", () => {
    expect([...createdTables.keys()]).toEqual(NEW_TABLES);
    for (const t of NEW_TABLES) expect(preExisting.has(t), t).toBe(false);
    const constraint = (table: string, name: string) => flat(createdTables.get(table)!.constraints.find((c) => c.startsWith(`CONSTRAINT "${name}"`)) ?? "");
    expect(constraint("StudioItem", "StudioItem_kind_check")).toBe(`CONSTRAINT "StudioItem_kind_check" CHECK ("kind" IN ('image','video'))`);
    expect(constraint("StudioItem", "StudioItem_source_check")).toBe(`CONSTRAINT "StudioItem_source_check" CHECK ("source" IN ('render','canva','logo'))`);
    expect(constraint("StudioItem", "StudioItem_size_check")).toBe(`CONSTRAINT "StudioItem_size_check" CHECK ("size" IS NULL OR "size" IN ('square','feed','story','original'))`);
    expect(constraint("StudioItem", "StudioItem_format_check")).toBe(`CONSTRAINT "StudioItem_format_check" CHECK ("format" IN ('jpg','png','mp4'))`);
    expect(constraint("StudioItem", "StudioItem_mediaKey_check")).toBe(`CONSTRAINT "StudioItem_mediaKey_check" CHECK ("mediaKey" ~ '^[a-f0-9]{32}\\.(jpg|png|mp4)$')`);
    expect(constraint("StudioItem", "StudioItem_canva_check")).toBe(`CONSTRAINT "StudioItem_canva_check" CHECK ("source" <> 'canva' OR "canvaDesignId" IS NOT NULL)`);
    expect(constraint("StudioItem", "StudioItem_bytes_check")).toBe(`CONSTRAINT "StudioItem_bytes_check" CHECK ("bytes" > 0 AND "bytes" <= 104857600)`);
    expect(constraint("StudioItem", "StudioItem_brandId_fkey")).toBe(`CONSTRAINT "StudioItem_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE SET NULL ON UPDATE CASCADE`);
    expect(constraint("StudioJob", "StudioJob_kind_check")).toBe(`CONSTRAINT "StudioJob_kind_check" CHECK ("kind" IN ('canva_import','canva_autofill','canva_return'))`);
    expect(constraint("StudioJob", "StudioJob_state_check")).toBe(`CONSTRAINT "StudioJob_state_check" CHECK ("state" IN ('queued','uploading','filling','exporting','downloading','done','failed'))`);
    expect(constraint("StudioJob", "StudioJob_attempts_check")).toBe(`CONSTRAINT "StudioJob_attempts_check" CHECK ("attempts" BETWEEN 0 AND 60)`);
    expect(constraint("CanvaConnection", "CanvaConnection_status_check")).toBe(`CONSTRAINT "CanvaConnection_status_check" CHECK ("status" IN ('active','expired','revoked','error'))`);
    expect(constraint("CanvaReturnState", "CanvaReturnState_id_check")).toBe(`CONSTRAINT "CanvaReturnState_id_check" CHECK ("id" ~ '^[A-Za-z0-9_-]{22}$')`);
    expect(constraint("CanvaReturnState", "CanvaReturnState_purpose_check")).toBe(`CONSTRAINT "CanvaReturnState_purpose_check" CHECK ("purpose" IN ('edit','new_design','autofill'))`);
    expect(constraint("CanvaReturnState", "CanvaReturnState_path_check")).toBe(`CONSTRAINT "CanvaReturnState_path_check" CHECK ("returnPath" IS NULL OR "returnPath" ~ '^/app/[A-Za-z0-9/_?=&.-]{0,200}$')`);
    for (const t of NEW_TABLES) expect(constraint(t, `${t}_pkey`), t).toBe(`CONSTRAINT "${t}_pkey" PRIMARY KEY ("id")`);
    // The only foreign key is the brand link; nothing references Tenant (erasure goes through PERSONAL_DATA).
    expect(code.match(/REFERENCES/g)).toHaveLength(1);
    expect(code).not.toMatch(/REFERENCES "Tenant"/);
    // Canva tokens are stored sealed: only the *Enc columns, no plain token column.
    const canva = createdTables.get("CanvaConnection")!.columns.map((c) => c.name);
    expect(canva.filter((c) => /token/i.test(c)).sort()).toEqual(["accessTokenEnc", "refreshTokenEnc"]);
  });

  it("indexes the new tables as 4.1 lists them", () => {
    const indexes = statements
      .map(flat)
      .filter((s) => s.startsWith("CREATE") && s.includes("INDEX"))
      .map((s) => /INDEX IF NOT EXISTS "(\w+)" ON "\w+"\((.+?)\)/.exec(s)!)
      .map((m) => `${m[1]}(${m[2]})`);
    expect(indexes).toEqual([
      `Brand_tenant_default_key("tenantId")`,
      `StudioItem_tenantId_mediaKey_key("tenantId","mediaKey")`,
      `StudioItem_tenantId_createdAt_idx("tenantId","createdAt")`,
      `StudioItem_tenantId_canvaDesignId_idx("tenantId","canvaDesignId")`,
      `StudioJob_tenantId_createdAt_idx("tenantId","createdAt")`,
      `StudioJob_state_nextPollAt_idx("state","nextPollAt")`,
      `CanvaConnection_tenantId_userId_key("tenantId","userId")`,
      `CanvaConnection_tenantId_status_idx("tenantId","status")`,
      `CanvaReturnState_tenantId_userId_idx("tenantId","userId")`,
      `CanvaReturnState_expiresAt_idx("expiresAt")`,
    ]);
    const unique = statements.map(flat).filter((s) => s.startsWith("CREATE UNIQUE INDEX")).map((s) => /"(\w+)"/.exec(s)![1]);
    expect(unique).toEqual(["Brand_tenant_default_key", "StudioItem_tenantId_mediaKey_key", "CanvaConnection_tenantId_userId_key"]);
  });
});

describe("prisma/schema.prisma mirrors 0015 (4.2)", () => {
  it("has the six Brand columns with a matching type, nullability and default, and the studioItems back-relation", () => {
    expect(added).toHaveLength(6);
    for (const col of added) expectMirrored(col);
    expect(prismaModel("Brand").get("studioItems")).toMatchObject({ type: "StudioItem", list: true });
    expect(prismaModel("Brand").get("briefs")).toMatchObject({ type: "CreativeBrief", list: true });
  });

  it("has a model for every new table, with every column matching and no field without a column but the brand relation", () => {
    for (const [table, { columns }] of createdTables) {
      const model = prismaModel(table);
      for (const col of columns) expectMirrored(col);
      const scalar = [...model.values()].filter((f) => ["String", "Int", "BigInt", "Boolean", "DateTime", "Json"].includes(f.type));
      expect(scalar.map((f) => f.name).sort(), table).toEqual(columns.map((c) => c.name).sort());
      expect([...model.values()].some((f) => f.type === "Tenant"), table).toBe(false);
    }
    expect([...prismaModel("StudioItem").values()].filter((f) => !["String", "Int", "Boolean", "DateTime", "Json"].includes(f.type)).map((f) => f.name)).toEqual(["brand"]);
    // CanvaReturnState's id is the 22-character correlation id the app makes, not a cuid.
    expect(prismaModel("CanvaReturnState").get("id")?.attrs).toBe("@id");
  });

  it("keeps the brand relation (set null on delete), the unique keys and the indexes under their SQL names", () => {
    expect(prismaModel("StudioItem").get("brand")).toMatchObject({ type: "Brand", optional: true });
    expect(prismaModel("StudioItem").get("brand")?.attrs).toBe("@relation(fields: [brandId], references: [id], onDelete: SetNull)");
    // Prisma's default names equal the SQL names: <Model>_<fields>_key and <Model>_<fields>_idx.
    expect(modelBlock("StudioItem")).toMatch(/@@unique\(\[tenantId, mediaKey\]\)/);
    expect(modelBlock("StudioItem")).toMatch(/@@index\(\[tenantId, createdAt\]\)/);
    expect(modelBlock("StudioItem")).toMatch(/@@index\(\[tenantId, canvaDesignId\]\)/);
    expect(modelBlock("StudioJob")).toMatch(/@@index\(\[tenantId, createdAt\]\)/);
    expect(modelBlock("StudioJob")).toMatch(/@@index\(\[state, nextPollAt\]\)/);
    expect(modelBlock("CanvaConnection")).toMatch(/@@unique\(\[tenantId, userId\]\)/);
    expect(modelBlock("CanvaConnection")).toMatch(/@@index\(\[tenantId, status\]\)/);
    expect(modelBlock("CanvaReturnState")).toMatch(/@@index\(\[tenantId, userId\]\)/);
    expect(modelBlock("CanvaReturnState")).toMatch(/@@index\(\[expiresAt\]\)/);
  });

  it("names every CHECK and the partial unique index of 0015 in the schema, as SQL-only objects", () => {
    // Each Brand CHECK is named twice (ADD and VALIDATE).
    const names = [...new Set([...code.matchAll(/CONSTRAINT "(\w+_check)"/g)].map((m) => m[1]))];
    expect(names).toHaveLength(4 + 7 + 3 + 1 + 3);
    for (const name of names) expect(schema, name).toContain(name);
    expect(schema).toContain("Brand_tenant_default_key");
    // Partial indexes stay SQL only: Prisma cannot express them.
    expect(schema).not.toMatch(/map: "Brand_tenant_default_key"/);
    expect(modelBlock("Brand")).not.toMatch(/@@unique\(\[tenantId\]/);
  });
});
