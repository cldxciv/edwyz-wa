import { getActor } from "@/lib/auth";
import { getSetup } from "@/lib/setup";
import { errorResponse, hasRole } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/** GET -> { steps, summary, canDismiss }. Any member may read it; only owners and admins can dismiss steps. */
export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    const setup = await getSetup(actor.tenantId);
    return Response.json({ ...setup, canDismiss: hasRole(actor, "admin") }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
