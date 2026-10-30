/**
 * Assistant autonomy policy (docs/SPEND-CONTROLS-SPEC.md 7.2). Pure: no database, no network; `now` and every figure are
 * passed in. The Spend Book calls decide() for assistant actors inside the reservation (4.6 step 10); the optimizer passes each
 * proposal through it (7.3). The asymmetric rule holds everywhere: lowering spend or risk is never refused here.
 *
 * Order of checks:
 *   1. A freeze (workspace or platform `all`, or `assistants` for an assistant) or a blocking breaker refuses a raise.
 *   2. The 14-day learning window (shadow): every action gives `shadow`, with what the configured level would have done.
 *   3. ASSISTANT_SPEND_ENABLED=false: the level is treated as 0.
 *   4. No mandate, a disabled mandate, or an op not in allowedOps: a SUGGESTION (needs_approval), never a refusal
 *      (decision 2.3.10: "refuse" is only for actions an approval could not make valid; an approver who accepts a suggestion
 *      runs it as their own action).
 *   5. The action does not fit what is left of the limits, or the mandate's own ceilings: refuse ("This needs ₹X but only ₹Y
 *      is left this month."). An approval cannot exceed the owner's limit.
 *   6. The level matrix, with the Level 2 anti-splitting rule (2.3.9, kept by 12.1a decision 6): the share test uses
 *      max(Δmonth of this action, Δmonth + Σ Δmonth of this assistant's auto-applied raises in the last rolling 24 h).
 *      Level 1's +20% is cumulative per ad set per account day: (new budget - budget at the start of the day) / that start.
 *      On an ad account whose Meta limit is not managed (5.1), every assistant raise or launch needs approval.
 *
 * Breakers and kill switches are not assistants: their lowering is always automatic, and the only raise they may make is the
 * `daily_limit` breaker's auto-resume (through reserveAds). Eddy is not an assistant either (4.15, registry.ts).
 */
import { assistantSpendEnabled as assistantSpendEnabledFlag } from "./flags";
import { getAssistant, isLoweringOp } from "./registry";
import type { AutonomyLevel, FreezeLevel, PolicyVerdict, Pot, ShadowDecision, SpendActor } from "./types";

export type PolicyActionKind = "lowering" | "raise" | "launch";

/** Ops that start or restart spending ("Resume, activate, launch, broadcast start" in the matrix). */
export const LAUNCH_OPS: readonly string[] = ["activate", "resume_ad", "resume_adset", "extend_end", "broadcast_start", "send_followup", "create_live"];

export type PolicyIntent = {
  /** The op: an AdsRaiseIntent or lowering kind, or a registry op (broadcast_start, ...). */
  op: string;
  /** Derived from the op when omitted: lowering ops, `raise_budget`, everything else is a launch. */
  kind?: PolicyActionKind;
  /** Derived from the op when omitted: broadcast and follow-up ops are messaging, ai_call is ai, the rest ads. */
  pot?: Pot;
  /** raise_budget: the ad set's budget at the start of the account day, and the new budget. */
  dayStartBudgetMinor?: bigint | null;
  toMinor?: bigint | null;
  /** The campaign has an end date or a lifetime budget (R2). Ads launches only. */
  hasEndDate?: boolean;
  /** The object was paused by a safety stop: resuming it is never automatic at Level 1. */
  resumesBreakerPause?: boolean;
};

/** The mandate as the policy needs it (an AssistantMandate row); null when there is no row. */
export type PolicyMandate = {
  enabled: boolean;
  level: AutonomyLevel;
  allowedOps: readonly string[];
  maxDailyMinor: bigint | null;
  maxMonthlyMinor: bigint | null;
  targetCostPerLeadMinor: bigint | null;
  raiseStepPct: number;
  approvalSharePct: number;
  shadowUntil: Date | null;
  sandboxOnly?: boolean;
};

