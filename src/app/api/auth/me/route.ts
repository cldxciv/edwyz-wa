import { getActor } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { HttpError, errorResponse } from "@/lib/tenancy";

export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    const [user, memberships] = await Promise.all([
      prisma.user.findUnique({ where: { id: actor.userId }, select: { id: true, email: true, name: true, emailVerifiedAt: true } }),
      // Deleted workspaces are left out of the switcher: switching into one would only be refused.
      prisma.membership.findMany({
        where: { userId: actor.userId, tenant: { deletedAt: null } },
        orderBy: { createdAt: "asc" },
        include: { tenant: { select: { id: true, name: true, slug: true } } },
      }),
    ]);
    if (!user) throw new HttpError(401, "Not signed in.");
    const workspaces = memberships.map((m) => ({ id: m.tenant.id, name: m.tenant.name, slug: m.tenant.slug, role: m.role }));
    const current = workspaces.find((w) => w.id === actor.tenantId) ?? null;
    const { emailVerifiedAt, ...profile } = user;
    return Response.json({ user: { ...profile, emailVerified: emailVerifiedAt !== null }, workspace: current, role: actor.role, workspaces }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
