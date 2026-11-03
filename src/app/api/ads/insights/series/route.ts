import { getActor } from "@/lib/auth";
import { errorResponse } from "@/lib/tenancy";
import { insightsRange } from "@/lib/ads/insights-http";
import { accountScope, dailySeries } from "@/lib/ads/insights-queries";

export const dynamic = "force-dynamic";

/** ?from&to, and ?adAccount=<assetId> for one ad account. */
export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    const { from, to } = insightsRange(request);
    const adAccount = new URL(request.url).searchParams.get("adAccount");
    const scope = adAccount ? await accountScope(actor.tenantId, adAccount) : null;
    const days = await dailySeries(actor.tenantId, from, to, scope);
    return Response.json({ from, to, days }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
