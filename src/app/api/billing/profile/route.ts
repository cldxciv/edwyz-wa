import { audit } from "@/lib/auth/audit";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { saveBillingProfile } from "@/lib/billing/service";
import { readJsonObject } from "@/lib/contacts/http";
import { errorResponse, requireRole } from "@/lib/tenancy";

export async function PUT(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const profile = await saveBillingProfile(actor, await readJsonObject(request));
    await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "billing.profile_updated" });
    return Response.json({ billingProfile: profile });
  } catch (e) {
    return errorResponse(e);
  }
}