/** The figures from headroom() and the book that the policy reads. Amounts are minor units of the pot's currency. */
export type PolicyHeadroom = {
  /** Workspace and platform freezes. */
  freeze: { workspace: FreezeLevel; platform: FreezeLevel };
  /** An open breaker that pauses the scope or blocks raises covers the object, campaign, ad account or workspace. */
  blockingBreaker?: boolean;
  /** Any open breaker on the scope, blocking or not (a Level 1 auto raise needs none). */
  breakerOnScope?: boolean;
  /** Effective limits, min(owner, ceiling); null = not set. */
  dailyLimitMinor?: bigint | null;
  monthlyLimitMinor: bigint | null;
  /** What is left before this action: limit - (spent + set aside). null = no limit for that period. */
  dayLeftMinor?: bigint | null;
  monthLeftMinor?: bigint | null;
  /** Meta's limit is managed on the ad account (5.1). Ads only. */
  metaLimitManaged?: boolean;
  /** A test ad account (MetaAsset.sandbox). */
  sandbox?: boolean;
  /** The workspace's target cost per lead, used when the mandate has none. */
  targetCostPerLeadMinor?: bigint | null;
  /** Σ Δmonth of this assistant's automatically applied raises in the last rolling 24 h (anti-splitting). */
  autoRaisesLast24hMinor?: bigint;
  /** This assistant's own use before the action (spent plus set aside), for the mandate ceilings. */
  assistantTodayMinor?: bigint;
  assistantMonthMinor?: bigint;
};

/** Worst-case deltas of the action (4.6 step 6). */
export type PolicyDelta = { todayMinor: bigint; monthMinor: bigint };

export type PolicyReason =
  | "lowering"
  | "frozen"
  | "assistants_frozen"
  | "platform_frozen"
  | "breaker"
  | "learning"
  | "unknown_assistant"
  | "suggestion_only"
  | "op_not_allowed"
  | "over_daily_limit"
  | "over_monthly_limit"
  | "mandate_daily"
  | "mandate_monthly"
  | "no_monthly_limit"
  | "end_date_required"
  | "meta_limit_not_managed"
  | "sandbox_only"
  | "level_0"
  | "level_1_step"
  | "level_1_over_step"
  | "level_1_breaker_open"
  | "level_1_breaker_resume"
  | "level_1_launch"
  | "level_2"
  | "level_2_over_share"
  | "no_target_cost"
  | "breaker_lowering"
  | "breaker_resume"
  | "breaker_no_raise"
  | "not_assistant";

export type PolicyDecision = {
  verdict: PolicyVerdict;
  reason: PolicyReason;
  /** The level the matrix used: 0 while ASSISTANT_SPEND_ENABLED is false, during learning, or without a mandate. */
  level: AutonomyLevel;
  /** Shadow only: what the configured level would have done (stored on the AssistantShadowRecord). */
  would?: ShadowDecision;
  wouldReason?: PolicyReason;
  /** True when a suggestion is still shown to approvers although the assistant cannot act itself (2.3.10). */
  suggestion: boolean;
  /** Refusals for room: what the action needs and what is left ("This needs ₹X but only ₹Y is left this month."). */
  needsMinor?: bigint;
  leftMinor?: bigint;
  period?: "day" | "month";
};

export type DecideOptions = {
  /** ASSISTANT_SPEND_ENABLED; read from the environment when omitted. */
  assistantSpendEnabled?: boolean;
};

const ADS_LAUNCH_OPS = new Set(["activate", "resume_ad", "resume_adset", "extend_end", "create_live"]);
const RESUME_OPS = new Set(["resume_ad", "resume_adset", "activate"]);

export function actionKind(intent: PolicyIntent): PolicyActionKind {
  if (intent.kind) return intent.kind;
  if (isLoweringOp(intent.op)) return "lowering";
  return intent.op === "raise_budget" ? "raise" : "launch";
}

export function actionPot(intent: PolicyIntent): Pot {
  if (intent.pot) return intent.pot;
  if (intent.op === "ai_call") return "ai";
  if (["broadcast_start", "pause_broadcast", "cancel_broadcast", "release_hold", "send_followup"].includes(intent.op)) return "messaging";
  return "ads";
}

