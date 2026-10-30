/**
 * The AI gateway (docs/SPEND-CONTROLS-SPEC.md 4.10, 6.4, invariants I5, I9, I12; docs/EDDY-SPEC.md 5.2, 5.10).
 *
 * Every model call and every metered image or video goes through here, and this is the only file that names the
 * Anthropic host (bypass rule B2). The order is always:
 *
 *   1. freeze check (read through the at most 5 s old cache of kill.ts). Under "Stop all spending" (workspace or platform)
 *      the AUTOMATIC features stop: agent_reply, escalation, and any assistant actor. Features a signed-in person asked
 *      for keep working within the AI limit: inbox_suggest, creative, ai_test and eddy (decision 2.3.11, 12.1a decision 8).
 *      "Stop assistants" stops assistant actors only.
 *   2. reserveAi: the lock-free conditional UPDATE on SpendCounter (pot ai, currency CRD, day and month keys in the
 *      workspace time zone), then a SpendReservation `ai_call` (ttl 2 min, 3 min for streams) so a crash is recovered by
 *      expireReservations(). A refusal is HTTP 402 `ai_quota` with the 4.13 copy. The AI monthly credit limit is enforced
 *      today, so it stays enforced in observe mode (I12): observe relaxes only the checks that are new in Phase 0 (the
 *      owner's AI limits, the new-workspace and platform ceilings), never for an assistant (4.14), and records a
 *      would-refuse row, like the WhatsApp send gate.
 *   3. the call.
 *   4. settle with the actual credits: the counters move from reserved to spent, recordUsage(ai_credits) writes the
 *      UsageLedger row with input and output tokens and the model, and the 80% and 100% notices go out once per period
 *      (claimOnce `spend-ai:<tenantId>:<period>:<level>`, then the spend notifier). On failure the hold is released.
 *
 * Counters start from the truth: the first call of a day or month in a workspace seeds the counter rows from UsageLedger,
 * so credits already used this month before the gateway shipped still count (I12).
 *
 * Callers that spread one charge over several model rounds (the AI agent, reply suggestions, the AI test) hold credits
 * once (reserveAi, or billing/limits.ts reserveCredits) and pass the hold to anthropicMessages() for each round; they
 * settle the hold once with the reference the outcome needs. Creative Studio's text calls are held by its own
 * reserveCredits() and counted by its recordUsage(); their HTTP goes through anthropicMessagesHeldByCaller().
 *
 * No lock is held here and no network call runs inside one (I10): the reservation is a single conditional statement.
 * The worker may import this file; it must never import ai-stream.ts (the SDK).
 */
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { claimOnce, releaseClaim } from "@/lib/lifecycle/state";
import { describeError } from "@/lib/safe-error";
import { HttpError } from "@/lib/tenancy";
import { recordUsage } from "@/lib/usage";
import { effectiveLimits } from "@/lib/spend/allowances";
import { getControl } from "@/lib/spend/control";
import { spendCopy, type SpendCopyCode } from "@/lib/spend/copy";
import { adjustSpent, counterKeys, ensureCounterRows, readCounters, releaseCounter, reserveCounter, type CounterKeys } from "@/lib/spend/counters";
import { SpendBlockedError } from "@/lib/spend/errors";
import { spendEnforceMode } from "@/lib/spend/flags";
import { spendState } from "@/lib/spend/kill";
import { appendStandalone } from "@/lib/spend/ledger";
import { CRD } from "@/lib/spend/money";
import { notifySpend } from "@/lib/spend/notify";
import { monthStartDay, nextLocalMidnight, nextLocalMonthStart, startOfLocalDay } from "@/lib/spend/periods";
import { createCallReservation, releaseCallReservation, settleCallReservation } from "@/lib/spend/reservations";
import type { FreezeState, SpendActor } from "@/lib/spend/types";

// ===== Features and actors =====

export type AiFeature = "agent_reply" | "inbox_suggest" | "creative" | "escalation" | "ai_test" | "eddy";
export const AI_FEATURES: readonly AiFeature[] = ["agent_reply", "inbox_suggest", "creative", "escalation", "ai_test", "eddy"];
/** Stop when spending is stopped ("all"): nobody is waiting on them, and they spend on their own. */
export const AUTOMATIC_AI_FEATURES: readonly AiFeature[] = ["agent_reply", "escalation"];
/** A signed-in person asked; they keep working under "all", within the AI limit. */
export const PERSON_REQUESTED_AI_FEATURES: readonly AiFeature[] = ["inbox_suggest", "creative", "ai_test", "eddy"];

