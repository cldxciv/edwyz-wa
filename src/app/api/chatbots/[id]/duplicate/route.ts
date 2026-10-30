import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { duplicateChatbot } from "@/lib/chatbots/service";
import { errorResponse, requireRole } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/** POST (admin or owner) -> 201 { chatbot }. Copies the draft flow into a new draft. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const id = (await params).id;
    return Response.json({ chatbot: await duplicateChatbot(actor.tenantId, actor.userId, id) }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
