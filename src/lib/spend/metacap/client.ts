/**
 * Wall (a), the Meta client (docs/SPEND-CONTROLS-SPEC.md 5.2, 5.5, 5.7). The ONLY code that writes Meta's spending limit
 * (bypass rules B8 and B9).
 *
 * - Reads: GET act_X?fields=spend_cap,amount_spent,currency,timezone_name,account_status,is_prepay_account. Both money
 *   fields are read as minor units (the documented read unit; the read-back confirms it). 0 means no cap.
 * - Writes: POST act_X {spend_cap: '<major units with the currency exponent>'} ("20000.00" INR, "20000" JPY, "20.000"
 *   KWD) inside a meta_cap permit the transport tripwire checks. If Meta read the value as minor units the cap would be 100x
 *   STRICTER, the safe direction. Removing the limit (offboarding only) is spend_cap_action=delete with a delete permit.
 *   `reset` is never sent: the customer's counter is not touched.
 * - One write in flight per account: pg_advisory_xact_lock(21329, hashtext(adAccountAssetId)), taken before any spend lock
 *   (lock order, I10). No spend lock is ever held around these calls.
 * - Every write is ledgered as meta.spend_cap.write: `requested` (before {cap, amount_spent}, the target, and the undo recipe
 *   of the previous cap), then exactly one outcome.
 * - Read-back right after the write: within 1 minor unit verifies the unit; x100 or /100 is a unit mismatch (mode error,
 *   breaker meta_cap_units, platform admins alerted, ONE corrective emergency write in the inferred unit); amount_spent
 *   dropping to about 0 means `resets_on_write`; otherwise `cumulative`.
 * - Failures (5.7): 17/1885172 blocks writes until the account's next midnight (and opens meta_cap_stale_high when the
 *   blocked write was a lowering); a quoted floor is written when it is at most T + 10% of M (looseness recorded), otherwise
 *   the old cap is kept and marked loose; permission errors (10, 200, 294) give no_permission with in-app copy; prepaid gives
 *   unavailable_prepaid. An ambiguous write (5xx or timeout) is never retried blindly: it is read back at once and again
 *   after 60 seconds, then settled as applied or failed.
 * - SPEND_CAP_MODE=observe writes an `info` row with what would have been written and never POSTs (12.1a decision 5 keeps
 *   observe until the owner runs runbook V1-V9). off does nothing.
 */
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { GraphError, graphFetchAs } from "@/lib/graph";
import { enqueue as enqueueJob } from "@/lib/queue";
import { describeError, sanitizeMessage } from "@/lib/safe-error";
import { openBreaker } from "../breakers/state";
import type { SpendDb } from "../control";
import { spendCapMode } from "../flags";
import { appendOutcome, appendRequest, appendStandalone, newCorrelationId, type LedgerDb } from "../ledger";
import { isLockTimeoutError, METACAP_LOCK_NAMESPACE } from "../lock";
import { currencyExponent, decimalToMinorBig, formatMinor, minorToMajorString } from "../money";
import { notifySpend } from "../notify";
import { mintPermit, runWithPermit } from "../permit";
import { nextLocalMidnight, resolveTimeZone } from "../periods";
import { PERMIT_TTL_MS, SPEND_QUEUES, type MetaCapPriority, type MetaCapSemantics, type MetaCapUnitMode, type SpendActor, type SpendNotice } from "../types";
import { acceptFloor, CHANGE_WINDOW_MS, oneMajorUnit, translateCustomerCapAfterReset, type CapWriteRecord, type MetaCapRow, type WriteClass } from "./plan";

type Env = Record<string, string | undefined>;

/** A Prisma client (with $transaction for the account lock) or a transaction client. */
export type MetaCapDb = SpendDb & { $transaction?: <R>(fn: (tx: SpendDb) => Promise<R>, options?: { timeout?: number; maxWait?: number }) => Promise<R> };

export type MetaCapIo = {
  db?: MetaCapDb;
  env?: Env;
  now?: Date;
  /** The job queue (the 60-second read-back of an ambiguous write). */
  enqueue?: (queue: string, payload: unknown, opts?: { runAt?: Date }) => Promise<unknown>;
  /** Notices to the owner and platform admins. */
  notify?: (notice: SpendNotice) => Promise<unknown>;
  /** The ad account's token (getAssetAccess: HttpError 409 when the connection expired or was revoked). */
  access?: (tenantId: string, adAccountAssetId: string) => Promise<{ token: string; externalId: string }>;
};

/** The ad account's token through the Meta connection (409 when it expired or was revoked). Loaded lazily. */
export async function assetToken(io: MetaCapIo, tenantId: string, adAccountAssetId: string): Promise<{ token: string; externalId: string }> {
  if (io.access) return io.access(tenantId, adAccountAssetId);
  const { getAssetAccess } = await import("@/lib/meta-connect");
  const a = await getAssetAccess(tenantId, adAccountAssetId);
  return { token: a.token, externalId: a.externalId };
}

