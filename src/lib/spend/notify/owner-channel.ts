/**
 * Owner and approver WhatsApp channels for spending notices (docs/SPEND-CONTROLS-SPEC.md 7.4 items 3 and 5, 3.5).
 *
 * - Opt-in: the owner, or an admin the owner named as an approver, enters a number on Settings > Spending limits and agrees to
 *   the 7.4 consent text. That writes an append-only SpendConsent row (`owner_whatsapp`, the text version and its SHA-256),
 *   a pending OwnerNotifyChannel, a `consent.owner_whatsapp` ledger row (no phone), and sends `spend_optin_v1`.
 * - Verification: the "Yes" quick reply carries `spopt:<channelId>:<hmac16>`. A valid HMAC from that very number sets
 *   verifiedAt: it proves the number and opens a 24-hour window.
 * - STOP opts out every channel with that phone (Meta's opt-out is per person, not per workspace). START, or a fresh opt-in on
 *   the Spending page, re-enables only the channel it came from.
 * - A channel goes when its person is no longer a member of the workspace (pruneChannels), with what the notifier holds.
 * The HMAC key is SPEND_NOTIFY_SECRET. Without it nothing can be verified, so no channel is offered for WhatsApp.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/db";
import { createLimiter } from "@/lib/ratelimit";
import { describeError } from "@/lib/safe-error";
import { HttpError, type Actor } from "@/lib/tenancy";
import { getControl, type SpendDb } from "../control";
import { appendStandalone, type LedgerDb } from "../ledger";
import type { NotifyChannelDTO, NotifySettingsDTO, SpendNoticeAudience } from "../types";
import { NOTIFY_SOURCE_PREFIX, forgetNotifierPhone, notifierPhoneOptedOut, notifierRoomFor, phoneDigits, readNotifierConfig, sendNotifierTemplate, senderReadiness, toE164, type NotifierConfig } from "./platform-sender";
import { OWNER_WHATSAPP_CONSENT_TEXT, OWNER_WHATSAPP_CONSENT_VERSION } from "./templates";

type Db = SpendDb;
type Env = Record<string, string | undefined>;
const dbOf = (db?: Db): Db => db ?? (prisma as unknown as Db);

export const DEFAULT_SENDER_DISPLAY = "+1 711-268-5789";
/** 12.1a decision 2: no SMTP, so the page says alerts come in the app and on WhatsApp. */
export const EMAIL_OFF_TEXT = "Email alerts are off for now, so alerts come here in the app and on WhatsApp.";
export const ONLY_OWNER_OR_APPROVER = "Only the owner and the admins they name as approvers can get spending alerts on WhatsApp.";
export const PHONE_PROBLEM = "Enter a number with country code, like +91 98765 43210.";
export const CONSENT_NEEDED = "Tick the box to agree first.";
export const CONSENT_CHANGED = "The consent text has changed. Reload the page and agree again.";
export const SENDER_UNAVAILABLE = "WhatsApp alerts can't be set up right now. Alerts still come here in the app; try again later.";
export const SEND_FAILED = "We couldn't send the confirmation. Try again in a minute.";
export const TOO_MANY = "Too many confirmations were sent. Try again in an hour.";
export const STOPPED_TEXT = "WhatsApp alerts are off for this number. Send a new confirmation to turn them back on.";
/** The number replied STOP to the notifier: only the phone itself can lift that. */
export const phoneStoppedText = (sender: string): string =>
  `This number replied STOP to Edwyz alerts, so we can't message it. To get alerts again, send START to ${sender} on WhatsApp from that phone, then try again here.`;
/** {{1}} of spend_optin_v1. Never the workspace's own name: whoever types a number chooses that name, and the person at the number did not ask for it. */
export const OPTIN_SUBJECT = "your Edwyz workspace";

const E164 = /^\+[1-9]\d{7,14}$/;
/**
 * Per person 3 and per workspace 10 confirmations an hour, and 3 a day to any one number from all workspaces together: the
 * opt-in sends a message to whatever number is typed.
 */
const perUser = createLimiter(3, 3_600_000, "spend-optin-user");
const perTenant = createLimiter(10, 3_600_000, "spend-optin-tenant");
const perPhone = createLimiter(3, 24 * 3_600_000, "spend-optin-phone");

/** Test hook: forgets the confirmation limits. */
export async function resetOptInLimits(): Promise<void> {
  await Promise.all([perUser.clear(), perTenant.clear(), perPhone.clear()]);
}

