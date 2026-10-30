import { audit } from "@/lib/auth/audit";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { startSubscription } from "@/lib/billing/service";
import { readJsonObject } from "@/lib/contacts/http";
import { errorResponse, requireRole } from "@/lib/tenancy";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const body = await readJsonObject(request);
    const result = await startSubscription(actor, body.planId);
    await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "billing.subscribe_started", target: String(body.planId) });
    return Response.json(result);
  } catch (e) {
    return errorResponse(e);
  }
}
