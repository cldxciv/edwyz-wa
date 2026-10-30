import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, DATABASE_URL_TEST, HAS_TEST_DB, type TestDb } from "../helpers/pg";

/**
 * docs/EDDY-SPEC.md 9.1 `actions-pending` on Postgres (EDDY-03 acceptance 4): the confirm claim of 4.5 against the real
 * ActionRecord table of migration 0009. Two concurrent confirms with one nonce run once; a wrong nonce, user or tenant is
 * 404; an expired card is 410; a material change supersedes the card with 409; an undo runs once; the raw CLAIM_SQL
 * returns one row to exactly one of two connections. Skipped cleanly without DATABASE_URL_TEST.
 */
const h = vi.hoisted(() => ({ client: null as unknown as Record<string, unknown> | null }));
vi.mock("@/lib/db", () => ({
  prisma: new Proxy(
    {},
    {
      get(_target, key: string) {
        if (!h.client) throw new Error("The test Prisma client is not ready.");
        const value = h.client[key];
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(h.client) : value;
      },
    },
  ),
}));

import { confirmAction, proposeAction, resetInvokeState, undoAction } from "@/lib/actions/invoke";
import { clearPrincipalMemo, eddyPrincipal } from "@/lib/actions/principal";
import { registerActions, resetRegistry } from "@/lib/actions/registry";
import { CLAIM_SQL } from "@/lib/actions/store";
import { sha256Hex } from "@/lib/actions/canonical";
import { basePreview, sendDef, tagDef, testDeps } from "../helpers/action-fixtures";

