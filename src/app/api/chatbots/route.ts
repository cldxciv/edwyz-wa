import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { createChatbot, FLOW_BODY_LIMIT, listChatbots } from "@/lib/chatbots/service";
import { readJsonLimited } from "@/lib/http/body";
import { errorResponse, requireRole } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/** GET -> { chatbots: [summary] } without flows. Any member can read. */
export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    return Response.json({ chatbots: await listChatbots(actor.tenantId) });
  } catch (e) {
    return errorResponse(e);
  }
}

/** POST { name, triggerType?, triggerKeywords?, phoneNumberId?, flow? } (admin or owner) -> 201 { chatbot } */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const chatbot = await createChatbot(actor.tenantId, actor.userId, await readJsonLimited(request, FLOW_BODY_LIMIT));
    return Response.json({ chatbot }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