// =====================================================================================================================
// Quick-reply payloads: spopt:<channelId>:<hmac16> and spdec:<approvalId>:<hmac16>
// =====================================================================================================================

export type ReplyKind = "spopt" | "spno" | "spdec";

/** SPEND_NOTIFY_SECRET when it is usable (32 bytes or more), else null. */
export function notifySecret(env: Env = process.env): string | null {
  const s = env.SPEND_NOTIFY_SECRET ?? "";
  return Buffer.byteLength(s, "utf8") >= 32 ? s : null;
}

/** 16 hex characters of HMAC-SHA256 over the kind, the id and the recipient's wa_id, so a payload works only from that phone. */
export function replyHmac(kind: ReplyKind, id: string, waId: string, secret: string): string {
  return createHmac("sha256", secret).update(`${kind}|${id}|${phoneDigits(waId)}`).digest("hex").slice(0, 16);
}

/** The quick-reply payload for one recipient. Null without a usable secret. */
export function replyPayload(kind: ReplyKind, id: string, waId: string, env: Env = process.env): string | null {
  const secret = notifySecret(env);
  if (!secret) return null;
  const mac = replyHmac(kind, id, waId, secret);
  return kind === "spno" ? `spopt:${id}:${mac}:no` : `${kind}:${id}:${mac}`;
}

export type ParsedReply = { kind: ReplyKind; id: string };

const PAYLOAD = /^(spopt|spdec):([A-Za-z0-9_-]{1,64}):([0-9a-f]{16})(:no)?$/;

/** The payload's kind and id when its HMAC matches this sender's wa_id; null for anything else (ignored). */
export function verifyReplyPayload(payload: string, waId: string, env: Env = process.env): ParsedReply | null {
  const secret = notifySecret(env);
  const m = PAYLOAD.exec(String(payload ?? ""));
  if (!secret || !m || !phoneDigits(waId)) return null;
  if (m[1] === "spdec" && m[4]) return null;
  const kind: ReplyKind = m[1] === "spdec" ? "spdec" : m[4] ? "spno" : "spopt";
  const expected = Buffer.from(replyHmac(kind, m[2], waId, secret), "utf8");
  const got = Buffer.from(m[3], "utf8");
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;
  return { kind, id: m[2] };
}

// =====================================================================================================================
// Who may have a channel, and who gets WhatsApp
// =====================================================================================================================

type Role = "owner" | "admin" | "agent";

/** Still a member; and the owner, or an admin listed in approverUserIds. */
export async function ownerOrApprover(tenantId: string, userId: string, db?: Db): Promise<{ member: boolean; role: Role | null; allowed: boolean }> {
  const d = dbOf(db);
  const m = (await d.membership.findFirst({ where: { tenantId, userId }, select: { role: true } })) as { role?: string } | null;
  const role = m?.role === "owner" || m?.role === "admin" || m?.role === "agent" ? (m.role as Role) : null;
  if (!role) return { member: false, role: null, allowed: false };
  if (role === "owner") return { member: true, role, allowed: true };
  if (role === "agent") return { member: true, role, allowed: false };
  const control = await getControl(tenantId, { db: d, prune: false });
  return { member: true, role, allowed: control.approverUserIds.includes(userId) };
}

type ChannelRow = {
  id: string;
  tenantId: string;
  userId: string;
  phoneE164: string;
  optInAt: Date | null;
  optInTextVersion: string | null;
  verifiedAt: Date | null;
  optOutAt: Date | null;
  notifierContactId: string | null;
  lastSentAt: Date | null;
};

export type Recipient = { channelId: string; userId: string; phoneE164: string; waId: string; role: Role };

/**
 * The verified, opted-in channels for a notice's audience (7.4): the owner for owner notices; the owner and the approvers for
 * every other workspace notice. Members who left, or admins who are no longer approvers, are skipped.
 */
export async function recipientsFor(tenantId: string, audience: SpendNoticeAudience, db?: Db): Promise<Recipient[]> {
  if (audience === "platform_admins") return [];
  const d = dbOf(db);
  const channels = ((await d.ownerNotifyChannel.findMany({ where: { tenantId, optOutAt: null, verifiedAt: { not: null } } })) ?? []) as ChannelRow[];
  if (!channels.length) return [];
  const members = ((await d.membership.findMany({ where: { tenantId, userId: { in: channels.map((c) => c.userId) } }, select: { userId: true, role: true } })) ?? []) as { userId: string; role: string }[];
  const roleOf = new Map(members.map((m) => [m.userId, m.role as Role]));
  const approvers = new Set((await getControl(tenantId, { db: d, prune: false })).approverUserIds);
  const out: Recipient[] = [];
  for (const c of channels) {
    const role = roleOf.get(c.userId);
    if (!role || !c.verifiedAt || c.optOutAt) continue;
    const allowed = role === "owner" || (role === "admin" && approvers.has(c.userId));
    if (!allowed) continue;
    if (audience === "owner" && role !== "owner") continue;
    out.push({ channelId: c.id, userId: c.userId, phoneE164: c.phoneE164, waId: phoneDigits(c.phoneE164), role });
  }
  return out;
}

