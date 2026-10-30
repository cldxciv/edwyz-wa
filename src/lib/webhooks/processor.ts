import { sanitizeMessage } from "@/lib/safe-error";
import { runAutomationsForInbound } from "@/lib/automation/engine";
import { handleInboundForAiAgent } from "@/lib/ai-agent";
import { handleInboundForChatbots } from "@/lib/chatbots";
import { endChatbotSessionsForContact } from "@/lib/chatbots/opt-out";
import { captureReferral, parseReferral } from "@/lib/conversions/referral";
import { onContactOptedOut, onInboundFromContact } from "@/lib/leads";
import { prisma } from "@/lib/db";
import { sendText } from "@/lib/inbox/service";
import { getInboxSettings } from "@/lib/inbox/settings";
import { reopenOnInbound } from "@/lib/inbox/status";
import { failedRecipientData } from "@/lib/broadcasts/retry";
import { handleBlockedDelivery, isTemplateBlockCode, pauseBroadcastsForTemplate } from "@/lib/broadcasts/blocked";
import { reestimateBroadcastHolds, syncRecipientFromMessage } from "@/lib/broadcasts/process";
import { graphFetch } from "@/lib/graph";
import { emitEvent } from "@/lib/integrations/events";
import { normalizeTier } from "@/lib/messaging-limit";
import { contactOptedOutPayload, messageReceivedPayload, messageStatusPayload, templateStatusPayload } from "@/lib/integrations/payloads";
import { assignConversation } from "@/lib/routing";
import { normalizeIdentity } from "@/lib/contacts/identity";
import { learnIdentityFromStatus, resolveInboundContact } from "@/lib/contacts/resolve";
import { describeError } from "@/lib/safe-error";
import { applyAccountUpdate, applyTemplateQuality, normalizeQualityRating } from "@/lib/spend/messaging/quality";
import { normalizeCategory } from "@/lib/spend/messaging/origin";
import { handleOwnerKeyword, handleOwnerReply } from "@/lib/spend/notify/inbound";
import { mapMetaStatus } from "@/lib/templates/status";
import { wireModules } from "@/lib/wiring";
import { asArr, asJsonArr, asRec, describeMessage, INTERACTIVE_PLACEHOLDER, extractChanges, isStartMessage, isStopMessage, parsePricing, str, type Change, type ParsedMessage, type Rec } from "./payload";

type Target = { tenantId: string; phoneRowId: string; metaPhoneId?: string };
export type Profile = { name?: string; username?: string; waId?: string; bsuid?: string };

const STATUS_RANK: Record<string, number> = { received: 0, queued: 1, sent: 2, delivered: 3, read: 4, failed: 5 };
/**
 * Meta's template events to our status (docs/SPEND-CONTROLS-SPEC.md 6.3). FLAGGED is its own status now (marketing broadcasts
 * and assistants stop using it, other senders continue); REINSTATED and UNPAUSE put a template back to approved, followed by a
 * re-read of the template from Meta.
 */
const TEMPLATE_EVENTS: Record<string, string> = {
  APPROVED: "approved",
  REJECTED: "rejected",
  PENDING: "pending",
  IN_REVIEW: "pending",
  PAUSED: "paused",
  DISABLED: "disabled",
  FLAGGED: "flagged",
  REINSTATED: "approved",
  UNPAUSE: "approved",
  UNPAUSED: "approved",
};
const RESTORING_EVENTS = new Set(["REINSTATED", "UNPAUSE", "UNPAUSED"]);

export type ProcessResult = { handled: number; notes: string[] };
type Outcome = { tenantId?: string; phoneNumberId?: string; note?: string };

export async function processWebhookEvent(eventId: string): Promise<ProcessResult> {
  const event = await prisma.webhookEvent.findUnique({ where: { id: eventId } });
  if (!event) return { handled: 0, notes: ["event not found"] };
  if (event.processedAt) return { handled: 0, notes: ["already processed"] };

  const result: ProcessResult = { handled: 0, notes: [] };
  let tenantId: string | null = null;
  let phoneNumberId: string | null = null;
  let wabaId: string | null = null;

  try {
    for (const change of extractChanges(event.payload)) {
      const outcome = await processChange(change);
      tenantId = outcome.tenantId ?? tenantId;
      phoneNumberId = outcome.phoneNumberId ?? phoneNumberId;
      wabaId = change.wabaId ?? wabaId;
      if (outcome.note) result.notes.push(outcome.note);
      else result.handled += 1;
    }
  } catch (error) {
    const message = error instanceof Error ? sanitizeMessage(error.message, 500) : "unknown error";
    await prisma.webhookEvent.update({ where: { id: eventId }, data: { error: message } });
    throw error;
  }

  await prisma.webhookEvent.update({
    where: { id: eventId },
    data: { processedAt: new Date(), tenantId, phoneNumberId, wabaId, error: result.notes.join("; ").slice(0, 500) || null },
  });
  return result;
}

