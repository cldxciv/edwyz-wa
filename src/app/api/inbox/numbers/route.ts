import { getActor } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { errorResponse } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/** GET -> { numbers: [{ id, displayPhone, verifiedName }] } the connected business numbers a chat can be started from */
export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    const numbers = await prisma.phoneNumber.findMany({
      where: { tenantId: actor.tenantId, status: "connected" },
      orderBy: { createdAt: "asc" },
      take: 20,
      select: { id: true, displayPhone: true, verifiedName: true },
    });
    return Response.json({ numbers });
  } catch (e) {
    return errorResponse(e);
  }
}
