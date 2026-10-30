import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, HAS_TEST_DB, inTransaction, sqlState, type TestDb } from "../helpers/pg";

/**
 * Database proof of migrations 0009 and 0010 (docs/SPEND-CONTROLS-SPEC.md 10.2, docs/EDDY-SPEC.md EDDY-02 acceptance 3):
 * the append-only triggers (42501), the one exception for the purge GUC, the ActionInvocation anonymisation exception, the
 * partial unique indexes, the backfill rows and the non-blocking Message objects. Runs only with DATABASE_URL_TEST set; each
 * run works in its own schema and drops it afterwards.
 */
describe.skipIf(!HAS_TEST_DB)("0009 and 0010 on Postgres", () => {
  let db: TestDb;
  const q = (text: string, values?: unknown[]) => db.query(text, values);
  const ledgerRow = (id: string, tenantId = "tny", extra: Record<string, unknown> = {}) =>
    q(
      `INSERT INTO "SpendLedger" ("id","tenantId","pot","action","phase","actorType","reason","correlationId","idempotencyKey")
       VALUES ($1,$2,'ads','ads.adset.budget_raise',$3,'user','Raised a budget',$4,$5)`,
      [id, tenantId, extra.phase ?? "requested", extra.correlationId ?? `c_${id}`, extra.idempotencyKey ?? null],
    );
  const consentRow = (id: string, tenantId = "tny") =>
    q(`INSERT INTO "SpendConsent" ("id","tenantId","userId","kind","granted","textVersion","textSha256") VALUES ($1,$2,'u1','meta_spend_cap',true,'meta-cap-v1','abc')`, [id, tenantId]);

  beforeAll(async () => {
    db = await createTestDb({ upTo: "0008_agent_reply_backfill" });
    // Workspaces as they exist before 0009, to prove the backfill.
    for (const [id, name] of [["tny", "New York"], ["trc", "Routing"], ["tno", "Nothing"], ["ttw", "Two accounts"], ["tol", "Old cap"]]) {
      await q(`INSERT INTO "Tenant" ("id","name","slug") VALUES ($1,$2,$3)`, [id, name, `slug-${id}`]);
    }
    await q(`INSERT INTO "MetaConnection" ("id","tenantId","metaUserId","tokenEnc","connectedByUserId","updatedAt") VALUES ('mc_ny','tny','fb1','x','u1',now()),('mc_tw','ttw','fb2','x','u1',now())`);
    await q(
      `INSERT INTO "MetaAsset" ("id","tenantId","connectionId","type","externalId","status","meta","createdAt","updatedAt") VALUES
       ('as_ny','tny','mc_ny','ad_account','act_1','active','{"timezone":"America/New_York"}', '2026-01-01', now()),
       ('pg_ny','tny','mc_ny','page','page_1','active','{}', '2026-01-01', now()),
       ('as_tw1','ttw','mc_tw','ad_account','act_21','active','{"timezone":"Europe/London"}', '2026-01-01', now()),
       ('as_tw2','ttw','mc_tw','ad_account','act_22','active','{"timezone":"Asia/Dubai"}', '2026-02-01', now()),
       ('as_tw3','ttw','mc_tw','ad_account','act_23','disconnected','{"timezone":"Asia/Tokyo"}', '2025-01-01', now())`,
    );
    await q(`INSERT INTO "RoutingConfig" ("id","tenantId","timezone","updatedAt") VALUES ('rc1','trc','Asia/Dubai',now()),('rc2','tny','Europe/Paris',now())`);
    await q(
      `INSERT INTO "PlatformSetting" ("key","value","updatedAt") VALUES
       ('ads:caps:tny','{"currency":"INR","maxDailyBudgetMinor":100000}',now()),
       ('ads:caps:tol','{"currency":"HUF","maxDailyBudgetMinor":57100,"exponent":2}',now()),
       ('ads:caps:trc','{"currency":"usd","maxDailyBudgetMinor":100000}',now()),
       ('ads:caps:tno','{"currency":"INR","maxDailyBudgetMinor":"abc"}',now()),
       ('ads:caps:ttw','{"currency":"INR","maxDailyBudgetMinor":0}',now())`,
    );
    await db.migrate();
  });

  afterAll(async () => {
    await db?.close();
  });

  it("applied 0009 and 0010", () => {
    // Later migrations (0011_template_flagged, ...) may follow; what matters is that both ran, 0009 before 0010.
    const i9 = db.applied.indexOf("0009_spend_controls");
    const i10 = db.applied.indexOf("0010_spend_message_indexes");
    expect(i9).toBeGreaterThanOrEqual(0);
    expect(i10).toBe(i9 + 1);
  });

  describe("backfill", () => {
    it("maps the old cap C to a daily limit of ceil(1.75 C) and keeps C", async () => {
      const { rows } = await q(`SELECT "id","tenantId","pot","currency","dailyLimitMinor","monthlyLimitMinor","migratedFromCapMinor" FROM "SpendAllowance" ORDER BY "tenantId"`);
      expect(rows).toEqual([
        { id: expect.stringMatching(/^sa_[0-9a-f]{32}$/), tenantId: "tny", pot: "ads", currency: "INR", dailyLimitMinor: "175000", monthlyLimitMinor: null, migratedFromCapMinor: "100000" },
        // (repair) tol's cap was saved when HUF had 2 decimals (exponent 2); HUF has 0 now, so C = floor(57100 / 100) = 571,
        // the cap getCaps enforces today, and the limit is ceil(1.75 x 571) = 1000, not 100 times looser.
        { id: expect.stringMatching(/^sa_[0-9a-f]{32}$/), tenantId: "tol", pot: "ads", currency: "HUF", dailyLimitMinor: "1000", monthlyLimitMinor: null, migratedFromCapMinor: "571" },
      ]);
    });

    it("creates a SpendControl row per workspace: probation auto, time zone from the ad account, then routing, then Asia/Kolkata", async () => {
      const { rows } = await q(`SELECT "tenantId","probation","timezone","spendingAdAccountAssetId","freeze" FROM "SpendControl" ORDER BY "tenantId"`);
      expect(rows).toEqual([
        { tenantId: "tno", probation: "auto", timezone: "Asia/Kolkata", spendingAdAccountAssetId: null, freeze: "none" },
        { tenantId: "tny", probation: "auto", timezone: "America/New_York", spendingAdAccountAssetId: "as_ny", freeze: "none" },
        { tenantId: "tol", probation: "auto", timezone: "Asia/Kolkata", spendingAdAccountAssetId: null, freeze: "none" },
        { tenantId: "trc", probation: "auto", timezone: "Asia/Dubai", spendingAdAccountAssetId: null, freeze: "none" },
        { tenantId: "ttw", probation: "auto", timezone: "Europe/London", spendingAdAccountAssetId: null, freeze: "none" },
      ]);
    });

    it("seeds the three new-workspace ceilings (ads and WhatsApp in INR, AI in credits)", async () => {
      const { rows } = await q(`SELECT "id","scope","scopeId","pot","currency","dailyMinor","monthlyMinor" FROM "SpendCeiling" ORDER BY "id"`);
      expect(rows).toEqual([
        { id: "sc_probation_ads_inr", scope: "probation", scopeId: "*", pot: "ads", currency: "INR", dailyMinor: "200000", monthlyMinor: "2000000" },
        { id: "sc_probation_ai_crd", scope: "probation", scopeId: "*", pot: "ai", currency: "CRD", dailyMinor: null, monthlyMinor: "500" },
        { id: "sc_probation_messaging_inr", scope: "probation", scopeId: "*", pot: "messaging", currency: "INR", dailyMinor: "50000", monthlyMinor: "500000" },
      ]);
    });

    it("left existing rows alone and gave old rows the new defaults", async () => {
      expect((await q(`SELECT count(*)::int AS n FROM "PlatformSetting" WHERE "key" LIKE 'ads:caps:%'`)).rows[0].n).toBe(5);
      const cols = await q(
        `SELECT table_name, column_name, column_default, is_nullable FROM information_schema.columns
         WHERE table_schema = current_schema() AND ((table_name = 'AdCampaign' AND column_name IN ('origin','sandbox')) OR (table_name = 'MetaAsset' AND column_name = 'sandbox'))
         ORDER BY table_name, column_name`,
      );
      expect(cols.rows.map((r) => [r.table_name, r.column_name, String(r.column_default), r.is_nullable])).toEqual([
        ["AdCampaign", "origin", "'human'::text", "NO"],
        ["AdCampaign", "sandbox", "false", "NO"],
        ["MetaAsset", "sandbox", "false", "NO"],
      ]);
      expect((await q(`SELECT "sandbox" FROM "MetaAsset" WHERE "id" = 'as_ny'`)).rows[0].sandbox).toBe(false);
    });
  });

  describe("append-only SpendLedger and SpendConsent", () => {
    it("refuse UPDATE, DELETE and TRUNCATE with 42501", async () => {
      await ledgerRow("l1");
      await consentRow("k1");
      for (const table of ["SpendLedger", "SpendConsent"]) {
        expect(await sqlState(q(`UPDATE "${table}" SET "tenantId" = 'x'`)), table).toBe("42501");
        expect(await sqlState(q(`DELETE FROM "${table}"`)), table).toBe("42501");
        expect(await sqlState(q(`TRUNCATE "${table}"`)), table).toBe("42501");
      }
      expect((await q(`SELECT count(*)::int AS n FROM "SpendLedger" WHERE "id" = 'l1'`)).rows[0].n).toBe(1);
    });

    it("allow DELETE only inside a transaction that set edwyz.purge to that table and that workspace", async () => {
      await ledgerRow("l2", "tpurge");
      await ledgerRow("l3", "tpurge");
      await consentRow("k2", "tpurge");
      await ledgerRow("lk", "tkeep");
      // Wrong table named: still refused.
      await expect(
        inTransaction(db.client, async () => {
          await q(`SELECT set_config('edwyz.purge', 'SpendConsent:tpurge', true)`);
          await q(`DELETE FROM "SpendLedger" WHERE "tenantId" = 'tpurge'`);
        }),
      ).rejects.toMatchObject({ code: "42501" });
      // (repair) The table alone no longer opens anything: the value names one workspace.
      expect(await sqlState(inTransaction(db.client, async () => {
        await q(`SELECT set_config('edwyz.purge', 'SpendLedger', true)`);
        await q(`DELETE FROM "SpendLedger" WHERE "tenantId" = 'tpurge'`);
      }))).toBe("42501");
      // (repair) An erasure query that lost its tenant filter fails on the other workspace's row and deletes nothing.
      expect(await sqlState(inTransaction(db.client, async () => {
        await q(`SELECT set_config('edwyz.purge', 'SpendLedger:tpurge', true)`);
        await q(`DELETE FROM "SpendLedger"`);
      }))).toBe("42501");
      expect((await q(`SELECT count(*)::int AS n FROM "SpendLedger" WHERE "tenantId" IN ('tpurge','tkeep')`)).rows[0].n).toBe(3);
      // The erasure shape: one transaction, the GUC set before each table.
      const deleted = await inTransaction(db.client, async () => {
        await q(`SELECT set_config('edwyz.purge', 'SpendLedger:tpurge', true)`);
        const ledger = await q(`DELETE FROM "SpendLedger" WHERE "tenantId" = 'tpurge'`);
        await q(`SELECT set_config('edwyz.purge', 'SpendConsent:tpurge', true)`);
        const consent = await q(`DELETE FROM "SpendConsent" WHERE "tenantId" = 'tpurge'`);
        return [ledger.rowCount, consent.rowCount];
      });
      expect(deleted).toEqual([2, 1]);
      expect((await q(`SELECT count(*)::int AS n FROM "SpendLedger" WHERE "tenantId" = 'tkeep'`)).rows[0].n).toBe(1);
      // The setting is transaction-local: the next transaction is refused again.
      await ledgerRow("l4", "tpurge");
      expect(await sqlState(inTransaction(db.client, () => q(`DELETE FROM "SpendLedger" WHERE "tenantId" = 'tpurge'`)))).toBe("42501");
      // Outside a transaction block set_config(..., true) lasts one statement, so it opens nothing either.
      await q(`SELECT set_config('edwyz.purge', 'SpendLedger:tpurge', true)`);
      expect(await sqlState(q(`DELETE FROM "SpendLedger" WHERE "tenantId" = 'tpurge'`))).toBe("42501");
      // And it never allows an UPDATE.
      expect(
        await sqlState(
          inTransaction(db.client, async () => {
            await q(`SELECT set_config('edwyz.purge', 'SpendLedger:tpurge', true)`);
            await q(`UPDATE "SpendLedger" SET "reason" = 'changed' WHERE "tenantId" = 'tpurge'`);
          }),
        ),
      ).toBe("42501");
    });

    it("keep exactly one outcome and one reconciled row per request (repair)", async () => {
      await ledgerRow("o0", "tout", { correlationId: "c_out" });
      expect(await sqlState(ledgerRow("o1", "tout", { phase: "applied", correlationId: "c_out" }))).toBeNull();
      expect(await sqlState(ledgerRow("o2", "tout", { phase: "failed", correlationId: "c_out" }))).toBe("23505");
      expect(await sqlState(ledgerRow("o3", "tout", { phase: "refused", correlationId: "c_out" }))).toBe("23505");
      expect(await sqlState(ledgerRow("o4", "tout", { phase: "reconciled", correlationId: "c_out" }))).toBeNull();
      expect(await sqlState(ledgerRow("o5", "tout", { phase: "reconciled", correlationId: "c_out" }))).toBe("23505");
      // Another workspace, or rows that do not close a request, are not affected.
      expect(await sqlState(ledgerRow("o6", "tout2", { phase: "applied", correlationId: "c_out" }))).toBeNull();
      expect(await sqlState(ledgerRow("o7", "tout", { phase: "info", correlationId: "c_out" }))).toBeNull();
      expect(await sqlState(ledgerRow("o8", "tout", { phase: "info", correlationId: "c_out" }))).toBeNull();
    });

    it("enforce the (tenant, idempotencyKey, phase) key only where a key is set", async () => {
      await ledgerRow("i1", "tidem", { idempotencyKey: "activate:c1:1" });
      expect(await sqlState(ledgerRow("i2", "tidem", { idempotencyKey: "activate:c1:1" }))).toBe("23505");
      expect(await sqlState(ledgerRow("i3", "tidem", { idempotencyKey: "activate:c1:1", phase: "applied" }))).toBeNull();
      expect(await sqlState(ledgerRow("i4", "tother", { idempotencyKey: "activate:c1:1" }))).toBeNull();
      expect(await sqlState(ledgerRow("i5", "tidem"))).toBeNull();
      expect(await sqlState(ledgerRow("i6", "tidem"))).toBeNull();
      expect(await sqlState(ledgerRow("i7", "tidem", { phase: "approved" }))).toBe("23514");
      const seq = await q(`SELECT "seq" FROM "SpendLedger" WHERE "id" IN ('i5','i6') ORDER BY "seq"`);
      expect(BigInt(seq.rows[1].seq)).toBeGreaterThan(BigInt(seq.rows[0].seq));
    });

    it("accepts the external actor (critic)", async () => {
      expect(
        await sqlState(
          q(`INSERT INTO "SpendLedger" ("id","tenantId","pot","action","phase","actorType","actorId","reason","correlationId") VALUES ('x1','tny','ads','ads.external_change','reconciled','external','meta_ads_manager','Changed in Meta Ads Manager','cx')`),
        ),
      ).toBeNull();
      expect(await sqlState(q(`INSERT INTO "SpendLedger" ("id","tenantId","pot","action","phase","actorType","reason","correlationId") VALUES ('x2','tny','ads','a','info','robot','r','cy')`))).toBe("23514");
    });
  });

  describe("Eddy guards", () => {
    beforeAll(async () => {
      await q(
        `INSERT INTO "EddyConversation" ("id","tenantId","userId","roleAtStart","roleClass","model","toolsetVersion","promptVersion","visibilityHash")
         VALUES ('cv1','tny','u1','owner','admin','claude-sonnet-5-5','t1','p1','h1')`,
      );
    });

    it("refuses an UPDATE on EddyMessage and still allows DELETE", async () => {
      await q(`INSERT INTO "EddyMessage" ("id","conversationId","tenantId","seq","role","kind","content") VALUES ('m1','cv1','tny',0,'user','user_text','[]')`);
      expect(await sqlState(q(`UPDATE "EddyMessage" SET "kind" = 'assistant' WHERE "id" = 'm1'`))).toBe("42501");
      expect(await sqlState(q(`DELETE FROM "EddyMessage" WHERE "id" = 'm1'`))).toBeNull();
    });

    it("stores EddyMessage.content as written, key order included (repair: JSON, not JSONB)", async () => {
      const text = '[{"type":"tool_use","id":"tu_1","name":"list_templates","input":{"status":"approved","conversationId":"cv1"}}]';
      await q(`INSERT INTO "EddyMessage" ("id","conversationId","tenantId","seq","role","kind","content") VALUES ('m2','cv1','tny',1,'assistant','assistant',$1)`, [text]);
      const { rows } = await q(`SELECT "content"::text AS "text", pg_typeof("content")::text AS "type" FROM "EddyMessage" WHERE "id" = 'm2'`);
      expect(rows).toEqual([{ text, type: "json" }]);
    });

    it("lets ActionInvocation change only userId to NULL", async () => {
      const insert = (id: string) =>
        q(`INSERT INTO "ActionInvocation" ("id","tenantId","userId","via","principalId","opId","action","risk","stage","outcome","argsHash") VALUES ($1,'tny','u1','eddy','eddy:u1:cv1','op1','get_spending','instant','read','ok','h')`, [id]);
      await insert("ai1");
      await insert("ai2");
      expect(await sqlState(q(`UPDATE "ActionInvocation" SET "userId" = NULL WHERE "id" = 'ai1'`))).toBeNull();
      expect((await q(`SELECT "userId" FROM "ActionInvocation" WHERE "id" = 'ai1'`)).rows[0].userId).toBeNull();
      expect(await sqlState(q(`UPDATE "ActionInvocation" SET "code" = 'x' WHERE "id" = 'ai2'`))).toBe("42501");
      expect(await sqlState(q(`UPDATE "ActionInvocation" SET "userId" = NULL, "code" = 'x' WHERE "id" = 'ai2'`))).toBe("42501");
      expect(await sqlState(q(`UPDATE "ActionInvocation" SET "userId" = 'u2' WHERE "id" = 'ai2'`))).toBe("42501");
      expect(await sqlState(q(`TRUNCATE "ActionInvocation"`))).toBe("42501");
    });

    it("keeps one active conversation per member and one running turn per conversation", async () => {
      const conv = (id: string, status = "active") =>
        q(`INSERT INTO "EddyConversation" ("id","tenantId","userId","roleAtStart","roleClass","model","toolsetVersion","promptVersion","visibilityHash","status") VALUES ($1,'tny','u9','agent','agent','m','t','p','h',$2)`, [id, status]);
      await conv("c_a");
      expect(await sqlState(conv("c_b"))).toBe("23505");
      expect(await sqlState(conv("c_c", "closed"))).toBeNull();
      const turn = (id: string, status = "running") => q(`INSERT INTO "EddyTurn" ("id","conversationId","tenantId","model","language","status") VALUES ($1,'c_a','tny','m','en',$2)`, [id, status]);
      await turn("tu1");
      expect(await sqlState(turn("tu2"))).toBe("23505");
      expect(await sqlState(turn("tu3", "done"))).toBeNull();
      expect(await sqlState(q(`INSERT INTO "EddyUserPref" ("tenantId","userId","language") VALUES ('tny','u9','fr')`))).toBe("23514");
      expect(await sqlState(q(`INSERT INTO "Notice" ("id","tenantId","kind","severity","dedupeKey","expiresAt") VALUES ('n1','tny','k','urgent','d',now())`))).toBe("23514");
    });
  });

  describe("partial unique indexes", () => {
    it("allows one workspace to manage Meta's limit on a real ad account", async () => {
      const limit = (assetId: string, tenantId: string, mode: string) =>
        q(`INSERT INTO "MetaSpendLimit" ("adAccountAssetId","tenantId","accountExternalId","mode") VALUES ($1,$2,'act_shared',$3)`, [assetId, tenantId, mode]);
      await limit("a1", "tny", "managed");
      // (repair) Decision 11: only 'managed' holds the slot; a pending_owner row of another workspace never blocks it.
      expect(await sqlState(limit("a2", "trc", "pending_owner"))).toBeNull();
      expect(await sqlState(limit("a3", "trc", "managed"))).toBe("23505");
      expect(await sqlState(limit("a4", "trc", "other_workspace"))).toBeNull();
      expect(await sqlState(limit("a5", "tno", "off"))).toBeNull();
      expect(await sqlState(limit("a6", "tol", "bogus"))).toBe("23514");
    });

    it("keeps one open commitment, held reservation and tripped breaker per subject", async () => {
      const commitment = (id: string, status: string) =>
        q(
          `INSERT INTO "SpendCommitment" ("id","tenantId","adAccountAssetId","campaignId","metaObjectId","objectLevel","origin","currency","timezone","dailyBudgetMinor","status")
           VALUES ($1,'tny','as_ny','c1','obj1','adset','human','INR','Asia/Kolkata',1000,$2)`,
          [id, status],
        );
      await commitment("cm1", "live");
      expect(await sqlState(commitment("cm2", "reserved"))).toBe("23505");
      expect(await sqlState(commitment("cm3", "stopped"))).toBeNull();
      expect(
        await sqlState(
          q(`INSERT INTO "SpendCommitment" ("id","tenantId","adAccountAssetId","campaignId","metaObjectId","objectLevel","origin","currency","timezone","dailyBudgetMinor","status") VALUES ('cm4','tny','as_ny','c2','obj2','campaign','assistant','INR','Asia/Kolkata',1000,'live')`),
        ),
      ).toBe("23514"); // an assistant campaign needs an end date or a lifetime budget

      const reservation = (id: string, status: string) =>
        q(
          `INSERT INTO "SpendReservation" ("id","tenantId","pot","currency","subjectType","subjectId","amountMinor","status","dayKey","monthKey","expiresAt","correlationId")
           VALUES ($1,'tny','messaging','INR','broadcast','b1',5000,$2,'2026-10-28','2026-10',now(),'c')`,
          [id, status],
        );
      await reservation("r1", "held");
      expect(await sqlState(reservation("r2", "held"))).toBe("23505");
      expect(await sqlState(reservation("r3", "released"))).toBeNull();

      const breaker = (id: string, state: string) =>
        q(`INSERT INTO "SpendBreaker" ("id","tenantId","kind","scopeType","scopeId","state","effect","reason") VALUES ($1,'tny','pacing','workspace','tny',$2,'pause_scope','r')`, [id, state]);
      await breaker("b1", "tripped");
      expect(await sqlState(breaker("b2", "tripped"))).toBe("23505");
      expect(await sqlState(breaker("b3", "cleared"))).toBeNull();
    });

    it("keys SpendDaily by origin, so the account 'all' and 'external' rows share a day", async () => {
      const daily = (origin: string) =>
        q(`INSERT INTO "SpendDaily" ("tenantId","pot","scopeType","scopeId","day","currency","amountMinor","origin","source","syncedAt") VALUES ('tny','ads','account','act_1','2026-10-28','INR',100,$1,'fast_sync',now())`, [origin]);
      expect(await sqlState(daily("all"))).toBeNull();
      expect(await sqlState(daily("external"))).toBeNull();
      expect(await sqlState(daily("all"))).toBe("23505");
    });
  });

  describe("Message objects", () => {
    it("validated the spendState CHECK in 0010 and built both indexes valid", async () => {
      const check = await q(`SELECT convalidated FROM pg_constraint WHERE conname = 'Message_spendState_check' AND connamespace = current_schema()::regnamespace`);
      expect(check.rows).toEqual([{ convalidated: true }]);
      const idx = await q(
        `SELECT c.relname, i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
         WHERE c.relnamespace = current_schema()::regnamespace AND c.relname IN ('Message_spend_open_idx','Message_pricing_unsettled_idx') ORDER BY c.relname`,
      );
      expect([...idx.rows].sort((a, b) => String(a.relname).localeCompare(String(b.relname)))).toEqual([
        { relname: "Message_pricing_unsettled_idx", indisvalid: true },
        { relname: "Message_spend_open_idx", indisvalid: true },
      ]);
    });

    it("installs the trigger function once and the triggers on the right tables", async () => {
      const triggers = await q(
        `SELECT c.relname AS "table", t.tgname AS "trigger", p.proname AS "fn" FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_proc p ON p.oid = t.tgfoid
         WHERE NOT t.tgisinternal AND c.relnamespace = current_schema()::regnamespace ORDER BY 1, 2`,
      );
      const key = (r: Record<string, unknown>) => `${r.table}/${r.trigger}`;
      expect([...triggers.rows].sort((a, b) => (key(a) < key(b) ? -1 : 1))).toEqual([
        { table: "ActionInvocation", trigger: "ActionInvocation_append_only", fn: "edwyz_action_invocation_guard" },
        { table: "ActionInvocation", trigger: "ActionInvocation_no_truncate", fn: "edwyz_append_only" },
        { table: "EddyMessage", trigger: "EddyMessage_append_only", fn: "edwyz_append_only" },
        { table: "SpendConsent", trigger: "SpendConsent_append_only", fn: "edwyz_append_only" },
        { table: "SpendConsent", trigger: "SpendConsent_no_truncate", fn: "edwyz_append_only" },
        { table: "SpendLedger", trigger: "SpendLedger_append_only", fn: "edwyz_append_only" },
        { table: "SpendLedger", trigger: "SpendLedger_no_truncate", fn: "edwyz_append_only" },
      ]);
    });
  });
});