/** The customer-facing AI reply bot. It is not an autonomy-governed assistant (7.1); its feature is automatic. */
export const AI_AGENT_ACTOR: SpendActor = Object.freeze({ type: "system", job: "ai_agent" }) as SpendActor;
/** The chatbot's AI escalation check. */
export const AI_ESCALATION_ACTOR: SpendActor = Object.freeze({ type: "system", job: "chatbot_escalation" }) as SpendActor;
/** Callers of the legacy reserveCredits() that do not say who asked (Creative Studio). */
export const AI_LEGACY_ACTOR: SpendActor = Object.freeze({ type: "system", job: "billing.reserveCredits" }) as SpendActor;

export const AI_CALL_TTL_MS = 2 * 60_000;
export const AI_STREAM_TTL_MS = 3 * 60_000;
export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
/** The raw-fetch callers stay on this API version (Eddy 5.2); the SDK in ai-stream.ts sends its own. */
export const LEGACY_ANTHROPIC_VERSION = "2023-06-01";
export const AI_SETTINGS_LINK = "/app/settings/spending";

export function isAiFeature(value: unknown): value is AiFeature {
  return typeof value === "string" && (AI_FEATURES as readonly string[]).includes(value);
}

/** A person asked for this call (and it is not an assistant acting). */
export function isPersonRequested(feature: AiFeature, actor: SpendActor): boolean {
  return actor.type !== "assistant" && PERSON_REQUESTED_AI_FEATURES.includes(feature);
}

/**
 * Whether SPEND_ENFORCE=observe relaxes the NEW Phase 0 AI checks for this caller (4.14, I12, rollout rule R3): every caller
 * except an assistant, which is always enforced. The WhatsApp send gate applies the same rule to its pot.
 */
export function aiObserveApplies(actor: SpendActor, env: Record<string, string | undefined> = process.env): boolean {
  return actor.type !== "assistant" && spendEnforceMode(env) === "observe";
}

// ===== Freeze =====

/**
 * The refusal a freeze gives this AI call, or null (4.10 step 1 as corrected by the critic pass and 4.11). Under "all"
 * only automatic features and assistants stop; "assistants" stops assistant actors only.
 */
export function aiFreezeRefusal(state: Pick<FreezeState, "workspace" | "platform">, feature: AiFeature, actor: SpendActor): SpendCopyCode | null {
  const automatic = AUTOMATIC_AI_FEATURES.includes(feature) || actor.type === "assistant";
  if (automatic && state.platform === "all") return "spend.platform_frozen";
  if (automatic && state.workspace === "all") return "spend.frozen";
  if (actor.type === "assistant") {
    if (state.platform === "assistants") return "spend.platform_frozen";
    if (state.workspace === "assistants") return "spend.frozen";
  }
  return null;
}

/** Throws the freeze refusal for this call, if any. */
export async function assertAiAllowed(tenantId: string, feature: AiFeature, actor: SpendActor): Promise<void> {
  if (!isAiFeature(feature)) throw new RangeError(`Unknown AI feature ${String(feature)}`);
  const code = aiFreezeRefusal(await spendState(tenantId), feature, actor);
  if (code) throw new SpendBlockedError(code);
}

/** A refusal of the gateway: the AI limit is used up, or spending is stopped. Callers hand the chat to a person. */
export function isAiRefusal(error: unknown): error is SpendBlockedError {
  return error instanceof SpendBlockedError && (error.code === "ai_quota" || error.code === "spend.frozen" || error.code === "spend.platform_frozen");
}

export function isAiQuotaError(error: unknown): error is SpendBlockedError {
  return error instanceof SpendBlockedError && error.code === "ai_quota";
}

/** The 402 `ai_quota` refusal with the 4.13 copy ("This month's AI limit is used up. ... until 1 Nov."). */
export function aiQuotaError(period: "day" | "month", now: Date, timezone: string): SpendBlockedError {
  const resetsOn = period === "day" ? nextLocalMidnight(now, timezone) : nextLocalMonthStart(now, timezone);
  return new SpendBlockedError("ai_quota", { period, resetsOn, timezone });
}

