import { getAdMedia } from "@/lib/promote/media";
import { PROMOTE_NOT_FOUND, promoteRoute } from "@/lib/promote/route-guard";
import { HttpError } from "@/lib/tenancy";

/**
 * GET (get_ad_media, admin): { media: AdMediaView } for one item of the workspace (docs/IG-PAGE-ADS-SPEC.md 4.8, 6.4, PRM-06):
 * its status with one plain line, the fit chips ("Feed 4:5 ✓", "Stories and Reels 9:16: missing") and the problems. The page
 * polls it while Meta processes a video. Reads the database only; the promote.media task checks Meta. 404 for an item of
 * another workspace. Classified by the /api/promote/** entry of src/lib/actions/not-exposed.ts until PRM-13.
 */
export const GET = promoteRoute<{ params: Promise<{ id: string }> }>(
  "read",
  async ({ actor }, _request, { params }) => {
    const { id } = await params;
    const media = await getAdMedia(actor.tenantId, id);
    if (!media) throw new HttpError(404, PROMOTE_NOT_FOUND);
    return Response.json({ media }, { headers: { "cache-control": "no-store" } });
  },
  { minRole: "admin" },
);
