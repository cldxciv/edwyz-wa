/**
 * Eddy's switches and preferences (docs/EDDY-SPEC.md 5.5, 5.11, 6.11, 7.1, 7.9, 7.10, 12.1a decision 6). One of the three
 * persistence files Eddy's import boundary allows (4.8): EddyWorkspaceSetting, EddyUserPref, Eddy's PlatformSetting rows
 * (`eddy:platform`, `eddy:prefix-tokens:*`, `eddy:prefix-warm:*`) and the member and notice reads the status needs.
 *
 * Eddy is OFF by default (12.1a decision 6). Only the workspace OWNER turns it on, with one tap that also records the
 * AI-processing consent bound to LEGAL.version; a later LEGAL.version bump puts the workspace back to workspace_off until
 * the owner confirms again. Every change is audited. The route keeps the verified-email rule (5.11 critic): switching
 * Eddy on sends workspace data to Anthropic and starts AI spend.
 */
import { audit } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { LEGAL } from "@/lib/legal";
import { RETENTION_CONFIG_KEY, RETENTION_DEFAULTS, RETENTION_LIMITS } from "@/lib/lifecycle/personal-data";
import { supersededSpendRow } from "@/lib/notices/kinds";
import { HttpError, type Actor } from "@/lib/tenancy";
import { EDDY_LANGS, type EddyLangPref } from "./contract";
import type { NoticeFact } from "./context-note";

// ===== Workspace setting =====

export type EddyWorkspaceSettingDTO = {
  enabled: boolean;
  enabledById: string | null;
  enabledAt: string | null;
  consentVersion: string | null;
  /** True when the stored consent is for the current LEGAL.version. */
  consentCurrent: boolean;
  legalVersion: string;
  proactiveNotices: boolean;
  dailyTurnCap: number | null;
};

export type WorkspaceSettingRow = { enabled: boolean; enabledById: string | null; enabledAt: Date | null; consentVersion: string | null; proactiveNotices: boolean; dailyTurnCap: number | null };

const OFF: WorkspaceSettingRow = { enabled: false, enabledById: null, enabledAt: null, consentVersion: null, proactiveNotices: true, dailyTurnCap: null };

export async function workspaceSetting(tenantId: string): Promise<WorkspaceSettingRow> {
  const row = await prisma.eddyWorkspaceSetting.findFirst({
    where: { tenantId },
    select: { enabled: true, enabledById: true, enabledAt: true, consentVersion: true, proactiveNotices: true, dailyTurnCap: true },
  });
  return row ?? OFF;
}

/** On for this workspace: switched on, with consent for the current LEGAL.version (5.11 state 3). */
export function workspaceEnabled(s: Pick<WorkspaceSettingRow, "enabled" | "consentVersion">, legalVersion: string = LEGAL.version): boolean {
  return s.enabled && s.consentVersion === legalVersion;
}

export function settingDTO(s: WorkspaceSettingRow): EddyWorkspaceSettingDTO {
  return {
    enabled: s.enabled,
    enabledById: s.enabledById,
    enabledAt: s.enabledAt ? s.enabledAt.toISOString() : null,
    consentVersion: s.consentVersion,
    consentCurrent: s.consentVersion === LEGAL.version,
    legalVersion: LEGAL.version,
    proactiveNotices: s.proactiveNotices,
    dailyTurnCap: s.dailyTurnCap,
  };
}

export type SettingsUpdate = { enabled?: boolean; consent?: boolean; proactiveNotices?: boolean; dailyTurnCap?: number | null };

/** Parses the PUT /api/eddy/settings body; unknown fields are ignored, bad values are a 400. */
export function parseSettingsUpdate(body: Record<string, unknown>): SettingsUpdate {
  const out: SettingsUpdate = {};
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") throw new HttpError(400, "Choose whether Eddy is on or off.");
    out.enabled = body.enabled;
  }
  if (body.consent !== undefined) {
    if (typeof body.consent !== "boolean") throw new HttpError(400, "The consent answer is not valid.");
    out.consent = body.consent;
  }
  if (body.proactiveNotices !== undefined) {
    if (typeof body.proactiveNotices !== "boolean") throw new HttpError(400, "Choose whether Eddy shows notices.");
    out.proactiveNotices = body.proactiveNotices;
  }
  if (body.dailyTurnCap !== undefined) {
    const v = body.dailyTurnCap;
    if (v !== null && !(typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 100_000)) throw new HttpError(400, "The daily message limit must be a whole number from 1 to 100,000, or empty for no limit.");
    out.dailyTurnCap = v as number | null;
  }
  if (Object.keys(out).length === 0) throw new HttpError(400, "Nothing to change.");
  return out;
}

