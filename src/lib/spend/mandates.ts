/**
 * Assistant mandates (docs/SPEND-CONTROLS-SPEC.md 2.2, 2.3.10, 7.2, 7.5, 8.1, 8.3; 12.1a decision 5).
 *
 * - A missing AssistantMandate row means enabled false and level 0: the assistant only makes suggestions, which is today's
 *   optimizer behaviour (2.3.10). Reads never create a row.
 * - Who changes what: the owner raises a level, a mandate ceiling, the allowed ops or switches an assistant on; the owner or an
 *   admin lowers them (8.1); a platform admin can only lower (lowerMandate, 8.3 `lower_assistant_level`). The target cost per
 *   lead is the owner's setting. Every change writes a `mandate.change` pair in the ledger, with an undo recipe.
 * - The learning period (shadow, 7.5) starts on the FIRST enable of (workspace, assistant): shadowUntil = that moment + 14 days.
 *   Re-enabling a disabled mandate does not restart it.
 * - The effective level is 0 while the mandate is off, while it is learning, and while ASSISTANT_SPEND_ENABLED=false (decision
 *   5: every assistant stays at Level 0 until the owner has run the V1-V9 runbook). The configured level is kept and shown.
 * - The effective ceilings are min(mandate, allowance): a mandate can only narrow what the owner's limits allow.
 * - assistantContext() gathers, once, everything policy.ts decide() needs for one assistant in one workspace (the optimizer's
 *   daily run passes every proposal through it).
 */
import { prisma } from "@/lib/db";
import { HttpError } from "@/lib/tenancy";
import { effectiveLimits } from "./allowances";
import { adsHeadroomDetail } from "./book";
import { listBreakers, type BreakerRow, type BreakerScopeRef, isOpen } from "./breakers/state";
import { applyLedgered, getControl, requireReason, type SpendControlState, type SpendDb } from "./control";
import { assistantSpendEnabled } from "./flags";
import { minLimit, toMoneyDTOOrNull } from "./money";
import { dayKey } from "./periods";
import { decide, type PolicyDecision, type PolicyDelta, type PolicyHeadroom, type PolicyIntent, type PolicyMandate } from "./policy";
import {
  ASSISTANTS,
  APPROVAL_SHARE_PCT_RANGE,
  getAssistant,
  LEVEL_OPTIONS,
  MANDATE_DEFAULTS,
  RAISE_STEP_PCT_RANGE,
  sanitizeAllowedOps,
  type AssistantDefinition,
} from "./registry";
import { shadowSummary } from "./shadow";
import type { AssistantDTO, AutonomyLevel, LedgerRowInput, MandateDTO, Pot, SpendActor, SpendRole } from "./types";

type Env = Record<string, string | undefined>;

export const SHADOW_DAYS = MANDATE_DEFAULTS.shadowDays;
const DAY_MS = 86_400_000;

/** A mandate as the book and the UI read it; `exists` is false for the defaults of a missing row. */
export type MandateState = {
  tenantId: string;
  assistantKey: string;
  exists: boolean;
  enabled: boolean;
  level: AutonomyLevel;
  allowedOps: string[];
  maxDailyMinor: bigint | null;
  maxMonthlyMinor: bigint | null;
  currency: string | null;
  targetCostPerLeadMinor: bigint | null;
  raiseStepPct: number;
  approvalSharePct: number;
  shadowStartedAt: Date | null;
  shadowUntil: Date | null;
  sandboxOnly: boolean;
  version: number;
  updatedAt: Date | null;
  updatedByUserId: string | null;
};

const big = (v: unknown): bigint | null => (v === null || v === undefined ? null : typeof v === "bigint" ? v : BigInt(v as number | string));
const date = (v: unknown): Date | null => (v instanceof Date ? v : v ? new Date(String(v)) : null);
const toLevel = (v: unknown): AutonomyLevel => (Number(v) === 1 ? 1 : Number(v) === 2 ? 2 : 0);

function knownAssistant(assistantKey: string): AssistantDefinition {
  const a = getAssistant(assistantKey);
  if (!a) throw new HttpError(404, "That assistant does not exist.");
  return a;
}