// ===== Usage =====

export type AiRef = { type: string; id: string };
export type AiUsage = { inputTokens: number | null; outputTokens: number | null; model: string | null };
export const NO_USAGE: AiUsage = Object.freeze({ inputTokens: null, outputTokens: null, model: null });

const count = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);

/** usage.input_tokens, usage.output_tokens and the model of an Anthropic response. */
export function usageFromResponse(json: unknown): AiUsage {
  const j = (json && typeof json === "object" ? json : {}) as { usage?: { input_tokens?: unknown; output_tokens?: unknown }; model?: unknown };
  return { inputTokens: count(j.usage?.input_tokens), outputTokens: count(j.usage?.output_tokens), model: typeof j.model === "string" ? j.model : null };
}

/** Sums two usages (tokens add up; the later model wins). */
export function addUsage(a: AiUsage | null | undefined, b: AiUsage | null | undefined): AiUsage {
  const x = a ?? NO_USAGE;
  const y = b ?? NO_USAGE;
  const sum = (p: number | null, q: number | null) => (p === null && q === null ? null : (p ?? 0) + (q ?? 0));
  return { inputTokens: sum(x.inputTokens, y.inputTokens), outputTokens: sum(x.outputTokens, y.outputTokens), model: y.model ?? x.model };
}

function wholeCredits(value: number, label = "credits"): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`AI ${label} must be zero or more.`);
  return Math.ceil(value);
}

// ===== Counters seeded from UsageLedger =====

const seeded = new Set<string>();

/** Test hook: forget which counter rows were seeded in this process. */
export function resetAiCounterSeeds(): void {
  seeded.clear();
}

async function creditsSince(tenantId: string, since: Date): Promise<bigint> {
  const rows = (await prisma.usageLedger.aggregate({ where: { tenantId, meter: "ai_credits", createdAt: { gte: since } }, _sum: { amount: true } })) as { _sum?: { amount?: number | null } } | null;
  return BigInt(Math.max(0, Math.floor(rows?._sum?.amount ?? 0)));
}

/**
 * Creates this day's and month's AI counter rows from UsageLedger when they do not exist yet (I12: credits used before the
 * gateway shipped, or by Creative Studio's legacy path, still count). Returns which rows this call created.
 */
export async function seedAiCounters(tenantId: string, keys: CounterKeys, timezone: string): Promise<{ day: boolean; month: boolean }> {
  const dayId = `${tenantId}|day|${keys.day}`;
  const monthId = `${tenantId}|month|${keys.month}`;
  if (seeded.has(dayId) && seeded.has(monthId)) return { day: false, month: false };
  const rows = ((await prisma.spendCounter.findMany({
    where: { tenantId, pot: "ai", OR: [{ periodKind: "day", periodKey: keys.day }, { periodKind: "month", periodKey: keys.month }] },
    select: { periodKind: true, periodKey: true },
  })) ?? []) as { periodKind: string; periodKey: string }[];
  const has = (kind: string) => rows.some((r) => r.periodKind === kind);
  const data: { tenantId: string; pot: string; periodKind: string; periodKey: string; currency: string; spentMinor: bigint }[] = [];
  if (!has("month")) data.push({ tenantId, pot: "ai", periodKind: "month", periodKey: keys.month, currency: CRD, spentMinor: await creditsSince(tenantId, startOfLocalDay(monthStartDay(keys.month), timezone)) });
  if (!has("day")) data.push({ tenantId, pot: "ai", periodKind: "day", periodKey: keys.day, currency: CRD, spentMinor: await creditsSince(tenantId, startOfLocalDay(keys.day, timezone)) });
  let created = { day: false, month: false };
  if (data.length > 0) {
    const out = (await prisma.spendCounter.createMany({ data, skipDuplicates: true })) as { count?: number } | null;
    // When another process created a row first we cannot tell which; report none, so a legacy count adds rather than skips.
    if ((out?.count ?? 0) === data.length) created = { day: !has("day"), month: !has("month") };
  }
  if (seeded.size > 20_000) seeded.clear();
  seeded.add(dayId);
  seeded.add(monthId);
  return created;
}

/**
 * Counts credits a legacy caller recorded with recordUsage() after holding them with reserveCredits() (Creative Studio):
 * the hold is released separately, so the spend is added here, and the 80% and 100% notices are checked. Never throws.
 */
