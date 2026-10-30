/**
 * The platform-owned WhatsApp sender for owner notifications (docs/SPEND-CONTROLS-SPEC.md 7.4 item 1; docs/platform-notifier.md).
 *
 * - Configured in PlatformSetting 'spend:notify': {tenantId, phoneNumberId, language, templates: {approval, alert, digest,
 *   optin}, senderDisplay?}. Today that is the Edwyz workspace `edwyz-test`, +1 711-268-5789 at TIER_250 (12.1a decision 1).
 * - Every message goes through the normal inbox path, `sendTemplateMessage` in the notifier workspace with origin
 *   `system_notify`, so it passes the send gate and is counted against the notifier workspace's own pots (the platform pays).
 *   The owner is a Contact there, opted in and tagged `owner_spend_alerts`. The subject workspace is written into the
 *   message's first timeline entry as `source: "spend_notify:<tenantId>"` (the slot admin_test uses), so erasure can find it.
 * - Health (4.16): the notifier workspace must be billingExempt and active, its AI agent, chatbots and automations off, and
 *   its members platform admins only. notifierHealth() lists what is wrong; the hourly spend.notify.health task and the
 *   first send of each process log it as a warning, and the admin panel shows it.
 * - Capacity (TIER_250): at most 250 distinct owners in a rolling 24 hours. Above 200, alerts and approvals still go out and
 *   digests stay in the app; at 250 nobody new is messaged. An owner already messaged today never uses a new slot.
 * Never throws from a send: every refusal is an outcome with a reason, and the caller falls back to the app.
 */
import { prisma } from "@/lib/db";
import { describeError } from "@/lib/safe-error";
import { HttpError } from "@/lib/tenancy";
import type { SpendDb } from "../control";
import { NOTIFY_TEMPLATES, TEMPLATE_KEYS, templateComponents, type TemplateKey, type TemplateValues } from "./templates";

export const NOTIFIER_KEY = "spend:notify";
/** The message source that marks a notifier send and names the workspace it is about. */
export const NOTIFY_SOURCE_PREFIX = "spend_notify:";
export const OWNER_CONTACT_TAG = "owner_spend_alerts";
/** Meta's TIER_250: distinct people a number may start conversations with in a rolling 24 hours. */
export const TIER_LIMIT = 250;
/** Above this many owners in 24 hours, digests stay in the app so alerts and approvals keep their room (7.4 item 6). */
export const DIGEST_CUTOFF = 200;
/**
 * At most this many people a day get only a confirmation (spend_optin_v1) and nothing else: a confirmation goes to a number
 * nobody has proved yet, so a run of sign-ups to made-up numbers may use at most 20% of TIER_250. Approvals and alerts to
 * verified owners keep the rest.
 */
export const OPTIN_TIER_CAP = Math.floor(TIER_LIMIT / 5);
const DAY_MS = 24 * 3_600_000;
const READY_CACHE_MS = 60_000;
/** Number problems that stop the sender: Meta rated it RED (LOW), restricted it or disabled the account. */
const BLOCKING_BREAKERS = ["wa_quality_red", "wa_restricted", "waba_disabled"];

export type NotifierConfig = {
  tenantId: string;
  /** PhoneNumber row id or Meta's phone number id; both are accepted. */
  phoneNumberId: string;
  language: string;
  templates: Record<TemplateKey, string>;
  senderDisplay: string | null;
};

export type NotifyPurpose = "approval" | "alert" | "digest" | "optin" | "reply";

export type SendOutcome = { sent: true; messageId: string; contactId: string } | { sent: false; reason: string };

type Db = SpendDb;
const dbOf = (db?: Db): Db => db ?? (prisma as unknown as Db);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Digits of a phone in E.164 ("+919876543210" -> "919876543210"); Meta's wa_id has no plus. */
export const phoneDigits = (phone: string | null | undefined): string => String(phone ?? "").replace(/\D/g, "");
/** The E.164 form of a wa_id or a phone. */
export const toE164 = (phone: string | null | undefined): string => `+${phoneDigits(phone)}`;

