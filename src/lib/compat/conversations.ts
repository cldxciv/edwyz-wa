import type { Prisma } from "@/generated/prisma/client";
import { audit } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { assign, CONVERSATION_STATUSES, setTags } from "@/lib/inbox/service";
import { setStatus } from "@/lib/inbox/status";
import { isWithinServiceWindow } from "@/lib/inbox/window";
import { type Actor, HttpError } from "@/lib/tenancy";
import { contactView, isObject, iso, pageJson, parsePaging, requireContact, resolveTarget } from "./common";
import type { Handler } from "./runtime";

type ConversationRow = Prisma.ConversationGetPayload<{ include: { contact: true } }>;

export function conversationView(c: ConversationRow) {
  return {
    id: c.id,
    status: c.status,
    tags: c.tags,
    unread_count: c.unreadCount,
    assigned_to: c.assignedToId ?? null,
    team_id: c.teamId ?? null,
    window_open: isWithinServiceWindow(c.lastInboundAt),
    last_message_at: iso(c.lastMessageAt),
    last_inbound_at: iso(c.lastInboundAt),
    first_agent_reply_at: iso(c.firstAgentReplyAt),
    last_agent_reply_at: iso(c.lastAgentReplyAt),
    created: iso(c.createdAt),
    contact: contactView(c.contact),
  };
}

/**
 * A key with the conversations:write scope is an integration credential created by an admin, so its changes are not held to the
 * per-agent "only your own chats" rule. The scope is what grants the access, not the role of the person who made the key.
 */
export const managerOf = (actor: Actor): Actor => ({ ...actor, role: "admin" });

/** The conversation a path target names: a conversation id, or the most recently active conversation of a contact. */
export async function requireConversation(tenantId: string, target: string): Promise<ConversationRow> {
  const resolved = await resolveTarget(tenantId, target);
  const where: Prisma.ConversationWhereInput = resolved.conversationId
    ? { id: resolved.conversationId, tenantId }
    : resolved.contact
      ? { tenantId, contactId: resolved.contact.id }
      : { id: "" };
  const found = await prisma.conversation.findFirst({ where, include: { contact: true }, orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }] });
  if (!found) throw new HttpError(404, "Conversation not found.");
  return found;
}

async function reload(tenantId: string, id: string) {
  const row = await prisma.conversation.findFirst({ where: { id, tenantId }, include: { contact: true } });
  if (!row) throw new HttpError(404, "Conversation not found.");
  return { json: { conversation: conversationView(row) } };
}

export const listConversations: Handler = async ({ actor, query }) => {
  const paging = parsePaging(query);
  const where: Prisma.ConversationWhereInput = { tenantId: actor.tenantId };
  const status = query.get("status");
  if (status) {
    if (!(CONVERSATION_STATUSES as readonly string[]).includes(status)) throw new HttpError(400, "status must be open, pending, solved or blocked.");
    where.status = status;
  }
  const target = query.get("target");
  if (target) where.contactId = (await requireContact(actor.tenantId, target)).id;
  const [rows, total] = await Promise.all([
    prisma.conversation.findMany({ where, include: { contact: true }, orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }], skip: paging.skip, take: paging.take }),
    prisma.conversation.count({ where }),
  ]);
  return { json: pageJson("conversation_list", rows.map(conversationView), paging, total) };
};

export const getConversation: Handler = async ({ actor, params }) => ({ json: { conversation: conversationView(await requireConversation(actor.tenantId, params.target)) } });

export const setConversationStatus: Handler = async ({ actor, params, body }) => {
  const input = await body();
  if (typeof input.status !== "string") throw new HttpError(400, "status is required.");
  const conversation = await requireConversation(actor.tenantId, params.target);
  await setStatus(managerOf(actor), conversation.id, input.status);
  return reload(actor.tenantId, conversation.id);
};

export const assignConversation: Handler = async ({ actor, params, body }) => {
  const input = await body();
  if (!("user_id" in input) || (input.user_id !== null && (typeof input.user_id !== "string" || !input.user_id || input.user_id.length > 64))) {
    throw new HttpError(400, "user_id must be the id of a workspace member, or null to unassign.");
  }
  const conversation = await requireConversation(actor.tenantId, params.target);
  await assign(actor.tenantId, conversation.id, input.user_id as string | null);
  await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "compat.conversation.assigned", target: conversation.id });
  return reload(actor.tenantId, conversation.id);
};

const MAX_TAGS = 50;
const MAX_TAG_LENGTH = 40;

function cleanTags(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 10 || value.some((t) => typeof t !== "string" || !t.trim() || t.trim().length > MAX_TAG_LENGTH)) {
    throw new HttpError(400, `tags must be 1 to 10 tags of up to ${MAX_TAG_LENGTH} characters.`);
  }
  return [...new Set((value as string[]).map((t) => t.trim()))];
}

export const addConversationTags: Handler = async ({ actor, params, body }) => {
  const input = await body();
  if (!isObject(input)) throw new HttpError(400, "tags is required.");
  const add = cleanTags(input.tags);
  const conversation = await requireConversation(actor.tenantId, params.target);
  const next = [...new Set([...conversation.tags, ...add])];
  if (next.length > MAX_TAGS) throw new HttpError(400, `A conversation can carry up to ${MAX_TAGS} tags.`);
  await setTags(actor.tenantId, conversation.id, next);
  return reload(actor.tenantId, conversation.id);
};

export const removeConversationTag: Handler = async ({ actor, params }) => {
  const conversation = await requireConversation(actor.tenantId, params.target);
  await setTags(actor.tenantId, conversation.id, conversation.tags.filter((t) => t !== params.tag));
  return reload(actor.tenantId, conversation.id);
};
