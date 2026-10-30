import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { deleteAgent, getAgent, updateAgent } from "@/lib/ai-agent/agents";
import { readJsonLimited } from "@/lib/http/body";
import { errorResponse, requireRole } from "@/lib/tenancy";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** GET -> { agent }. Any member can read. */
export async function GET(request: Request, { params }: Ctx) {
  try {
    const actor = await getActor(request);
    return Response.json({ agent: await getAgent(actor.tenantId, (await params).id) });
  } catch (e) {
    return errorResponse(e);
  }
}

/** PATCH any agent field (admin or owner) -> { agent } */
export async function PATCH(request: Request, { params }: Ctx) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const body = await readJsonLimited(request, 32 * 1024);
    return Response.json({ agent: await updateAgent(actor.tenantId, actor.userId, (await params).id, body) });
  } catch (e) {
    return errorResponse(e);
  }
}

/** DELETE (admin or owner) -> { ok: true }. Knowledge sources are deleted with the agent. */
export async function DELETE(request: Request, { params }: Ctx) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    await deleteAgent(actor.tenantId, actor.userId, (await params).id);
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
