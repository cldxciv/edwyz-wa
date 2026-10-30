import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeSpendDb, RawCall, Row } from "./helpers/fake-spend-db";

const h = vi.hoisted(() => ({ db: null as unknown as FakeSpendDb }));

vi.mock("@/lib/db", async () => {
  const { createFakeSpendDb } = await import("./helpers/fake-spend-db");
  h.db = createFakeSpendDb();
  return { prisma: h.db.prisma };
});

import {
  adjustSpent,
  counterKeys,
  readCounters,
  releaseCounter,
  reserveCounter,
  reserveCounterUnconditional,
  reserveStatement,
  settleCounter,
  settleStatement,
} from "@/lib/spend/counters";
import { SpendBlockedError, SpendBusyError } from "@/lib/spend/errors";
import { heldSpendLocks, isLockTimeoutError, SpendLockOrderError, withSpendLock, type SpendLockClient } from "@/lib/spend/lock";
import {
  consumeReservation,
  createCallReservation,
  expireReservations,
  openReservationFor,
  releaseCallReservation,
  releaseUnspent,
  reserveBulk,
  settleCallReservation,
} from "@/lib/spend/reservations";
import type { SpendActor } from "@/lib/spend/types";

const T = "t1";
const KEYS = { day: "2026-10-28", month: "2026-10" };
const owner: SpendActor = { type: "user", userId: "u_owner", role: "owner" };
const max = (a: bigint, b: bigint) => (a > b ? a : b);

/**
 * Emulates the SpendCounter statements of counters.ts on the fake's rows, atomically (JavaScript runs one handler at a
 * time, like Postgres re-checking each row after its lock). By default a partial match changes neither row, which is the
 * end state after Postgres rolls back our own transaction. With `postgresPartial` each row is updated on its own exactly as
 * the CTE statement does, for code paths that run inside a caller's transaction and must undo the half that matched.
 */
function emulateCounterSql(db: FakeSpendDb, opts: { postgresPartial?: boolean } = {}) {
  db.onRaw((call: RawCall) => {
    const rows = db.rows("spendCounter");
    const find = (t: unknown, pot: unknown, kind: string, key: unknown) => rows.find((r) => r.tenantId === t && r.pot === pot && r.periodKind === kind && r.periodKey === key);
    if (call.sql.includes("spend.counter.unreserve")) {
      const [t, pot, kind, key, c] = call.values as [string, string, string, string, bigint];
      const r = find(t, pot, kind, key);
      if (!r) return 0;
      r.reservedMinor = max(0n, (r.reservedMinor as bigint) - c);
      return 1;
    }
    if (call.sql.includes("spend.counter.reserve")) {
      const [t, pot, day, month, c, dl, ml] = call.values as [string, string, string, string, bigint, bigint | null, bigint | null];
      const d = find(t, pot, "day", day);
      const m = find(t, pot, "month", month);
      const fits = (r: Row | undefined, lim: bigint | null) => !!r && (lim === null || (r.spentMinor as bigint) + (r.reservedMinor as bigint) + c <= lim);
      const dOk = fits(d, dl);
      const mOk = fits(m, ml);
      if (opts.postgresPartial) {
        if (dOk) d!.reservedMinor = (d!.reservedMinor as bigint) + c;
        if (mOk) m!.reservedMinor = (m!.reservedMinor as bigint) + c;
      } else if (dOk && mOk) {
        d!.reservedMinor = (d!.reservedMinor as bigint) + c;
        m!.reservedMinor = (m!.reservedMinor as bigint) + c;
      }
      const total = (r: Row | undefined) => (r ? String((r.spentMinor as bigint) + (r.reservedMinor as bigint)) : null);
      return [{ d: dOk ? 1 : 0, m: mOk ? 1 : 0, dayTotal: dOk ? total(d) : null, monthTotal: mOk ? total(m) : null }];
    }
    if (call.sql.includes("spend.counter.settle")) {
      const [t, pot, day, month, rel, delta] = call.values as [string, string, string, string, bigint, bigint];
      let n = 0;
      for (const r of [find(t, pot, "day", day), find(t, pot, "month", month)]) {
        if (!r) continue;
        r.reservedMinor = max(0n, (r.reservedMinor as bigint) - rel);
        r.spentMinor = max(0n, (r.spentMinor as bigint) + delta);
        n++;
      }
      return n;
    }
    const returning = (r: Row) => ({ ...r, amountMinor: String(r.amountMinor), consumedMinor: String(r.consumedMinor) });
    if (call.sql.includes("spend.reservation.consume")) {
      const [id, c, now] = call.values as [string, bigint, Date];
      const r = db.rows("spendReservation").find((x) => x.id === id);
      if (!r || r.status !== "held" || (r.expiresAt as Date).getTime() <= now.getTime() || (r.consumedMinor as bigint) + c > (r.amountMinor as bigint)) return [];
      r.consumedMinor = (r.consumedMinor as bigint) + c;
      return [returning(r)];
    }
    if (call.sql.includes("spend.reservation.close")) {
      const [id, status, now, actual] = call.values as [string, string, Date, bigint | null];
      const r = db.rows("spendReservation").find((x) => x.id === id);
      if (!r || r.status !== "held") return [];
      r.status = status === "released" && (r.consumedMinor as bigint) > 0n ? "settled" : status;
      r.closedAt = now;
      if (actual !== null) r.consumedMinor = actual;
      return [returning(r)];
    }
    return undefined;
  });
}

