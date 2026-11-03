import { getActor } from "@/lib/auth";
import { assertConversationVisible } from "@/lib/teams/visibility";
import { createLimiter } from "@/lib/ratelimit";
import { prisma } from "@/lib/db";
import { assertSameOrigin } from "@/lib/inbox/http";
import { uploadAttachmentToMeta } from "@/lib/inbox/upload";
import { errorResponse, HttpError } from "@/lib/tenancy";

const limiter = createLimiter(30, 60_000, "inbox-upload");

/**
 * POST raw file body (any member). Content-Type is the file's type; X-File-Name is its URL-encoded name.
 * WhatsApp limits apply: photos 5 MB (JPEG, PNG), videos 16 MB (MP4), audio 16 MB (MP3, AAC, AMR, OGG), documents 100 MB
 * (PDF, Word, Excel, PowerPoint, text), stickers 100 KB (500 KB animated) as WebP. MOV is refused.
 * Every file, photos and videos included, is uploaded straight to WhatsApp: none goes into the workspace's media library, so
 * its 500-file limit can never stop a send. The chat's preview copy expires on its own (lib/inbox/media.ts).
 * -> 201 { mediaId, kind, bytes, filename, mime }   send with POST ../messages { type: kind, mediaId, filename?, mime?, caption? }
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
    return Response.json(await uploadAttachmentToMeta(actor.tenantId, id, request), { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
