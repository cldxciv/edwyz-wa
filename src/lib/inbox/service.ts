import { emitTagChanges } from "@/lib/automation/v2/emit";
import { prisma } from "@/lib/db";
import { enqueue } from "@/lib/queue";
import { stopBotsOnHumanReply } from "@/lib/chatbots/human-reply";
import { applyAssignment } from "@/lib/routing";
import { templateBlockedFor } from "@/lib/contacts/identity";
import { mayReceive, OPTED_OUT_OF_MARKETING, sendKindForCategory } from "@/lib/contacts/opt-out";
import { categoryForSend, DEFAULT_ORIGIN, FREE_FORM_CATEGORY, type OriginField, type PricingCategory } from "@/lib/spend/messaging/origin";
import { HttpError } from "@/lib/tenancy";
import { clearReadMarks, notifyMentions } from "./marks";
import { isWithinServiceWindow } from "./window";

export const CONVERSATION_STATUSES = ["open", "pending", "solved", "blocked"] as const;
export const MEDIA_TYPES = ["image", "document", "audio", "video", "sticker"] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];

const WINDOW_MESSAGE = "The 24-hour customer service window is closed. Send an approved template message instead.";
const clampLimit = (limit: number | undefined, fallback = 30) => Math.min(Math.max(Math.trunc(limit ?? fallback), 1), 100);

export { listConversations, type ListConversationsParams } from "./list";

async function requireConversation(tenantId: string, id: string) {
  const conversation = await prisma.conversation.findFirst({ where: { id, tenantId } });
  if (!conversation) throw new HttpError(404, "Conversation not found.");
  return conversation;
}

