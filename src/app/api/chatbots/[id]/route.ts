import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { deleteChatbot, FLOW_BODY_LIMIT, getChatbot, redactForViewer, updateChatbot } from "@/lib/chatbots/service";
import { readJsonLimited } from "@/lib/http/body";
import { errorResponse, hasRole, requireRole } from "@/lib/tenancy";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** GET -> { chatbot } including the draft flow and the published flow. Any member can read; webhook addresses and bodies are hidden from agents. */
export async function GET(request: Request, { params }: Ctx) {
  try {
    const actor = await getActor(request);
    const chatbot = await getChatbot(actor.tenantId, (await params).id);
    return Response.json({ chatbot: hasRole(actor, "admin") ? chatbot : redactForViewer(chatbot) });
  } catch (e) {
    return errorResponse(e);
  }
}

/** PATCH any of { name, triggerType, triggerKeywords, phoneNumberId, flow } (admin or owner). flow replaces the draft only. */
export async function PATCH(request: Request, { params }: Ctx) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const body = await readJsonLimited(request, FLOW_BODY_LIMIT);
    return Response.json({ chatbot: await updateChatbot(actor.tenantId, (await params).id, body) });
  } catch (e) {
    return errorResponse(e);
  }
}

/** DELETE (admin or owner) -> { ok: true }. Sessions are deleted with the chatbot. */
export async function DELETE(request: Request, { params }: Ctx) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    await deleteChatbot(actor.tenantId, (await params).id);
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
