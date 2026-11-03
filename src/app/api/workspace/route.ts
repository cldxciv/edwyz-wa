import { getActor } from "@/lib/auth";
import { audit } from "@/lib/auth/audit";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { readJson, str } from "@/lib/auth/http";
import { prisma } from "@/lib/db";
import { errorResponse, requireRole } from "@/lib/tenancy";

/**
 * Renames the workspace. Owner only. Body: { name }. The web address part (slug) stays as it was, so links and API clients keep
 * working; only the name people see in the app, emails and invoices changes.
 */
export async function PATCH(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "owner");
    const name = str(await readJson(request), "name", "Workspace name", 100);
    const before = await prisma.tenant.findUnique({ where: { id: actor.tenantId }, select: { name: true } });
    const workspace = await prisma.tenant.update({ where: { id: actor.tenantId }, data: { name }, select: { id: true, name: true, slug: true } });
    if (before?.name !== name) await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "workspace.renamed", target: actor.tenantId, meta: { from: before?.name ?? null, to: name } });
    return Response.json({ workspace }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
