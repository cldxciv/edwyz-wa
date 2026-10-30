/**
 * Breaker state (SpendBreaker, docs/SPEND-CONTROLS-SPEC.md 6). The breakers themselves (WP-08, WP-12) decide WHEN to trip;
 * this module only stores it:
 * - openBreaker() is idempotent through the open-row partial unique index (tenantId, kind, scopeType, scopeId) WHERE state =
 *   'tripped': a second trip of the same breaker returns the open row and writes nothing. A new trip writes `breaker.trip`.
 * - clearBreaker() closes it and writes `breaker.clear` (actor breaker for an auto-clear, the person otherwise). Clearing a
 *   breaker that paused something is a raise; the caller checks who may do it and resumes only through reserveAds.
 * - isBlocked() answers "does an open breaker with one of these effects cover this scope?". A workspace breaker covers every
 *   scope of the workspace. A breaker past its autoClearAt no longer blocks, even before the clearing task runs (4.16).
 */
import { prisma } from "@/lib/db";
import type { SpendDb } from "../control";
import { appendStandalone, type LedgerDb } from "../ledger";
import type { BreakerEffect, BreakerKind, BreakerScopeType, BreakerState, LedgerPot, OpenBreakerRef, SpendActor } from "../types";

export type BreakerRow = {
  id: string;
  tenantId: string;
  kind: BreakerKind | string;
  scopeType: BreakerScopeType;
  scopeId: string;
  state: BreakerState;
  effect: BreakerEffect;
  reason: string;
  details: unknown;
  trippedAt: Date;
  clearedAt: Date | null;
  clearedByUserId: string | null;
  autoClearAt: Date | null;
  notifiedAt: Date | null;
};

const SCOPE_TYPES: readonly BreakerScopeType[] = ["workspace", "ad_account", "campaign", "adset", "phone", "template", "waba", "assistant"];
const EFFECTS: readonly BreakerEffect[] = ["pause_scope", "block_raises", "block_marketing", "block_automated", "block_all_outbound", "notify_only"];
const MESSAGING_KINDS = new Set(["wa_quality_yellow", "wa_quality_red", "wa_restricted", "waba_disabled"]);
const ADS_KINDS = new Set([
  "pacing",
  "efficiency",
  "spend_jump",
  "cpm_ctr_anomaly",
  "account_spike",
  "daily_limit",
  "monthly_limit",
  "budget_change_quota",
  "sync_stale",
  "meta_cap_units",
  "meta_cap_unreachable",
  "meta_cap_stale_high",
  "external_edit",
]);

/** The ledger pot of a breaker kind. */
export function breakerPot(kind: string): LedgerPot {
  return ADS_KINDS.has(kind) ? "ads" : MESSAGING_KINDS.has(kind) ? "messaging" : "none";
}

const date = (v: unknown): Date | null => (v instanceof Date ? v : v ? new Date(String(v)) : null);

export function toBreakerRow(raw: Record<string, unknown>): BreakerRow {
  return {
    id: String(raw.id),
    tenantId: String(raw.tenantId),
    kind: String(raw.kind),
    scopeType: raw.scopeType as BreakerScopeType,
    scopeId: String(raw.scopeId),
    state: raw.state === "cleared" ? "cleared" : "tripped",
    effect: raw.effect as BreakerEffect,
    reason: String(raw.reason ?? ""),
    details: raw.details ?? null,
    trippedAt: date(raw.trippedAt) ?? new Date(0),
    clearedAt: date(raw.clearedAt),
    clearedByUserId: (raw.clearedByUserId as string | null) ?? null,
    autoClearAt: date(raw.autoClearAt),
    notifiedAt: date(raw.notifiedAt),
  };
}

export function toOpenRef(row: BreakerRow): OpenBreakerRef {
  return { id: row.id, kind: row.kind, scopeType: row.scopeType, scopeId: row.scopeId, effect: row.effect };
}

/** True while the breaker is tripped and not past its autoClearAt. */
export function isOpen(row: BreakerRow, now: Date = new Date()): boolean {
  return row.state === "tripped" && !(row.autoClearAt && row.autoClearAt.getTime() <= now.getTime());
}

