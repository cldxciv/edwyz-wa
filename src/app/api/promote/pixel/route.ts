import { siteUrl } from "@/lib/config";
import { promoteText } from "@/lib/promote/copy";
import { createOrReusePixel, currentPixel, PIXEL_COPY, PIXEL_CREATES_PER_DAY } from "@/lib/promote/pixel";
import { promoteRoute } from "@/lib/promote/route-guard";
import { createLimiter } from "@/lib/ratelimit";
import { HttpError } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/** 3 creates a day per workspace (docs/IG-PAGE-ADS-SPEC.md 4.8). A reuse counts too: each tap may reach Meta. */
const creates = createLimiter(PIXEL_CREATES_PER_DAY, 24 * 3_600_000, "promote-pixel-create");

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

const installHelp = () => promoteText("readiness.pixel_install");

/**
 * POST /api/promote/pixel {name} (Eddy's create_pixel, a confirm card; C9 then C7). Admins and owners, same origin, 3 a day per
 * workspace. Makes the spending ad account's pixel, or reuses the one it has, and returns its install code. Under
 * SPEND_DRY_RUN Meta answers with a fake id and nothing is stored.
 */
export const POST = promoteRoute("write", async ({ actor, dryRun }, request) => {
  const body = (await request.json().catch(() => null)) as { name?: unknown } | null;
  if (body !== null && (typeof body !== "object" || Array.isArray(body))) throw new HttpError(400, "Send the pixel's name as JSON.");
  if (!(await creates.consumeShared(actor.tenantId))) throw new HttpError(429, PIXEL_COPY.tooMany);
  const pixel = await createOrReusePixel(actor, body?.name, { dryRun });
  return Response.json({ pixel, installHelp: installHelp(), ...(pixel.code || dryRun ? {} : { notice: PIXEL_COPY.noCode }) }, { headers: { "cache-control": "no-store" } });
});

/** GET /api/promote/pixel: the spending account's pixel and its install code, or null. Nothing is created. Admins and owners. */
export const GET = promoteRoute(
  "read",
  async ({ actor, dryRun }, request) => {
    refuseCrossSite(request);
    const pixel = await currentPixel(actor, { dryRun });
    return Response.json({ pixel, installHelp: installHelp() }, { headers: { "cache-control": "no-store" } });
  },
  { minRole: "admin" },
);
