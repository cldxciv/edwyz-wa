/** WhatsApp Cloud API media rules for outbound attachments. Pure, so the browser and the server apply the same checks. */

export type AttachmentKind = "image" | "video" | "audio" | "document" | "sticker";

const MB = 1024 * 1024;

export const ATTACHMENT_LIMITS = {
  image: 5 * MB,
  video: 16 * MB,
  audio: 16 * MB,
  document: 100 * MB,
  stickerStatic: 100 * 1024,
  stickerAnimated: 500 * 1024,
} as const;

const IMAGE_TYPES = ["image/jpeg", "image/png"];
const VIDEO_TYPES = ["video/mp4", "video/3gpp"];
const AUDIO_TYPES = ["audio/aac", "audio/mp4", "audio/mpeg", "audio/amr", "audio/ogg"];
const DOCUMENT_TYPES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
];

export const ACCEPTED_ATTACHMENT_TYPES: readonly string[] = [...IMAGE_TYPES, "image/webp", ...VIDEO_TYPES, ...AUDIO_TYPES, ...DOCUMENT_TYPES];

export const normalizeMime = (raw: string | null | undefined) => (raw ?? "").split(";")[0].trim().toLowerCase();

export type AttachmentClass = { kind: AttachmentKind; mime: string; maxBytes: number };

/** The WhatsApp kind and size limit for a mime type, or null when WhatsApp does not accept it. A webp image is sent as a sticker. */
export function classifyAttachment(rawMime: string | null | undefined): AttachmentClass | null {
  const mime = normalizeMime(rawMime);
  if (IMAGE_TYPES.includes(mime)) return { kind: "image", mime, maxBytes: ATTACHMENT_LIMITS.image };
  if (mime === "image/webp") return { kind: "sticker", mime, maxBytes: ATTACHMENT_LIMITS.stickerAnimated };
  if (VIDEO_TYPES.includes(mime)) return { kind: "video", mime, maxBytes: ATTACHMENT_LIMITS.video };
  if (AUDIO_TYPES.includes(mime)) return { kind: "audio", mime, maxBytes: ATTACHMENT_LIMITS.audio };
  if (DOCUMENT_TYPES.includes(mime)) return { kind: "document", mime, maxBytes: ATTACHMENT_LIMITS.document };
  return null;
}

export function formatLimit(bytes: number): string {
  return bytes >= MB ? `${Math.round(bytes / MB)} MB` : `${Math.round(bytes / 1024)} KB`;
}

export const UNSUPPORTED_ATTACHMENT =
  "WhatsApp accepts JPEG or PNG photos, MP4 videos, PDF, Word, Excel, PowerPoint or text documents, MP3, AAC, AMR or OGG audio, and WebP stickers.";

const KIND_LABEL: Record<AttachmentKind, string> = { image: "Photos", video: "Videos", audio: "Audio files", document: "Documents", sticker: "Stickers" };

/** A plain-language problem with a file the agent picked, or null when it can be sent. */
export function attachmentProblem(file: { type: string; size: number }): string | null {
  const cls = classifyAttachment(file.type);
  if (!cls) return normalizeMime(file.type) === "video/quicktime" ? "WhatsApp does not accept MOV videos. Export the video as MP4 and try again." : UNSUPPORTED_ATTACHMENT;
  if (file.size === 0) return "That file is empty.";
  if (file.size > cls.maxBytes) return `${KIND_LABEL[cls.kind]} can be up to ${formatLimit(cls.maxBytes)}. This file is ${formatLimit(file.size)}.`;
  return null;
}

/** WebP files carry an ANIM chunk in the header when they are animated. Animated stickers may be 500 KB, static ones 100 KB. */
export function isAnimatedWebp(head: Uint8Array): boolean {
  return ascii(head, 0, Math.min(head.length, 64)).includes("ANIM");
}

export function stickerLimit(head: Uint8Array): number {
  return isAnimatedWebp(head) ? ATTACHMENT_LIMITS.stickerAnimated : ATTACHMENT_LIMITS.stickerStatic;
}

const startsWith = (head: Uint8Array, bytes: number[]) => bytes.every((b, i) => head[i] === b);
const ascii = (head: Uint8Array, from: number, to: number) => String.fromCharCode(...head.subarray(from, to));

/** True when the first bytes plausibly belong to the declared type. Plain text has no signature and is accepted. */
export function matchesSignature(mime: string, head: Uint8Array): boolean {
  if (head.length === 0) return false;
  if (mime === "text/plain") return true;
  if (head.length < 12) return false;
  switch (mime) {
    case "image/jpeg":
      return startsWith(head, [0xff, 0xd8, 0xff]);
    case "image/png":
      return startsWith(head, [0x89, 0x50, 0x4e, 0x47]);
    case "image/webp":
      return ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 12) === "WEBP";
    case "video/mp4":
    case "audio/mp4":
    case "video/3gpp":
      return ascii(head, 4, 8) === "ftyp";
    case "audio/ogg":
      return ascii(head, 0, 4) === "OggS";
    case "audio/mpeg":
      return ascii(head, 0, 3) === "ID3" || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0);
    case "audio/aac":
      return (head[0] === 0xff && (head[1] & 0xf0) === 0xf0) || ascii(head, 0, 3) === "ID3";
    case "audio/amr":
      return ascii(head, 0, 5) === "#!AMR";
    case "application/pdf":
      return ascii(head, 0, 4) === "%PDF";
    case "application/msword":
    case "application/vnd.ms-excel":
    case "application/vnd.ms-powerpoint":
      return startsWith(head, [0xd0, 0xcf, 0x11, 0xe0]);
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
    case "application/vnd.openxmlformats-officedocument.presentationml.presentation":
      return startsWith(head, [0x50, 0x4b]);
    default:
      return false;
  }
}

/** A file name safe to show and to send as the document name. */
export function safeFileName(raw: string | null | undefined, fallback = "file"): string {
  // eslint-disable-next-line no-control-regex
  const clean = (raw ?? "").replace(/[\x00-\x1f\\/:*?"<>|]+/g, "_").trim().slice(0, 100);
  return clean && clean !== "." && clean !== ".." ? clean : fallback;
}
