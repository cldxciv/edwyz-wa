import { getActor } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { errorResponse } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/** GET -> { teams: [{ id, name }], phoneNumbers: [{ id, displayPhone, verifiedName }] }: what the chatbot builder offers in its pickers. Any member can read. */
export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    const [teams, phoneNumbers] = await Promise.all([
      prisma.team.findMany({ where: { tenantId: actor.tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" }, take: 100 }),
      prisma.phoneNumber.findMany({ where: { tenantId: actor.tenantId }, select: { id: true, displayPhone: true, verifiedName: true }, orderBy: { displayPhone: "asc" }, take: 50 }),
    ]);
    return Response.json({ teams, phoneNumbers }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
