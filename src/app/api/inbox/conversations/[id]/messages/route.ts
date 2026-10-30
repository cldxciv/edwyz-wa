import { getActor } from "@/lib/auth";
import { assertConversationVisible } from "@/lib/teams/visibility";
import { CONTENT_TYPE_BY_EXT, mediaExists, mediaPublicUrl } from "@/lib/content/media";
import { MEDIA_KEY_PATTERN, mediaKind } from "@/lib/content/limits";
import { assertSameOrigin, optString, readJson, reqString } from "@/lib/inbox/http";
import { MEDIA_TYPES, sendMedia, sendText, type MediaType } from "@/lib/inbox/service";
import { signatureForUser } from "@/lib/inbox/settings";
import { assertCanActOnConversation } from "@/lib/inbox/status";
import { sendConversationTemplate } from "@/lib/inbox/template-send";
import { errorResponse, HttpError } from "@/lib/tenancy";

/** An uploaded attachment (see ../attachments) is referenced by its key; the signed link Meta fetches is built here. */
async function resolveUploadedMedia(tenantId: string, type: string, key: string) {
  if (!MEDIA_KEY_PATTERN.test(key) || mediaKind(key) !== type || !(await mediaExists(tenantId, key))) {
    throw new HttpError(400, "That attachment is no longer available. Attach the file again.");
  }
  return { media: mediaPublicUrl(tenantId, key), mime: CONTENT_TYPE_BY_EXT[key.split(".")[1]] };
}

/**
 * POST { type: "text", body }
 *   or { type: "image"|"document"|"audio"|"video"|"sticker", media | mediaId, caption?, filename?, mime? } (mediaId from POST ../attachments)
 *   or { type: "image"|"video", mediaKey, caption? } (mediaKey from POST ../attachments)
 *   or { type: "template", templateId, variables?: string[] } (approved template, allowed outside the window)
 * media is a Meta media id or an https URL. 409 when the 24-hour window is closed. -> 201 { message }
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    const { id } = await params;
    await assertConversationVisible(actor, id);
    await assertCanActOnConversation(actor, id);
    const body = await readJson(request);
    const base = { tenantId: actor.tenantId, conversationId: id, userId: actor.userId };
    const type = body.type ?? "text";

    if (type === "text") {
      const message = await sendText({ ...base, body: reqString(body, "body", 4096), signature: await signatureForUser(actor.tenantId, actor.userId), origin: "human" });
      return Response.json({ message }, { status: 201 });
    }
    if (type === "template") {
      const message = await sendConversationTemplate(actor, id, { templateId: reqString(body, "templateId", 100), variables: body.variables }, { origin: "human" });
      return Response.json({ message }, { status: 201 });
    }
    if (typeof type !== "string" || !(MEDIA_TYPES as readonly string[]).includes(type)) throw new HttpError(400, "Unsupported message type.");
    const uploaded = typeof body.mediaKey === "string" ? await resolveUploadedMedia(actor.tenantId, type, body.mediaKey) : null;
    const mediaId = typeof body.mediaId === "string" ? body.mediaId : null;
    if (mediaId !== null && !/^[A-Za-z0-9_-]{1,64}$/.test(mediaId)) throw new HttpError(400, "mediaId is not valid.");
    const media = uploaded?.media ?? (mediaId ? `meta-media:${mediaId}` : reqString(body, "media", 2048));
    if (/^[a-z]+:/i.test(media) && !/^(https:\/\/|meta-media:)/i.test(media)) throw new HttpError(400, "media must be a media id or an https URL.");
    const message = await sendMedia({
      ...base,
      mediaType: type as MediaType,
      media,
      caption: optString(body, "caption", 1024),
      filename: optString(body, "filename", 255),
      mime: uploaded?.mime ?? optString(body, "mime", 100),
      origin: "human",
    });
    return Response.json({ message }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