/** The defaults of a workspace with no mandate row: off, Level 0, suggestions only (2.2, 2.3.10). */
export function defaultMandate(tenantId: string, assistantKey: string): MandateState {
  return {
    tenantId,
    assistantKey,
    exists: false,
    enabled: false,
    level: MANDATE_DEFAULTS.level,
    allowedOps: [],
    maxDailyMinor: null,
    maxMonthlyMinor: null,
    currency: null,
    targetCostPerLeadMinor: null,
    raiseStepPct: MANDATE_DEFAULTS.raiseStepPct,
    approvalSharePct: MANDATE_DEFAULTS.approvalSharePct,
    shadowStartedAt: null,
    shadowUntil: null,
    sandboxOnly: false,
    version: 0,
    updatedAt: null,
    updatedByUserId: null,
  };
}

export function toMandateState(row: Record<string, unknown>): MandateState {
  const key = String(row.assistantKey);
  return {
    tenantId: String(row.tenantId),
    assistantKey: key,
    exists: true,
    enabled: row.enabled === true,
    level: toLevel(row.level),
    allowedOps: sanitizeAllowedOps(key, Array.isArray(row.allowedOps) ? (row.allowedOps as string[]) : []),
    maxDailyMinor: big(row.maxDailyMinor),
    maxMonthlyMinor: big(row.maxMonthlyMinor),
    currency: typeof row.currency === "string" ? row.currency : null,
    targetCostPerLeadMinor: big(row.targetCostPerLeadMinor),
    raiseStepPct: Number.isFinite(Number(row.raiseStepPct)) ? Number(row.raiseStepPct) : MANDATE_DEFAULTS.raiseStepPct,
    approvalSharePct: Number.isFinite(Number(row.approvalSharePct)) ? Number(row.approvalSharePct) : MANDATE_DEFAULTS.approvalSharePct,
    shadowStartedAt: date(row.shadowStartedAt),
    shadowUntil: date(row.shadowUntil),
    sandboxOnly: row.sandboxOnly === true,
    version: Number.isInteger(Number(row.version)) ? Number(row.version) : 1,
    updatedAt: date(row.updatedAt),
    updatedByUserId: (row.updatedByUserId as string | null) ?? null,
  };
}

async function readRow(db: SpendDb, tenantId: string, assistantKey: string): Promise<Record<string, unknown> | null> {
  return (await db.assistantMandate.findFirst({ where: { tenantId, assistantKey } })) as Record<string, unknown> | null;
}

/** The mandate of one assistant, or its defaults when there is no row. Never writes. */
export async function getMandate(tenantId: string, assistantKey: string, opts: { db?: SpendDb } = {}): Promise<MandateState> {
  knownAssistant(assistantKey);
  const row = await readRow(opts.db ?? prisma, tenantId, assistantKey);
  return row ? toMandateState(row) : defaultMandate(tenantId, assistantKey);
}

/** Every registered assistant's mandate, in registry order. */
export async function listMandates(tenantId: string, opts: { db?: SpendDb } = {}): Promise<MandateState[]> {
  const db = opts.db ?? prisma;
  const rows = ((await db.assistantMandate.findMany({ where: { tenantId } })) ?? []) as Record<string, unknown>[];
  return ASSISTANTS.map((a) => {
    const row = rows.find((r) => r.assistantKey === a.key);
    return row ? toMandateState(row) : defaultMandate(tenantId, a.key);
  });
}

/** True while the assistant is in its learning period (7.5). */
export function isLearning(m: Pick<MandateState, "shadowUntil">, now: Date = new Date()): boolean {
  return !!m.shadowUntil && m.shadowUntil.getTime() > now.getTime();
}

/** The level the assistant acts at now: 0 when off, while learning, or while ASSISTANT_SPEND_ENABLED is not true. */
export function effectiveLevel(m: Pick<MandateState, "enabled" | "level" | "shadowUntil">, opts: { now?: Date; env?: Env } = {}): AutonomyLevel {
  if (!m.enabled || isLearning(m, opts.now ?? new Date()) || !assistantSpendEnabled(opts.env ?? process.env)) return 0;
  return m.level;
}

