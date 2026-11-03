/**
 * Promote settings of a workspace, and each member's display preferences (docs/IG-PAGE-ADS-SPEC.md 3.2, 3.5, 5.4, PRM-10).
 *
 * PlatformSetting rows, no migration:
 * - `promote:settings:<tenantId>` holds {privacyUrl, shop:{lat, lng, label, pincode}, welcome:{en, hi, hinglish}, preferredGoal}.
 * - `promote:member-prefs:<tenantId>:<userId>` holds {showAllOptions}.
 * Both keys carry the workspace id, so erasing the workspace removes them (lifecycle/erase-workspace.ts).
 *
 * Reads are lenient: anything malformed in a stored row reads as not set. Writes are strict and refuse with plain copy (an
 * HttpError 400). The privacy link is the business's own and must be https (D13, 11.1a decision 2): Edwyz never hosts one.
 * PRM-09 adds GET and PUT /api/promote/settings on top of these functions.
 */
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { HttpError } from "@/lib/tenancy";
import { promoteText } from "./copy";
import { isGoalKey, type GoalKey } from "./types";

export const settingsKey = (tenantId: string) => `promote:settings:${tenantId}`;
export const memberPrefsKey = (tenantId: string, userId: string) => `promote:member-prefs:${tenantId}:${userId}`;

export const PRIVACY_URL_MAX = 2_000;
export const SHOP_LABEL_MAX = 100;
export const WELCOME_MAX = 1_000;

export type ShopLocation = { lat: number | null; lng: number | null; label: string | null; pincode: string | null };
export type WelcomeMessages = { en: string | null; hi: string | null; hinglish: string | null };
export type PromoteSettings = { privacyUrl: string | null; shop: ShopLocation | null; welcome: WelcomeMessages; preferredGoal: GoalKey | null };
export type MemberPrefs = { showAllOptions: boolean };

export const EMPTY_SETTINGS: PromoteSettings = Object.freeze({
  privacyUrl: null,
  shop: null,
  welcome: Object.freeze({ en: null, hi: null, hinglish: null }) as WelcomeMessages,
  preferredGoal: null,
}) as PromoteSettings;

export const PROMOTE_SETTINGS_COPY = {
  privacyMissing: promoteText("form.privacy_help"),
  privacyHttps: promoteText("form.privacy_https"),
  privacyInvalid: "Enter the full link to your privacy policy, starting with https://",
  privacyTooLong: "The privacy policy link is too long. Use a shorter link.",
  pincode: "Enter a 6-digit PIN code.",
  coordinates: "Pick your shop on the map again.",
  shopEmpty: "Add your shop's PIN code or pick it on the map.",
  shopLabel: `The shop name can be up to ${SHOP_LABEL_MAX} characters.`,
  welcome: `Each welcome message can be up to ${WELCOME_MAX.toLocaleString("en-IN")} characters.`,
  goal: "Choose one of the goals on the list.",
  notObject: "Send the settings as an object.",
  showAllOptions: "Choose on or off for \"Show all options\".",
} as const;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const refuse = (message: string): never => {
  throw new HttpError(400, message);
};

// ===== The privacy link (shared with promote/lead-forms) =====

/**
 * What is wrong with a privacy-policy link, in plain words, or null when it can be used: https, a real host name (with a dot),
 * no user name or password in it, and at most 2,000 characters.
 */
export function privacyUrlProblem(value: unknown): string | null {
  if (value === undefined || value === null || (typeof value === "string" && !value.trim())) return PROMOTE_SETTINGS_COPY.privacyMissing;
  if (typeof value !== "string") return PROMOTE_SETTINGS_COPY.privacyInvalid;
  const text = value.trim();
  if (text.length > PRIVACY_URL_MAX) return PROMOTE_SETTINGS_COPY.privacyTooLong;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return /^https?:/i.test(text) ? PROMOTE_SETTINGS_COPY.privacyInvalid : PROMOTE_SETTINGS_COPY.privacyHttps;
  }
  if (url.protocol !== "https:") return PROMOTE_SETTINGS_COPY.privacyHttps;
  if (url.username || url.password || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(url.hostname)) return PROMOTE_SETTINGS_COPY.privacyInvalid;
  return null;
}

