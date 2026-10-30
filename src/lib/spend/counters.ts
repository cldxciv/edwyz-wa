/**
 * Lock-free per-message and per-AI-call counters (SpendCounter, docs/SPEND-CONTROLS-SPEC.md 4.9, 4.10, invariant I5).
 *
 * One row per (workspace, pot, day|month, key) in the WORKSPACE time zone (SpendControl.timezone). The rows are upserted
 * first, then one statement makes the conditional reservation on both rows:
 *
 *   WITH d AS (UPDATE ... WHERE day row AND ($dayLimit IS NULL OR spent + reserved + $c <= $dayLimit) RETURNING ...),
 *        m AS (UPDATE ... WHERE month row AND ($monthLimit IS NULL OR spent + reserved + $c <= $monthLimit) RETURNING ...)
 *   SELECT (SELECT count(*) FROM d) AS d, (SELECT count(*) FROM m) AS m
 *
 * Each UPDATE re-checks its own row after any row-lock wait, so parallel callers can never overdraw. When either update
 * matched no row, the transaction is rolled back, which undoes the other. No advisory lock is needed.
 *
 * Origins that are never blocked by cost (human, approval, consent, system_notify, eddy) use the SAME statement with no limit
 * (null limits), so their cost is always counted; `overLimit` then says the counter went past the limit ("over_limit").
 * Settle moves an estimate from reserved to spent at the actual cost; release gives a reservation back. Both clamp at 0, so a
 * double release can never break the non-negative CHECK.
 *
 * The statements are exported as text with $n placeholders so the two-process database test runs exactly this SQL.
 */
import { prisma } from "@/lib/db";
import { getControl, type SpendDb } from "./control";
import { CRD } from "./money";
import { dayKey, monthKey } from "./periods";

export type CounterPot = "messaging" | "ai";
export type CounterKeys = { day: string; month: string };
export type CounterPeriod = "day" | "month";

/** The day and month keys of an instant in the workspace's zone. */
export function counterKeys(at: Date, timezone: string): CounterKeys {
  return { day: dayKey(at, timezone), month: monthKey(at, timezone) };
}

/** Keys from what the caller knows: explicit keys, else a zone, else the workspace's SpendControl.timezone. */
export async function resolveCounterKeys(tenantId: string, input: { keys?: CounterKeys; timezone?: string; at?: Date }, db: SpendDb = prisma): Promise<CounterKeys> {
  if (input.keys) return input.keys;
  const tz = input.timezone ?? (await getControl(tenantId, { db, prune: false })).timezone;
  return counterKeys(input.at ?? new Date(), tz);
}

export const potCurrencyDefault = (pot: CounterPot): string => (pot === "ai" ? CRD : "INR");

type Statement = { text: string; values: unknown[] };

/**
 * The conditional reservation of 4.9 on the day and month rows. With both limits null it is the unconditional variant.
 * Values: $1 tenant, $2 pot, $3 day key, $4 month key, $5 amount, $6 day limit, $7 month limit.
 */
export function reserveStatement(tenantId: string, pot: CounterPot, keys: CounterKeys, amountMinor: bigint, dayLimitMinor: bigint | null, monthLimitMinor: bigint | null): Statement {
  const text = `/* spend.counter.reserve */
WITH d AS (
  UPDATE "SpendCounter" SET "reservedMinor" = "reservedMinor" + $5::bigint, "updatedAt" = now()
  WHERE "tenantId" = $1 AND "pot" = $2 AND "periodKind" = 'day' AND "periodKey" = $3
    AND ($6::bigint IS NULL OR "spentMinor" + "reservedMinor" + $5::bigint <= $6::bigint)
  RETURNING ("spentMinor" + "reservedMinor") AS total),
m AS (
  UPDATE "SpendCounter" SET "reservedMinor" = "reservedMinor" + $5::bigint, "updatedAt" = now()
  WHERE "tenantId" = $1 AND "pot" = $2 AND "periodKind" = 'month' AND "periodKey" = $4
    AND ($7::bigint IS NULL OR "spentMinor" + "reservedMinor" + $5::bigint <= $7::bigint)
  RETURNING ("spentMinor" + "reservedMinor") AS total)
SELECT (SELECT count(*) FROM d)::int AS d, (SELECT count(*) FROM m)::int AS m,
       (SELECT max(total) FROM d)::text AS "dayTotal", (SELECT max(total) FROM m)::text AS "monthTotal"`;
  return { text, values: [tenantId, pot, keys.day, keys.month, amountMinor, dayLimitMinor, monthLimitMinor] };
}