/** min(mandate, allowance) for each period; null only when neither sets one. */
export function effectiveMandateCeilings(m: Pick<MandateState, "maxDailyMinor" | "maxMonthlyMinor">, limits: { daily: bigint | null; monthly: bigint | null }): { daily: bigint | null; monthly: bigint | null } {
  return { daily: minLimit(m.maxDailyMinor, limits.daily), monthly: minLimit(m.maxMonthlyMinor, limits.monthly) };
}

/** The mandate as policy.ts reads it; null without a row (suggestions only). */
export function toPolicyMandate(m: MandateState): PolicyMandate | null {
  if (!m.exists) return null;
  return {
    enabled: m.enabled,
    level: m.level,
    allowedOps: m.allowedOps,
    maxDailyMinor: m.maxDailyMinor,
    maxMonthlyMinor: m.maxMonthlyMinor,
    targetCostPerLeadMinor: m.targetCostPerLeadMinor,
    raiseStepPct: m.raiseStepPct,
    approvalSharePct: m.approvalSharePct,
    shadowUntil: m.shadowUntil,
    sandboxOnly: m.sandboxOnly,
  };
}

// =====================================================================================================================
// Changes: who may do what (8.1)
// =====================================================================================================================

export type MandatePatch = {
  enabled?: boolean;
  level?: number;
  allowedOps?: string[];
  maxDailyMinor?: bigint | null;
  maxMonthlyMinor?: bigint | null;
  targetCostPerLeadMinor?: bigint | null;
  raiseStepPct?: number;
  approvalSharePct?: number;
  sandboxOnly?: boolean;
};

export type MandateField = keyof MandatePatch;
/** raise: gives the assistant more room; lower: less; owner_only: a setting only the owner changes; same: no change. */
export type MandateChangeKind = "raise" | "lower" | "owner_only" | "same";
export type MandateFieldChange = { field: MandateField; from: unknown; to: unknown; kind: MandateChangeKind };
export type MandateChange = { fields: MandateFieldChange[]; changed: boolean; raises: boolean; lowers: boolean; ownerOnly: boolean };

/** A ceiling: null means "no own ceiling" (only the owner's limits apply), which is more room than any number. */
function ceilingKind(from: bigint | null, to: bigint | null): MandateChangeKind {
  if (from === to) return "same";
  if (to === null) return "raise";
  if (from === null) return "lower";
  return to > from ? "raise" : "lower";
}

function intIn(value: unknown, range: { min: number; max: number }, what: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < range.min || value > range.max) {
    throw new HttpError(400, `${what} must be a whole number from ${range.min} to ${range.max}.`);
  }
  return value;
}

function positiveOrNull(value: bigint | null | undefined, what: string): bigint | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== "bigint" || value <= 0n) throw new HttpError(400, `Enter ${what} above zero, or leave it empty.`);
  return value;
}

/** Validates a patch against the registry and the 2.2 ranges. Throws HttpError(400) with a plain sentence. */
export function normalizeMandatePatch(assistantKey: string, patch: MandatePatch): MandatePatch {
  knownAssistant(assistantKey);
  const out: MandatePatch = {};
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== "boolean") throw new HttpError(400, "Choose on or off for the assistant.");
    out.enabled = patch.enabled;
  }
  if (patch.level !== undefined) out.level = intIn(patch.level, { min: 0, max: 2 }, "The level");
  if (patch.allowedOps !== undefined) {
    if (!Array.isArray(patch.allowedOps) || patch.allowedOps.some((o) => typeof o !== "string")) throw new HttpError(400, "Choose what the assistant may do from the list.");
    const clean = sanitizeAllowedOps(assistantKey, patch.allowedOps);
    if (clean.length !== new Set(patch.allowedOps).size) throw new HttpError(400, "That assistant cannot do one of the chosen things.");
    out.allowedOps = clean;
  }
  if (patch.maxDailyMinor !== undefined) out.maxDailyMinor = positiveOrNull(patch.maxDailyMinor, "the most it can spend a day");
  if (patch.maxMonthlyMinor !== undefined) out.maxMonthlyMinor = positiveOrNull(patch.maxMonthlyMinor, "the most it can spend a month");
  if (patch.targetCostPerLeadMinor !== undefined) out.targetCostPerLeadMinor = positiveOrNull(patch.targetCostPerLeadMinor, "a target cost per lead");
  if (patch.raiseStepPct !== undefined) out.raiseStepPct = intIn(patch.raiseStepPct, RAISE_STEP_PCT_RANGE, "The daily raise step");
  if (patch.approvalSharePct !== undefined) out.approvalSharePct = intIn(patch.approvalSharePct, APPROVAL_SHARE_PCT_RANGE, "The approval share");
  if (patch.sandboxOnly !== undefined) {
    if (typeof patch.sandboxOnly !== "boolean") throw new HttpError(400, "Choose whether the assistant acts only on test ad accounts.");
    out.sandboxOnly = patch.sandboxOnly;
  }
  return out;
}