/** Reads 'spend:notify'. Null when it is not set up (then every notice stays in the app). */
export async function readNotifierConfig(db?: Db): Promise<NotifierConfig | null> {
  try {
    const row = (await dbOf(db).platformSetting.findUnique({ where: { key: NOTIFIER_KEY } })) as { value?: unknown } | null;
    return parseNotifierConfig(row?.value);
  } catch (error) {
    console.error(`[spend] notifier settings not readable: ${describeError(error)}`);
    return null;
  }
}

/** The settings value as stored, or null when it names no workspace and number. Pure. */
export function parseNotifierConfig(value: unknown): NotifierConfig | null {
  const v = rec(value);
  const tenantId = str(v.tenantId);
  const phoneNumberId = str(v.phoneNumberId);
  if (!tenantId || !phoneNumberId) return null;
  const names = rec(v.templates);
  const templates = Object.fromEntries(TEMPLATE_KEYS.map((k) => [k, str(names[k]) ?? NOTIFY_TEMPLATES[k].name])) as Record<TemplateKey, string>;
  return { tenantId, phoneNumberId, language: str(v.language) ?? "en", templates, senderDisplay: str(v.senderDisplay) ?? str(v.phoneDisplay) };
}

type PhoneRow = { id: string; tenantId: string; wabaRefId: string; phoneNumberId: string; displayPhone: string; qualityRating: string | null; status: string };

async function notifierPhone(config: NotifierConfig, db: Db): Promise<PhoneRow | null> {
  return ((await db.phoneNumber.findFirst({
    where: { tenantId: config.tenantId, OR: [{ id: config.phoneNumberId }, { phoneNumberId: config.phoneNumberId }] },
    select: { id: true, tenantId: true, wabaRefId: true, phoneNumberId: true, displayPhone: true, qualityRating: true, status: true },
  })) ?? null) as PhoneRow | null;
}

/** Why the number cannot carry business-initiated messages now, or null: RED quality, a restriction, a disabled account. */
async function numberProblem(phone: PhoneRow, db: Db): Promise<string | null> {
  const rating = (phone.qualityRating ?? "").toUpperCase();
  if (rating === "RED" || rating === "LOW") return "number_red";
  if (["RESTRICTED", "FLAGGED", "BANNED", "DISCONNECTED", "DELETED"].includes((phone.status ?? "").toUpperCase())) return "number_restricted";
  const open = ((await db.spendBreaker.findMany({ where: { tenantId: phone.tenantId, state: "tripped", kind: { in: BLOCKING_BREAKERS } }, select: { kind: true, scopeType: true, scopeId: true } })) ?? []) as {
    kind: string;
    scopeType: string;
    scopeId: string;
  }[];
  const hit = open.find((b) => (b.scopeType === "phone" && b.scopeId === phone.id) || (b.scopeType === "waba" && b.scopeId === phone.wabaRefId));
  if (!hit) return null;
  return hit.kind === "wa_quality_red" ? "number_red" : "number_restricted";
}

type TenantRow = { id: string; status: string; deletedAt: Date | null; billingExempt: boolean; name?: string };

/** The workspace may be the notifier: billingExempt (admin comp) and active (7.4 critic). Throws the 409 to show otherwise. */
export async function assertNotifierWorkspace(tenantId: string, db?: Db): Promise<void> {
  const t = (await dbOf(db).tenant.findUnique({ where: { id: tenantId }, select: { id: true, status: true, deletedAt: true, billingExempt: true } })) as TenantRow | null;
  if (!t) throw new HttpError(404, "That workspace was not found.");
  if (t.deletedAt || t.status !== "active") throw new HttpError(409, "The notifier workspace must be active.");
  if (!t.billingExempt) throw new HttpError(409, "The notifier workspace must be exempt from billing (comp), so an unpaid plan can never hold owners' alerts.");
}

export type Readiness =
  | { ok: true; config: NotifierConfig; phone: PhoneRow; templateName: string; language: string }
  | { ok: false; reason: string };

const readyCache = new Map<string, { at: number; value: Readiness }>();

/** Test hook: forgets cached readiness and the once-per-process startup check. */
export function resetNotifierState(): void {
  readyCache.clear();
  startupChecked = false;
}

