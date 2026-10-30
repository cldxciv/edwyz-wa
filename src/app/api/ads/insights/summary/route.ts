import { getActor } from "@/lib/auth";
import { errorResponse } from "@/lib/tenancy";
import { insightsRange } from "@/lib/ads/insights-http";
import { loadState } from "@/lib/ads/insights-store";
import { nextManualSyncAt } from "@/lib/ads/insights-sync";
import { connectionStatus, fatigueCandidates, spendPacing, summaryByPeriod, tenantCurrency } from "@/lib/ads/insights-queries";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    const { from, to } = insightsRange(request);
    const [conn, summary, currency, fatigue, pacing, state, next] = await Promise.all([
      connectionStatus(actor.tenantId),
      summaryByPeriod(actor.tenantId, from, to),
      tenantCurrency(actor.tenantId),
      fatigueCandidates(actor.tenantId, from, to),
      spendPacing(actor.tenantId, to),
      loadState(actor.tenantId),
      nextManualSyncAt(actor.tenantId),
    ]);
    return Response.json(
      {
        from,
        to,
        ...conn,
        ...currency,
        ...summary,
        fatigue,
        pacing,
        lastSyncAt: state.lastSyncAt ?? null,
        lastError: state.lastError ?? null,
        nextManualSyncAt: next?.toISOString() ?? null,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    return errorResponse(e);
  }
}
