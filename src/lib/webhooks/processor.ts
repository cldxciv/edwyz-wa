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
import { normalizeIdentity, phoneFromWaId } from "@/lib/contacts/identity";
import { learnIdentityFromStatus, resolveInboundContact } from "@/lib/contacts/resolve";
import { describeError } from "@/lib/safe-error";
import { applyAccountUpdate, applyTemplateQuality, normalizeQualityRating } from "@/lib/spend/messaging/quality";
import { normalizeCategory } from "@/lib/spend/messaging/origin";
import { handleOwnerKeyword, handleOwnerReply } from "@/lib/spend/notify/inbound";
import { mapMetaStatus } from "@/lib/templates/status";
import { wireModules } from "@/lib/wiring";
import { POSSIBLE_OPT_OUT_NOTE } from "@/lib/contacts/opt-out";
import { asArr, asJsonArr, asRec, describeMessage, INTERACTIVE_PLACEHOLDER, extractChanges, isOptOutButton, isStartMessage, isStopMessage, mightBeOptOutRequest, mightBeStopWord, NOT_CUSTOMER_MESSAGE_TYPES, parsePricing, stopSourceOf, str, type Change, type ParsedMessage, type Rec, type StopSource } from "./payload";

type Target = { tenantId: string; phoneRowId: string; metaPhoneId?: string };
export type Profile = { name?: string; username?: string; waId?: string; bsuid?: string };

const STATUS_RANK: Record<string, number> = { received: 0, queued: 1, sent: 2, delivered: 3, read: 4, failed: 5 };
/**
 * Meta's template events to our status (docs/SPEND-CONTROLS-SPEC.md 6.3). FLAGGED is its own status now (marketing broadcasts
 * and assistants stop using it, other senders continue); REINSTATED and UNPAUSE put a template back to approved, followed by a
 * re-read of the template from Meta. A template deleted or archived in WhatsApp Manager can no longer be sent, so it is disabled
 * (and its broadcasts pause) instead of staying approved; an appeal is back under review; LIMIT_EXCEEDED (the account is at its
 * template limit) is not usable and can be fixed like a rejected one. Every event that is also a template status maps exactly as a
 * sync does (templates/status.ts), so a webhook and the next sync never disagree; tests/webhook-processor.test.ts checks this.
 */
const TEMPLATE_EVENTS: Record<string, string> = {
  APPROVED: "approved",
  REJECTED: "rejected",
  PENDING: "pending",
  IN_REVIEW: "pending",
  IN_APPEAL: "pending",
  PAUSED: "paused",
  DISABLED: "disabled",
  DELETED: "disabled",
  PENDING_DELETION: "disabled",
  ARCHIVED: "disabled",
  LIMIT_EXCEEDED: "rejected",
  FLAGGED: "flagged",
  REINSTATED: "approved",
  UNPAUSE: "approved",
  UNPAUSED: "approved",
};
const RESTORING_EVENTS = new Set(["REINSTATED", "UNPAUSE", "UNPAUSED"]);
/**
 * Events that carry no status. LOCKED means the template can no longer be edited; it can still be sent, so nothing changes.
 * UNARCHIVED puts the template back to the status it had before it was archived, which only Meta knows, so it is read back from
 * Meta (until then it stays disabled, which is safe).
 */
const LOCKED_EVENT = "LOCKED";
const UNARCHIVED_EVENT = "UNARCHIVED";

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

/**
 * What an inbound row is. A customer message counts as unread, moves the chat up the list, reopens a solved chat, is routed and
 * reaches bots, the AI agent and rules. A reaction (an emoji on an earlier message) and a notice (WhatsApp saying the customer's
 * number or security code changed) are stored and shown in the chat, and nothing else runs for them.
 */
export type InboundKind = "message" | "reaction" | "notice";

/** Built from NOT_CUSTOMER_MESSAGE_TYPES, the list the bots, the AI agent and rules use to leave these rows out of their counts. */
export function inboundKind(type: string): InboundKind {
  if (!NOT_CUSTOMER_MESSAGE_TYPES.includes(type)) return "message";
  return type === "reaction" ? "reaction" : "notice";
}

