/**
 * The owner's limits (SpendAllowance) and the effective limits of each pot (docs/SPEND-CONTROLS-SPEC.md 4.4, 8.1, 2.3.8).
 *
 * effectiveLimits(tenant, pot, currency?) = min(owner, ceiling) with the pot rules of 4.4:
 * - Ads: owner daily Not set means no ads can start, whatever the ceiling. Owner monthly Not set: the monthly ceiling applies
 *   if there is one; otherwise people are checked against the daily limit only and assistants are refused.
 * - WhatsApp and AI: owner Not set means the ceiling applies if one exists; otherwise people and existing automations are
 *   counted, not limited, and assistants are refused.
 * - AI monthly is never above the plan's aiCreditsMonthly (or AI_DEFAULT_MONTHLY_CREDITS), so it is never unlimited.
 * - An UNKNOWN ceiling (no row in the currency and no fresh rate) refuses assistants, and people while the new-workspace
 *   limits apply.
 * - Decision 2.3.8 ("in every pot, Not set means assistants are refused") is the stricter reading of 4.4 and wins: when the
 *   OWNER's monthly limit is Not set, assistants are refused in that pot even if a ceiling gives the pot a number (the
 *   new-workspace ceilings now cover all three pots, 12.1a decision 3). People are unaffected: for them the ceiling applies.
 *   This matches the 8.1 copy "assistants can't send until you set a limit".
 * Owner limits in another currency than the pot's do not apply (they read as Not set: the safe direction for ads), and the
 * caller refuses raises with spend.currency.
 *
 * setAllowances(): the per-field rule of 8.1 and decision 2.3.8. The owner raises, sets a number where it was Not set, clears
 * a number to Not set and changes the currency. Admins (and platform admins, lower_spend_limits) only lower a number that
 * exists. Anything else is 403 spend.only_owner_raise. An optimistic version gives 409 spend.version. Every attempt, allowed
 * or refused, writes a ledger row (allowance.change).
 */
import { defaultMonthlyCreditCeiling } from "@/lib/ai-agent/credits";
import { RATECARD_KEY } from "@/lib/admin/ratecard";
import { prisma } from "@/lib/db";
import { HttpError } from "@/lib/tenancy";
import { resolveCeiling, resolveSpendPlan, type ResolvedCeiling, type SpendPlan } from "./ceilings";
import { applyLedgered, getControl, type SpendControlState, type SpendDb } from "./control";
import type { SpendCopyCode } from "./copy";
import { SpendBlockedError } from "./errors";
import { appendStandalone } from "./ledger";
import { CRD, fitsStoredMinor, formatMinor, isCurrencyCode, minLimit } from "./money";
import { probationState, type ProbationState } from "./probation";
import type { EffectiveLimits, LimitBinding, Pot, SpendActor } from "./types";

export const DEFAULT_LIMIT_CURRENCY = "INR";
const POTS: readonly Pot[] = ["ads", "messaging", "ai"];

export type AllowanceRow = {
  id: string;
  tenantId: string;
  pot: Pot;
  currency: string;
  dailyLimitMinor: bigint | null;
  monthlyLimitMinor: bigint | null;
  migratedFromCapMinor: bigint | null;
  version: number;
  updatedByUserId: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
};

const big = (v: unknown): bigint | null => (v === null || v === undefined ? null : typeof v === "bigint" ? v : BigInt(v as number | string));
const date = (v: unknown): Date | null => (v instanceof Date ? v : v ? new Date(String(v)) : null);

export function toAllowanceRow(raw: Record<string, unknown>): AllowanceRow {
  return {
    id: String(raw.id),
    tenantId: String(raw.tenantId),
    pot: raw.pot as Pot,
    currency: String(raw.currency),
    dailyLimitMinor: big(raw.dailyLimitMinor),
    monthlyLimitMinor: big(raw.monthlyLimitMinor),
    migratedFromCapMinor: big(raw.migratedFromCapMinor),
    version: Number(raw.version ?? 1),
    updatedByUserId: (raw.updatedByUserId as string | null) ?? null,
    createdAt: date(raw.createdAt),
    updatedAt: date(raw.updatedAt),
  };
}

