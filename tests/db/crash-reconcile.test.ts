import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { headroom, reserveAds } from "@/lib/spend/book";
import { reconcileCommitments } from "@/lib/spend/reconcile";
import { createFakeMeta } from "../helpers/fake-meta";
import { createTestDb, DATABASE_URL_TEST, HAS_TEST_DB, type TestDb } from "../helpers/pg";

/**
 * A crash between reserveAds and settleAds (docs/SPEND-CONTROLS-SPEC.md 10.2 crash-reconcile, I3): the reservation is
 * committed, the process dies (its client is closed and its permit is lost), and nothing settles it. The commitment stays
 * counted. A fresh process runs the reconciler past reservedUntil against fake Meta: ACTIVE becomes live at Meta's budget,
 * PAUSED becomes stopped, each with one reconciled ledger row and only GET requests. Skips without DATABASE_URL_TEST.
 */

const NOW = new Date("2026-10-28T06:30:00Z");
const LATER = new Date(NOW.getTime() + 11 * 60_000);
const ENV = { SPEND_ENFORCE: "enforce" };
const T = "t_crash";

function clientFor(schema: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL_TEST, options: `-c search_path=${schema}`, max: 5 }, { schema }) });
}

describe.skipIf(!HAS_TEST_DB)("crash between reserve and settle", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
    await db.query(`INSERT INTO "Tenant" ("id","name","slug") VALUES ($1,$1,$1)`, [T]);
    await db.query(`INSERT INTO "MetaConnection" ("id","tenantId","metaUserId","tokenEnc","connectedByUserId","updatedAt") VALUES ('mc1',$1,'mu','sealed','u',now())`, [T]);
    await db.query(`INSERT INTO "MetaAsset" ("id","tenantId","connectionId","type","externalId","name","meta","updatedAt") VALUES ('acc1',$1,'mc1','ad_account','act_1','Ads',$2::jsonb,now())`, [T, JSON.stringify({ currency: "INR", timezone: "Asia/Kolkata" })]);
    await db.query(
      `INSERT INTO "SpendControl" ("tenantId","probation","spendingAdAccountAssetId","timezone","updatedAt") VALUES ($1,'lifted','acc1','Asia/Kolkata',now())
       ON CONFLICT ("tenantId") DO UPDATE SET "probation" = 'lifted', "spendingAdAccountAssetId" = 'acc1'`,
      [T],
    );
    await db.query(`INSERT INTO "SpendAllowance" ("id","tenantId","pot","currency","dailyLimitMinor","monthlyLimitMinor","updatedAt") VALUES ('sa1',$1,'ads','INR',1000000,10000000,now())`, [T]);
    for (const c of ["c1", "c2"]) {
      await db.query(
        `INSERT INTO "AdCampaign" ("id","tenantId","adAccountAssetId","metaCampaignId","name","template","objective","status","dailyBudgetMinor","currency","updatedAt")
         VALUES ($1,$2,'acc1',$3,$1,'lead_generation','OUTCOME_LEADS','paused',100000,'INR',now())`,
        [c, T, `m_${c}`],
      );
      await db.query(`INSERT INTO "AdSet" ("id","tenantId","campaignId","metaAdSetId","name","status","targeting","dailyBudgetMinor") VALUES ($1,$2,$3,$4,$1,'paused','{}'::jsonb,100000)`, [`${c}s`, T, c, `m_${c}s`]);
    }
  }, 120_000);
  afterAll(async () => {
    await db?.close();
  });

  it("keeps the crashed reservation counted, then the reconciler settles it from Meta: ACTIVE to live, PAUSED to stopped", async () => {
    // The "process" that crashes: it reserves both, then dies before any Meta call returns and before settling.
    const doomed = clientFor(db.schema);
    for (const c of ["c1", "c2"]) {
      await reserveAds(T, { kind: "activate", campaignId: c, sets: [{ adSetId: `${c}s`, metaAdSetId: `m_${c}s` }] }, { type: "user", userId: "u", role: "owner" }, { idempotencyKey: `activate:${c}`, reason: "Launch", db: doomed as never, now: NOW, env: ENV });
    }
    await doomed.$disconnect();

    // A new process: both are still counted, at their worst case, even past reservedUntil.
    const fresh = clientFor(db.schema);
    try {
      const room = await headroom(T, "ads", { db: fresh as never, now: LATER, env: ENV });
      expect(room.today.committed).toBe(350_000n);

      // Meta: c1 went live with a budget changed to 1,200; c2 never got past PAUSED.
      const meta = createFakeMeta({ now: LATER, accountId: "act_1" });
      meta.addCampaign({ id: "m_c1", status: "ACTIVE" });
      meta.addAdSet({ id: "m_c1s", campaignId: "m_c1", status: "ACTIVE", dailyBudgetMinor: 120_000n });
      meta.addCampaign({ id: "m_c2", status: "PAUSED" });
      meta.addAdSet({ id: "m_c2s", campaignId: "m_c2", status: "PAUSED", dailyBudgetMinor: 100_000n });
      const out = await reconcileCommitments({
        db: fresh as never,
        now: LATER,
        access: async () => ({ token: "tok" }),
        read: async (_t, id) => meta.request("GET", id).body as Record<string, unknown>,
      });
      expect(out).toMatchObject({ checked: 2, live: 1, stopped: 1, unreachable: 0 });
      expect(meta.calls.every((c) => c.method === "GET")).toBe(true);

      const rows = await db.query<{ metaObjectId: string; status: string; dailyBudgetMinor: string }>(`SELECT "metaObjectId", "status", "dailyBudgetMinor"::text AS "dailyBudgetMinor" FROM "SpendCommitment" WHERE "tenantId" = $1 ORDER BY "metaObjectId"`, [T]);
      expect(rows.rows).toEqual([
        { metaObjectId: "m_c1s", status: "live", dailyBudgetMinor: "120000" },
        { metaObjectId: "m_c2s", status: "stopped", dailyBudgetMinor: "100000" },
      ]);
      const ledger = await db.query<{ phase: string; n: string }>(`SELECT "phase", count(*)::text AS n FROM "SpendLedger" WHERE "tenantId" = $1 GROUP BY "phase" ORDER BY "phase"`, [T]);
      expect(ledger.rows).toEqual(expect.arrayContaining([{ phase: "requested", n: "2" }]));
      const reconciled = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM "SpendLedger" WHERE "tenantId" = $1 AND "phase" = 'reconciled' AND "action" = 'ads.campaign.activate'`, [T]);
      expect(reconciled.rows[0].n).toBe("2");
      // A second run has nothing left to do.
      expect((await reconcileCommitments({ db: fresh as never, now: LATER, access: async () => ({ token: "tok" }), read: async (_t, id) => meta.request("GET", id).body as Record<string, unknown> })).checked).toBe(0);
    } finally {
      await fresh.$disconnect();
    }
  }, 120_000);
});
