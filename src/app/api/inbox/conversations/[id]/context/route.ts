import { getActor } from "@/lib/auth";
import { assertConversationVisible, conversationScopeFor, shouldMaskFor } from "@/lib/teams/visibility";
import { getConversationContext } from "@/lib/inbox/context";
import { errorResponse } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/** GET -> { lead, stats, otherChats } for the side panel. Any member. lead is null when the contact has no Lead. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await getActor(request);
    await assertConversationVisible(actor, (await params).id);
    const [scope, maskPhone] = await Promise.all([conversationScopeFor(actor), shouldMaskFor(actor)]);
    return Response.json(await getConversationContext(actor.tenantId, (await params).id, { scope, maskPhone }), { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