export const CAP_READ_FIELDS = "spend_cap,amount_spent,currency,timezone_name,account_status,is_prepay_account";
export const METACAP_LOCK_SQL = `SELECT pg_advisory_xact_lock(${METACAP_LOCK_NAMESPACE}, hashtext($1::text))`;
export const METACAP_LOCK_TIMEOUT_SQL = "SET LOCAL lock_timeout = '5s'";
/** A 5xx or timeout is read back again after this long before it is settled. */
export const AMBIGUOUS_RECHECK_MS = 60_000;
/** Meta's daily change limit on spend_cap. */
export const META_CAP_CHANGE_LIMIT = { code: 17, subcode: 1885172 } as const;
export const META_PERMISSION_CODES: readonly number[] = [10, 200, 294];
export const META_PREPAID_SUBCODE = 1885080;

/** 5.7 copy, shown in Edwyz (no trip to Meta Ads Manager is needed). */
export const NEED_ADMIN_COPY = "You need to be an admin of this ad account in Meta to let Edwyz manage its limit.";
export const NO_PERMISSION_COPY = "Meta says the person who connected this account can't change its spending limit. Connect again as someone who is an admin of this ad account.";
export const CONNECT_AGAIN_LABEL = "Connect again with an admin account";
export const LOOSE_COPY = "Meta's limit is a little above your limit because some charges are still pending.";

export const actPath = (accountExternalId: string): string => `act_${String(accountExternalId).replace(/^act_/, "")}`;

const ledgerDb = (db: unknown): LedgerDb => db as LedgerDb;
const max0 = (x: bigint): bigint => (x < 0n ? 0n : x);
const abs = (x: bigint): bigint => (x < 0n ? -x : x);

// =====================================================================================================================
// Reading (5.2)
// =====================================================================================================================

export type CapRead = {
  capMinor: bigint;
  amountSpentMinor: bigint;
  currency: string | null;
  timezone: string | null;
  accountStatus: number | null;
  isPrepay: boolean | null;
};

/** A counter Meta returns (spend_cap, amount_spent) as minor units. Throws on anything that is not a plain number. */
export function parseCounter(value: unknown): bigint {
  if (value === null || value === undefined || value === "") return 0n;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) throw new RangeError("Meta returned an unreadable amount.");
    return BigInt(Math.round(value));
  }
  const text = String(value).trim();
  if (/^\d{1,30}$/.test(text)) return BigInt(text);
  return decimalToMinorBig(text, 0);
}

/** Reads Meta's limit of one ad account. Reads use no change budget. */
export async function readCap(token: string, accountExternalId: string): Promise<CapRead> {
  const res = await graphFetchAs<Record<string, unknown>>(token, { path: actPath(accountExternalId), method: "GET", query: { fields: CAP_READ_FIELDS } });
  const status = res?.account_status;
  return {
    capMinor: parseCounter(res?.spend_cap),
    amountSpentMinor: parseCounter(res?.amount_spent),
    currency: typeof res?.currency === "string" ? res.currency.toUpperCase() : null,
    timezone: typeof res?.timezone_name === "string" ? res.timezone_name : null,
    accountStatus: typeof status === "number" ? status : typeof status === "string" && /^\d+$/.test(status) ? Number(status) : null,
    isPrepay: typeof res?.is_prepay_account === "boolean" ? res.is_prepay_account : null,
  };
}

// =====================================================================================================================
// Values and errors
// =====================================================================================================================

/** How the value is sent: major units (the default), minor units (Meta reads it as minor), or /100 (Meta reads it x100). */
export type WriteUnit = "major" | "minor" | "hundredth";

/** The spend_cap value for `minor` minor units in the given unit, as a decimal string with the currency exponent. */
export function capValueString(minor: bigint, currency: string, unit: WriteUnit = "major"): string {
  if (unit === "minor") return minor.toString();
  if (unit === "hundredth") return minorToMajorString(minor / 100n, currency);
  return minorToMajorString(minor, currency);
}

/** The floor in "must be at least ₹1,234.56" (any currency sign or code), in minor units; null when there is none. */
export function parseFloorMinor(message: string, currency: string): bigint | null {
  const m = /at least\s*(?:[A-Za-z]{3}\s*)?[^\d\s]{0,4}\s*(\d[\d,]*(?:\.\d+)?)/i.exec(message ?? "");
  if (!m) return null;
  try {
    return decimalToMinorBig(m[1].replace(/,/g, ""), currencyExponent(currency));
  } catch {
    return null;
  }
}

export type CapErrorKind = "daily_change_limit" | "floor" | "permission" | "prepaid" | "ambiguous" | "unreachable" | "other";

/** What a failed spend_cap call means (5.7). */
export function classifyCapError(error: unknown, currency: string): { kind: CapErrorKind; floorMinor: bigint | null; code?: number; subcode?: number } {
  if (error instanceof GraphError) {
    const { code, subcode, status } = error;
    if (code === META_CAP_CHANGE_LIMIT.code && subcode === META_CAP_CHANGE_LIMIT.subcode) return { kind: "daily_change_limit", floorMinor: null, code, subcode };
    if (code !== undefined && META_PERMISSION_CODES.includes(code)) return { kind: "permission", floorMinor: null, code, subcode };
    if (subcode === META_PREPAID_SUBCODE || /prepaid/i.test(error.message)) return { kind: "prepaid", floorMinor: null, code, subcode };
    const floor = parseFloorMinor(error.message, currency);
    if (floor !== null) return { kind: "floor", floorMinor: floor, code, subcode };
    if (error.ambiguous || status === 0 || status >= 500) return { kind: "ambiguous", floorMinor: null, code, subcode };
    if (code === 190) return { kind: "unreachable", floorMinor: null, code, subcode };
    return { kind: "other", floorMinor: null, code, subcode };
  }
  if (error && typeof error === "object" && (error as { status?: unknown }).status === 409) return { kind: "unreachable", floorMinor: null };
  return { kind: "other", floorMinor: null };
}

