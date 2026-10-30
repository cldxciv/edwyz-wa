import { prisma } from "@/lib/db";
import { assignConversation } from "@/lib/routing";
import { describeError } from "@/lib/safe-error";

/**
 * Gives a lead the owner of its chat. If the chat has no owner yet the routing rules pick one (they honour the workspace's auto-assign
 * switch, working hours and fallback); an owner who is already there is kept. Returns the user id, or null when there is no one to assign.
 * Never throws: a routing problem must not stop a lead from being saved or followed up.
 */
export async function assignLeadToConversation(tenantId: string, leadId: string, conversationId: string): Promise<string | null> {
  try {
    await assignConversation(tenantId, conversationId);
    const chat = await prisma.conversation.findFirst({ where: { id: conversationId, tenantId }, select: { assignedToId: true } });
    const assignee = chat?.assignedToId ?? null;
    if (!assignee) return null;
    await prisma.lead.updateMany({ where: { id: leadId, tenantId, assignedToId: null }, data: { assignedToId: assignee } });
    return assignee;
  } catch (e) {
    console.error("[leads] routing failed:", describeError(e));
    return null;
  }
}

/** For a lead that has just arrived: when its contact already has a chat, route that chat now instead of waiting for a first message to be sent. Never throws, like assignLeadToConversation: the lookup of the chat is inside the guard too. */
export async function routeNewLead(tenantId: string, lead: { id: string; contactId: string | null; assignedToId: string | null }): Promise<string | null> {
  if (!lead.contactId || lead.assignedToId) return null;
  try {
    const chat = await prisma.conversation.findFirst({ where: { tenantId, contactId: lead.contactId }, orderBy: { lastMessageAt: "desc" }, select: { id: true } });
    return chat ? await assignLeadToConversation(tenantId, lead.id, chat.id) : null;
  } catch (e) {
    console.error("[leads] routing lookup failed:", describeError(e));
    return null;
  }
}
