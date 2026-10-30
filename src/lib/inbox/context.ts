import { prisma } from "@/lib/db";
import { maskLeadFields } from "@/lib/teams/visibility";
import { HttpError } from "@/lib/tenancy";

const MAX_LEAD_FIELDS = 8;
const MAX_FIELD_CHARS = 200;
const HISTORY_LIMIT = 10;

/** Lead form answers as short label/value pairs; anything that is not a short scalar is dropped. */
export function summarizeLeadFields(fields: unknown): { label: string; value: string }[] {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return [];
  const out: { label: string; value: string }[] = [];
  for (const [key, raw] of Object.entries(fields as Record<string, unknown>)) {
    if (typeof raw !== "string" && typeof raw !== "number") continue;
    const value = String(raw).trim().slice(0, MAX_FIELD_CHARS);
    if (!value) continue;
    out.push({ label: key.replace(/[_-]+/g, " ").trim().slice(0, 40), value });
    if (out.length === MAX_LEAD_FIELDS) break;
  }
  return out;
}

export type ConversationContext = {
  lead: null | {
    id: string;
    status: string;
    createdAt: Date;
    formName: string | null;
    adMetaId: string | null;
    campaignMetaId: string | null;
    consentAt: Date | null;
    assignedToId: string | null;
    fields: { label: string; value: string }[];
  };
  stats: { messages: number; received: number; firstContactAt: Date };
  otherChats: { id: string; status: string; lastMessageAt: Date; unreadCount: number; number: string | null }[];
};

/** Everything here is read with the caller's tenantId; the conversation decides which contact is meant. */
export async function getConversationContext(tenantId: string, conversationId: string, viewer: { scope?: Record<string, unknown> | null; maskPhone?: boolean } = {}): Promise<ConversationContext> {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, tenantId },
    select: { id: true, contactId: true, contact: { select: { createdAt: true } } },
  });
  if (!conversation) throw new HttpError(404, "Conversation not found.");

  const [lead, messages, received, others] = await Promise.all([
    prisma.lead.findFirst({
      where: { tenantId, contactId: conversation.contactId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        status: true,
        createdAt: true,
        fields: true,
        adMetaId: true,
        campaignMetaId: true,
        consentAt: true,
        assignedToId: true,
        leadForm: { select: { name: true } },
      },
    }),
    prisma.message.count({ where: { tenantId, conversationId } }),
    prisma.message.count({ where: { tenantId, conversationId, direction: "inbound" } }),
    prisma.conversation.findMany({
      where: { tenantId, contactId: conversation.contactId, id: { not: conversationId }, ...(viewer.scope ?? {}) },
      orderBy: { lastMessageAt: "desc" },
      take: HISTORY_LIMIT,
      select: { id: true, status: true, lastMessageAt: true, unreadCount: true, phoneNumber: { select: { displayPhone: true } } },
    }),
  ]);

  return {
    lead: lead && {
      id: lead.id,
      status: lead.status,
      createdAt: lead.createdAt,
      formName: lead.leadForm?.name ?? null,
      adMetaId: lead.adMetaId,
      campaignMetaId: lead.campaignMetaId,
      consentAt: lead.consentAt,
      assignedToId: lead.assignedToId,
      fields: maskLeadFields(summarizeLeadFields(lead.fields), viewer.maskPhone === true),
    },
    stats: { messages, received, firstContactAt: conversation.contact.createdAt },
    otherChats: others.map((o) => ({ id: o.id, status: o.status, lastMessageAt: o.lastMessageAt, unreadCount: o.unreadCount, number: o.phoneNumber.displayPhone })),
  };
}