/** Field by field: does the patch give the assistant more room (raise), less (lower), or touch an owner-only setting? Pure. */
export function classifyMandateChange(current: MandateState, patch: MandatePatch): MandateChange {
  const fields: MandateFieldChange[] = [];
  const add = (field: MandateField, from: unknown, to: unknown, kind: MandateChangeKind) => fields.push({ field, from, to, kind });
  if (patch.enabled !== undefined) add("enabled", current.enabled, patch.enabled, patch.enabled === current.enabled ? "same" : patch.enabled ? "raise" : "lower");
  if (patch.level !== undefined) add("level", current.level, patch.level, patch.level === current.level ? "same" : patch.level > current.level ? "raise" : "lower");
  if (patch.allowedOps !== undefined) {
    const before = new Set(current.allowedOps);
    const after = new Set(patch.allowedOps);
    const added = [...after].some((o) => !before.has(o));
    const removed = [...before].some((o) => !after.has(o));
    add("allowedOps", current.allowedOps, patch.allowedOps, added ? "raise" : removed ? "lower" : "same");
  }
  if (patch.maxDailyMinor !== undefined) add("maxDailyMinor", current.maxDailyMinor, patch.maxDailyMinor, ceilingKind(current.maxDailyMinor, patch.maxDailyMinor));
  if (patch.maxMonthlyMinor !== undefined) add("maxMonthlyMinor", current.maxMonthlyMinor, patch.maxMonthlyMinor, ceilingKind(current.maxMonthlyMinor, patch.maxMonthlyMinor));
  if (patch.targetCostPerLeadMinor !== undefined) add("targetCostPerLeadMinor", current.targetCostPerLeadMinor, patch.targetCostPerLeadMinor, current.targetCostPerLeadMinor === patch.targetCostPerLeadMinor ? "same" : "owner_only");
  if (patch.raiseStepPct !== undefined) add("raiseStepPct", current.raiseStepPct, patch.raiseStepPct, patch.raiseStepPct === current.raiseStepPct ? "same" : patch.raiseStepPct > current.raiseStepPct ? "raise" : "lower");
  if (patch.approvalSharePct !== undefined) add("approvalSharePct", current.approvalSharePct, patch.approvalSharePct, patch.approvalSharePct === current.approvalSharePct ? "same" : patch.approvalSharePct > current.approvalSharePct ? "raise" : "lower");
  if (patch.sandboxOnly !== undefined) add("sandboxOnly", current.sandboxOnly, patch.sandboxOnly, patch.sandboxOnly === current.sandboxOnly ? "same" : patch.sandboxOnly ? "lower" : "raise");
  const real = fields.filter((f) => f.kind !== "same");
  return { fields, changed: real.length > 0, raises: real.some((f) => f.kind === "raise"), lowers: real.some((f) => f.kind === "lower"), ownerOnly: real.some((f) => f.kind === "owner_only") };
}

export const MANDATE_OWNER_ONLY = "Only the owner can raise an assistant's level or limits. You can lower them.";
export const MANDATE_TARGET_OWNER_ONLY = "Only the owner can change the target cost per lead.";
export const MANDATE_MEMBER_DENIED = "Only the owner or an admin can change assistants.";
export const MANDATE_SUPPORT_LOWER_ONLY = "Edwyz support can only lower an assistant's level or limits.";

