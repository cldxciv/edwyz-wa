import { prisma } from "@/lib/db";
import { OPT_IN_REPLY, OPT_OUT_REPLY } from "@/lib/contacts/opt-out";
import { HttpError } from "@/lib/tenancy";
import { checkStopWord, cleanStopWords, MAX_WORKSPACE_STOP_WORDS } from "@/lib/webhooks/payload";

/**
 * Per-workspace inbox options, kept in one PlatformSetting row (key inbox:settings:<tenantId>) because no tenant settings table exists.
 * - agentSignature: put the sending agent's name in front of the text they send, so customers see who is writing.
 * - optOutReply / optInReply: the confirmation sent when a customer replies STOP or START. Empty text sends nothing.
 * - stopWords: the workspace's own STOP words, on top of DEFAULT_STOP_WORDS (webhooks/payload.ts). Stored normalised.
 */
export type InboxSettings = { agentSignature: boolean; optOutReply: string; optInReply: string; stopWords: string[] };

export const DEFAULT_INBOX_SETTINGS: InboxSettings = {
  agentSignature: false,
  optOutReply: OPT_OUT_REPLY,
  optInReply: OPT_IN_REPLY,
  stopWords: [],
};

/**
 * The confirmations earlier releases used as defaults. A workspace that saved its settings without editing them has these stored
 * word for word; they said nothing about order updates still arriving, so they read as today's defaults instead.
 */
const LEGACY_DEFAULT_REPLIES: Record<string, string> = {
  "You have been unsubscribed and will not get marketing messages from us. Reply START to subscribe again.": OPT_OUT_REPLY,
  "You are subscribed again. Reply STOP at any time to unsubscribe.": OPT_IN_REPLY,
};

const MAX_REPLY = 500;
export const inboxSettingsKey = (tenantId: string) => `inbox:settings:${tenantId}`;

export function cleanSettings(raw: unknown): InboxSettings {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const text = (v: unknown, fallback: string) => (typeof v === "string" ? (LEGACY_DEFAULT_REPLIES[v.trim()] ?? v.trim().slice(0, MAX_REPLY)) : fallback);
  return {
    agentSignature: r.agentSignature === true,
    optOutReply: text(r.optOutReply, DEFAULT_INBOX_SETTINGS.optOutReply),
    optInReply: text(r.optInReply, DEFAULT_INBOX_SETTINGS.optInReply),
    stopWords: cleanStopWords(r.stopWords),
  };
}

/** Validates the STOP words from the settings form: up to MAX_WORKSPACE_STOP_WORDS words, each usable. Returns them as stored. */
export function parseStopWords(value: unknown): string[] {
  if (!Array.isArray(value)) throw new HttpError(400, "stopWords must be a list of words.");
  if (value.length > MAX_WORKSPACE_STOP_WORDS * 5) throw new HttpError(400, `You can add up to ${MAX_WORKSPACE_STOP_WORDS} STOP words.`);
  for (const item of value) {
    const checked = checkStopWord(item);
    if (!checked.ok) throw new HttpError(400, checked.reason);
  }
  const words = cleanStopWords(value, Number.POSITIVE_INFINITY);
  if (words.length > MAX_WORKSPACE_STOP_WORDS) throw new HttpError(400, `You can add up to ${MAX_WORKSPACE_STOP_WORDS} STOP words.`);
  return words;
}

export async function getInboxSettings(tenantId: string): Promise<InboxSettings> {
  try {
    const row = await prisma.platformSetting.findUnique({ where: { key: inboxSettingsKey(tenantId) } });
    return cleanSettings(row?.value);
  } catch {
    return cleanSettings(null);
  }
}

/** Validates a partial update from the settings dialog. */
export function parseSettingsPatch(body: Record<string, unknown>): Partial<InboxSettings> {
  const patch: Partial<InboxSettings> = {};
  if (body.agentSignature !== undefined) {
    if (typeof body.agentSignature !== "boolean") throw new HttpError(400, "agentSignature must be true or false.");
    patch.agentSignature = body.agentSignature;
  }
  for (const key of ["optOutReply", "optInReply"] as const) {
    const value = body[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.length > MAX_REPLY) throw new HttpError(400, `${key} must be text of up to ${MAX_REPLY} characters.`);
    patch[key] = value.trim();
  }
  if (body.stopWords !== undefined) patch.stopWords = parseStopWords(body.stopWords);
  if (Object.keys(patch).length === 0) throw new HttpError(400, "Nothing to update.");
  return patch;
}

export async function updateInboxSettings(tenantId: string, patch: Partial<InboxSettings>): Promise<InboxSettings> {
  const next = { ...(await getInboxSettings(tenantId)), ...patch };
  await prisma.platformSetting.upsert({ where: { key: inboxSettingsKey(tenantId) }, create: { key: inboxSettingsKey(tenantId), value: next }, update: { value: next } });
  return next;
}

/** The name printed in front of an agent's text, or undefined when the option is off or the agent has no name. */
export function signatureFor(settings: InboxSettings, agentName: string | null | undefined): string | undefined {
  if (!settings.agentSignature) return undefined;
  const name = (agentName ?? "").replace(/[*\r\n]+/g, " ").trim().slice(0, 60);
  return name || undefined;
}

/** The signature to send with this agent's text, or undefined when the workspace option is off. */
export async function signatureForUser(tenantId: string, userId: string): Promise<string | undefined> {
  const settings = await getInboxSettings(tenantId);
  if (!settings.agentSignature) return undefined;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
  return signatureFor(settings, user?.name);
}
