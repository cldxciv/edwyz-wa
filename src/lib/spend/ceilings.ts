/**
 * Platform ceilings (SpendCeiling, docs/SPEND-CONTROLS-SPEC.md 3.2, 4.4, 8.3).
 *
 * Scopes: `platform` (scopeId '*'), `probation` (the new-workspace limits, scopeId '*'), `plan` (scopeId Plan.id) and
 * `tenant` (an admin override for one workspace, scopeId Tenant.id, optionally expiring).
 *
 * The ceiling of a pot is the unexpired `tenant` override when one exists (it replaces everything else, so it can raise above
 * the plan and the new-workspace limits or cut below the owner's limit). Otherwise it is min(platform, plan, probation when
 * it is on). Each source resolves to the pot currency through its row in that currency, then its INR row converted at a fresh
 * rate (rounded down), then UNKNOWN. A source with no rows for the pot sets no ceiling. Null on a period means "no ceiling
 * for that period from this source".
 *
 * MAX_DAILY_BUDGET_MINOR (deprecated) is read as an INR `platform` daily ads ceiling of ceil175(value): it used to bound the
 * nominal sum of daily budgets, and this keeps that meaning under the worst-case maths (4.4, the same rule as the backfill).
 */
import { prisma } from "@/lib/db";
import { HttpError } from "@/lib/tenancy";
import { applyLedgered, PLATFORM_LEDGER_TENANT, requirePlatformAdmin, requireReason, type SpendDb } from "./control";
import { legacyMaxDailyBudgetMinor } from "./flags";
import { convertFromInr, FX_BASE, readFx, type FxTable } from "./fx";
import { CRD, fitsStoredMinor, isCurrencyCode, minLimit } from "./money";
import type { CeilingScope, Pot, SpendActor } from "./types";

export const PLATFORM_SCOPE_ID = "*";
const SCOPES: readonly CeilingScope[] = ["platform", "probation", "plan", "tenant"];
const POT_SET: readonly Pot[] = ["ads", "messaging", "ai"];

export type CeilingRow = {
  id: string;
  scope: CeilingScope;
  scopeId: string;
  pot: Pot;
  currency: string;
  dailyMinor: bigint | null;
  monthlyMinor: bigint | null;
  reason: string | null;
  setByUserId: string | null;
  expiresAt: Date | null;
  createdAt: Date | null;
  updatedAt: Date | null;
};

/** How one source's ceiling was found in the pot currency. */
export type CeilingVia = "row" | "fx" | "none" | "unknown";

export type SourceCeiling = {
  source: CeilingScope;
  daily: bigint | null;
  monthly: bigint | null;
  /** The source has rows for the pot, but none usable in this currency (no row, no fresh rate). */
  unknown: boolean;
  via: CeilingVia;
  expiresAt: Date | null;
  rowIds: string[];
};

export type ResolvedCeiling = {
  daily: bigint | null;
  monthly: bigint | null;
  dailySource: CeilingScope | null;
  monthlySource: CeilingScope | null;
  /** The source that sets the monthly ceiling, else the daily one; null when nothing sets a ceiling. */
  source: CeilingScope | null;
  /** The override's end, when the tenant override is what applies. */
  expiresAt: Date | null;
  unknown: boolean;
  /** True when an unexpired tenant override replaced the other sources. */
  override: boolean;
  sources: SourceCeiling[];
};

const big = (v: unknown): bigint | null => (v === null || v === undefined ? null : typeof v === "bigint" ? v : BigInt(v as number | string));
const date = (v: unknown): Date | null => (v instanceof Date ? v : v ? new Date(String(v)) : null);