/** Who may make this change (8.1, 8.3). Throws the 403 to show. */
export function assertMayChangeMandate(actor: SpendActor, change: MandateChange): void {
  if (!change.changed) return;
  if (actor.type === "platform_admin") {
    if (change.raises || change.ownerOnly) throw new HttpError(403, MANDATE_SUPPORT_LOWER_ONLY);
    return;
  }
  if (actor.type !== "user") throw new HttpError(403, MANDATE_MEMBER_DENIED);
  if (actor.role === "owner") return;
  if (actor.role !== "admin") throw new HttpError(403, MANDATE_MEMBER_DENIED);
  if (change.ownerOnly) throw new HttpError(403, MANDATE_TARGET_OWNER_ONLY);
  if (change.raises) throw new HttpError(403, MANDATE_OWNER_ONLY);
}

export type UpdateMandateOptions = {
  db?: SpendDb;
  now?: Date;
  /** The version the caller last read (optimistic check); a different stored version is a 409. */
  expectedVersion?: number;
  reason?: string;
};

export type UpdateMandateResult = { mandate: MandateState; change: MandateChange; correlationId: string | null };

const VERSION_CONFLICT = "Someone else changed this assistant's settings. Reload to see the latest.";

function mandateSnapshot(m: MandateState): Record<string, unknown> {
  return {
    enabled: m.enabled,
    level: m.level,
    allowedOps: m.allowedOps,
    maxDailyMinor: m.maxDailyMinor,
    maxMonthlyMinor: m.maxMonthlyMinor,
    currency: m.currency,
    targetCostPerLeadMinor: m.targetCostPerLeadMinor,
    raiseStepPct: m.raiseStepPct,
    approvalSharePct: m.approvalSharePct,
    shadowUntil: m.shadowUntil,
    sandboxOnly: m.sandboxOnly,
  };
}

function changeReason(def: AssistantDefinition, change: MandateChange): string {
  const parts: string[] = [];
  for (const f of change.fields.filter((x) => x.kind !== "same")) {
    if (f.field === "enabled") parts.push(f.to ? "switched it on" : "switched it off");
    else if (f.field === "level") parts.push(`set its level to ${LEVEL_OPTIONS.find((o) => o.level === f.to)?.label ?? String(f.to)}`);
    else if (f.field === "allowedOps") parts.push("changed what it may do on its own");
    else if (f.field === "maxDailyMinor") parts.push("changed the most it can spend a day");
    else if (f.field === "maxMonthlyMinor") parts.push("changed the most it can spend a month");
    else if (f.field === "targetCostPerLeadMinor") parts.push("changed its target cost per lead");
    else if (f.field === "raiseStepPct") parts.push("changed how much it may raise a budget in a day");
    else if (f.field === "approvalSharePct") parts.push("changed when it needs approval");
    else if (f.field === "sandboxOnly") parts.push(f.to ? "limited it to test ad accounts" : "let it act on real ad accounts");
  }
  const text = parts.length ? parts.join(", ") : "changed its settings";
  return `${def.label}: ${text}.`;
}

/** The currency the assistant's ceilings are in: its pot's allowance currency, else the spending ad account's, else INR. */
async function potCurrency(tenantId: string, pot: Pot, db: SpendDb, control: SpendControlState): Promise<string> {
  try {
    return (await effectiveLimits(tenantId, pot, undefined, db, { control })).currency;
  } catch {
    return "INR";
  }
}