/** Integer percent test without floats: part <= pct% of whole, with pct in whole percent or up to two decimals. */
export function withinPct(part: bigint, whole: bigint, pct: number): boolean {
  if (part <= 0n) return true;
  if (whole <= 0n || !Number.isFinite(pct) || pct <= 0) return false;
  const bps = BigInt(Math.round(pct * 100));
  return part * 10_000n <= bps * whole;
}

/**
 * The Level 2 share of one action under the anti-splitting rule: max(Δmonth, Δmonth + Σ auto raises in the last 24 h).
 * A negative sum (auto cuts are not counted, but a caller may pass net figures) never lowers the action's own share.
 */
export function level2Share(deltaMonth: bigint, autoRaisesLast24h: bigint = 0n): bigint {
  const withWindow = deltaMonth + (autoRaisesLast24h > 0n ? autoRaisesLast24h : 0n);
  return withWindow > deltaMonth ? withWindow : deltaMonth;
}

/** Level 1: the cumulative raise today, (to - dayStart), is at most raiseStepPct% of the budget at the start of the day. */
export function withinLevel1Step(dayStartBudgetMinor: bigint | null | undefined, toMinor: bigint | null | undefined, raiseStepPct: number): boolean {
  if (dayStartBudgetMinor === null || dayStartBudgetMinor === undefined || toMinor === null || toMinor === undefined) return false;
  if (dayStartBudgetMinor <= 0n) return false;
  return withinPct(toMinor - dayStartBudgetMinor, dayStartBudgetMinor, raiseStepPct);
}

const decision = (verdict: PolicyVerdict, reason: PolicyReason, level: AutonomyLevel, extra: Partial<PolicyDecision> = {}): PolicyDecision => ({
  verdict,
  reason,
  level,
  suggestion: verdict === "needs_approval" || verdict === "shadow",
  ...extra,
});

function freezeRefusal(actor: SpendActor, h: PolicyHeadroom): PolicyReason | null {
  if (h.freeze.platform === "all") return "platform_frozen";
  if (h.freeze.workspace === "all") return "frozen";
  if (actor.type === "assistant" && (h.freeze.platform === "assistants" || h.freeze.workspace === "assistants")) return "assistants_frozen";
  return null;
}

