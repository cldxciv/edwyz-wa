/**
 * The assistant registry (docs/SPEND-CONTROLS-SPEC.md 7.1). Code, not data: an assistant exists only when it is listed here,
 * so a mandate row, an approval or a ledger row for an unknown key is refused by the readers. Pure: no database, no network.
 *
 * In code the AI agents that run the funnel are "assistants" (the role `agent` is a human teammate). Two things that look
 * like assistants are deliberately NOT here:
 * - Eddy, the in-app helper (4.15). It acts only when the signed-in member taps confirm on a preview card, as that member,
 *   with reasonCodes ['via_eddy']. It holds no mandate and has no autonomy level.
 * - The customer-facing AI reply bot (AiAgent). Its sends are origin `ai_reply` (automated) and its AI calls go through the
 *   gateway; it never decides money.
 */
import type { AutonomyLevel, KnownAssistantKey, Pot } from "./types";

/** What an assistant may ever ask for. A mandate's allowedOps is a subset of its assistant's ops. */
export type AssistantOp =
  // Ads lowering (never refused, works while frozen).
  | "pause"
  | "archive"
  | "cut_budget"
  | "end_earlier"
  // Ads raises (through reserveAds).
  | "raise_budget"
  | "resume_ad"
  | "resume_adset"
  | "activate"
  | "extend_end"
  // Messaging.
  | "broadcast_start"
  | "pause_broadcast"
  | "cancel_broadcast"
  | "release_hold"
  | "send_followup"
  // AI.
  | "ai_call";

export const LOWERING_OPS: readonly AssistantOp[] = ["pause", "archive", "cut_budget", "end_earlier", "pause_broadcast", "cancel_broadcast", "release_hold"];

/** True for an op that only lowers spend or risk: never gated by autonomy above Level 0, never refused (I2). */
export function isLoweringOp(op: string): boolean {
  return (LOWERING_OPS as readonly string[]).includes(op);
}

export type AssistantDefinition = {
  key: KnownAssistantKey;
  /** The UI name (7.1). */
  label: string;
  /** One plain sentence for the Assistants card. */
  description: string;
  pots: readonly Pot[];
  /** live: exists today (proposal-only); planned: a Phase 1 consumer. */
  phase: "live" | "planned";
  ops: readonly AssistantOp[];
};

export const ASSISTANTS: readonly AssistantDefinition[] = Object.freeze([
  Object.freeze({
    key: "ads_optimizer",
    label: "Ad assistant",
    description: "Watches your running ads and suggests pausing, cutting or raising budgets.",
    pots: Object.freeze(["ads"] as Pot[]),
    phase: "live",
    ops: Object.freeze(["pause", "archive", "cut_budget", "end_earlier", "raise_budget", "resume_ad", "resume_adset"] as AssistantOp[]),
  }),
  Object.freeze({
    key: "ads_launcher",
    label: "Campaign assistant",
    description: "Prepares new ad campaigns with a daily budget and an end date.",
    pots: Object.freeze(["ads"] as Pot[]),
    phase: "planned",
    ops: Object.freeze(["pause", "archive", "cut_budget", "end_earlier", "activate", "extend_end"] as AssistantOp[]),
  }),
  Object.freeze({
    key: "broadcast_planner",
    label: "Broadcast assistant",
    description: "Plans WhatsApp broadcasts and starts them within your WhatsApp limit.",
    pots: Object.freeze(["messaging"] as Pot[]),
    phase: "planned",
    ops: Object.freeze(["broadcast_start", "pause_broadcast", "cancel_broadcast", "release_hold"] as AssistantOp[]),
  }),
  Object.freeze({
    key: "lead_followup",
    label: "Follow-up assistant",
    description: "Follows up with new leads on WhatsApp and drafts the messages with AI.",
    pots: Object.freeze(["messaging", "ai"] as Pot[]),
    phase: "planned",
    ops: Object.freeze(["send_followup", "ai_call", "pause_broadcast", "cancel_broadcast", "release_hold"] as AssistantOp[]),
  }),
]) as readonly AssistantDefinition[];