async function writeMandate(
  tenantId: string,
  assistantKey: string,
  patch: MandatePatch,
  actor: SpendActor,
  opts: UpdateMandateOptions,
): Promise<UpdateMandateResult> {
  const def = knownAssistant(assistantKey);
  const clean = normalizeMandatePatch(assistantKey, patch);
  const now = opts.now ?? new Date();
  let out: { mandate: MandateState; change: MandateChange } | null = null;
  const { correlationId } = await applyLedgered(opts.db, async (tx) => {
    const row = await readRow(tx, tenantId, assistantKey);
    const current = row ? toMandateState(row) : defaultMandate(tenantId, assistantKey);
    if (opts.expectedVersion !== undefined && opts.expectedVersion !== current.version) throw new HttpError(409, VERSION_CONFLICT);
    const change = classifyMandateChange(current, clean);
    assertMayChangeMandate(actor, change);
    if (!change.changed) {
      out = { mandate: current, change };
      return { result: null, row: null };
    }
    const next: MandateState = { ...current, ...clean } as MandateState;
    if (clean.level !== undefined) next.level = toLevel(clean.level);
    // Switched on for the first time: the learning period starts now, once per (workspace, assistant) (7.5).
    if (next.enabled && !current.shadowStartedAt) {
      next.shadowStartedAt = now;
      next.shadowUntil = new Date(now.getTime() + SHADOW_DAYS * DAY_MS);
    }
    // Switched on with nothing chosen: everything the assistant can do (the level still decides what needs approval).
    if (next.enabled && clean.allowedOps === undefined && current.allowedOps.length === 0) next.allowedOps = [...def.ops];
    if ((next.maxDailyMinor !== null || next.maxMonthlyMinor !== null || next.targetCostPerLeadMinor !== null) && !next.currency) {
      next.currency = await potCurrency(tenantId, def.pots[0], tx, await getControl(tenantId, { db: tx, prune: false }));
    }
    const userId = actor.type === "user" || actor.type === "platform_admin" ? actor.userId : null;
    const data = {
      enabled: next.enabled,
      level: next.level,
      allowedOps: next.allowedOps,
      maxDailyMinor: next.maxDailyMinor,
      maxMonthlyMinor: next.maxMonthlyMinor,
      currency: next.currency,
      targetCostPerLeadMinor: next.targetCostPerLeadMinor,
      raiseStepPct: next.raiseStepPct,
      approvalSharePct: next.approvalSharePct,
      shadowStartedAt: next.shadowStartedAt,
      shadowUntil: next.shadowUntil,
      sandboxOnly: next.sandboxOnly,
      updatedByUserId: userId,
    };
    if (row) {
      const { count } = await tx.assistantMandate.updateMany({ where: { tenantId, assistantKey, version: current.version }, data: { ...data, version: { increment: 1 } } });
      if (count !== 1) throw new HttpError(409, VERSION_CONFLICT);
    } else {
      const { count } = await tx.assistantMandate.createMany({ data: [{ tenantId, assistantKey, ...data, version: 1 }], skipDuplicates: true });
      if (count !== 1) throw new HttpError(409, VERSION_CONFLICT);
    }
    const stored = await readRow(tx, tenantId, assistantKey);
    const mandate = stored ? toMandateState(stored) : { ...next, exists: true, version: current.version + 1 };
    out = { mandate, change };
    const ledger: LedgerRowInput = {
      tenantId,
      pot: def.pots[0],
      action: "mandate.change",
      actor,
      reason: requireReason(opts.reason, changeReason(def, change)),
      reasonCodes: [change.raises ? "raise" : "lower", ...change.fields.filter((f) => f.kind !== "same").map((f) => f.field)],
      targetType: "assistant",
      targetId: assistantKey,
      currency: mandate.currency,
      before: mandateSnapshot(current),
      after: mandateSnapshot(mandate),
      undo: { action: "set_mandate", assistantKey, ...mandateSnapshot(current) },
    };
    return { result: null, row: ledger };
  });
  const done = out as { mandate: MandateState; change: MandateChange } | null;
  if (!done) throw new Error("[spend] mandate change produced no result");
  return { mandate: done.mandate, change: done.change, correlationId };
}

/**
 * Changes one assistant's mandate for a person (Settings > Spending limits, Assistants card). The owner may raise and lower;
 * an admin may only lower (8.1). Ledgered as `mandate.change`.
 */
export async function updateMandate(tenantId: string, assistantKey: string, patch: MandatePatch, actor: SpendActor, opts: UpdateMandateOptions = {}): Promise<UpdateMandateResult> {
  if (actor.type !== "user") throw new HttpError(403, MANDATE_MEMBER_DENIED);
  return writeMandate(tenantId, assistantKey, patch, actor, opts);
}

