import { getActor } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { listConnections } from "@/lib/meta-connect/service";
import { META_CONNECT_SCOPES, SCOPE_PURPOSES } from "@/lib/meta-connect/scopes";
import { errorResponse } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    // The WhatsApp number is connected on its own page (Connect WhatsApp); it is listed here so this page never reads as "nothing connected".
    const [connections, whatsapp] = await Promise.all([
      listConnections(actor.tenantId),
      prisma.phoneNumber.findMany({ where: { tenantId: actor.tenantId, status: "connected" }, orderBy: { createdAt: "asc" }, select: { displayPhone: true, verifiedName: true } }),
    ]);
    const scopes = META_CONNECT_SCOPES.map((scope) => ({ scope, purpose: SCOPE_PURPOSES[scope] }));
    return Response.json({ connections, scopes, configured: Boolean(process.env.META_LOGIN_CONFIG_ID && process.env.META_APP_ID), whatsapp });
  } catch (e) {
    return errorResponse(e);
  }
}