/**
 * Whether a template can go out now (7.4 fallback rule 1): the sender is configured, its workspace is exempt and active, the
 * number is not RED or restricted, and the template is approved and active under the number's own WABA. Cached a minute.
 */
export async function senderReadiness(key: TemplateKey, opts: { db?: Db; now?: number; fresh?: boolean } = {}): Promise<Readiness> {
  const now = opts.now ?? Date.now();
  const hit = readyCache.get(key);
  if (!opts.fresh && hit && now - hit.at < READY_CACHE_MS) return hit.value;
  const value = await computeReadiness(key, dbOf(opts.db)).catch((error): Readiness => {
    console.error(`[spend] notifier readiness not checked: ${describeError(error)}`);
    return { ok: false, reason: "check_failed" };
  });
  readyCache.set(key, { at: now, value });
  return value;
}

async function computeReadiness(key: TemplateKey, db: Db): Promise<Readiness> {
  const config = await readNotifierConfig(db);
  if (!config) return { ok: false, reason: "not_set_up" };
  try {
    await assertNotifierWorkspace(config.tenantId, db);
  } catch {
    return { ok: false, reason: "notifier_not_exempt" };
  }
  const phone = await notifierPhone(config, db);
  if (!phone) return { ok: false, reason: "no_number" };
  const problem = await numberProblem(phone, db);
  if (problem) return { ok: false, reason: problem };
  const name = config.templates[key];
  const template = (await db.template.findFirst({ where: { tenantId: config.tenantId, wabaRefId: phone.wabaRefId, name, language: config.language }, select: { status: true } })) as { status?: string } | null;
  if (!template) return { ok: false, reason: "template_missing" };
  if (template.status !== "approved") return { ok: false, reason: `template_${template.status ?? "unknown"}` };
  return { ok: true, config, phone, templateName: name, language: config.language };
}

// =====================================================================================================================
// Health and the startup check (4.16, 7.4 critic)
// =====================================================================================================================

export type NotifierHealth = {
  configured: boolean;
  tenantId: string | null;
  senderDisplay: string | null;
  problems: string[];
  templates: { key: TemplateKey; name: string; status: string }[];
  ownersToday: number;
  limit: number;
  digestCutoff: number;
};

/**
 * Everything wrong with the notifier, in plain sentences (the admin alerts strip and the startup warning). Empty when it is
 * healthy. Never throws.
 */