/**
 * A platform admin lowers an assistant's level or ceilings (8.3 `lower_assistant_level`), for example while a bug is
 * investigated. It can never raise. Ledgered as `mandate.change` with actorType platform_admin and the given reason.
 */
export async function lowerMandate(tenantId: string, assistantKey: string, patch: MandatePatch, actor: SpendActor, reason: string, opts: Omit<UpdateMandateOptions, "reason"> = {}): Promise<UpdateMandateResult> {
  if (actor.type !== "platform_admin") throw new HttpError(403, "Only Edwyz support can do this.");
  return writeMandate(tenantId, assistantKey, patch, actor, { ...opts, reason: requireReason(reason) });
}

// =====================================================================================================================
// DTOs (types.ts MandateDTO, AssistantDTO)
// =====================================================================================================================

export function toMandateDTO(m: MandateState, opts: { now?: Date; env?: Env; currency?: string } = {}): MandateDTO {
  const currency = m.currency ?? opts.currency ?? "INR";
  return {
    assistantKey: m.assistantKey,
    enabled: m.enabled,
    level: m.level,
    effectiveLevel: effectiveLevel(m, opts),
    allowedOps: [...m.allowedOps],
    maxDaily: toMoneyDTOOrNull(m.maxDailyMinor, currency),
    maxMonthly: toMoneyDTOOrNull(m.maxMonthlyMinor, currency),
    currency: m.currency,
    targetCostPerLead: toMoneyDTOOrNull(m.targetCostPerLeadMinor, currency),
    raiseStepPct: m.raiseStepPct,
    approvalSharePct: m.approvalSharePct,
    shadowStartedAt: m.shadowStartedAt?.toISOString() ?? null,
    shadowUntil: m.shadowUntil?.toISOString() ?? null,
    sandboxOnly: m.sandboxOnly,
    version: m.version,
    updatedAt: m.updatedAt?.toISOString() ?? null,
  };
}

/** The Assistants card for one viewer: every registered assistant, its mandate (null without a row) and its learning summary. */
export async function assistantDTOs(tenantId: string, role: SpendRole, opts: { db?: SpendDb; now?: Date; env?: Env } = {}): Promise<AssistantDTO[]> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const mandates = await listMandates(tenantId, { db });
  const out: AssistantDTO[] = [];
  for (const def of ASSISTANTS) {
    const m = mandates.find((x) => x.assistantKey === def.key) ?? defaultMandate(tenantId, def.key);
    out.push({
      assistantKey: def.key,
      label: def.label,
      pots: [...def.pots],
      phase: def.phase,
      mandate: m.exists ? toMandateDTO(m, { now, env: opts.env }) : null,
      shadow: await shadowSummary(tenantId, m, { db, now }),
      levelOptions: LEVEL_OPTIONS.map((o) => ({ level: o.level, label: o.label, description: o.description })),
      canRaise: role === "owner",
      canLower: role === "owner" || role === "admin",
    });
  }
  return out;
}

/** Plain line for the card while assistants are held at Level 0 (8.1). */
export const ASSISTANTS_SUGGEST_ONLY_TEXT = "Assistants only make suggestions for now.";

// =====================================================================================================================
// One assistant's policy inputs, gathered once (7.2; used by the optimizer's daily run)
// =====================================================================================================================

export type AssistantContext = {
  tenantId: string;
  assistantKey: string;
  mandate: MandateState;
  currency: string;
  now: Date;
  /** The figures decide() reads, before any action of this run. */
  headroom: PolicyHeadroom;
  /** The budget of an ad set at the start of its account day (Level 1's +20% is measured from it); null when unknown. */
  dayStartBudget(metaObjectId: string): bigint | null;
  /** The 7.2 decision for one intent, with the breakers on these scopes. */
  decide(intent: PolicyIntent, delta: PolicyDelta, scopes?: BreakerScopeRef[]): PolicyDecision;
};

