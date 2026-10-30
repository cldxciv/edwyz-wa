import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { readJsonLimited } from "@/lib/http/body";
import { assignConversation, assignManually } from "@/lib/routing";
import { HttpError, errorResponse, requireRole } from "@/lib/tenancy";

/**
 * POST { conversationId, userId?: string | null } (admin or owner) -> { assignedToId, reason }
 * userId set: assign to that member; null: unassign; omitted: run automatic routing now (only if the chat is unassigned).
 */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const body = await readJsonLimited(request, 1024);
    if (typeof body.conversationId !== "string" || !body.conversationId || body.conversationId.length > 64) throw new HttpError(400, "conversationId is required.");
    if (body.userId === undefined) return Response.json(await assignConversation(actor.tenantId, body.conversationId, { force: true }));
    if (body.userId !== null && (typeof body.userId !== "string" || !body.userId || body.userId.length > 64)) throw new HttpError(400, "userId must be a user id or null.");
    return Response.json(await assignManually(actor, body.conversationId, body.userId as string | null));
  } catch (e) {
    return errorResponse(e);
  }
}
