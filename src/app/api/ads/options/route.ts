import { getActor } from "@/lib/auth";
import { adOptions } from "@/lib/ads/service";
import { errorResponse, requireRole } from "@/lib/tenancy";

export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    requireRole(actor, "admin");
    return Response.json(await adOptions(actor.tenantId));
  } catch (e) {
    return errorResponse(e);
  }
}