export async function notifierHealth(opts: { db?: Db; now?: Date; env?: Record<string, string | undefined> } = {}): Promise<NotifierHealth> {
  const db = dbOf(opts.db);
  const now = opts.now ?? new Date();
  const env = opts.env ?? process.env;
  const out: NotifierHealth = { configured: false, tenantId: null, senderDisplay: null, problems: [], templates: [], ownersToday: 0, limit: TIER_LIMIT, digestCutoff: DIGEST_CUTOFF };
  try {
    const config = await readNotifierConfig(db);
    if (!config) {
      out.problems.push("WhatsApp alerts to owners are off: the notification sender is not set up.");
      return out;
    }
    out.configured = true;
    out.tenantId = config.tenantId;
    out.senderDisplay = config.senderDisplay;
    if (!env.SPEND_NOTIFY_SECRET) out.problems.push("SPEND_NOTIFY_SECRET is not set, so WhatsApp replies (Yes, Decline) cannot be checked.");
    const tenant = (await db.tenant.findUnique({ where: { id: config.tenantId }, select: { id: true, status: true, deletedAt: true, billingExempt: true } })) as TenantRow | null;
    if (!tenant) out.problems.push("The notifier workspace no longer exists.");
    else {
      if (tenant.deletedAt || tenant.status !== "active") out.problems.push("The notifier workspace is not active, so its messages are held.");
      if (!tenant.billingExempt) out.problems.push("The notifier workspace is not exempt from billing: an unpaid plan would hold every owner's alerts.");
    }
    const [agents, bots, rules] = await Promise.all([
      db.aiAgent.count({ where: { tenantId: config.tenantId, enabled: true } }),
      db.chatbot.count({ where: { tenantId: config.tenantId, status: "published" } }),
      db.automationRule.count({ where: { tenantId: config.tenantId, enabled: true } }),
    ]);
    if (agents > 0) out.problems.push("The notifier workspace has an AI agent turned on. Turn it off: owners' replies must never get automatic answers.");
    if (bots > 0) out.problems.push("The notifier workspace has a chatbot published. Unpublish it.");
    if (rules > 0) out.problems.push("The notifier workspace has automations turned on. Turn them off.");
    // Loaded here only: the admin guard pulls in the request auth graph, which the notifier's callers must not load.
    const { isPlatformAdminEmail } = await import("@/lib/admin/auth");
    const members = ((await db.membership.findMany({ where: { tenantId: config.tenantId }, select: { userId: true, user: { select: { email: true } } } })) ?? []) as { userId: string; user?: { email?: string | null } | null }[];
    const outsiders = members.filter((m) => !isPlatformAdminEmail(m.user?.email ?? null, env.PLATFORM_ADMIN_EMAILS));
    if (outsiders.length) out.problems.push(`The notifier workspace has ${outsiders.length === 1 ? "1 member who is" : `${outsiders.length} members who are`} not a platform admin. Its inbox holds every owner's number; remove them.`);
    const phone = await notifierPhone(config, db);
    if (!phone) out.problems.push("The notifier phone number is not in the notifier workspace.");
    else {
      const problem = await numberProblem(phone, db);
      if (problem === "number_red") out.problems.push("The notifier number's quality is low (RED), so alerts stay in the app.");
      if (problem === "number_restricted") out.problems.push("Meta restricted the notifier number, so alerts stay in the app.");
      for (const key of TEMPLATE_KEYS) {
        const name = config.templates[key];
        const t = (await db.template.findFirst({ where: { tenantId: config.tenantId, wabaRefId: phone.wabaRefId, name, language: config.language }, select: { status: true } })) as { status?: string } | null;
        const status = t?.status ?? "missing";
        out.templates.push({ key, name, status });
        if (status !== "approved") out.problems.push(`Template ${name} is ${status === "missing" ? "not in the notifier's template list" : status}, so ${key === "digest" ? "daily summaries" : key === "optin" ? "new sign-ups" : `${key}s`} stay in the app.`);
      }
      out.ownersToday = (await ownersNotifiedSince(config.tenantId, config.templates.optin, new Date(now.getTime() - DAY_MS), db)).all.size;
      if (out.ownersToday > DIGEST_CUTOFF) out.problems.push(`${out.ownersToday} owners got WhatsApp alerts in the last 24 hours (limit ${TIER_LIMIT}). Daily summaries stay in the app until it drops.`);
    }
  } catch (error) {
    out.problems.push("The notification sender could not be checked.");
    console.error(`[spend] notifier health check failed: ${describeError(error)}`);
  }
  return out;
}

let startupChecked = false;

/** Logs the notifier's problems as warnings (the startup check of 7.4). Returns them. */
export async function logNotifierProblems(opts: { db?: Db; now?: Date; env?: Record<string, string | undefined>; log?: (line: string) => void } = {}): Promise<string[]> {
  const health = await notifierHealth(opts);
  const log = opts.log ?? ((line: string) => console.warn(line));
  if (health.configured) for (const p of health.problems) log(`[spend] notifier: ${p}`);
  return health.problems;
}

/** The startup check, once per process, on the first send. Never throws and never delays a send by more than its reads. */
async function ensureStartupCheck(db: Db): Promise<void> {
  if (startupChecked) return;
  startupChecked = true;
  await logNotifierProblems({ db }).catch(() => undefined);
}

// =====================================================================================================================
// Capacity (TIER_250)
// =====================================================================================================================

/**
 * The notifier conversations (one per owner phone) that got a message since `since`, and how many of them got nothing but a
 * confirmation (an unproved number).
 */
