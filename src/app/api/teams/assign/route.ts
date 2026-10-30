import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { readJsonLimited } from "@/lib/http/body";
import { assignToTeam } from "@/lib/teams";
import { HttpError, errorResponse } from "@/lib/tenancy";

const idOrNull = (v: unknown, field: string): string | null => {
  if (v === null) return null;
  if (typeof v !== "string" || !v || v.length > 64) throw new HttpError(400, `${field} must be an id or null.`);
  return v;
};

/**
 * POST { conversationId, teamId: string | null, userId?: string | null, route?: boolean } -> { teamId, assignedToId, reason }
 * Puts a chat in a team. userId picks a person inside the team (null leaves it with nobody); route: true lets routing pick one.
 * Admins and owners can do anything; agents can send a chat they may act on to a team, or take it themselves.
 */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    const body = await readJsonLimited(request, 2048);
    const conversationId = idOrNull(body.conversationId, "conversationId");
    if (!conversationId) throw new HttpError(400, "conversationId is required.");
    if (body.teamId === undefined) throw new HttpError(400, "teamId is required (use null to take the chat out of its team).");
    if (body.route !== undefined && typeof body.route !== "boolean") throw new HttpError(400, "route must be true or false.");
    const result = await assignToTeam(actor, conversationId, {
      teamId: idOrNull(body.teamId, "teamId"),
      ...(body.userId !== undefined ? { userId: idOrNull(body.userId, "userId") } : {}),
      route: body.route === true,
    });
    return Response.json(result);
  } catch (e) {
    return errorResponse(e);
  }
}
