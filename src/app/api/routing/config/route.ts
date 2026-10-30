import { assertSameOrigin } from "@/lib/auth/csrf";
import { audit } from "@/lib/auth/audit";
import { getActor } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { readJsonLimited } from "@/lib/http/body";
import { getSettings, validateSettings } from "@/lib/routing";
import { HttpError, errorResponse, requireRole } from "@/lib/tenancy";

/** GET (admin or owner) -> { config: RoutingSettings } */
export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    requireRole(actor, "admin");
    return Response.json({ config: await getSettings(actor.tenantId) });
  } catch (e) {
    return errorResponse(e);
  }
}

/** PUT full settings (admin or owner) -> { config } */
export async function PUT(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const parsed = validateSettings(await readJsonLimited(request, 16 * 1024));
    if (!parsed.ok) throw new HttpError(400, parsed.error);
    const value = parsed.value;
    if (value.fallbackUserId) {
      const member = await prisma.membership.findFirst({ where: { tenantId: actor.tenantId, userId: value.fallbackUserId }, select: { id: true } });
      if (!member) throw new HttpError(400, "The fallback agent must be a member of this workspace.");
    }
    const data = { ...value, workingHours: value.workingHours ?? Prisma.DbNull };
    await prisma.routingConfig.upsert({
      where: { tenantId: actor.tenantId },
      create: { tenantId: actor.tenantId, ...data },
      update: data,
    });
    await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "routing.config_update", meta: { autoAssign: value.autoAssign, mode: value.mode } });
    return Response.json({ config: value });
  } catch (e) {
    return errorResponse(e);
  }
}
