import { siteUrl } from "@/lib/config";
import { pageLang } from "@/lib/promote/copy";
import { promoteRoute } from "@/lib/promote/route-guard";
import { assertSourcesRate, isSourceApp, isSourceKind, listSources } from "@/lib/promote/sources";
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

/**
 * GET /api/promote/sources?source=instagram|facebook&kind=reel|post|story&cursor=&pageAssetId=&igAssetId=&limit=
 * (docs/IG-PAGE-ADS-SPEC.md 3.3, 4.8; Eddy's list_boostable_posts). Admins and owners only, 60 a minute per member. Posts come
 * newest first, 25 at a time, each with its boost eligibility in plain words, the ₹ badge, "Made in Edwyz", and its caption
 * as untrusted text. Hidden (404) while PROMOTE_ENABLED keeps the feature from this member.
 */
export const GET = promoteRoute(
  "read",
  async ({ actor, access }, request) => {
    refuseCrossSite(request);
    assertSourcesRate(actor);
    const p = new URL(request.url).searchParams;
    const source = p.get("source") || null;
    const kind = p.get("kind") || null;
    if (source !== null && !isSourceApp(source)) throw new HttpError(400, "Choose Instagram or Facebook.");
    if (kind !== null && !isSourceKind(kind)) throw new HttpError(400, "Choose reels, posts or stories.");
    const limit = Number(p.get("limit") ?? "");
    const result = await listSources(actor.tenantId, {
      source,
      kind,
      cursor: p.get("cursor") || null,
      pageAssetId: id(p.get("pageAssetId")),
      igAssetId: id(p.get("igAssetId")),
      limit: Number.isInteger(limit) && limit > 0 ? limit : undefined,
      lang: pageLang(p.get("lang"), access.pageLangs),
    });
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  },
  { minRole: "admin" },
);
