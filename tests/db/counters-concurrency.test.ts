import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { counterKeys, ensureRowsStatement, reserveStatement, settleStatement, unreservePeriodStatement, type CounterPot } from "@/lib/spend/counters";
import { isLockTimeoutError, SPEND_LOCK_SQL, spendLockKey } from "@/lib/spend/lock";
import { closeStatement, consumeStatement } from "@/lib/spend/reservations";
import { createTestDb, DATABASE_URL_TEST, HAS_TEST_DB, inTransaction, type TestDb } from "../helpers/pg";

/**
 * The lock-free counters against real Postgres (docs/SPEND-CONTROLS-SPEC.md 10.2 counters-concurrency): 2 separate Node
 * processes run 25 parallel reservations each (one connection per reservation) against a limit that fits exactly 10.
 * Exactly 10 succeed and nothing deadlocks, for WhatsApp and for AI credits. The children run the very statements
 * counters.ts exports. Also: the spend lock's timeout gives 55P03, and the reservation statements behave as written.
 * Skips cleanly when DATABASE_URL_TEST is not set.
 */

const req = createRequire(import.meta.url);
const PG_PATH = req.resolve("pg");

/** One child process: `parallel` reservations at once, each in its own connection and transaction, as processSendJob does. */
const CHILD = `
const pg = require(process.env.PG_PATH);
const job = JSON.parse(process.env.SPEND_JOB);
async function once() {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL_TEST });
  try {
    await c.connect();
    await c.query('SET search_path TO "' + job.schema + '"');
    await c.query('BEGIN');
    await c.query(job.ensure.text, job.ensure.values);
    const r = (await c.query(job.reserve.text, job.reserve.values)).rows[0];
    if (r.d !== 1 || r.m !== 1) { await c.query('ROLLBACK'); return 'refused'; }
    await c.query('COMMIT');
    return 'ok';
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    return 'error:' + (e.code || e.message);
  } finally {
    await c.end().catch(() => {});
  }
}
Promise.all(Array.from({ length: job.parallel }, once))
  .then((out) => process.stdout.write(JSON.stringify(out)))
  .catch((e) => { process.stderr.write(String((e && e.stack) || e)); process.exit(1); });
`;

const plain = (s: { text: string; values: unknown[] }) => ({ text: s.text, values: s.values.map((v) => (typeof v === "bigint" ? v.toString() : v instanceof Date ? v.toISOString() : v)) });

function runChild(job: Record<string, unknown>): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", CHILD], { env: { ...process.env, PG_PATH, SPEND_JOB: JSON.stringify(job), DATABASE_URL_TEST } });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(JSON.parse(out) as string[]) : reject(new Error(`child exited ${code}: ${err}`))));
  });
}