/** Messages are returned newest first; pass nextCursor to load older ones. */
export async function getConversation(tenantId: string, id: string, opts: { cursor?: string; limit?: number } = {}) {
  const conversation = await prisma.conversation.findFirst({
    where: { id, tenantId },
    // wabaRefId lets the inbox offer only templates this number's WhatsApp Business Account can send.
    include: { contact: true, phoneNumber: { select: { id: true, displayPhone: true, verifiedName: true, wabaRefId: true } } },
  });
  if (!conversation) throw new HttpError(404, "Conversation not found.");
  const limit = clampLimit(opts.limit, 50);
  const cursor = opts.cursor && (await prisma.message.findFirst({ where: { id: opts.cursor, tenantId, conversationId: id }, select: { id: true } })) ? opts.cursor : undefined;
  const rows = await prisma.message.findMany({
    where: { tenantId, conversationId: id },
    // The spend gate's cost columns are BigInt, which Response.json cannot serialize: every chat with a sent message answered 500.
    omit: { estCostMinor: true, costMinor: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  const messages = rows.slice(0, limit);
  return {
    conversation,
    windowOpen: isWithinServiceWindow(conversation.lastInboundAt),
    messages,
    nextCursor: rows.length > limit ? messages[messages.length - 1].id : null,
  };
}

/**
 * source marks where the send came from (for example "admin_test"); it is kept on the first statusTimeline entry since Message has no
 * meta column. origin (docs/SPEND-CONTROLS-SPEC.md 4.9) says who is sending, for the spend controls' send gate; an unstamped caller
 * gets "unknown", which the gate treats as automated.
 */
type SendBase = { tenantId: string; conversationId: string; userId?: string; source?: string } & OriginField;

/** What the send gate needs to know about a queued message, stamped on the job and the Message row (4.9). */
type SpendStamp = { category: PricingCategory; wabaRefId: string | null; reservationId?: string };

async function queueOutbound(
  base: SendBase,
  data: { type: string; body: string | null; mediaUrl?: string; mediaMime?: string; templateName?: string },
  job: Record<string, unknown> = {},
  stamp: SpendStamp = { category: FREE_FORM_CATEGORY, wabaRefId: null },
) {
  const origin = base.origin ?? DEFAULT_ORIGIN;
  const message = await prisma.message.create({
    data: {
      tenantId: base.tenantId,
      conversationId: base.conversationId,
      direction: "outbound",
      status: "queued",
      statusTimeline: [{ status: "queued", at: new Date().toISOString(), ...(base.source ? { source: base.source } : {}) }],
      sentByUserId: base.userId ?? null,
      origin,
      pricingCategory: stamp.category,
      ...data,
    },
  });
  const now = new Date();
  await prisma.conversation.updateMany({ where: { id: base.conversationId, tenantId: base.tenantId }, data: { lastMessageAt: now, ...(base.userId ? { lastAgentReplyAt: now } : {}) } });
  if (base.userId) await prisma.conversation.updateMany({ where: { id: base.conversationId, tenantId: base.tenantId, firstAgentReplyAt: null }, data: { firstAgentReplyAt: now } });
  if (base.userId) await stopBotsOnHumanReply(base.tenantId, base.conversationId);
  await enqueue("send", {
    messageId: message.id,
    tenantId: base.tenantId,
    ...job,
    origin,
    category: stamp.category,
    wabaRefId: stamp.wabaRefId,
    ...(stamp.reservationId ? { reservationId: stamp.reservationId } : {}),
  });
  return message;
}

async function requireOpenWindow(tenantId: string, conversationId: string) {
  const conversation = await requireConversation(tenantId, conversationId);
  if (!isWithinServiceWindow(conversation.lastInboundAt)) throw new HttpError(409, WINDOW_MESSAGE);
  return conversation;
}

/** signature (the agent's name, when the workspace turned that on) is added in front of the text when the message is sent, not stored in it. */
export async function sendText(input: SendBase & { body: string; signature?: string }) {
  const body = input.body.trim();
  if (!body) throw new HttpError(400, "Message text is required.");
  await requireOpenWindow(input.tenantId, input.conversationId);
  return queueOutbound(input, { type: "text", body }, input.signature ? { signature: input.signature } : {});
}

/** media is a Meta media id (stored as meta-media:<id>) or an https link. Audio and stickers cannot carry a caption. */
export async function sendMedia(input: SendBase & { mediaType: MediaType; media: string; caption?: string; filename?: string; mime?: string }) {
  await requireOpenWindow(input.tenantId, input.conversationId);
  const caption = input.mediaType === "audio" || input.mediaType === "sticker" ? null : input.caption?.trim() || null;
  return queueOutbound(
    input,
    { type: input.mediaType, body: caption, mediaUrl: input.media, mediaMime: input.mime },
    input.filename ? { filename: input.filename } : {},
  );
}

export type SendTemplateInput = {
  tenantId: string;
  /** PhoneNumber.id (our row id, the same value stored in Conversation.phoneNumberId), not Meta's phone_number_id. */
  phoneNumberId: string;
  contactId: string;
  templateName: string;
  language: string;
  components?: unknown[];
  conversationId?: string;
  userId?: string;
  source?: string;
  /** A bulk send's SpendReservation (broadcast, automation run, API batch): the gate consumes this message's estimate from it. */
  reservationId?: string;
} & OriginField;

/**
 * Allowed at any time (inside or outside the 24-hour window). Creates the conversation when needed and queues the send job.
 * Consent is enforced here for every caller: a contact who opted out never receives a marketing template (lib/contacts/opt-out.ts),
 * and a template whose category is MARKETING needs a recorded opt-in. A template the workspace has no row for might be marketing, so it also needs the opt-in.
 * The job and the Message carry the origin, the pricing category (by the number's WABA) and a bulk send's reservation (4.9).
 */
export async function sendTemplateMessage(input: SendTemplateInput) {
  const { tenantId } = input;
  const [phone, contact] = await Promise.all([
    prisma.phoneNumber.findFirst({ where: { id: input.phoneNumberId, tenantId }, select: { id: true, wabaRefId: true } }),
    prisma.contact.findFirst({ where: { id: input.contactId, tenantId }, select: { id: true, optIn: true, optedOutAt: true, phone: true, bsuid: true } }),
  ]);
  if (!phone) throw new HttpError(404, "Phone number not found.");
  if (!contact) throw new HttpError(404, "Contact not found.");
  const templateCategory = await assertMayReceiveTemplate(tenantId, phone.wabaRefId, contact, input.templateName, input.language);

  const conversationId = input.conversationId
    ? (await requireConversation(tenantId, input.conversationId)).id
    : (
        await prisma.conversation.upsert({
          where: { phoneNumberId_contactId: { phoneNumberId: phone.id, contactId: contact.id } },
          create: { tenantId, phoneNumberId: phone.id, contactId: contact.id },
          update: {},
        })
      ).id;

  return queueOutbound(
    { tenantId, conversationId, userId: input.userId, source: input.source, origin: input.origin },
    { type: "template", body: `[template] ${input.templateName}`, templateName: input.templateName },
    { template: { name: input.templateName, language: input.language, components: input.components ?? [] } },
    { category: categoryForSend("template", templateCategory), wabaRefId: phone.wabaRefId ?? null, ...(input.reservationId ? { reservationId: input.reservationId } : {}) },
  );
}

/**
 * The one place that decides whether a template may go to a contact. Fails closed: a template this workspace has no row for (not
 * synced yet, or synced only under another WhatsApp Business Account) is treated as marketing, so it needs the contact's opt-in.
 * Only a template known to be utility or authentication reaches a contact who has not opted in, or who opted out (an opt-out stops
 * marketing only, and an unknown template counts as marketing).
 * Returns the category the send is priced at (docs/SPEND-CONTROLS-SPEC.md 4.9): the template's row under the sending number's
 * own WABA, or null when that WABA has no row (priced as MARKETING). A row found only under another WABA of the workspace still
 * decides consent, the stricter way, but never prices the send.
 */
async function assertMayReceiveTemplate(
  tenantId: string,
  wabaRefId: string | undefined,
  contact: { optIn?: boolean; optedOutAt?: Date | null; phone?: string | null; bsuid?: string | null },
  name: string,
  language: string,
): Promise<string | null> {
  const own = await prisma.template.findFirst({ where: { tenantId, name, language, ...(wabaRefId ? { wabaRefId } : {}) }, select: { category: true } });
  const template = own ?? (wabaRefId ? await prisma.template.findFirst({ where: { tenantId, name, language }, select: { category: true } }) : null);
  if (!mayReceive(contact, sendKindForCategory(template?.category))) throw new HttpError(422, OPTED_OUT_OF_MARKETING);
  const blocked = templateBlockedFor(template?.category, contact);
  if (blocked) throw new HttpError(422, blocked);
  const category = template?.category?.toUpperCase();
  const pricedAt = own?.category ?? null;
  if (contact.optIn) return pricedAt;
  if (!template) {
    throw new HttpError(422, "This template is not in your synced template list, so it is treated as a marketing message and this contact has not opted in. Sync your templates or record their opt-in first.");
  }
  if (category === "MARKETING") {
    throw new HttpError(422, "This contact has not opted in to marketing messages. Use a utility template or record their opt-in first.");
  }
  return pricedAt;
}

/** Resets the shared unread counter. With userId, the agent's own "marked as unread" flag and mention notice for the chat are cleared too. */
export async function markRead(tenantId: string, id: string, userId?: string) {
  const { count } = await prisma.conversation.updateMany({ where: { id, tenantId }, data: { unreadCount: 0 } });
  if (count === 0) throw new HttpError(404, "Conversation not found.");
  if (userId) await clearReadMarks(tenantId, userId, id);
}

/**
 * Assignment for callers that act for the workspace rather than a member (the API and the workspace MCP server). It goes through
 * the same checks and write as every manual assignment (lib/routing applyAssignment): a member whose account is not disabled,
 * inside the chat's team, recorded for round-robin and in the audit log.
 */
export async function assign(tenantId: string, id: string, userId: string | null) {
  const chat = await prisma.conversation.findFirst({ where: { id, tenantId }, select: { id: true, assignedToId: true, teamId: true } });
  if (!chat) throw new HttpError(404, "Conversation not found.");
  await applyAssignment({ tenantId }, chat, userId);
  return prisma.conversation.findFirst({ where: { id, tenantId } });
}

export async function setTags(tenantId: string, id: string, tags: string[]) {
  const before = await prisma.conversation.findFirst({ where: { id, tenantId }, select: { contactId: true, tags: true } });
  const row = await updateConversation(tenantId, id, { tags: [...new Set(tags.map((t) => t.trim()).filter(Boolean))] });
  if (before && row) void emitTagChanges({ tenantId, contactId: before.contactId, conversationId: id }, before.tags, row.tags);
  return row;
}

export async function setStatus(tenantId: string, id: string, status: string) {
  if (!(CONVERSATION_STATUSES as readonly string[]).includes(status)) throw new HttpError(400, "Invalid status.");
  return updateConversation(tenantId, id, { status });
}

async function updateConversation(tenantId: string, id: string, data: Record<string, unknown>) {
  const { count } = await prisma.conversation.updateMany({ where: { id, tenantId }, data });
  if (count === 0) throw new HttpError(404, "Conversation not found.");
  return prisma.conversation.findFirst({ where: { id, tenantId } });
}

export async function addNote(tenantId: string, id: string, authorId: string, body: string) {
  const text = body.trim();
  if (!text) throw new HttpError(400, "Note text is required.");
  await requireConversation(tenantId, id);
  const note = await prisma.note.create({ data: { tenantId, conversationId: id, authorId, body: text } });
  await notifyMentions(tenantId, authorId, id, text).catch(() => console.error("[inbox] could not record note mentions"));
  return note;
}

export async function listNotes(tenantId: string, id: string) {
  await requireConversation(tenantId, id);
  return prisma.note.findMany({ where: { tenantId, conversationId: id }, orderBy: { createdAt: "desc" } });
}

export async function listQuickReplies(tenantId: string) {
  return prisma.quickReply.findMany({ where: { tenantId }, orderBy: { shortcut: "asc" } });
}

function normalizeShortcut(shortcut: string) {
  const value = shortcut.trim().replace(/^\//, "").toLowerCase();
  if (!/^[a-z0-9_-]{1,32}$/.test(value)) throw new HttpError(400, "Shortcut must be 1-32 letters, numbers, dashes or underscores.");
  return value;
}

const isUniqueViolation = (e: unknown) => (e as { code?: string })?.code === "P2002";

export async function createQuickReply(tenantId: string, input: { shortcut: string; body: string }) {
  const body = input.body.trim();
  if (!body) throw new HttpError(400, "Quick reply text is required.");
  try {
    return await prisma.quickReply.create({ data: { tenantId, shortcut: normalizeShortcut(input.shortcut), body } });
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, "That shortcut already exists.");
    throw e;
  }
}

export async function updateQuickReply(tenantId: string, id: string, input: { shortcut?: string; body?: string }) {
  const data: { shortcut?: string; body?: string } = {};
  if (input.shortcut !== undefined) data.shortcut = normalizeShortcut(input.shortcut);
  if (input.body !== undefined) {
    if (!input.body.trim()) throw new HttpError(400, "Quick reply text is required.");
    data.body = input.body.trim();
  }
  try {
    const { count } = await prisma.quickReply.updateMany({ where: { id, tenantId }, data });
    if (count === 0) throw new HttpError(404, "Quick reply not found.");
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, "That shortcut already exists.");
    throw e;
  }
  return prisma.quickReply.findFirst({ where: { id, tenantId } });
}

export async function deleteQuickReply(tenantId: string, id: string) {
  const { count } = await prisma.quickReply.deleteMany({ where: { id, tenantId } });
  if (count === 0) throw new HttpError(404, "Quick reply not found.");
}
