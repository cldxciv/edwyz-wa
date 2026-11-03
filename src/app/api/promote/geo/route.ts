import { spendingAdAccount } from "@/lib/promote/audiences";
import { assertSearchRate, GEO_COPY, refuseCrossSite, searchPlaces } from "@/lib/promote/geo";
import { promoteMeta } from "@/lib/promote/meta";
import { promoteRoute } from "@/lib/promote/route-guard";
import { HttpError } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/**
 * GET /api/promote/geo?q= (search_places, admin; docs/IG-PAGE-ADS-SPEC.md 3.7, 4.2 A7, 4.8): India's cities, PIN codes and
 * states for "People near my shop" and "People I choose". A 6-digit PIN code searches postal codes. 60 searches a minute per
 * member, shared with interest search.
 */
export const GET = promoteRoute(
  "read",
  async ({ actor }, request) => {
    refuseCrossSite(request);
    assertSearchRate(actor);
    const account = await spendingAdAccount(actor.tenantId);
    if (!account) throw new HttpError(409, GEO_COPY.noAccount);
    const places = await searchPlaces(promoteMeta, { tenantId: actor.tenantId, adAccountAssetId: account.assetId }, new URL(request.url).searchParams.get("q"));
    return Response.json({ places }, { headers: { "cache-control": "no-store" } });
  },
  { minRole: "admin" },
);
