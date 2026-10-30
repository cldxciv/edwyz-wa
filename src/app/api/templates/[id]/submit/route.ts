import { audit } from "@/lib/auth/audit";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { submitTemplate } from "@/lib/templates/service";
import { errorResponse, requireRole } from "@/lib/tenancy";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const id = (await params).id;
    const template = await submitTemplate(actor, id);
    await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "template.submitted", target: id });
    return Response.json({ template });
  } catch (e) {
    return errorResponse(e);
  }
}