export async function processChange(change: Change): Promise<Outcome> {
  switch (change.field) {
    case "messages":
      return processMessagesChange(change);
    case "message_template_status_update":
      return processTemplateStatus(change);
    case "message_template_quality_update":
      return processTemplateQuality(change);
    case "template_category_update":
      return processCategoryUpdate(change);
    case "phone_number_quality_update":
      return processQualityUpdate(change);
    default:
      return processAccountEvent(change);
  }
}

async function resolvePhone(phoneId: string | undefined): Promise<Target | null> {
  if (!phoneId) return null;
  const phone = await prisma.phoneNumber.findUnique({ where: { phoneNumberId: phoneId }, select: { id: true, tenantId: true } });
  return phone ? { tenantId: phone.tenantId, phoneRowId: phone.id } : null;
}

async function resolveWaba(wabaId: string | undefined) {
  if (!wabaId) return null;
  return prisma.waba.findUnique({ where: { wabaId }, select: { id: true, tenantId: true } });
}

async function processMessagesChange(change: Change): Promise<Outcome> {
  const phoneId = str(asRec(change.value.metadata).phone_number_id);
  const target = await resolvePhone(phoneId);
  if (!target) return { phoneNumberId: phoneId, note: `unknown phone_number_id ${phoneId ?? "(missing)"}` };

  const profiles = new Map<string, Profile>();
  for (const c of asArr(change.value.contacts)) {
    const rec = asRec(c);
    const profile = asRec(rec.profile);
    // Profile keys: the wa_id (a phone) and the BSUID. A username user may have only the BSUID. VERIFY field names against Meta's webhook reference.
    const entry: Profile = { name: str(profile.name), username: str(profile.username) ?? str(rec.username), waId: str(rec.wa_id), bsuid: str(rec.user_id) ?? str(rec.bsuid) };
    for (const key of [entry.waId, entry.bsuid]) if (key) profiles.set(key, entry);
  }
  for (const m of asArr(change.value.messages)) await handleInboundMessage({ ...target, metaPhoneId: phoneId }, asRec(m), profiles);
  for (const s of asArr(change.value.statuses)) await handleStatus(target.tenantId, asRec(s));
  return { tenantId: target.tenantId, phoneNumberId: phoneId };
}

const eventTime = (timestamp: unknown) => {
  const seconds = Number(timestamp);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : new Date();
};

/** The sender's identifiers from a message and its contacts[] entry. `from` is the phone (wa_id); a username user has `from_user_id` (the BSUID) and may have no phone. */
export function senderIdentity(message: Rec, profiles: Map<string, Profile>) {
  const from = str(message.from);
  const userId = str(message.from_user_id) ?? str(message.user_id);
  const profile = (userId && profiles.get(userId)) || (from && profiles.get(from)) || undefined;
  const identity = normalizeIdentity({ from, waId: profile?.waId, bsuid: userId ?? profile?.bsuid, username: profile?.username });
  return { identity, name: profile?.name };
}