const counter = (kind: "day" | "month", pot = "messaging") => h.db.rows("spendCounter").find((r) => r.tenantId === T && r.pot === pot && r.periodKind === kind)!;
const seedCounters = (spent: { day?: bigint; month?: bigint }, pot = "messaging", reserved: { day?: bigint; month?: bigint } = {}) =>
  h.db.seed("spendCounter", [
    { tenantId: T, pot, periodKind: "day", periodKey: KEYS.day, currency: pot === "ai" ? "CRD" : "INR", spentMinor: spent.day ?? 0n, reservedMinor: reserved.day ?? 0n },
    { tenantId: T, pot, periodKind: "month", periodKey: KEYS.month, currency: pot === "ai" ? "CRD" : "INR", spentMinor: spent.month ?? 0n, reservedMinor: reserved.month ?? 0n },
  ]);
const ledger = (action?: string) => h.db.rows("spendLedger").filter((r) => !action || r.action === action);

beforeEach(() => {
  h.db.reset();
  emulateCounterSql(h.db);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// =====================================================================================================================
describe("counter keys", () => {
  it("are day and month keys in the workspace time zone", () => {
    const at = new Date("2026-10-31T20:00:00Z"); // 1 Nov 01:30 in Kolkata
    expect(counterKeys(at, "Asia/Kolkata")).toEqual({ day: "2026-11-01", month: "2026-11" });
    expect(counterKeys(at, "America/New_York")).toEqual({ day: "2026-10-31", month: "2026-10" });
  });

  it("default to SpendControl.timezone", async () => {
    h.db.seed("spendControl", [{ tenantId: T, timezone: "America/New_York" }]);
    const out = await reserveCounter({ tenantId: T, pot: "messaging", amountMinor: 10n, dayLimitMinor: null, monthLimitMinor: null, at: new Date("2026-10-31T20:00:00Z") });
    expect(out.keys).toEqual({ day: "2026-10-31", month: "2026-10" });
  });
});

describe("lock-free conditional reservation (4.9)", () => {
  it("creates the rows first, then reserves on both", async () => {
    const out = await reserveCounter({ tenantId: T, pot: "messaging", amountMinor: 115n, dayLimitMinor: 50_000n, monthLimitMinor: 500_000n, keys: KEYS });
    expect(out).toEqual({ ok: true, keys: KEYS, dayTotal: 115n, monthTotal: 115n });
    expect(counter("day")).toMatchObject({ reservedMinor: 115n, spentMinor: 0n, currency: "INR" });
    expect(counter("month").reservedMinor).toBe(115n);
    const sql = h.db.raw.find((c) => c.sql.includes("spend.counter.reserve"))!;
    expect(sql.sql).toMatch(/"spentMinor" \+ "reservedMinor" \+ \$5::bigint <= \$6::bigint/);
    expect(sql.tx).not.toBeNull(); // inside a transaction, so a partial match rolls back
  });

  it("refuses when the day or the month would go over, and changes nothing", async () => {
    seedCounters({ day: 900n, month: 9_000n });
    expect(await reserveCounter({ tenantId: T, pot: "messaging", amountMinor: 200n, dayLimitMinor: 1_000n, monthLimitMinor: 100_000n, keys: KEYS })).toMatchObject({ ok: false, exhausted: "day" });
    expect(await reserveCounter({ tenantId: T, pot: "messaging", amountMinor: 50n, dayLimitMinor: null, monthLimitMinor: 9_000n, keys: KEYS })).toMatchObject({ ok: false, exhausted: "month" });
    expect(await reserveCounter({ tenantId: T, pot: "messaging", amountMinor: 5_000n, dayLimitMinor: 1_000n, monthLimitMinor: 9_000n, keys: KEYS })).toMatchObject({ ok: false, exhausted: "both" });
    expect([counter("day").reservedMinor, counter("month").reservedMinor]).toEqual([0n, 0n]);
    // Exactly at the limit fits.
    expect((await reserveCounter({ tenantId: T, pot: "messaging", amountMinor: 100n, dayLimitMinor: 1_000n, monthLimitMinor: null, keys: KEYS })).ok).toBe(true);
  });

  it("never overdraws under parallel reservations", async () => {
    const tries = Array.from({ length: 40 }, () => reserveCounter({ tenantId: T, pot: "messaging", amountMinor: 100n, dayLimitMinor: null, monthLimitMinor: 1_000n, keys: KEYS }));
    const results = await Promise.all(tries);
    expect(results.filter((r) => r.ok)).toHaveLength(10);
    expect(counter("month").reservedMinor).toBe(1_000n);
    expect(counter("day").reservedMinor).toBe(1_000n);
    // AI credits the same way, with a daily limit.
    const ai = await Promise.all(Array.from({ length: 30 }, () => reserveCounter({ tenantId: T, pot: "ai", amountMinor: 3n, dayLimitMinor: 30n, monthLimitMinor: 500n, keys: KEYS })));
    expect(ai.filter((r) => r.ok)).toHaveLength(10);
    expect(counter("day", "ai")).toMatchObject({ reservedMinor: 30n, currency: "CRD" });
  });

  it("inside a caller's transaction a partial match is undone before refusing, so half a reservation never commits", async () => {
    h.db.onRaw(null);
    emulateCounterSql(h.db, { postgresPartial: true });
    seedCounters({ day: 0n, month: 950n });
    const run = (h.db.prisma as unknown as { $transaction: <R>(fn: (tx: never) => Promise<R>) => Promise<R> }).$transaction;
    // The day fits, the month does not: Postgres updates the day row only.
    const out = await run((tx) => reserveCounter({ tenantId: T, pot: "messaging", amountMinor: 100n, dayLimitMinor: 10_000n, monthLimitMinor: 1_000n, keys: KEYS }, tx));
    expect(out).toMatchObject({ ok: false, exhausted: "month" });
    expect([counter("day").reservedMinor, counter("month").reservedMinor]).toEqual([0n, 0n]);
    expect(h.db.raw.filter((c) => c.sql.includes("spend.counter.unreserve")).map((c) => c.values.slice(2))).toEqual([["day", KEYS.day, 100n]]);
    expect(h.db.transactions.at(-1)?.status).toBe("committed");
    // The month fits, the day does not: the month row is put back.
    const day = await run((tx) => reserveCounter({ tenantId: T, pot: "messaging", amountMinor: 30n, dayLimitMinor: 20n, monthLimitMinor: 1_000n, keys: KEYS }, tx));
    expect(day).toMatchObject({ ok: false, exhausted: "day" });
    expect([counter("day").reservedMinor, counter("month").reservedMinor]).toEqual([0n, 0n]);
    // Both fit: nothing to undo.
    expect((await run((tx) => reserveCounter({ tenantId: T, pot: "messaging", amountMinor: 50n, dayLimitMinor: 1_000n, monthLimitMinor: 1_000n, keys: KEYS }, tx))).ok).toBe(true);
    expect([counter("day").reservedMinor, counter("month").reservedMinor]).toEqual([50n, 50n]);
    // On the app client the statement runs in its own transaction instead, so no undo statement is sent.
    h.db.raw.length = 0;
    expect((await reserveCounter({ tenantId: T, pot: "messaging", amountMinor: 1_000n, dayLimitMinor: 10_000n, monthLimitMinor: 1_000n, keys: KEYS })).ok).toBe(false);
    expect(h.db.raw.some((c) => c.sql.includes("spend.counter.unreserve"))).toBe(false);
  });

  it("a free message (0) always fits and touches nothing", async () => {
    seedCounters({ month: 5_000n });
    expect((await reserveCounter({ tenantId: T, pot: "messaging", amountMinor: 0n, dayLimitMinor: 1n, monthLimitMinor: 1n, keys: KEYS })).ok).toBe(true);
    expect(h.db.raw.filter((c) => c.sql.includes("spend.counter"))).toHaveLength(0);
    await expect(reserveCounter({ tenantId: T, pot: "messaging", amountMinor: -1n, dayLimitMinor: null, monthLimitMinor: null, keys: KEYS })).rejects.toThrow(RangeError);
  });

  it("the unconditional path always increments and flags going over the limit", async () => {
    seedCounters({ day: 990n, month: 990n });
    const out = await reserveCounterUnconditional({ tenantId: T, pot: "messaging", amountMinor: 115n, keys: KEYS, dayLimitMinor: 1_000n, monthLimitMinor: 100_000n });
    expect(out).toMatchObject({ overLimit: true, overLimitPeriods: ["day"], dayTotal: 1_105n, monthTotal: 1_105n });
    const under = await reserveCounterUnconditional({ tenantId: T, pot: "messaging", amountMinor: 10n, keys: KEYS });
    expect(under.overLimit).toBe(false);
    expect(counter("day").reservedMinor).toBe(125n);
    // The same statement with no limit conditions.
    expect(reserveStatement(T, "messaging", KEYS, 1n, null, null).values.slice(5)).toEqual([null, null]);
  });

  it("settles, releases and adjusts, never below zero", async () => {
    seedCounters({ day: 1_000n, month: 5_000n }, "messaging", { day: 300n, month: 300n });
    await settleCounter({ tenantId: T, pot: "messaging", keys: KEYS, reservedMinor: 115n, actualMinor: 115n });
    expect(counter("day")).toMatchObject({ reservedMinor: 185n, spentMinor: 1_115n });
    await releaseCounter({ tenantId: T, pot: "messaging", keys: KEYS, amountMinor: 1_000n });
    expect(counter("month").reservedMinor).toBe(0n);
    await adjustSpent({ tenantId: T, pot: "messaging", keys: KEYS, deltaMinor: -115n });
    expect([counter("day").spentMinor, counter("month").spentMinor]).toEqual([1_000n, 5_000n]);
    expect(await readCounters(T, "messaging", KEYS)).toEqual({ day: { spent: 1_000n, reserved: 0n, used: 1_000n }, month: { spent: 5_000n, reserved: 0n, used: 5_000n } });
    await adjustSpent({ tenantId: T, pot: "messaging", keys: KEYS, deltaMinor: -3_000n });
    expect([counter("day").spentMinor, counter("month").spentMinor]).toEqual([0n, 2_000n]);
    expect(await releaseCounter({ tenantId: T, pot: "messaging", keys: KEYS, amountMinor: 0n })).toBe(0);
    expect(settleStatement(T, "ai", KEYS, 2n, 3n).text).toMatch(/GREATEST\("reservedMinor" - \$5::bigint, 0\)/);
    await expect(settleCounter({ tenantId: T, pot: "messaging", keys: KEYS, reservedMinor: -1n, actualMinor: 0n })).rejects.toThrow(RangeError);
  });
});

// =====================================================================================================================
describe("bulk reservations (reserveBulk)", () => {
  const opts = (limits: { daily: bigint | null; monthly: bigint | null }) => ({ currency: "INR", limits, actor: owner, reason: "Started the Diwali broadcast", timezone: "Asia/Kolkata", at: new Date("2026-10-28T06:00:00Z") });

  it("holds the estimate under the lock and counts it against today and the month", async () => {
    const out = await reserveBulk(T, "messaging", 430_000n, { type: "broadcast", id: "b1" }, 7 * 86_400_000, opts({ daily: null, monthly: 1_000_000n }));
    expect(out.created).toBe(true);
    expect(out.reservation).toMatchObject({ status: "held", amountMinor: 430_000n, consumedMinor: 0n, dayKey: KEYS.day, monthKey: KEYS.month, subjectType: "broadcast", subjectId: "b1" });
    expect([counter("day").reservedMinor, counter("month").reservedMinor]).toEqual([430_000n, 430_000n]);
    expect(h.db.raw.some((c) => c.sql.includes("pg_advisory_xact_lock(21328") && c.values[0] === `${T}:messaging`)).toBe(true);
    expect(ledger("messaging.bulk_hold").map((r) => r.phase)).toEqual(["requested", "applied"]);
    // A retried start returns the same hold.
    const again = await reserveBulk(T, "messaging", 430_000n, { type: "broadcast", id: "b1" }, 7 * 86_400_000, opts({ daily: null, monthly: 1_000_000n }));
    expect(again).toMatchObject({ created: false, reservation: { id: out.reservation!.id } });
    expect(counter("month").reservedMinor).toBe(430_000n);
    expect(await openReservationFor(T, { type: "broadcast", id: "b1" }, { now: new Date("2026-10-28T07:00:00Z") })).toMatchObject({ id: out.reservation!.id });
  });

  it("refuses with 409 spend.broadcast and the numbers, holding nothing", async () => {
    seedCounters({ day: 0n, month: 380_000n });
    const e = await reserveBulk(T, "messaging", 430_000n, { type: "broadcast", id: "b2" }, 86_400_000, opts({ daily: null, monthly: 500_000n })).catch((x) => x);
    expect(e).toBeInstanceOf(SpendBlockedError);
    expect(e.status).toBe(409);
    expect(e.code).toBe("spend.broadcast");
    expect(e.message).toBe("This broadcast could cost about ₹4,300, but only ₹1,200 is left in your WhatsApp limit this month. Send to fewer people or raise the limit.");
    expect(h.db.rows("spendReservation")).toHaveLength(0);
    expect(counter("month").reservedMinor).toBe(0n);
    expect(ledger("messaging.bulk_hold").map((r) => r.phase)).toEqual(["refused"]);
    // Against today's limit the copy says "today".
    const day = await reserveBulk(T, "messaging", 60_000n, { type: "automation_run", id: "r1" }, 86_400_000, opts({ daily: 50_000n, monthly: null })).catch((x) => x);
    expect(day.message).toBe("This broadcast could cost about ₹600, but only ₹500 is left in your WhatsApp limit today. Send to fewer people or raise the limit.");
  });

  it("cannot overdraw when several bulk holds and single messages race", async () => {
    const holds = Array.from({ length: 5 }, (_, i) => reserveBulk(T, "messaging", 300n, { type: "api_batch", id: `api_${i}` }, 60_000, opts({ daily: null, monthly: 1_000n })).then(() => true, () => false));
    const singles = Array.from({ length: 5 }, () => reserveCounter({ tenantId: T, pot: "messaging", amountMinor: 50n, dayLimitMinor: null, monthLimitMinor: 1_000n, keys: KEYS }).then((r) => r.ok));
    await Promise.all([...holds, ...singles]);
    const reserved = counter("month").reservedMinor as bigint;
    expect(reserved <= 1_000n).toBe(true);
    const held = h.db.rows("spendReservation").filter((r) => r.status === "held");
    expect(held.length).toBeLessThanOrEqual(3);
    // Everything that was let through is exactly what is held: no reservation without its counter amount.
    const singlesOk = reserved - 300n * BigInt(held.length);
    expect(singlesOk % 50n).toBe(0n);
  });

  it("a start after the old hold expired (but before the sweep) gives the old hold back and takes a fresh one", async () => {
    const t0 = new Date("2026-10-28T06:00:00Z");
    const first = await reserveBulk(T, "messaging", 700n, { type: "broadcast", id: "b9" }, 60_000, { ...opts({ daily: null, monthly: 1_000n }), at: t0 });
    await consumeReservation(first.reservation!.id, 200n, { now: t0 });
    // 61 s later the hold is past expiresAt but still `held`: a retried start must not reuse it, nor be blocked by it.
    const t1 = new Date(t0.getTime() + 61_000);
    const second = await reserveBulk(T, "messaging", 700n, { type: "broadcast", id: "b9" }, 60_000, { ...opts({ daily: null, monthly: 1_000n }), at: t1 });
    expect(second.created).toBe(true);
    expect(second.reservation!.id).not.toBe(first.reservation!.id);
    const byId = Object.fromEntries(h.db.rows("spendReservation").map((r) => [r.id, r.status]));
    expect(byId).toEqual({ [first.reservation!.id]: "expired", [second.reservation!.id]: "held" });
    // 700 held - 500 unspent given back + 700 new = 900; the 200 consumed stays until its message settles.
    expect(counter("month").reservedMinor).toBe(900n);
    expect(ledger("messaging.bulk_release")).toHaveLength(1);
    expect(ledger("messaging.bulk_release")[0]).toMatchObject({ reasonCodes: ["expired"], amountMinor: 500n });
    // The sweep later finds nothing more to do for it.
    expect((await expireReservations({ now: t1 })).expired).toBe(0);
  });

  it("needs no hold for a free send and validates its inputs", async () => {
    expect(await reserveBulk(T, "messaging", 0n, { type: "broadcast", id: "free" }, 60_000, opts({ daily: null, monthly: 1n }))).toEqual({ reservation: null, created: false, correlationId: null });
    await expect(reserveBulk(T, "messaging", 1n, { type: "ai_call" as never, id: "x" }, 60_000, opts({ daily: null, monthly: null }))).rejects.toThrow(RangeError);
    await expect(reserveBulk(T, "messaging", 1n, { type: "broadcast", id: "x" }, 30 * 86_400_000, opts({ daily: null, monthly: null }))).rejects.toThrow(RangeError);
  });

  it("messages consume the hold lock-free; the unspent part is released on completion", async () => {
    // The hold is made on the test clock (opts().at), so every consume uses that clock too; the real clock would see it expired.
    const at = { now: new Date("2026-10-28T07:00:00Z") };
    const { reservation } = await reserveBulk(T, "messaging", 1_000n, { type: "broadcast", id: "b3" }, 86_400_000, opts({ daily: null, monthly: 10_000n }));
    const id = reservation!.id;
    const consumed = await Promise.all(Array.from({ length: 12 }, () => consumeReservation(id, 100n, at)));
    expect(consumed.filter((c) => c.ok)).toHaveLength(10);
    expect(consumed.find((c) => !c.ok)).toMatchObject({ reason: "exhausted", remaining: 0n });
    expect(h.db.rows("spendReservation")[0].consumedMinor).toBe(1_000n);

    const { reservation: r2 } = await reserveBulk(T, "messaging", 1_000n, { type: "broadcast", id: "b4" }, 86_400_000, opts({ daily: null, monthly: 10_000n }));
    await consumeReservation(r2!.id, 300n, at);
    const before = counter("month").reservedMinor as bigint;
    const released = await releaseUnspent(r2!.id, { actor: owner, reason: "Broadcast finished" });
    expect(released).toEqual({ closed: true, releasedMinor: 700n, status: "settled" });
    expect(counter("month").reservedMinor).toBe(before - 700n);
    expect(await releaseUnspent(r2!.id, { actor: owner, reason: "again" })).toMatchObject({ closed: false, releasedMinor: 0n });
    expect(await consumeReservation(r2!.id, 1n, at)).toMatchObject({ ok: false, reason: "closed" });
    expect(ledger("messaging.bulk_release")).toHaveLength(1);
    expect(await consumeReservation("nope", 1n, at)).toMatchObject({ ok: false, reason: "missing" });
  });
});

describe("AI call reservations and expiry", () => {
  it("settles at the actual credits, releases a failed call, and expires what a crash left held", async () => {
    const now = new Date("2026-10-28T06:00:00Z");
    for (const id of ["call1", "call2", "call3"]) await reserveCounter({ tenantId: T, pot: "ai", amountMinor: 30n, dayLimitMinor: null, monthLimitMinor: 500n, keys: KEYS });
    const r1 = await createCallReservation({ tenantId: T, pot: "ai", currency: "CRD", subjectId: "call1", amountMinor: 30n, keys: KEYS, ttlMs: 120_000, now });
    const r2 = await createCallReservation({ tenantId: T, pot: "ai", currency: "CRD", subjectId: "call2", amountMinor: 30n, keys: KEYS, ttlMs: 120_000, now });
    await createCallReservation({ tenantId: T, pot: "ai", currency: "CRD", subjectId: "call3", amountMinor: 30n, keys: KEYS, ttlMs: 120_000, now });
    expect(counter("month", "ai").reservedMinor).toBe(90n);

    expect(await settleCallReservation(r1.id, 12n, { now })).toMatchObject({ closed: true, status: "settled" });
    expect(counter("month", "ai")).toMatchObject({ reservedMinor: 60n, spentMinor: 12n });
    expect(await releaseCallReservation(r2.id, { now })).toMatchObject({ closed: true, status: "released", releasedMinor: 30n });
    expect(counter("month", "ai").reservedMinor).toBe(30n);

    // call3's process died: nothing happens before expiresAt, then the sweep gives the credits back.
    expect((await expireReservations({ now })).expired).toBe(0);
    const out = await expireReservations({ now: new Date(now.getTime() + 120_001) });
    expect(out).toEqual({ expired: 1, releasedMinor: 30n });
    expect(counter("month", "ai").reservedMinor).toBe(0n);
    expect(h.db.rows("spendReservation").map((r) => r.status).sort()).toEqual(["expired", "released", "settled"]);
    expect(ledger()).toHaveLength(0); // no ledger row per AI call (9.1)
  });

  it("expired bulk holds release their unspent part and are ledgered", async () => {
    const at = new Date("2026-10-28T06:00:00Z");
    const { reservation } = await reserveBulk(T, "messaging", 5_000n, { type: "automation_run", id: "run1" }, 60_000, { currency: "INR", limits: { daily: null, monthly: null }, actor: { type: "system", job: "automation" }, reason: "Sequence run", timezone: "Asia/Kolkata", at });
    await consumeReservation(reservation!.id, 1_000n, { now: at });
    expect(await openReservationFor(T, { type: "automation_run", id: "run1" }, { now: new Date(at.getTime() + 61_000) })).toBeNull();
    expect(await consumeReservation(reservation!.id, 1n, { now: new Date(at.getTime() + 61_000) })).toMatchObject({ ok: false, reason: "expired" });
    const out = await expireReservations({ now: new Date(at.getTime() + 61_000) });
    expect(out).toEqual({ expired: 1, releasedMinor: 4_000n });
    expect(counter("month").reservedMinor).toBe(1_000n);
    const row = ledger("messaging.bulk_release")[0];
    expect(row).toMatchObject({ phase: "info", actorType: "system", reasonCodes: ["expired"] });
    expect(row.reason).toBe("The hold for this send expired, so ₹40 went back to your WhatsApp limit.");
  });
});

// =====================================================================================================================
describe("withSpendLock", () => {
  it("takes the two-key advisory lock with a 3 s lock_timeout in an 8 s transaction", async () => {
    let options: unknown;
    const db: SpendLockClient = { $transaction: (fn, o) => ((options = o), (h.db.prisma as unknown as SpendLockClient).$transaction(fn, o)) };
    const out = await withSpendLock(T, "ads", async () => heldSpendLocks(), { db });
    expect(out).toEqual([{ tenantId: T, pot: "ads" }]);
    expect(options).toEqual({ timeout: 8_000 });
    const sql = h.db.raw.filter((c) => c.kind === "execute").map((c) => [c.sql.replace(/\s+/g, " "), c.values]);
    expect(sql).toEqual([
      ["SET LOCAL lock_timeout = '3s'", []],
      ["SELECT pg_advisory_xact_lock(21328, hashtext($1::text))", [`${T}:ads`]],
    ]);
    expect(heldSpendLocks()).toEqual([]);
  });

  it("turns a lock timeout or a transaction timeout into SpendBusyError (503 spend.busy)", async () => {
    h.db.onRaw((call) => {
      if (call.sql.includes("pg_advisory_xact_lock")) throw Object.assign(new Error("canceling statement due to lock timeout"), { code: "P2010", meta: { code: "55P03" } });
      return undefined;
    });
    const e = await withSpendLock(T, "messaging", async () => "never").catch((x) => x);
    expect(e).toBeInstanceOf(SpendBusyError);
    expect(e).toMatchObject({ status: 503, code: "spend.busy", message: "Busy checking your limits. Try again in a moment." });
    const expired: SpendLockClient = { $transaction: async () => Promise.reject(Object.assign(new Error("Transaction already closed: the timeout for this transaction was 8000 ms"), { code: "P2028" })) };
    await expect(withSpendLock(T, "ads", async () => 1, { db: expired })).rejects.toBeInstanceOf(SpendBusyError);
    expect(isLockTimeoutError({ cause: { originalCode: "55P03" } })).toBe(true);
    expect(isLockTimeoutError(new Error("syntax error"))).toBe(false);
  });

  it("passes other errors through and rolls back", async () => {
    const boom = new Error("not a lock problem");
    await expect(
      withSpendLock(T, "ads", async (tx) => {
        await tx.spendReservation.create({ data: { tenantId: T, pot: "messaging", currency: "INR", subjectType: "broadcast", subjectId: "x", amountMinor: 1n, dayKey: KEYS.day, monthKey: KEYS.month, expiresAt: new Date(), correlationId: "c" } });
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(h.db.rows("spendReservation")).toHaveLength(0);
    expect(h.db.transactions.at(-1)?.status).toBe("rolled_back");
  });

  it("throws when a lock for another pot or workspace is nested (I10); the same pot re-uses the transaction", async () => {
    await expect(withSpendLock(T, "ads", () => withSpendLock(T, "messaging", async () => 1))).rejects.toBeInstanceOf(SpendLockOrderError);
    await expect(withSpendLock(T, "ads", () => withSpendLock("t2", "ads", async () => 1))).rejects.toBeInstanceOf(SpendLockOrderError);
    const before = h.db.transactions.length;
    const same = await withSpendLock(T, "ads", (outer) => withSpendLock(T, "ads", async (inner) => inner === outer));
    expect(same).toBe(true);
    expect(h.db.transactions.length).toBe(before + 1);
    // One after the other is fine, and a continuation that outlives the lock is not "nested".
    let later: Promise<number> | null = null;
    await withSpendLock(T, "ads", async () => {
      later = new Promise((r) => setTimeout(r, 5)).then(() => withSpendLock(T, "messaging", async () => 2));
    });
    await expect(later).resolves.toBe(2);
  });

  it("only warns about nesting in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(withSpendLock(T, "ads", () => withSpendLock(T, "ai", async () => 3))).resolves.toBe(3);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("never held together"));
    warn.mockRestore();
  });
});
