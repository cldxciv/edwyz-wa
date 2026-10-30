import type { Contact, Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import type { NormalizedIdentity } from "./identity";

type Tx = Prisma.TransactionClient;

export type InboundIdentity = NormalizedIdentity & { name?: string | null };

const MAX_PREVIOUS_BSUIDS = 5;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const later = (a: Date | null, b: Date | null) => (a && b ? (a > b ? a : b) : (a ?? b));
const earlier = (a: Date | null, b: Date | null) => (a && b ? (a < b ? a : b) : (a ?? b));
const union = (a: string[], b: string[]) => Array.from(new Set([...a, ...b]));

/** Consent after combining two records: the most recent decision wins, and a STOP is never lost to an older opt-in. */
export function mergeConsent(a: Pick<Contact, "optIn" | "optInAt" | "optedOutAt" | "optInSource">, b: Pick<Contact, "optIn" | "optInAt" | "optedOutAt" | "optInSource">) {
  const optedOutAt = later(a.optedOutAt, b.optedOutAt);
  const optInAt = later(a.optIn ? a.optInAt : null, b.optIn ? b.optInAt : null);
  const anyOptIn = a.optIn || b.optIn;
  const optedOut = !!optedOutAt && (!optInAt || optedOutAt >= optInAt);
  const source = (a.optIn ? a.optInSource : null) ?? (b.optIn ? b.optInSource : null) ?? null;
  return { optedOutAt: optedOut ? optedOutAt : null, optIn: anyOptIn && !optedOut, optInAt: optInAt ?? null, optInSource: source };
}

/** Existing values win; the other record only fills gaps. */
export function mergeAttributes(keep: unknown, other: unknown): Record<string, unknown> {
  return { ...(isObject(other) ? other : {}), ...(isObject(keep) ? keep : {}) };
}

async function moveConversation(tx: Tx, tenantId: string, from: { id: string }, to: { id: string }) {
  const where = { conversationId: from.id, tenantId };
  await tx.message.updateMany({ where, data: { conversationId: to.id } });
  await tx.note.updateMany({ where, data: { conversationId: to.id } });
  await tx.chatbotSession.updateMany({ where, data: { conversationId: to.id } });
  await tx.ruleExecution.updateMany({ where, data: { conversationId: to.id } });
  await tx.automationRun.updateMany({ where: { conversationId: from.id }, data: { conversationId: to.id } });

  const existing = await tx.conversationMark.findMany({ where: { conversationId: to.id }, select: { userId: true, kind: true } });
  const have = new Set(existing.map((m) => `${m.userId}:${m.kind}`));
  const marks = await tx.conversationMark.findMany({ where: { conversationId: from.id }, select: { id: true, userId: true, kind: true } });
  for (const m of marks) {
    if (have.has(`${m.userId}:${m.kind}`)) await tx.conversationMark.deleteMany({ where: { id: m.id } });
    else await tx.conversationMark.updateMany({ where: { id: m.id }, data: { conversationId: to.id } });
  }
}

async function mergeConversations(tx: Tx, tenantId: string, source: Contact, target: Contact) {
  const mine = await tx.conversation.findMany({ where: { tenantId, contactId: source.id } });
  for (const conv of mine) {
    const twin = await tx.conversation.findFirst({ where: { tenantId, contactId: target.id, phoneNumberId: conv.phoneNumberId } });
    if (!twin) {
      await tx.conversation.updateMany({ where: { id: conv.id, tenantId }, data: { contactId: target.id } });
      continue;
    }
    await moveConversation(tx, tenantId, conv, twin);
    await tx.conversation.updateMany({
      where: { id: twin.id, tenantId },
      data: {
        tags: union(twin.tags, conv.tags),
        unreadCount: twin.unreadCount + conv.unreadCount,
        lastMessageAt: later(twin.lastMessageAt, conv.lastMessageAt) ?? twin.lastMessageAt,
        lastInboundAt: later(twin.lastInboundAt, conv.lastInboundAt),
        firstAgentReplyAt: earlier(twin.firstAgentReplyAt, conv.firstAgentReplyAt),
        lastAgentReplyAt: later(twin.lastAgentReplyAt, conv.lastAgentReplyAt),
        referral: (twin.referral ?? conv.referral ?? undefined) as Prisma.InputJsonValue | undefined,
        assignedToId: twin.assignedToId ?? conv.assignedToId,
        teamId: twin.teamId ?? conv.teamId,
        ...(twin.status !== "open" && conv.status === "open" ? { status: "open" as const } : {}),
      },
    });
    await tx.conversation.deleteMany({ where: { id: conv.id, tenantId } });
  }
}

async function mergeRecipients(tx: Tx, tenantId: string, sourceId: string, targetId: string) {
  const theirs = await tx.broadcastRecipient.findMany({ where: { tenantId, contactId: targetId }, select: { broadcastId: true } });
  const taken = theirs.map((r) => r.broadcastId);
  if (taken.length) await tx.broadcastRecipient.deleteMany({ where: { tenantId, contactId: sourceId, broadcastId: { in: taken } } });
  await tx.broadcastRecipient.updateMany({ where: { tenantId, contactId: sourceId }, data: { contactId: targetId } });
}

/**
 * A phone number has arrived for a person we only knew by BSUID, and we already hold a contact for that phone. Everything the BSUID
 * contact owns moves onto the phone contact (first-seen phone kept), then the BSUID contact is removed. One transaction: either the
 * whole merge happens or none of it. Returns the surviving contact.
 */
export async function mergeContacts(tenantId: string, sourceId: string, targetId: string, extra: Prisma.ContactUpdateInput = {}): Promise<Contact> {
  return prisma.$transaction(async (tx) => {
    const [source, target] = await Promise.all([tx.contact.findFirst({ where: { id: sourceId, tenantId } }), tx.contact.findFirst({ where: { id: targetId, tenantId } })]);
    if (!source || !target) throw new Error("contact to merge not found");

    await mergeConversations(tx, tenantId, source, target);
    await mergeRecipients(tx, tenantId, source.id, target.id);
    await tx.lead.updateMany({ where: { tenantId, contactId: source.id }, data: { contactId: target.id } });
    await tx.conversionEvent.updateMany({ where: { tenantId, contactId: source.id }, data: { contactId: target.id } });
    await tx.abandonedCart.updateMany({ where: { tenantId, contactId: source.id }, data: { contactId: target.id } });
    await tx.chatbotSession.updateMany({ where: { tenantId, contactId: source.id }, data: { contactId: target.id } });
    await tx.ruleExecution.updateMany({ where: { tenantId, contactId: source.id }, data: { contactId: target.id } });

    const consent = mergeConsent(target, source);
    await tx.contact.deleteMany({ where: { id: source.id, tenantId } });
    return tx.contact.update({
      where: { id: target.id },
      data: {
        name: target.name ?? source.name,
        tags: union(target.tags, source.tags),
        attributes: mergeAttributes(target.attributes, source.attributes) as Prisma.InputJsonValue,
        bsuid: source.bsuid ?? target.bsuid,
        username: source.username ?? target.username,
        waId: target.waId ?? source.waId,
        ownerUserId: target.ownerUserId ?? source.ownerUserId,
        leadStage: target.leadStage ?? source.leadStage,
        ...consent,
        ...extra,
      },
    });
  });
}

type Found = { byPhone: Contact | null; byBsuid: Contact | null };

async function find(tenantId: string, id: InboundIdentity): Promise<Found> {
  const [byPhone, byBsuid] = await Promise.all([
    id.phone ? prisma.contact.findFirst({ where: { tenantId, phone: id.phone } }) : null,
    id.bsuid ? prisma.contact.findFirst({ where: { tenantId, bsuid: id.bsuid } }) : null,
  ]);
  return { byPhone, byBsuid };
}

function previousBsuids(contact: Contact, next: string | null) {
  if (!contact.bsuid || contact.bsuid === next) return undefined;
  const attrs = isObject(contact.attributes) ? contact.attributes : {};
  const prior = Array.isArray(attrs.previous_bsuids) ? (attrs.previous_bsuids as unknown[]).filter((v): v is string => typeof v === "string") : [];
  return { ...attrs, previous_bsuids: union([contact.bsuid], prior).slice(0, MAX_PREVIOUS_BSUIDS) } as Prisma.InputJsonValue;
}

function updateFor(contact: Contact, id: InboundIdentity): Prisma.ContactUpdateInput {
  const data: Prisma.ContactUpdateInput = {};
  if (id.name && id.name !== contact.name) data.name = id.name;
  if (id.username && id.username !== contact.username) data.username = id.username;
  if (id.waId && !contact.waId) data.waId = id.waId;
  if (id.phone && !contact.phone) data.phone = id.phone;
  if (id.bsuid && id.bsuid !== contact.bsuid) {
    data.bsuid = id.bsuid;
    const attributes = previousBsuids(contact, id.bsuid);
    if (attributes) data.attributes = attributes;
  }
  return data;
}

/**
 * Finds or creates the contact for an inbound message and keeps identifiers in step.
 * - phone known: the contact with that phone (or a BSUID-only one with the same BSUID, which then gains the phone)
 * - phone and BSUID both known and they belong to two different contacts: merged, the phone contact survives with its first-seen phone
 * - only a BSUID: the contact with that BSUID, created when new
 * A message is never dropped for lack of a phone. Returns null only when the payload carried no usable identifier at all.
 */
export async function resolveInboundContact(tenantId: string, id: InboundIdentity): Promise<Contact | null> {
  if (!id.phone && !id.bsuid) return null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await resolveOnce(tenantId, id);
    } catch (error) {
      if ((error as { code?: string }).code !== "P2002" || attempt === 1) throw error;
    }
  }
  return null;
}