export async function handleInboundMessage(target: Target, message: Rec, profiles: Map<string, Profile>) {
  const wamid = str(message.id);
  if (!wamid) return;
  const { tenantId, phoneRowId } = target;

  const { identity, name } = senderIdentity(message, profiles);
  if (!identity.phone && !identity.bsuid) return;

  if (await prisma.message.findUnique({ where: { wamid }, select: { id: true } })) return;

  const contact = await resolveInboundContact(tenantId, { ...identity, name });
  if (!contact) return;
  const phone = contact.phone;
  const conversation = await prisma.conversation.upsert({
    where: { phoneNumberId_contactId: { phoneNumberId: phoneRowId, contactId: contact.id } },
    create: { tenantId, phoneNumberId: phoneRowId, contactId: contact.id },
    update: {},
  });

  const parsed = describeMessage(message);
  const at = eventTime(message.timestamp);

  // An interactive message without a tapped button or row (a form reply, for example) carries no words, so bots, the AI and rules never read its placeholder text.
  const textual = ["text", "button"].includes(parsed.type) || (parsed.type === "interactive" && parsed.body !== INTERACTIVE_PLACEHOLDER);
  // The title of a tapped reply button or list row is the business's own wording (a menu may offer "Cancel" or "End"), not the customer's words.
  const tappedReply = parsed.type === "interactive" && Boolean(parsed.replyId);
  const isStop = textual && !tappedReply && isStopMessage(parsed.body);
  const isStart = textual && !tappedReply && !isStop && !!contact.optedOutAt && isStartMessage(parsed.body);
  // Consent is applied before the message row is stored. The row is what makes a webhook retry stop early, so a crash between the
  // two steps can never leave a stored STOP or START that was not acted on. Every step here is safe to run again.
  if (isStop) {
    await applyOptOut(tenantId, { id: contact.id, phone, bsuid: contact.bsuid, waId: contact.waId, username: contact.username, name: name ?? contact.name ?? null });
    await endChatbotSessionsForContact(tenantId, contact.id);
    await onContactOptedOut(tenantId, contact.id).catch(() => console.error("[leads] could not stop lead sequences after an opt-out"));
  } else if (isStart) {
    await applyOptIn(tenantId, contact.id);
  }
  // In the platform's notifier workspace, STOP turns off every owner channel with this phone and START only its own (7.4 item 5).
  if ((isStop || isStart) && (await notifierTenantId()) === tenantId) await ownerKeyword(tenantId, str(message.from) ?? identity.phone ?? "", isStop ? "stop" : "start");

  try {
    await prisma.message.create({
      data: {
        tenantId,
        conversationId: conversation.id,
        wamid,
        direction: "inbound",
        type: parsed.type,
        body: parsed.body,
        mediaUrl: parsed.mediaId ? `meta-media:${parsed.mediaId}` : null,
        mediaMime: parsed.mediaMime ?? null,
        status: "received",
        statusTimeline: [{ status: "received", at: at.toISOString() }],
        createdAt: at,
      },
    });
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") return;
    throw error;
  }

  await prisma.conversation.updateMany({
    where: { id: conversation.id, tenantId },
    data: { lastInboundAt: at, lastMessageAt: at, unreadCount: { increment: 1 } },
  });

  // An owner's quick reply to a spending notice (Decline, or the opt-in "Yes"): only in the platform's notifier workspace, and
  // nothing else runs for it (no bots, rules or routing). Anywhere else the same payload is an ordinary button tap.
  const ownerPayload = !isStop && !isStart ? ownerReplyPayload(parsed) : null;
  if (ownerPayload && (await notifierTenantId()) === tenantId) {
    const waId = (str(message.from) ?? identity.phone ?? "").replace(/\D/g, "");
    await handleOwnerReply({ tenantId, waId, payload: ownerPayload, messageId: wamid }).catch((error) => console.error("[spend] could not handle an owner's quick reply:", describeError(error)));
    return;
  }

  if (isStop) {
    if (!contact.optedOutAt) await sendConsentReply(tenantId, conversation.id, "optOutReply");
  } else if (isStart) {
    await sendConsentReply(tenantId, conversation.id, "optInReply");
  } else {
    await onInboundFromContact(tenantId, contact.id).catch(() => console.error("[leads] could not stop lead sequences after a reply"));
  }

  const referral = parseReferral(message);
  await emitEvent(
    tenantId,
    "message.received",
    messageReceivedPayload({
      conversationId: conversation.id,
      channel: target.metaPhoneId ?? null,
      assignedTo: conversation.assignedToId ?? null,
      contact: { ...contact, name: name ?? contact.name ?? null },
      message: { id: wamid, type: parsed.type, text: parsed.body, mediaId: parsed.mediaId ?? null, mimeType: parsed.mediaMime ?? null, timestamp: at },
      referral,
    }),
  );

  if (referral) await captureReferral(tenantId, conversation.id, referral).catch(() => console.error("[conversions] could not store a click-to-WhatsApp referral"));

  const reopened = await reopenOnInbound(tenantId, conversation.id, at).catch(() => false);
  wireModules();
  const inboundInput = { tenantId, phoneNumberId: phoneRowId, conversationId: conversation.id, contactId: contact.id, text: textual ? parsed.body : "", receivedAt: at, replyId: parsed.replyId };
  const chatbotHandled = isStop || isStart
    ? false
    : await handleInboundForChatbots(inboundInput).catch(() => {
        console.error("[chatbot] could not run chatbots for an inbound message");
        return false;
      });
  const aiHandled =
    isStop || isStart || chatbotHandled
      ? false
      : await handleInboundForAiAgent(inboundInput).catch(() => {
          console.error("[ai-agent] could not run the AI agent for an inbound message");
          return false;
        });
  const botHandled = chatbotHandled || aiHandled;
  if (!botHandled && (reopened || !conversation.assignedToId)) {
    await assignConversation(tenantId, conversation.id).catch(() => console.error("[routing] could not assign a conversation"));
  }

  if (!isStop && !isStart) {
    await runAutomationsForInbound({ tenantId, phoneNumberId: phoneRowId, conversationId: conversation.id, contactId: contact.id, text: textual ? parsed.body : "", receivedAt: at, messageType: parsed.type, botHandled }).catch(() =>
      console.error("[automation] could not run automations for an inbound message"),
    );
  }
}