export async function getAllowance(tenantId: string, pot: Pot, db: SpendDb = prisma): Promise<AllowanceRow | null> {
  const row = (await db.spendAllowance.findUnique({ where: { tenantId_pot: { tenantId, pot } } })) as Record<string, unknown> | null;
  return row ? toAllowanceRow(row) : null;
}

export async function getAllowances(tenantId: string, db: SpendDb = prisma): Promise<Record<Pot, AllowanceRow | null>> {
  const rows = (((await db.spendAllowance.findMany({ where: { tenantId } })) ?? []) as Record<string, unknown>[]).map(toAllowanceRow);
  return { ads: rows.find((r) => r.pot === "ads") ?? null, messaging: rows.find((r) => r.pot === "messaging") ?? null, ai: rows.find((r) => r.pot === "ai") ?? null };
}

/**
 * The currency a pot is counted in when the caller does not say: AI is always credits; ads take the spending ad account's
 * currency; WhatsApp takes the rate card's; otherwise INR (3.1).
 */
export async function defaultPotCurrency(tenantId: string, pot: Pot, db: SpendDb = prisma, control?: SpendControlState): Promise<string> {
  if (pot === "ai") return CRD;
  if (pot === "ads") {
    const ctl = control ?? (await getControl(tenantId, { db, prune: false }));
    if (ctl.spendingAdAccountAssetId) {
      const asset = (await db.metaAsset.findFirst({ where: { id: ctl.spendingAdAccountAssetId, tenantId }, select: { meta: true } })) as { meta?: unknown } | null;
      const cur = asset?.meta && typeof asset.meta === "object" ? (asset.meta as { currency?: unknown }).currency : undefined;
      if (isCurrencyCode(cur)) return cur;
    }
    return DEFAULT_LIMIT_CURRENCY;
  }
  const card = (await db.platformSetting.findUnique({ where: { key: RATECARD_KEY } })) as { value?: unknown } | null;
  const cur = card?.value && typeof card.value === "object" ? (card.value as { currency?: unknown }).currency : undefined;
  return isCurrencyCode(cur) ? cur : DEFAULT_LIMIT_CURRENCY;
}

// ===== Combining (pure) =====

export type CombinedLimits = {
  daily: bigint | null;
  monthly: bigint | null;
  dailyBinding: LimitBinding | null;
  monthlyBinding: LimitBinding | null;
  binding: LimitBinding;
};

function bindingOf(effective: bigint | null, owner: bigint | null, ceiling: bigint | null, ceilingSource: LimitBinding | null, planCap: bigint | null = null): LimitBinding | null {
  if (effective === null) return null;
  if (owner !== null && owner === effective) return "owner";
  if (ceiling !== null && ceiling === effective && ceilingSource) return ceilingSource;
  if (planCap !== null && planCap === effective) return "plan";
  return ceilingSource ?? "owner";
}

/** min(owner, ceiling) per period with the pot rules of 4.4. */
export function combineLimits(
  pot: Pot,
  owner: { daily: bigint | null; monthly: bigint | null },
  ceiling: Pick<ResolvedCeiling, "daily" | "monthly" | "dailySource" | "monthlySource">,
  planCapMonthly: bigint | null = null,
): CombinedLimits {
  // Ads: a Not set daily limit means no ads can start, whatever the ceiling.
  const daily = pot === "ads" && owner.daily === null ? null : minLimit(owner.daily, ceiling.daily);
  let monthly = minLimit(owner.monthly, ceiling.monthly);
  if (pot === "ai") monthly = minLimit(monthly, planCapMonthly);
  const dailyBinding = bindingOf(daily, owner.daily, ceiling.daily, ceiling.dailySource);
  const monthlyBinding = bindingOf(monthly, owner.monthly, ceiling.monthly, ceiling.monthlySource, pot === "ai" ? planCapMonthly : null);
  const binding: LimitBinding =
    monthlyBinding && monthlyBinding !== "owner" ? monthlyBinding : dailyBinding && dailyBinding !== "owner" ? dailyBinding : "owner";
  return { daily, monthly, dailyBinding, monthlyBinding, binding };
}

export type LimitRefusal = { reason: "no_daily_limit" | "no_monthly_limit" | "no_limit" | "unknown_ceiling"; code: SpendCopyCode | null };

