import { prisma } from "@/lib/db";
import { GraphError, graphUpload } from "@/lib/graph";
import { HttpError } from "@/lib/tenancy";
import {
  attachmentProblem,
  classifyAttachment,
  formatLimit,
  matchesSignature,
  safeFileName,
  stickerLimit,
  type AttachmentKind,
} from "./attachments";

export type UploadedAttachment = { mediaId: string; kind: AttachmentKind; mime: string; bytes: number; filename: string };

const MAX_CONCURRENT_UPLOADS = 3;
let active = 0;

async function readLimited(request: Request, limit: number, tooBig: string): Promise<Buffer> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > limit) throw new HttpError(413, tooBig);
  if (!request.body) throw new HttpError(400, "The upload is empty.");
  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new HttpError(413, tooBig);
    }
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  }
  return Buffer.concat(chunks, total);
}

function nameFromHeader(request: Request): string {
  const raw = request.headers.get("x-file-name");
  if (!raw) return "file";
  try {
    return safeFileName(decodeURIComponent(raw));
  } catch {
    return safeFileName(raw);
  }
}

/**
 * Reads the raw request body (Content-Type is the file's type, X-File-Name its URL-encoded name), applies the WhatsApp size
 * and type rules, and uploads it to Meta with the workspace's token. Returns the media id to send with POST ../messages.
 * Nothing is stored on our disk. At most three uploads run at once per process because the file is held in memory.
 */
export async function uploadAttachmentToMeta(tenantId: string, conversationId: string, request: Request): Promise<UploadedAttachment> {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, tenantId },
    select: { phoneNumber: { select: { phoneNumberId: true } } },
  });
  if (!conversation) throw new HttpError(404, "Conversation not found.");

  const declaredType = request.headers.get("content-type") ?? "";
  const cls = classifyAttachment(declaredType);
  const declaredSize = Number(request.headers.get("content-length") ?? 0);
  const upFront = attachmentProblem({ type: declaredType, size: declaredSize > 0 ? declaredSize : 1 });
  if (!cls || upFront) throw new HttpError(cls ? 413 : 415, upFront ?? "That file type is not supported.");

  if (active >= MAX_CONCURRENT_UPLOADS) throw new HttpError(429, "Other files are uploading. Try again in a moment.");
  active += 1;
  try {
    const bytes = await readLimited(request, cls.maxBytes, `This file is larger than the ${formatLimit(cls.maxBytes)} WhatsApp allows.`);
    if (bytes.length === 0) throw new HttpError(400, "The upload is empty.");
    const head = bytes.subarray(0, 64);
    if (!matchesSignature(cls.mime, head)) throw new HttpError(400, "The file content does not match its type.");
    if (cls.kind === "sticker" && bytes.length > stickerLimit(head)) {
      throw new HttpError(413, `Stickers can be up to ${formatLimit(stickerLimit(head))}. Animated stickers can be up to 500 KB.`);
    }
    const filename = nameFromHeader(request);
    let id: string | undefined;
    try {
      const res = await graphUpload<{ id?: string }>({
        tenantId,
        path: `${conversation.phoneNumber.phoneNumberId}/media`,
        fields: { messaging_product: "whatsapp", type: cls.mime },
        file: { bytes, filename, mime: cls.mime },
      });
      id = typeof res?.id === "string" ? res.id : undefined;
    } catch (e) {
      if (e instanceof GraphError && e.status >= 400 && e.status < 500) throw new HttpError(422, "WhatsApp did not accept this file. Check its type and size, then try again.");
      throw new HttpError(502, "We could not upload this file to WhatsApp. Try again.");
    }
    if (!id || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new HttpError(502, "We could not upload this file to WhatsApp. Try again.");
    return { mediaId: id, kind: cls.kind, mime: cls.mime, bytes: bytes.length, filename };
  } finally {
    active -= 1;
  }
}
