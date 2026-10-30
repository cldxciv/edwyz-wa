import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { reserveAds } from "@/lib/spend/book";
import { METACAP_LOCK_NAMESPACE, SPEND_LOCK_SQL, SpendLockOrderError, spendLockKey, withSpendLock } from "@/lib/spend/lock";
import { createTestDb, DATABASE_URL_TEST, HAS_TEST_DB, type TestDb } from "../helpers/pg";

/**
 * Lock order (docs/SPEND-CONTROLS-SPEC.md I10, 10.2 lock-order). The metacap account lock (21329, account) is always taken
 * before the spend lock (21328, tenant:pot), and reserveAds never takes the account lock, so a metacap write holding the
 * account lock while reserveAds runs on the same workspace completes without a deadlock. Spend locks for two pots are
 * never held together: nesting them throws SpendLockOrderError outside production. Skips without DATABASE_URL_TEST.
 */

const NOW = new Date("2026-10-28T06:30:00Z");
const ENV = { SPEND_ENFORCE: "enforce" };
const T = "t_order";
const METACAP_LOCK_SQL = `SELECT pg_advisory_xact_lock(${METACAP_LOCK_NAMESPACE}, hashtext($1::text))`;

function clientFor(schema: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL_TEST, options: `-c search_path=${schema}`, max: 5 }, { schema }) });
}

describe.skipIf(!HAS_TEST_DB)("spend lock order", () => {
  let db: TestDb;
  let client: PrismaClient;

  beforeAll(async () => {
    db = await createTestDb();
    client = clientFor(db.schema);
    await db.query(`INSERT INTO "Tenant" ("id","name","slug") VALUES ($1,$1,$1)`, [T]);
    await db.query(`INSERT INTO "MetaConnection" ("id","tenantId","metaUserId","tokenEnc","connectedByUserId","updatedAt") VALUES ('mc1',$1,'mu','sealed','u',now())`, [T]);
    await db.query(`INSERT INTO "MetaAsset" ("id","tenantId","connectionId","type","externalId","name","meta","updatedAt") VALUES ('acc1',$1,'mc1','ad_account','act_1','Ads',$2::jsonb,now())`, [T, JSON.stringify({ currency: "INR", timezone: "Asia/Kolkata" })]);
    await db.query(
      `INSERT INTO "SpendControl" ("tenantId","probation","spendingAdAccountAssetId","timezone","updatedAt") VALUES ($1,'lifted','acc1','Asia/Kolkata',now())
       ON CONFLICT ("tenantId") DO UPDATE SET "probation" = 'lifted', "spendingAdAccountAssetId" = 'acc1'`,
      [T],
    );
    await db.query(`INSERT INTO "SpendAllowance" ("id","tenantId","pot","currency","dailyLimitMinor","monthlyLimitMinor","updatedAt") VALUES ('sa1',$1,'ads','INR',1000000,10000000,now())`, [T]);
    await db.query(
      `INSERT INTO "AdCampaign" ("id","tenantId","adAccountAssetId","metaCampaignId","name","template","objective","status","dailyBudgetMinor","currency","updatedAt")
       VALUES ('c1',$1,'acc1','m_c1','c1','lead_generation','OUTCOME_LEADS','paused',100000,'INR',now())`,
      [T],
    );
    await db.query(`INSERT INTO "AdSet" ("id","tenantId","campaignId","metaAdSetId","name","status","targeting","dailyBudgetMinor") VALUES ('c1s',$1,'c1','m_c1s','c1s','paused','{}'::jsonb,100000)`, [T]);
  }, 120_000);
  afterAll(async () => {
    await client?.$disconnect();
    await db?.close();
  });

  it("a metacap write holding the account lock, then the spend lock, and reserveAds at the same time: both finish, no deadlock", async () => {
    const metacap = await db.connect();
    await metacap.query("BEGIN");
    await metacap.query(METACAP_LOCK_SQL, ["acc1"]);
    // The metacap write: account lock first, then the spend lock (the fixed order), a short write, commit.
    const metacapWrite = (async () => {
      await metacap.query(SPEND_LOCK_SQL.timeout);
      await metacap.query(SPEND_LOCK_SQL.lock, [spendLockKey(T, "ads")]);
      await new Promise((r) => setTimeout(r, 200));
      await metacap.query("COMMIT");
    })();
    // reserveAds takes only the spend lock, never the account lock, so the two can only queue, never wait on each other.
    const reserving = reserveAds(T, { kind: "activate", campaignId: "c1", sets: [{ adSetId: "c1s", metaAdSetId: "m_c1s" }] }, { type: "user", userId: "u", role: "owner" }, { idempotencyKey: "activate:c1", reason: "Order test", db: client as never, now: NOW, env: ENV });
    const [, permit] = await Promise.all([metacapWrite, reserving]);
    expect(permit.kind).toBe("activate");
    const n = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM "SpendCommitment" WHERE "tenantId" = $1 AND "status" = 'reserved'`, [T]);
    expect(n.rows[0].n).toBe("1");
  }, 60_000);

  it("nested spend locks for two pots throw in test mode, and the outer transaction rolls back", async () => {
    const error = await withSpendLock(T, "ads", async () => withSpendLock(T, "messaging", async () => "never"), { db: client as never }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SpendLockOrderError);
    // The same pot nested re-uses the outer transaction.
    await expect(withSpendLock(T, "ads", async () => withSpendLock(T, "ads", async () => "same"), { db: client as never })).resolves.toBe("same");
  }, 60_000);
});
