import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, HAS_TEST_DB, sqlState, type TestDb } from "../helpers/pg";

/**
 * Database proof of 0012_ig_page_ads and 0013_ig_page_ads_indexes (docs/IG-PAGE-ADS-SPEC.md 5.1, 5.2; PRM-00 acceptance 2):
 * rows written before 0012 survive it and pass 0013's VALIDATE, and each CHECK rejects its bad row with SQLSTATE 23514.
 * Runs only with DATABASE_URL_TEST set; each run works in its own schema and drops it afterwards.
 */
const CHECK_VIOLATION = "23514";

describe.skipIf(!HAS_TEST_DB)("0012 and 0013 on Postgres", () => {
  let db: TestDb;
  const q = (text: string, values?: unknown[]) => db.query(text, values);

  const campaign = (id: string, extra: Record<string, unknown> = {}) => {
    const cols = { id, tenantId: "t1", adAccountAssetId: "as1", name: `Campaign ${id}`, template: "traffic", objective: "OUTCOME_TRAFFIC", dailyBudgetMinor: 30000, ...extra };
    const keys = Object.keys(cols);
    return q(
      `INSERT INTO "AdCampaign" (${keys.map((k) => `"${k}"`).join(",")},"updatedAt") VALUES (${keys.map((_, i) => `$${i + 1}`).join(",")},now())`,
      Object.values(cols),
    );
  };
  const adSet = (id: string, extra: Record<string, unknown> = {}) => {
    const cols = { id, tenantId: "t1", campaignId: "c_ok", name: `Ad set ${id}`, targeting: "{}", ...extra };
    const keys = Object.keys(cols);
    return q(`INSERT INTO "AdSet" (${keys.map((k) => `"${k}"`).join(",")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(",")})`, Object.values(cols));
  };
  const lead = (id: string, extra: Record<string, unknown> = {}) => {
    const cols = { id, tenantId: "t1", leadgenId: `lg_${id}`, fields: "{}", ...extra };
    const keys = Object.keys(cols);
    return q(`INSERT INTO "Lead" (${keys.map((k) => `"${k}"`).join(",")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(",")})`, Object.values(cols));
  };

  beforeAll(async () => {
    db = await createTestDb({ upTo: "0011_template_flagged" });
    // Rows as they exist before 0012: they must keep working and pass 0013's VALIDATE.
    await q(`INSERT INTO "AdCampaign" ("id","tenantId","adAccountAssetId","name","template","objective","dailyBudgetMinor","updatedAt") VALUES ('c_old','t1','as1','Old','boost_post','OUTCOME_ENGAGEMENT',10000,now())`);
    await q(`INSERT INTO "AdSet" ("id","tenantId","campaignId","name","targeting") VALUES ('s_old','t1','c_old','Old set','{}')`);
    await q(`INSERT INTO "Ad" ("id","tenantId","adSetId","name","creative") VALUES ('a_old','t1','s_old','Old ad','{}')`);
    await q(`INSERT INTO "LeadForm" ("id","tenantId","pageAssetId","metaFormId") VALUES ('f_old','t1','pg1','mf1')`);
    await q(`INSERT INTO "Lead" ("id","tenantId","leadgenId","fields") VALUES ('l_old','t1','lg_old','{}')`);
    await db.migrate();
    await campaign("c_ok");
  });

  afterAll(async () => {
    await db?.close();
  });

  it("applied 0012, then 0013 straight after it", () => {
    const i12 = db.applied.indexOf("0012_ig_page_ads");
    expect(i12).toBeGreaterThan(db.applied.indexOf("0011_template_flagged"));
    expect(db.applied.indexOf("0013_ig_page_ads_indexes")).toBe(i12 + 1);
  });

  it("gave the old rows the defaults, and 0013 validated every CHECK", async () => {
    const c = await q(`SELECT "surface","placementMode","runDays","startMode" FROM "AdCampaign" WHERE id = 'c_old'`);
    expect(c.rows[0]).toEqual({ surface: "wizard", placementMode: "auto", runDays: null, startMode: null });
    expect((await q(`SELECT "format","mediaIds" FROM "Ad" WHERE id = 'a_old'`)).rows[0]).toEqual({ format: "single_image", mediaIds: [] });
    expect((await q(`SELECT "source","isTest" FROM "Lead" WHERE id = 'l_old'`)).rows[0]).toEqual({ source: "instant_form", isTest: false });
    expect((await q(`SELECT "origin" FROM "LeadForm" WHERE id = 'f_old'`)).rows[0]).toEqual({ origin: "registered" });
    const open = await q(`SELECT conname FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = $1 AND NOT c.convalidated`, [db.schema]);
    expect(open.rows).toEqual([]);
    const idx = await q(`SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND indexname = ANY($2)`, [
      db.schema,
      ["Lead_tenant_source_created_idx", "Lead_tenant_ad_idx", "Lead_tenant_conversation_idx", "AdCampaign_tenant_surface_idx", "Ad_review_open_idx"],
    ]);
    expect(idx.rows).toHaveLength(5);
  });

  it("refuses a promote campaign with no end date and no lifetime budget, and accepts one with either", async () => {
    expect(await sqlState(campaign("c_bad", { surface: "promote" }))).toBe(CHECK_VIOLATION);
    expect(await sqlState(campaign("c_bad_eddy", { surface: "eddy" }))).toBe(CHECK_VIOLATION);
    expect(await sqlState(campaign("c_end", { surface: "promote", endsAt: new Date("2026-11-07T18:29:00Z") }))).toBeNull();
    expect(await sqlState(campaign("c_life", { surface: "eddy", lifetimeBudgetMinor: 500000 }))).toBeNull();
    expect(await sqlState(campaign("c_wizard", { surface: "wizard" }))).toBeNull();
  });

  it("refuses runDays 1 (and 91), and accepts 2 to 90", async () => {
    const end = { surface: "promote", endsAt: new Date("2026-11-07T18:29:00Z") };
    expect(await sqlState(campaign("c_days1", { ...end, runDays: 1 }))).toBe(CHECK_VIOLATION);
    expect(await sqlState(campaign("c_days91", { ...end, runDays: 91 }))).toBe(CHECK_VIOLATION);
    expect(await sqlState(campaign("c_days2", { ...end, runDays: 2, startMode: "now" }))).toBeNull();
    expect(await sqlState(campaign("c_days90", { ...end, runDays: 90, startMode: "at" }))).toBeNull();
    expect(await sqlState(campaign("c_mode", { ...end, startMode: "later" }))).toBe(CHECK_VIOLATION);
    expect(await sqlState(campaign("c_surface", { surface: "app" }))).toBe(CHECK_VIOLATION);
  });

  it("refuses an ad set schedule without a lifetime budget, and a capped bid without an amount", async () => {
    const schedule = JSON.stringify([{ days: [1, 2, 3], startMinute: 540, endMinute: 1260 }]);
    expect(await sqlState(adSet("s_sched", { schedule }))).toBe(CHECK_VIOLATION);
    expect(await sqlState(adSet("s_sched_ok", { schedule, lifetimeBudgetMinor: 900000 }))).toBeNull();
    expect(await sqlState(adSet("s_bid", { bidStrategy: "COST_CAP" }))).toBe(CHECK_VIOLATION);
    expect(await sqlState(adSet("s_bid_ok", { bidStrategy: "COST_CAP", bidAmountMinor: 5000 }))).toBeNull();
    expect(await sqlState(adSet("s_variant", { variantKey: "D" }))).toBe(CHECK_VIOLATION);
  });

  it("refuses Lead.source 'x' and an unknown platform, and accepts a chat lead", async () => {
    expect(await sqlState(lead("l_x", { source: "x" }))).toBe(CHECK_VIOLATION);
    expect(await sqlState(lead("l_plat", { platform: "tiktok" }))).toBe(CHECK_VIOLATION);
    expect(await sqlState(lead("l_ctwa", { source: "ctwa", platform: "whatsapp", leadgenId: "ctwa:wamid.1", conversationId: "v1" }))).toBeNull();
  });

  it("enforces the new tables' CHECKs, the customer-list lawful basis and the cascade from audience to upload", async () => {
    // A customer list needs one of the two lawful bases. (As written in spec 5.1 the CHECK lets a NULL consentBasis through,
    // because a CHECK passes on NULL; PRM-11 must validate the basis in code before it writes the row.)
    expect(await sqlState(q(`INSERT INTO "AdAudience" ("id","tenantId","adAccountAssetId","kind","name","consentBasis") VALUES ('au_bad','t1','as1','customer_list','Buyers','implied')`))).toBe(CHECK_VIOLATION);
    expect(await sqlState(q(`INSERT INTO "AdAudience" ("id","tenantId","kind","name") VALUES ('au_noacct','t1','lookalike','Like buyers')`))).toBe(CHECK_VIOLATION);
    await q(`INSERT INTO "AdAudience" ("id","tenantId","adAccountAssetId","kind","name","consentBasis") VALUES ('au_ok','t1','as1','customer_list','Buyers','marketing_opt_in')`);
    await q(`INSERT INTO "AdAudienceUpload" ("id","tenantId","audienceId","sessionId","mode") VALUES ('up1','t1','au_ok',1,'add')`);
    expect(await sqlState(q(`INSERT INTO "AdAudienceUpload" ("id","tenantId","audienceId","sessionId","mode") VALUES ('up2','t1','au_ok',2,'merge')`))).toBe(CHECK_VIOLATION);
    await q(`DELETE FROM "AdAudience" WHERE id = 'au_ok'`);
    expect((await q(`SELECT count(*)::int AS n FROM "AdAudienceUpload"`)).rows[0].n).toBe(0);
    const sha = "a".repeat(64);
    expect(await sqlState(q(`INSERT INTO "AdMedia" ("id","tenantId","adAccountAssetId","source","sourceKey","kind","mime","bytes","sha256","attempts") VALUES ('m1','t1','as1','content','k.jpg','image','image/jpeg',10,$1,6)`, [sha]))).toBe(CHECK_VIOLATION);
    expect(await sqlState(q(`INSERT INTO "InsightBreakdown" ("id","tenantId","entityType","entityMetaId","date","dimension","dimKey") VALUES ('ib1','t1','ad','1','2026-10-30','run_total','all')`))).toBeNull();
    expect(await sqlState(q(`INSERT INTO "InsightBreakdown" ("id","tenantId","entityType","entityMetaId","date","dimension","dimKey") VALUES ('ib2','t1','ad','1','2026-10-30','device','x')`))).toBe(CHECK_VIOLATION);
  });

  it("allows one version comparison per campaign, removed with its campaign", async () => {
    await q(`INSERT INTO "AdTest" ("id","tenantId","campaignId") VALUES ('t_1','t1','c_ok')`);
    expect(await sqlState(q(`INSERT INTO "AdTest" ("id","tenantId","campaignId") VALUES ('t_2','t1','c_ok')`))).toBe("23505");
    await q(`DELETE FROM "AdCampaign" WHERE id = 'c_ok'`);
    expect((await q(`SELECT count(*)::int AS n FROM "AdTest"`)).rows[0].n).toBe(0);
  });
});