/** Steps 4-6 at one level: the verdict an assistant gets for a raise or launch, or a lowering. */
function matrix(intent: PolicyIntent, delta: PolicyDelta, mandate: PolicyMandate | null, h: PolicyHeadroom, level: AutonomyLevel): { verdict: ShadowDecision; reason: PolicyReason; extra?: Partial<PolicyDecision> } {
  const kind = actionKind(intent);
  const pot = actionPot(intent);
  // Step 4: suggestions only, never a refusal.
  const suggestionOnly: PolicyReason | null = !mandate || !mandate.enabled ? "suggestion_only" : !mandate.allowedOps.includes(intent.op) ? "op_not_allowed" : null;

  if (kind === "lowering") {
    if (suggestionOnly) return { verdict: "needs_approval", reason: suggestionOnly };
    return level === 0 ? { verdict: "needs_approval", reason: "level_0" } : { verdict: "auto", reason: "lowering" };
  }

  // Step 5: it must fit what is left. An approval cannot exceed the owner's limit.
  if (h.dayLeftMinor !== undefined && h.dayLeftMinor !== null && delta.todayMinor > h.dayLeftMinor) {
    return { verdict: "refuse", reason: "over_daily_limit", extra: { needsMinor: delta.todayMinor, leftMinor: h.dayLeftMinor < 0n ? 0n : h.dayLeftMinor, period: "day" } };
  }
  if (h.monthLeftMinor !== undefined && h.monthLeftMinor !== null && delta.monthMinor > h.monthLeftMinor) {
    return { verdict: "refuse", reason: "over_monthly_limit", extra: { needsMinor: delta.monthMinor, leftMinor: h.monthLeftMinor < 0n ? 0n : h.monthLeftMinor, period: "month" } };
  }
  if (suggestionOnly) return { verdict: "needs_approval", reason: suggestionOnly };
  const m = mandate as PolicyMandate;
  if (m.maxDailyMinor !== null) {
    const used = h.assistantTodayMinor ?? 0n;
    if (used + delta.todayMinor > m.maxDailyMinor) return { verdict: "refuse", reason: "mandate_daily", extra: { needsMinor: delta.todayMinor, leftMinor: m.maxDailyMinor - used < 0n ? 0n : m.maxDailyMinor - used, period: "day" } };
  }
  if (m.maxMonthlyMinor !== null) {
    const used = h.assistantMonthMinor ?? 0n;
    if (used + delta.monthMinor > m.maxMonthlyMinor) return { verdict: "refuse", reason: "mandate_monthly", extra: { needsMinor: delta.monthMinor, leftMinor: m.maxMonthlyMinor - used < 0n ? 0n : m.maxMonthlyMinor - used, period: "month" } };
  }

  // Step 6: the matrix.
  const needsEndDate = kind === "launch" && pot === "ads" && ADS_LAUNCH_OPS.has(intent.op);
  if (level === 2 && needsEndDate && !intent.hasEndDate) return { verdict: "refuse", reason: "end_date_required" };
  if (pot === "ads" && !h.metaLimitManaged && !h.sandbox) return { verdict: "needs_approval", reason: "meta_limit_not_managed" };
  if (m.sandboxOnly && !h.sandbox) return { verdict: "needs_approval", reason: "sandbox_only" };
  if (level === 0) return { verdict: "needs_approval", reason: "level_0" };

  if (level === 1) {
    if (kind === "launch") return { verdict: "needs_approval", reason: "level_1_launch" };
    if (h.breakerOnScope || h.blockingBreaker) return { verdict: "needs_approval", reason: "level_1_breaker_open" };
    if (intent.resumesBreakerPause) return { verdict: "needs_approval", reason: "level_1_breaker_resume" };
    return withinLevel1Step(intent.dayStartBudgetMinor, intent.toMinor, m.raiseStepPct) ? { verdict: "auto", reason: "level_1_step" } : { verdict: "needs_approval", reason: "level_1_over_step" };
  }

  // Level 2.
  if (h.monthlyLimitMinor === null) return { verdict: "refuse", reason: "no_monthly_limit" };
  const share = level2Share(delta.monthMinor, h.autoRaisesLast24hMinor ?? 0n);
  if (!withinPct(share, h.monthlyLimitMinor, m.approvalSharePct)) return { verdict: "needs_approval", reason: "level_2_over_share" };
  if (kind === "launch" && pot === "ads" && (m.targetCostPerLeadMinor ?? h.targetCostPerLeadMinor ?? null) === null) return { verdict: "needs_approval", reason: "no_target_cost" };
  return { verdict: "auto", reason: "level_2" };
}

/**
 * The 7.2 decision for one action. `actor` is usually an assistant; breakers get their own rule and any other actor (a person,
 * an API key, a system job) is outside the autonomy policy, so only freezes and blocking breakers apply to its raises here.
 */
