/**
 * Bulk messaging holds and in-flight AI calls (SpendReservation, docs/SPEND-CONTROLS-SPEC.md 4.9, 4.10, 4.16).
 *
 * reserveBulk() runs under withSpendLock(tenant, pot): it inserts a `held` SpendReservation (one open hold per subject, by
 * the 0009 partial unique index) and adds the whole estimate to the day and month counters' reservedMinor with the same
 * conditional statement as a single message, so a hold can never overdraw either, even against lock-free per-message
 * reservations running at the same time. A hold counts in full against the day it starts (conservative). When it does not
 * fit it is refused with 409 spend.broadcast and the numbers ("could cost about ₹4,300, but only ₹1,200 is left"). The
 * limits are passed in by the caller (allowances.ts effectiveLimits), so this module never decides them.
 *
 * Messages of the broadcast consume from the hold without any lock (one conditional UPDATE, like the counters). The unspent
 * part is released on completion or cancel, never waiting for a lock (lowering, I2). Holds past expiresAt are released by
 * expireReservations(); until then they stay counted, which is the safe direction (4.16 lazy expiry).
 */
import { prisma } from "@/lib/db";
import { getControl, type SpendDb } from "./control";
import { counterKeys, readCounters, releaseCounter, reserveStatement, ensureCounterRows, settleCounter, type CounterKeys, type CounterPot } from "./counters";
import { SpendBlockedError } from "./errors";
import { appendOutcome, appendRequest, appendStandalone, newCorrelationId, type LedgerDb } from "./ledger";
import { withSpendLock, type SpendLockClient } from "./lock";
import { formatMinor, maxBig } from "./money";
import type { BulkSubjectType, ReservationSubjectType, SpendActor } from "./types";

export type ReservationStatus = "held" | "settled" | "released" | "expired";

export type ReservationRow = {
  id: string;
  tenantId: string;
  pot: CounterPot;
  currency: string;
  subjectType: ReservationSubjectType;
  subjectId: string;
  amountMinor: bigint;
  consumedMinor: bigint;
  status: ReservationStatus;
  dayKey: string;
  monthKey: string;
  expiresAt: Date;
  correlationId: string;
  createdAt: Date | null;
  closedAt: Date | null;
};

const big = (v: unknown): bigint => (typeof v === "bigint" ? v : BigInt((v as number | string | null | undefined) ?? 0));

export function toReservationRow(raw: Record<string, unknown>): ReservationRow {
  return {
    id: String(raw.id),
    tenantId: String(raw.tenantId),
    pot: raw.pot as CounterPot,
    currency: String(raw.currency),
    subjectType: raw.subjectType as ReservationSubjectType,
    subjectId: String(raw.subjectId),
    amountMinor: big(raw.amountMinor),
    consumedMinor: big(raw.consumedMinor),
    status: raw.status as ReservationStatus,
    dayKey: String(raw.dayKey),
    monthKey: String(raw.monthKey),
    expiresAt: raw.expiresAt instanceof Date ? raw.expiresAt : new Date(String(raw.expiresAt)),
    correlationId: String(raw.correlationId),
    createdAt: raw.createdAt instanceof Date ? raw.createdAt : null,
    closedAt: raw.closedAt instanceof Date ? raw.closedAt : null,
  };
}

const keysOf = (r: Pick<ReservationRow, "dayKey" | "monthKey">): CounterKeys => ({ day: r.dayKey, month: r.monthKey });
const BULK_TYPES: readonly BulkSubjectType[] = ["broadcast", "automation_run", "api_batch"];
/** A bulk hold never lives longer than this (a scheduled broadcast's 7 days, plus slack). */
const MAX_TTL_MS = 8 * 86_400_000;

export type BulkLimits = { daily: bigint | null; monthly: bigint | null };

export type ReserveBulkOptions = {
  currency: string;
  /** The pot's effective limits from effectiveLimits(); null = not limited for that period. */
  limits: BulkLimits;
  actor: SpendActor;
  reason: string;
  /** Defaults to the workspace's SpendControl.timezone. */
  timezone?: string;
  at?: Date;
  /** Ledger idempotency key of the hold's request row; unique per hold (a retried start of the same subject reuses the open hold anyway). */
  idempotencyKey?: string;
  db?: SpendLockClient;
};

export type ReserveBulkResult = { reservation: ReservationRow | null; created: boolean; correlationId: string | null };