describe.skipIf(!HAS_TEST_DB)("spend counters on Postgres", () => {
  let db: TestDb;
  const keys = counterKeys(new Date("2026-10-28T06:00:00Z"), "Asia/Kolkata");

  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db?.close();
  });

  async function race(tenantId: string, pot: CounterPot, amount: bigint, limits: { day: bigint | null; month: bigint | null }) {
    const job = {
      schema: db.schema,
      parallel: 25,
      ensure: plain(ensureRowsStatement(tenantId, pot, keys, pot === "ai" ? "CRD" : "INR")),
      reserve: plain(reserveStatement(tenantId, pot, keys, amount, limits.day, limits.month)),
    };
    const [a, b] = await Promise.all([runChild(job), runChild(job)]);
    const all = [...a, ...b];
    const { rows } = await db.query<{ periodKind: string; reservedMinor: string }>(`SELECT "periodKind", "reservedMinor"::text AS "reservedMinor" FROM "SpendCounter" WHERE "tenantId" = $1 AND "pot" = $2 ORDER BY "periodKind"`, [tenantId, pot]);
    return { all, rows };
  }

  it("WhatsApp: 2 processes x 25 parallel reservations against a month that fits 10 give exactly 10", async () => {
    const { all, rows } = await race("t_msg", "messaging", 115n, { day: null, month: 1_150n });
    expect(all.filter((r) => r === "ok")).toHaveLength(10);
    expect(all.filter((r) => r.startsWith("error"))).toEqual([]);
    expect(rows).toEqual([
      { periodKind: "day", reservedMinor: "1150" },
      { periodKind: "month", reservedMinor: "1150" },
    ]);
  });

  it("AI credits: the same against a daily limit, with no deadlock and nothing reserved on the month without the day", async () => {
    const { all, rows } = await race("t_ai", "ai", 3n, { day: 30n, month: 500n });
    expect(all.filter((r) => r === "ok")).toHaveLength(10);
    expect(all.filter((r) => r.startsWith("error"))).toEqual([]);
    expect(rows.map((r) => r.reservedMinor)).toEqual(["30", "30"]);
  });

  it("a partial match rolls back, and settle and release clamp at zero", async () => {
    const t = "t_partial";
    await db.query(plain(ensureRowsStatement(t, "messaging", keys, "INR")).text, plain(ensureRowsStatement(t, "messaging", keys, "INR")).values);
    await db.query(`UPDATE "SpendCounter" SET "spentMinor" = 900 WHERE "tenantId" = $1 AND "periodKind" = 'month'`, [t]);
    await db.query("BEGIN");
    const s = plain(reserveStatement(t, "messaging", keys, 200n, 10_000n, 1_000n));
    const r = (await db.query<{ d: number; m: number }>(s.text, s.values)).rows[0];
    expect([r.d, r.m]).toEqual([1, 0]);
    await db.query("ROLLBACK");
    const after = await db.query<{ r: string }>(`SELECT sum("reservedMinor")::text AS r FROM "SpendCounter" WHERE "tenantId" = $1`, [t]);
    expect(after.rows[0].r).toBe("0");
    // Inside a caller's transaction there is nothing of ours to roll back: the half that matched is undone, then COMMIT.
    await db.query("BEGIN");
    const again = (await db.query<{ d: number; m: number }>(s.text, s.values)).rows[0];
    expect([again.d, again.m]).toEqual([1, 0]);
    const undo = plain(unreservePeriodStatement(t, "messaging", "day", keys.day, 200n));
    expect((await db.query(undo.text, undo.values)).rowCount).toBe(1);
    await db.query("COMMIT");
    const committed = await db.query<{ r: string }>(`SELECT sum("reservedMinor")::text AS r FROM "SpendCounter" WHERE "tenantId" = $1`, [t]);
    expect(committed.rows[0].r).toBe("0");
    const settle = plain(settleStatement(t, "messaging", keys, 50n, -5_000n));
    expect((await db.query(settle.text, settle.values)).rowCount).toBe(2);
    const clamp = await db.query<{ reservedMinor: string; spentMinor: string }>(`SELECT "reservedMinor"::text AS "reservedMinor", "spentMinor"::text AS "spentMinor" FROM "SpendCounter" WHERE "tenantId" = $1 ORDER BY "periodKind"`, [t]);
    expect(clamp.rows).toEqual([
      { reservedMinor: "0", spentMinor: "0" },
      { reservedMinor: "0", spentMinor: "0" },
    ]);
  });

  it("consumes and closes a hold with single conditional updates", async () => {
    const now = new Date("2026-10-28T06:00:00Z");
    await db.query(
      `INSERT INTO "SpendReservation" ("id","tenantId","pot","currency","subjectType","subjectId","amountMinor","dayKey","monthKey","expiresAt","correlationId")
       VALUES ('sr_db','t_res','messaging','INR','broadcast','b1',1000,$1,$2,$3,'c1')`,
      [keys.day, keys.month, new Date(now.getTime() + 60_000)],
    );
    const take = async (amount: bigint) => {
      const s = plain(consumeStatement("sr_db", amount, now));
      return (await db.query(s.text, s.values)).rowCount;
    };
    expect(await take(600n)).toBe(1);
    expect(await take(500n)).toBe(0); // would go past the hold
    expect(await take(400n)).toBe(1);
    const close = plain(closeStatement("sr_db", "released", now, null));
    const closed = await db.query<{ status: string; consumedMinor: string }>(close.text, close.values);
    expect(closed.rows[0]).toMatchObject({ status: "settled", consumedMinor: "1000" });
    expect((await db.query(close.text, close.values)).rowCount).toBe(0);
    expect(await take(1n)).toBe(0);
  });

  it("the spend lock times out with 55P03 while another connection holds it", async () => {
    const other = await db.connect();
    const key = spendLockKey("t_lock", "ads");
    await other.query("BEGIN");
    await other.query(SPEND_LOCK_SQL.lock, [key]);
    const started = Date.now();
    const error = await inTransaction(db.client, async () => {
      await db.query(SPEND_LOCK_SQL.timeout);
      await db.query(SPEND_LOCK_SQL.lock, [key]);
    }).catch((e: unknown) => e);
    expect(isLockTimeoutError(error)).toBe(true);
    expect(Date.now() - started).toBeLessThan(6_000);
    // Another pot of the same workspace is a different key and is not blocked.
    await inTransaction(db.client, async () => {
      await db.query(SPEND_LOCK_SQL.timeout);
      await db.query(SPEND_LOCK_SQL.lock, [spendLockKey("t_lock", "messaging")]);
    });
    await other.query("COMMIT");
  });
});