export type LimitRules = {
  /** Ads only: a daily limit exists, so ads may start (subject to the other checks). Always true for the other pots. */
  adsCanStart: boolean;
  /** Periods people are checked against; a period that is not checked is only counted. */
  humansChecked: { daily: boolean; monthly: boolean };
  /** Why an assistant's raise in this pot is refused before any maths, or null. */
  assistantRefusal: LimitRefusal | null;
  /** Why a person's raise in this pot is refused before any maths, or null. */
  humanRefusal: LimitRefusal | null;
};

/**
 * What "Not set" and an unknown ceiling mean for people and assistants (4.4, 4.6 step 4, decision 2.3.8). `limits` are the
 * effective limits; `owner` (when given) the owner's own limits in the pot currency, so an owner monthly limit that is Not set
 * refuses assistants even when a ceiling fills the gap (2.3.8). Without `owner` only the effective limits are used.
 */
export function limitRules(
  pot: Pot,
  limits: { daily: bigint | null; monthly: bigint | null; unknownCeiling: boolean },
  probationOn: boolean,
  owner?: { daily: bigint | null; monthly: bigint | null },
): LimitRules {
  const unknown: LimitRefusal = { reason: "unknown_ceiling", code: "spend.currency" };
  const monthlyNotSet = limits.monthly === null || (owner !== undefined && owner.monthly === null);
  if (pot === "ads") {
    const noDaily: LimitRefusal = { reason: "no_daily_limit", code: "spend.no_limit" };
    return {
      adsCanStart: limits.daily !== null,
      humansChecked: { daily: limits.daily !== null, monthly: limits.monthly !== null },
      assistantRefusal: limits.daily === null ? noDaily : monthlyNotSet ? { reason: "no_monthly_limit", code: null } : limits.unknownCeiling ? unknown : null,
      humanRefusal: limits.daily === null ? noDaily : limits.unknownCeiling && probationOn ? unknown : null,
    };
  }
  return {
    adsCanStart: true,
    humansChecked: { daily: limits.daily !== null, monthly: limits.monthly !== null },
    assistantRefusal: monthlyNotSet ? { reason: "no_limit", code: null } : limits.unknownCeiling ? unknown : null,
    humanRefusal: limits.unknownCeiling && probationOn ? unknown : null,
  };
}

// ===== effectiveLimits =====

export type ResolvedLimits = EffectiveLimits & {
  dailyBinding: LimitBinding | null;
  monthlyBinding: LimitBinding | null;
  allowance: AllowanceRow | null;
  /** False when the owner's limits are in another currency than the pot's (spend.currency for raises). */
  currencyMatches: boolean;
  probation: ProbationState;
  plan: SpendPlan;
  ceilingDetail: ResolvedCeiling;
  rules: LimitRules;
};

export type EffectiveLimitsOptions = { now?: Date; env?: Record<string, string | undefined>; control?: SpendControlState };

/** The limits that apply to one pot now (4.4). `currency` defaults to the pot's currency (defaultPotCurrency). */
export async function effectiveLimits(tenantId: string, pot: Pot, currency?: string | null, tx?: SpendDb, opts: EffectiveLimitsOptions = {}): Promise<ResolvedLimits> {
  if (!POTS.includes(pot)) throw new RangeError(`Unknown pot ${String(pot)}`);
  const db = tx ?? prisma;
  const now = opts.now ?? new Date();
  const control = opts.control ?? (await getControl(tenantId, { db, prune: false }));
  const allowance = await getAllowance(tenantId, pot, db);
  const cur = (currency ?? allowance?.currency ?? (await defaultPotCurrency(tenantId, pot, db, control))).toUpperCase();
  const currencyMatches = !allowance || allowance.currency === cur;
  const owner = currencyMatches && allowance ? { daily: allowance.dailyLimitMinor, monthly: allowance.monthlyLimitMinor } : { daily: null, monthly: null };
  const probation = await probationState(tenantId, { db, control });
  const plan = await resolveSpendPlan(tenantId, db, now);
  const ceiling = await resolveCeiling({ tenantId, pot, currency: cur, planId: plan.planId, probationOn: probation.on, now, db, env: opts.env });
  // A platform admin's workspace override replaces every other ceiling, the plan's monthly AI credits included: it is how
  // support tops up AI credits (Eddy 12.1a decision 2; Phase 0 8.3 set_spend_ceiling). Without an override the plan caps it.
  const planCapMonthly = pot === "ai" ? (ceiling.override && ceiling.monthly !== null ? ceiling.monthly : BigInt(plan.aiCreditsMonthly ?? defaultMonthlyCreditCeiling())) : null;
  const combined = combineLimits(pot, owner, ceiling, planCapMonthly);
  return {
    pot,
    currency: cur,
    daily: combined.daily,
    monthly: combined.monthly,
    owner,
    ceiling: { daily: ceiling.daily, monthly: ceiling.monthly, source: ceiling.source, expiresAt: ceiling.expiresAt },
    binding: combined.binding,
    unknownCeiling: ceiling.unknown,
    ...(pot === "ai" ? { planCapMonthly } : {}),
    dailyBinding: combined.dailyBinding,
    monthlyBinding: combined.monthlyBinding,
    allowance,
    currencyMatches,
    probation,
    plan,
    ceilingDetail: ceiling,
    rules: limitRules(pot, { daily: combined.daily, monthly: combined.monthly, unknownCeiling: ceiling.unknown }, probation.on, owner),
  };
}