async function applyOptOut(tenantId: string, contact: { id: string; phone: string | null; bsuid?: string | null; waId?: string | null; username?: string | null; name: string | null }) {
  const optedOutAt = new Date();
  await prisma.contact.updateMany({ where: { id: contact.id, tenantId }, data: { optedOutAt, optIn: false } });
  await prisma.auditLog.create({ data: { tenantId, action: "contact.opted_out", target: contact.id, meta: { via: "stop_keyword" } } });
  await emitEvent(tenantId, "contact.opted_out", contactOptedOutPayload({ contact, optedOutAt, source: "stop_keyword" }));
}

/** START (or UNSTOP, SUBSCRIBE) from a contact who had sent STOP: they asked to hear from the business again. */
async function applyOptIn(tenantId: string, contactId: string) {
  await prisma.contact.updateMany({ where: { id: contactId, tenantId }, data: { optedOutAt: null, optIn: true, optInSource: "whatsapp_start", optInAt: new Date() } });
  await prisma.auditLog.create({ data: { tenantId, action: "contact.opted_in", target: contactId, meta: { via: "start_keyword" } } });
}

/**
 * The confirmation after STOP or START. The customer's own message has just opened the 24-hour window, so free text is allowed.
 * An empty text in the workspace's inbox settings sends nothing. Origin `consent` (docs/SPEND-CONTROLS-SPEC.md 4.9): a
 * compliance message is never held by a stop, a quality drop or a used-up limit.
 */
async function sendConsentReply(tenantId: string, conversationId: string, kind: "optOutReply" | "optInReply") {
  try {
    const body = (await getInboxSettings(tenantId))[kind];
    if (body) await sendText({ tenantId, conversationId, body, origin: "consent" });
  } catch {
    console.error("[inbox] could not queue the opt-in or opt-out confirmation");
  }
}

/** The quick-reply prefixes of the spending notices (7.4): Decline (`spdec:`) and the opt-in "Yes" (`spopt:`). */
const OWNER_REPLY = /^(spdec|spopt):/;

/** STOP or START from an owner in the notifier workspace, kept in step with their spending-alert channels. Never throws. */
async function ownerKeyword(tenantId: string, from: string, keyword: "stop" | "start"): Promise<void> {
  try {
    await handleOwnerKeyword({ tenantId, waId: from.replace(/\D/g, ""), keyword });
  } catch (error) {
    console.error("[spend] could not update owner alert channels after STOP or START:", describeError(error));
  }
}

/** The payload of a tapped spending-notice quick reply (template button, or an interactive reply id), or null. */
export function ownerReplyPayload(parsed: Pick<ParsedMessage, "type" | "buttonPayload" | "replyId">): string | null {
  const payload = parsed.type === "button" ? parsed.buttonPayload : parsed.type === "interactive" ? parsed.replyId : undefined;
  return payload && OWNER_REPLY.test(payload) ? payload : null;
}

const NOTIFIER_KEY = "spend:notify";
const NOTIFIER_CACHE_MS = 60_000;
let notifierCache: { at: number; tenantId: string | null } | null = null;

/** The platform's notifier workspace ('spend:notify'.tenantId), cached for a minute; null when none is set up or unreadable. */
export async function notifierTenantId(now: number = Date.now()): Promise<string | null> {
  if (notifierCache && now - notifierCache.at < NOTIFIER_CACHE_MS) return notifierCache.tenantId;
  let tenantId: string | null = null;
  try {
    const row = await prisma.platformSetting.findUnique({ where: { key: NOTIFIER_KEY } });
    const value = row?.value as { tenantId?: unknown } | null | undefined;
    tenantId = typeof value?.tenantId === "string" && value.tenantId ? value.tenantId : null;
  } catch {
    tenantId = null;
  }
  notifierCache = { at: now, tenantId };
  return tenantId;
}

/** Test hook. */
export function resetNotifierCache(): void {
  notifierCache = null;
}

const RECIPIENT_FROM: Record<string, string[]> = {
  sent: ["pending", "queued"],
  delivered: ["pending", "queued", "sent"],
  read: ["pending", "queued", "sent", "delivered"],
  failed: ["pending", "queued", "sent"],
};

export async function handleStatus(tenantId: string, status: Rec) {
  const wamid = str(status.id);
  const next = str(status.status);
  if (!wamid || !next || !RECIPIENT_FROM[next]) return;

  const at = eventTime(status.timestamp);
  const errorCode = next === "failed" ? str(asRec(asArr(status.errors)[0]).code) : undefined;

  const updated = await updateMessageStatus(tenantId, wamid, next, at, errorCode);
  if (updated) await storePricing(tenantId, updated.messageId, status);
  // A broadcast recipient is linked to its message until the worker copies the wamid over, so settle it from the message right away
  // instead of waiting for the next worker run (which can be hours away while a broadcast waits for the daily limit to reopen).
  if (updated) await syncRecipientFromMessage(updated.messageId).catch(() => console.error("[webhooks] could not update a broadcast recipient from a delivery status"));
  await updateRecipientStatus(tenantId, wamid, next, at, errorCode);
  const contact = updated?.contact ?? null;
  if (!contact) return;
  // The recipient may be named by phone (recipient_id) or BSUID (recipient_user_id, VERIFY). Learn whichever the contact is missing.
  const identity = normalizeIdentity({ phone: status.recipient_id, bsuid: status.recipient_user_id ?? status.user_id });
  if ((identity.phone && !contact.phone) || (identity.bsuid && !contact.bsuid)) {
    await learnIdentityFromStatus(tenantId, contact.id, { ...identity, name: null }).catch(() => console.error("[webhooks] could not update a contact from a delivery status"));
  }
}

