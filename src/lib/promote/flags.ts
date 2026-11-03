/**
 * Rollout flags of Instagram and Facebook Page ads (docs/IG-PAGE-ADS-SPEC.md 1.4, 9.7, D22, PRM-00). Read on every call, so a
 * test or an env change takes effect without a restart. src/lib/env-rules.mjs refuses an unknown value at startup; here an
 * unknown value falls back to the safe default, and the defaults are train P1 (dark):
 *   PROMOTE_ENABLED=off, PROMOTE_VIDEO=off, PROMOTE_AUDIENCES=off, PROMOTE_PAGE_LANGS=en, META_LOGIN_POPUP=on.
 *
 * Pure: no database, no network. The route guard (route-guard.ts) supplies the facts that need a lookup.
 */
import type { Role } from "@/generated/prisma/client";
import { spendEnforceMode, spendTripwireMode } from "@/lib/spend/flags";

type Env = Record<string, string | undefined>;

export type PromoteMode = "off" | "admins" | "on";
export type PromotePreviews = "meta" | "local";
export type PromoteVideo = "off" | "file_url" | "resumable";
export type PromoteAudiences = "off" | "engagement" | "all";
export type PromotePageLang = "en" | "hi" | "hinglish";

/** Every goal of the catalog (4.4). Keep equal to PROMOTE_GOAL_KEYS in src/lib/env-rules.mjs (tests/promote-flags.test.ts checks). */
export const PROMOTE_GOAL_KEYS = [
  "whatsapp_chats",
  "lead_form",
  "website_visits",
  "instagram_dms",
  "messenger_chats",
  "website_sales",
  "profile_visits",
  "engagement",
  "video_views",
  "awareness",
  "page_likes",
  "any_chat",
] as const;
export type PromoteGoalKey = (typeof PROMOTE_GOAL_KEYS)[number];

export const PROMOTE_PAGE_LANGS: readonly PromotePageLang[] = ["en", "hi", "hinglish"];

const read = (env: Env, key: string): string => (env[key] ?? "").trim().toLowerCase();
const isOn = (value: string): boolean => value === "1" || value === "true" || value === "yes" || value === "on";
const isOff = (value: string): boolean => value === "0" || value === "false" || value === "no" || value === "off";
const isProduction = (env: Env): boolean => (env.NODE_ENV ?? "").trim() === "production";

/** The master switch. off: nobody sees the feature. admins: Edwyz platform admins only (train P2). on: every workspace (P3). */
export function promoteEnabled(env: Env = process.env): PromoteMode {
  const v = read(env, "PROMOTE_ENABLED");
  return v === "admins" || v === "on" ? v : "off";
}

/**
 * The goals offered. A comma list of goal keys; unset (or empty) means every goal, and the catalog's verify states still hide
 * rows that only the documentation backs (D22). Unknown keys are dropped. A goal that failed its runbook step stays out.
 */
export function promoteGoals(env: Env = process.env): PromoteGoalKey[] {
  const raw = read(env, "PROMOTE_GOALS");
  if (!raw) return [...PROMOTE_GOAL_KEYS];
  const asked = new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
  return PROMOTE_GOAL_KEYS.filter((g) => asked.has(g));
}

/** meta: Meta's own preview iframes (D18). local: only "Our preview (approximate)", no Meta call. */
export function promotePreviews(env: Env = process.env): PromotePreviews {
  return read(env, "PROMOTE_PREVIEWS") === "local" ? "local" : "meta";
}

/** Video ads stay off until the VPS disk is below 80% (D21, train P4). file_url: Meta fetches a signed link; resumable: upload. */
export function promoteVideo(env: Env = process.env): PromoteVideo {
  const v = read(env, "PROMOTE_VIDEO");
  return v === "file_url" || v === "resumable" ? v : "off";
}

/** The audiences flag as set. Use effectiveAudiences() for what may be offered. */
export function promoteAudiences(env: Env = process.env): PromoteAudiences {
  const v = read(env, "PROMOTE_AUDIENCES");
  return v === "engagement" || v === "all" ? v : "off";
}

/** The lawyer review of customer-list audiences under the DPDP Act has passed (D17). */
export function legalDpdpAudiencesOk(env: Env = process.env): boolean {
  return isOn(read(env, "LEGAL_DPDP_AUDIENCES_OK"));
}

/**
 * What may be offered: customer lists (all) only with PROMOTE_AUDIENCES=all, and in production only with
 * LEGAL_DPDP_AUDIENCES_OK=1. Without the legal flag, production gets engagement, website and lookalike audiences only.
 */
export function effectiveAudiences(env: Env = process.env): PromoteAudiences {
  const v = promoteAudiences(env);
  if (v === "all" && isProduction(env) && !legalDpdpAudiencesOk(env)) return "engagement";
  return v;
}