async function ownersNotifiedSince(notifierTenantId: string, optInTemplate: string, since: Date, db: Db): Promise<{ all: Set<string>; optInOnly: number }> {
  const rows = ((await db.message.findMany({
    where: { tenantId: notifierTenantId, direction: "outbound", origin: "system_notify", createdAt: { gte: since } },
    select: { conversationId: true, templateName: true, body: true },
    take: 5_000,
  })) ?? []) as { conversationId: string; templateName?: string | null; body?: string | null }[];
  const all = new Set<string>();
  const other = new Set<string>();
  for (const r of rows) {
    all.add(r.conversationId);
    const name = r.templateName ?? (typeof r.body === "string" && r.body.startsWith("[template] ") ? r.body.slice(11) : null);
    if (name !== optInTemplate) other.add(r.conversationId);
  }
  return { all, optInOnly: [...all].filter((id) => !other.has(id)).length };
}

/**
 * Whether one more message fits TIER_250 (7.4 item 6). An owner already messaged in 24 hours always fits. A confirmation to
 * a new number also needs room under OPTIN_TIER_CAP, so made-up numbers can never crowd out real approvals and alerts.
 */
export function tierAllows(purpose: NotifyPurpose, alreadyToday: boolean, ownersToday: number, optInsToday = 0): { ok: true } | { ok: false; reason: string } {
  if (alreadyToday || purpose === "reply") return { ok: true };
  if (ownersToday >= TIER_LIMIT) return { ok: false, reason: "tier_full" };
  if (purpose === "digest" && ownersToday >= DIGEST_CUTOFF) return { ok: false, reason: "tier_digest_cutoff" };
  if (purpose === "optin" && optInsToday >= OPTIN_TIER_CAP) return { ok: false, reason: "tier_optin_cap" };
  return { ok: true };
}

// =====================================================================================================================
// The owner as a notifier contact
// =====================================================================================================================

/** Whether the person at this phone replied STOP to the notifier number (and has not sent START since). */
export async function notifierPhoneOptedOut(config: NotifierConfig, phoneE164: string, db?: Db): Promise<boolean> {
  const contact = (await dbOf(db).contact.findFirst({ where: { tenantId: config.tenantId, phone: toE164(phoneE164) }, select: { optedOutAt: true } })) as { optedOutAt?: Date | null } | null;
  return !!contact?.optedOutAt;
}

/**
 * The owner's Contact in the notifier workspace, created when missing: opted in (their own consent on the Spending page),
 * tagged owner_spend_alerts. `freshConsent` records the page's consent on the contact, but NEVER clears a STOP: the consent
 * belongs to whoever typed the number, while STOP came from the phone itself. Only START from that phone lifts it.
 */
export async function ensureNotifierContact(config: NotifierConfig, phoneE164: string, opts: { db?: Db; now?: Date; freshConsent?: boolean } = {}): Promise<string> {
  const db = dbOf(opts.db);
  const now = opts.now ?? new Date();
  const phone = toE164(phoneE164);
  const find = async () => (await db.contact.findFirst({ where: { tenantId: config.tenantId, phone }, select: { id: true, tags: true, optedOutAt: true } })) as { id: string; tags?: string[] | null; optedOutAt?: Date | null } | null;
  let contact = await find();
  if (!contact) {
    try {
      const created = (await db.contact.create({
        data: { tenantId: config.tenantId, phone, waId: phoneDigits(phone), name: "Workspace owner", tags: [OWNER_CONTACT_TAG], optIn: true, optInSource: "spend_alerts", optInAt: now },
        select: { id: true },
      })) as { id: string };
      return String(created.id);
    } catch (error) {
      if ((error as { code?: unknown })?.code !== "P2002") throw error;
      contact = await find();
      if (!contact) throw error;
    }
  }
  const tags = contact.tags ?? [];
  const data: Record<string, unknown> = {};
  if (!tags.includes(OWNER_CONTACT_TAG)) data.tags = [...tags, OWNER_CONTACT_TAG];
  if (opts.freshConsent && !contact.optedOutAt) Object.assign(data, { optIn: true, optInSource: "spend_alerts", optInAt: now });
  if (Object.keys(data).length) await db.contact.updateMany({ where: { id: contact.id, tenantId: config.tenantId }, data });
  return contact.id;
}

