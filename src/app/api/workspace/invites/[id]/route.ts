import { getActor } from "@/lib/auth";
import { audit } from "@/lib/auth/audit";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { prisma } from "@/lib/db";
import { HttpError, errorResponse, requireRole } from "@/lib/tenancy";

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const { id } = await params;
    const res = await prisma.invite.deleteMany({ where: { id, tenantId: actor.tenantId, acceptedAt: null } });
    if (res.count === 0) throw new HttpError(404, "That invite was not found.");
    await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "invite.revoked", target: id });
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