// =====================================================================================================================
// DTOs
// =====================================================================================================================

/** "+91 •••••• 3210": the country code and the last 4 digits. */
export function maskPhone(phoneE164: string): string {
  const d = phoneDigits(phoneE164);
  if (d.length < 6) return "••••";
  const cc = d.length > 10 ? d.slice(0, d.length - 10) : d.slice(0, 2);
  return `+${cc} ${"•".repeat(Math.max(2, d.length - cc.length - 4))} ${d.slice(-4)}`;
}

const iso = (d: Date | null | undefined): string | null => (d instanceof Date ? d.toISOString() : null);

export function channelStatus(row: Pick<ChannelRow, "verifiedAt" | "optOutAt">): NotifyChannelDTO["status"] {
  return row.optOutAt ? "opted_out" : row.verifiedAt ? "verified" : "pending";
}

/** The channel as the Spending page shows it: the full number only to its own person. */
export function toChannelDTO(row: ChannelRow, viewerUserId: string, senderDisplay: string): NotifyChannelDTO {
  return {
    id: row.id,
    userId: row.userId,
    phone: row.userId === viewerUserId ? row.phoneE164 : maskPhone(row.phoneE164),
    status: channelStatus(row),
    optInAt: iso(row.optInAt),
    verifiedAt: iso(row.verifiedAt),
    optOutAt: iso(row.optOutAt),
    lastSentAt: iso(row.lastSentAt),
    senderDisplay,
  };
}

async function senderDisplayOf(config: NotifierConfig | null, db: Db): Promise<string> {
  if (config?.senderDisplay) return config.senderDisplay;
  if (!config) return DEFAULT_SENDER_DISPLAY;
  const phone = (await db.phoneNumber.findFirst({ where: { tenantId: config.tenantId, OR: [{ id: config.phoneNumberId }, { phoneNumberId: config.phoneNumberId }] }, select: { displayPhone: true } })) as { displayPhone?: string } | null;
  return phone?.displayPhone || DEFAULT_SENDER_DISPLAY;
}

/** The caller's own notification settings (GET /api/spend/notify). */
export async function notifySettingsFor(actor: Actor, opts: { db?: Db } = {}): Promise<NotifySettingsDTO & { canSetNumber: boolean; consentText: string; consentVersion: string }> {
  const db = dbOf(opts.db);
  const [row, control, who, config] = await Promise.all([
    db.ownerNotifyChannel.findFirst({ where: { tenantId: actor.tenantId, userId: actor.userId } }) as Promise<ChannelRow | null>,
    getControl(actor.tenantId, { db, prune: false }),
    ownerOrApprover(actor.tenantId, actor.userId, db),
    readNotifierConfig(db),
  ]);
  const sender = await senderDisplayOf(config, db);
  return {
    own: row ? toChannelDTO(row, actor.userId, sender) : null,
    emailFallback: "off",
    emailFallbackText: EMAIL_OFF_TEXT,
    digestEnabled: control.digestEnabled,
    canSetNumber: who.allowed,
    consentText: OWNER_WHATSAPP_CONSENT_TEXT,
    consentVersion: OWNER_WHATSAPP_CONSENT_VERSION,
  };
}

// =====================================================================================================================
// Opt-in, verification, STOP and START
// =====================================================================================================================

export const consentSha256 = (text: string = OWNER_WHATSAPP_CONSENT_TEXT): string => createHash("sha256").update(text, "utf8").digest("hex");

export type OptInInput = { phone: unknown; consent: unknown; textVersion: unknown };
export type OptInOptions = { db?: Db; now?: Date; env?: Env };