export const OWNER_ONLY_MESSAGE = "Only the workspace owner can switch Eddy on or change its settings.";
export const CONSENT_NEEDED_MESSAGE = "Read what Eddy does with your data, then switch it on to agree.";

/**
 * Changes the workspace's Eddy setting. OWNER ONLY (12.1a decision 6; an admin gets 403). Switching on stores enabledById,
 * enabledAt and consentVersion = LEGAL.version (the tap is the AI-processing consent). Audited as eddy.settings.
 */
export async function updateWorkspaceSetting(actor: Actor, update: SettingsUpdate, now: Date = new Date()): Promise<WorkspaceSettingRow> {
  if (actor.role !== "owner") throw new HttpError(403, OWNER_ONLY_MESSAGE);
  if (update.enabled === true && update.consent === false) throw new HttpError(400, CONSENT_NEEDED_MESSAGE);
  const current = await prisma.eddyWorkspaceSetting.findFirst({ where: { tenantId: actor.tenantId }, select: { tenantId: true } });
  const data: Record<string, unknown> = { updatedAt: now };
  if (update.enabled === true) Object.assign(data, { enabled: true, enabledById: actor.userId, enabledAt: now, consentVersion: LEGAL.version });
  if (update.enabled === false) data.enabled = false;
  if (update.proactiveNotices !== undefined) data.proactiveNotices = update.proactiveNotices;
  if (update.dailyTurnCap !== undefined) data.dailyTurnCap = update.dailyTurnCap;
  if (current) await prisma.eddyWorkspaceSetting.updateMany({ where: { tenantId: actor.tenantId }, data });
  else await prisma.eddyWorkspaceSetting.create({ data: { tenantId: actor.tenantId, enabled: false, enabledById: null, enabledAt: null, consentVersion: null, proactiveNotices: true, dailyTurnCap: null, ...data } as never });
  const action = update.enabled === true ? "eddy.enabled" : update.enabled === false ? "eddy.disabled" : "eddy.settings";
  await audit({
    tenantId: actor.tenantId,
    userId: actor.userId,
    action,
    target: actor.tenantId,
    meta: {
      ...(update.enabled !== undefined ? { enabled: update.enabled } : {}),
      ...(update.enabled === true ? { consentVersion: LEGAL.version } : {}),
      ...(update.proactiveNotices !== undefined ? { proactiveNotices: update.proactiveNotices } : {}),
      ...(update.dailyTurnCap !== undefined ? { dailyTurnCap: update.dailyTurnCap } : {}),
    },
  });
  return workspaceSetting(actor.tenantId);
}

// ===== Member preference =====

export type EddyUserPrefDTO = {
  language: EddyLangPref;
  proactive: boolean;
  mutedNoticeKinds: string[];
  firstUseAckAt: string | null;
  firstUseVersion: string | null;
  /** The first-use notice (6.11) must show: never acknowledged, or acknowledged for an older LEGAL.version. */
  firstUse: boolean;
};

export type UserPrefRow = { language: string; proactive: boolean; mutedNoticeKinds: string[]; firstUseAckAt: Date | null; firstUseVersion: string | null };

const LANG_PREFS: readonly EddyLangPref[] = ["auto", ...EDDY_LANGS];
export const isLangPref = (v: unknown): v is EddyLangPref => typeof v === "string" && (LANG_PREFS as readonly string[]).includes(v);

export async function userPref(tenantId: string, userId: string): Promise<UserPrefRow | null> {
  return prisma.eddyUserPref.findFirst({ where: { tenantId, userId }, select: { language: true, proactive: true, mutedNoticeKinds: true, firstUseAckAt: true, firstUseVersion: true } });
}

export function prefDTO(p: UserPrefRow | null): EddyUserPrefDTO {
  return {
    language: isLangPref(p?.language) ? p.language : "auto",
    proactive: p?.proactive ?? true,
    mutedNoticeKinds: p?.mutedNoticeKinds ?? [],
    firstUseAckAt: p?.firstUseAckAt ? p.firstUseAckAt.toISOString() : null,
    firstUseVersion: p?.firstUseVersion ?? null,
    firstUse: !p?.firstUseAckAt || p.firstUseVersion !== LEGAL.version,
  };
}

