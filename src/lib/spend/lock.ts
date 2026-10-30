/**
 * The spend lock (docs/SPEND-CONTROLS-SPEC.md 4.3, invariants I5 and I10).
 *
 * Every check-then-reserve section for one workspace and one pot runs under
 *   pg_advisory_xact_lock(21328, hashtext(tenantId || ':' || pot))
 * inside a transaction with SET LOCAL lock_timeout = '3s' and an 8 s transaction timeout. That serialises the web process,
 * the worker daemon and /api/internal/tick. The two-key form is its own keyspace, so it can never collide with the existing
 * single-key hashtext() locks. A lock that cannot be taken in time becomes SpendBusyError (HTTP 503, spend.busy), which is safe
 * to retry.
 *
 * Rules the callers keep:
 * - No Meta, WhatsApp or AI request runs while the lock is held (I10). Read what needs a fresh Meta read BEFORE locking.
 * - Lock order: the metacap account lock (21329, account) first, then this lock. Spend locks for different pots are never held
 *   together. In development and tests a nested lock for another pot (or another workspace) in the same async context throws
 *   SpendLockOrderError, so an ordering mistake fails in a test rather than as a production deadlock. In production it is
 *   logged and allowed (Postgres still detects a real deadlock).
 * - The same workspace and pot nested inside an active lock re-uses the outer transaction (a second transaction would wait on
 *   its own lock until lock_timeout).
 * - Lowering never waits for this lock (I2).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { SpendBusyError } from "./errors";
import type { Pot } from "./types";

/** First key of the spend lock. 21329 is the metacap account lock (5.4). */
export const SPEND_LOCK_NAMESPACE = 21328;
export const METACAP_LOCK_NAMESPACE = 21329;
/** SET LOCAL lock_timeout inside the lock transaction. */
export const SPEND_LOCK_TIMEOUT = "3s";
/** Interactive transaction timeout of withSpendLock. */
export const SPEND_LOCK_TX_TIMEOUT_MS = 8_000;
/** The two statements the lock runs, first thing in its transaction ($1 = spendLockKey). Constant text, bound parameter. */
export const SPEND_LOCK_SQL = {
  timeout: `SET LOCAL lock_timeout = '${SPEND_LOCK_TIMEOUT}'`,
  lock: `SELECT pg_advisory_xact_lock(${SPEND_LOCK_NAMESPACE}, hashtext($1::text))`,
} as const;

/** The transaction client the locked section receives. */
export type SpendTx = Prisma.TransactionClient;

/** Anything with Prisma's interactive $transaction (the app client, or a test double). */
export type SpendLockClient = {
  $transaction: <R>(fn: (tx: SpendTx) => Promise<R>, options?: { timeout?: number; maxWait?: number }) => Promise<R>;
};

export type SpendLockOptions = {
  /** Defaults to the app's Prisma client. */
  db?: SpendLockClient;
  /** Overrides the 8 s transaction timeout (tests only). */
  timeoutMs?: number;
};

type Frame = { tenantId: string; pot: Pot; tx: SpendTx; active: boolean };

const held = new AsyncLocalStorage<Frame[]>();

/** A nested spend lock that breaks the fixed lock order (I10). Thrown only outside production. */
export class SpendLockOrderError extends Error {
  readonly code = "spend.lock_order" as const;
  constructor(message: string) {
    super(message);
    this.name = "SpendLockOrderError";
  }
}

/** The text hashed into the second key: "<tenantId>:<pot>". */
export function spendLockKey(tenantId: string, pot: Pot): string {
  return `${tenantId}:${pot}`;
}

/** The spend locks the current async context holds, outermost first. */
export function heldSpendLocks(): { tenantId: string; pot: Pot }[] {
  return (held.getStore() ?? []).filter((f) => f.active).map(({ tenantId, pot }) => ({ tenantId, pot }));
}

/** Order mistakes throw everywhere except production. */
function strictLockOrder(): boolean {
  return (process.env.NODE_ENV ?? "").trim() !== "production";
}

/** Every SQLSTATE or Prisma code an error carries, looking through Prisma's meta and the driver adapter's cause. */
function errorCodes(error: unknown, depth = 0, out: string[] = []): string[] {
  if (!error || typeof error !== "object" || depth > 5) return out;
  const e = error as Record<string, unknown>;
  for (const key of ["code", "originalCode", "sqlState", "sqlstate"]) {
    const v = e[key];
    if (typeof v === "string") out.push(v);
  }
  for (const key of ["meta", "cause", "driverAdapterError", "error"]) errorCodes(e[key], depth + 1, out);
  return out;
}

function errorText(error: unknown, depth = 0): string {
  if (!error || typeof error !== "object" || depth > 5) return "";
  const e = error as Record<string, unknown>;
  const own = typeof e.message === "string" ? e.message : "";
  return `${own} ${errorText(e.meta, depth + 1)} ${errorText(e.cause, depth + 1)}`;
}

/** True for Postgres 55P03 (lock_not_available), which SET LOCAL lock_timeout raises when the advisory lock is not granted. */
export function isLockTimeoutError(error: unknown): boolean {
  if (errorCodes(error).includes("55P03")) return true;
  return /lock timeout|could not obtain lock|lock_not_available/i.test(errorText(error));
}

/** True for Prisma's interactive-transaction timeout (P2028: expired, closed, or not started in time). */
export function isTransactionTimeoutError(error: unknown): boolean {
  if (errorCodes(error).includes("P2028")) return true;
  return /transaction (already closed|api error).*(expired|timeout|timed out)|expired transaction|unable to start a transaction in the given time/i.test(errorText(error));
}

/**
 * Runs `fn` inside one transaction that holds the spend lock for (tenantId, pot). Throws SpendBusyError when the lock is not
 * granted within 3 s or the transaction runs past 8 s; any other error from `fn` propagates unchanged and rolls back.
 */
export async function withSpendLock<T>(tenantId: string, pot: Pot, fn: (tx: SpendTx) => Promise<T>, opts: SpendLockOptions = {}): Promise<T> {
  if (!tenantId) throw new RangeError("withSpendLock needs a workspace.");
  const frames = (held.getStore() ?? []).filter((f) => f.active);
  const same = frames.find((f) => f.tenantId === tenantId && f.pot === pot);
  if (same) return fn(same.tx);
  if (frames.length > 0) {
    const outer = frames[frames.length - 1];
    const message = `[spend] withSpendLock(${spendLockKey(tenantId, pot)}) inside withSpendLock(${spendLockKey(outer.tenantId, outer.pot)}): spend locks for different pots or workspaces are never held together (I10).`;
    if (strictLockOrder()) throw new SpendLockOrderError(message);
    console.warn(message);
  }
  const client = opts.db ?? (prisma as unknown as SpendLockClient);
  const key = spendLockKey(tenantId, pot);
  try {
    return await client.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(SPEND_LOCK_SQL.timeout);
        await tx.$executeRawUnsafe(SPEND_LOCK_SQL.lock, key);
        const frame: Frame = { tenantId, pot, tx, active: true };
        try {
          return await held.run([...frames, frame], () => fn(tx));
        } finally {
          frame.active = false;
        }
      },
      { timeout: opts.timeoutMs ?? SPEND_LOCK_TX_TIMEOUT_MS },
    );
  } catch (error) {
    if (error instanceof SpendBusyError) throw error;
    if (isLockTimeoutError(error) || isTransactionTimeoutError(error)) throw new SpendBusyError();
    throw error;
  }
}
