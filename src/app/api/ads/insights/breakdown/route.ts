import { getActor } from "@/lib/auth";
import { HttpError, errorResponse } from "@/lib/tenancy";
import { insightsRange } from "@/lib/ads/insights-http";
import type { InsightLevel } from "@/lib/ads/insights-fetch";
import { accountScope, breakdownByLevel, topAndBottomAds } from "@/lib/ads/insights-queries";

export const dynamic = "force-dynamic";

const LEVELS: InsightLevel[] = ["campaign", "adset", "ad"];

/** ?level&from&to, and ?adAccount=<assetId> for one ad account. Every row carries the currency of its spend. */
export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    const { from, to } = insightsRange(request);
    const params = new URL(request.url).searchParams;
    const level = params.get("level") ?? "ad";
    if (!LEVELS.includes(level as InsightLevel)) throw new HttpError(400, "level must be campaign, adset or ad.");
    const adAccount = params.get("adAccount");
    const scope = adAccount ? await accountScope(actor.tenantId, adAccount) : null;
    const [rows, ranked] = await Promise.all([
      breakdownByLevel(actor.tenantId, level as InsightLevel, from, to, 100, scope),
      level === "ad" ? topAndBottomAds(actor.tenantId, from, to, 5, scope) : Promise.resolve({ top: [], bottom: [] }),
    ]);
    return Response.json({ from, to, level, rows, ...ranked }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