class BulkRefusal {
  constructor(readonly error: SpendBlockedError, readonly snapshot: Record<string, unknown>) {}
}

/**
 * Holds a bulk send's conservative estimate (4.9): broadcasts (ttl 7 days), automation runs, API batches. Returns the existing
 * hold when the subject already has one (a retried start). An estimate of 0 (only free entry points) needs no hold.
 */
export async function reserveBulk(
  tenantId: string,
  pot: "messaging",
  estimateMinor: bigint,
  subject: { type: BulkSubjectType; id: string },
  ttlMs: number,
  opts: ReserveBulkOptions,
): Promise<ReserveBulkResult> {
  if (pot !== "messaging") throw new RangeError("Bulk holds are for WhatsApp messages.");
  if (!BULK_TYPES.includes(subject?.type) || !subject.id) throw new RangeError("A bulk hold needs a broadcast, automation run or API batch.");
  if (typeof estimateMinor !== "bigint" || estimateMinor < 0n) throw new RangeError("The estimate must be zero or more.");
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > MAX_TTL_MS) throw new RangeError("A bulk hold lasts between a moment and 8 days.");
  if (estimateMinor === 0n) return { reservation: null, created: false, correlationId: null };
  const at = opts.at ?? new Date();
  const currency = opts.currency.toUpperCase();
  try {
    const out = await withSpendLock(
      tenantId,
      pot,
      async (tx) => {
        const open = (await tx.spendReservation.findFirst({ where: { tenantId, subjectType: subject.type, subjectId: subject.id, status: "held" } })) as Record<string, unknown> | null;
        if (open) {
          const existing = toReservationRow(open);
          if (existing.expiresAt.getTime() > at.getTime()) return { reservation: existing, created: false, correlationId: existing.correlationId };
          // Past expiresAt but not swept yet (4.16 lazy expiry): give its unspent part back and take a fresh hold below.
          const closed = await closeHeld(existing.id, "expired", tx, at);
          if (closed.closed) await ledgerExpiry(existing, closed.releasedMinor, tx as unknown as LedgerDb, true);
        }
        const tz = opts.timezone ?? (await getControl(tenantId, { db: tx, prune: false })).timezone;
        const keys = counterKeys(at, tz);
        await ensureCounterRows(tenantId, pot, keys, currency, tx);
        // Read first, for the refusal copy; the conditional statement below is what decides.
        const before = await readCounters(tenantId, pot, keys, tx);
        const correlationId = newCorrelationId();
        const created = (await tx.spendReservation.create({
          data: {
            tenantId,
            pot,
            currency,
            subjectType: subject.type,
            subjectId: subject.id,
            amountMinor: estimateMinor,
            dayKey: keys.day,
            monthKey: keys.month,
            expiresAt: new Date(at.getTime() + ttlMs),
            correlationId,
          },
        })) as Record<string, unknown>;
        const reservation = toReservationRow(created);
        await appendRequest(tx as unknown as LedgerDb, {
          tenantId,
          pot,
          action: "messaging.bulk_hold",
          actor: opts.actor,
          reason: opts.reason,
          targetType: subject.type,
          targetId: subject.id,
          currency,
          amountMinor: estimateMinor,
          forecastTodayMinor: estimateMinor,
          forecastMonthMinor: estimateMinor,
          snapshot: { limits: opts.limits, day: before.day, month: before.month, keys },
          undo: { action: "release_hold", reservationId: reservation.id },
          correlationId,
          idempotencyKey: opts.idempotencyKey ?? null,
        });
        const stmt = reserveStatement(tenantId, pot, keys, estimateMinor, opts.limits.daily, opts.limits.monthly);
        const rows = (await tx.$queryRawUnsafe(stmt.text, ...stmt.values)) as { d: number; m: number }[];
        const d = Number(rows?.[0]?.d ?? 0) === 1;
        const m = Number(rows?.[0]?.m ?? 0) === 1;
        if (!d || !m) {
          // The month is what the copy names first; a broadcast that fits the month but not today says "today" (4.9).
          const period: "month" | "day" = !m ? "month" : "day";
          const limit = period === "month" ? opts.limits.monthly : opts.limits.daily;
          const used = period === "month" ? before.month.used : before.day.used;
          const left = limit === null ? 0n : maxBig(0n, limit - used);
          throw new BulkRefusal(new SpendBlockedError("spend.broadcast", { cost: { minor: estimateMinor, currency }, left: { minor: left, currency }, period }), {
            period,
            limit,
            used,
            keys,
          });
        }
        return { reservation, created: true, correlationId };
      },
      { db: opts.db },
    );
    if (out.created && out.correlationId) {
      await appendOutcome(out.correlationId, {
        tenantId,
        pot,
        action: "messaging.bulk_hold",
        phase: "applied",
        actor: opts.actor,
        reason: opts.reason,
        targetType: subject.type,
        targetId: subject.id,
        currency,
        amountMinor: estimateMinor,
      });
    }
    return out;
  } catch (error) {
    if (!(error instanceof BulkRefusal)) throw error;
    await appendStandalone({
      tenantId,
      pot,
      action: "messaging.bulk_hold",
      phase: "refused",
      actor: opts.actor,
      reason: error.error.message,
      reasonCodes: [error.error.code],
      targetType: subject.type,
      targetId: subject.id,
      currency,
      amountMinor: estimateMinor,
      forecastTodayMinor: estimateMinor,
      forecastMonthMinor: estimateMinor,
      snapshot: error.snapshot,
    });
    throw error.error;
  }
}

