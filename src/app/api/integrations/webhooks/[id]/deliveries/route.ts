import { getActor } from "@/lib/auth";
import { listDeliveries } from "@/lib/integrations/endpoints";
import { errorResponse, requireRole } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/** GET -> { deliveries: [{ id, event, status, attempts, lastStatus, lastError, createdAt }] } latest 25 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await getActor(request);
    requireRole(actor, "admin");
    return Response.json({ deliveries: await listDeliveries(actor.tenantId, (await params).id) }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