// ===== Changing the owner's limits (8.1, 2.3.8) =====

/** undefined = leave as it is; null = Not set. */
export type AllowancePatch = { pot: Pot; dailyLimitMinor?: bigint | null; monthlyLimitMinor?: bigint | null; currency?: string };

export type AllowanceFieldKind = "raise" | "lower" | "set" | "clear" | "same";
export type AllowanceFieldChange = { field: "daily" | "monthly"; from: bigint | null; to: bigint | null; kind: AllowanceFieldKind };

export type AllowanceChange = {
  pot: Pot;
  fromCurrency: string;
  toCurrency: string;
  currencyChanged: boolean;
  fields: AllowanceFieldChange[];
  changed: boolean;
  /** Anything only the owner may do: a raise, Not set to a number, a number to Not set, or a currency change. */
  ownerOnly: boolean;
  /** For the paywall rule (4.17): only raising operations call assertTenantCanWrite. */
  raises: boolean;
  direction: "raise" | "lower" | "mixed" | "none";
};

function fieldKind(from: bigint | null, to: bigint | null): AllowanceFieldKind {
  if (from === to) return "same";
  if (from === null) return "set";
  if (to === null) return "clear";
  return to > from ? "raise" : "lower";
}

/** Compares the current row with the patch, field by field (pure). */
export function classifyAllowanceChange(current: { currency: string; daily: bigint | null; monthly: bigint | null }, patch: AllowancePatch): AllowanceChange {
  const toCurrency = (patch.currency ?? current.currency).toUpperCase();
  const currencyChanged = toCurrency !== current.currency;
  const fields: AllowanceFieldChange[] = [];
  if (patch.dailyLimitMinor !== undefined) fields.push({ field: "daily", from: current.daily, to: patch.dailyLimitMinor, kind: fieldKind(current.daily, patch.dailyLimitMinor) });
  if (patch.monthlyLimitMinor !== undefined) fields.push({ field: "monthly", from: current.monthly, to: patch.monthlyLimitMinor, kind: fieldKind(current.monthly, patch.monthlyLimitMinor) });
  const moved = fields.filter((f) => f.kind !== "same");
  const ownerOnly = currencyChanged || moved.some((f) => f.kind !== "lower");
  const lowers = moved.some((f) => f.kind === "lower");
  const raises = ownerOnly;
  return {
    pot: patch.pot,
    fromCurrency: current.currency,
    toCurrency,
    currencyChanged,
    fields,
    changed: currencyChanged || moved.length > 0,
    ownerOnly,
    raises,
    direction: raises && lowers ? "mixed" : raises ? "raise" : lowers ? "lower" : "none",
  };
}

const ROLE_READ_ONLY = "Only the owner can change spending limits. Ask them if you need more.";

/** Who may make this change. Throws the error to show; returns nothing when it is allowed. */
export function assertMayChangeAllowance(actor: SpendActor, change: AllowanceChange): void {
  const isOwner = actor.type === "user" && actor.role === "owner";
  if (isOwner) return;
  const mayLower = (actor.type === "user" && actor.role === "admin") || actor.type === "platform_admin";
  if (!mayLower) throw new HttpError(403, ROLE_READ_ONLY);
  if (change.ownerOnly) throw new SpendBlockedError("spend.only_owner_raise");
}

