import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { connectStore, listStores } from "@/lib/commerce/stores";
import { readJsonLimited } from "@/lib/http/body";
import { errorResponse, requireRole } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/** GET -> { stores: [{ id, shopDomain, status, verified, hasWebhookSecret, createdAt, webhookUrl }] } */
export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    return Response.json({ stores: await listStores(actor.tenantId) });
  } catch (e) {
    return errorResponse(e);
  }
}

/**
 * POST { shopDomain, webhookSecret, accessToken? } (admin or owner) -> 201 { store }. Send the Admin API accessToken: Shopify is asked
 * (GET /admin/api/<version>/shop.json on the shop's own host) to confirm the domain, and only then is the store created, active, with the
 * domain claimed. A newer proof takes the domain over from another workspace, whose store goes back to pending_verification. The token is
 * kept sealed (it is used again to re-verify) and is never returned. 422 with a plain-language message and nothing stored when the token
 * is invalid, belongs to another shop, or Shopify cannot be reached; 429 after too many checks. Without accessToken (older clients) the
 * store is created "pending_verification": no data, no claim, until POST /api/commerce/stores/[id]/verify or PATCH { accessToken }.
 */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const store = await connectStore(actor.tenantId, await readJsonLimited(request, 8 * 1024));
    return Response.json({ store }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
