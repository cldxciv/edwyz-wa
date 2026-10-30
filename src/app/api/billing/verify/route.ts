import { audit } from "@/lib/auth/audit";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { confirmCheckout } from "@/lib/billing/service";
import { readJsonObject } from "@/lib/contacts/http";
import { errorResponse, requireRole } from "@/lib/tenancy";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const result = await confirmCheckout(actor, await readJsonObject(request));
    await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "billing.payment_verified" });
    return Response.json(result);
  } catch (e) {
    return errorResponse(e);
  }
}
