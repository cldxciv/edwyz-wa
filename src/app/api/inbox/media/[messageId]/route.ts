import { getActor } from "@/lib/auth";
import { createLimiter } from "@/lib/ratelimit";
import { prisma } from "@/lib/db";
import { serveInboundMedia } from "@/lib/inbox/media";
import { conversationScopeFor } from "@/lib/teams/visibility";
import { errorResponse, HttpError } from "@/lib/tenancy";

const limiter = createLimiter(600, 60_000, "inbox-media");

/**
 * GET (any member). Streams the media of a message of the caller's workspace: image, video, audio or a document download.
 * 404 for a message of another workspace or without Meta media. The Meta link and token never reach the browser.
 */
export async function GET(request: Request, { params }: { params: Promise<{ messageId: string }> }) {
  try {
    const actor = await getActor(request);
    if (!limiter.consume(`${actor.tenantId}:${actor.userId}`)) throw new HttpError(429, "Too many requests. Wait a moment and try again.");
    const { messageId } = await params;
    const scope = await conversationScopeFor(actor);
    return await serveInboundMedia(request, actor.tenantId, messageId, (tenantId, id) =>
      prisma.message.findFirst({ where: { id, tenantId, ...(scope ? { conversation: scope } : {}) }, select: { mediaUrl: true, mediaMime: true } }),
    );
  } catch (e) {
    return errorResponse(e);
  }
}