export async function countLegacyAiUsage(tenantId: string, credits: number, now: Date = new Date()): Promise<void> {
  try {
    if (!(credits > 0)) return;
    const control = await getControl(tenantId, { prune: false });
    const keys = counterKeys(now, control.timezone);
    const created = await seedAiCounters(tenantId, keys, control.timezone);
    // The ledger row was written first, so rows seeded just now already include it.
    if (!(created.day && created.month)) {
      await ensureCounterRows(tenantId, "ai", keys, CRD);
      await adjustSpent({ tenantId, pot: "ai", keys, deltaMinor: BigInt(Math.ceil(credits)) });
    }
    const limits = await effectiveLimits(tenantId, "ai", CRD, undefined, { now, control });
    await checkAiNotices(tenantId, keys, { daily: limits.daily, monthly: limits.monthly }, control.timezone, now);
  } catch (error) {
    console.warn(`[ai] credits could not be added to the AI counter: ${describeError(error)}`);
  }
}

// ===== Holds =====

export type AiCtx = {
  tenantId: string;
  feature: AiFeature;
  actor: SpendActor;
  /** Credits to hold (and, for anthropicMessages, to charge). Whole credits; 0 holds nothing but still checks freezes. */
  credits: number;
  /** UsageLedger refType / refId when the gateway settles. */
  ref?: AiRef | null;
  /** The ai_call reservation subject; unique per open hold. Defaults to `<feature>:<uuid>`. */
  subjectId?: string;
};

export type AiReserveOptions = { ttlMs?: number; now?: Date; env?: Record<string, string | undefined> };

export type AiSettleInput = { credits: number; ref?: AiRef | null; usage?: AiUsage | null };

export type AiHoldState = "open" | "settled" | "released";

export interface AiHold {
  readonly tenantId: string;
  readonly feature: AiFeature;
  readonly actor: SpendActor;
  readonly credits: number;
  readonly reservationId: string | null;
  readonly keys: CounterKeys | null;
  readonly state: AiHoldState;
  /** Tokens and model of the calls made under this hold so far. */
  readonly usage: AiUsage;
  noteUsage(usage: AiUsage | null | undefined): void;
  /** Charges `credits` (counters, UsageLedger, notices). Idempotent: only the first settle or release counts. */
  settle(input: AiSettleInput): Promise<void>;
  /** Gives the hold back unspent. Idempotent. */
  release(): Promise<void>;
}

const LIVE_HOLDS = new WeakSet<AiHold>();

/** True for a hold this gateway made that is still open. */
export function isLiveAiHold(hold: unknown): hold is AiHold {
  return !!hold && typeof hold === "object" && LIVE_HOLDS.has(hold as AiHold) && (hold as AiHold).state === "open";
}

type HoldInit = {
  ctx: AiCtx;
  credits: number;
  reservationId: string | null;
  keys: CounterKeys | null;
  timezone: string | null;
  limits: { daily: bigint | null; monthly: bigint | null } | null;
};

function makeHold(init: HoldInit): AiHold {
  const { ctx } = init;
  let state: AiHoldState = "open";
  let usage: AiUsage = NO_USAGE;
  const hold: AiHold = {
    tenantId: ctx.tenantId,
    feature: ctx.feature,
    actor: ctx.actor,
    credits: init.credits,
    reservationId: init.reservationId,
    keys: init.keys,
    get state() {
      return state;
    },
    get usage() {
      return usage;
    },
    noteUsage(u) {
      usage = addUsage(usage, u);
    },
    async settle(input) {
      if (state !== "open") return;
      state = "settled";
      const actual = wholeCredits(input.credits);
      const used = addUsage(usage, input.usage);
      let moved = false;
      if (init.reservationId) {
        try {
          const out = await settleCallReservation(init.reservationId, BigInt(actual));
          // The hold expired before this settle, so its reserve already went back: add the spend on its own.
          if (!out.closed && actual > 0 && init.keys) await adjustSpent({ tenantId: ctx.tenantId, pot: "ai", keys: init.keys, deltaMinor: BigInt(actual) });
          moved = true;
        } catch (error) {
          // The call was answered (and billed), so it is still charged: the expiry sweep gives the reserve back, and the
          // credits are added to the counter below, like a legacy caller's.
          console.warn(`[ai] hold not settled, charging it on its own: ${describeError(error)}`);
        }
      }
      const ref = input.ref ?? ctx.ref ?? undefined;
      // The counters were moved above (or, when they were not, are added just below), never again by recordUsage.
      await recordUsage(ctx.tenantId, "ai_credits", actual, ref, { inputTokens: used.inputTokens, outputTokens: used.outputTokens, model: used.model, counted: true });
      if (!moved && actual > 0) await countLegacyAiUsage(ctx.tenantId, actual);
      if (actual > 0 && init.keys && init.limits && init.timezone) await checkAiNotices(ctx.tenantId, init.keys, init.limits, init.timezone);
    },
    async release() {
      if (state !== "open") return;
      state = "released";
      if (init.reservationId) await releaseCallReservation(init.reservationId);
    },
  };
  LIVE_HOLDS.add(hold);
  return hold;
}

