import { spendingAdAccount } from "@/lib/promote/audiences";
import { assertSearchRate, GEO_COPY, refuseCrossSite, searchInterests } from "@/lib/promote/geo";
import { promoteMeta } from "@/lib/promote/meta";
import { promoteRoute } from "@/lib/promote/route-guard";
import { HttpError } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/**
 * GET /api/promote/interests?q= (search_interests, admin; docs/IG-PAGE-ADS-SPEC.md 3.7, 4.2 A8, 4.8): interests by name, so
 * people pick "Yoga" rather than type an id. 60 searches a minute per member, shared with place search.
 */
export const GET = promoteRoute(
  "read",
  async ({ actor }, request) => {
    refuseCrossSite(request);
    assertSearchRate(actor);
    const account = await spendingAdAccount(actor.tenantId);
    if (!account) throw new HttpError(409, GEO_COPY.noAccount);
    const interests = await searchInterests(promoteMeta, { tenantId: actor.tenantId, adAccountAssetId: account.assetId }, new URL(request.url).searchParams.get("q"));
    return Response.json({ interests }, { headers: { "cache-control": "no-store" } });
  },
  { minRole: "admin" },
);
