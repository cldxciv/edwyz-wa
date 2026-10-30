import { audit } from "@/lib/auth/audit";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { syncTemplates } from "@/lib/templates/service";
import { errorResponse, requireRole } from "@/lib/tenancy";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const result = await syncTemplates(actor);
    await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "template.synced", meta: { synced: result.synced } });
    return Response.json(result);
  } catch (e) {
    return errorResponse(e);
  }
}