async function updateMessageStatus(tenantId: string, wamid: string, next: string, at: Date, errorCode?: string): Promise<{ messageId: string; contact: { id: string; phone: string | null; bsuid: string | null } | null } | null> {
  const message = await prisma.message.findFirst({ where: { wamid, tenantId }, select: { id: true, status: true, statusTimeline: true, conversationId: true, direction: true, conversation: { select: { contact: { select: { id: true, phone: true, bsuid: true, waId: true, username: true, name: true } } } } } });
  if (!message) return null;
  const entry = { status: next, at: at.toISOString(), ...(errorCode ? { errorCode } : {}) };
  const advance = (STATUS_RANK[next] ?? 0) > (STATUS_RANK[message.status] ?? 0);
  await prisma.message.updateMany({
    where: { id: message.id, tenantId },
    data: {
      statusTimeline: [...asJsonArr(message.statusTimeline), entry],
      ...(advance ? { status: next as never } : {}),
      ...(errorCode ? { errorCode } : {}),
    },
  });
  if (message.direction === "outbound") {
    await emitEvent(
      tenantId,
      "message.status",
      messageStatusPayload({ messageId: message.id, conversationId: message.conversationId, wamid, status: next, errorCode: errorCode ?? null, timestamp: at, contact: message.conversation?.contact ?? null }),
    );
  }
  return { messageId: message.id, contact: message.direction === "outbound" ? (message.conversation?.contact ?? null) : null };
}

/**
 * Meta's pricing for a delivered message (statuses[].pricing: billable, type, category), stored from the FIRST status that
 * carries it (docs/SPEND-CONTROLS-SPEC.md 4.9). Settlement (spend.messaging.settle) then replaces the estimate with it once.
 * Meta's category replaces the one stamped at enqueue, so settlement prices what Meta actually charged.
 */
async function storePricing(tenantId: string, messageId: string, status: Rec): Promise<void> {
  const pricing = parsePricing(status);
  if (!pricing) return;
  try {
    await prisma.message.updateMany({
      where: { id: messageId, tenantId, billable: null },
      data: {
        billable: pricing.billable,
        pricingType: pricing.type,
        ...(pricing.category ? { pricingCategory: normalizeCategory(pricing.category) } : {}),
      },
    });
  } catch (error) {
    console.error("[webhooks] could not store a message's pricing:", describeError(error));
  }
}

async function updateRecipientStatus(tenantId: string, wamid: string, next: string, at: Date, errorCode?: string) {
  // The template was paused or disabled: same handling as a refusal at send time (back to pending, broadcast paused with the reason).
  if (next === "failed" && isTemplateBlockCode(errorCode) && (await handleBlockedDelivery(tenantId, wamid, errorCode as string).catch(() => false))) return;
  const stamp = next === "sent" ? { sentAt: at } : next === "delivered" ? { deliveredAt: at } : next === "read" ? { readAt: at } : {};
  const retry = next === "failed" && errorCode ? await retryBookkeeping(tenantId, wamid, errorCode, at) : {};
  await prisma.broadcastRecipient.updateMany({
    where: { tenantId, wamid, status: { in: RECIPIENT_FROM[next] as never[] } },
    data: { status: next as never, ...stamp, ...(errorCode ? { errorCode } : {}), ...retry },
  });
}

/** A failure that arrives after the message was accepted (status "sent") still gets the per-user marketing cap retry bookkeeping. */
async function retryBookkeeping(tenantId: string, wamid: string, errorCode: string, at: Date): Promise<Record<string, unknown>> {
  const r = await prisma.broadcastRecipient.findFirst({ where: { tenantId, wamid }, select: { attempts: true, broadcast: { select: { retryDays: true, startedAt: true } } } });
  if (!r?.broadcast) return {};
  const { status: _status, errorCode: _code, ...extra } = failedRecipientData(errorCode, { attempts: r.attempts, retryDays: r.broadcast.retryDays, startedAt: r.broadcast.startedAt }, at);
  void _status;
  void _code;
  return extra;
}

