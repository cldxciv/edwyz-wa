import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { testAgent } from "@/lib/ai-agent";
import { readJsonLimited } from "@/lib/http/body";
import { errorResponse, HttpError, requireRole } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/** POST { message } (admin or owner) -> { text, handoff, sources }. Nothing is sent to anyone; one AI credit is used. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const body = await readJsonLimited(request, 16 * 1024);
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message || message.length > 1000) throw new HttpError(400, "message is required (up to 1000 characters).");
    return Response.json(await testAgent(actor.tenantId, (await params).id, message));
  } catch (e) {
    return errorResponse(e);
  }
}