export const ASSISTANT_KEYS: readonly KnownAssistantKey[] = Object.freeze(ASSISTANTS.map((a) => a.key));

/**
 * Names that must never be treated as assistants, with the reason (4.15, 7.1). A mandate or approval for one of these is a
 * bug: Eddy acts as the confirming member, and the reply bot is an automated sender.
 */
export const NOT_ASSISTANTS: Readonly<Record<string, string>> = Object.freeze({
  eddy: "Eddy acts only as the signed-in member who confirms a card (Phase 0 4.15); it holds no mandate.",
  ai_reply: "The AI reply bot is an automated sender (origin ai_reply); its AI calls go through the gateway.",
  ai_agent: "The AI reply bot is an automated sender (origin ai_reply); its AI calls go through the gateway.",
});

export function isAssistantKey(key: unknown): key is KnownAssistantKey {
  return typeof key === "string" && (ASSISTANT_KEYS as readonly string[]).includes(key);
}

export function getAssistant(key: string): AssistantDefinition | null {
  return ASSISTANTS.find((a) => a.key === key) ?? null;
}

/** The UI label, or "Assistant" for an unknown key (never the raw key). */
export function assistantLabel(key: string): string {
  return getAssistant(key)?.label ?? "Assistant";
}

/** True when the assistant may ever perform the op (the mandate narrows it further). */
export function assistantMayDo(key: string, op: string): boolean {
  const a = getAssistant(key);
  return !!a && (a.ops as readonly string[]).includes(op);
}

/** Keeps only the ops the assistant may ever perform, in registry order (for saving a mandate's allowedOps). */
export function sanitizeAllowedOps(key: string, ops: readonly string[]): AssistantOp[] {
  const a = getAssistant(key);
  if (!a) return [];
  const wanted = new Set(ops);
  return a.ops.filter((op) => wanted.has(op));
}

/** The assistants that use a pot (the Spending limits page groups them under it). */
export function assistantsForPot(pot: Pot): AssistantDefinition[] {
  return ASSISTANTS.filter((a) => a.pots.includes(pot));
}

export type LevelOption = { level: AutonomyLevel; label: string; description: string };

/** Autonomy levels as the Assistants card shows them (2.2, 7.2). Level 0 is the default. */
export const LEVEL_OPTIONS: readonly LevelOption[] = Object.freeze([
  Object.freeze({ level: 0 as AutonomyLevel, label: "Suggest", description: "Only makes suggestions. Nothing changes until someone approves it." }),
  Object.freeze({
    level: 1 as AutonomyLevel,
    label: "Guarded",
    description: "Pauses and cuts on its own. Raises a budget by up to 20% a day on its own; anything more needs approval.",
  }),
  Object.freeze({
    level: 2 as AutonomyLevel,
    label: "Autopilot",
    description: "Acts on its own within your limits. Anything that could add more than 25% of your monthly limit needs approval.",
  }),
]) as readonly LevelOption[];

export function levelLabel(level: number): string {
  return LEVEL_OPTIONS.find((o) => o.level === level)?.label ?? LEVEL_OPTIONS[0].label;
}

/** Mandate defaults (2.2): Level 0, +20% Level 1 step, 25% Level 2 share, 14-day learning period. */
export const MANDATE_DEFAULTS = Object.freeze({
  level: 0 as AutonomyLevel,
  raiseStepPct: 20,
  approvalSharePct: 25,
  shadowDays: 14,
});

/** The owner may only LOWER these (2.2): the stored value is clamped to the range. */
export const RAISE_STEP_PCT_RANGE = Object.freeze({ min: 0, max: 20 });
export const APPROVAL_SHARE_PCT_RANGE = Object.freeze({ min: 1, max: 25 });

export function clampRaiseStepPct(value: number): number {
  return clampInt(value, RAISE_STEP_PCT_RANGE.min, RAISE_STEP_PCT_RANGE.max, MANDATE_DEFAULTS.raiseStepPct);
}

export function clampApprovalSharePct(value: number): number {
  return clampInt(value, APPROVAL_SHARE_PCT_RANGE.min, APPROVAL_SHARE_PCT_RANGE.max, MANDATE_DEFAULTS.approvalSharePct);
}

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
