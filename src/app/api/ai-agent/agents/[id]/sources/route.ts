import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { addSource, listSources, refreshSource } from "@/lib/ai-agent/agents";
import { readJsonLimited } from "@/lib/http/body";
import { errorResponse, HttpError, requireRole } from "@/lib/tenancy";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** 100 000 characters of Hindi or another Indian script take up to 3 bytes each, plus JSON escaping. */
const SOURCE_BODY_LIMIT = 512 * 1024;

/** GET -> { sources: [{ id, kind, title, sourceUrl, status, chars, createdAt }] }. Content is never returned. */
export async function GET(request: Request, { params }: Ctx) {
  try {
    const actor = await getActor(request);
    return Response.json({ sources: await listSources(actor.tenantId, (await params).id) });
  } catch (e) {
    return errorResponse(e);
  }
}

/**
 * POST { kind: "text", title?, content } | { kind: "faq", title?, faq: [{ q, a }] } | { kind: "url", title?, url }
 * | { kind: "file", title?, fileName, content } (a .txt or .md file read in the browser) (admin or owner) -> 201 { source }.
 * A url is read now and stored; PATCH reads it again.
 */
export async function POST(request: Request, { params }: Ctx) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const body = await readJsonLimited(request, SOURCE_BODY_LIMIT);
    return Response.json({ source: await addSource(actor.tenantId, actor.userId, (await params).id, body) }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}

/** PATCH { sourceId } (admin or owner) -> { source }. Refresh: reads a web page source again and replaces its stored text. */
export async function PATCH(request: Request, { params }: Ctx) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const body = await readJsonLimited(request, 4 * 1024);
    const sourceId = typeof body.sourceId === "string" && body.sourceId.length <= 64 ? body.sourceId : "";
    if (!sourceId) throw new HttpError(400, "sourceId is required.");
    return Response.json({ source: await refreshSource(actor.tenantId, actor.userId, (await params).id, sourceId) });
  } catch (e) {
    return errorResponse(e);
  }
}