/**
 * Moves an amount out of reserved and adds the actual cost to spent, on both rows, clamped at 0. Release is settle with an
 * actual of 0; a spent correction (settlement delta) is settle with nothing to release.
 * Values: $1 tenant, $2 pot, $3 day key, $4 month key, $5 release from reserved, $6 add to spent (may be negative).
 */
export function settleStatement(tenantId: string, pot: CounterPot, keys: CounterKeys, releaseMinor: bigint, spentDeltaMinor: bigint): Statement {
  const text = `/* spend.counter.settle */
UPDATE "SpendCounter"
SET "reservedMinor" = GREATEST("reservedMinor" - $5::bigint, 0),
    "spentMinor" = GREATEST("spentMinor" + $6::bigint, 0),
    "updatedAt" = now()
WHERE "tenantId" = $1 AND "pot" = $2
  AND (("periodKind" = 'day' AND "periodKey" = $3) OR ("periodKind" = 'month' AND "periodKey" = $4))`;
  return { text, values: [tenantId, pot, keys.day, keys.month, releaseMinor, spentDeltaMinor] };
}

/**
 * Takes a reservation back off ONE period row (day or month), clamped at 0. Used only to undo the half of a conditional
 * reservation that matched when the other half did not and there is no transaction of our own to roll back (the caller
 * passed its transaction client): the row is already locked by our own UPDATE, so this exactly reverses it.
 * Values: $1 tenant, $2 pot, $3 period kind, $4 period key, $5 amount.
 */
export function unreservePeriodStatement(tenantId: string, pot: CounterPot, kind: CounterPeriod, key: string, amountMinor: bigint): Statement {
  const text = `/* spend.counter.unreserve */
UPDATE "SpendCounter" SET "reservedMinor" = GREATEST("reservedMinor" - $5::bigint, 0), "updatedAt" = now()
WHERE "tenantId" = $1 AND "pot" = $2 AND "periodKind" = $3 AND "periodKey" = $4`;
  return { text, values: [tenantId, pot, kind, key, amountMinor] };
}

/** The INSERT ... ON CONFLICT DO NOTHING that makes sure both rows exist. Values: $1 tenant, $2 pot, $3 day, $4 month, $5 currency. */
export function ensureRowsStatement(tenantId: string, pot: CounterPot, keys: CounterKeys, currency: string): Statement {
  const text = `/* spend.counter.ensure */
INSERT INTO "SpendCounter" ("tenantId","pot","periodKind","periodKey","currency","reservedMinor","spentMinor","updatedAt")
VALUES ($1, $2, 'day', $3, $5, 0, 0, now()), ($1, $2, 'month', $4, $5, 0, 0, now())
ON CONFLICT ("tenantId","pot","periodKind","periodKey") DO NOTHING`;
  return { text, values: [tenantId, pot, keys.day, keys.month, currency] };
}

type RawClient = Pick<SpendDb, "$queryRawUnsafe" | "$executeRawUnsafe" | "spendCounter">;
type TxClient = RawClient & { $transaction?: <R>(fn: (tx: RawClient) => Promise<R>) => Promise<R> };

/** Creates the day and month rows when they are missing (counter rows are upserted first, 4.9). */
export async function ensureCounterRows(tenantId: string, pot: CounterPot, keys: CounterKeys, currency: string, db: RawClient = prisma): Promise<void> {
  await db.spendCounter.createMany({
    data: [
      { tenantId, pot, periodKind: "day", periodKey: keys.day, currency },
      { tenantId, pot, periodKind: "month", periodKey: keys.month, currency },
    ],
    skipDuplicates: true,
  });
}

/** Deadlock or serialization failure (40P01, 40001), looking through Prisma's meta and the driver adapter's cause. */
function isRetryableConflict(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== "object" || depth > 5) return false;
  const e = error as Record<string, unknown>;
  for (const key of ["code", "originalCode", "sqlState"]) if (e[key] === "40P01" || e[key] === "40001") return true;
  return ["meta", "cause", "driverAdapterError"].some((key) => isRetryableConflict(e[key], depth + 1));
}