/** The link as stored and sent to Meta (trimmed, normalised by URL). Call privacyUrlProblem first. */
export const normalizePrivacyUrl = (value: string): string => new URL(value.trim()).toString();

// ===== Parsing (lenient, for reads) =====

const text = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() && v.length <= max ? v.trim() : null);
const coordinate = (v: unknown, limit: number): number | null => (typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= limit ? v : null);
const PINCODE = /^[1-9][0-9]{5}$/;

function parseShop(v: unknown): ShopLocation | null {
  if (!isObject(v)) return null;
  const lat = coordinate(v.lat, 90);
  const lng = coordinate(v.lng, 180);
  const pair = lat !== null && lng !== null;
  const pincode = typeof v.pincode === "string" && PINCODE.test(v.pincode) ? v.pincode : null;
  if (!pair && !pincode) return null;
  return { lat: pair ? lat : null, lng: pair ? lng : null, label: text(v.label, SHOP_LABEL_MAX), pincode };
}

/** A stored settings row as the app uses it; anything malformed reads as not set. */
export function parsePromoteSettings(raw: unknown): PromoteSettings {
  const v = isObject(raw) ? raw : {};
  const welcome = isObject(v.welcome) ? v.welcome : {};
  const privacy = typeof v.privacyUrl === "string" && privacyUrlProblem(v.privacyUrl) === null ? normalizePrivacyUrl(v.privacyUrl) : null;
  return {
    privacyUrl: privacy,
    shop: parseShop(v.shop),
    welcome: { en: text(welcome.en, WELCOME_MAX), hi: text(welcome.hi, WELCOME_MAX), hinglish: text(welcome.hinglish, WELCOME_MAX) },
    preferredGoal: isGoalKey(v.preferredGoal) ? v.preferredGoal : null,
  };
}

export const parseMemberPrefs = (raw: unknown): MemberPrefs => ({ showAllOptions: isObject(raw) && raw.showAllOptions === true });

// ===== Validation (strict, for writes) =====

function validShop(v: unknown): ShopLocation | null {
  if (v === null) return null;
  if (!isObject(v)) return refuse(PROMOTE_SETTINGS_COPY.shopEmpty);
  const hasLat = v.lat !== undefined && v.lat !== null;
  const hasLng = v.lng !== undefined && v.lng !== null;
  if (hasLat !== hasLng) refuse(PROMOTE_SETTINGS_COPY.coordinates);
  const lat = hasLat ? (coordinate(v.lat, 90) ?? refuse(PROMOTE_SETTINGS_COPY.coordinates)) : null;
  const lng = hasLng ? (coordinate(v.lng, 180) ?? refuse(PROMOTE_SETTINGS_COPY.coordinates)) : null;
  let pincode: string | null = null;
  if (v.pincode !== undefined && v.pincode !== null && v.pincode !== "") {
    const p = typeof v.pincode === "number" ? String(v.pincode) : typeof v.pincode === "string" ? v.pincode.replace(/\s+/g, "") : "";
    if (!PINCODE.test(p)) refuse(PROMOTE_SETTINGS_COPY.pincode);
    pincode = p;
  }
  if (lat === null && pincode === null) refuse(PROMOTE_SETTINGS_COPY.shopEmpty);
  let label: string | null = null;
  if (v.label !== undefined && v.label !== null) {
    if (typeof v.label !== "string" || v.label.trim().length > SHOP_LABEL_MAX) refuse(PROMOTE_SETTINGS_COPY.shopLabel);
    label = (v.label as string).trim() || null;
  }
  return { lat, lng, label, pincode };
}

