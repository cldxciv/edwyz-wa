import { getComparison } from "@/lib/promote/abtest";
import { refuseCrossSite } from "@/lib/promote/geo";
import { promoteRoute } from "@/lib/promote/route-guard";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/promote/tests/[id] (get_version_comparison, admin; docs/IG-PAGE-ADS-SPEC.md 3.8, 4.8, PRM-12): one comparison of the
 * workspace, each version's spend, results and cost per result, and the verdict ("Version B gets chats at ₹38 vs ₹55: likely
 * winner." or "Too early to tell."). Stored rows only: no Meta call.
 */
export const GET = promoteRoute<Ctx>(
  "read",
  async ({ actor }, request, { params }) => {
    refuseCrossSite(request);
    const { id } = await params;
    return Response.json({ comparison: await getComparison(actor.tenantId, id) }, { headers: { "cache-control": "no-store" } });
  },
  { minRole: "admin" },
);