export type ReadBack = { match: "exact" | "x100" | "div100" | "none"; resetDetected: boolean };

/** Compares what Meta reads back with what was written (5.5 i-iv). Pure. */
export function analyseReadBack(input: { expectedMinor: bigint; isDelete: boolean; before: Pick<CapRead, "amountSpentMinor">; after: Pick<CapRead, "capMinor" | "amountSpentMinor">; currency: string | null }): ReadBack {
  const { expectedMinor: x, after } = input;
  const unit = oneMajorUnit(input.currency);
  const before = input.before.amountSpentMinor;
  const resetDetected = before > unit && after.amountSpentMinor <= (before / 100n > unit ? before / 100n : unit);
  if (input.isDelete) return { match: after.capMinor === 0n ? "exact" : "none", resetDetected: false };
  if (abs(after.capMinor - x) <= 1n) return { match: "exact", resetDetected };
  if (x > 0n && abs(after.capMinor - x * 100n) <= 100n) return { match: "x100", resetDetected };
  if (x > 0n && abs(after.capMinor * 100n - x) <= 100n) return { match: "div100", resetDetected };
  return { match: "none", resetDetected };
}

// =====================================================================================================================
// Per-account working state (PlatformSetting spend:metacap:<tenantId>:<assetId>; erasure removes it with the workspace)
// =====================================================================================================================

export type AccountState = {
  /** A lower amount_spent seen once without an Edwyz write; used only when the next read agrees (3.1). */
  readDrift?: { amountSpentMinor: string; at: string };
  /** |ΔA - ΔS| > 10% of ΔS strikes (5.6). */
  drift?: { a: string; s: string; strikes: number; flagged: boolean };
  /** An ambiguous write waiting for its read-back. */
  unconfirmed?: { correlationId: string; targetMinor: string; action: "write" | "delete"; at: string; priority: MetaCapPriority };
  /** First 409 from getAssetAccess and the last retry. */
  unreachableSince?: string;
  lastUnreachableTryAt?: string;
  /** When the sandbox info row was written. */
  sandboxNotedAt?: string;
};

export const accountStateKey = (tenantId: string, assetId: string): string => `spend:metacap:${tenantId}:${assetId}`;

export async function loadAccountState(tenantId: string, assetId: string, db: SpendDb = prisma): Promise<AccountState> {
  const row = (await db.platformSetting.findUnique({ where: { key: accountStateKey(tenantId, assetId) } })) as { value?: unknown } | null;
  const v = row?.value;
  return v && typeof v === "object" && !Array.isArray(v) ? (v as AccountState) : {};
}

export async function saveAccountState(tenantId: string, assetId: string, state: AccountState, db: SpendDb = prisma): Promise<void> {
  const key = accountStateKey(tenantId, assetId);
  const value = JSON.parse(JSON.stringify(state)) as Prisma.InputJsonValue;
  await db.platformSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
}

/** Merges what was learned on a live account into 'spend:meta-verified' (the platform default, 5.5). Never throws. */
async function recordLearned(db: SpendDb, unitMode: MetaCapUnitMode, semantics: MetaCapSemantics, now: Date): Promise<void> {
  try {
    const key = "spend:meta-verified";
    const row = (await db.platformSetting.findUnique({ where: { key } })) as { value?: unknown } | null;
    const prev = row?.value && typeof row.value === "object" && !Array.isArray(row.value) ? (row.value as Record<string, unknown>) : {};
    const value = { ...prev, learned: { unitMode, semantics, at: now.toISOString() } } as Prisma.InputJsonValue;
    await db.platformSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
  } catch (error) {
    console.error(`[spend] spend:meta-verified not updated: ${describeError(error)}`);
  }
}

/** The `requested` meta.spend_cap.write rows of the last 24 h for one account: the change budget's input (5.4). */
export async function loadCapWrites(tenantId: string, adAccountAssetId: string, now: Date, db: SpendDb = prisma): Promise<CapWriteRecord[]> {
  const rows = ((await db.spendLedger.findMany({
    where: { tenantId, action: "meta.spend_cap.write", phase: "requested", targetId: adAccountAssetId, createdAt: { gte: new Date(now.getTime() - CHANGE_WINDOW_MS) } },
    select: { createdAt: true, snapshot: true },
    take: 100,
  })) ?? []) as { createdAt: Date; snapshot: unknown }[];
  return rows.map((r) => ({ at: r.createdAt instanceof Date ? r.createdAt : new Date(String(r.createdAt)), raise: !!r.snapshot && typeof r.snapshot === "object" && (r.snapshot as { raise?: unknown }).raise === true }));
}