/** Checks the request in order and gives the sentence to show; throws HttpError. Pure apart from nothing. */
export function validateOptIn(input: OptInInput): string {
  const phone = typeof input.phone === "string" ? input.phone.replace(/[\s()-]/g, "") : "";
  if (!E164.test(phone)) throw new HttpError(400, PHONE_PROBLEM);
  if (input.consent !== true) throw new HttpError(400, CONSENT_NEEDED);
  if (input.textVersion !== OWNER_WHATSAPP_CONSENT_VERSION) throw new HttpError(409, CONSENT_CHANGED);
  return phone;
}

/**
 * The 7.4 opt-in. Refuses before writing anything when the sender cannot send now, so no consent row is stored for a
 * confirmation that never goes out. A changed number leaves the old one's notifier data behind only if another workspace
 * still uses it.
 */
export async function optIn(actor: Actor, input: OptInInput, opts: OptInOptions = {}): Promise<NotifyChannelDTO> {
  const db = dbOf(opts.db);
  const now = opts.now ?? new Date();
  const env = opts.env ?? process.env;
  const who = await ownerOrApprover(actor.tenantId, actor.userId, db);
  if (!who.allowed) throw new HttpError(403, ONLY_OWNER_OR_APPROVER);
  const phone = validateOptIn(input);
  const config = await readNotifierConfig(db);
  if (!config || !notifySecret(env) || !(await senderReadiness("optin", { db, now: now.getTime() })).ok) throw new HttpError(409, SENDER_UNAVAILABLE);
  if (!perUser.consume(`${actor.tenantId}:${actor.userId}`, now.getTime()) || !perTenant.consume(actor.tenantId, now.getTime()) || !perPhone.consume(phoneDigits(phone), now.getTime())) {
    throw new HttpError(429, TOO_MANY);
  }
  // A STOP from that phone wins over a consent typed on this page: refuse before anything is stored.
  if (await notifierPhoneOptedOut(config, phone, db)) throw new HttpError(409, phoneStoppedText(await senderDisplayOf(config, db)));
  if (!(await notifierRoomFor(config, phone, "optin", { db, now })).ok) throw new HttpError(409, SENDER_UNAVAILABLE);

  const before = (await db.ownerNotifyChannel.findFirst({ where: { tenantId: actor.tenantId, userId: actor.userId } })) as ChannelRow | null;
  const channel = (await db.ownerNotifyChannel.upsert({
    where: { tenantId_userId: { tenantId: actor.tenantId, userId: actor.userId } },
    create: { tenantId: actor.tenantId, userId: actor.userId, phoneE164: phone, optInAt: now, optInTextVersion: OWNER_WHATSAPP_CONSENT_VERSION, verifiedAt: null, optOutAt: null },
    update: { phoneE164: phone, optInAt: now, optInTextVersion: OWNER_WHATSAPP_CONSENT_VERSION, verifiedAt: null, optOutAt: null },
  })) as ChannelRow;
  await db.spendConsent.create({
    data: { tenantId: actor.tenantId, userId: actor.userId, kind: "owner_whatsapp", subjectId: channel.id, granted: true, textVersion: OWNER_WHATSAPP_CONSENT_VERSION, textSha256: consentSha256() },
  });
  await appendStandalone(
    {
      tenantId: actor.tenantId,
      pot: "none",
      action: "consent.owner_whatsapp",
      phase: "info",
      actor: { type: "user", userId: actor.userId, role: actor.role },
      reason: "Agreed to get spending approvals, alerts and a daily summary on WhatsApp.",
      reasonCodes: ["opt_in"],
      targetType: "notify_channel",
      targetId: channel.id,
    },
    { db: db as unknown as LedgerDb },
  );
  if (before && phoneDigits(before.phoneE164) !== phoneDigits(phone)) await releasePhone(before.phoneE164, actor.tenantId, db, config).catch((error) => console.error(`[spend] old notifier number not released: ${describeError(error)}`));

  const waId = phoneDigits(phone);
  const sent = await sendNotifierTemplate(
    {
      key: "optin",
      purpose: "optin",
      subjectTenantId: actor.tenantId,
      phoneE164: phone,
      freshConsent: true,
      values: {
        params: [OPTIN_SUBJECT],
        payloads: { "Yes, send me alerts": replyPayload("spopt", channel.id, waId, env)!, No: replyPayload("spno", channel.id, waId, env)! },
      },
    },
    { db, now },
  );
  if (!sent.sent) {
    if (sent.reason === "opted_out") throw new HttpError(409, phoneStoppedText(await senderDisplayOf(config, db)));
    const unavailable = sent.reason !== "send_failed" && !sent.reason.startsWith("refused_");
    throw new HttpError(unavailable ? 409 : 502, unavailable ? SENDER_UNAVAILABLE : SEND_FAILED);
  }
  await db.ownerNotifyChannel.updateMany({ where: { id: channel.id }, data: { notifierContactId: sent.contactId, lastSentAt: now } });
  const fresh = ((await db.ownerNotifyChannel.findFirst({ where: { id: channel.id } })) ?? channel) as ChannelRow;
  return toChannelDTO(fresh, actor.userId, await senderDisplayOf(config, db));
}