export type PrefsUpdate = { language?: EddyLangPref; proactive?: boolean; mutedNoticeKinds?: string[]; firstUseAck?: true };

const NOTICE_KIND = /^[a-z][a-z0-9_]{1,39}$/;

/** Parses PUT /api/eddy/prefs: language auto | en | hi | hinglish, the first-use acknowledgement, notice switches. */
export function parsePrefsUpdate(body: Record<string, unknown>): PrefsUpdate {
  const out: PrefsUpdate = {};
  if (body.language !== undefined) {
    if (!isLangPref(body.language)) throw new HttpError(400, "Choose Auto, English, Hindi or Hinglish.");
    out.language = body.language;
  }
  if (body.proactive !== undefined) {
    if (typeof body.proactive !== "boolean") throw new HttpError(400, "Choose whether Eddy shows notices.");
    out.proactive = body.proactive;
  }
  if (body.mutedNoticeKinds !== undefined) {
    const v = body.mutedNoticeKinds;
    if (!Array.isArray(v) || v.length > 30 || !v.every((k) => typeof k === "string" && NOTICE_KIND.test(k))) throw new HttpError(400, "The muted notice list is not valid.");
    out.mutedNoticeKinds = [...new Set(v as string[])];
  }
  if (body.firstUseAck !== undefined) {
    if (body.firstUseAck !== true) throw new HttpError(400, "The acknowledgement is not valid.");
    out.firstUseAck = true;
  }
  if (Object.keys(out).length === 0) throw new HttpError(400, "Nothing to change.");
  return out;
}

/** Saves the member's own preference. The first-use acknowledgement records firstUseAckAt and firstUseVersion = LEGAL.version. */
export async function updateUserPref(actor: Actor, update: PrefsUpdate, now: Date = new Date()): Promise<UserPrefRow> {
  const data: Record<string, unknown> = { updatedAt: now };
  if (update.language) data.language = update.language;
  if (update.proactive !== undefined) data.proactive = update.proactive;
  if (update.mutedNoticeKinds) data.mutedNoticeKinds = update.mutedNoticeKinds;
  if (update.firstUseAck) Object.assign(data, { firstUseAckAt: now, firstUseVersion: LEGAL.version });
  const existing = await userPref(actor.tenantId, actor.userId);
  if (existing) await prisma.eddyUserPref.updateMany({ where: { tenantId: actor.tenantId, userId: actor.userId }, data });
  else await prisma.eddyUserPref.create({ data: { tenantId: actor.tenantId, userId: actor.userId, language: "auto", proactive: true, mutedNoticeKinds: [], firstUseAckAt: null, firstUseVersion: null, ...data } as never });
  return (await userPref(actor.tenantId, actor.userId)) as UserPrefRow;
}

// ===== Platform settings =====

export const EDDY_PLATFORM_KEY = "eddy:platform";
export const prefixTokensKey = (model: string, roleClass: string) => `eddy:prefix-tokens:${model}:${roleClass}`;
export const prefixWarmKey = (model: string, roleClass: string) => `eddy:prefix-warm:${model}:${roleClass}`;

const record = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** The ops kill switch (7.10): PlatformSetting `eddy:platform` {enabled:false, reason}. */
export async function platformSwitchOff(): Promise<boolean> {
  const row = await prisma.platformSetting.findFirst({ where: { key: EDDY_PLATFORM_KEY }, select: { value: true } });
  return record(row?.value).enabled === false;
}

/** The measured tools-plus-system prefix (5.5), or null before the deploy step has measured it. */
export async function measuredPrefixTokens(model: string, roleClass: string): Promise<number | null> {
  const row = await prisma.platformSetting.findFirst({ where: { key: prefixTokensKey(model, roleClass) }, select: { value: true } });
  const v = row?.value;
  const n = typeof v === "number" ? v : record(v).tokens;
  return typeof n === "number" && Number.isFinite(n) && n > 0 && n < 1_000_000 ? Math.floor(n) : null;
}

/** Refreshes `eddy:prefix-warm:<model>:<roleClass>` (cache telemetry only, 5.10). Never throws. */
export async function notePrefixWarm(model: string, roleClass: string, now: Date = new Date()): Promise<void> {
  const key = prefixWarmKey(model, roleClass);
  const value = { at: now.toISOString() };
  try {
    const updated = await prisma.platformSetting.updateMany({ where: { key }, data: { value } });
    if (updated.count === 0) await prisma.platformSetting.create({ data: { key, value } });
  } catch {
    // Telemetry only.
  }
}

