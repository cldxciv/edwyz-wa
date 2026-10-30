/**
 * The spend ledger's single writer (docs/SPEND-CONTROLS-SPEC.md 9.1). SpendLedger is append-only by trigger (0009); nothing
 * else in src writes it (bypass rule B6), apart from the erasure purge.
 *
 * - appendRequest(tx, row): inside the reservation transaction. Strict: if the insert fails, the action stops.
 * - appendOutcome(correlationId, row): after the call. Never throws; retries once; a duplicate outcome is a no-op.
 * - appendStandalone(row): refused, shadow, info and reconciled rows that stand alone with their own correlationId. A refusal
 *   is written OUTSIDE the transaction that refuses (that transaction rolls back), so by default this never throws either.
 * - Idempotency: a row with the same (tenant, idempotencyKey, phase) is returned instead of written twice.
 * - listLedger(): seq cursor pages of at most 100 rows.
 *
 * Pairs: requested, then exactly one of applied | failed | unconfirmed | refused | reconciled. The only third row is a
 * reconciled row after unconfirmed. Not one row per message or AI call: those live in SpendCounter, Message and UsageLedger.
 */
import { randomUUID } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { describeError } from "@/lib/safe-error";
import { jsonSafe } from "./http";
import { MAX_STORED_MINOR } from "./money";
import type { LedgerPhase, LedgerPot, LedgerRecord, LedgerRowInput, OutcomePhase, Pot, SpendActor, SpendActorType, StandalonePhase } from "./types";

type LedgerDelegate = Pick<Prisma.TransactionClient["spendLedger"], "findFirst" | "findMany" | "create" | "createMany">;
/** A Prisma client or interactive-transaction client; only the spendLedger delegate is used. */
export type LedgerDb = { spendLedger: LedgerDelegate };

export const LEDGER_PAGE_MAX = 100;
export const LEDGER_PAGE_DEFAULT = 50;

/** Outcome phases that close a request. A reconciled row may follow only an unconfirmed one. */
const CLOSING_PHASES: readonly LedgerPhase[] = ["applied", "failed", "unconfirmed", "refused"];

export type LedgerAppendResult = { record: LedgerRecord; created: boolean };

type Logger = (message: string) => void;
const defaultLog: Logger = (message) => console.error(message);

export function newCorrelationId(): string {
  return `sc_${randomUUID()}`;
}

/** The actor columns of a ledger row. reasonCodes of a user actor (via_eddy) are carried onto the row. */
export function actorColumns(actor: SpendActor): { actorType: SpendActorType; actorId: string | null; assistantKey: string | null; approvalId: string | null; reasonCodes: string[] } {
  switch (actor.type) {
    case "user":
      // A person who accepted an assistant's suggestion (2.3.10) keeps the assistant and the approval on the row.
      return { actorType: "user", actorId: actor.userId, assistantKey: actor.assistantKey ?? null, approvalId: actor.approvalId ?? null, reasonCodes: [...(actor.reasonCodes ?? [])] };
    case "assistant":
      return { actorType: "assistant", actorId: null, assistantKey: actor.assistantKey, approvalId: actor.approvalId ?? null, reasonCodes: [] };
    case "system":
      return { actorType: "system", actorId: actor.job, assistantKey: null, approvalId: null, reasonCodes: [] };
    case "breaker":
      return { actorType: "breaker", actorId: actor.kind, assistantKey: null, approvalId: null, reasonCodes: [] };
    case "platform_admin":
      return { actorType: "platform_admin", actorId: actor.userId, assistantKey: null, approvalId: null, reasonCodes: [] };
    case "api":
      return { actorType: "api", actorId: actor.keyId, assistantKey: null, approvalId: null, reasonCodes: [] };
    case "external":
      return { actorType: "external", actorId: actor.source, assistantKey: null, approvalId: null, reasonCodes: [] };
  }
}

const json = (value: unknown): Prisma.InputJsonValue | undefined =>
  value === undefined || value === null ? undefined : (jsonSafe(value) as Prisma.InputJsonValue);

