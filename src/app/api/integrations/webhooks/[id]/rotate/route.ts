import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { rotateSecret } from "@/lib/integrations/endpoints";
import { errorResponse, requireRole } from "@/lib/tenancy";

/** POST -> { secret }. The new secret is shown once; the old one stops working immediately. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    return Response.json(await rotateSecret(actor.tenantId, (await params).id), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
