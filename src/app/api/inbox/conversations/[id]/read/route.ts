import { getActor } from "@/lib/auth";
import { assertConversationVisible } from "@/lib/teams/visibility";
import { assertSameOrigin } from "@/lib/inbox/http";
import { markRead } from "@/lib/inbox/service";
import { errorResponse } from "@/lib/tenancy";

/** POST -> { ok: true }. Resets the unread counter and clears the caller's own "marked as unread" flag and mention notice for this chat. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    await assertConversationVisible(actor, (await params).id);
    await markRead(actor.tenantId, (await params).id, actor.userId);
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