export function toCeilingRow(raw: Record<string, unknown>): CeilingRow {
  return {
    id: String(raw.id),
    scope: raw.scope as CeilingScope,
    scopeId: String(raw.scopeId),
    pot: raw.pot as Pot,
    currency: String(raw.currency),
    dailyMinor: big(raw.dailyMinor),
    monthlyMinor: big(raw.monthlyMinor),
    reason: (raw.reason as string | null) ?? null,
    setByUserId: (raw.setByUserId as string | null) ?? null,
    expiresAt: date(raw.expiresAt),
    createdAt: date(raw.createdAt),
    updatedAt: date(raw.updatedAt),
  };
}

/** Integer worst case of a daily budget: ceil(1.75 x). The same rule as worstcase.ts and the 0009 backfill. */
function ceil175(x: bigint): bigint {
  return (7n * x + 3n) / 4n;
}

/** The deprecated env ceiling as an INR platform daily ads ceiling: ceil175(MAX_DAILY_BUDGET_MINOR), or null when unset. */
export function legacyPlatformDailyCeiling(env: Record<string, string | undefined> = process.env): bigint | null {
  const value = legacyMaxDailyBudgetMinor(env);
  return value === null ? null : ceil175(value);
}

/**
 * One source's rows (one scope, one pot) resolved to `currency`: the row in that currency; else the INR row converted at a
 * fresh rate, rounded down (each period on its own, null stays null); else UNKNOWN when the source has rows at all.
 */
export function resolveSourceRows(source: CeilingScope, rows: CeilingRow[], currency: string, fx: FxTable, now: Date): SourceCeiling {
  const ids = rows.map((r) => r.id);
  const expiresAt = rows.reduce<Date | null>((min, r) => (r.expiresAt && (!min || r.expiresAt < min) ? r.expiresAt : min), null);
  if (rows.length === 0) return { source, daily: null, monthly: null, unknown: false, via: "none", expiresAt: null, rowIds: [] };
  const exact = rows.find((r) => r.currency === currency);
  if (exact) return { source, daily: exact.dailyMinor, monthly: exact.monthlyMinor, unknown: false, via: "row", expiresAt: exact.expiresAt, rowIds: [exact.id] };
  const inr = rows.find((r) => r.currency === FX_BASE);
  if (inr && currency !== CRD) {
    const convert = (v: bigint | null): { ok: boolean; value: bigint | null } => {
      if (v === null) return { ok: true, value: null };
      const c = convertFromInr(v, currency, fx, now);
      return { ok: c !== null, value: c };
    };
    const d = convert(inr.dailyMinor);
    const m = convert(inr.monthlyMinor);
    if (d.ok && m.ok) return { source, daily: d.value, monthly: m.value, unknown: false, via: "fx", expiresAt: inr.expiresAt, rowIds: [inr.id] };
  }
  return { source, daily: null, monthly: null, unknown: true, via: "unknown", expiresAt, rowIds: ids };
}

/** min over sources, period by period, remembering which source set each period. */
export function combineSources(sources: SourceCeiling[], override: boolean): ResolvedCeiling {
  let daily: bigint | null = null;
  let monthly: bigint | null = null;
  let dailySource: CeilingScope | null = null;
  let monthlySource: CeilingScope | null = null;
  for (const s of sources) {
    if (s.daily !== null && (daily === null || s.daily < daily)) {
      daily = s.daily;
      dailySource = s.source;
    }
    if (s.monthly !== null && (monthly === null || s.monthly < monthly)) {
      monthly = s.monthly;
      monthlySource = s.source;
    }
  }
  const tenant = sources.find((s) => s.source === "tenant");
  return {
    daily,
    monthly,
    dailySource,
    monthlySource,
    source: monthlySource ?? dailySource,
    expiresAt: override ? (tenant?.expiresAt ?? null) : null,
    unknown: sources.some((s) => s.unknown),
    override,
    sources,
  };
}

/** The plan whose ceilings apply: the subscription's plan, or the `trial` plan while trialing; none when billing-exempt. */
export type SpendPlan = { planId: string | null; code: string | null; aiCreditsMonthly: number | null; trialing: boolean; billingExempt: boolean };