function toCreateData(row: LedgerRowInput, phase: LedgerPhase, correlationId: string): Prisma.SpendLedgerUncheckedCreateInput {
  const reason = (row.reason ?? "").trim();
  if (!reason) throw new RangeError("A ledger row needs a plain-language reason.");
  if (!row.tenantId) throw new RangeError("A ledger row needs a workspace.");
  const actor = actorColumns(row.actor);
  const reasonCodes = [...new Set([...(row.reasonCodes ?? []), ...actor.reasonCodes])];
  return {
    tenantId: row.tenantId,
    pot: row.pot,
    action: row.action,
    phase,
    actorType: actor.actorType,
    actorId: actor.actorId,
    assistantKey: actor.assistantKey,
    autonomyLevel: row.autonomyLevel ?? null,
    targetType: row.targetType ?? null,
    targetId: row.targetId ?? null,
    metaObjectId: row.metaObjectId ?? null,
    currency: row.currency ?? null,
    amountMinor: row.amountMinor ?? null,
    forecastTodayMinor: row.forecastTodayMinor ?? null,
    forecastMonthMinor: row.forecastMonthMinor ?? null,
    before: json(row.before),
    after: json(row.after),
    snapshot: json(row.snapshot),
    reason,
    reasonCodes,
    approvalId: row.approvalId ?? actor.approvalId,
    undo: json(row.undo),
    correlationId,
    idempotencyKey: row.idempotencyKey ?? null,
    observe: row.observe ?? false,
    sandbox: row.sandbox ?? false,
  };
}

type RawRow = Record<string, unknown>;

/** Maps a database row to the typed record (seq and amounts stay bigint). */
export function toLedgerRecord(raw: RawRow): LedgerRecord {
  const big = (v: unknown): bigint | null => (v === null || v === undefined ? null : typeof v === "bigint" ? v : BigInt(v as number | string));
  return {
    id: String(raw.id),
    seq: big(raw.seq) ?? 0n,
    tenantId: String(raw.tenantId),
    pot: raw.pot as LedgerPot,
    action: String(raw.action),
    phase: raw.phase as LedgerPhase,
    actorType: raw.actorType as SpendActorType,
    actorId: (raw.actorId as string | null) ?? null,
    assistantKey: (raw.assistantKey as string | null) ?? null,
    autonomyLevel: (raw.autonomyLevel as number | null) ?? null,
    targetType: (raw.targetType as string | null) ?? null,
    targetId: (raw.targetId as string | null) ?? null,
    metaObjectId: (raw.metaObjectId as string | null) ?? null,
    currency: (raw.currency as string | null) ?? null,
    amountMinor: big(raw.amountMinor),
    forecastTodayMinor: big(raw.forecastTodayMinor),
    forecastMonthMinor: big(raw.forecastMonthMinor),
    before: raw.before ?? null,
    after: raw.after ?? null,
    snapshot: raw.snapshot ?? null,
    reason: String(raw.reason),
    reasonCodes: Array.isArray(raw.reasonCodes) ? (raw.reasonCodes as string[]) : [],
    approvalId: (raw.approvalId as string | null) ?? null,
    undo: raw.undo ?? null,
    correlationId: String(raw.correlationId),
    idempotencyKey: (raw.idempotencyKey as string | null) ?? null,
    observe: Boolean(raw.observe),
    sandbox: Boolean(raw.sandbox),
    createdAt: raw.createdAt instanceof Date ? raw.createdAt : new Date(String(raw.createdAt)),
  };
}

const isUniqueViolation = (error: unknown): boolean => (error as { code?: unknown })?.code === "P2002";

async function findByKey(db: LedgerDb, tenantId: string, idempotencyKey: string, phase: LedgerPhase): Promise<LedgerRecord | null> {
  const row = await db.spendLedger.findFirst({ where: { tenantId, idempotencyKey, phase } });
  return row ? toLedgerRecord(row as unknown as RawRow) : null;
}

async function insert(db: LedgerDb, data: Prisma.SpendLedgerUncheckedCreateInput): Promise<LedgerRecord> {
  return toLedgerRecord((await db.spendLedger.create({ data })) as unknown as RawRow);
}

/**
 * The row that already holds this request's place: the same (tenant, idempotencyKey, phase), else the one closing row
 * (applied | failed | unconfirmed | refused) or the one reconciled row of this correlationId. 0009 makes both unique
 * (SpendLedger_idem_key, SpendLedger_one_outcome_key, SpendLedger_one_reconciled_key), so a concurrent second writer gets
 * P2002 and is answered with this row.
 */
