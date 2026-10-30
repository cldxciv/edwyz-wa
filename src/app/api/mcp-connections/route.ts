import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { readJsonLimited } from "@/lib/http/body";
import { createConnection, listConnections } from "@/lib/byo-mcp/connections";
import { errorResponse, requireRole } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/** GET (admin or owner) -> { connections: [{ id, name, url, hasAuth, allowedTools, enabled, createdAt }] } */
export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    requireRole(actor, "admin");
    return Response.json({ connections: await listConnections(actor.tenantId) }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}

/** POST { name, url, authToken? } -> 201 { connection }. No tools are allowed until the admin ticks them. */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const body = await readJsonLimited(request, 8 * 1024);
    return Response.json({ connection: await createConnection(actor, body) }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
