import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { readJsonLimited } from "@/lib/http/body";
import { deleteEndpoint, updateEndpoint } from "@/lib/integrations/endpoints";
import { errorResponse, requireRole } from "@/lib/tenancy";

/** PATCH { url?, events?, enabled? } -> { endpoint } */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const body = await readJsonLimited(request, 8 * 1024);
    return Response.json({ endpoint: await updateEndpoint(actor.tenantId, (await params).id, body) });
  } catch (e) {
    return errorResponse(e);
  }
}

/** DELETE -> { ok: true } */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    await deleteEndpoint(actor.tenantId, (await params).id);
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
