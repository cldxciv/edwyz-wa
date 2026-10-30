import { assertSameOrigin } from "@/lib/auth/csrf";
import { audit } from "@/lib/auth/audit";
import { getActor } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { readJsonLimited } from "@/lib/http/body";
import { getExtra, saveExtra, validateExtra } from "@/lib/routing";
import { HttpError, errorResponse, requireRole } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/** GET (admin or owner) -> { extra: RoutingExtra } */
export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    requireRole(actor, "admin");
    return Response.json({ extra: await getExtra(actor.tenantId) });
  } catch (e) {
    return errorResponse(e);
  }
}

/**
 * PUT full replacement (admin or owner) -> { extra }
 * { lastAssignee: { enabled, withinHours }, contactOwner: { enabled }, setOwnerOnAssign, autoReassign: { enabled, minutes, maxMoves },
 *   viewOnlyAssigned: { allAgents, userIds }, maskPhone: { allAgents, userIds }, teamVisibility, leadStages: string[] }
 */
export async function PUT(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const parsed = validateExtra(await readJsonLimited(request, 16 * 1024));
    if (!parsed.ok) throw new HttpError(400, parsed.error);
    const value = parsed.value;
    const people = [...new Set([...value.viewOnlyAssigned.userIds, ...value.maskPhone.userIds])];
    if (people.length > 0) {
      const found = await prisma.membership.findMany({ where: { tenantId: actor.tenantId, userId: { in: people } }, select: { userId: true } });
      if (found.length !== people.length) throw new HttpError(400, "Everyone you pick must be a member of this workspace.");
    }
    await saveExtra(actor.tenantId, value);
    await audit({
      tenantId: actor.tenantId,
      userId: actor.userId,
      action: "routing.extra_update",
      meta: { autoReassign: value.autoReassign.enabled, viewOnlyAll: value.viewOnlyAssigned.allAgents, maskAll: value.maskPhone.allAgents, teamVisibility: value.teamVisibility },
    });
    return Response.json({ extra: value });
  } catch (e) {
    return errorResponse(e);
  }
}