/** Updates a template by Meta id, falling back to name and language. Returns how many rows changed. */
async function updateTemplateRow(where: { tenantId: string; wabaRefId: string }, v: Rec, data: Record<string, unknown>): Promise<number> {
  const metaId = str(v.message_template_id);
  const byId = metaId ? await prisma.template.updateMany({ where: { ...where, metaTemplateId: metaId }, data }) : { count: 0 };
  if (byId.count > 0) return byId.count;
  const name = str(v.message_template_name);
  const language = str(v.message_template_language);
  if (!name || !language) return 0;
  return (await prisma.template.updateMany({ where: { ...where, name, language }, data })).count;
}

/** The template a webhook value names, by Meta id or by name and language. */
const knownTemplate = (where: { tenantId: string; wabaRefId: string }, v: Rec) => {
  const metaId = str(v.message_template_id);
  return findKnownTemplate({ ...where, ...(metaId ? { metaTemplateId: metaId } : { name: str(v.message_template_name) ?? "", language: str(v.message_template_language) ?? "" }) });
};

/**
 * After REINSTATED or UNPAUSE, reads the template back from Meta so its status and category match what Meta now says (6.3
 * "plus a template re-sync"). Best effort: the event's own status was already stored.
 */
async function resyncTemplate(tenantId: string, template: { id: string; metaTemplateId?: string | null } | null): Promise<void> {
  if (!template?.metaTemplateId) return;
  try {
    const t = await graphFetch<{ status?: string; category?: string }>({ tenantId, path: template.metaTemplateId, query: { fields: "status,category" } });
    await prisma.template.updateMany({
      where: { id: template.id, tenantId },
      data: { ...(t.status ? { status: mapMetaStatus(t.status) } : {}), ...(t.category ? { category: String(t.category).toUpperCase() } : {}) },
    });
  } catch (error) {
    console.warn("[webhooks] could not re-read a reinstated template from Meta:", describeError(error));
  }
}

async function processTemplateStatus(change: Change): Promise<Outcome> {
  const waba = await resolveWaba(change.wabaId);
  if (!waba) return { note: `unknown waba ${change.wabaId ?? "(missing)"}` };
  const v = change.value;
  const event = (str(v.event) ?? "").toUpperCase();
  let status = TEMPLATE_EVENTS[event];
  if (!status) return { tenantId: waba.tenantId, note: `unhandled template event ${str(v.event)}` };

  const reason = str(v.reason);
  const where = { tenantId: waba.tenantId, wabaRefId: waba.id };
  const dataFor = (s: string) => ({ status: s as never, rejectionReason: s === "rejected" && reason && reason !== "NONE" ? reason : null });
  try {
    await updateTemplateRow(where, v, dataFor(status));
  } catch (error) {
    if (status !== "flagged") throw error;
    // Before migration 0011 adds the `flagged` value the database refuses it: keep the old, stricter mapping (paused).
    console.warn("[webhooks] the flagged template status is not in the database yet; storing paused:", describeError(error));
    status = "paused";
    await updateTemplateRow(where, v, dataFor(status));
  }
  const stops = status === "paused" || status === "disabled" || status === "rejected";
  const data = dataFor(status);
  const known = await knownTemplate(where, v);
  // Stop campaigns that use this template now, with the reason, instead of waiting for the worker to notice on its next run.
  if (stops && known) await pauseBroadcastsForTemplate(waba.tenantId, known.id, "template_paused").catch(() => console.error("[webhooks] could not pause broadcasts for a stopped template"));
  // Flagged: marketing broadcasts using it pause; other senders may continue (6.3).
  if (status === "flagged" && known && normalizeCategory(known.category) === "MARKETING") {
    await pauseBroadcastsForTemplate(waba.tenantId, known.id, "template_quality").catch(() => console.error("[webhooks] could not pause broadcasts for a flagged template"));
  }
  if (RESTORING_EVENTS.has(event)) await resyncTemplate(waba.tenantId, known);
  await emitEvent(
    waba.tenantId,
    "template.status",
    templateStatusPayload({
      templateId: known?.id ?? null,
      name: str(v.message_template_name) ?? null,
      language: str(v.message_template_language) ?? null,
      category: known?.category?.toLowerCase() ?? null,
      status,
      reason: data.rejectionReason,
      timestamp: new Date(),
    }),
  );
  return { tenantId: waba.tenantId };
}

/**
 * Meta's template quality score changed (GREEN, YELLOW, RED, UNKNOWN). A drop to RED stops every broadcast that is scheduled or sending with
 * that template before Meta pauses the template itself; a drop to YELLOW is recorded as a warning. Both stop assistants from using it and
 * tell the owner (docs/SPEND-CONTROLS-SPEC.md 6.3); GREEN lifts that again. The template itself stays approved.
 */
