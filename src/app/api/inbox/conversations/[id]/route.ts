import { getActor } from "@/lib/auth";
import { intParam } from "@/lib/inbox/http";
import { flagsFor } from "@/lib/inbox/marks";
import { getConversation } from "@/lib/inbox/service";
import { assertConversationVisible, maskContact, shouldMaskFor } from "@/lib/teams/visibility";
import { errorResponse } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/** GET ?cursor=&limit= -> { conversation (with the caller's own flags: favorite, unread, mention), windowOpen, messages (newest first), nextCursor } */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await getActor(request);
    const { id } = await params;
    const p = new URL(request.url).searchParams;
    await assertConversationVisible(actor, id);
    const result = await getConversation(actor.tenantId, id, { cursor: p.get("cursor") ?? undefined, limit: intParam(p.get("limit")) });
    const masked = await shouldMaskFor(actor);
    const flags = (await flagsFor(actor.tenantId, actor.userId, [id])).get(id) ?? { favorite: false, unread: false, mention: false };
    const conversation = { ...result.conversation, flags, ...(masked ? { contact: maskContact(result.conversation.contact, true) } : {}) };
    return Response.json({ ...result, conversation });
  } catch (e) {
    return errorResponse(e);
  }
}
