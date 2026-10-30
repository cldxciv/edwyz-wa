import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { convertRule } from "@/lib/automation/v2/service";
import { errorResponse, requireRole } from "@/lib/tenancy";

/** POST (admin or owner) -> { rule }: turns a classic rule into the same rule in the When / If / Then format. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    return Response.json({ rule: await convertRule(actor.tenantId, (await params).id) });
  } catch (e) {
    return errorResponse(e);
  }
}
