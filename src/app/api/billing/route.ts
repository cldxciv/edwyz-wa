import { getActor } from "@/lib/auth";
import { billingOverview } from "@/lib/billing/service";
import { errorResponse, requireRole } from "@/lib/tenancy";

export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    requireRole(actor, "admin");
    return Response.json(await billingOverview(actor));
  } catch (e) {
    return errorResponse(e);
  }
}
