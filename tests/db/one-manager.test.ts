import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { turnOnMetaLimit } from "@/lib/spend/metacap/consent";
import { createTestDb, DATABASE_URL_TEST, HAS_TEST_DB, type TestDb } from "../helpers/pg";

/**
 * One manager per real ad account (docs/SPEND-CONTROLS-SPEC.md 5.1, decision 2.3.14, 12.1c R3, 10.2 one-manager). Two
 * workspaces turn on Meta's limit for the same accountExternalId in parallel, on real Postgres: the partial unique index
 * MetaSpendLimit_one_manager_key (mode = 'managed') lets exactly one become `managed`; the other becomes `other_workspace`.
 * A third workspace's `pending_owner` row on the same account stops neither. Skips without DATABASE_URL_TEST.
 */

const ACT = "act_777";
const ENV = { SPEND_CAP_MODE: "off" } as Record<string, string>;

function clientFor(schema: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL_TEST, options: `-c search_path=${schema}`, max: 6 }, { schema }) });
}

describe.skipIf(!HAS_TEST_DB)("one Meta-limit manager per real ad account", () => {
  let db: TestDb;
  let a: PrismaClient;
  let b: PrismaClient;

  beforeAll(async () => {
    db = await createTestDb();
    for (const [t, asset] of [
      ["t_a", "asset_a"],
      ["t_b", "asset_b"],
      ["t_c", "asset_c"],
    ]) {
      await db.query(`INSERT INTO "Tenant" ("id","name","slug") VALUES ($1,$1,$1)`, [t]);
      await db.query(`INSERT INTO "MetaConnection" ("id","tenantId","metaUserId","tokenEnc","connectedByUserId","updatedAt") VALUES ($1,$2,'mu','sealed','u',now())`, [`mc_${t}`, t]);
      await db.query(`INSERT INTO "MetaAsset" ("id","tenantId","connectionId","type","externalId","name","meta","updatedAt") VALUES ($1,$2,$3,'ad_account',$4,'Shared ads',$5::jsonb,now())`, [asset, t, `mc_${t}`, ACT, JSON.stringify({ currency: "INR", timezone: "Asia/Kolkata" })]);
      await db.query(
        `INSERT INTO "SpendControl" ("tenantId","probation","spendingAdAccountAssetId","timezone","updatedAt") VALUES ($1,'lifted',$2,'Asia/Kolkata',now())
         ON CONFLICT ("tenantId") DO UPDATE SET "probation" = 'lifted', "spendingAdAccountAssetId" = $2`,
        [t, asset],
      );
      await db.query(`INSERT INTO "SpendAllowance" ("id","tenantId","pot","currency","dailyLimitMinor","monthlyLimitMinor","updatedAt") VALUES ($1,$2,'ads','INR',200000,3000000,now()) ON CONFLICT DO NOTHING`, [`sa_${t}`, t]);
    }
    // A third workspace only asked (an admin): pending_owner, which never holds the slot (R3).
    await db.query(`INSERT INTO "MetaSpendLimit" ("adAccountAssetId","tenantId","accountExternalId","mode","updatedAt") VALUES ('asset_c','t_c',$1,'pending_owner',now())`, [ACT]);
    a = clientFor(db.schema);
    b = clientFor(db.schema);
  }, 120_000);

  afterAll(async () => {
    await a?.$disconnect();
    await b?.$disconnect();
    await db?.close();
  });

  it("two owners in parallel: exactly one managed, the other other_workspace; the pending_owner row is untouched", async () => {
    const owner = { userId: "owner", role: "owner" as const };
    const quiet = { env: ENV, enqueue: async () => undefined, notify: async () => undefined };
    const [ra, rb] = await Promise.allSettled([
      turnOnMetaLimit("t_a", owner, { agreed: true, textVersion: "meta-cap-v1" }, { ...quiet, db: a as never }),
      turnOnMetaLimit("t_b", owner, { agreed: true, textVersion: "meta-cap-v1" }, { ...quiet, db: b as never }),
    ]);
    expect(ra.status).toBe("fulfilled");
    expect(rb.status).toBe("fulfilled");
    const { rows } = await db.query(`SELECT "tenantId","mode" FROM "MetaSpendLimit" WHERE "accountExternalId" = $1 ORDER BY "tenantId"`, [ACT]);
    const modes = Object.fromEntries((rows as { tenantId: string; mode: string }[]).map((r) => [r.tenantId, r.mode]));
    expect([modes.t_a, modes.t_b].sort()).toEqual(["managed", "other_workspace"]);
    expect(modes.t_c).toBe("pending_owner");
    // Both consents are stored, append-only, whoever won the slot.
    const consents = await db.query(`SELECT count(*)::int AS n FROM "SpendConsent" WHERE "kind" = 'meta_spend_cap' AND "granted" = true`);
    expect(consents.rows[0].n).toBe(2);
  });

  it("the index refuses a second managed row directly", async () => {
    const { rows } = await db.query(`SELECT "adAccountAssetId" FROM "MetaSpendLimit" WHERE "accountExternalId" = $1 AND "mode" = 'other_workspace'`, [ACT]);
    const loser = rows[0].adAccountAssetId as string;
    await expect(db.query(`UPDATE "MetaSpendLimit" SET "mode" = 'managed' WHERE "adAccountAssetId" = $1`, [loser])).rejects.toMatchObject({ code: "23505" });
  });
});