async function existingFor(db: LedgerDb, row: LedgerRowInput, phase: LedgerPhase, correlationId: string): Promise<LedgerRecord | null> {
  if (row.idempotencyKey) {
    const byKey = await findByKey(db, row.tenantId, row.idempotencyKey, phase);
    if (byKey) return byKey;
  }
  const slot: LedgerPhase[] | null = CLOSING_PHASES.includes(phase) ? [...CLOSING_PHASES] : phase === "reconciled" ? ["reconciled"] : null;
  if (!slot) return null;
  const hit = await db.spendLedger.findFirst({ where: { tenantId: row.tenantId, correlationId, phase: { in: slot } }, orderBy: { seq: "asc" } });
  return hit ? toLedgerRecord(hit as unknown as RawRow) : null;
}

/**
 * Inserts one row, or returns the row that already holds its place (created: false).
 * Outside a transaction a unique violation is caught. Inside one it cannot be: Postgres aborts the transaction on the failed
 * INSERT (25P02), so any query after it fails. There the insert is ON CONFLICT DO NOTHING (createMany skipDuplicates).
 */
async function insertOnce(db: LedgerDb, data: Prisma.SpendLedgerUncheckedCreateInput, row: LedgerRowInput, phase: LedgerPhase, correlationId: string, inTransaction: boolean): Promise<LedgerAppendResult> {
  if (inTransaction) {
    const { count } = await db.spendLedger.createMany({ data: [data], skipDuplicates: true });
    if (count === 1) {
      const created = await db.spendLedger.findFirst({ where: { tenantId: row.tenantId, correlationId, phase }, orderBy: { seq: "desc" } });
      if (created) return { record: toLedgerRecord(created as unknown as RawRow), created: true };
    }
    const existing = await existingFor(db, row, phase, correlationId);
    if (existing) return { record: existing, created: false };
    throw new Error(`[spend] ledger ${phase} row for ${correlationId} was neither written nor found`);
  }
  try {
    return { record: await insert(db, data), created: true };
  } catch (error) {
    if (isUniqueViolation(error)) {
      const existing = await existingFor(db, row, phase, correlationId);
      if (existing) return { record: existing, created: false };
    }
    throw error;
  }
}

/**
 * Writes the `requested` row inside the caller's transaction. Strict: any failure propagates and the action must stop.
 * With an idempotency key that already has a requested row, that row is returned (`created: false`) and nothing is written.
 */
export async function appendRequest(tx: LedgerDb, row: LedgerRowInput): Promise<LedgerAppendResult> {
  const correlationId = row.correlationId ?? newCorrelationId();
  const data = toCreateData(row, "requested", correlationId);
  if (row.idempotencyKey) {
    const existing = await findByKey(tx, row.tenantId, row.idempotencyKey, "requested");
    if (existing) return { record: existing, created: false };
  }
  return { record: await insert(tx, data), created: true };
}

export type BestEffortOptions = { db?: LedgerDb; log?: Logger; retryDelayMs?: number };

const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/** Runs a write at most twice; logs and returns null when both attempts fail. Never throws. */
async function bestEffort<T>(what: string, ref: string, attempt: () => Promise<T>, opts: BestEffortOptions): Promise<T | null> {
  const log = opts.log ?? defaultLog;
  for (let i = 0; i < 2; i++) {
    try {
      return await attempt();
    } catch (error) {
      if (i === 1) {
        log(`[spend] ledger ${what} not written (${ref}): ${describeError(error)}`);
        return null;
      }
      await sleep(opts.retryDelayMs ?? 50);
    }
  }
  return null;
}

/**
 * Writes the one outcome of a request (same correlationId). Never throws: a failed write is retried once, then logged, and
 * the nightly crosscheck flags the orphan. A second outcome for the same request is a no-op that returns the first one.
 */
export async function appendOutcome(
  correlationId: string,
  row: LedgerRowInput & { phase: OutcomePhase },
  opts: BestEffortOptions = {},
): Promise<LedgerAppendResult | null> {
  const db = opts.db ?? (prisma as unknown as LedgerDb);
  return bestEffort("outcome", correlationId, async () => {
    const data = toCreateData({ ...row, correlationId }, row.phase, correlationId);
    if (row.idempotencyKey) {
      const existing = await findByKey(db, row.tenantId, row.idempotencyKey, row.phase);
      if (existing) return { record: existing, created: false };
    }
    const prior = (await db.spendLedger.findMany({
      where: { tenantId: row.tenantId, correlationId, phase: { in: [...CLOSING_PHASES, "reconciled"] } },
      orderBy: { seq: "asc" },
    })) as unknown as RawRow[];
    const closing = prior.find((r) => CLOSING_PHASES.includes(r.phase as LedgerPhase));
    const reconciled = prior.find((r) => r.phase === "reconciled");
    // A request has exactly one outcome; the only third row is reconciled after unconfirmed (9.1).
    if (row.phase !== "reconciled" && (closing || reconciled)) return { record: toLedgerRecord((closing ?? reconciled)!), created: false };
    if (row.phase === "reconciled" && (reconciled || (closing && closing.phase !== "unconfirmed"))) {
      return { record: toLedgerRecord((reconciled ?? closing)!), created: false };
    }
    // The checks above are a read; a concurrent writer (the call site and the reconciler) can pass them too. The 0009 unique
    // indexes then refuse the second row, and the first row is the answer.
    return insertOnce(db, data, row, row.phase, correlationId, false);
  }, opts);
}