async function resolveOnce(tenantId: string, id: InboundIdentity): Promise<Contact> {
  const { byPhone, byBsuid } = await find(tenantId, id);

  if (byPhone && byBsuid && byPhone.id !== byBsuid.id) {
    const history = previousBsuids(byPhone, id.bsuid);
    return mergeContacts(tenantId, byBsuid.id, byPhone.id, { ...updateFor(byPhone, { ...id, bsuid: null }), bsuid: id.bsuid, ...(history ? { attributes: mergeAttributes(history, byBsuid.attributes) as Prisma.InputJsonValue } : {}) });
  }

  const existing = byPhone ?? byBsuid;
  if (!existing) {
    return prisma.contact.create({ data: { tenantId, phone: id.phone, bsuid: id.bsuid, username: id.username, waId: id.waId, name: id.name ?? null } });
  }
  const data = updateFor(existing, id);
  if (Object.keys(data).length === 0) return existing;
  return prisma.contact.update({ where: { id: existing.id }, data });
}

/**
 * A delivery status named a recipient by phone, BSUID or both. If the message's contact lacks one of them, store it; if the other
 * identifier already belongs to a different contact, merge. Best effort: failures are swallowed by the caller.
 */
export async function learnIdentityFromStatus(tenantId: string, contactId: string, id: InboundIdentity): Promise<void> {
  if (!id.phone && !id.bsuid) return;
  const contact = await prisma.contact.findFirst({ where: { id: contactId, tenantId } });
  if (!contact) return;
  const missingPhone = !!id.phone && !contact.phone;
  const missingBsuid = !!id.bsuid && !contact.bsuid;
  if (!missingPhone && !missingBsuid) return;
  await resolveInboundContact(tenantId, { phone: missingPhone ? id.phone : contact.phone, bsuid: missingBsuid ? id.bsuid : contact.bsuid, waId: id.waId, username: id.username, name: null });
}