/** Turns off the caller's own WhatsApp alerts (a lowering: works in every workspace state). */
export async function optOutOwn(actor: Actor, opts: { db?: Db; now?: Date } = {}): Promise<NotifyChannelDTO | null> {
  const db = dbOf(opts.db);
  const now = opts.now ?? new Date();
  await db.ownerNotifyChannel.updateMany({ where: { tenantId: actor.tenantId, userId: actor.userId, optOutAt: null }, data: { optOutAt: now } });
  const row = (await db.ownerNotifyChannel.findFirst({ where: { tenantId: actor.tenantId, userId: actor.userId } })) as ChannelRow | null;
  return row ? toChannelDTO(row, actor.userId, await senderDisplayOf(await readNotifierConfig(db), db)) : null;
}

/** "Yes": the number proved itself. Only when the tapping phone is the channel's own number. */
export async function verifyChannel(channelId: string, waId: string, opts: { db?: Db; now?: Date } = {}): Promise<ChannelRow | null> {
  const db = dbOf(opts.db);
  const row = (await db.ownerNotifyChannel.findFirst({ where: { id: channelId } })) as ChannelRow | null;
  if (!row || phoneDigits(row.phoneE164) !== phoneDigits(waId)) return null;
  if (row.optOutAt && row.optInAt && row.optOutAt.getTime() > row.optInAt.getTime()) return null;
  const now = opts.now ?? new Date();
  await db.ownerNotifyChannel.updateMany({ where: { id: row.id }, data: { verifiedAt: now, optOutAt: null } });
  return { ...row, verifiedAt: now, optOutAt: null };
}

/** "No" on the confirmation: that one channel is off, nothing else changes. */
export async function declineChannel(channelId: string, waId: string, opts: { db?: Db; now?: Date } = {}): Promise<ChannelRow | null> {
  const db = dbOf(opts.db);
  const row = (await db.ownerNotifyChannel.findFirst({ where: { id: channelId } })) as ChannelRow | null;
  if (!row || phoneDigits(row.phoneE164) !== phoneDigits(waId)) return null;
  await db.ownerNotifyChannel.updateMany({ where: { id: row.id }, data: { optOutAt: opts.now ?? new Date() } });
  return row;
}

/** STOP from a phone: every channel with that number, in every workspace, stops (Meta's opt-out is per person). */
export async function optOutPhone(waId: string, opts: { db?: Db; now?: Date } = {}): Promise<number> {
  const db = dbOf(opts.db);
  const { count } = await db.ownerNotifyChannel.updateMany({ where: { phoneE164: toE164(waId), optOutAt: null }, data: { optOutAt: opts.now ?? new Date() } });
  return count;
}

/**
 * START from a phone re-enables only the channel it came from: the workspace the latest notifier message to this person
 * was about, or else the channel that stopped last. Other workspaces stay off until their own opt-in.
 */
export async function startFromPhone(notifierTenantId: string, waId: string, opts: { db?: Db; now?: Date } = {}): Promise<ChannelRow | null> {
  const db = dbOf(opts.db);
  const phone = toE164(waId);
  const channels = ((await db.ownerNotifyChannel.findMany({ where: { phoneE164: phone, optOutAt: { not: null } } })) ?? []) as ChannelRow[];
  if (!channels.length) return null;
  let subject: string | null = null;
  const contact = (await db.contact.findFirst({ where: { tenantId: notifierTenantId, phone }, select: { id: true } })) as { id: string } | null;
  if (contact) {
    const convs = ((await db.conversation.findMany({ where: { tenantId: notifierTenantId, contactId: contact.id }, select: { id: true } })) ?? []) as { id: string }[];
    if (convs.length) {
      const last = ((await db.message.findMany({ where: { tenantId: notifierTenantId, conversationId: { in: convs.map((c) => c.id) }, direction: "outbound" }, orderBy: { createdAt: "desc" }, take: 20, select: { statusTimeline: true, createdAt: true } })) ?? []) as { statusTimeline: unknown; createdAt?: Date }[];
      last.sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
      for (const m of last) {
        const first = Array.isArray(m.statusTimeline) ? (m.statusTimeline[0] as { source?: unknown } | undefined) : undefined;
        const source = typeof first?.source === "string" ? first.source : "";
        if (source.startsWith(NOTIFY_SOURCE_PREFIX)) {
          subject = source.slice(NOTIFY_SOURCE_PREFIX.length);
          break;
        }
      }
    }
  }
  const chosen = channels.find((c) => c.tenantId === subject) ?? [...channels].sort((a, b) => (b.optOutAt?.getTime() ?? 0) - (a.optOutAt?.getTime() ?? 0))[0];
  await db.ownerNotifyChannel.updateMany({ where: { id: chosen.id }, data: { optOutAt: null } });
  return { ...chosen, optOutAt: null };
}

