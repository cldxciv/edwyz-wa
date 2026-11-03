import { AUDIENCE_COPY, sizeForTargeting } from "@/lib/promote/audiences";
import { assertSizeRate } from "@/lib/promote/geo";
import { promoteRoute } from "@/lib/promote/route-guard";
import { HttpError } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/**
 * POST /api/promote/audiences/size {targeting, specialAdCategory?} (get_audience_size, admin; docs/IG-PAGE-ADS-SPEC.md 3.7,
 * 4.2 A9, 4.8): "About 1.2–1.8 lakh people", or "Size not available right now". Meta's reachestimate, kept 10 minutes; 20 a
 * minute per member. A POST only because the targeting is a body: it changes nothing.
 */
export const POST = promoteRoute("write", async ({ actor }, request) => {
  assertSizeRate(actor);
  const body = (await request.json().catch(() => null)) as { targeting?: unknown; specialAdCategory?: unknown } | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, AUDIENCE_COPY.targeting);
  const size = await sizeForTargeting(actor, body.targeting, body.specialAdCategory);
  return Response.json({ size }, { headers: { "cache-control": "no-store" } });
});
