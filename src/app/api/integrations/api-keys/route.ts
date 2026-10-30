import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { readJsonLimited } from "@/lib/http/body";
import { createApiKey, listApiKeys } from "@/lib/integrations/apikeys";
import { errorResponse, requireRole } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/** GET (admin or owner) -> { keys: [{ id, name, prefix, scopes, lastUsedAt, revokedAt, createdAt }] } */
export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    requireRole(actor, "admin");
    return Response.json({ keys: await listApiKeys(actor.tenantId) }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}

/** POST { name, scopes: string[] } (admin or owner) -> 201 { apiKey, key }. `key` is shown once and never stored. */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const body = await readJsonLimited(request, 8 * 1024);
    return Response.json(await createApiKey(actor, { name: body.name, scopes: body.scopes }), { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
