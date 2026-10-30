import { getActor } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { errorResponse } from "@/lib/tenancy";

export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    const rows = await prisma.membership.findMany({
      where: { tenantId: actor.tenantId },
      orderBy: { createdAt: "asc" },
      include: { user: { select: { id: true, email: true, name: true } } },
    });
    const members = rows.map((m) => ({ userId: m.userId, email: m.user.email, name: m.user.name, role: m.role, joinedAt: m.createdAt }));
    return Response.json({ members }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