export type ConsumeResult = { ok: true; remaining: bigint } | { ok: false; reason: "missing" | "closed" | "expired" | "exhausted" | "contended"; remaining: bigint };

const RETURNING = `RETURNING "id","tenantId","pot","currency","subjectType","subjectId","amountMinor"::text AS "amountMinor",
  "consumedMinor"::text AS "consumedMinor","status","dayKey","monthKey","expiresAt","correlationId","createdAt","closedAt"`;

/**
 * Takes `amount` from a held, unexpired hold in one conditional UPDATE (no lock, no retry), like the counters.
 * Values: $1 id, $2 amount, $3 now.
 */
export function consumeStatement(reservationId: string, amountMinor: bigint, now: Date): { text: string; values: unknown[] } {
  const text = `/* spend.reservation.consume */
UPDATE "SpendReservation" SET "consumedMinor" = "consumedMinor" + $2::bigint
WHERE "id" = $1 AND "status" = 'held' AND "expiresAt" > $3 AND "consumedMinor" + $2::bigint <= "amountMinor"
${RETURNING}`;
  return { text, values: [reservationId, amountMinor, now] };
}

/**
 * Closes a held hold in one conditional UPDATE, so a message consuming at the same moment either lands first (and is
 * counted as consumed) or is refused (the hold is no longer held). `released` with something consumed becomes `settled`.
 * With `settleActualMinor` (an AI call) consumedMinor becomes the actual usage. Values: $1 id, $2 status, $3 now, $4 actual.
 */
export function closeStatement(reservationId: string, status: "settled" | "released" | "expired", now: Date, settleActualMinor: bigint | null): { text: string; values: unknown[] } {
  const text = `/* spend.reservation.close */
UPDATE "SpendReservation"
SET "status" = CASE WHEN $2::text = 'released' AND "consumedMinor" > 0 THEN 'settled' ELSE $2::text END,
    "closedAt" = $3,
    "consumedMinor" = COALESCE($4::bigint, "consumedMinor")
WHERE "id" = $1 AND "status" = 'held'
${RETURNING}`;
  return { text, values: [reservationId, status, now, settleActualMinor] };
}

/**
 * One message of a bulk send takes its estimate from the hold, lock-free (one conditional UPDATE). When the hold is used up,
 * closed or expired, the caller falls back to the per-message conditional reservation; nothing is sent unheld.
 */
export async function consumeReservation(reservationId: string, amountMinor: bigint, opts: { db?: SpendDb; now?: Date } = {}): Promise<ConsumeResult> {
  if (amountMinor < 0n) throw new RangeError("A message cannot consume a negative amount.");
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  if (amountMinor > 0n) {
    const stmt = consumeStatement(reservationId, amountMinor, now);
    const rows = ((await db.$queryRawUnsafe(stmt.text, ...stmt.values)) ?? []) as Record<string, unknown>[];
    if (rows.length === 1) {
      const r = toReservationRow(rows[0]);
      return { ok: true, remaining: r.amountMinor - r.consumedMinor };
    }
  }
  // Nothing taken (or nothing asked): say why.
  const raw = (await db.spendReservation.findUnique({ where: { id: reservationId } })) as Record<string, unknown> | null;
  if (!raw) return { ok: false, reason: "missing", remaining: 0n };
  const r = toReservationRow(raw);
  const remaining = r.amountMinor - r.consumedMinor;
  if (r.status !== "held") return { ok: false, reason: "closed", remaining };
  if (r.expiresAt.getTime() <= now.getTime()) return { ok: false, reason: "expired", remaining };
  if (amountMinor === 0n) return { ok: true, remaining };
  return { ok: false, reason: amountMinor > remaining ? "exhausted" : "contended", remaining };
}