/** Whether a message of this purpose to this phone fits TIER_250 now (the opt-in checks it before storing anything). */
export async function notifierRoomFor(config: NotifierConfig, phoneE164: string, purpose: NotifyPurpose, opts: { db?: Db; now?: Date } = {}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const db = dbOf(opts.db);
  const now = opts.now ?? new Date();
  const phone = await notifierPhone(config, db);
  if (!phone) return { ok: false, reason: "no_number" };
  const contact = (await db.contact.findFirst({ where: { tenantId: config.tenantId, phone: toE164(phoneE164) }, select: { id: true } })) as { id: string } | null;
  const conversation = contact ? ((await db.conversation.findFirst({ where: { tenantId: config.tenantId, phoneNumberId: phone.id, contactId: contact.id }, select: { id: true } })) as { id: string } | null) : null;
  const today = await ownersNotifiedSince(config.tenantId, config.templates.optin, new Date(now.getTime() - DAY_MS), db);
  return tierAllows(purpose, !!conversation && today.all.has(conversation.id), today.all.size, today.optInOnly);
}

/** The inbox send path, loaded on first use: it pulls in routing, chatbots and the automation graph. */
async function inbox() {
  return import("@/lib/inbox/service");
}

export type TemplateSend = {
  key: TemplateKey;
  purpose: NotifyPurpose;
  /** The workspace the message is about (written into the timeline for erasure). */
  subjectTenantId: string;
  phoneE164: string;
  values: TemplateValues;
  /** A fresh opt-in on the Spending page (records it on the notifier contact; a STOP from the phone still wins). */
  freshConsent?: boolean;
};

/**
 * Sends one template to one owner from the notifier number, after the readiness and capacity checks. Never throws: a
 * refusal or a failed queue comes back as { sent: false, reason }.
 */
export async function sendNotifierTemplate(input: TemplateSend, opts: { db?: Db; now?: Date } = {}): Promise<SendOutcome> {
  const db = dbOf(opts.db);
  const now = opts.now ?? new Date();
  try {
    await ensureStartupCheck(db);
    const ready = await senderReadiness(input.key, { db, now: now.getTime() });
    if (!ready.ok) return { sent: false, reason: ready.reason };
    const contactId = await ensureNotifierContact(ready.config, input.phoneE164, { db, now, freshConsent: input.freshConsent });
    const contact = (await db.contact.findFirst({ where: { id: contactId, tenantId: ready.config.tenantId }, select: { optedOutAt: true } })) as { optedOutAt?: Date | null } | null;
    if (contact?.optedOutAt) return { sent: false, reason: "opted_out" };
    const conversation = (await db.conversation.findFirst({ where: { tenantId: ready.config.tenantId, phoneNumberId: ready.phone.id, contactId }, select: { id: true } })) as { id: string } | null;
    const today = await ownersNotifiedSince(ready.config.tenantId, ready.config.templates.optin, new Date(now.getTime() - DAY_MS), db);
    const room = tierAllows(input.purpose, !!conversation && today.all.has(conversation.id), today.all.size, today.optInOnly);
    if (!room.ok) return { sent: false, reason: room.reason };
    const { sendTemplateMessage } = await inbox();
    const message = await sendTemplateMessage({
      tenantId: ready.config.tenantId,
      phoneNumberId: ready.phone.id,
      contactId,
      ...(conversation ? { conversationId: conversation.id } : {}),
      templateName: ready.templateName,
      language: ready.language,
      components: templateComponents(input.key, input.values),
      source: `${NOTIFY_SOURCE_PREFIX}${input.subjectTenantId}`,
      origin: "system_notify",
    });
    return { sent: true, messageId: String((message as { id?: unknown }).id ?? ""), contactId };
  } catch (error) {
    console.error(`[spend] notifier ${input.key} not sent: ${describeError(error)}`);
    return { sent: false, reason: error instanceof HttpError ? `refused_${error.status}` : "send_failed" };
  }
}

/**
 * A free-text reply inside the 24-hour window the owner's own tap just opened ("Declined. Nothing was changed."). Never
 * throws.
 */
