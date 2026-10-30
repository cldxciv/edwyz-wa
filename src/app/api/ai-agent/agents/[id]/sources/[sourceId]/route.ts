import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { deleteSource } from "@/lib/ai-agent/agents";
import { errorResponse, requireRole } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/** DELETE (admin or owner) -> { ok: true } */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string; sourceId: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const { id, sourceId } = await params;
    await deleteSource(actor.tenantId, actor.userId, id, sourceId);
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