/** Catalog rows still at verify state `docs` (D22). They show only for sandbox ad accounts, see promoteAccess(). */
export function promoteExperimental(env: Env = process.env): boolean {
  return isOn(read(env, "PROMOTE_EXPERIMENTAL"));
}

/** Page languages (D23). English always; hi and hinglish only after the native-speaker review flips them on. */
export function promotePageLangs(env: Env = process.env): PromotePageLang[] {
  const asked = new Set(read(env, "PROMOTE_PAGE_LANGS").split(",").map((s) => s.trim()).filter(Boolean));
  return PROMOTE_PAGE_LANGS.filter((l) => l === "en" || asked.has(l));
}

/** Facebook Login for Business opens as a popup (D20). Default on; off keeps the full-page redirect only. */
export function metaLoginPopup(env: Env = process.env): boolean {
  return !isOff(read(env, "META_LOGIN_POPUP"));
}

export type PromoteAccessInput = {
  /** The member's role in this workspace. */
  role: Role;
  /** An Edwyz platform admin (the eligibility rule of src/lib/admin/auth.ts). */
  isPlatformAdmin: boolean;
  /** The workspace's spending ad account is a Meta sandbox (test) account. */
  sandboxAccount: boolean;
};

export type PromoteAccess = {
  /** The feature exists for this member. When false every /api/promote route answers 404. */
  visible: boolean;
  /** Drafts, forms, audiences and settings may be changed (workspace admins and owners). Agents read only. */
  canWrite: boolean;
  /** The Start button: PROMOTE_ENABLED=on with both spend controls enforcing (train P3). */
  canStart: boolean;
  audiences: PromoteAudiences;
  video: PromoteVideo;
  previews: PromotePreviews;
  goals: PromoteGoalKey[];
  /** Catalog rows at verify state `docs` may show (D22): PROMOTE_EXPERIMENTAL and a sandbox ad account. */
  experimental: boolean;
  pageLangs: PromotePageLang[];
};

/** What a member who cannot see the feature gets: nothing on, no Meta previews. */
export const PROMOTE_HIDDEN: Readonly<PromoteAccess> = Object.freeze<PromoteAccess>({
  visible: false,
  canWrite: false,
  canStart: false,
  audiences: "off",
  video: "off",
  previews: "local",
  goals: [],
  experimental: false,
  pageLangs: ["en"],
});

/**
 * What one member may do with Instagram and Facebook Page ads.
 * - off: nothing is visible.
 * - admins: visible only to Edwyz platform admins, never to a customer's members (train P2). Start stays hidden.
 * - on: every workspace. Admins and owners write; agents read only.
 * Start needs PROMOTE_ENABLED=on, SPEND_ENFORCE=enforce and SPEND_TRIPWIRE=enforce (train P3), and a writer.
 */
export function promoteAccess(input: PromoteAccessInput, env: Env = process.env): PromoteAccess {
  const mode = promoteEnabled(env);
  const visible = mode === "on" || (mode === "admins" && input.isPlatformAdmin === true);
  if (!visible) return { ...PROMOTE_HIDDEN, goals: [], pageLangs: ["en"] };
  const canWrite = input.role === "owner" || input.role === "admin";
  const enforcing = spendEnforceMode(env) === "enforce" && spendTripwireMode(env) === "enforce";
  return {
    visible: true,
    canWrite,
    canStart: mode === "on" && canWrite && enforcing,
    audiences: effectiveAudiences(env),
    video: promoteVideo(env),
    previews: promotePreviews(env),
    goals: promoteGoals(env),
    experimental: promoteExperimental(env) && input.sandboxAccount === true,
    pageLangs: promotePageLangs(env),
  };
}

export type PromoteFlags = {
  enabled: PromoteMode;
  goals: PromoteGoalKey[];
  previews: PromotePreviews;
  video: PromoteVideo;
  audiences: PromoteAudiences;
  effectiveAudiences: PromoteAudiences;
  legalDpdpAudiencesOk: boolean;
  experimental: boolean;
  pageLangs: PromotePageLang[];
  metaLoginPopup: boolean;
};

/** Every flag at once, for health pages and tests. */
export function promoteFlags(env: Env = process.env): PromoteFlags {
  return {
    enabled: promoteEnabled(env),
    goals: promoteGoals(env),
    previews: promotePreviews(env),
    video: promoteVideo(env),
    audiences: promoteAudiences(env),
    effectiveAudiences: effectiveAudiences(env),
    legalDpdpAudiencesOk: legalDpdpAudiencesOk(env),
    experimental: promoteExperimental(env),
    pageLangs: promotePageLangs(env),
    metaLoginPopup: metaLoginPopup(env),
  };
}
