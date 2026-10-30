import { getActor } from "@/lib/auth";
import { getConversationBotState } from "@/lib/chatbots";
import { assertConversationVisible } from "@/lib/teams/visibility";
import { HttpError, errorResponse } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/** GET ?conversationId= -> { session: latest bot session of the chat or null, available: [{ id, name }] bots that can be started on it }. */
export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    const conversationId = new URL(request.url).searchParams.get("conversationId") ?? "";
    if (!conversationId || conversationId.length > 64) throw new HttpError(400, "conversationId is required.");
    await assertConversationVisible(actor, conversationId);
    return Response.json(await getConversationBotState(actor.tenantId, conversationId), { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
