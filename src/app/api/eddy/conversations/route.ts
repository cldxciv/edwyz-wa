import { getActor } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { deleteOwnConversations, listConversations, visibilityHashOf } from "@/lib/eddy/conversations";
import { actionRecordDays, eddyHistoryDays } from "@/lib/eddy/settings";
import { viewerRules } from "@/lib/teams/visibility";
import { errorResponse, type Actor } from "@/lib/tenancy";

/**
 * GET /api/eddy/conversations -> { conversations, historyDays }
 *   The member's OWN Eddy conversations only, and only those whose visibilityHash equals the member's current one
 *   (docs/EDDY-SPEC.md 5.8 critic, 7.5): after a demotion, a team change or masking being switched on, old transcripts that
 *   hold what the member can no longer see are hidden (and deleted by the next eddy.retention run).
 * DELETE /api/eddy/conversations -> { deleted, message }
 *   "Delete my Eddy history" (7.6): the member's conversations and messages go at once. A record of the actions they
 *   confirmed stays for actionRecordDays as the activity record, and the answer says so. Allowed for an unverified member.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

async function memberVisibilityHash(actor: Actor): Promise<string> {
  const rules = await viewerRules(actor);
  return visibilityHashOf({ roleClass: actor.role === "agent" ? "agent" : "admin", teamIds: rules.teamIds, includeUnteamed: rules.includeUnteamed, onlyAssigned: rules.onlyAssigned, maskPhone: rules.maskPhone });
}

export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    if (request.headers.get("origin") !== null) assertSameOrigin(request);
    const [conversations, historyDays] = await Promise.all([listConversations(actor.tenantId, actor.userId, await memberVisibilityHash(actor)), eddyHistoryDays()]);
    return Response.json({ conversations, historyDays }, { headers: NO_STORE });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(request: Request) {
  try {
    const actor = await getActor(request);
    assertSameOrigin(request);
    const deleted = await deleteOwnConversations(actor.tenantId, actor.userId);
    const days = await actionRecordDays();
    return Response.json({ deleted, message: `Your chats are deleted now. A record of actions you confirmed is kept for ${days} days.` }, { headers: NO_STORE });
  } catch (e) {
    return errorResponse(e);
  }
}
