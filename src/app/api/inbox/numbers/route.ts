import { getActor } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { errorResponse } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/**
 * GET -> { numbers: [{ id, displayPhone, verifiedName, wabaRefId }] } the connected business numbers a chat can be started from.
 * wabaRefId (the number's WhatsApp Business Account) lets the new-chat dialog offer only templates that number can send.
 */
export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    const numbers = await prisma.phoneNumber.findMany({
      where: { tenantId: actor.tenantId, status: "connected" },
      orderBy: { createdAt: "asc" },
      take: 20,
      select: { id: true, displayPhone: true, verifiedName: true, wabaRefId: true },
    });
    return Response.json({ numbers });
  } catch (e) {
    return errorResponse(e);
  }
}