/**
 * Mirrors billing/limits.ts resolvePlanLimits with flat reads (safe inside a transaction): suspended keeps the subscription's
 * plan; billing-exempt has none; a subscription gives its plan whatever its status; otherwise an unexpired trial gives `trial`.
 */
export async function resolveSpendPlan(tenantId: string, db: SpendDb = prisma, now: Date = new Date()): Promise<SpendPlan> {
  const tenant = (await db.tenant.findUnique({ where: { id: tenantId }, select: { status: true, billingExempt: true, trialEndsAt: true } })) as
    | { status?: string; billingExempt?: boolean; trialEndsAt?: Date | null }
    | null;
  const sub = (await db.subscription.findUnique({ where: { tenantId }, select: { planId: true } })) as { planId?: string } | null;
  const billingExempt = tenant?.billingExempt === true;
  const suspended = tenant?.status === "suspended";
  let planId: string | null = null;
  let trialing = false;
  if (suspended) planId = sub?.planId ?? null;
  else if (billingExempt) planId = null;
  else if (sub?.planId) planId = sub.planId;
  else if (tenant?.trialEndsAt instanceof Date && tenant.trialEndsAt.getTime() > now.getTime()) trialing = true;
  const plan = (planId
    ? await db.plan.findUnique({ where: { id: planId }, select: { id: true, code: true, aiCreditsMonthly: true } })
    : trialing
      ? await db.plan.findUnique({ where: { code: "trial" }, select: { id: true, code: true, aiCreditsMonthly: true } })
      : null) as { id?: string; code?: string; aiCreditsMonthly?: number | null } | null;
  return {
    planId: plan?.id ?? planId,
    code: plan?.code ?? null,
    aiCreditsMonthly: typeof plan?.aiCreditsMonthly === "number" ? plan.aiCreditsMonthly : null,
    trialing,
    billingExempt,
  };
}

export type ResolveCeilingInput = {
  tenantId: string;
  pot: Pot;
  currency: string;
  planId: string | null;
  probationOn: boolean;
  now?: Date;
  db?: SpendDb;
  fx?: FxTable;
  env?: Record<string, string | undefined>;
};

/** The ceiling of one pot in one currency (4.4). */
export async function resolveCeiling(input: ResolveCeilingInput): Promise<ResolvedCeiling> {
  const db = input.db ?? prisma;
  const now = input.now ?? new Date();
  const scopes: { scope: CeilingScope; scopeId: string }[] = [
    { scope: "tenant", scopeId: input.tenantId },
    { scope: "platform", scopeId: PLATFORM_SCOPE_ID },
    { scope: "probation", scopeId: PLATFORM_SCOPE_ID },
    ...(input.planId ? [{ scope: "plan" as const, scopeId: input.planId }] : []),
  ];
  const rows = (((await db.spendCeiling.findMany({ where: { pot: input.pot, OR: scopes } })) ?? []) as Record<string, unknown>[]).map(toCeilingRow);
  const fx = input.fx ?? (await readFx(db));
  const of = (scope: CeilingScope) => rows.filter((r) => r.scope === scope);
  const tenantRows = of("tenant").filter((r) => !r.expiresAt || r.expiresAt.getTime() > now.getTime());
  if (tenantRows.length > 0) return combineSources([resolveSourceRows("tenant", tenantRows, input.currency, fx, now)], true);

  // The deprecated env ceiling joins the platform INR row (ads, daily only).
  const platformRows = of("platform");
  const legacy = input.pot === "ads" ? legacyPlatformDailyCeiling(input.env) : null;
  if (legacy !== null) {
    const inr = platformRows.find((r) => r.currency === FX_BASE);
    if (inr) inr.dailyMinor = minLimit(inr.dailyMinor, legacy);
    else platformRows.push({ id: "env:MAX_DAILY_BUDGET_MINOR", scope: "platform", scopeId: PLATFORM_SCOPE_ID, pot: "ads", currency: FX_BASE, dailyMinor: legacy, monthlyMinor: null, reason: "MAX_DAILY_BUDGET_MINOR", setByUserId: null, expiresAt: null, createdAt: null, updatedAt: null });
  }
  const sources = [resolveSourceRows("platform", platformRows, input.currency, fx, now)];
  if (input.planId) sources.push(resolveSourceRows("plan", of("plan"), input.currency, fx, now));
  if (input.probationOn) sources.push(resolveSourceRows("probation", of("probation"), input.currency, fx, now));
  return combineSources(sources, false);
}

