import { insightsRange } from "@/lib/ads/insights-http";
import { comparisonForCampaign } from "@/lib/promote/abtest";
import { dimensionRows, isResultDimension } from "@/lib/promote/breakdowns";
import { refuseCrossSite } from "@/lib/promote/geo";
import { promoteRoute } from "@/lib/promote/route-guard";
import { HttpError } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/**
 * GET /api/ads/insights/dimensions?campaignId=&dimension=placement|creative|age_gender|region&from=&to= (get_promotion_results;
 * docs/IG-PAGE-ADS-SPEC.md 3.10, 4.8, PRM-12). Admins and owners only, stricter than the other insights routes, and hidden
 * while the feature is (promote route guard). Also takes dimension=overview and dimension=leads, the Overview and Leads tabs.
 * Answers the plain rows of one Results tab from stored rows: no Meta call. "creative" also carries the compare verdict.
 */
export const GET = promoteRoute(
  "read",
  async ({ actor }, request) => {
    refuseCrossSite(request);
    const params = new URL(request.url).searchParams;
    const campaignId = params.get("campaignId")?.trim();
    if (!campaignId || campaignId.length > 64) throw new HttpError(400, "Choose a campaign.");
    const dimension = params.get("dimension") ?? "placement";
    if (!isResultDimension(dimension)) throw new HttpError(400, "dimension must be overview, placement, creative, age_gender, region or leads.");
    const { from, to } = insightsRange(request);
    const result = await dimensionRows(actor.tenantId, campaignId, dimension, { from, to });
    const compare = dimension === "creative" ? await comparisonForCampaign(actor.tenantId, campaignId) : undefined;
    return Response.json(compare === undefined ? result : { ...result, compare }, { headers: { "cache-control": "no-store" } });
  },
  { minRole: "admin" },
);
