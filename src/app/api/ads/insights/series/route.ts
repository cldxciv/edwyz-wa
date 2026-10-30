import { getActor } from "@/lib/auth";
import { errorResponse } from "@/lib/tenancy";
import { insightsRange } from "@/lib/ads/insights-http";
import { dailySeries } from "@/lib/ads/insights-queries";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    const { from, to } = insightsRange(request);
    const days = await dailySeries(actor.tenantId, from, to);
    return Response.json({ from, to, days }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
