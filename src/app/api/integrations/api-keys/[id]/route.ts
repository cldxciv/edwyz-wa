import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { revokeOrRemoveApiKey } from "@/lib/integrations/apikeys";
import { errorResponse, requireRole } from "@/lib/tenancy";

/** DELETE turns an active key off, or removes a key that is already off from the list (admin or owner) -> { ok: true, result: "revoked" | "removed" } */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const result = await revokeOrRemoveApiKey(actor.tenantId, (await params).id);
    return Response.json({ ok: true, result });
  } catch (e) {
    return errorResponse(e);
  }
}
