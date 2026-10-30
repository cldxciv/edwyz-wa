import { audit } from "@/lib/auth/audit";
import { getActor } from "@/lib/auth";
import { buildChatExport, EXPORT_FORMATS, type ExportFormat } from "@/lib/inbox/export";
import { createLimiter } from "@/lib/ratelimit";
import { assertConversationVisible, shouldMaskFor } from "@/lib/teams/visibility";
import { errorResponse, HttpError } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

const limiter = createLimiter(10, 60_000, "inbox-export");

/**
 * GET ?format=txt|json&notes=1 -> the chat as a download (attachment). Notes are included only with notes=1.
 * The file holds message text, never media files or links. The export is recorded in the audit log (no content).
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await getActor(request);
    const { id } = await params;
    const p = new URL(request.url).searchParams;
    const format = (p.get("format") ?? "txt") as ExportFormat;
    if (!(EXPORT_FORMATS as readonly string[]).includes(format)) throw new HttpError(400, "format must be txt or json.");
    if (!limiter.consume(`${actor.tenantId}:${actor.userId}`)) throw new HttpError(429, "Too many downloads. Wait a minute and try again.");
    await assertConversationVisible(actor, id);
    const file = await buildChatExport(actor.tenantId, id, { format, includeNotes: p.get("notes") === "1", masked: await shouldMaskFor(actor) });
    await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "inbox.chat.exported", target: id, meta: { format, items: file.count, notes: p.get("notes") === "1" } });
    return new Response(file.body, {
      headers: {
        "content-type": file.contentType,
        "content-disposition": `attachment; filename="${file.fileName}"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
