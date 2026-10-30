import { getActor } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { readJsonObject } from "@/lib/contacts/http";
import { cancelWorkspaceDeletion, getDeletionRequest, requestWorkspaceDeletion } from "@/lib/lifecycle/export-deletion";
import { errorResponse, requireRole } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/*
 * Lives under /api/billing on purpose: that prefix stays writable for a workspace that is locked for non-payment and for an owner
 * who has not confirmed their email, and these are exactly the people who may want to leave.
 */

/** GET (owner) -> { request: { status, requestedAt, deleteBy } | null } */
export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    requireRole(actor, "owner");
    return Response.json({ request: await getDeletionRequest(actor.tenantId) }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}

/** POST { confirmName } (owner) -> 201 { request }. Records the request; nothing is erased until the platform team acts on it. */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "owner");
    const body = await readJsonObject(request);
    return Response.json({ request: await requestWorkspaceDeletion(actor, body.confirmName) }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}

/** DELETE (owner) -> { cancelled }. Withdraws an open request. */
export async function DELETE(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "owner");
    return Response.json(await cancelWorkspaceDeletion(actor));
  } catch (e) {
    return errorResponse(e);
  }
}
