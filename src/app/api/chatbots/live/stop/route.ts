import { getActor } from "@/lib/auth";
import { stopConversationBot } from "@/lib/chatbots";
import { assertSameOrigin, readJson, reqString } from "@/lib/inbox/http";
import { canActOn } from "@/lib/inbox/status";
import { prisma } from "@/lib/db";
import { assertConversationVisible } from "@/lib/teams/visibility";
import { errorResponse, HttpError } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/** POST { conversationId } -> { stopped: boolean }. A teammate takes over: the running bot session ends as handed over. */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    const conversationId = reqString(await readJson(request), "conversationId", 64);
    await assertConversationVisible(actor, conversationId);
    const conversation = await prisma.conversation.findFirst({ where: { id: conversationId, tenantId: actor.tenantId }, select: { assignedToId: true } });
    if (!conversation) throw new HttpError(404, "Conversation not found.");
    if (!canActOn(actor, conversation.assignedToId)) throw new HttpError(403, "You can only stop a chatbot on your own chats or unassigned ones.");
    return Response.json({ stopped: await stopConversationBot(actor.tenantId, conversationId) });
  } catch (e) {
    return errorResponse(e);
  }
}
