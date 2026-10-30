/**
 * Eddy's availability (docs/EDDY-SPEC.md 5.11, 6.11, 6.14, EDDY-11 acceptance 2 and 6). No model call is ever made here:
 * GET /api/eddy/status runs on shell mount, every 5 minutes and when the panel opens, and the turn route runs the same gate
 * before anything else (5.9 step 1).
 *
 * The first state that matches wins:
 *   1 platform_off    no ANTHROPIC_API_KEY, or EDDY_ENABLED is not `true` (reason not_configured: EDDY_ENABLED defaults to
 *                     false, so a key alone never switches Eddy on), or the ops kill switch `eddy:platform` {enabled:false}
 *                     or a recent authentication failure (reason paused)
 *   2 locked          the workspace is suspended, deleted or billing-locked
 *   3 workspace_off   EddyWorkspaceSetting.enabled is false, or its consentVersion is not LEGAL.version (owner-only enable)
 *   4 paused          the AI gateway would refuse Eddy because of a freeze (defensive: since E7 a freeze never stops Eddy chat;
 *                     a normal freeze is the `spendingStopped` banner instead)
 *   5 allowance_used  the AI headroom left today or this month is below the minimum hold of a 2,000-token round
 *   6 user_capped     the member's daily Eddy credit cap is reached
 *   7 ready           readOnly when the member's email is unverified and verification is required
 */
import { memberDailyCreditCap, type EddyConfig, type EddyLangPref, type EddyOffReason, type EddyStatusDTO, type EddyWhatsAppState } from "./contract";
import type { MemberFacts, UserPrefRow, WorkspaceSettingRow } from "./settings";

/** An authentication failure marks Eddy paused for 5 minutes (5.11). */
export const AUTH_FAILURE_PAUSE_MS = 5 * 60_000;

let authFailedUntil = 0;

/** Called by the loop on AuthenticationError or PermissionDeniedError. Returns true the first time in a window (log once). */
export function noteAuthFailure(now: Date = new Date()): boolean {
  const first = now.getTime() >= authFailedUntil;
  authFailedUntil = now.getTime() + AUTH_FAILURE_PAUSE_MS;
  return first;
}

export function authFailedRecently(now: Date = new Date()): boolean {
  return now.getTime() < authFailedUntil;
}

/** Test hook. */
export function resetAuthFailure(): void {
  authFailedUntil = 0;
}

/** The AI pot in credits, as the spend bridge reads it from Phase 0 headroom('ai'). Null limits: not set. */
export type AllowanceFacts = {
  usedToday: number;
  limitToday: number | null;
  usedMonth: number;
  limitMonth: number | null;
  leftToday: number | null;
  leftMonth: number | null;
  /** Local dates (YYYY-MM-DD, workspace time zone) the day and the month reset. */
  todayResetsOn: string | null;
  monthResetsOn: string | null;
  timezone: string;
};

export type FreezeFacts = { workspace: "none" | "assistants" | "all"; platform: "none" | "assistants" | "all"; effective: "none" | "assistants" | "all" };

export type StatusActor = { userId: string; tenantId: string; role: "agent" | "admin" | "owner" };

export type StatusDeps = {
  config(): EddyConfig;
  /** An API key is configured (or, outside production, the scripted fake model is on). */
  aiConfigured(): boolean;
  platformSwitchOff(): Promise<boolean>;
  authFailed(now: Date): boolean;
  /** The billing paywall: throws when the workspace is locked, suspended or deleted. */
  assertCanWrite(tenantId: string): Promise<void>;
  workspaceSetting(tenantId: string): Promise<WorkspaceSettingRow>;
  legalVersion: string;
  freeze(tenantId: string): Promise<FreezeFacts>;
  /** The gateway's own freeze refusal for feature eddy (spend.frozen / spend.platform_frozen), or null. */
  gatewayFreezeCode(tenantId: string): Promise<string | null>;
  allowance(tenantId: string, now: Date): Promise<AllowanceFacts>;
  /** The smallest hold of any round, in credits (metering.ts minimumRoundCredits). */
  minimumRoundCredits(model: string, roleClass: "agent" | "admin"): Promise<number>;
  memberCreditsToday(tenantId: string, userId: string, now: Date, timezone: string): Promise<number>;
  member(userId: string): Promise<MemberFacts>;
  verificationRequired(): boolean;
  ownerNames(tenantId: string): Promise<string[]>;
  userPref(tenantId: string, userId: string): Promise<UserPrefRow | null>;
  needsYou(actor: StatusActor, now: Date): Promise<number>;
  demo(tenantId: string): Promise<boolean>;
  whatsapp(tenantId: string): Promise<EddyWhatsAppState>;
  clock(): Date;
};

/** Everything the status call and the turn gate learned, so a turn does not read it twice. */
export type EddyGate = {
  status: EddyStatusDTO;
  setting: WorkspaceSettingRow;
  member: MemberFacts;
  memberCap: number;
  memberUsedToday: number;
  allowance: AllowanceFacts;
  freeze: FreezeFacts;
  pref: UserPrefRow | null;
  verificationRequired: boolean;
};

const NO_ALLOWANCE = (timezone = "Asia/Kolkata"): AllowanceFacts => ({ usedToday: 0, limitToday: null, usedMonth: 0, limitMonth: null, leftToday: null, leftMonth: null, todayResetsOn: null, monthResetsOn: null, timezone });
const NO_FREEZE: FreezeFacts = { workspace: "none", platform: "none", effective: "none" };