type ReserveRow = { d: number | bigint; m: number | bigint; dayTotal: string | null; monthTotal: string | null };
const toBig = (v: string | null | undefined): bigint | null => (v === null || v === undefined ? null : BigInt(v));

class RollbackSignal extends Error {
  constructor(readonly row: ReserveRow) {
    super("rollback");
  }
}

export type CounterReserveInput = {
  tenantId: string;
  pot: CounterPot;
  amountMinor: bigint;
  /** Effective limits of the pot (allowances.ts); null = not limited for this period. */
  dayLimitMinor: bigint | null;
  monthLimitMinor: bigint | null;
  currency?: string;
  keys?: CounterKeys;
  timezone?: string;
  at?: Date;
};

export type CounterReserveResult =
  | { ok: true; keys: CounterKeys; dayTotal: bigint | null; monthTotal: bigint | null }
  | { ok: false; keys: CounterKeys; exhausted: "day" | "month" | "both" };

/**
 * The lock-free conditional reservation (4.9 step 4, 4.10 step 2). Never overdraws: both rows fit or neither changes.
 * An amount of 0 (a free message) always fits and touches nothing.
 *
 * On the app client the two updates run in their own transaction, so a partial match rolls back. Given a caller's
 * transaction client (no $transaction), there is nothing of ours to roll back, so the half that matched is reversed with
 * unreservePeriodStatement before answering "refused": the caller's transaction never commits half a reservation.
 */
export async function reserveCounter(input: CounterReserveInput, db: TxClient = prisma as unknown as TxClient): Promise<CounterReserveResult> {
  if (input.amountMinor < 0n) throw new RangeError("A reservation cannot be negative.");
  const keys = await resolveCounterKeys(input.tenantId, input, db as unknown as SpendDb);
  if (input.amountMinor === 0n) return { ok: true, keys, dayTotal: null, monthTotal: null };
  const currency = input.currency ?? potCurrencyDefault(input.pot);
  const stmt = reserveStatement(input.tenantId, input.pot, keys, input.amountMinor, input.dayLimitMinor, input.monthLimitMinor);
  const ownTransaction = typeof db.$transaction === "function";
  for (let attempt = 1; ; attempt++) {
    try {
      const run = async (tx: RawClient): Promise<ReserveRow> => {
        await ensureCounterRows(input.tenantId, input.pot, keys, currency, tx);
        const rows = (await tx.$queryRawUnsafe(stmt.text, ...stmt.values)) as ReserveRow[];
        const row = rows?.[0] ?? { d: 0, m: 0, dayTotal: null, monthTotal: null };
        const d = Number(row.d) === 1;
        const m = Number(row.m) === 1;
        if (!d || !m) {
          if (!ownTransaction && (d || m)) {
            const undo = unreservePeriodStatement(input.tenantId, input.pot, d ? "day" : "month", d ? keys.day : keys.month, input.amountMinor);
            await tx.$executeRawUnsafe(undo.text, ...undo.values);
          }
          throw new RollbackSignal(row);
        }
        return row;
      };
      const row = ownTransaction ? await db.$transaction!(run) : await run(db);
      return { ok: true, keys, dayTotal: toBig(row.dayTotal), monthTotal: toBig(row.monthTotal) };
    } catch (error) {
      if (error instanceof RollbackSignal) {
        const d = Number(error.row.d) === 1;
        const m = Number(error.row.m) === 1;
        return { ok: false, keys, exhausted: !d && !m ? "both" : !d ? "day" : "month" };
      }
      if (attempt < 3 && isRetryableConflict(error)) continue;
      throw error;
    }
  }
}

export type UnconditionalResult = { keys: CounterKeys; dayTotal: bigint | null; monthTotal: bigint | null; overLimit: boolean; overLimitPeriods: CounterPeriod[] };

/**
 * The never-blocked origins (human, approval, consent, system_notify, eddy): the same statement without limit conditions, so
 * the cost is always counted. `overLimit` is true when this increment took a period past its limit (flagged over_limit).
 */