const hourKey = (now: Date) => now.toISOString().slice(0, 13);

/** One refused row per workspace, reason and hour (like messaging.blocked); never one row per AI call (9.1). */
async function ledgerAiBlocked(ctx: AiCtx, credits: number, reason: string, codes: string[], observe: boolean, now: Date): Promise<void> {
  try {
    await appendStandalone({
      tenantId: ctx.tenantId,
      pot: "ai",
      action: "ai.blocked",
      phase: "refused",
      actor: ctx.actor,
      reason,
      reasonCodes: codes,
      targetType: "ai_feature",
      targetId: ctx.feature,
      currency: CRD,
      amountMinor: BigInt(credits),
      observe,
      idempotencyKey: `ai.blocked:${observe ? "observe:" : ""}${codes.join(",")}:${hourKey(now)}`,
    });
  } catch (error) {
    console.warn(`[ai] refusal not ledgered: ${describeError(error)}`);
  }
}

/**
 * Holds credits for one call or one multi-round operation (4.10 step 2): freeze check, the conditional counter reservation
 * and the ai_call SpendReservation. Throws 402 ai_quota when either period would go over, or the freeze refusal.
 */
export async function reserveAi(ctx: AiCtx, opts: AiReserveOptions = {}): Promise<AiHold> {
  const credits = wholeCredits(ctx.credits);
  await assertAiAllowed(ctx.tenantId, ctx.feature, ctx.actor);
  if (credits === 0) return makeHold({ ctx, credits: 0, reservationId: null, keys: null, timezone: null, limits: null });

  const now = opts.now ?? new Date();
  const control = await getControl(ctx.tenantId, { prune: false });
  const timezone = control.timezone;
  const keys = counterKeys(now, timezone);
  const limits = await effectiveLimits(ctx.tenantId, "ai", CRD, undefined, { now, control, env: opts.env });
  if (ctx.actor.type === "assistant" && limits.rules.assistantRefusal) {
    await ledgerAiBlocked(ctx, credits, spendCopy("ai_quota", { period: "month", timezone }), ["ai_quota", ctx.feature, limits.rules.assistantRefusal.reason], false, now);
    throw aiQuotaError("month", now, timezone);
  }
  // I12: observe relaxes only the new checks (never for an assistant); the monthly plan credits stay enforced.
  const observe = aiObserveApplies(ctx.actor, opts.env ?? process.env);
  const dayLimit = observe ? null : limits.daily;
  const monthLimit = observe ? (limits.planCapMonthly ?? limits.monthly) : limits.monthly;

  await seedAiCounters(ctx.tenantId, keys, timezone);
  const out = await reserveCounter({ tenantId: ctx.tenantId, pot: "ai", amountMinor: BigInt(credits), dayLimitMinor: dayLimit, monthLimitMinor: monthLimit, currency: CRD, keys });
  if (!out.ok) {
    const period = out.exhausted === "day" ? "day" : "month";
    const error = aiQuotaError(period, now, timezone);
    await ledgerAiBlocked(ctx, credits, error.message, ["ai_quota", ctx.feature, period], false, now);
    await sendAiNotice(ctx.tenantId, period, period === "day" ? keys.day : keys.month, 100, null, period === "day" ? dayLimit : monthLimit, timezone, now);
    throw error;
  }
  if (observe) {
    const overDay = limits.daily !== null && out.dayTotal !== null && out.dayTotal > limits.daily;
    const overMonth = limits.monthly !== null && out.monthTotal !== null && out.monthTotal > limits.monthly;
    if (overDay || overMonth) {
      const period = overMonth ? "month" : "day";
      await ledgerAiBlocked(ctx, credits, `${aiQuotaError(period, now, timezone).message} (Let through while the new limits are being watched.)`, ["ai_quota", ctx.feature, period], true, now);
    }
  }

  let reservationId: string;
  try {
    const row = await createCallReservation({
      tenantId: ctx.tenantId,
      pot: "ai",
      currency: CRD,
      subjectId: ctx.subjectId ?? `${ctx.feature}:${randomUUID()}`,
      amountMinor: BigInt(credits),
      keys,
      ttlMs: opts.ttlMs ?? AI_CALL_TTL_MS,
      now,
    });
    reservationId = row.id;
  } catch (error) {
    await releaseCounter({ tenantId: ctx.tenantId, pot: "ai", keys, amountMinor: BigInt(credits) }).catch((e) => console.warn(`[ai] counter release failed: ${describeError(e)}`));
    throw error;
  }
  return makeHold({ ctx, credits, reservationId, keys, timezone, limits: { daily: limits.daily, monthly: limits.monthly } });
}