// =====================================================================================================================
// Writing (5.5)
// =====================================================================================================================

export type CapWriteInput = MetaCapIo & {
  tenantId: string;
  row: MetaCapRow;
  token: string;
  /** "write" sets the cap to `target`; "delete" removes the limit (offboarding only). */
  action?: "write" | "delete";
  target: bigint;
  priority: MetaCapPriority;
  writeClass: WriteClass;
  actor: SpendActor;
  /** Plain-language why, for the activity table. */
  reason: string;
  /** The fresh read taken right before this write. */
  before: CapRead;
  monthlyLimitMinor: bigint | null;
  /** S just before the write: becomes spentAtLastWriteMinor under resets_on_write. */
  spentBeforeMinor: bigint | null;
  sandbox?: boolean;
  /** Internal: the T this write is the floor retry of. */
  floorOf?: bigint;
  /** Internal: the unit of a corrective write. */
  unit?: WriteUnit;
  corrective?: boolean;
};

export type CapWriteResult =
  | { outcome: "applied"; correlationId: string; read: CapRead; writtenMinor: bigint; unitMismatch: "x100" | "div100" | null; resetDetected: boolean; loosenessMinor: bigint | null }
  | { outcome: "failed"; correlationId: string; error: CapErrorKind | "read_back_mismatch"; message: string }
  | { outcome: "unconfirmed"; correlationId: string }
  | { outcome: "observed"; correlationId: string | null }
  | { outcome: "skipped"; reason: "off" | "busy" };

type Ctx = Required<Pick<MetaCapIo, "db" | "env" | "now">> & { enqueue: NonNullable<MetaCapIo["enqueue"]>; notify: NonNullable<MetaCapIo["notify"]> };

function ctxOf(io: MetaCapIo): Ctx {
  return {
    db: io.db ?? (prisma as unknown as MetaCapDb),
    env: io.env ?? process.env,
    now: io.now ?? new Date(),
    enqueue: io.enqueue ?? ((queue, payload, opts) => enqueueJob(queue, payload, opts)),
    notify: io.notify ?? ((notice) => notifySpend(notice)),
  };
}

/** Runs `fn` while holding the account's metacap lock. Returns "busy" when another write holds it past 5 seconds. */
export async function withAccountLock<T>(db: MetaCapDb, adAccountAssetId: string, fn: () => Promise<T>): Promise<T | "busy"> {
  if (typeof db.$transaction !== "function") return fn();
  try {
    return await db.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(METACAP_LOCK_TIMEOUT_SQL);
        await tx.$executeRawUnsafe(METACAP_LOCK_SQL, adAccountAssetId);
        return fn();
      },
      { timeout: 150_000, maxWait: 10_000 },
    );
  } catch (error) {
    if (isLockTimeoutError(error)) return "busy";
    throw error;
  }
}

const unitOfRow = (row: MetaCapRow): WriteUnit => (row.unitMode === "minor_write" ? "minor" : "major");
const fmt = (minor: bigint, currency: string) => formatMinor(minor, currency);

function subject(input: CapWriteInput, currency: string) {
  return {
    tenantId: input.tenantId,
    pot: "ads" as const,
    targetType: "ad_account",
    targetId: input.row.adAccountAssetId,
    metaObjectId: actPath(input.row.accountExternalId),
    currency,
    sandbox: input.sandbox === true,
  };
}

/**
 * Writes Meta's spending limit of one account (or removes it), verifies it, and updates MetaSpendLimit. Never retries an
 * ambiguous write blindly. Never throws for Meta's answers; a ledger `requested` row that cannot be written stops the write.
 */
export async function writeCap(input: CapWriteInput): Promise<CapWriteResult> {
  const ctx = ctxOf(input);
  const mode = spendCapMode(ctx.env);
  if (mode === "off") return { outcome: "skipped", reason: "off" };
  const currency = (input.row.currency ?? input.before.currency ?? "INR").toUpperCase();
  const isDelete = input.action === "delete";
  if (mode === "observe") {
    const out = await appendStandalone(
      {
        ...subject(input, currency),
        action: "meta.spend_cap.observe",
        phase: "info",
        actor: input.actor,
        reason: isDelete ? "Would remove Meta's spending limit (observe mode, nothing was sent)." : `Would set Meta's spending limit to ${fmt(input.target, currency)} (observe mode, nothing was sent).`,
        reasonCodes: [input.priority, input.writeClass, "observe"],
        amountMinor: isDelete ? null : input.target,
        before: { cap: input.before.capMinor, amount_spent: input.before.amountSpentMinor },
        after: isDelete ? { cap: 0n, action: "delete" } : { cap: input.target },
        observe: true,
      },
      { db: ledgerDb(ctx.db) },
    );
    return { outcome: "observed", correlationId: out?.record.correlationId ?? null };
  }
  const locked = await withAccountLock(ctx.db, input.row.adAccountAssetId, () => doWrite(input, ctx, currency));
  return locked === "busy" ? { outcome: "skipped", reason: "busy" } : locked;
}

