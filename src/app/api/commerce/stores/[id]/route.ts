import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { deleteStore, getStore, updateStore } from "@/lib/commerce/stores";
import { readJsonLimited } from "@/lib/http/body";
import { errorResponse, requireRole } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET -> { store } */
export async function GET(request: Request, { params }: Ctx) {
  try {
    const actor = await getActor(request);
    return Response.json({ store: await getStore(actor.tenantId, (await params).id) });
  } catch (e) {
    return errorResponse(e);
  }
}

/**
 * PATCH { status?, webhookSecret?, accessToken? } (admin or owner) -> { store }. accessToken is checked with Shopify (422 when invalid or
 * for another shop) and, once accepted, saved sealed and never returned. On a pending or active store it verifies and activates the store
 * (claiming the domain); on a disabled store without a status it only replaces the saved token. status "active" on a disabled or pending
 * store verifies with the pasted token or the saved one (422 when there is neither, or Shopify no longer accepts it) and nothing changes
 * on failure. status "disabled" releases the domain and cannot be combined with accessToken (400).
 */
export async function PATCH(request: Request, { params }: Ctx) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const store = await updateStore(actor.tenantId, (await params).id, await readJsonLimited(request, 8 * 1024));
    return Response.json({ store });
  } catch (e) {
    return errorResponse(e);
  }
}

/** DELETE (admin or owner) -> { ok: true }. Removes the store and its carts. */
export async function DELETE(request: Request, { params }: Ctx) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    await deleteStore(actor.tenantId, (await params).id);
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