export function decide(
  actor: SpendActor,
  intent: PolicyIntent,
  delta: PolicyDelta,
  mandate: PolicyMandate | null,
  headroom: PolicyHeadroom,
  now: Date,
  opts: DecideOptions = {},
): PolicyDecision {
  const kind = actionKind(intent);

  if (actor.type === "breaker") {
    if (kind === "lowering") return decision("auto", "breaker_lowering", 0);
    const frozen = freezeRefusal(actor, headroom);
    if (frozen) return decision("refuse", frozen, 0);
    // Only the daily_limit breaker's auto-resume, through reserveAds (6.2, 7.2 matrix).
    if (actor.kind === "daily_limit" && kind === "launch" && RESUME_OPS.has(intent.op)) return decision("auto", "breaker_resume", 0);
    return decision("refuse", "breaker_no_raise", 0);
  }

  if (actor.type !== "assistant") {
    if (kind === "lowering") return decision("auto", "lowering", 0);
    const frozen = freezeRefusal(actor, headroom);
    if (frozen) return decision("refuse", frozen, 0);
    if (headroom.blockingBreaker) return decision("refuse", "breaker", 0);
    return decision("auto", "not_assistant", 0);
  }

  if (!getAssistant(actor.assistantKey)) return { verdict: "refuse", reason: "unknown_assistant", level: 0, suggestion: false };

  // 1. Freezes and blocking breakers refuse raises (never lowering).
  if (kind !== "lowering") {
    const frozen = freezeRefusal(actor, headroom);
    if (frozen) return decision("refuse", frozen, 0);
    if (headroom.blockingBreaker) return decision("refuse", "breaker", 0);
  }

  const configured: AutonomyLevel = mandate && mandate.enabled ? mandate.level : 0;

  // 2. Learning window: the assistant executes nothing; what the configured level would have done is recorded.
  if (mandate?.shadowUntil && mandate.shadowUntil.getTime() > now.getTime()) {
    const would = matrix(intent, delta, mandate, headroom, configured);
    return decision("shadow", "learning", 0, { would: would.verdict, wouldReason: would.reason, ...would.extra });
  }

  // 3. While ASSISTANT_SPEND_ENABLED is false every assistant acts at Level 0.
  const enabled = opts.assistantSpendEnabled ?? assistantSpendEnabledFlag();
  const level: AutonomyLevel = enabled ? configured : 0;

  // 4-6.
  const v = matrix(intent, delta, mandate, headroom, level);
  return decision(v.verdict, v.reason, level, v.extra);
}

/** Plain-language line for a policy reason, for the ledger `reason` and the approval card. Never jargon (4.13). */
export function policyReasonText(reason: PolicyReason): string {
  switch (reason) {
    case "lowering":
    case "breaker_lowering":
      return "Lowering spend is always allowed.";
    case "frozen":
      return "Spending is stopped for this workspace.";
    case "assistants_frozen":
      return "Assistants are stopped for this workspace.";
    case "platform_frozen":
      return "Edwyz has paused new spending for a short while.";
    case "breaker":
      return "A safety stop is on for this.";
    case "learning":
      return "The assistant is still learning, so this is saved as a suggestion.";
    case "unknown_assistant":
      return "This assistant is not known to Edwyz.";
    case "suggestion_only":
      return "This assistant is not switched on, so it only makes suggestions.";
    case "op_not_allowed":
      return "This assistant is not allowed to do this on its own, so it is a suggestion.";
    case "over_daily_limit":
      return "This would go over the ads limit for today.";
    case "over_monthly_limit":
      return "This would go over the limit for this month.";
    case "mandate_daily":
      return "This would go over the assistant's own limit for today.";
    case "mandate_monthly":
      return "This would go over the assistant's own limit for this month.";
    case "no_monthly_limit":
      return "Set a monthly limit before an assistant can spend on its own.";
    case "end_date_required":
      return "Ads started by an assistant need an end date.";
    case "meta_limit_not_managed":
      return "Meta's spending limit isn't managed by Edwyz on this ad account, so this needs approval.";
    case "sandbox_only":
      return "This assistant may act on its own only on a test ad account.";
    case "level_0":
      return "The assistant only makes suggestions at this level.";
    case "level_1_step":
      return "Within the 20% a day the assistant may raise on its own.";
    case "level_1_over_step":
      return "This raises the budget by more than the assistant may on its own today.";
    case "level_1_breaker_open":
      return "A safety stop is open here, so this needs approval.";
    case "level_1_breaker_resume":
      return "A safety stop paused this, so turning it back on needs approval.";
    case "level_1_launch":
      return "Starting or resuming ads needs approval at this level.";
    case "level_2":
      return "Within what the assistant may do on its own.";
    case "level_2_over_share":
      return "This could add more than the assistant may add on its own in a day, so it needs approval.";
    case "no_target_cost":
      return "Set a target cost per lead before an assistant starts ads on its own.";
    case "breaker_resume":
      return "Turned back on after the daily limit reset.";
    case "breaker_no_raise":
      return "Safety stops only lower spending.";
    case "not_assistant":
      return "Checked against your limits.";
  }
}
