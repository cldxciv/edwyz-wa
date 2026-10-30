import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { sendTestEvent } from "@/lib/integrations/endpoints";
import { errorResponse, requireRole } from "@/lib/tenancy";

/** POST -> 202 { deliveryId }. Queues a webhook.test event to this endpoint only. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    return Response.json(await sendTestEvent(actor.tenantId, (await params).id), { status: 202 });
  } catch (e) {
    return errorResponse(e);
  }
}