export type CloseResult = { closed: boolean; releasedMinor: bigint; status: ReservationStatus | null };

/** Closes a held row and gives `amount - consumed` (or, for an AI call, the whole hold) back to the counters. */
async function closeHeld(
  reservationId: string,
  status: "settled" | "released" | "expired",
  db: SpendDb,
  now: Date,
  settleActualMinor: bigint | null = null,
): Promise<{ row: ReservationRow | null; releasedMinor: bigint; closed: boolean }> {
  const stmt = closeStatement(reservationId, status, now, settleActualMinor);
  const rows = ((await db.$queryRawUnsafe(stmt.text, ...stmt.values)) ?? []) as Record<string, unknown>[];
  if (rows.length !== 1) {
    const raw = (await db.spendReservation.findUnique({ where: { id: reservationId } })) as Record<string, unknown> | null;
    return { row: raw ? toReservationRow(raw) : null, releasedMinor: 0n, closed: false };
  }
  const r = toReservationRow(rows[0]);
  const keys = keysOf(r);
  if (settleActualMinor !== null) {
    // An AI call: its whole hold leaves reserved and the actual credits are spent.
    await settleCounter({ tenantId: r.tenantId, pot: r.pot, keys, reservedMinor: r.amountMinor, actualMinor: settleActualMinor }, db);
    return { row: r, releasedMinor: r.amountMinor, closed: true };
  }
  // Consumed messages settle on their own; only the unspent part goes back.
  const unspent = maxBig(0n, r.amountMinor - r.consumedMinor);
  await releaseCounter({ tenantId: r.tenantId, pot: r.pot, keys, amountMinor: unspent }, db);
  return { row: r, releasedMinor: unspent, closed: true };
}

/**
 * A bulk send finished or was cancelled: the unspent part of its hold goes back (4.9, broadcasts/process.ts). A lowering, so
 * it takes no lock and is never refused. Ledgered as messaging.bulk_release.
 */
export async function releaseUnspent(reservationId: string, opts: { actor: SpendActor; reason: string; db?: SpendDb; now?: Date }): Promise<CloseResult> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const out = await closeHeld(reservationId, "released", db, now);
  if (out.closed && out.row && out.row.subjectType !== "ai_call") {
    await appendStandalone(
      {
        tenantId: out.row.tenantId,
        pot: out.row.pot,
        action: "messaging.bulk_release",
        phase: "info",
        actor: opts.actor,
        reason: opts.reason,
        targetType: out.row.subjectType,
        targetId: out.row.subjectId,
        currency: out.row.currency,
        amountMinor: out.releasedMinor,
        before: { amountMinor: out.row.amountMinor, consumedMinor: out.row.consumedMinor },
        correlationId: out.row.correlationId,
        idempotencyKey: `bulk_release:${reservationId}`,
      },
      { db: db as unknown as LedgerDb },
    );
  }
  return { closed: out.closed, releasedMinor: out.releasedMinor, status: out.row?.status ?? null };
}

export type CallReservationInput = {
  tenantId: string;
  pot: CounterPot;
  currency: string;
  subjectId: string;
  amountMinor: bigint;
  keys: CounterKeys;
  ttlMs: number;
  correlationId?: string;
  now?: Date;
};

/**
 * The crash-recovery row of an in-flight AI call (4.10 step 2): written right after the lock-free counter reservation
 * (reserveCounter), so expireReservations() gives the credits back if the process dies before settling.
 */