async function updateRow(db: SpendDb, adAccountAssetId: string, data: Record<string, unknown>): Promise<void> {
  await db.metaSpendLimit.update({ where: { adAccountAssetId }, data: { ...data, version: { increment: 1 } } as never });
}

async function doWrite(input: CapWriteInput, ctx: Ctx, currency: string): Promise<CapWriteResult> {
  const { row, before } = input;
  const isDelete = input.action === "delete";
  const target = isDelete ? 0n : input.target;
  const unit = input.unit ?? unitOfRow(row);
  const act = actPath(row.accountExternalId);
  const correlationId = newCorrelationId();
  const lowering = !isDelete && (before.capMinor === 0n || target < before.capMinor);
  const raise = !isDelete && before.capMinor > 0n && target > before.capMinor;
  const base = subject(input, currency);
  const requestRow = {
    ...base,
    action: "meta.spend_cap.write",
    actor: input.actor,
    reason: input.reason,
    reasonCodes: [input.priority, input.writeClass, ...(input.corrective ? ["corrective"] : []), ...(input.floorOf !== undefined ? ["floor"] : []), ...(isDelete ? ["remove"] : [])],
    amountMinor: isDelete ? null : target,
    before: { cap: before.capMinor, amount_spent: before.amountSpentMinor },
    after: isDelete ? { cap: 0n, action: "delete" } : { cap: target },
    snapshot: { priority: input.priority, writeClass: input.writeClass, raise, unit, unitMode: row.unitMode, semantics: row.semantics, monthlyLimitMinor: input.monthlyLimitMinor, spentBeforeMinor: input.spentBeforeMinor },
    undo: before.capMinor > 0n ? { action: "set_meta_cap", adAccountAssetId: row.adAccountAssetId, capMinor: before.capMinor.toString() } : { action: "remove_meta_cap", adAccountAssetId: row.adAccountAssetId },
    correlationId,
  };
  try {
    await appendRequest(ledgerDb(ctx.db), requestRow);
  } catch (error) {
    console.error(`[spend] meta.spend_cap.write not requested, nothing sent: ${describeError(error)}`);
    return { outcome: "failed", correlationId, error: "other", message: "The change could not be recorded, so nothing was sent to Meta." };
  }
  const outcome = (phase: "applied" | "failed" | "unconfirmed", extra: { reason: string; after?: unknown; reasonCodes?: string[] }) =>
    appendOutcome(correlationId, { ...requestRow, phase, reason: extra.reason, after: extra.after ?? requestRow.after, reasonCodes: [...requestRow.reasonCodes, ...(extra.reasonCodes ?? [])] }, { db: ledgerDb(ctx.db) });

  // The call itself, inside a meta_cap permit (one use, two minutes). Permit times are the real clock, as the tripwire checks.
  const issuedAt = new Date();
  const permit = mintPermit({
    type: "meta_cap",
    kind: isDelete ? "delete" : "write",
    correlationId,
    tenantId: input.tenantId,
    adAccountAssetId: row.adAccountAssetId,
    accountExternalId: act,
    ...(isDelete ? {} : { capMinor: target }),
    priority: input.priority,
    paths: [act],
    maxUses: 1,
    issuedAt,
    expiresAt: new Date(issuedAt.getTime() + PERMIT_TTL_MS.meta_cap),
  });
  const body = isDelete ? { spend_cap_action: "delete" } : { spend_cap: capValueString(target, currency, unit) };
  let failure: unknown = null;
  try {
    await runWithPermit(permit, () => graphFetchAs(input.token, { path: act, method: "POST", body }));
  } catch (error) {
    failure = error;
  }

  if (failure !== null) {
    const err = classifyCapError(failure, currency);
    if (err.kind !== "ambiguous") return handleFailure(input, ctx, currency, correlationId, err, failure, outcome, lowering);
    // Never retried blindly: read back at once; settle now only if Meta clearly applied it.
    const rb = await readCap(input.token, act).catch(() => null);
    const seen = rb ? analyseReadBack({ expectedMinor: target, isDelete, before, after: rb, currency }) : null;
    if (!rb || !seen || seen.match === "none") {
      await outcome("unconfirmed", { reason: "Meta did not answer clearly. We'll check the limit again in a minute before doing anything else.", reasonCodes: ["ambiguous"] });
      const state = await loadAccountState(input.tenantId, row.adAccountAssetId, ctx.db).catch(() => ({}) as AccountState);
      state.unconfirmed = { correlationId, targetMinor: target.toString(), action: isDelete ? "delete" : "write", at: ctx.now.toISOString(), priority: input.priority };
      await saveAccountState(input.tenantId, row.adAccountAssetId, state, ctx.db).catch(() => undefined);
      await updateRow(ctx.db, row.adAccountAssetId, { lastError: "unconfirmed", pendingTargetMinor: isDelete ? null : target, ...(rb ? { lastReadCapMinor: rb.capMinor, lastReadAmountSpentMinor: rb.amountSpentMinor, lastReadAt: ctx.now } : {}) }).catch(() => undefined);
      await ctx
        .enqueue(SPEND_QUEUES.metacapReplan, { tenantId: input.tenantId, adAccountAssetId: row.adAccountAssetId, reason: "ambiguous_write_recheck", correlationId }, { runAt: new Date(ctx.now.getTime() + AMBIGUOUS_RECHECK_MS) })
        .catch((e: unknown) => console.error(`[spend] metacap re-check not queued: ${describeError(e)}`));
      return { outcome: "unconfirmed", correlationId };
    }
    return settleApplied(input, ctx, currency, correlationId, rb, seen, outcome);
  }

  // Read back right after the write (5.2).
  const rb = await readCap(input.token, act).catch(() => null);
  if (!rb) {
    await outcome("unconfirmed", { reason: "Meta accepted the change, but we could not read it back yet. We'll check again in a minute.", reasonCodes: ["read_back_failed"] });
    const state = await loadAccountState(input.tenantId, row.adAccountAssetId, ctx.db).catch(() => ({}) as AccountState);
    state.unconfirmed = { correlationId, targetMinor: target.toString(), action: isDelete ? "delete" : "write", at: ctx.now.toISOString(), priority: input.priority };
    await saveAccountState(input.tenantId, row.adAccountAssetId, state, ctx.db).catch(() => undefined);
    await updateRow(ctx.db, row.adAccountAssetId, { lastError: "unconfirmed", lastWriteAt: ctx.now, pendingTargetMinor: isDelete ? null : target }).catch(() => undefined);
    await ctx.enqueue(SPEND_QUEUES.metacapReplan, { tenantId: input.tenantId, adAccountAssetId: row.adAccountAssetId, reason: "read_back_recheck", correlationId }, { runAt: new Date(ctx.now.getTime() + AMBIGUOUS_RECHECK_MS) }).catch(() => undefined);
    return { outcome: "unconfirmed", correlationId };
  }
  return settleApplied(input, ctx, currency, correlationId, rb, analyseReadBack({ expectedMinor: target, isDelete, before, after: rb, currency }), outcome);
}

