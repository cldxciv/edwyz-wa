import { getActor } from "@/lib/auth";
import { assertConversationVisible } from "@/lib/teams/visibility";
import { createLimiter } from "@/lib/ratelimit";
import { saveUpload } from "@/lib/content/media";
import { prisma } from "@/lib/db";
import { attachmentProblem, classifyAttachment } from "@/lib/inbox/attachments";
import { assertSameOrigin } from "@/lib/inbox/http";
import { uploadAttachmentToMeta } from "@/lib/inbox/upload";
import { errorResponse, HttpError } from "@/lib/tenancy";

const limiter = createLimiter(30, 60_000, "inbox-upload");

/** JPEG, PNG and MP4 go through the workspace media library (a preview link is kept); everything else is uploaded straight to WhatsApp. */
const LIBRARY_TYPES = new Set(["image/jpeg", "image/png", "video/mp4"]);

/**
 * POST raw file body (any member). Content-Type is the file's type; X-File-Name is its URL-encoded name.
 * WhatsApp limits apply: photos 5 MB (JPEG, PNG), videos 16 MB (MP4), audio 16 MB (MP3, AAC, AMR, OGG), documents 100 MB
 * (PDF, Word, Excel, PowerPoint, text), stickers 100 KB (500 KB animated) as WebP. MOV is refused.
 * -> 201 { key, kind, bytes }                       for JPEG, PNG and MP4: send with POST ../messages { type: kind, mediaKey: key }
 * -> 201 { mediaId, kind, bytes, filename, mime }   for the rest: send with POST ../messages { type: kind, mediaId, filename?, caption? }
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    if (!limiter.consume(`${actor.tenantId}:${actor.userId}`)) throw new HttpError(429, "Too many uploads. Wait a minute and try again.");
    const { id } = await params;
    await assertConversationVisible(actor, id);
    const conversation = await prisma.conversation.findFirst({ where: { id, tenantId: actor.tenantId }, select: { id: true } });
    if (!conversation) throw new HttpError(404, "Conversation not found.");

    const cls = classifyAttachment(request.headers.get("content-type"));
    if (cls && LIBRARY_TYPES.has(cls.mime)) {
      const declared = Number(request.headers.get("content-length") ?? 0);
      if (!(declared > 0)) throw new HttpError(411, "The file size is missing. Try attaching it again.");
      const problem = attachmentProblem({ type: cls.mime, size: declared });
      if (problem) throw new HttpError(413, problem);
      return Response.json(await saveUpload(actor.tenantId, request), { status: 201 });
    }
    return Response.json(await uploadAttachmentToMeta(actor.tenantId, id, request), { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
