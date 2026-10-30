import { audit } from "@/lib/auth/audit";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { cancelAtPeriodEnd } from "@/lib/billing/service";
import { errorResponse, requireRole } from "@/lib/tenancy";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "owner");
    const result = await cancelAtPeriodEnd(actor);
    await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "billing.cancel_requested" });
    return Response.json(result);
  } catch (e) {
    return errorResponse(e);
  }
}
