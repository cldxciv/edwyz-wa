import { getActor } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { deleteOwnConversations, readConversation, visibilityHashOf } from "@/lib/eddy/conversations";
import { viewerRules } from "@/lib/teams/visibility";
import { errorResponse, type Actor } from "@/lib/tenancy";

/**
 * GET /api/eddy/conversations/[id] -> { conversation, messages }
 *   One of the member's OWN conversations, with what they typed and Eddy's replies (the transcript projection, never the
 *   raw tool results or context notes). 404 for another member's conversation, another workspace's, or one whose
 *   visibilityHash no longer matches the member (docs/EDDY-SPEC.md 5.8 critic).
 * DELETE /api/eddy/conversations/[id] -> { deleted }
 *   Deletes that conversation of the member's own history at once (7.6). Allowed for an unverified member.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const NO_STORE = { "cache-control": "no-store" };
const NOT_FOUND = "That Eddy chat wasn't found. It may have been deleted.";

async function memberVisibilityHash(actor: Actor): Promise<string> {
  const rules = await viewerRules(actor);
  return visibilityHashOf({ roleClass: actor.role === "agent" ? "agent" : "admin", teamIds: rules.teamIds, includeUnteamed: rules.includeUnteamed, onlyAssigned: rules.onlyAssigned, maskPhone: rules.maskPhone });
}

export async function GET(request: Request, { params }: Ctx) {
  try {
    const actor = await getActor(request);
    if (request.headers.get("origin") !== null) assertSameOrigin(request);
    const { id } = await params;
    if (!ID.test(id ?? "")) return Response.json({ error: NOT_FOUND }, { status: 404, headers: NO_STORE });
    const found = await readConversation(actor.tenantId, actor.userId, id, await memberVisibilityHash(actor));
    if (!found) return Response.json({ error: NOT_FOUND }, { status: 404, headers: NO_STORE });
    return Response.json(found, { headers: NO_STORE });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(request: Request, { params }: Ctx) {
  try {
    const actor = await getActor(request);
    assertSameOrigin(request);
    const { id } = await params;
    if (!ID.test(id ?? "")) return Response.json({ error: NOT_FOUND }, { status: 404, headers: NO_STORE });
    const deleted = await deleteOwnConversations(actor.tenantId, actor.userId, id);
    if (deleted === 0) return Response.json({ error: NOT_FOUND }, { status: 404, headers: NO_STORE });
    return Response.json({ deleted }, { headers: NO_STORE });
  } catch (e) {
    return errorResponse(e);
  }
}
