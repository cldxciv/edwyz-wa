import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { FlowInvalidError, publishChatbot } from "@/lib/chatbots/service";
import { errorResponse, requireRole } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/** POST (admin or owner) -> { chatbot, warnings }; 422 { error, errors, warnings } when the draft flow is invalid. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    return Response.json(await publishChatbot(actor.tenantId, (await params).id));
  } catch (e) {
    if (e instanceof FlowInvalidError) return Response.json({ error: e.message, errors: e.validation.errors, warnings: e.validation.warnings }, { status: 422 });
    return errorResponse(e);
  }
}
