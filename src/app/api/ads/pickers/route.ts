import { getActor } from "@/lib/auth";
import { isPickerKind, listAllLeadForms, listInstagramMedia, listLeadForms, listPagePosts, searchCities, searchInterests } from "@/lib/ads/pickers";
import { errorResponse, HttpError, requireRole } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/**
 * GET (admin) read-only Meta pickers for the campaign wizard and the Lead forms page:
 * - ?kind=posts&page=<pageAssetId>              the Page's published posts
 * - ?kind=instagram_media&instagram=<assetId>   the Instagram account's posts
 * - ?kind=lead_forms[&page=<pageAssetId>]       lead forms (of one Page, or of every connected Page); each is registered as a
 *                                               LeadForm row, an idempotent bookkeeping write, so it shows before its first lead
 * - ?kind=interests&account=<adAccountAssetId>&q=<text>
 * - ?kind=cities&account=<adAccountAssetId>&q=<text>[&country=IN]
 */
export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const p = new URL(request.url).searchParams;
    const kind = p.get("kind");
    if (!isPickerKind(kind)) throw new HttpError(400, "kind must be posts, instagram_media, lead_forms, interests or cities.");
    const t = actor.tenantId;
    const headers = { "cache-control": "no-store" };
    switch (kind) {
      case "posts":
        return Response.json({ items: await listPagePosts(t, p.get("page")) }, { headers });
      case "instagram_media":
        return Response.json({ items: await listInstagramMedia(t, p.get("instagram")) }, { headers });
      case "lead_forms":
        return Response.json(p.get("page") ? { items: await listLeadForms(t, p.get("page")), problems: [] } : await listAllLeadForms(t), { headers });
      case "interests":
        return Response.json({ items: await searchInterests(t, p.get("account"), p.get("q")) }, { headers });
      case "cities":
        return Response.json({ items: await searchCities(t, p.get("account"), p.get("q"), p.get("country")) }, { headers });
    }
  } catch (e) {
    return errorResponse(e);
  }
}
