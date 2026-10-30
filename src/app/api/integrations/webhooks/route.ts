import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { readJsonLimited } from "@/lib/http/body";
import { createEndpoint, listEndpoints } from "@/lib/integrations/endpoints";
import { WEBHOOK_EVENTS } from "@/lib/integrations/events";
import { errorResponse, requireRole } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/** GET (admin or owner) -> { endpoints, events } */
export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    requireRole(actor, "admin");
    return Response.json({ endpoints: await listEndpoints(actor.tenantId), events: WEBHOOK_EVENTS }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}

/** POST { url, events } -> 201 { endpoint, secret }. The signing secret is shown once. */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const body = await readJsonLimited(request, 8 * 1024);
    return Response.json(await createEndpoint(actor.tenantId, { url: body.url, events: body.events }), { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
