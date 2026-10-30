import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { addSource, listSources } from "@/lib/ai-agent/agents";
import { readJsonLimited } from "@/lib/http/body";
import { errorResponse, requireRole } from "@/lib/tenancy";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** GET -> { sources: [{ id, kind, title, sourceUrl, status, chars, createdAt }] }. Content is never returned. */
export async function GET(request: Request, { params }: Ctx) {
  try {
    const actor = await getActor(request);
    return Response.json({ sources: await listSources(actor.tenantId, (await params).id) });
  } catch (e) {
    return errorResponse(e);
  }
}

/** POST { kind: "text", title?, content } | { kind: "faq", title?, faq: [{ q, a }] } | { kind: "url", title?, url } (admin or owner) -> 201 { source }. URLs are fetched once now. */
export async function POST(request: Request, { params }: Ctx) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const body = await readJsonLimited(request, 256 * 1024);
    return Response.json({ source: await addSource(actor.tenantId, actor.userId, (await params).id, body) }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
