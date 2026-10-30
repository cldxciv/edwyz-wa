import { getActor } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { loadCandidates } from "@/lib/routing";
import { errorResponse } from "@/lib/tenancy";

/** GET (any member) -> { agents: [{ userId, name, email, role, available, maxOpen, openCount, lastAssignedAt, disabled }] } */
export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    const [members, candidates] = await Promise.all([
      prisma.membership.findMany({ where: { tenantId: actor.tenantId }, select: { userId: true, role: true, user: { select: { name: true, email: true } } }, orderBy: { createdAt: "asc" } }),
      loadCandidates(actor.tenantId),
    ]);
    const byId = new Map(candidates.map((c) => [c.userId, c]));
    const agents = members.map((m) => {
      const c = byId.get(m.userId);
      return {
        userId: m.userId,
        name: m.user.name,
        email: m.user.email,
        role: m.role,
        available: c?.available ?? true,
        maxOpen: c?.maxOpen ?? null,
        openCount: c?.openCount ?? 0,
        lastAssignedAt: c?.lastAssignedAt ?? null,
        disabled: c?.disabled ?? false,
      };
    });
    return Response.json({ agents, me: actor.userId });
  } catch (e) {
    return errorResponse(e);
  }
}
