import { getActor } from "@/lib/auth";
import { assertSameOrigin, readJson, reqString } from "@/lib/inbox/http";
import { canActOn } from "@/lib/inbox/status";
import { startChatbot } from "@/lib/chatbots";
import { prisma } from "@/lib/db";
import { assertConversationVisible } from "@/lib/teams/visibility";
import { errorResponse, HttpError } from "@/lib/tenancy";
import { wireModules } from "@/lib/wiring";

export const dynamic = "force-dynamic";

/**
 * POST { conversationId } -> { sessionId, status }. Any member who may act on the chat can start a published chatbot on it
 * (agents only on unassigned chats or their own). Replaces a bot that is already running there.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    const conversationId = reqString(await readJson(request), "conversationId", 64);
    await assertConversationVisible(actor, conversationId);
    const conversation = await prisma.conversation.findFirst({ where: { id: conversationId, tenantId: actor.tenantId }, select: { assignedToId: true } });
    if (!conversation) throw new HttpError(404, "Conversation not found.");
    if (!canActOn(actor, conversation.assignedToId)) throw new HttpError(403, "You can only start a chatbot on your own chats or unassigned ones.");
    wireModules();
    const result = await startChatbot({ tenantId: actor.tenantId }, (await params).id, conversationId, { source: "manual" });
    return Response.json(result, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
