import { getActor } from "@/lib/auth";
import { errorResponse } from "@/lib/tenancy";
import { insightsRange } from "@/lib/ads/insights-http";
import { loadState } from "@/lib/ads/insights-store";
import { nextManualSyncAt } from "@/lib/ads/insights-sync";
import { FATIGUE_FREQUENCY, accountScope, connectionStatus, fatigueCandidates, insightAccounts, spendPacing, summaryByCurrency, summaryByPeriod, tenantCurrency } from "@/lib/ads/insights-queries";

export const dynamic = "force-dynamic";

/**
 * ?from&to, and ?adAccount=<assetId> for one ad account. With one account the money is in its currency. Without one, a
 * workspace whose ad accounts use different currencies also gets byCurrency: one set of totals per currency, because amounts
 * of different currencies are never added up.
 */
export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    const { from, to } = insightsRange(request);
    const adAccount = new URL(request.url).searchParams.get("adAccount");
    const scope = adAccount ? await accountScope(actor.tenantId, adAccount) : null;
    const [conn, summary, currency, fatigue, pacing, state, next, accounts] = await Promise.all([
      connectionStatus(actor.tenantId),
      summaryByPeriod(actor.tenantId, from, to, scope),
      scope ? Promise.resolve({ currency: scope.currency, mixed: false }) : tenantCurrency(actor.tenantId),
      fatigueCandidates(actor.tenantId, from, to, FATIGUE_FREQUENCY, scope),
      spendPacing(actor.tenantId, to, scope),
      loadState(actor.tenantId),
      nextManualSyncAt(actor.tenantId),
      insightAccounts(actor.tenantId),
    ]);
    const byCurrency = !scope && currency.mixed ? await summaryByCurrency(actor.tenantId, from, to) : null;
    return Response.json(
      {
        from,
        to,
        ...conn,
        ...currency,
        ...summary,
        adAccount: scope?.assetId ?? null,
        accounts,
        byCurrency,
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