const POT_LABEL: Record<Pot, string> = { ads: "ads", messaging: "WhatsApp", ai: "AI" };

function describeChange(change: AllowanceChange): string {
  const show = (v: bigint | null, currency: string) => (v === null ? "Not set" : formatMinor(v, currency));
  const verbs: Record<AllowanceFieldKind, string> = { raise: "Raised", lower: "Lowered", set: "Set", clear: "Cleared", same: "Kept" };
  const parts = change.fields
    .filter((f) => f.kind !== "same")
    .map((f) => `${verbs[f.kind]} the ${POT_LABEL[change.pot]} ${f.field} limit from ${show(f.from, change.fromCurrency)} to ${show(f.to, change.toCurrency)}`);
  if (change.currencyChanged) parts.push(`Changed the ${POT_LABEL[change.pot]} limits from ${change.fromCurrency} to ${change.toCurrency}`);
  return parts.length ? `${parts.join(". ")}.` : `No change to the ${POT_LABEL[change.pot]} limits.`;
}

function checkPatch(patch: AllowancePatch): void {
  if (!patch || !POTS.includes(patch.pot)) throw new HttpError(400, "Choose ads, WhatsApp or AI.");
  for (const [key, label] of [["dailyLimitMinor", "daily limit"], ["monthlyLimitMinor", "monthly limit"]] as const) {
    const v = patch[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== "bigint" || v <= 0n) throw new HttpError(400, `Enter a ${label} above zero, or leave it empty for Not set.`);
    if (!fitsStoredMinor(v)) throw new HttpError(400, `That ${label} is too large. Enter a smaller amount, or leave it empty for Not set.`);
  }
  if (patch.currency !== undefined) {
    const c = patch.currency.toUpperCase();
    if (!isCurrencyCode(c)) throw new HttpError(400, "Use a three-letter currency code such as INR.");
    if (patch.pot === "ai" && c !== CRD) throw new HttpError(400, "AI limits are counted in credits.");
    if (patch.pot !== "ai" && c === CRD) throw new HttpError(400, "Credits are only for AI limits.");
  }
}

export type AllowanceChangeResult = { allowance: AllowanceRow | null; change: AllowanceChange; correlationId: string | null };

/** The classification a route needs before it decides whether the paywall applies (4.17). Reads, never writes. */
export async function previewAllowanceChange(tenantId: string, patch: AllowancePatch, db: SpendDb = prisma): Promise<AllowanceChange> {
  checkPatch(patch);
  const row = await getAllowance(tenantId, patch.pot, db);
  const currency = row?.currency ?? (await defaultPotCurrency(tenantId, patch.pot, db));
  return classifyAllowanceChange({ currency, daily: row?.dailyLimitMinor ?? null, monthly: row?.monthlyLimitMinor ?? null }, patch);
}

class Refusal {
  constructor(
    readonly error: Error,
    readonly code: string,
    readonly change: AllowanceChange | null,
  ) {}
}

/**
 * PUT /api/spend/allowances for one pot, and the admin panel's lower_spend_limits. `version` is the row's version as the
 * caller last read it (0 when there was no row). Returns the saved row and the ledger correlationId.
 */