export async function sendNotifierReply(waId: string, body: string, subjectTenantId: string | null, opts: { db?: Db; config?: NotifierConfig | null } = {}): Promise<SendOutcome> {
  const db = dbOf(opts.db);
  try {
    const config = opts.config ?? (await readNotifierConfig(db));
    if (!config) return { sent: false, reason: "not_set_up" };
    const phone = await notifierPhone(config, db);
    if (!phone) return { sent: false, reason: "no_number" };
    const contact = (await db.contact.findFirst({ where: { tenantId: config.tenantId, phone: toE164(waId) }, select: { id: true } })) as { id: string } | null;
    if (!contact) return { sent: false, reason: "no_contact" };
    const conversation = (await db.conversation.findFirst({ where: { tenantId: config.tenantId, phoneNumberId: phone.id, contactId: contact.id }, select: { id: true } })) as { id: string } | null;
    if (!conversation) return { sent: false, reason: "no_chat" };
    const { sendText } = await inbox();
    const message = await sendText({ tenantId: config.tenantId, conversationId: conversation.id, body, ...(subjectTenantId ? { source: `${NOTIFY_SOURCE_PREFIX}${subjectTenantId}` } : {}), origin: "system_notify" });
    return { sent: true, messageId: String((message as { id?: unknown }).id ?? ""), contactId: contact.id };
  } catch (error) {
    console.error(`[spend] notifier reply not sent: ${describeError(error)}`);
    return { sent: false, reason: "send_failed" };
  }
}

// =====================================================================================================================
// Erasure (3.5 critic)
// =====================================================================================================================

/** The workspace a notifier message is about, from its first timeline entry; null for any other message. Pure. */
export function notifierSubjectOf(statusTimeline: unknown): string | null {
  const first = Array.isArray(statusTimeline) ? rec(statusTimeline[0]) : {};
  const source = typeof first.source === "string" ? first.source : "";
  return source.startsWith(NOTIFY_SOURCE_PREFIX) ? source.slice(NOTIFY_SOURCE_PREFIX.length) || null : null;
}

/**
 * Removes what the notifier workspace holds about one owner phone for one workspace. When the phone has no channel left in
 * any other workspace, the whole Contact goes with its conversations and messages; otherwise only the messages about this
 * workspace go. Returns how many messages were deleted.
 */
export async function forgetNotifierPhone(phoneE164: string, subjectTenantId: string, opts: { db?: Db; config?: NotifierConfig | null; keepContact?: boolean } = {}): Promise<number> {
  const db = dbOf(opts.db);
  const config = opts.config === undefined ? await readNotifierConfig(db) : opts.config;
  if (!config || config.tenantId === subjectTenantId) return 0;
  const phone = toE164(phoneE164);
  const contact = (await db.contact.findFirst({ where: { tenantId: config.tenantId, phone }, select: { id: true } })) as { id: string } | null;
  if (!contact) return 0;
  const conversations = ((await db.conversation.findMany({ where: { tenantId: config.tenantId, contactId: contact.id }, select: { id: true } })) ?? []) as { id: string }[];
  const conversationIds = conversations.map((c) => c.id);
  if (!opts.keepContact) {
    const { count } = conversationIds.length ? await db.message.deleteMany({ where: { tenantId: config.tenantId, conversationId: { in: conversationIds } } }) : { count: 0 };
    if (conversationIds.length) await db.conversation.deleteMany({ where: { tenantId: config.tenantId, id: { in: conversationIds } } });
    await db.contact.deleteMany({ where: { tenantId: config.tenantId, id: contact.id } });
    return count;
  }
  if (!conversationIds.length) return 0;
  const messages = ((await db.message.findMany({ where: { tenantId: config.tenantId, conversationId: { in: conversationIds } }, select: { id: true, statusTimeline: true }, take: 50_000 })) ?? []) as {
    id: string;
    statusTimeline: unknown;
  }[];
  const ids = messages.filter((m) => notifierSubjectOf(m.statusTimeline) === subjectTenantId).map((m) => m.id);
  if (!ids.length) return 0;
  const { count } = await db.message.deleteMany({ where: { tenantId: config.tenantId, id: { in: ids } } });
  return count;
}
