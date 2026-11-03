import { ensurePageBackedInstagram } from "@/lib/meta-connect/service";
import { promoteRoute } from "@/lib/promote/route-guard";
import { createLimiter } from "@/lib/ratelimit";
import { HttpError } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/** Each tap can reach Meta twice and runs discovery again: a handful an hour per workspace is plenty. */
const taps = createLimiter(10, 3_600_000, "promote-ig-identity");

/**
 * POST /api/promote/fix/instagram-identity {pageAssetId} (docs/IG-PAGE-ADS-SPEC.md 3.2, 8.3; Eddy's create_instagram_identity,
 * a confirm card: X, I). "Run Instagram ads using your Page": makes the Page's ads-only Instagram identity (C8), once per Page
 * (a stored or listed one is reused), then refreshes discovery so it is listed. Admins and owners, same origin. Under
 * SPEND_DRY_RUN Meta answers with a fake id and nothing is stored.
 */
export const POST = promoteRoute("write", async ({ actor, dryRun }, request) => {
  const body = (await request.json().catch(() => null)) as { pageAssetId?: unknown } | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "Choose a Facebook Page first.");
  if (!(await taps.consumeShared(actor.tenantId))) throw new HttpError(429, "That's a lot of tries in an hour. Wait a while and try again.");
  const result = await ensurePageBackedInstagram(actor, body.pageAssetId, { dryRun });
  return Response.json(result, { headers: { "cache-control": "no-store" } });
});