async function processTemplateQuality(change: Change): Promise<Outcome> {
  const waba = await resolveWaba(change.wabaId);
  if (!waba) return { note: `unknown waba ${change.wabaId ?? "(missing)"}` };
  const v = change.value;
  const score = (str(v.new_quality_score) ?? str(v.quality_score) ?? "").toUpperCase();
  const previous = (str(v.previous_quality_score) ?? "").toUpperCase();
  const metaId = str(v.message_template_id);
  const name = str(v.message_template_name);
  const language = str(v.message_template_language);
  const where = { tenantId: waba.tenantId, wabaRefId: waba.id };
  const known = await findKnownTemplate(metaId ? { ...where, metaTemplateId: metaId } : { ...where, name: name ?? "", language: language ?? "" });
  if (score === "GREEN") {
    await applyTemplateQuality(waba.tenantId, known ? { id: known.id, name: known.name ?? name ?? null } : null, score).catch((error) => console.error("[webhooks] could not lift a template quality stop:", describeError(error)));
    return { tenantId: waba.tenantId };
  }
  if (score !== "RED" && score !== "YELLOW") return { tenantId: waba.tenantId };
  await prisma.auditLog.create({
    data: { tenantId: waba.tenantId, action: score === "RED" ? "template.quality_dropped" : "template.quality_warning", target: known?.id ?? metaId ?? name ?? null, meta: { name: name ?? null, language: language ?? null, from: previous || null, to: score } },
  });
  if (score === "RED" && known) await pauseBroadcastsForTemplate(waba.tenantId, known.id, "template_quality");
  await applyTemplateQuality(waba.tenantId, known ? { id: known.id, name: known.name ?? name ?? null } : null, score).catch((error) => console.error("[webhooks] could not record a template quality drop:", describeError(error)));
  return { tenantId: waba.tenantId };
}

/**
 * template_category_update (docs/SPEND-CONTROLS-SPEC.md 6.3): Meta re-categorised a template, which changes what it costs. The
 * new category is stored (the next estimate and every send gate use it), and the holds of broadcasts sending with it are
 * re-estimated; a broadcast that no longer fits pauses with messaging_limit. A notice of a coming change (no new_category yet)
 * is only recorded.
 */
async function processCategoryUpdate(change: Change): Promise<Outcome> {
  const waba = await resolveWaba(change.wabaId);
  if (!waba) return { note: `unknown waba ${change.wabaId ?? "(missing)"}` };
  const v = change.value;
  const next = (str(v.new_category) ?? "").toUpperCase().replace(/[^A-Z_]/g, "").slice(0, 32);
  const previous = (str(v.previous_category) ?? "").toUpperCase().replace(/[^A-Z_]/g, "").slice(0, 32);
  const where = { tenantId: waba.tenantId, wabaRefId: waba.id };
  const known = await knownTemplate(where, v);
  await prisma.auditLog.create({
    data: {
      tenantId: waba.tenantId,
      action: "template.category_changed",
      target: known?.id ?? str(v.message_template_id) ?? str(v.message_template_name) ?? null,
      meta: { name: str(v.message_template_name) ?? null, from: previous || null, to: next || null, upcoming: (str(v.correct_category) ?? "").toUpperCase().slice(0, 32) || null },
    },
  });
  if (!next) return { tenantId: waba.tenantId };
  await updateTemplateRow(where, v, { category: next });
  if (known) {
    await reestimateBroadcastHolds(waba.tenantId, known.id).catch((error) => console.error("[webhooks] could not re-estimate broadcasts after a category change:", describeError(error)));
  }
  return { tenantId: waba.tenantId };
}

async function findKnownTemplate(where: Record<string, unknown>) {
  try {
    return await prisma.template.findFirst({ where, select: { id: true, category: true, name: true, metaTemplateId: true } });
  } catch {
    return null;
  }
}

async function processQualityUpdate(change: Change): Promise<Outcome> {
  const v = change.value;
  const phoneId = str(v.phone_number_id);
  let target = await resolvePhone(phoneId);
  if (!target) target = await matchByDisplayNumber(change.wabaId, str(v.display_phone_number));
  if (!target) return { note: "quality update for unknown phone number" };

  // Stored as GREEN, YELLOW or RED (Meta's older HIGH, MEDIUM and LOW too); UNKNOWN or NA keeps the last known rating. The quality
  // breakers are driven by the 30-minute poll (spend.quality.poll), because this event usually carries no rating any more.
  const rating = normalizeQualityRating(str(v.quality_rating) ?? str(v.current_quality_rating));
  const tier = normalizeTier(str(v.current_limit) ?? str(v.messaging_limit_tier));
  await prisma.phoneNumber.updateMany({
    where: { id: target.phoneRowId, tenantId: target.tenantId },
    data: { ...(rating ? { qualityRating: rating } : {}), ...(tier ? { messagingLimitTier: tier } : {}) },
  });
  // The limit belongs to the portfolio, not to this number. Without this a sibling number keeping an older, higher tier would mask a
  // downgrade, because the portfolio limit is the highest tier any of its numbers reports.
  if (tier) {
    const row = await prisma.phoneNumber.findFirst({ where: { id: target.phoneRowId, tenantId: target.tenantId }, select: { wabaRefId: true } });
    if (row?.wabaRefId) await storePortfolioTier({ id: row.wabaRefId, tenantId: target.tenantId }, tier);
  }
  return { tenantId: target.tenantId, phoneNumberId: phoneId };
}

