import { getActor } from "@/lib/auth";
import { HttpError, errorResponse } from "@/lib/tenancy";
import { insightsRange } from "@/lib/ads/insights-http";
import type { InsightLevel } from "@/lib/ads/insights-fetch";
import { breakdownByLevel, topAndBottomAds } from "@/lib/ads/insights-queries";

export const dynamic = "force-dynamic";

const LEVELS: InsightLevel[] = ["campaign", "adset", "ad"];

export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    const { from, to } = insightsRange(request);
    const level = new URL(request.url).searchParams.get("level") ?? "ad";
    if (!LEVELS.includes(level as InsightLevel)) throw new HttpError(400, "level must be campaign, adset or ad.");
    const [rows, ranked] = await Promise.all([
      breakdownByLevel(actor.tenantId, level as InsightLevel, from, to),
      level === "ad" ? topAndBottomAds(actor.tenantId, from, to) : Promise.resolve({ top: [], bottom: [] }),
    ]);
    return Response.json({ from, to, level, rows, ...ranked }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
