import { getActor } from "@/lib/auth";
import { resumeAiAgent } from "@/lib/ai-agent";
import { assertSameOrigin, readJson, reqString } from "@/lib/inbox/http";
import { assertCanActOnConversation } from "@/lib/inbox/status";
import { assertConversationVisible } from "@/lib/teams/visibility";
import { errorResponse } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/**
 * POST { conversationId } -> { resumed: boolean }. "Let the AI answer again": the AI agent, paused in this chat after a hand-off,
 * answers the customer's next message. Anyone who may write in the chat may do it (agents on their own or unassigned chats).
 */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    const conversationId = reqString(await readJson(request), "conversationId", 64);
    await assertConversationVisible(actor, conversationId);
    await assertCanActOnConversation(actor, conversationId);
    return Response.json({ resumed: await resumeAiAgent(actor.tenantId, conversationId, actor.userId) });
  } catch (e) {
    return errorResponse(e);
  }
}