/** Marks a channel as having just got a message. Never throws. */
export async function noteSent(channelIds: readonly string[], now: Date, db?: Db): Promise<void> {
  if (!channelIds.length) return;
  try {
    await dbOf(db).ownerNotifyChannel.updateMany({ where: { id: { in: [...channelIds] } }, data: { lastSentAt: now } });
  } catch (error) {
    console.error(`[spend] notify channel not updated: ${describeError(error)}`);
  }
}

// =====================================================================================================================
// Pruning and erasure (3.5)
// =====================================================================================================================

/**
 * What the notifier holds for a number one channel of this workspace stopped using (its row already changed or deleted):
 * nothing while another channel of this workspace still uses it; this workspace's messages while another workspace does;
 * otherwise the whole notifier Contact.
 */
async function releasePhone(phoneE164: string, tenantId: string, db: Db, config: NotifierConfig | null): Promise<number> {
  const phone = toE164(phoneE164);
  const sameWorkspace = await db.ownerNotifyChannel.count({ where: { phoneE164: phone, tenantId } });
  if (sameWorkspace > 0) return 0;
  const others = await db.ownerNotifyChannel.count({ where: { phoneE164: phone } });
  return forgetNotifierPhone(phone, tenantId, { db, config, keepContact: others > 0 });
}

/**
 * Deletes channels whose person is no longer a member of the workspace (7.4, 3.5: "removed with the membership"), and what
 * the notifier holds about them for that workspace. Returns how many channels went. Never throws.
 */
export async function pruneChannels(opts: { db?: Db; tenantId?: string; limit?: number } = {}): Promise<number> {
  const db = dbOf(opts.db);
  try {
    const channels = ((await db.ownerNotifyChannel.findMany({ where: opts.tenantId ? { tenantId: opts.tenantId } : {}, take: opts.limit ?? 2_000 })) ?? []) as ChannelRow[];
    if (!channels.length) return 0;
    const config = await readNotifierConfig(db);
    let removed = 0;
    for (const c of channels) {
      const member = await db.membership.findFirst({ where: { tenantId: c.tenantId, userId: c.userId }, select: { userId: true } });
      if (member) continue;
      await db.ownerNotifyChannel.deleteMany({ where: { id: c.id } });
      await releasePhone(c.phoneE164, c.tenantId, db, config).catch((error) => console.error(`[spend] notifier data not released: ${describeError(error)}`));
      removed++;
    }
    return removed;
  } catch (error) {
    console.error(`[spend] notify channels not pruned: ${describeError(error)}`);
    return 0;
  }
}

/**
 * Workspace erasure (3.5 critic): every owner phone of this workspace loses its notifier Contact, Conversation and Messages,
 * or, when another workspace still uses the phone, only the messages about this workspace. The channel rows themselves go
 * with the workspace's tables. Returns how many notifier messages were deleted.
 */
export async function eraseOwnerChannels(tenantId: string, opts: { db?: Db } = {}): Promise<number> {
  const db = dbOf(opts.db);
  const channels = ((await db.ownerNotifyChannel.findMany({ where: { tenantId } })) ?? []) as ChannelRow[];
  if (!channels.length) return 0;
  const config = await readNotifierConfig(db);
  if (!config || config.tenantId === tenantId) return 0;
  let deleted = 0;
  const seen = new Set<string>();
  for (const c of channels) {
    const phone = toE164(c.phoneE164);
    if (seen.has(phone)) continue;
    seen.add(phone);
    const others = await db.ownerNotifyChannel.count({ where: { phoneE164: phone, NOT: { tenantId } } });
    deleted += await forgetNotifierPhone(phone, tenantId, { db, config, keepContact: others > 0 });
  }
  return deleted;
}
