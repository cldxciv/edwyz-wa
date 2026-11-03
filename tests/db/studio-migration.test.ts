import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigration, createTestDb, HAS_TEST_DB, sqlState, type TestDb } from "../helpers/pg";

/**
 * Database proof of 0015_studio_canva (docs/specs/ADS-MCP-CANVA-CREATIVE-SPEC.md 4.1, 8.2; MCC-00 acceptance 1): it applies
 * twice with psql -1, a Brand row written before it keeps working with the new defaults, every CHECK rejects its bad row with
 * SQLSTATE 23514, the partial unique index allows one default brand per workspace, and deleting a Brand sets
 * StudioItem.brandId to null. Runs only with DATABASE_URL_TEST set; each run works in its own schema and drops it afterwards.
 */
const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";
const NAME = "0015_studio_canva";
const SHA = "a".repeat(64);
const KEY = (ext = "jpg", c = "b") => `${c.repeat(32)}.${ext}`;
const CORRELATION = "Abcdefghij_klmnop-1234"; // 22 base64url characters

const CONSTRAINTS_0015 = [
  "Brand_fontStyle_check", "Brand_defaultLanguage_check", "Brand_logoMediaKey_check", "Brand_text_len_check",
  "StudioItem_kind_check", "StudioItem_source_check", "StudioItem_size_check", "StudioItem_format_check", "StudioItem_mediaKey_check",
  "StudioItem_canva_check", "StudioItem_bytes_check", "StudioItem_brandId_fkey", "StudioJob_kind_check", "StudioJob_state_check",
  "StudioJob_attempts_check", "CanvaConnection_status_check", "CanvaReturnState_id_check", "CanvaReturnState_purpose_check",
  "CanvaReturnState_path_check",
];

