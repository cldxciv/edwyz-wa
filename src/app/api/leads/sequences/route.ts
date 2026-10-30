import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { readJsonLimited } from "@/lib/http/body";
import { createSequence, listSequences } from "@/lib/leads/service";
import { errorResponse, requireRole } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    requireRole(actor, "admin");
    return Response.json({ items: await listSequences(actor.tenantId) });
  } catch (e) {
    return errorResponse(e);
  }
}

/** POST { name, enabled?, steps: [{ delayMinutes, templateId?, chatbotId?, stopOnReply?, params? }], appliesTo?: { leadFormId?, campaignMetaId? } } (admin). */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const body = await readJsonLimited(request, 32 * 1024);
    return Response.json({ sequence: await createSequence(actor, body) }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
