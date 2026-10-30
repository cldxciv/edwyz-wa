import { Prisma } from "@/generated/prisma/client";
import { audit } from "@/lib/auth/audit";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { enqueueDelivery } from "@/lib/conversions";
import { HttpError, errorResponse, requireRole } from "@/lib/tenancy";

/** POST (admin or owner): re-queues a failed or skipped event -> { ok: true } */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const { id } = await ctx.params;
    const event = await prisma.conversionEvent.findFirst({ where: { id, tenantId: actor.tenantId }, select: { id: true, status: true } });
    if (!event) throw new HttpError(404, "Event not found.");
    if (event.status !== "failed" && event.status !== "skipped") throw new HttpError(409, "Only failed or skipped events can be re-queued.");
    await prisma.conversionEvent.updateMany({ where: { id, tenantId: actor.tenantId }, data: { status: "pending", attempts: 0, response: Prisma.DbNull } });
    await enqueueDelivery(actor.tenantId, id);
    await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "conversions.requeue", meta: { eventId: id } });
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