/** Σ forecastMonth of this assistant's raises that ran without an approval in the last 24 h (anti-splitting, 2.3.9). */
export async function autoRaisesLast24h(tenantId: string, assistantKey: string, now: Date, db: SpendDb = prisma): Promise<bigint> {
  const rows = ((await db.spendLedger.findMany({
    where: { tenantId, phase: "requested", actorType: "assistant", assistantKey, approvalId: null, pot: "ads", createdAt: { gte: new Date(now.getTime() - DAY_MS) } },
    select: { forecastMonthMinor: true },
  })) ?? []) as { forecastMonthMinor: bigint | null }[];
  return rows.reduce((s, r) => s + (big(r.forecastMonthMinor) ?? 0n), 0n);
}

const BLOCKING = new Set(["pause_scope", "block_raises"]);

function onScope(b: BreakerRow, scopes: BreakerScopeRef[]): boolean {
  return b.scopeType === "workspace" || scopes.some((s) => s.scopeType === b.scopeType && s.scopeId === b.scopeId);
}

/**
 * Everything decide() needs for one ads assistant in one workspace, read once (headroom, freezes, breakers, the mandate, the
 * assistant's own use and its automatic raises of the last 24 h). The book runs the same checks again for anything applied.
 */
export async function assistantContext(tenantId: string, assistantKey: string, opts: { db?: SpendDb; now?: Date; env?: Env } = {}): Promise<AssistantContext> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const env = opts.env ?? process.env;
  const mandate = await getMandate(tenantId, assistantKey, { db });
  const detail = await adsHeadroomDetail(tenantId, { db, now, env, fresh: true });
  const { figures, state, limits } = detail;
  const breakers = (await listBreakers(tenantId, { db, now })).filter((b) => isOpen(b, now));
  const control = state.control;
  let ownToday = 0n;
  let ownMonth = 0n;
  for (const f of figures.perCommitment) {
    if (f.assistantKey !== assistantKey) continue;
    ownToday += (f.spentToday ?? 0n) + f.dayRisk;
    ownMonth += f.spentMonth + f.remainingMonth;
  }
  const autoRaises = mandate.enabled && mandate.level === 2 ? await autoRaisesLast24h(tenantId, assistantKey, now, db) : 0n;
  const headroom: PolicyHeadroom = {
    freeze: { workspace: detail.headroom.freeze.workspace, platform: detail.headroom.freeze.platform },
    blockingBreaker: false,
    breakerOnScope: false,
    dailyLimitMinor: limits.daily,
    monthlyLimitMinor: limits.monthly,
    dayLeftMinor: limits.daily === null ? null : limits.daily - figures.dayUse,
    monthLeftMinor: limits.monthly === null ? null : limits.monthly - figures.monthUse,
    metaLimitManaged: detail.headroom.metaLimit?.managed === true,
    sandbox: state.spendingAccount?.sandbox === true,
    targetCostPerLeadMinor: control.targetCostPerLeadMinor,
    autoRaisesLast24hMinor: autoRaises,
    assistantTodayMinor: ownToday,
    assistantMonthMinor: ownMonth,
  };
  const policyMandate = toPolicyMandate(mandate);
  const actor = { type: "assistant" as const, assistantKey };
  const enabled = assistantSpendEnabled(env);
  return {
    tenantId,
    assistantKey,
    mandate,
    currency: limits.currency,
    now,
    headroom,
    dayStartBudget(metaObjectId: string): bigint | null {
      const c = [...state.commitments, ...state.orphans].find((x) => x.metaObjectId === metaObjectId);
      if (!c) return null;
      return c.dayKey === dayKey(now, c.timezone) ? (c.dayStartBudgetMinor ?? c.dailyBudgetMinor) : c.dailyBudgetMinor;
    },
    decide(intent: PolicyIntent, delta: PolicyDelta, scopes: BreakerScopeRef[] = []): PolicyDecision {
      const hit = breakers.filter((b) => onScope(b, [...scopes, { scopeType: "assistant", scopeId: assistantKey }]));
      return decide(actor, intent, delta, policyMandate, { ...headroom, blockingBreaker: hit.some((b) => BLOCKING.has(b.effect)), breakerOnScope: hit.length > 0 }, now, { assistantSpendEnabled: enabled });
    },
  };
}
