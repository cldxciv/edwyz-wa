import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { verifyStore } from "@/lib/commerce/stores";
import { readTextLimited } from "@/lib/http/body";
import { HttpError, errorResponse, requireRole } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

async function optionalJson(request: Request): Promise<Record<string, unknown>> {
  const text = (await readTextLimited(request, 8 * 1024)).trim();
  if (!text) return {};
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpError(400, "The request body must be valid JSON.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "The request body must be a JSON object.");
  return body as Record<string, unknown>;
}

/**
 * POST { accessToken? } (admin or owner) -> { store }. Proves the workspace controls the shop: Shopify is asked (GET shop.json with the
 * Admin API token) to confirm the domain, then a pending store becomes active. Uses the token saved with the store when none is sent.
 * 422 with a plain-language message when the token is invalid, belongs to another shop, or Shopify cannot be reached.
 */
export async function POST(request: Request, { params }: Ctx) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const store = await verifyStore(actor.tenantId, (await params).id, await optionalJson(request));
    return Response.json({ store });
  } catch (e) {
    return errorResponse(e);
  }
}
