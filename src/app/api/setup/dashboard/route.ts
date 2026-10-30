import { getActor } from "@/lib/auth";
import { buildDashboard } from "@/lib/setup/dashboard";
import { errorResponse } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/** GET ?tz=Area/City -> DashboardData for the signed-in member. Admins get workspace alerts; agents get their own queue. */
export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    const tz = new URL(request.url).searchParams.get("tz");
    const data = await buildDashboard(actor, { tz });
    return Response.json(data, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