describe.skipIf(!HAS_TEST_DB)("0015_studio_canva on Postgres", () => {
  let db: TestDb;
  const q = (text: string, values?: unknown[]) => db.query(text, values);

  /** INSERT INTO "<table>" with the given columns; returns the query promise. */
  const insert = (table: string, cols: Record<string, unknown>) => {
    const keys = Object.keys(cols);
    return q(`INSERT INTO "${table}" (${keys.map((k) => `"${k}"`).join(",")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(",")})`, Object.values(cols));
  };
  const brand = (id: string, extra: Record<string, unknown> = {}) => insert("Brand", { id, tenantId: "t1", name: `Brand ${id}`, updatedAt: new Date(), ...extra });
  let item = 0;
  /** A fresh Library key per row (32 hex characters from a counter), so only the rows meant to collide do. */
  const studioItem = (extra: Record<string, unknown> = {}) => {
    item += 1;
    return insert("StudioItem", { id: `si_${item}`, tenantId: "t1", mediaKey: `${item.toString(16).padStart(32, "0")}.jpg`, kind: "image", source: "render", format: "jpg", bytes: 1000, sha256: SHA, ...extra });
  };
  let job = 0;
  const studioJob = (extra: Record<string, unknown> = {}) => insert("StudioJob", { id: `sj_${++job}`, tenantId: "t1", userId: "u1", kind: "canva_import", input: JSON.stringify({ v: 1 }), ...extra });
  let conn = 0;
  const canvaConnection = (extra: Record<string, unknown> = {}) => insert("CanvaConnection", { id: `cc_${++conn}`, tenantId: "t1", userId: `u_${conn}`, canvaUserId: `cu_${conn}`, ...extra });
  const returnState = (id: string, extra: Record<string, unknown> = {}) =>
    insert("CanvaReturnState", { id, tenantId: "t1", userId: "u1", connectionId: "cc_1", designId: "DAF1", purpose: "edit", exportSpec: JSON.stringify({ pages: [1] }), expiresAt: new Date(Date.now() + 86_400_000), ...extra });

  beforeAll(async () => {
    db = await createTestDb({ upTo: "0013_ig_page_ads_indexes" });
    // A brand as it exists before 0015: it must keep working, take the defaults and pass the VALIDATE.
    await brand("b_old");
    await db.migrate([NAME]);
    // psql -1 a second time: IF NOT EXISTS and the duplicate_object guards make it a no-op.
    await applyMigration(db.client, NAME);
    // Every later migration still applies on top (they touch none of 0015's tables).
    await db.migrate();
  });

  afterAll(async () => {
    await db?.close();
  });

  it("applied 0015 straight after 0013, and a second run in one transaction changed nothing", async () => {
    expect(db.applied.indexOf(NAME)).toBe(db.applied.indexOf("0013_ig_page_ads_indexes") + 1);
    // A third run (one transaction, like psql -1), now on top of every later migration, also succeeds.
    await expect(applyMigration(db.client, NAME)).resolves.toBeUndefined();
    const tables = await q(`SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = ANY($2) ORDER BY table_name`, [
      db.schema,
      ["CanvaConnection", "CanvaReturnState", "StudioItem", "StudioJob"],
    ]);
    expect(tables.rows.map((r) => r.table_name)).toEqual(["CanvaConnection", "CanvaReturnState", "StudioItem", "StudioJob"]);
  });

  it("gave the old brand the defaults, and every constraint of 0015 exists once and is validated", async () => {
    const row = await q(`SELECT "logoMediaKey","fontStyle","defaultLanguage","tagline","contactLine","isDefault" FROM "Brand" WHERE id = 'b_old'`);
    expect(row.rows[0]).toEqual({ logoMediaKey: null, fontStyle: "simple", defaultLanguage: "en", tagline: null, contactLine: null, isDefault: false });
    const found = await q(
      `SELECT conname, convalidated FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = $1 AND conname = ANY($2) ORDER BY conname`,
      [db.schema, CONSTRAINTS_0015],
    );
    expect(found.rows.map((r) => r.conname)).toEqual([...CONSTRAINTS_0015].sort());
    for (const r of found.rows) expect(r.convalidated, r.conname).toBe(true);
    const idx = await q(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = 'Brand_tenant_default_key'`, [db.schema]);
    expect(idx.rows).toHaveLength(1);
    expect(idx.rows[0].indexdef).toMatch(/UNIQUE INDEX .* WHERE "isDefault"/);
  });

  it("Brand refuses an unknown style or language, a logo key that is not a Library key, and over-long text", async () => {
    expect(await sqlState(brand("b_style", { fontStyle: "fancy" }))).toBe(CHECK_VIOLATION);
    expect(await sqlState(brand("b_lang", { defaultLanguage: "fr" }))).toBe(CHECK_VIOLATION);
    for (const [i, bad] of ["logo.png", `${"B".repeat(32)}.png`, KEY("gif"), KEY("mp4"), `../${KEY("png")}`].entries()) {
      expect(await sqlState(brand(`b_logo_${i}`, { logoMediaKey: bad })), bad).toBe(CHECK_VIOLATION);
    }
    expect(await sqlState(brand("b_tag", { tagline: "x".repeat(81) }))).toBe(CHECK_VIOLATION);
    expect(await sqlState(brand("b_contact", { contactLine: "x".repeat(61) }))).toBe(CHECK_VIOLATION);
    expect(
      await sqlState(brand("b_ok", { fontStyle: "festive", defaultLanguage: "both", logoMediaKey: KEY("png"), tagline: "x".repeat(80), contactLine: "Call or WhatsApp 98765 43210" })),
    ).toBeNull();
    expect(await sqlState(brand("b_hi", { fontStyle: "modern", defaultLanguage: "hi" }))).toBeNull();
  });

  it("allows one default brand per workspace, any number of others, and a default in each workspace", async () => {
    expect(await sqlState(brand("d1", { isDefault: true }))).toBeNull();
    expect(await sqlState(brand("d2", { isDefault: true }))).toBe(UNIQUE_VIOLATION);
    expect(await sqlState(brand("d3", { isDefault: false }))).toBeNull();
    expect(await sqlState(brand("d4"))).toBeNull();
    expect(await sqlState(brand("d5", { tenantId: "t2", isDefault: true }))).toBeNull();
    // Moving the default: clear the old one first, then set the new one.
    await q(`UPDATE "Brand" SET "isDefault" = false WHERE id = 'd1'`);
    expect(await sqlState(q(`UPDATE "Brand" SET "isDefault" = true WHERE id = 'd3'`))).toBeNull();
    expect(await sqlState(q(`UPDATE "Brand" SET "isDefault" = true WHERE id = 'd4'`))).toBe(UNIQUE_VIOLATION);
  });

  it("StudioItem refuses a bad kind, source, size, format, Library key or byte count, and a Canva item without its design", async () => {
    expect(await sqlState(studioItem({ kind: "gif" }))).toBe(CHECK_VIOLATION);
    expect(await sqlState(studioItem({ source: "upload" }))).toBe(CHECK_VIOLATION);
    expect(await sqlState(studioItem({ size: "banner" }))).toBe(CHECK_VIOLATION);
    expect(await sqlState(studioItem({ format: "svg" }))).toBe(CHECK_VIOLATION);
    for (const bad of ["photo.jpg", `${"b".repeat(31)}.jpg`, `${"b".repeat(32)}.svg`, `${"g".repeat(32)}.jpg`, `/srv/${KEY()}`]) {
      expect(await sqlState(studioItem({ mediaKey: bad })), bad).toBe(CHECK_VIOLATION);
    }
    expect(await sqlState(studioItem({ bytes: 0 }))).toBe(CHECK_VIOLATION);
    expect(await sqlState(studioItem({ bytes: 104857601 }))).toBe(CHECK_VIOLATION);
    expect(await sqlState(studioItem({ source: "canva" }))).toBe(CHECK_VIOLATION);
    expect(await sqlState(studioItem({ source: "canva", canvaDesignId: "DAF123", canvaPage: 2, size: "original", mediaKey: KEY("png", "c"), format: "png" }))).toBeNull();
    expect(await sqlState(studioItem({ kind: "video", format: "mp4", mediaKey: KEY("mp4", "d"), bytes: 104857600, source: "canva", canvaDesignId: "DAF9" }))).toBeNull();
    expect(await sqlState(studioItem({ source: "logo", size: null, mediaKey: KEY("png", "e"), format: "png" }))).toBeNull();
    // One row per Library file per workspace.
    expect(await sqlState(studioItem({ mediaKey: KEY("png", "c"), format: "png" }))).toBe(UNIQUE_VIOLATION);
    expect(await sqlState(studioItem({ tenantId: "t2", mediaKey: KEY("png", "c"), format: "png" }))).toBeNull();
  });

  it("StudioJob refuses an unknown kind or state and more than 60 attempts", async () => {
    expect(await sqlState(studioJob({ kind: "canva_resize" }))).toBe(CHECK_VIOLATION);
    expect(await sqlState(studioJob({ state: "running" }))).toBe(CHECK_VIOLATION);
    expect(await sqlState(studioJob({ attempts: 61 }))).toBe(CHECK_VIOLATION);
    expect(await sqlState(studioJob({ attempts: -1 }))).toBe(CHECK_VIOLATION);
    expect(await sqlState(studioJob({ kind: "canva_autofill", state: "filling", attempts: 60 }))).toBeNull();
    const fresh = await q(`SELECT "state","attempts","resultItemIds" FROM "StudioJob" WHERE id = $1`, [`sj_${job}`]);
    expect(fresh.rows[0]).toEqual({ state: "filling", attempts: 60, resultItemIds: [] });
    expect(await sqlState(studioJob({ kind: "canva_return" }))).toBeNull();
    expect((await q(`SELECT "state" FROM "StudioJob" WHERE id = $1`, [`sj_${job}`])).rows[0].state).toBe("queued");
  });

  it("CanvaConnection refuses an unknown status and a second connection for the same member and workspace", async () => {
    expect(await sqlState(canvaConnection({ status: "paused" }))).toBe(CHECK_VIOLATION);
    expect(await sqlState(canvaConnection({ userId: "member", status: "expired", scopes: ["design:meta:read"] }))).toBeNull();
    expect(await sqlState(canvaConnection({ userId: "member" }))).toBe(UNIQUE_VIOLATION);
    expect(await sqlState(canvaConnection({ userId: "member", tenantId: "t2" }))).toBeNull();
    const row = await q(`SELECT "status","scopes","accessTokenEnc" FROM "CanvaConnection" WHERE "userId" = 'member' AND "tenantId" = 't2'`);
    expect(row.rows[0]).toEqual({ status: "active", scopes: [], accessTokenEnc: null });
  });

  it("CanvaReturnState refuses a malformed correlation id, an unknown purpose and a return path outside /app/", async () => {
    for (const bad of ["short", `${CORRELATION}x`, "Abcdefghij_klmnop+1234", "Abcdefghij klmnop-1234"]) {
      expect(await sqlState(returnState(bad)), bad).toBe(CHECK_VIOLATION);
    }
    expect(await sqlState(returnState("Abcdefghij_klmnop-0001", { purpose: "share" }))).toBe(CHECK_VIOLATION);
    for (const bad of ["/admin", "https://evil.example/app/x", "/app/x y", "/app/<script>", `/app/${"a".repeat(201)}`, "//app/x"]) {
      expect(await sqlState(returnState("Abcdefghij_klmnop-0002", { returnPath: bad })), bad).toBe(CHECK_VIOLATION);
    }
    expect(await sqlState(returnState(CORRELATION, { returnPath: "/app/content?compose=1&media=abc.jpg" }))).toBeNull();
    expect(await sqlState(returnState("Abcdefghij_klmnop-0003", { purpose: "new_design", returnPath: `/app/${"a".repeat(200)}` }))).toBeNull();
    expect(await sqlState(returnState("Abcdefghij_klmnop-0004", { purpose: "autofill" }))).toBeNull();
  });

  it("deleting a brand keeps its Studio items and sets their brandId to null", async () => {
    await brand("b_del");
    await studioItem({ id: "si_branded", brandId: "b_del", mediaKey: KEY("jpg", "f") });
    expect((await q(`SELECT "brandId" FROM "StudioItem" WHERE id = 'si_branded'`)).rows[0].brandId).toBe("b_del");
    await q(`DELETE FROM "Brand" WHERE id = 'b_del'`);
    expect((await q(`SELECT "brandId" FROM "StudioItem" WHERE id = 'si_branded'`)).rows[0]).toEqual({ brandId: null });
    // The link refuses a brand that does not exist.
    expect(await sqlState(studioItem({ brandId: "b_missing", mediaKey: KEY("jpg", "0") }))).toBe("23503");
  });
});