async function matchByDisplayNumber(wabaId: string | undefined, displayPhone: string | undefined): Promise<Target | null> {
  const waba = await resolveWaba(wabaId);
  const digits = displayPhone?.replace(/\D/g, "");
  if (!waba || !digits) return null;
  const phones = await prisma.phoneNumber.findMany({
    where: { tenantId: waba.tenantId, wabaRefId: waba.id },
    select: { id: true, displayPhone: true },
  });
  const match = phones.find((p) => p.displayPhone.replace(/\D/g, "") === digits);
  return match ? { tenantId: waba.tenantId, phoneRowId: match.id } : null;
}

const PORTFOLIO_LIMIT_KEYS = ["max_daily_conversations_per_business", "max_daily_conversation_per_business", "max_daily_conversation_per_phone", "current_limit", "messaging_limit_tier"];

/** Meta applies the messaging limit to the whole business portfolio, so a change on the account is stored on every number of that portfolio. */
async function applyPortfolioLimit(waba: { id: string; tenantId: string }, value: Record<string, unknown>): Promise<void> {
  const key = PORTFOLIO_LIMIT_KEYS.find((k) => value[k] !== undefined && value[k] !== null);
  const tier = key ? normalizeTier(value[key]) : null;
  if (tier) await storePortfolioTier(waba, tier);
}

async function storePortfolioTier(waba: { id: string; tenantId: string }, tier: string): Promise<void> {
  const row = await prisma.waba.findFirst({ where: { id: waba.id, tenantId: waba.tenantId }, select: { businessId: true } });
  await prisma.phoneNumber.updateMany({
    where: { tenantId: waba.tenantId, waba: row?.businessId ? { businessId: row.businessId } : { id: waba.id } },
    data: { messagingLimitTier: tier },
  });
}

/** The only keys of an account-level webhook value that may reach the audit log, and only as short scalars. Everything else (message content, contacts, template text, free text) is dropped. */
const SUMMARY_KEYS = ["event", "ban_state", "violation_type", "decision", "current_limit", "restriction_type"] as const;
const SUMMARY_VALUE_MAX = 64;

const shortScalar = (value: unknown): string | null => {
  if (typeof value === "string") return value.replace(/[^\w .:/-]/g, "").slice(0, SUMMARY_VALUE_MAX) || null;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
};

/** `event` type, waba id and a one-line summary built from the allow-listed keys. Never the raw webhook value. */
export function accountEventAuditMeta(change: Pick<Change, "field" | "value">, wabaId: string | undefined): Record<string, string | null> {
  const parts: string[] = [];
  for (const key of SUMMARY_KEYS) {
    const v = shortScalar(change.value[key]);
    if (v) parts.push(`${key}=${v}`);
  }
  return { event: shortScalar(change.value.event) ?? change.field, wabaId: wabaId ?? null, summary: `${change.field}${parts.length ? `: ${parts.join(", ")}` : ""}`.slice(0, 200) };
}

async function processAccountEvent(change: Change): Promise<Outcome> {
  const partnerAdded = change.field === "account_update" && str(change.value.event) === "PARTNER_ADDED";
  const info = asRec(change.value.waba_info);
  const wabaId = change.wabaId ?? str(info.waba_id) ?? str(change.value.waba_id);
  const waba = await resolveWaba(wabaId);

  if (partnerAdded) {
    // Hosted signup: no tenant owns this WABA yet, so the audit row is platform-level. Token retrieval is a later phase.
    await prisma.auditLog.create({
      data: {
        tenantId: waba?.tenantId ?? null,
        action: "webhook.account_update.PARTNER_ADDED",
        target: wabaId,
        meta: { wabaId: wabaId ?? null, ownerBusinessId: str(info.owner_business_id) ?? null },
      },
    });
    return { tenantId: waba?.tenantId };
  }

  if (!waba) return { note: `${change.field}: unknown waba ${wabaId ?? "(missing)"}` };
  if (change.field === "business_capability_update") await applyPortfolioLimit(waba, change.value);
  await prisma.auditLog.create({
    data: { tenantId: waba.tenantId, action: `webhook.${change.field}`, target: wabaId, meta: accountEventAuditMeta(change, wabaId) },
  });
  // Restrictions, disabling and violations become safety stops and notices (docs/SPEND-CONTROLS-SPEC.md 6.3).
  if (change.field === "account_update") await applyAccountUpdate({ id: waba.id, tenantId: waba.tenantId, wabaId }, change.value);
  return { tenantId: waba.tenantId };
}
