import { readJsonLimited } from "@/lib/http/body";
import { previewsForActor } from "@/lib/promote/previews";
import { promoteRoute } from "@/lib/promote/route-guard";

/**
 * POST { draftId, adId? } or { spec }, plus placements[] (docs/IG-PAGE-ADS-SPEC.md 4.8 preview_ad, D18, 7.4, PRM-08).
 * Answers { call: "P1" | "P2" | null, previews: [{ placement, adFormat, source, approximate, label, src, cached, reason, mock }] }.
 * `src` is only ever Meta's preview page (the allowlisted iframe src); every other tab is the local mock flagged approximate.
 * Admins and owners, through the promote route guard (same origin, 404 while the feature is hidden, 403 for agents). It reads
 * from Meta and writes nothing, so it answers the same under SPEND_DRY_RUN. Classified by the /api/promote/** entry of
 * src/lib/actions/not-exposed.ts until PRM-13 gives it its action.
 */
export const POST = promoteRoute("write", async ({ actor }, request) => {
  const body = await readJsonLimited(request);
  return Response.json(await previewsForActor(actor, body), { headers: { "cache-control": "no-store" } });
});
