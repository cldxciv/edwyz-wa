import { getActor } from "@/lib/auth";
import { getWhatsAppTokenHealth } from "@/lib/onboarding/token-health";
import { errorResponse, hasRole } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/** Any member can read it (the banner explains why sending stopped); only owners and admins get canReconnect. No token material is returned. */
export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    const health = await getWhatsAppTokenHealth(actor.tenantId);
    return Response.json({ ...health, canReconnect: hasRole(actor, "admin") });
  } catch (e) {
    return errorResponse(e);
  }
}