// ===== Notices at 80% and 100% (6.4) =====

const fmt = (n: bigint) => Number(n).toLocaleString("en-IN");

/** The claimOnce marker of one notice (6.4): `spend-ai:<tenantId>:<period>:<level>`, the period being its day or month key. */
export const aiNoticeKey = (tenantId: string, periodKey: string, level: 80 | 100) => `spend-ai:${tenantId}:${periodKey}:${level}`;

async function sendAiNotice(tenantId: string, period: "day" | "month", periodKey: string, level: 80 | 100, used: bigint | null, limit: bigint | null, timezone: string, now: Date): Promise<void> {
  try {
    const key = (l: 80 | 100) => aiNoticeKey(tenantId, periodKey, l);
    if (!(await claimOnce(key(level)))) return;
    // A limit reached in one jump sends only the 100% notice; the 80% one never follows it.
    if (level === 100) await claimOnce(key(80));
    const when = period === "day" ? "today" : "this month";
    const owner = "The owner can raise the limit in Settings > Spending limits.";
    const title = level === 100 ? `${period === "day" ? "Today's" : "This month's"} AI limit is used up` : `AI credits are 80% used ${when}`;
    const body =
      level === 100
        ? `${spendCopy("ai_quota", { period, resetsOn: period === "day" ? nextLocalMidnight(now, timezone) : nextLocalMonthStart(now, timezone), timezone })} ${owner}`
        : `Your workspace has used ${used === null ? "most" : fmt(used)} of ${limit === null ? "its" : fmt(limit)} AI credits ${when}. AI replies, suggestions, Creative Studio and Eddy stop at the limit. ${owner}`;
    const result = await notifySpend({
      tenantId,
      kind: level === 100 ? "ai_limit_100" : "ai_limit_80",
      severity: level === 100 ? "action_needed" : "heads_up",
      audience: "admins",
      dedupeKey: key(level),
      title,
      body,
      link: AI_SETTINGS_LINK,
      params: { period, level, ...(used !== null ? { used: Number(used) } : {}), ...(limit !== null ? { limit: Number(limit) } : {}) },
    });
    // Nothing could be stored or sent: give the marker back so the next charge tries again.
    if (result.delivered.length === 0 && !result.deduplicated) await releaseClaim(key(level));
  } catch (error) {
    console.warn(`[ai] AI limit notice not sent: ${describeError(error)}`);
  }
}

/** After a charge: the notice for each period whose spent credits crossed 80% or 100% of its limit. Never throws. */
async function checkAiNotices(tenantId: string, keys: CounterKeys, limits: { daily: bigint | null; monthly: bigint | null }, timezone: string, now: Date = new Date()): Promise<void> {
  try {
    const figures = await readCounters(tenantId, "ai", keys);
    for (const period of ["month", "day"] as const) {
      const limit = period === "month" ? limits.monthly : limits.daily;
      if (limit === null || limit <= 0n) continue;
      const used = figures[period].spent;
      const level = used >= limit ? 100 : used * 100n >= limit * 80n ? 80 : null;
      if (level) await sendAiNotice(tenantId, period, period === "month" ? keys.month : keys.day, level, used, limit, timezone, now);
    }
  } catch (error) {
    console.warn(`[ai] AI limit check failed: ${describeError(error)}`);
  }
}