export type OpenBreakerInput = {
  tenantId: string;
  kind: BreakerKind | string;
  scopeType: BreakerScopeType;
  scopeId: string;
  effect: BreakerEffect;
  /** Plain words, shown to the owner ("Spent ₹1,400 in 2 hours on a ₹1,000 daily budget"). */
  reason: string;
  details?: Record<string, unknown> | null;
  autoClearAt?: Date | null;
};

export type BreakerOptions = { db?: SpendDb; now?: Date };

function check(input: OpenBreakerInput): void {
  if (!input.tenantId || !input.kind || !input.scopeId) throw new RangeError("A breaker needs a workspace, a kind and a scope.");
  if (!SCOPE_TYPES.includes(input.scopeType)) throw new RangeError(`Unknown breaker scope ${String(input.scopeType)}`);
  if (!EFFECTS.includes(input.effect)) throw new RangeError(`Unknown breaker effect ${String(input.effect)}`);
  if (!(input.reason ?? "").trim()) throw new RangeError("A breaker needs a plain-language reason.");
}

const jsonSafe = (v: unknown): unknown => JSON.parse(JSON.stringify(v ?? null, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));

/** Opens a breaker, or returns the one that is already open for the same kind and scope (created: false). */
export async function openBreaker(input: OpenBreakerInput, opts: BreakerOptions = {}): Promise<{ breaker: BreakerRow; created: boolean }> {
  check(input);
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const key = { tenantId: input.tenantId, kind: input.kind, scopeType: input.scopeType, scopeId: input.scopeId };
  // ON CONFLICT DO NOTHING against the open-row unique index: safe inside a caller's transaction (no 25P02).
  const { count } = await db.spendBreaker.createMany({
    data: [{ ...key, state: "tripped", effect: input.effect, reason: input.reason.trim(), details: input.details ? (jsonSafe(input.details) as object) : undefined, trippedAt: now, autoClearAt: input.autoClearAt ?? null }],
    skipDuplicates: true,
  });
  const raw = (await db.spendBreaker.findFirst({ where: { ...key, state: "tripped" }, orderBy: { trippedAt: "desc" } })) as Record<string, unknown> | null;
  if (!raw) throw new Error("[spend] breaker was neither opened nor found");
  const breaker = toBreakerRow(raw);
  const created = count === 1;
  if (created) {
    await appendStandalone(
      {
        tenantId: input.tenantId,
        pot: breakerPot(input.kind),
        action: "breaker.trip",
        phase: "info",
        actor: { type: "breaker", kind: input.kind },
        reason: breaker.reason,
        reasonCodes: [String(input.kind)],
        targetType: input.scopeType,
        targetId: input.scopeId,
        snapshot: { effect: input.effect, details: input.details ?? null, autoClearAt: input.autoClearAt ?? null },
        idempotencyKey: `breaker:${breaker.id}:trip`,
      },
      opts.db ? { tx: opts.db as unknown as LedgerDb } : {},
    );
  }
  return { breaker, created };
}

export type ClearTarget = { id: string } | { tenantId: string; kind: BreakerKind | string; scopeType: BreakerScopeType; scopeId: string };

/**
 * Clears an open breaker. `actor` defaults to the breaker itself (an auto-clear); pass the person who cleared it otherwise.
 * Clearing one that is not open is a no-op (cleared: false).
 */
