import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { unpublishChatbot } from "@/lib/chatbots/service";
import { errorResponse, requireRole } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/** POST (admin or owner) -> { chatbot }. Back to draft; live sessions expire. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const id = (await params).id;
    return Response.json({ chatbot: await unpublishChatbot(actor.tenantId, id) });
  } catch (e) {
    return errorResponse(e);
  }
}