export async function reserveCounterUnconditional(
  input: Omit<CounterReserveInput, "dayLimitMinor" | "monthLimitMinor"> & { dayLimitMinor?: bigint | null; monthLimitMinor?: bigint | null },
  db: RawClient = prisma,
): Promise<UnconditionalResult> {
  if (input.amountMinor < 0n) throw new RangeError("A reservation cannot be negative.");
  const keys = await resolveCounterKeys(input.tenantId, input, db as unknown as SpendDb);
  if (input.amountMinor === 0n) return { keys, dayTotal: null, monthTotal: null, overLimit: false, overLimitPeriods: [] };
  await ensureCounterRows(input.tenantId, input.pot, keys, input.currency ?? potCurrencyDefault(input.pot), db);
  const stmt = reserveStatement(input.tenantId, input.pot, keys, input.amountMinor, null, null);
  const rows = (await db.$queryRawUnsafe(stmt.text, ...stmt.values)) as ReserveRow[];
  const dayTotal = toBig(rows?.[0]?.dayTotal);
  const monthTotal = toBig(rows?.[0]?.monthTotal);
  const over: CounterPeriod[] = [];
  if (input.dayLimitMinor != null && dayTotal !== null && dayTotal > input.dayLimitMinor) over.push("day");
  if (input.monthLimitMinor != null && monthTotal !== null && monthTotal > input.monthLimitMinor) over.push("month");
  return { keys, dayTotal, monthTotal, overLimit: over.length > 0, overLimitPeriods: over };
}

export type CounterMove = { tenantId: string; pot: CounterPot; keys: CounterKeys };

/** After a send or an AI call: reserved minus the estimate, spent plus the actual cost (the estimate when unknown). */
export async function settleCounter(input: CounterMove & { reservedMinor: bigint; actualMinor: bigint }, db: RawClient = prisma): Promise<number> {
  if (input.reservedMinor < 0n || input.actualMinor < 0n) throw new RangeError("Settlement amounts cannot be negative.");
  const stmt = settleStatement(input.tenantId, input.pot, input.keys, input.reservedMinor, input.actualMinor);
  return Number(await db.$executeRawUnsafe(stmt.text, ...stmt.values));
}

/** A failed send or call, or the unspent part of a hold: gives the amount back to reserved (never below 0). */
export async function releaseCounter(input: CounterMove & { amountMinor: bigint }, db: RawClient = prisma): Promise<number> {
  if (input.amountMinor < 0n) throw new RangeError("A release cannot be negative.");
  if (input.amountMinor === 0n) return 0;
  const stmt = settleStatement(input.tenantId, input.pot, input.keys, input.amountMinor, 0n);
  return Number(await db.$executeRawUnsafe(stmt.text, ...stmt.values));
}

/** A pricing correction on the message's OWN day and month (4.9 settlement): adds a delta to spent, clamped at 0. */
export async function adjustSpent(input: CounterMove & { deltaMinor: bigint }, db: RawClient = prisma): Promise<number> {
  if (input.deltaMinor === 0n) return 0;
  const stmt = settleStatement(input.tenantId, input.pot, input.keys, 0n, input.deltaMinor);
  return Number(await db.$executeRawUnsafe(stmt.text, ...stmt.values));
}

export type CounterFigures = { spent: bigint; reserved: bigint; used: bigint };

/** Spent and reserved for the day and month keys (0 when a row does not exist yet). */
export async function readCounters(tenantId: string, pot: CounterPot, keys: CounterKeys, db: Pick<SpendDb, "spendCounter"> = prisma): Promise<{ day: CounterFigures; month: CounterFigures }> {
  const rows = ((await db.spendCounter.findMany({
    where: { tenantId, pot, OR: [{ periodKind: "day", periodKey: keys.day }, { periodKind: "month", periodKey: keys.month }] },
  })) ?? []) as { periodKind: string; periodKey: string; spentMinor: bigint; reservedMinor: bigint }[];
  const figures = (kind: CounterPeriod, key: string): CounterFigures => {
    const r = rows.find((x) => x.periodKind === kind && x.periodKey === key);
    const spent = BigInt(r?.spentMinor ?? 0n);
    const reserved = BigInt(r?.reservedMinor ?? 0n);
    return { spent, reserved, used: spent + reserved };
  };
  return { day: figures("day", keys.day), month: figures("month", keys.month) };
}