export async function createCallReservation(input: CallReservationInput, db: SpendDb = prisma): Promise<ReservationRow> {
  if (input.amountMinor <= 0n) throw new RangeError("A call reservation must be above zero.");
  const now = input.now ?? new Date();
  const raw = (await db.spendReservation.create({
    data: {
      tenantId: input.tenantId,
      pot: input.pot,
      currency: input.currency,
      subjectType: "ai_call",
      subjectId: input.subjectId,
      amountMinor: input.amountMinor,
      dayKey: input.keys.day,
      monthKey: input.keys.month,
      expiresAt: new Date(now.getTime() + input.ttlMs),
      correlationId: input.correlationId ?? newCorrelationId(),
    },
  })) as Record<string, unknown>;
  return toReservationRow(raw);
}

/** The call succeeded: the hold leaves reserved and the actual amount is spent. A successful call is never refunded. */
export async function settleCallReservation(reservationId: string, actualMinor: bigint, opts: { db?: SpendDb; now?: Date } = {}): Promise<CloseResult> {
  if (actualMinor < 0n) throw new RangeError("Actual usage cannot be negative.");
  const out = await closeHeld(reservationId, "settled", opts.db ?? prisma, opts.now ?? new Date(), actualMinor);
  return { closed: out.closed, releasedMinor: out.releasedMinor, status: out.row?.status ?? null };
}

/** The call failed or timed out: the whole hold goes back. */
export async function releaseCallReservation(reservationId: string, opts: { db?: SpendDb; now?: Date } = {}): Promise<CloseResult> {
  const out = await closeHeld(reservationId, "released", opts.db ?? prisma, opts.now ?? new Date());
  return { closed: out.closed, releasedMinor: out.releasedMinor, status: out.row?.status ?? null };
}

/**
 * Releases every hold past expiresAt (the periodic sweep, and lazily by readers). Bulk holds are ledgered as
 * messaging.bulk_release; AI calls are not (no ledger row per AI call, 9.1). Returns how many were expired.
 */
export async function expireReservations(opts: { db?: SpendDb; now?: Date; limit?: number } = {}): Promise<{ expired: number; releasedMinor: bigint }> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const due = ((await db.spendReservation.findMany({
    where: { status: "held", expiresAt: { lte: now } },
    orderBy: { expiresAt: "asc" },
    take: Math.min(Math.max(1, opts.limit ?? 200), 1_000),
  })) ?? []) as Record<string, unknown>[];
  let expired = 0;
  let releasedMinor = 0n;
  for (const raw of due) {
    const r = toReservationRow(raw);
    const out = await closeHeld(r.id, "expired", db, now);
    if (!out.closed) continue;
    expired++;
    releasedMinor += out.releasedMinor;
    await ledgerExpiry(r, out.releasedMinor, db as unknown as LedgerDb, false);
  }
  return { expired, releasedMinor };
}

/**
 * The `messaging.bulk_release` info row of an expired bulk hold (AI calls get none: no ledger row per AI call, 9.1). The
 * idempotency key is per hold, so the sweep and a lazy expiry inside reserveBulk never write it twice.
 */
async function ledgerExpiry(r: ReservationRow, releasedMinor: bigint, db: LedgerDb, inTransaction: boolean): Promise<void> {
  if (r.subjectType === "ai_call") return;
  await appendStandalone(
    {
      tenantId: r.tenantId,
      pot: r.pot,
      action: "messaging.bulk_release",
      phase: "info",
      actor: { type: "system", job: "spend.reservations.expire" },
      reason: `The hold for this ${r.subjectType === "broadcast" ? "broadcast" : "send"} expired, so ${formatMinor(releasedMinor, r.currency)} went back to your WhatsApp limit.`,
      reasonCodes: ["expired"],
      targetType: r.subjectType,
      targetId: r.subjectId,
      currency: r.currency,
      amountMinor: releasedMinor,
      correlationId: r.correlationId,
      idempotencyKey: `bulk_expire:${r.id}`,
    },
    inTransaction ? { tx: db } : { db },
  );
}

/** The open hold of a subject, if any (expired rows are ignored, 4.16). */
export async function openReservationFor(tenantId: string, subject: { type: ReservationSubjectType; id: string }, opts: { db?: SpendDb; now?: Date } = {}): Promise<ReservationRow | null> {
  const db = opts.db ?? prisma;
  const raw = (await db.spendReservation.findFirst({ where: { tenantId, subjectType: subject.type, subjectId: subject.id, status: "held" } })) as Record<string, unknown> | null;
  if (!raw) return null;
  const row = toReservationRow(raw);
  return row.expiresAt.getTime() > (opts.now ?? new Date()).getTime() ? row : null;
}