// ===== The model call =====

/** The parts of a Messages API response the legacy callers read. Anything else passes through untouched. */
export type AnthropicResponse = {
  id?: string;
  model?: string;
  content?: { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }[];
  stop_reason?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number; [k: string]: unknown };
  [k: string]: unknown;
};

/** A call under a hold the caller already made (one charge for several rounds). */
export type AiHeldCallCtx = { tenantId: string; feature: AiFeature; actor: SpendActor; hold: AiHold };
export type AiCallCtx = AiCtx | AiHeldCallCtx;

const isHeld = (ctx: AiCallCtx): ctx is AiHeldCallCtx => "hold" in ctx && !!(ctx as AiHeldCallCtx).hold;

function apiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) throw new HttpError(503, "AI is not configured.");
  return key;
}

/** True when an API key is configured (no network call). */
export function isAiConfigured(): boolean {
  return !!process.env.ANTHROPIC_API_KEY?.trim();
}

async function postMessages(key: string, body: Record<string, unknown>, timeoutMs: number): Promise<AnthropicResponse> {
  let res: Response;
  try {
    res = await fetch(ANTHROPIC_MESSAGES_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": LEGACY_ANTHROPIC_VERSION },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new HttpError(502, "The AI service could not be reached.");
  }
  if (!res.ok) throw new HttpError(502, "The AI service returned an error.");
  // The service answered (and billed): an unreadable body is an empty answer, still charged.
  const json = (await res.json().catch(() => null)) as unknown;
  return json && typeof json === "object" && !Array.isArray(json) ? (json as AnthropicResponse) : {};
}

/**
 * One Messages API call through the gateway (4.10). With `credits` it holds, calls and settles by itself (ref from the
 * ctx). With `hold` it checks freezes, calls and adds the usage to the caller's hold, which the caller settles once.
 */
export async function anthropicMessages(ctx: AiCallCtx, body: Record<string, unknown>, timeoutMs: number): Promise<AnthropicResponse> {
  const key = apiKey();
  if (isHeld(ctx)) {
    if (!isLiveAiHold(ctx.hold) || ctx.hold.tenantId !== ctx.tenantId) throw new RangeError("This AI call needs an open hold of the same workspace.");
    await assertAiAllowed(ctx.tenantId, ctx.feature, ctx.actor);
    const json = await postMessages(key, body, timeoutMs);
    ctx.hold.noteUsage(usageFromResponse(json));
    return json;
  }
  const hold = await reserveAi(ctx);
  let json: AnthropicResponse;
  try {
    json = await postMessages(key, body, timeoutMs);
  } catch (error) {
    await hold.release().catch((e) => console.warn(`[ai] hold release failed: ${describeError(e)}`));
    throw error;
  }
  await hold.settle({ credits: ctx.credits, ref: ctx.ref, usage: usageFromResponse(json) });
  return json;
}

/**
 * The HTTP of Creative Studio's text calls when the caller did not pass its hold: the service holds the action's credits
 * with reserveCredits() (feature `creative`, freeze-checked there) before the call and counts them with recordUsage()
 * after it, then releases the hold. Only src/lib/creative/llm.ts may call this (tests/spend-bypass.test.ts, rule B2c); a
 * caller that has the hold passes it and goes through anthropicMessages() instead.
 */
export async function anthropicMessagesHeldByCaller(body: Record<string, unknown>, timeoutMs: number): Promise<AnthropicResponse> {
  return postMessages(apiKey(), body, timeoutMs);
}

/**
 * A metered image or video provider call (4.10): hold `ctx.credits`, run, then charge what `charge(result)` says (for
 * example 0 when the provider fell back to the free placeholder). A failure releases the hold.
 */
export async function meteredProvider<T>(ctx: AiCtx, run: () => Promise<T>, opts: { charge?: (result: T) => number } = {}): Promise<T> {
  const hold = await reserveAi(ctx);
  let result: T;
  try {
    result = await run();
  } catch (error) {
    await hold.release().catch((e) => console.warn(`[ai] hold release failed: ${describeError(e)}`));
    throw error;
  }
  await hold.settle({ credits: opts.charge ? opts.charge(result) : ctx.credits, ref: ctx.ref });
  return result;
}