/** Message types with nothing a rule can read: they still reach the team, but never start an automatic reply. */
const NO_RULES_TYPES = new Set(["unsupported"]);

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
  const at = eventTime(message.timestamp);
  // A new chat starts at the message's own time. The column default (the moment we store it) is a little later than WhatsApp's
  // whole-second timestamp, which would read as "the business wrote last" (dashboard waiting list, "customer has not replied" rules).
  const conversation = await prisma.conversation.upsert({
    where: { phoneNumberId_contactId: { phoneNumberId: phoneRowId, contactId: contact.id } },
    create: { tenantId, phoneNumberId: phoneRowId, contactId: contact.id, lastMessageAt: at },
    update: {},
  });

  const parsed = describeMessage(message);
  const kind = inboundKind(parsed.type);

  // An interactive message without a tapped button or row (a form reply, for example) carries no words, so bots, the AI and rules never read its placeholder text.
  const textual = ["text", "button"].includes(parsed.type) || (parsed.type === "interactive" && parsed.body !== INTERACTIVE_PLACEHOLDER);
  // The title of a tapped reply button or list row is the business's own wording (a menu may offer "Cancel" or "End"), not the
  // customer's words, and so is a template's quick-reply button: a "Cancel" button on a booking template is not a STOP (stopSourceOf).
  const stopSource = stopSourceOf(parsed.type, parsed.replyId);
  const tappedReply = stopSource === "tapped_choice";
  // A STOP word (the whole message), or a tap on the template's marketing opt-out button ("Stop promotions").
  const isStop = textual && !tappedReply && (isOptOutButton(parsed) || (await isWorkspaceStop(tenantId, parsed.body, stopSource)));
  const isStart = textual && !tappedReply && !isStop && !!contact.optedOutAt && isStartMessage(parsed.body);
  // "stop please" is not a STOP (only the whole message counts), but it may be one: the team gets a note and the AI agent leaves it to them.
  const possibleOptOut = !isStop && !isStart && parsed.type === "text" && !contact.optedOutAt && mightBeOptOutRequest(parsed.body);
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

  const body = kind === "reaction" ? await reactionBody(tenantId, parsed) : parsed.body;
  try {
    await prisma.message.create({
      data: {
        tenantId,
        conversationId: conversation.id,
        wamid,
        direction: "inbound",
        type: parsed.type,
        body,
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

  if (kind === "message") await touchConversation(tenantId, conversation, at);

  // An owner's quick reply to a spending notice (Decline, or the opt-in "Yes"): only in the platform's notifier workspace, and
  // nothing else runs for it (no bots, rules or routing). Anywhere else the same payload is an ordinary button tap.
  const ownerPayload = kind === "message" && !isStop && !isStart ? ownerReplyPayload(parsed) : null;
  if (ownerPayload && (await notifierTenantId()) === tenantId) {
    const waId = (str(message.from) ?? identity.phone ?? "").replace(/\D/g, "");
    await handleOwnerReply({ tenantId, waId, payload: ownerPayload, messageId: wamid }).catch((error) => console.error("[spend] could not handle an owner's quick reply:", describeError(error)));
    return;
  }

  if (isStop) {
    if (!contact.optedOutAt) await sendConsentReply(tenantId, conversation.id, "optOutReply");
  } else if (isStart) {
    await sendConsentReply(tenantId, conversation.id, "optInReply");
  } else if (kind === "message") {
    await onInboundFromContact(tenantId, contact.id).catch(() => console.error("[leads] could not stop lead sequences after a reply"));
  }

  const referral = parseReferral(message);
  await emitEvent(
    tenantId,
    "message.received",
    withMessageDetails(
      messageReceivedPayload({
        conversationId: conversation.id,
        channel: target.metaPhoneId ?? null,
        assignedTo: conversation.assignedToId ?? null,
        contact: { ...contact, name: name ?? contact.name ?? null },
        message: { id: wamid, type: parsed.type, text: body, mediaId: parsed.mediaId ?? null, mimeType: parsed.mediaMime ?? null, timestamp: at },
        referral,
      }),
      parsed,
    ),
  );

  if (kind !== "message") {
    if (parsed.system?.event === "number_changed") await linkChangedNumber(tenantId, conversation.id, contact, parsed.system.newWaId);
    return;
  }

  if (referral) await captureReferral(tenantId, conversation.id, referral).catch(() => console.error("[conversions] could not store a click-to-WhatsApp referral"));
  if (possibleOptOut) await notePossibleOptOut(tenantId, conversation.id);

  const reopened = await reopenOnInbound(tenantId, conversation.id, at).catch(() => false);
  wireModules();
  // messageType and replyId tell the bots, the AI agent and rules where the words came from, so they read STOP words the same way (stopSourceOf).
  const inboundInput = { tenantId, phoneNumberId: phoneRowId, conversationId: conversation.id, contactId: contact.id, text: textual ? parsed.body : "", receivedAt: at, replyId: parsed.replyId, messageType: parsed.type };
  const chatbotHandled = isStop || isStart
    ? false
    : await handleInboundForChatbots(inboundInput).catch(() => {
        console.error("[chatbot] could not run chatbots for an inbound message");
        return false;
      });
  const aiHandled =
    isStop || isStart || chatbotHandled || possibleOptOut
      ? false
      : await handleInboundForAiAgent(inboundInput).catch(() => {
          console.error("[ai-agent] could not run the AI agent for an inbound message");
          return false;
        });
  const botHandled = chatbotHandled || aiHandled;
  if (!botHandled && (reopened || !conversation.assignedToId)) {
    await assignConversation(tenantId, conversation.id).catch(() => console.error("[routing] could not assign a conversation"));
  }

  if (!isStop && !isStart && !NO_RULES_TYPES.has(parsed.type)) {
    await runAutomationsForInbound({ tenantId, phoneNumberId: phoneRowId, conversationId: conversation.id, contactId: contact.id, text: textual ? parsed.body : "", receivedAt: at, messageType: parsed.type, replyId: parsed.replyId, botHandled }).catch(() =>
      console.error("[automation] could not run automations for an inbound message"),
    );
  }
}

/**
 * Only the newest customer message moves the chat's timestamps: webhook jobs can run out of order and Meta retries, so an older
 * message handled late must not rewind the 24-hour window or the list order. The newest one sets lastMessageAt to the same time as
 * lastInboundAt, even when a business message was stored in the meantime (an auto-reply to the customer's previous message, sent
 * before this one arrived): the customer is waiting for an answer to it, and the dashboard's waiting list and the "customer has not
 * replied" rules read lastMessageAt <= lastInboundAt that way. The unread count goes up on its own. A blocked chat stores the
 * message quietly: its unread count and its place in the list stay as they are.
 */
async function touchConversation(tenantId: string, conversation: { id: string; status?: string | null }, at: Date): Promise<void> {
  const where = { id: conversation.id, tenantId };
  const blocked = conversation.status === "blocked";
  await prisma.conversation.updateMany({
    where: { ...where, OR: [{ lastInboundAt: null }, { lastInboundAt: { lt: at } }] },
    data: blocked ? { lastInboundAt: at } : { lastInboundAt: at, lastMessageAt: at },
  });
  if (!blocked) await prisma.conversation.updateMany({ where, data: { unreadCount: { increment: 1 } } });
}

const QUOTE_MAX = 60;

/** `[reaction] <emoji> to "Your order is on its way"`: the message reacted to is quoted, so the chat reads on its own. */
async function reactionBody(tenantId: string, parsed: ParsedMessage): Promise<string> {
  const target = parsed.reaction?.messageId;
  if (!target) return parsed.body;
  let quoted = "";
  try {
    const row = await prisma.message.findFirst({ where: { tenantId, wamid: target }, select: { body: true } });
    quoted = (row?.body ?? "").replace(/\s+/g, " ").trim();
  } catch {
    quoted = "";
  }
  if (!quoted) return parsed.body;
  const excerpt = quoted.length > QUOTE_MAX ? `${quoted.slice(0, QUOTE_MAX - 3).trimEnd()}...` : quoted;
  return `${parsed.body} ${parsed.reaction?.emoji ? "to" : "from"} "${excerpt}"`;
}

/** message.received carries the structured part of an order, shared contact cards or a reaction next to the readable text. */
export function withMessageDetails<T extends { message: Record<string, unknown> }>(payload: T, parsed: ParsedMessage): T {
  const details = { ...(parsed.order ? { order: parsed.order } : {}), ...(parsed.contacts ? { contacts: parsed.contacts } : {}), ...(parsed.reaction ? { reaction: parsed.reaction } : {}) };
  return Object.keys(details).length ? { ...payload, message: { ...payload.message, ...details } } : payload;
}

const SYSTEM_AUTHOR = "system";
const NUMBER_LINKED_NOTE = "The customer changed their WhatsApp number. This contact now has the new number, so your replies go there.";
const NUMBER_TAKEN_NOTE =
  "The customer changed their WhatsApp number, but another contact already has the new number, so the two were not combined. Replies from this chat still go to the old number.";

/**
 * The customer changed their WhatsApp number (system notice user_changed_number): the contact moves to the new number and keeps
 * its chats, consent and history, so their next message lands in the same chat. When another contact already holds the new number
 * the two are not combined (the number may have been someone else's before). Either way a private note tells the team; neither the
 * note nor the audit row carries a phone number, because some teammates only see masked numbers. Best effort: the notice itself is
 * already stored.
 */
async function linkChangedNumber(tenantId: string, conversationId: string, contact: { id: string; phone: string | null }, newWaId: string | null): Promise<void> {
  const next = phoneFromWaId(newWaId);
  if (!next || contact.phone === next) return;
  try {
    const holder = await prisma.contact.findFirst({ where: { tenantId, phone: next }, select: { id: true } });
    let linked = !holder || holder.id === contact.id;
    if (linked) {
      try {
        await prisma.contact.updateMany({ where: { id: contact.id, tenantId }, data: { phone: next, waId: next.slice(1) } });
      } catch (error) {
        // Another contact took the number in the meantime.
        if ((error as { code?: string }).code !== "P2002") throw error;
        linked = false;
      }
    }
    await prisma.note.create({ data: { tenantId, conversationId, authorId: SYSTEM_AUTHOR, body: linked ? NUMBER_LINKED_NOTE : NUMBER_TAKEN_NOTE } });
    await prisma.auditLog.create({ data: { tenantId, action: "contact.number_changed", target: contact.id, meta: { linked } } });
  } catch (error) {
    console.error("[webhooks] could not move a contact to their new WhatsApp number:", describeError(error));
  }
}

/**
 * Whether the whole message is a STOP word of this workspace: a default (DEFAULT_STOP_WORDS) or one the workspace added in Inbox
 * settings. The workspace's words are read only for a message short enough to be one, and an unreadable setting means defaults only.
 * `source` is where the words came from: on a template button, cancel, end and quit do not count (stopSourceOf).
 */
export async function isWorkspaceStop(tenantId: string, body: string, source: StopSource = "typed"): Promise<boolean> {
  if (isStopMessage(body, [], source)) return true;
  if (source === "tapped_choice" || !mightBeStopWord(body)) return false;
  try {
    const settings = await getInboxSettings(tenantId);
    return isStopMessage(body, settings?.stopWords, source);
  } catch {
    return false;
  }
}

/**
 * A private note on the chat for a message that may be an opt-out request but is not a STOP word ("stop please"). Best effort: the
 * message itself is already stored.
 */
async function notePossibleOptOut(tenantId: string, conversationId: string): Promise<void> {
  try {
    await prisma.note.create({ data: { tenantId, conversationId, authorId: SYSTEM_AUTHOR, body: POSSIBLE_OPT_OUT_NOTE } });
  } catch (error) {
    console.error("[inbox] could not add the possible opt-out note:", describeError(error));
  }
}

/**
 * An opt-out stops marketing only (src/lib/contacts/opt-out.ts): order updates, login codes and replies to the customer's own
 * messages still go. optIn is cleared because the marketing consent is withdrawn; only START (or a new message) brings offers back.
 */
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
 * After REINSTATED, UNPAUSE or UNARCHIVED, reads the template back from Meta so its status and category match what Meta now says
 * (6.3 "plus a template re-sync"). Best effort: returns the status read back, or null when there was none or Meta could not be
 * reached (the event's own status, if any, was already stored).
 */
async function resyncTemplate(tenantId: string, template: { id: string; metaTemplateId?: string | null } | null): Promise<string | null> {
  if (!template?.metaTemplateId) return null;
  try {
    const t = await graphFetch<{ status?: string; category?: string }>({ tenantId, path: template.metaTemplateId, query: { fields: "status,category" } });
    const status = t.status ? mapMetaStatus(t.status) : null;
    await prisma.template.updateMany({
      where: { id: template.id, tenantId },
      data: { ...(status ? { status } : {}), ...(t.category ? { category: String(t.category).toUpperCase() } : {}) },
    });
    return status;
  } catch (error) {
    console.warn("[webhooks] could not re-read a reinstated or unarchived template from Meta:", describeError(error));
    return null;
  }
}

/** UNARCHIVED: the template is read back from Meta, and template.status goes out once the restored status is known. */
async function restoreUnarchived(tenantId: string, where: { tenantId: string; wabaRefId: string }, v: Rec): Promise<Outcome> {
  const known = await knownTemplate(where, v);
  const status = await resyncTemplate(tenantId, known);
  if (!status) return { tenantId };
  await emitEvent(
    tenantId,
    "template.status",
    templateStatusPayload({
      templateId: known?.id ?? null,
      name: str(v.message_template_name) ?? null,
      language: str(v.message_template_language) ?? null,
      category: known?.category?.toLowerCase() ?? null,
      status,
      reason: null,
      timestamp: new Date(),
    }),
  );
  return { tenantId };
}

async function processTemplateStatus(change: Change): Promise<Outcome> {
  const waba = await resolveWaba(change.wabaId);
  if (!waba) return { note: `unknown waba ${change.wabaId ?? "(missing)"}` };
  const v = change.value;
  const event = (str(v.event) ?? "").toUpperCase();
  const where = { tenantId: waba.tenantId, wabaRefId: waba.id };
  if (event === LOCKED_EVENT) return { tenantId: waba.tenantId };
  if (event === UNARCHIVED_EVENT) return restoreUnarchived(waba.tenantId, where, v);
  let status = TEMPLATE_EVENTS[event];
  if (!status) return { tenantId: waba.tenantId, note: `unhandled template event ${str(v.event)}` };

  const reason = str(v.reason);
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
