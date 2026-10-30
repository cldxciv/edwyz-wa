import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { FLOW_BODY_LIMIT, testRunChatbot } from "@/lib/chatbots/service";
import { readJsonLimited, readTextLimited } from "@/lib/http/body";
import { errorResponse, requireRole } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/** POST { flow? } (admin or owner) -> { ok, errors, warnings, nodeCount }. Validates the posted flow, or the saved draft; sends nothing. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const raw = await readTextLimited(request.clone(), FLOW_BODY_LIMIT);
    const body = raw.trim() ? await readJsonLimited(new Request(request.url, { method: "POST", body: raw }), FLOW_BODY_LIMIT) : {};
    return Response.json(await testRunChatbot(actor.tenantId, (await params).id, body));
  } catch (e) {
    return errorResponse(e);
  }
}
