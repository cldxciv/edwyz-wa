import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { archiveChatbot } from "@/lib/chatbots/service";
import { errorResponse, requireRole } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/** POST (admin or owner) -> { chatbot }. Live sessions expire. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const id = (await params).id;
    return Response.json({ chatbot: await archiveChatbot(actor.tenantId, id) });
  } catch (e) {
    return errorResponse(e);
  }
}