describe.skipIf(!HAS_TEST_DB)("ActionRecord confirm claim on Postgres", () => {
  let db: TestDb;
  let prismaClient: { $disconnect: () => Promise<void> } | null = null;
  const agent = { userId: "u_pg_agent", tenantId: "t_pg", role: "agent" as const };
  const principal = (actor = agent) => eddyPrincipal({ actor, emailVerified: true, conversationId: "cv_pg", lang: "en", turnId: `turn_${Math.random()}` });

  beforeAll(async () => {
    db = await createTestDb();
    const { PrismaClient } = await import("@/generated/prisma/client");
    const { PrismaPg } = await import("@prisma/adapter-pg");
    const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL_TEST }, { schema: db.schema }) });
    prismaClient = client;
    h.client = client as unknown as Record<string, unknown>;
    await db.query(`INSERT INTO "Tenant" ("id","name","slug") VALUES ('t_pg','PG','pg'),('t_pg2','PG2','pg2')`);
    await db.query(`INSERT INTO "User" ("id","email","name","passwordHash","emailVerifiedAt") VALUES ('u_pg_agent','a@x.test','Asha','x',now()),('u_pg_other','b@x.test','Ravi','x',now())`);
    await db.query(`INSERT INTO "Membership" ("id","tenantId","userId","role") VALUES ('m1','t_pg','u_pg_agent','agent'),('m2','t_pg','u_pg_other','agent'),('m3','t_pg2','u_pg_agent','agent')`);
    // ActionRecord.conversationId references the member's Eddy conversation (migration 0009).
    await db.query(
      `INSERT INTO "EddyConversation" ("id","tenantId","userId","roleAtStart","roleClass","model","toolsetVersion","promptVersion","visibilityHash")
       VALUES ('cv_pg','t_pg','u_pg_agent','agent','agent','claude-sonnet-5-5','ts_test','p_test','v_test')`,
    );
  });

  afterAll(async () => {
    await prismaClient?.$disconnect().catch(() => undefined);
    h.client = null;
    await db?.close();
  });

  beforeEach(() => {
    resetRegistry();
    resetInvokeState();
    clearPrincipalMemo();
  });

  it("two concurrent confirms with one nonce run once; wrong nonce, user or tenant is 404", async () => {
    const def = sendDef();
    registerActions([def]);
    const deps = testDeps();
    const out = await proposeAction(principal(), "send_fixture", { conversationId: "c1", text: "Hello" }, {}, deps);
    const card = out.card!;
    const ok = { principal: principal(), actionId: card.actionId, nonce: card.nonce, previewHash: card.previewHash };
    expect(await confirmAction({ ...ok, nonce: "wrong-nonce" }, deps)).toMatchObject({ status: 404 });
    expect(await confirmAction({ ...ok, principal: principal({ ...agent, userId: "u_pg_other" }) }, deps)).toMatchObject({ status: 404 });
    expect(await confirmAction({ ...ok, principal: principal({ ...agent, tenantId: "t_pg2" }) }, deps)).toMatchObject({ status: 404 });
    const results = await Promise.all([confirmAction(ok, deps), confirmAction(ok, deps), confirmAction(ok, deps)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect(def.run).toHaveBeenCalledTimes(1);
    const { rows } = await db.query(`SELECT "status","nonceHash" FROM "ActionRecord" WHERE "id" = $1`, [card.actionId]);
    expect(rows[0]).toEqual({ status: "done", nonceHash: sha256Hex(card.nonce) });
    const inv = await db.query(`SELECT "stage","outcome" FROM "ActionInvocation" WHERE "actionRecordId" = $1 ORDER BY "createdAt"`, [card.actionId]);
    expect(inv.rows.map((r) => `${r.stage}:${r.outcome}`)).toEqual(expect.arrayContaining(["preview:needs_confirmation", "execute:started", "execute:ok"]));
  });

  it("an expired card is 410", async () => {
    registerActions([sendDef()]);
    let now = new Date();
    const deps = testDeps({ clock: () => now });
    const out = await proposeAction(principal(), "send_fixture", { conversationId: "c2", text: "Hello" }, {}, deps);
    now = new Date(now.getTime() + 16 * 60_000);
    // The database's own now() is used by CLAIM_SQL; the store's claim compares with the clock it is given.
    expect(await confirmAction({ principal: principal(), actionId: out.card!.actionId, nonce: out.card!.nonce, previewHash: out.card!.previewHash }, deps)).toMatchObject({ status: 410 });
    const { rows } = await db.query(`SELECT "status" FROM "ActionRecord" WHERE "id" = $1`, [out.card!.actionId]);
    expect(rows[0].status).toBe("expired");
  });

  it("a material change gives 409 with a new card that supersedes the old one", async () => {
    let n = 1;
    const def = sendDef({ preview: vi.fn(async (_c: unknown, a: { conversationId: string }) => basePreview({ material: { targetId: a.conversationId, count: n } })) });
    registerActions([def]);
    const deps = testDeps();
    const card = (await proposeAction(principal(), "send_fixture", { conversationId: "c3", text: "Hello" }, {}, deps)).card!;
    n = 2;
    const res = await confirmAction({ principal: principal(), actionId: card.actionId, nonce: card.nonce, previewHash: card.previewHash }, deps);
    expect(res).toMatchObject({ status: 409, state: "changed" });
    expect(def.run).not.toHaveBeenCalled();
    const { rows } = await db.query(`SELECT "status","supersededById" FROM "ActionRecord" WHERE "id" = $1`, [card.actionId]);
    expect(rows[0]).toEqual({ status: "superseded", supersededById: res.card!.actionId });
    const next = await confirmAction({ principal: principal(), actionId: res.card!.actionId, nonce: res.card!.nonce, previewHash: res.card!.previewHash }, deps);
    expect(next).toMatchObject({ status: 200, state: "done" });
  });

  it("an undoable write is stored with its undo and can be undone exactly once", async () => {
    const def = tagDef();
    registerActions([def]);
    const deps = testDeps();
    const out = await proposeAction(principal(), "tag_fixture", { conversationId: "c4", tag: "vip" }, {}, deps);
    expect(out.model).toMatchObject({ status: "done", undoAvailable: true });
    const [a, b] = await Promise.all([undoAction({ principal: principal(), actionId: out.actionId! }, deps), undoAction({ principal: principal(), actionId: out.actionId! }, deps)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(def.undo!.inverse).toHaveBeenCalledTimes(1);
    const { rows } = await db.query(`SELECT "status","undo","undoneAt" IS NOT NULL AS "undone" FROM "ActionRecord" WHERE "id" = $1`, [out.actionId]);
    expect(rows[0]).toEqual({ status: "undone", undo: { kind: "tags", target: "c4", before: [], after: ["vip"] }, undone: true });
  });

  it("CLAIM_SQL hands the row to exactly one of two connections", async () => {
    const nonceHash = sha256Hex("n");
    await db.query(
      `INSERT INTO "ActionRecord" ("id","tenantId","userId","via","principalId","action","risk","status","args","argsHash","previewHash","nonceHash","expiresAt")
       VALUES ('ar_sql','t_pg','u_pg_agent','eddy','eddy:u_pg_agent:cv','send_fixture','confirm','pending','{}','h','ph',$1, now() + interval '10 minutes')`,
      [nonceHash],
    );
    const a = await db.connect();
    const b = await db.connect();
    const params = ["ar_sql", "t_pg", "u_pg_agent", nonceHash, "ph"];
    const [ra, rb] = await Promise.all([a.query(CLAIM_SQL, params), b.query(CLAIM_SQL, params)]);
    expect(ra.rowCount! + rb.rowCount!).toBe(1);
    expect((await db.query(CLAIM_SQL, params)).rowCount).toBe(0);
    expect((await db.query(`SELECT "status" FROM "ActionRecord" WHERE "id"='ar_sql'`)).rows[0].status).toBe("running");
  });
});
