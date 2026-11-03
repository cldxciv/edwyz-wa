import { audit } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { readJsonLimited } from "@/lib/http/body";
import { type AdMediaStatus, isAdMediaSource, listAdMedia, MEDIA_MESSAGES, prepare, takePrepareSlot } from "@/lib/promote/media";
import { promoteRoute } from "@/lib/promote/route-guard";
import { isAdFormat, isPlacementKey, type PlacementKey } from "@/lib/promote/types";
import { HttpError } from "@/lib/tenancy";

/**
 * Ad media (docs/IG-PAGE-ADS-SPEC.md 4.8, 6.4, PRM-06). Classified by the /api/promote/** entry of src/lib/actions/not-exposed.ts
 * until PRM-13 registers the actions.
 *
 * GET (list_ad_media, admin): { media: AdMediaView[] }, newest first. By default the media of the workspace's spending ad
 *   account (or all of it when none is chosen); ?account=all lists every ad account. Optional ?kind=image|video, ?status=, ?limit=.
 * POST (prepare_ad_media, admin, same origin; agents get 403): { from: 'content'|'creative'|'crop', key | assetId, placements?,
 *   format? }. Sends a library file to the spending ad account on Meta (D34: picking or cropping is the member's tap). 30 an
 *   hour per workspace (429 after). 201 with { media } for a new item, 200 for one already prepared (one row per file per
 *   account). Byte uploads stay on /api/content/media (a crop with ?purpose=ad_crop: `from: 'crop'` alone never makes a file
 *   ad-only). The answer comes well inside the proxy's 60 s: an image's send is awaited at most PREPARE_SEND_WAIT_MS (40 s)
 *   and then answered `uploading` while it goes on; a video is answered `pending` and sent by the promote.media task. The page
 *   polls GET /api/promote/media/[id] until the item is ready.
 */

const noStore = { "cache-control": "no-store" };
const STATUSES: readonly AdMediaStatus[] = ["pending", "uploading", "processing", "ready", "invalid", "error"];
const MAX_BODY = 8 * 1024;

const text = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/** The workspace's spending ad account (D3: every ad runs from it), or null when none is chosen. */
async function spendingAccount(tenantId: string): Promise<string | null> {
  const control = await prisma.spendControl.findUnique({ where: { tenantId }, select: { spendingAdAccountAssetId: true } });
  return control?.spendingAdAccountAssetId ?? null;
}

export const GET = promoteRoute(
  "read",
  async ({ actor }, request) => {
    const q = new URL(request.url).searchParams;
    const kind = q.get("kind");
    const status = q.get("status");
    const limit = Number(q.get("limit") ?? 50);
    const media = await listAdMedia(actor.tenantId, {
      adAccountAssetId: q.get("account") === "all" ? null : await spendingAccount(actor.tenantId),
      kind: kind === "image" || kind === "video" ? kind : null,
      status: STATUSES.includes(status as AdMediaStatus) ? (status as AdMediaStatus) : null,
      limit: Number.isFinite(limit) ? limit : 50,
    });
    return Response.json({ media }, { headers: noStore });
  },
  { minRole: "admin" },
);

export const POST = promoteRoute("write", async ({ actor }, request) => {
  takePrepareSlot(actor.tenantId);
  const body = await readJsonLimited(request, MAX_BODY);
  const source = body.from ?? body.source;
  if (!isAdMediaSource(source)) throw new HttpError(400, MEDIA_MESSAGES.chooseSource);
  const placements = body.placements ?? [];
  if (!Array.isArray(placements) || !placements.every(isPlacementKey)) throw new HttpError(400, MEDIA_MESSAGES.choosePlacements);
  if (body.format !== undefined && body.format !== null && !isAdFormat(body.format)) throw new HttpError(400, "Choose a valid ad format.");
  const account = await spendingAccount(actor.tenantId);
  if (!account) throw new HttpError(409, MEDIA_MESSAGES.chooseAccount);
  const { media, created } = await prepare(
    actor.tenantId,
    account,
    { source, key: text(body.key), assetId: text(body.assetId), format: isAdFormat(body.format) ? body.format : null },
    placements as PlacementKey[],
    { userId: actor.userId },
  );
  await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "promote.media.prepare", target: media.id, meta: { kind: media.kind, source: media.source, status: media.status } });
  return Response.json({ media }, { status: created ? 201 : 200, headers: noStore });
});
