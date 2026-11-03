import { siteUrl } from "@/lib/config";
import { pageLang } from "@/lib/promote/copy";
import { checkPromotionSetup } from "@/lib/promote/prereqs";
import { promoteRoute } from "@/lib/promote/route-guard";
import { HttpError } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/** Reads carry no state change, but their answers are the workspace's own: another site's page may not ask for them. */
function refuseCrossSite(request: Request): void {
  const site = request.headers.get("sec-fetch-site");
  const origin = request.headers.get("origin");
  let foreign = site === "cross-site" || site === "same-site";
  if (!foreign && origin) {
    try {
      foreign = new URL(origin).host !== new URL(siteUrl()).host;
    } catch {
      foreign = true;
    }
  }
  if (foreign) throw new HttpError(403, "This request could not be verified. Reload the page and try again.");
}

const id = (v: string | null) => (v && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : null);
const flag = (v: string | null) => v === "1" || v === "true";

/**
 * GET /api/promote/prereqs?goal=&pageAssetId=&igAssetId=&placements=auto|instagram|facebook&nearShop=1&customAudience=1
 * (docs/IG-PAGE-ADS-SPEC.md 3.2, 8.3a; Eddy's check_promotion_setup). Admins and owners only. Every readiness row of the goal,
 * ok, missing or unknown, each with one fix (Opens Meta addresses resolved here from the allowlist), and `ready` when nothing
 * blocks Start. Hidden (404) while PROMOTE_ENABLED keeps the feature from this member.
 */
export const GET = promoteRoute(
  "read",
  async ({ actor, access }, request) => {
    refuseCrossSite(request);
    const p = new URL(request.url).searchParams;
    const placements = p.get("placements");
    if (placements !== null && placements !== "auto" && placements !== "instagram" && placements !== "facebook") throw new HttpError(400, "Choose automatic, Instagram only or Facebook only.");
    const result = await checkPromotionSetup(actor, {
      goal: p.get("goal"),
      pageAssetId: id(p.get("pageAssetId")),
      igAssetId: id(p.get("igAssetId")),
      placements: placements ?? undefined,
      nearShop: flag(p.get("nearShop")),
      customAudience: flag(p.get("customAudience")),
      websiteAudience: flag(p.get("websiteAudience")),
      saysHasInstagram: flag(p.get("hasInstagram")),
      lang: pageLang(p.get("lang"), access.pageLangs),
    });
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  },
  { minRole: "admin" },
);
