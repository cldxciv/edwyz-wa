import type { Role } from "@/generated/prisma/client";
import { getActor } from "@/lib/auth";
import { audit } from "@/lib/auth/audit";
import { ROLES, lastOwnerGuard, withOwnerLock } from "@/lib/auth/roles";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { readJson, str } from "@/lib/auth/http";
import { prisma } from "@/lib/db";
import { revokeKeysBestEffort } from "@/lib/integrations/apikeys";
import { removeUserFromTeams } from "@/lib/teams/service";
import { HttpError, errorResponse, requireRole } from "@/lib/tenancy";

type Ctx = { params: Promise<{ userId: string }> };

export async function PATCH(request: Request, { params }: Ctx) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "owner");
    const { userId } = await params;
    const role = str(await readJson(request), "role", "Role", 20) as Role;
    if (!ROLES.includes(role)) throw new HttpError(400, "Choose owner, admin or agent.");
    // Making someone an owner gives away the workspace, so it goes through Transfer ownership, which asks for the owner's password and is
    // rate limited. Otherwise a hijacked session could promote an invited agent to owner without ever proving who is at the keyboard.
    if (role === "owner") throw new HttpError(400, "To make someone an owner, use Transfer ownership. It asks for your password.");

    const target = await prisma.membership.findUnique({ where: { tenantId_userId: { tenantId: actor.tenantId, userId } } });
    if (!target) throw new HttpError(404, "That member was not found in this workspace.");
    if (target.role === role) return Response.json({ userId, role });
    await withOwnerLock(actor.tenantId, async (tx) => {
      await lastOwnerGuard(tx, actor.tenantId, userId);
      await tx.membership.update({ where: { tenantId_userId: { tenantId: actor.tenantId, userId } }, data: { role } });
    });
    // Decision: a role change does not revoke the member's API keys. A key always acts with agent-level rights limited to its own scopes
    // (authenticateApiKey never reads the creator's role), so demotion cannot leave a key more powerful than the member now is.
    await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "member.role_changed", target: userId, meta: { from: target.role, to: role } });
    return Response.json({ userId, role });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(request: Request, { params }: Ctx) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const { userId } = await params;

    const target = await prisma.membership.findUnique({ where: { tenantId_userId: { tenantId: actor.tenantId, userId } } });
    if (!target) throw new HttpError(404, "That member was not found in this workspace.");
    if (actor.role === "admin" && target.role !== "agent" && userId !== actor.userId) {
      throw new HttpError(403, "Only an owner can remove an owner or an admin.");
    }
    await withOwnerLock(actor.tenantId, async (tx) => {
      await lastOwnerGuard(tx, actor.tenantId, userId);
      await tx.membership.delete({ where: { tenantId_userId: { tenantId: actor.tenantId, userId } } });
    });
    await removeUserFromTeams(actor.tenantId, userId).catch(() => console.error("[teams] could not clear team membership"));
    // Keys the member created stop working with them. Best effort: the live-membership check already refuses them if this write fails.
    const keysRevoked = await revokeKeysBestEffort(userId, actor.tenantId, "member_removed");
    await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "member.removed", target: userId, meta: { role: target.role, keysRevoked } });
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