// ===== Member, notices, retention =====

export type MemberFacts = { name: string | null; emailVerified: boolean };

export async function memberFacts(userId: string): Promise<MemberFacts> {
  const user = await prisma.user.findFirst({ where: { id: userId }, select: { name: true, emailVerifiedAt: true } });
  return { name: user?.name ?? null, emailVerified: !!user?.emailVerifiedAt };
}

const ROLE_RANK: Record<Actor["role"], number> = { agent: 1, admin: 2, owner: 3 };

type NoticeRow = { id: string; kind: string; severity: string; source: string; subjectType: string | null; subjectId: string | null; dedupeKey: string | null; audienceUserId: string | null; audienceMinRole: Actor["role"]; updatedAt: Date };

async function visibleNotices(actor: Actor, now: Date, extra: Record<string, unknown> = {}): Promise<NoticeRow[]> {
  const rows = (await prisma.notice.findMany({
    where: { tenantId: actor.tenantId, resolvedAt: null, expiresAt: { gt: now }, OR: [{ audienceUserId: null }, { audienceUserId: actor.userId }], ...extra },
    orderBy: { updatedAt: "desc" },
    take: 200,
    // dedupeKey: supersededSpendRow knows Phase 0's "ads-review:<ad>:rejected" row by it, as listNotices does.
    select: { id: true, kind: true, severity: true, source: true, subjectType: true, subjectId: true, dedupeKey: true, audienceUserId: true, audienceMinRole: true, updatedAt: true },
  })) as NoticeRow[];
  const allowed = rows.filter((n) => ROLE_RANK[actor.role] >= (ROLE_RANK[n.audienceMinRole] ?? 1));
  if (allowed.length === 0) return [];
  const dismissed = await prisma.noticeReceipt.findMany({ where: { tenantId: actor.tenantId, userId: actor.userId, noticeId: { in: allowed.map((n) => n.id) }, dismissedAt: { not: null } }, select: { noticeId: true } });
  const gone = new Set(dismissed.map((d) => d.noticeId));
  const pref = await userPref(actor.tenantId, actor.userId);
  const muted = new Set(pref?.mutedNoticeKinds ?? []);
  // The same rule as the strip (src/lib/notices/service.ts listNotices): a Phase 0 row that an Eddy notice already covers is
  // hidden, so the launcher dot never counts one more than "Needs you" shows.
  const eddyRows = allowed.filter((n) => n.source !== "spend");
  return allowed.filter((n) => !gone.has(n.id) && !muted.has(n.kind) && !supersededSpendRow(n, eddyRows));
}

/** Notices that need the member (the launcher dot and "Needs you", 6.7): action needed or heads-up, not dismissed. */
export async function needsYouCount(actor: Actor, now: Date = new Date()): Promise<number> {
  const rows = await visibleNotices(actor, now);
  return rows.filter((n) => n.severity === "action_needed" || n.severity === "heads_up").length;
}

/** Notices updated since `since`, for the context note: kinds and subject ids only, never their text (5.6, 6.7). */
export async function recentNoticeFacts(actor: Actor, since: Date, now: Date = new Date()): Promise<NoticeFact[]> {
  const rows = await visibleNotices(actor, now, { updatedAt: { gte: since } });
  return rows.slice(0, 5).map((n) => ({ kind: n.kind, ref: n.subjectId }));
}

/** How many days Eddy chats are kept (eddyHistoryDays, 30 to 365), for the {days} of the disclosure copy (7.9). */
export async function eddyHistoryDays(): Promise<number> {
  return retentionDays("eddyHistoryDays");
}

/** How long a record of confirmed actions is kept (actionRecordDays), for "Delete my Eddy history" (7.6). */
export async function actionRecordDays(): Promise<number> {
  return retentionDays("actionRecordDays");
}

/** A retention setting as lifecycle/retention.ts resolves it: the platform's configured value within its limits, else the default. */
async function retentionDays(key: "eddyHistoryDays" | "actionRecordDays"): Promise<number> {
  try {
    const row = await prisma.platformSetting.findFirst({ where: { key: RETENTION_CONFIG_KEY }, select: { value: true } });
    const v = record(row?.value)[key];
    const { min, max } = RETENTION_LIMITS[key];
    return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : RETENTION_DEFAULTS[key];
  } catch {
    return RETENTION_DEFAULTS[key];
  }
}