type OutcomeFn = (phase: "applied" | "failed" | "unconfirmed", extra: { reason: string; after?: unknown; reasonCodes?: string[] }) => Promise<unknown>;

async function settleApplied(input: CapWriteInput, ctx: Ctx, currency: string, correlationId: string, rb: CapRead, seen: ReadBack, outcome: OutcomeFn): Promise<CapWriteResult> {
  const { row, before } = input;
  const isDelete = input.action === "delete";
  const target = isDelete ? 0n : input.target;
  const after = { cap: rb.capMinor, amount_spent: rb.amountSpentMinor };
  const readFields = { lastReadCapMinor: rb.capMinor, lastReadAmountSpentMinor: rb.amountSpentMinor, lastReadAt: ctx.now };

  if (seen.match === "x100" || seen.match === "div100") {
    // (ii) A unit mismatch: assistants are frozen on the account, platform admins are told, and ONE corrective write goes out.
    await outcome("applied", { reason: "Meta read the new limit in a different unit than expected. We're correcting it now.", after, reasonCodes: ["unit_mismatch", seen.match] });
    await updateRow(ctx.db, row.adAccountAssetId, { ...readFields, mode: "error", lastError: `unit_mismatch:${seen.match}`, managedCapMinor: rb.capMinor, lastWriteAt: ctx.now });
    await openBreaker(
      { tenantId: input.tenantId, kind: "meta_cap_units", scopeType: "ad_account", scopeId: row.adAccountAssetId, effect: "block_raises", reason: "Meta read our spending limit in a different unit. Assistants can't raise anything on this ad account until Edwyz support checks it.", details: { match: seen.match, expectedMinor: target, readBackMinor: rb.capMinor } },
      { db: ctx.db, now: ctx.now },
    ).catch((e: unknown) => console.error(`[spend] meta_cap_units not opened: ${describeError(e)}`));
    console.error(`[spend] meta_cap_units: tenant ${input.tenantId} account ${row.adAccountAssetId} read back ${seen.match}`);
    await ctx
      .notify({ tenantId: input.tenantId, kind: "meta_limit", severity: "action_needed", audience: "platform_admins", dedupeKey: `metacap:units:${row.adAccountAssetId}`, title: "Meta limit unit mismatch", body: `Meta read a spending limit ${seen.match === "x100" ? "100 times higher" : "100 times lower"} than written on ad account ${actPath(row.accountExternalId)}.`, subjectType: "ad_account", subjectId: row.adAccountAssetId, correlationId })
      .catch(() => undefined);
    let correctedTo: bigint = rb.capMinor;
    if (!input.corrective && !isDelete) {
      const inferred: WriteUnit = seen.match === "div100" ? "minor" : "hundredth";
      const fix = await doWrite({ ...input, unit: inferred, corrective: true, writeClass: "emergency", before: rb, reason: "Corrects Meta's spending limit after Meta read it in a different unit." }, ctx, currency);
      if (fix.outcome === "applied") {
        correctedTo = fix.read.capMinor;
        if (abs(fix.read.capMinor - target) <= 1n) {
          await updateRow(ctx.db, row.adAccountAssetId, { mode: "error", unitMode: inferred === "minor" ? "minor_write" : "unverified", lastError: `unit_mismatch:${seen.match}` });
        }
      }
    }
    return { outcome: "applied", correlationId, read: { ...rb, capMinor: correctedTo }, writtenMinor: target, unitMismatch: seen.match, resetDetected: false, loosenessMinor: null };
  }

  if (seen.match === "none") {
    await outcome("failed", { reason: "Meta accepted the change but shows a different limit. We'll check it again on the next read.", after, reasonCodes: ["read_back_mismatch"] });
    await updateRow(ctx.db, row.adAccountAssetId, { ...readFields, managedCapMinor: rb.capMinor, lastError: "read_back_mismatch" });
    return { outcome: "failed", correlationId, error: "read_back_mismatch", message: "Meta shows a different limit than the one written." };
  }

  // (i) verified; (iii) or (iv) for the semantics.
  const unitMode: MetaCapUnitMode = row.unitMode !== "unverified" ? row.unitMode : (input.unit ?? unitOfRow(row)) === "minor" ? "minor_write" : "major_write";
  let semantics: MetaCapSemantics = row.semantics;
  if (seen.resetDetected) semantics = "resets_on_write";
  else if (semantics === "unverified" && before.amountSpentMinor > oneMajorUnit(currency)) semantics = "cumulative";
  const resets = semantics === "resets_on_write";
  const loosenessMinor = input.floorOf !== undefined ? max0(target - input.floorOf) : null;
  await updateRow(ctx.db, row.adAccountAssetId, {
    ...readFields,
    managedCapMinor: isDelete ? null : rb.capMinor,
    targetCapMinor: isDelete ? null : (input.floorOf ?? target),
    lastWriteAt: ctx.now,
    lastError: null,
    pendingTargetMinor: null,
    deferredUntil: null,
    loosenessMinor,
    unitMode,
    semantics,
    ...(resets && !isDelete
      ? { spentAtLastWriteMinor: input.spentBeforeMinor ?? 0n, customerCapAtConsentMinor: translateCustomerCapAfterReset(row.customerCapMinor, before.amountSpentMinor), customerAmountSpentAtConsentMinor: row.customerCapMinor !== null ? 0n : row.customerAmountSpentMinor }
      : {}),
  });
  await outcome("applied", {
    reason: isDelete ? "Meta's spending limit was removed." : input.reason,
    after,
    reasonCodes: [...(seen.resetDetected ? ["resets_on_write"] : []), ...(loosenessMinor ? ["loose"] : [])],
  });
  if (row.unitMode === "unverified" || row.semantics !== semantics) await recordLearned(ctx.db, unitMode, semantics, ctx.now);
  return { outcome: "applied", correlationId, read: rb, writtenMinor: target, unitMismatch: null, resetDetected: seen.resetDetected && row.semantics !== "resets_on_write", loosenessMinor };
}