export type StandaloneOptions = BestEffortOptions & {
  /** Write inside this transaction instead; then the write is strict and failures propagate. */
  tx?: LedgerDb;
};

/**
 * A row that stands alone with its own correlationId: a refusal (also an observe-mode would-refusal, observe=true), a shadow
 * verdict, an info row, or a reconciled row for a change Edwyz found but did not make (actor `external`). The orphan
 * crosscheck skips these. Without `tx` it never throws.
 */
export async function appendStandalone(row: LedgerRowInput & { phase: StandalonePhase }, opts: StandaloneOptions = {}): Promise<LedgerAppendResult | null> {
  const correlationId = row.correlationId ?? newCorrelationId();
  const write = async (db: LedgerDb, inTransaction: boolean): Promise<LedgerAppendResult> => {
    const data = toCreateData({ ...row, correlationId }, row.phase, correlationId);
    if (row.idempotencyKey) {
      const existing = await findByKey(db, row.tenantId, row.idempotencyKey, row.phase);
      if (existing) return { record: existing, created: false };
    }
    return insertOnce(db, data, row, row.phase, correlationId, inTransaction);
  };
  if (opts.tx) return write(opts.tx, true);
  return bestEffort(row.phase, correlationId, () => write(opts.db ?? (prisma as unknown as LedgerDb), false), opts);
}

export type ListLedgerOptions = {
  pot?: Pot | "none";
  /** The seq of the last row of the previous page (decimal string or bigint). */
  cursor?: string | bigint | null;
  /** 1-100; default 50. */
  limit?: number;
  /** Newest first by default (the activity table). */
  order?: "desc" | "asc";
  db?: LedgerDb;
};

export type LedgerPage = { rows: LedgerRecord[]; nextCursor: string | null };

function parseCursor(cursor: string | bigint | null | undefined): bigint | null {
  if (cursor === null || cursor === undefined || cursor === "") return null;
  if (typeof cursor === "bigint") return cursor;
  if (!/^\d{1,20}$/.test(cursor)) throw new RangeError("Invalid ledger cursor.");
  const seq = BigInt(cursor);
  // seq is a BIGINT: a larger cursor would fail in the database as a 500 instead of here.
  if (seq > MAX_STORED_MINOR) throw new RangeError("Invalid ledger cursor.");
  return seq;
}

/** One page of a workspace's ledger, ordered by seq. Never returns more than 100 rows. */
export async function listLedger(tenantId: string, opts: ListLedgerOptions = {}): Promise<LedgerPage> {
  const db = opts.db ?? (prisma as unknown as LedgerDb);
  const limit = Math.min(LEDGER_PAGE_MAX, Math.max(1, Math.floor(opts.limit ?? LEDGER_PAGE_DEFAULT)));
  const order = opts.order ?? "desc";
  const cursor = parseCursor(opts.cursor);
  const where: Prisma.SpendLedgerWhereInput = { tenantId };
  if (opts.pot) where.pot = opts.pot;
  if (cursor !== null) where.seq = order === "desc" ? { lt: cursor } : { gt: cursor };
  const rows = ((await db.spendLedger.findMany({ where, orderBy: { seq: order }, take: limit + 1 })) as unknown as RawRow[]).map(toLedgerRecord);
  const page = rows.slice(0, limit);
  return { rows: page, nextCursor: rows.length > limit ? page[page.length - 1].seq.toString() : null };
}

/** Every row of one decision, oldest first (request, outcome, and a reconciled row after unconfirmed). */
export async function ledgerRowsFor(tenantId: string, correlationId: string, db: LedgerDb = prisma as unknown as LedgerDb): Promise<LedgerRecord[]> {
  const rows = (await db.spendLedger.findMany({ where: { tenantId, correlationId }, orderBy: { seq: "asc" } })) as unknown as RawRow[];
  return rows.map(toLedgerRecord);
}