const safe = async <T>(p: Promise<T>, fallback: T): Promise<T> => {
  try {
    return await p;
  } catch {
    return fallback;
  }
};

const langPrefOf = (p: UserPrefRow | null): EddyLangPref => (p && ["auto", "en", "hi", "hinglish"].includes(p.language) ? (p.language as EddyLangPref) : "auto");

/** Computes the gate (5.11). Reads run together; nothing here calls the model or writes. */
export async function eddyGate(actor: StatusActor, deps: StatusDeps): Promise<EddyGate> {
  const now = deps.clock();
  const config = deps.config();
  const roleClass = actor.role === "agent" ? "agent" : "admin";
  const [switchOff, locked, setting, freeze, gatewayFreeze, allowance, member, ownerNames, pref, needsYou, demo, whatsapp, minHold] = await Promise.all([
    safe(deps.platformSwitchOff(), false),
    deps.assertCanWrite(actor.tenantId).then(
      () => false,
      () => true,
    ),
    safe(deps.workspaceSetting(actor.tenantId), { enabled: false, enabledById: null, enabledAt: null, consentVersion: null, proactiveNotices: true, dailyTurnCap: null } as WorkspaceSettingRow),
    safe(deps.freeze(actor.tenantId), NO_FREEZE),
    safe(deps.gatewayFreezeCode(actor.tenantId), null),
    safe(deps.allowance(actor.tenantId, now), NO_ALLOWANCE()),
    safe(deps.member(actor.userId), { name: null, emailVerified: false } as MemberFacts),
    safe(deps.ownerNames(actor.tenantId), [] as string[]),
    safe(deps.userPref(actor.tenantId, actor.userId), null),
    safe(deps.needsYou(actor, now), 0),
    safe(deps.demo(actor.tenantId), false),
    safe(deps.whatsapp(actor.tenantId), "none" as EddyWhatsAppState),
    safe(deps.minimumRoundCredits(config.model, roleClass), 1),
  ]);
  const verificationRequired = deps.verificationRequired();
  const verified = member.emailVerified || !verificationRequired;
  const memberCap = memberDailyCreditCap(config, verified);
  const memberUsedToday = await safe(deps.memberCreditsToday(actor.tenantId, actor.userId, now, allowance.timezone), 0);

  let state: EddyStatusDTO["state"] = "ready";
  let reason: EddyOffReason | undefined;
  if (!deps.aiConfigured() || !config.enabled) {
    state = "platform_off";
    reason = "not_configured";
  } else if (switchOff || deps.authFailed(now)) {
    state = "platform_off";
    reason = "paused";
  } else if (locked) state = "locked";
  else if (!(setting.enabled && setting.consentVersion === deps.legalVersion)) state = "workspace_off";
  else if (gatewayFreeze) state = "paused";
  else if ((allowance.leftToday !== null && allowance.leftToday < minHold) || (allowance.leftMonth !== null && allowance.leftMonth < minHold)) state = "allowance_used";
  else if (memberUsedToday >= memberCap) state = "user_capped";

  const monthUsed = allowance.leftMonth !== null && allowance.leftMonth < minHold;
  const dayUsed = allowance.leftToday !== null && allowance.leftToday < minHold;
  const status: EddyStatusDTO = {
    state,
    ...(reason ? { reason } : {}),
    readOnly: !verified,
    canEnable: actor.role === "owner",
    ownerNames,
    allowance: {
      usedToday: allowance.usedToday,
      limitToday: allowance.limitToday,
      usedMonth: allowance.usedMonth,
      limitMonth: allowance.limitMonth,
      resetsOn: monthUsed ? allowance.monthResetsOn : dayUsed ? allowance.todayResetsOn : null,
      period: monthUsed ? "month" : dayUsed ? "day" : null,
      memberUsedToday,
      memberLimitToday: memberCap,
    },
    langPref: langPrefOf(pref),
    needsYou,
    demo,
    whatsapp,
    phase: config.phase,
    firstUse: !pref?.firstUseAckAt || pref.firstUseVersion !== deps.legalVersion,
    spendingStopped: freeze.effective !== "none",
  };
  return { status, setting, member, memberCap, memberUsedToday, allowance, freeze, pref, verificationRequired };
}

/** GET /api/eddy/status (5.11). */
export async function eddyStatus(actor: StatusActor, deps: StatusDeps): Promise<EddyStatusDTO> {
  return (await eddyGate(actor, deps)).status;
}

/** The catalogue key of an off state (6.11, 6.12), for callers that render the state's sentence. */
export function offStateKey(status: Pick<EddyStatusDTO, "state" | "reason" | "allowance">, role: StatusActor["role"]): string | null {
  switch (status.state) {
    case "platform_off":
      return status.reason === "paused" ? "off.platform_paused" : "off.platform";
    case "locked":
      return role === "agent" ? "locked.agent" : "locked.admin";
    case "workspace_off":
      return role === "owner" ? "turnon.what" : "turnon.ask_owner";
    case "allowance_used":
      return status.allowance.limitMonth !== null && status.allowance.usedMonth >= status.allowance.limitMonth ? "allowance.used" : "allowance.used_today";
    case "user_capped":
      return "user_capped";
    default:
      return null;
  }
}