async function handleFailure(
  input: CapWriteInput,
  ctx: Ctx,
  currency: string,
  correlationId: string,
  err: ReturnType<typeof classifyCapError>,
  error: unknown,
  outcome: OutcomeFn,
  lowering: boolean,
): Promise<CapWriteResult> {
  const { row, before } = input;
  const tz = resolveTimeZone(row.timezone ?? before.timezone);
  const message = sanitizeMessage(error instanceof Error ? error.message : "Meta refused the change.");
  const owner = (dedupeKey: string, title: string, body: string, severity: SpendNotice["severity"] = "action_needed") =>
    ctx.notify({ tenantId: input.tenantId, kind: "meta_limit", severity, audience: "owner", dedupeKey, title, body, link: "/app/settings/spending", subjectType: "ad_account", subjectId: row.adAccountAssetId, correlationId }).catch(() => undefined);

  switch (err.kind) {
    case "daily_change_limit": {
      const until = nextLocalMidnight(ctx.now, tz);
      await outcome("failed", { reason: "Meta allows only a few changes to its spending limit each day. We'll try again after midnight.", reasonCodes: ["meta_17_1885172"] });
      await updateRow(ctx.db, row.adAccountAssetId, { writesBlockedUntil: until, lastError: "daily_change_limit", pendingTargetMinor: input.target, deferredUntil: until });
      console.error(`[spend] metacap 17/1885172: tenant ${input.tenantId} account ${row.adAccountAssetId}, writes blocked until ${until.toISOString()}`);
      await ctx
        .notify({ tenantId: input.tenantId, kind: "meta_limit", severity: "heads_up", audience: "platform_admins", dedupeKey: `metacap:blocked:${row.adAccountAssetId}:${until.toISOString().slice(0, 10)}`, title: "Meta limit changes blocked today", body: `Meta refused a spending-limit change on ad account ${actPath(row.accountExternalId)} (17/1885172).`, subjectType: "ad_account", subjectId: row.adAccountAssetId, correlationId })
        .catch(() => undefined);
      if (lowering && input.action !== "delete") {
        await openBreaker(
          { tenantId: input.tenantId, kind: "meta_cap_stale_high", scopeType: "ad_account", scopeId: row.adAccountAssetId, effect: "block_raises", reason: "Meta's spending limit couldn't be lowered today, so nothing can be raised on this ad account until it is.", details: { targetMinor: input.target, capMinor: before.capMinor, until } },
          { db: ctx.db, now: ctx.now },
        ).catch((e: unknown) => console.error(`[spend] meta_cap_stale_high not opened: ${describeError(e)}`));
        await owner(`metacap:stale_high:${row.adAccountAssetId}:${until.toISOString().slice(0, 10)}`, "Meta's limit will update after midnight", "Meta allows only a few changes to its spending limit each day, so we couldn't lower it yet. Raises on this ad account are paused until we can. Your Edwyz limits still apply now.");
      }
      return { outcome: "failed", correlationId, error: "daily_change_limit", message };
    }
    case "floor": {
      const x = err.floorMinor!;
      if (input.floorOf === undefined && input.action !== "delete" && acceptFloor(x, input.target, input.monthlyLimitMinor)) {
        await outcome("failed", { reason: `Meta needs the limit to be at least ${formatMinor(x, currency)} because some charges are still pending. We're setting that instead.`, reasonCodes: ["floor"] });
        return doWrite({ ...input, target: x, floorOf: input.target, reason: `Sets Meta's limit to ${formatMinor(x, currency)}, the lowest Meta allows while charges are pending.` }, ctx, currency);
      }
      await outcome("failed", { reason: "Meta needs a higher limit because some charges are still pending, so we kept the current one.", reasonCodes: ["floor", "loose"] });
      await updateRow(ctx.db, row.adAccountAssetId, { loosenessMinor: max0(before.capMinor - input.target), lastError: "floor", pendingTargetMinor: null, deferredUntil: null });
      return { outcome: "failed", correlationId, error: "floor", message };
    }
    case "permission": {
      await outcome("failed", { reason: NEED_ADMIN_COPY, reasonCodes: ["no_permission", String(err.code ?? "")] });
      await updateRow(ctx.db, row.adAccountAssetId, { mode: "no_permission", lastError: NO_PERMISSION_COPY, pendingTargetMinor: null, deferredUntil: null });
      await owner(`metacap:no_permission:${row.adAccountAssetId}`, "Meta's limit needs an admin connection", NO_PERMISSION_COPY);
      return { outcome: "failed", correlationId, error: "permission", message: NO_PERMISSION_COPY };
    }
    case "prepaid": {
      await outcome("failed", { reason: "This ad account uses prepaid funds, so Meta has no spending limit to manage. Your Edwyz limits still apply.", reasonCodes: ["prepaid"] });
      await updateRow(ctx.db, row.adAccountAssetId, { mode: "unavailable_prepaid", isPrepay: true, lastError: null, pendingTargetMinor: null, deferredUntil: null });
      return { outcome: "failed", correlationId, error: "prepaid", message };
    }
    default: {
      await outcome("failed", { reason: "Meta refused the change to its spending limit. We'll try again later.", reasonCodes: [err.kind] });
      await updateRow(ctx.db, row.adAccountAssetId, { lastError: message.slice(0, 200) });
      return { outcome: "failed", correlationId, error: err.kind, message };
    }
  }
}

