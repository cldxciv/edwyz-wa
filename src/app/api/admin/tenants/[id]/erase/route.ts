import { handleAdmin, readBody, requireConfirmation, requireReason } from "@/lib/admin/http";
import { audit } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { eraseWorkspaceData, tombstoneKey } from "@/lib/lifecycle/erase-workspace";
import { HttpError } from "@/lib/tenancy";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Permanent erasure of one workspace. Platform admin with TOTP step-up only; the workspace slug must be typed back. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleAdmin(request, true, async ({ actor }) => {
    const id = (await params).id;
    const body = await readBody(request);
    const reason = requireReason(body);
    const tenant = await prisma.tenant.findUnique({ where: { id }, select: { slug: true } });
    if (!tenant) throw new HttpError(404, "Workspace not found.");
    requireConfirmation(tenant.slug, body.confirm);

    const ref = tombstoneKey(id).slice("erasure:tenant:".length, "erasure:tenant:".length + 12);
    await audit({ userId: actor.userId, action: "admin.tenant.erase_started", target: ref, meta: { reason } });
    try {
      const result = await eraseWorkspaceData(id, { allowActiveSubscription: body.subscription === "cancelled" });
      await audit({
        userId: actor.userId,
        action: "admin.tenant.erased",
        target: ref,
        meta: { reason, connectionsRevoked: result.connectionsRevoked, connectionsRevokeFailed: result.connectionsRevokeFailed, usersAnonymised: result.usersAnonymised },
      });
      return { ok: true, erased: true, connectionsRevoked: result.connectionsRevoked, usersAnonymised: result.usersAnonymised };
    } catch (e) {
      await audit({ userId: actor.userId, action: "admin.tenant.erase_failed", target: ref });
      throw e;
    }
  });
}

export { adminMethodNotAllowed as GET, adminMethodNotAllowed as HEAD, adminMethodNotAllowed as PUT, adminMethodNotAllowed as PATCH, adminMethodNotAllowed as DELETE, adminMethodNotAllowed as OPTIONS } from "@/lib/admin/http";