function validWelcome(v: unknown, current: WelcomeMessages): WelcomeMessages {
  if (v === null) return { en: null, hi: null, hinglish: null };
  if (!isObject(v)) return refuse(PROMOTE_SETTINGS_COPY.welcome);
  const out = { ...current };
  for (const lang of ["en", "hi", "hinglish"] as const) {
    const m = v[lang];
    if (m === undefined) continue;
    if (m === null) {
      out[lang] = null;
      continue;
    }
    if (typeof m !== "string" || m.trim().length > WELCOME_MAX) refuse(PROMOTE_SETTINGS_COPY.welcome);
    out[lang] = (m as string).trim() || null;
  }
  return out;
}

/**
 * The settings after applying a change. Each key that is given replaces the stored one (null clears it); keys left out stay.
 * Refuses with plain copy: a link that isn't https, a PIN code that isn't 6 digits, a map point off the map, an unknown goal.
 */
export function applySettingsPatch(current: PromoteSettings, patch: unknown): PromoteSettings {
  if (!isObject(patch)) return refuse(PROMOTE_SETTINGS_COPY.notObject);
  const next: PromoteSettings = { ...current, welcome: { ...current.welcome } };
  if (patch.privacyUrl !== undefined) {
    if (patch.privacyUrl === null || patch.privacyUrl === "") next.privacyUrl = null;
    else {
      const problem = privacyUrlProblem(patch.privacyUrl);
      if (problem) refuse(problem);
      next.privacyUrl = normalizePrivacyUrl(patch.privacyUrl as string);
    }
  }
  if (patch.shop !== undefined) next.shop = validShop(patch.shop);
  if (patch.welcome !== undefined) next.welcome = validWelcome(patch.welcome, current.welcome);
  if (patch.preferredGoal !== undefined) {
    if (patch.preferredGoal !== null && !isGoalKey(patch.preferredGoal)) refuse(PROMOTE_SETTINGS_COPY.goal);
    next.preferredGoal = (patch.preferredGoal as GoalKey | null) ?? null;
  }
  return next;
}

// ===== Storage =====

async function readRow(key: string): Promise<unknown> {
  const row = await prisma.platformSetting.findUnique({ where: { key } });
  return row?.value ?? null;
}

async function writeRow(key: string, value: Record<string, unknown>): Promise<void> {
  const json = value as unknown as Prisma.InputJsonValue;
  await prisma.platformSetting.upsert({ where: { key }, create: { key, value: json }, update: { value: json } });
}

/** The workspace's Promote settings (defaults when none are saved). */
export async function getPromoteSettings(tenantId: string): Promise<PromoteSettings> {
  return parsePromoteSettings(await readRow(settingsKey(tenantId)));
}

/** Saves a change to the workspace's Promote settings and returns them. Keys left out keep their saved value. */
export async function setPromoteSettings(tenantId: string, patch: unknown): Promise<PromoteSettings> {
  const next = applySettingsPatch(await getPromoteSettings(tenantId), patch);
  await writeRow(settingsKey(tenantId), next as unknown as Record<string, unknown>);
  return next;
}

/** One member's display preferences in this workspace. */
export async function getMemberPrefs(tenantId: string, userId: string): Promise<MemberPrefs> {
  return parseMemberPrefs(await readRow(memberPrefsKey(tenantId, userId)));
}

/** Saves one member's display preferences. */
export async function setMemberPrefs(tenantId: string, userId: string, patch: unknown): Promise<MemberPrefs> {
  if (!isObject(patch)) return refuse(PROMOTE_SETTINGS_COPY.notObject);
  const current = await getMemberPrefs(tenantId, userId);
  const next: MemberPrefs = { ...current };
  if (patch.showAllOptions !== undefined) {
    if (typeof patch.showAllOptions !== "boolean") refuse(PROMOTE_SETTINGS_COPY.showAllOptions);
    next.showAllOptions = patch.showAllOptions as boolean;
  }
  await writeRow(memberPrefsKey(tenantId, userId), next);
  return next;
}
