import { audit } from "@/lib/auth/audit";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { HEADER_KINDS, type HeaderKind, uploadBroadcastMedia } from "@/lib/broadcasts/media";
import { createLimiter } from "@/lib/ratelimit";
import { MAX_UPLOAD_BYTES, readBytesLimited } from "@/lib/templates/upload";
import { HttpError, errorResponse, requireRole } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/** Each upload sends up to 16 MB to Meta, and a broadcast needs one file, so a workspace gets a handful per ten minutes. */
const tenantLimiter = createLimiter(20, 10 * 60_000, "broadcast-media-tenant");
const userLimiter = createLimiter(10, 60_000, "broadcast-media-user");

function fileName(raw: string | null): string {
  try {
    return decodeURIComponent(raw ?? "file").slice(0, 200);
  } catch {
    return "file";
  }
}

/**
 * POST ?phoneNumberId=<number>&type=image|video|document. Uploads the file a broadcast's header shows to WhatsApp for that number
 * and returns { media: { id, type, mime, filename, bytes, uploadedAt, phoneNumberId } } for the value mapping. The file is the raw
 * request body; its type and name come from the content-type and x-file-name headers. Nothing is stored here.
 */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const url = new URL(request.url);
    const phoneNumberId = url.searchParams.get("phoneNumberId") ?? "";
    if (!phoneNumberId || phoneNumberId.length > 64) throw new HttpError(400, "Choose the WhatsApp number you send from first.");
    const type = url.searchParams.get("type");
    if (type !== null && !(HEADER_KINDS as readonly string[]).includes(type)) throw new HttpError(400, "The file type is not one a template header shows.");
    if (!(await userLimiter.consumeShared(`${actor.tenantId}:${actor.userId}`)) || !(await tenantLimiter.consumeShared(actor.tenantId))) {
      throw new HttpError(429, "Too many uploads. Wait a few minutes and try again.");
    }
    const mime = request.headers.get("content-type") ?? "";
    if (!mime) throw new HttpError(400, "The file type is missing.");
    const bytes = await readBytesLimited(request, MAX_UPLOAD_BYTES);
    const media = await uploadBroadcastMedia(actor, phoneNumberId, type as HeaderKind | null, { bytes, mime, filename: fileName(request.headers.get("x-file-name")) });
    await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "broadcast.media_uploaded", meta: { type: media.type, bytes: media.bytes } });
    return Response.json({ media });
  } catch (e) {
    return errorResponse(e);
  }
}