export async function clearBreaker(target: ClearTarget, opts: BreakerOptions & { actor?: SpendActor; reason?: string } = {}): Promise<{ breaker: BreakerRow | null; cleared: boolean }> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const where = "id" in target ? { id: target.id, state: "tripped" } : { ...target, state: "tripped" };
  const raw = (await db.spendBreaker.findFirst({ where })) as Record<string, unknown> | null;
  if (!raw) return { breaker: null, cleared: false };
  const row = toBreakerRow(raw);
  const userId = opts.actor && (opts.actor.type === "user" || opts.actor.type === "platform_admin") ? opts.actor.userId : null;
  const { count } = await db.spendBreaker.updateMany({ where: { id: row.id, state: "tripped" }, data: { state: "cleared", clearedAt: now, clearedByUserId: userId } });
  if (count !== 1) return { breaker: row, cleared: false };
  const actor: SpendActor = opts.actor ?? { type: "breaker", kind: row.kind };
  await appendStandalone(
    {
      tenantId: row.tenantId,
      pot: breakerPot(row.kind),
      action: "breaker.clear",
      phase: "info",
      actor,
      reason: (opts.reason ?? "").trim() || "The safety stop was cleared.",
      reasonCodes: [String(row.kind)],
      targetType: row.scopeType,
      targetId: row.scopeId,
      snapshot: { effect: row.effect, trippedAt: row.trippedAt },
      idempotencyKey: `breaker:${row.id}:clear`,
    },
    opts.db ? { tx: opts.db as unknown as LedgerDb } : {},
  );
  return { breaker: { ...row, state: "cleared", clearedAt: now, clearedByUserId: userId }, cleared: true };
}

export type ListBreakersOptions = BreakerOptions & {
  /** Default 'open': tripped and not past autoClearAt. */
  state?: "open" | "tripped" | "cleared" | "all";
  kinds?: string[];
  limit?: number;
};

export async function listBreakers(tenantId: string, opts: ListBreakersOptions = {}): Promise<BreakerRow[]> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const state = opts.state ?? "open";
  const where: Record<string, unknown> = { tenantId };
  if (state === "open" || state === "tripped") where.state = "tripped";
  else if (state === "cleared") where.state = "cleared";
  if (opts.kinds?.length) where.kind = { in: opts.kinds };
  const rows = (((await db.spendBreaker.findMany({ where, orderBy: { trippedAt: "desc" }, take: Math.min(opts.limit ?? 200, 1_000) })) ?? []) as Record<string, unknown>[]).map(toBreakerRow);
  return state === "open" ? rows.filter((r) => isOpen(r, now)) : rows;
}

export type BreakerScopeRef = { scopeType: BreakerScopeType; scopeId: string };

/** The open breakers among `rows` that block an action on any of `scopes` with one of `effects` (pure). */
export function blockingBreakers(rows: BreakerRow[], scopes: BreakerScopeRef[], effects: BreakerEffect[], opts: { now?: Date; exemptBreakerId?: string } = {}): BreakerRow[] {
  const now = opts.now ?? new Date();
  return rows.filter(
    (r) =>
      r.id !== opts.exemptBreakerId &&
      isOpen(r, now) &&
      effects.includes(r.effect) &&
      (r.scopeType === "workspace" || scopes.some((s) => s.scopeType === r.scopeType && s.scopeId === r.scopeId)),
  );
}

/**
 * Whether an open breaker with one of `effects` covers any of `scopes` (or the whole workspace). `exemptBreakerId` lets a
 * breaker's own auto-resume pass its own breaker (4.6 step 3).
 */
export async function isBlocked(
  tenantId: string,
  scopes: BreakerScopeRef[],
  effects: BreakerEffect[],
  opts: BreakerOptions & { exemptBreakerId?: string } = {},
): Promise<{ blocked: boolean; breakers: OpenBreakerRef[] }> {
  const rows = await listBreakers(tenantId, { db: opts.db, now: opts.now, state: "tripped" });
  const hit = blockingBreakers(rows, scopes, effects, { now: opts.now, exemptBreakerId: opts.exemptBreakerId });
  return { blocked: hit.length > 0, breakers: hit.map(toOpenRef) };
}

/** Clears every breaker past its autoClearAt (budget_change_quota after 60 min, cpm_ctr_anomaly after 24 h). */
export async function clearExpiredBreakers(opts: BreakerOptions & { limit?: number } = {}): Promise<number> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const due = (((await db.spendBreaker.findMany({ where: { state: "tripped", autoClearAt: { lte: now } }, take: Math.min(opts.limit ?? 200, 1_000) })) ?? []) as Record<string, unknown>[]).map(toBreakerRow);
  let cleared = 0;
  for (const row of due) {
    const out = await clearBreaker({ id: row.id }, { db: opts.db, now, reason: "Cleared automatically." });
    if (out.cleared) cleared++;
  }
  return cleared;
}
