import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { readJsonLimited } from "@/lib/http/body";
import { deleteConnection, updateConnection } from "@/lib/byo-mcp/connections";
import { errorResponse, requireRole } from "@/lib/tenancy";

/** PATCH { name?, url?, authToken? (null or "" clears), allowedTools?, enabled? } -> { connection } */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const body = await readJsonLimited(request, 32 * 1024);
    return Response.json({ connection: await updateConnection(actor, (await params).id, body) });
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
    await deleteConnection(actor, (await params).id);
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
