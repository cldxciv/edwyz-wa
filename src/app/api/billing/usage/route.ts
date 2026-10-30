import { getActor } from "@/lib/auth";
import { usageLines, usagePlan } from "@/lib/billing/limits";
import { alertsFrom } from "@/lib/billing/usage-alerts";
import { errorResponse, requireRole } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/** Every plan limit with how much is used, plus the ones at 80 percent or more. Owners and admins only. */
export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const [lines, plan] = await Promise.all([usageLines(actor.tenantId), usagePlan(actor.tenantId)]);
    return Response.json({ lines, alerts: alertsFrom(lines), plan });
  } catch (e) {
    return errorResponse(e);
  }
}