/**
 * Settles an ambiguous write once a later read is available (the 60-second re-check, or the next scheduled read): the
 * reconciled row says whether Meta applied it. Returns true when it was applied.
 */
export async function settleUnconfirmed(input: { tenantId: string; row: MetaCapRow; state: AccountState; read: CapRead; actor: SpendActor; currency: string } & MetaCapIo): Promise<"applied" | "failed" | "waiting" | null> {
  const ctx = ctxOf(input);
  const pending = input.state.unconfirmed;
  if (!pending) return null;
  const expected = BigInt(pending.targetMinor);
  const isDelete = pending.action === "delete";
  const seen = analyseReadBack({ expectedMinor: expected, isDelete, before: { amountSpentMinor: input.row.lastReadAmountSpentMinor ?? 0n }, after: input.read, currency: input.currency });
  const age = ctx.now.getTime() - new Date(pending.at).getTime();
  if (seen.match !== "exact" && age < AMBIGUOUS_RECHECK_MS) return "waiting";
  const applied = seen.match === "exact";
  await appendOutcome(
    pending.correlationId,
    {
      tenantId: input.tenantId,
      pot: "ads",
      action: "meta.spend_cap.write",
      phase: "reconciled",
      actor: input.actor,
      reason: applied ? "Meta applied the change to its spending limit." : "Meta did not apply the change to its spending limit.",
      reasonCodes: [applied ? "applied" : "not_applied"],
      targetType: "ad_account",
      targetId: input.row.adAccountAssetId,
      metaObjectId: actPath(input.row.accountExternalId),
      currency: input.currency,
      after: { cap: input.read.capMinor, amount_spent: input.read.amountSpentMinor },
    },
    { db: ledgerDb(ctx.db) },
  );
  const { unconfirmed: _done, ...rest } = input.state;
  await saveAccountState(input.tenantId, input.row.adAccountAssetId, rest, ctx.db).catch(() => undefined);
  await updateRow(
    ctx.db,
    input.row.adAccountAssetId,
    applied
      ? { managedCapMinor: isDelete ? null : input.read.capMinor, targetCapMinor: isDelete ? null : expected, lastWriteAt: new Date(pending.at), lastError: null, pendingTargetMinor: null, deferredUntil: null }
      : { lastError: null },
  );
  return applied ? "applied" : "failed";
}