// ===== Admin panel writers (platform admin, ledgered) =====

export type CeilingInput = {
  scope: CeilingScope;
  /** '*' for platform and probation (filled in when omitted), the Plan id, or the Tenant id. */
  scopeId?: string;
  pot: Pot;
  currency: string;
  dailyMinor: bigint | null;
  monthlyMinor: bigint | null;
  /** Tenant overrides only. */
  expiresAt?: Date | null;
};

function checkScope(scope: CeilingScope, scopeId: string | undefined): string {
  if (!SCOPES.includes(scope)) throw new HttpError(400, "Choose platform, new-workspace, plan or workspace.");
  if (scope === "platform" || scope === "probation") return PLATFORM_SCOPE_ID;
  if (!scopeId || scopeId === PLATFORM_SCOPE_ID) throw new HttpError(400, scope === "plan" ? "Choose a plan." : "Choose a workspace.");
  return scopeId;
}

function checkAmount(value: bigint | null, label: string): bigint | null {
  if (value === null) return null;
  if (typeof value !== "bigint" || value < 0n || !fitsStoredMinor(value)) throw new HttpError(400, `Enter the ${label} as zero or more, or leave it empty for Not set.`);
  return value;
}

/** The ledger workspace of a ceiling change: the workspace for an override, the platform ledger otherwise. */
const ledgerTenantOf = (scope: CeilingScope, scopeId: string) => (scope === "tenant" ? scopeId : PLATFORM_LEDGER_TENANT);

const undoOf = (row: CeilingRow | null, key: { scope: CeilingScope; scopeId: string; pot: Pot; currency: string }) =>
  row
    ? { action: "set_ceiling", ...key, dailyMinor: row.dailyMinor?.toString() ?? null, monthlyMinor: row.monthlyMinor?.toString() ?? null, expiresAt: row.expiresAt?.toISOString() ?? null }
    : { action: "clear_ceiling", ...key };

/**
 * set_spend_ceiling, the new-workspace and platform forms, and plan ceilings (PlanForm): upserts one row per
 * (scope, scopeId, pot, currency). The AI pot is in credits (CRD). Ledgered as `ceiling.change`.
 */
export async function setCeiling(input: CeilingInput, actor: SpendActor, reason: string, opts: { db?: SpendDb; now?: Date } = {}): Promise<CeilingRow> {
  requirePlatformAdmin(actor);
  const why = requireReason(reason);
  const scopeId = checkScope(input.scope, input.scopeId);
  if (!POT_SET.includes(input.pot)) throw new HttpError(400, "Choose ads, WhatsApp or AI.");
  const currency = (input.currency ?? "").toUpperCase();
  if (!isCurrencyCode(currency)) throw new HttpError(400, "Use a three-letter currency code such as INR.");
  if ((input.pot === "ai") !== (currency === CRD)) throw new HttpError(400, input.pot === "ai" ? "AI limits are in credits (CRD)." : "Credits (CRD) are only for AI limits.");
  const dailyMinor = checkAmount(input.dailyMinor, "daily limit");
  const monthlyMinor = checkAmount(input.monthlyMinor, "monthly limit");
  const now = opts.now ?? new Date();
  const expiresAt = input.expiresAt ?? null;
  if (expiresAt && input.scope !== "tenant") throw new HttpError(400, "Only a workspace override can have an end date.");
  if (expiresAt && expiresAt.getTime() <= now.getTime()) throw new HttpError(400, "Choose an end date in the future.");
  const key = { scope: input.scope, scopeId, pot: input.pot, currency };
  const { result } = await applyLedgered(opts.db, async (tx) => {
    const whereKey = { scope_scopeId_pot_currency: key };
    const before = (await tx.spendCeiling.findUnique({ where: whereKey })) as Record<string, unknown> | null;
    const data = { dailyMinor, monthlyMinor, expiresAt, reason: why, setByUserId: actor.userId };
    const saved = (await tx.spendCeiling.upsert({ where: whereKey, create: { ...key, ...data }, update: data })) as Record<string, unknown>;
    const prev = before ? toCeilingRow(before) : null;
    return {
      result: toCeilingRow(saved),
      row: {
        tenantId: ledgerTenantOf(input.scope, scopeId),
        pot: input.pot,
        action: "ceiling.change",
        actor,
        reason: why,
        reasonCodes: [`ceiling_${input.scope}`],
        targetType: "ceiling",
        targetId: `${input.scope}:${scopeId}`,
        currency,
        before: prev ? { dailyMinor: prev.dailyMinor, monthlyMinor: prev.monthlyMinor, expiresAt: prev.expiresAt } : null,
        after: { dailyMinor, monthlyMinor, expiresAt },
        undo: undoOf(prev, key),
      },
    };
  });
  return result;
}