export async function setAllowances(
  tenantId: string,
  patch: AllowancePatch,
  actor: SpendActor,
  version: number,
  opts: { reason?: string; db?: SpendDb } = {},
): Promise<AllowanceChangeResult> {
  checkPatch(patch);
  const pot = patch.pot;
  try {
    const { result, correlationId } = await applyLedgered(opts.db, async (tx) => {
      const row = await getAllowance(tenantId, pot, tx);
      const currency = row?.currency ?? (await defaultPotCurrency(tenantId, pot, tx));
      const change = classifyAllowanceChange({ currency, daily: row?.dailyLimitMinor ?? null, monthly: row?.monthlyLimitMinor ?? null }, patch);
      if ((row?.version ?? 0) !== version) throw new Refusal(new SpendBlockedError("spend.version"), "spend.version", change);
      try {
        assertMayChangeAllowance(actor, change);
      } catch (error) {
        throw new Refusal(error as Error, error instanceof SpendBlockedError ? error.code : "role_read_only", change);
      }
      if (!change.changed) return { result: { allowance: row, change }, row: null };
      if (pot === "messaging" && change.currencyChanged) {
        // WhatsApp is priced in the rate card's currency, and limits in any other currency could never be checked: the send
        // gate would treat them as Not set while this page showed a limit.
        const card = await defaultPotCurrency(tenantId, "messaging", tx);
        if (change.toCurrency !== card) throw new Refusal(new HttpError(400, `WhatsApp limits are in ${card}, the currency WhatsApp prices your messages in. Enter them in ${card}.`), "spend.currency", change);
      }
      if (change.currencyChanged && (patch.dailyLimitMinor === undefined || patch.monthlyLimitMinor === undefined)) {
        // Nothing is converted silently (3.1): the owner enters both limits again in the new currency.
        throw new HttpError(400, `Enter your limits again in ${change.toCurrency}.`);
      }
      let daily = patch.dailyLimitMinor !== undefined ? patch.dailyLimitMinor : (row?.dailyLimitMinor ?? null);
      const monthly = patch.monthlyLimitMinor !== undefined ? patch.monthlyLimitMinor : (row?.monthlyLimitMinor ?? null);
      if (daily !== null && monthly !== null && daily > monthly) {
        if (patch.dailyLimitMinor !== undefined) throw new HttpError(400, "The daily limit can't be more than the monthly limit.");
        // Lowering is never blocked (I2): a monthly limit lowered below today's daily limit lowers the daily limit with it.
        change.fields.push({ field: "daily", from: daily, to: monthly, kind: "lower" });
        change.direction = change.raises ? "mixed" : "lower";
        daily = monthly;
      }
      const updatedByUserId = actor.type === "user" || actor.type === "platform_admin" ? actor.userId : null;
      if (!row) {
        const { count } = await tx.spendAllowance.createMany({
          data: [{ tenantId, pot, currency: change.toCurrency, dailyLimitMinor: daily, monthlyLimitMinor: monthly, updatedByUserId }],
          skipDuplicates: true,
        });
        if (count !== 1) throw new Refusal(new SpendBlockedError("spend.version"), "spend.version", change);
      } else {
        const { count } = await tx.spendAllowance.updateMany({
          where: { tenantId, pot, version },
          data: { currency: change.toCurrency, dailyLimitMinor: daily, monthlyLimitMinor: monthly, updatedByUserId, version: { increment: 1 } },
        });
        if (count !== 1) throw new Refusal(new SpendBlockedError("spend.version"), "spend.version", change);
      }
      const saved = await getAllowance(tenantId, pot, tx);
      return {
        result: { allowance: saved, change },
        row: {
          tenantId,
          pot,
          action: "allowance.change",
          actor,
          reason: (opts.reason ?? "").trim() || describeChange(change),
          reasonCodes: [`allowance_${change.direction}`],
          targetType: "allowance",
          targetId: pot,
          currency: change.toCurrency,
          before: { currency: change.fromCurrency, dailyLimitMinor: row?.dailyLimitMinor ?? null, monthlyLimitMinor: row?.monthlyLimitMinor ?? null, version: row?.version ?? 0 },
          after: { currency: change.toCurrency, dailyLimitMinor: daily, monthlyLimitMinor: monthly, version: saved?.version ?? null },
          undo: {
            action: "set_allowance",
            pot,
            currency: change.fromCurrency,
            dailyLimitMinor: row?.dailyLimitMinor?.toString() ?? null,
            monthlyLimitMinor: row?.monthlyLimitMinor?.toString() ?? null,
          },
        },
      };
    });
    return { allowance: result.allowance, change: result.change, correlationId };
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    // A refusal stands alone (the transaction that refused rolled back), written on its own connection.
    await appendStandalone(
      {
        tenantId,
        pot,
        action: "allowance.change",
        phase: "refused",
        actor,
        reason: error.error.message,
        reasonCodes: [error.code],
        targetType: "allowance",
        targetId: pot,
        currency: error.change?.toCurrency ?? null,
        before: error.change ? { currency: error.change.fromCurrency, fields: error.change.fields.map((f) => ({ field: f.field, value: f.from })) } : null,
        after: { currency: patch.currency ?? null, dailyLimitMinor: patch.dailyLimitMinor, monthlyLimitMinor: patch.monthlyLimitMinor, version },
      },
      { db: opts.db },
    );
    throw error.error;
  }
}

