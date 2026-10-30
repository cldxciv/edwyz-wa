import { audit } from "@/lib/auth/audit";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { MAX_UPLOAD_BYTES, readBytesLimited, uploadTemplateHeaderSample } from "@/lib/templates/upload";
import { createLimiter } from "@/lib/ratelimit";
import { HttpError, errorResponse, requireRole } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/** Each upload sends up to 16 MB to Meta, so a workspace gets a handful per ten minutes (a template needs one sample). */
const tenantLimiter = createLimiter(10, 10 * 60_000, "template-sample-tenant");
const userLimiter = createLimiter(5, 60_000, "template-sample-user");

function fileName(raw: string | null): string {
  try {
    return decodeURIComponent(raw ?? "sample").slice(0, 200);
  } catch {
    return "sample";
  }
}

/**
 * Uploads a sample image, video or document for a template header to Meta and returns its handle.
 * The file is the raw request body; its type and name come from the content-type and x-file-name headers. Nothing is stored here.
 */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    if (!userLimiter.consume(`${actor.tenantId}:${actor.userId}`) || !tenantLimiter.consume(actor.tenantId)) {
      throw new HttpError(429, "Too many sample uploads. Wait a few minutes and try again.");
    }
    const mime = request.headers.get("content-type") ?? "";
    if (!mime) throw new HttpError(400, "The file type is missing.");
    const bytes = await readBytesLimited(request, MAX_UPLOAD_BYTES);
    const media = await uploadTemplateHeaderSample(actor.tenantId, { bytes, mime, filename: fileName(request.headers.get("x-file-name")) });
    await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "template.sample_uploaded", meta: { type: media.type, bytes: bytes.byteLength } });
    return Response.json({ media });
  } catch (e) {
    return errorResponse(e);
  }
}