/** clear_spend_ceiling: removes the rows of one scope and pot (one currency, or all of them). Ledgered as `ceiling.change`. */
export async function clearCeiling(
  input: { scope: CeilingScope; scopeId?: string; pot: Pot; currency?: string },
  actor: SpendActor,
  reason: string,
  opts: { db?: SpendDb } = {},
): Promise<{ deleted: number }> {
  requirePlatformAdmin(actor);
  const why = requireReason(reason);
  const scopeId = checkScope(input.scope, input.scopeId);
  const currency = input.currency ? input.currency.toUpperCase() : undefined;
  const { result } = await applyLedgered(opts.db, async (tx) => {
    const where = { scope: input.scope, scopeId, pot: input.pot, ...(currency ? { currency } : {}) };
    const rows = (((await tx.spendCeiling.findMany({ where })) ?? []) as Record<string, unknown>[]).map(toCeilingRow);
    if (rows.length === 0) return { result: { deleted: 0 }, row: null };
    await tx.spendCeiling.deleteMany({ where });
    return {
      result: { deleted: rows.length },
      row: {
        tenantId: ledgerTenantOf(input.scope, scopeId),
        pot: input.pot,
        action: "ceiling.change",
        actor,
        reason: why,
        reasonCodes: [`ceiling_${input.scope}`, "cleared"],
        targetType: "ceiling",
        targetId: `${input.scope}:${scopeId}`,
        currency: currency ?? null,
        before: rows.map((r) => ({ currency: r.currency, dailyMinor: r.dailyMinor, monthlyMinor: r.monthlyMinor, expiresAt: r.expiresAt })),
        after: null,
        undo: { action: "restore_ceilings", rows: rows.map((r) => undoOf(r, { scope: r.scope, scopeId: r.scopeId, pot: r.pot, currency: r.currency })) },
      },
    };
  });
  return result;
}

/** Rows for the admin forms ("Limits for new workspaces", "Platform ceilings", plan ceilings, a workspace's overrides). */
export async function listCeilings(filter: { scope?: CeilingScope; scopeId?: string; pot?: Pot } = {}, db: SpendDb = prisma): Promise<CeilingRow[]> {
  const where: Record<string, unknown> = {};
  if (filter.scope) where.scope = filter.scope;
  if (filter.scopeId) where.scopeId = filter.scopeId;
  if (filter.pot) where.pot = filter.pot;
  const rows = ((await db.spendCeiling.findMany({ where, orderBy: [{ scope: "asc" }, { pot: "asc" }, { currency: "asc" }] })) ?? []) as Record<string, unknown>[];
  return rows.map(toCeilingRow);
}
