import { getAccessToken } from "@/lib/crypto/tokens";
import { GRAPH_API_VERSION } from "@/lib/config";
import { appSecretProof } from "@/lib/graph";
import { HttpError } from "@/lib/tenancy";

/*
 * Sample media for a template header. Meta wants an example file when a template with an image, video or document header is
 * submitted, and hands back a handle from its resumable upload API. The file itself is not kept: broadcasts send the header
 * from a link, per recipient or the same for everyone (see lib/broadcasts/mapping.ts).
 */

export type HeaderMediaType = "IMAGE" | "VIDEO" | "DOCUMENT";

export const MEDIA_RULES: Record<HeaderMediaType, { mimes: string[]; maxBytes: number; label: string }> = {
  IMAGE: { mimes: ["image/jpeg", "image/png"], maxBytes: 5 * 1024 * 1024, label: "a JPG or PNG image up to 5 MB" },
  VIDEO: { mimes: ["video/mp4"], maxBytes: 16 * 1024 * 1024, label: "an MP4 video up to 16 MB" },
  DOCUMENT: { mimes: ["application/pdf"], maxBytes: 16 * 1024 * 1024, label: "a PDF up to 16 MB" },
};

export const MAX_UPLOAD_BYTES = 16 * 1024 * 1024;
const TIMEOUT_MS = 60_000;

export type HeaderMedia = { type: HeaderMediaType; handle: string; mime?: string; filename?: string };

export function mediaTypeForMime(mime: string): HeaderMediaType | null {
  const base = mime.split(";")[0].trim().toLowerCase();
  return (Object.keys(MEDIA_RULES) as HeaderMediaType[]).find((t) => MEDIA_RULES[t].mimes.includes(base)) ?? null;
}

/** True when the first bytes look like the claimed type, so a renamed file is not sent on as something else. */
export function looksLike(mime: string, head: Uint8Array): boolean {
  const at = (i: number, text: string) => text.split("").every((ch, k) => head[i + k] === ch.charCodeAt(0));
  switch (mime) {
    case "image/jpeg":
      return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    case "image/png":
      return head[0] === 0x89 && at(1, "PNG");
    case "application/pdf":
      return at(0, "%PDF");
    case "video/mp4":
      return at(4, "ftyp");
    default:
      return false;
  }
}

export function safeFilename(name: string): string {
  const clean = name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+/, "").slice(0, 80);
  return clean || "sample";
}

export function checkUpload(file: { bytes: Uint8Array; mime: string; filename: string }): { type: HeaderMediaType; mime: string; filename: string } {
  const mime = file.mime.split(";")[0].trim().toLowerCase();
  const type = mediaTypeForMime(mime);
  if (!type) throw new HttpError(400, "Use a JPG or PNG image, an MP4 video or a PDF document.");
  const rule = MEDIA_RULES[type];
  if (file.bytes.byteLength === 0) throw new HttpError(400, "That file is empty.");
  if (file.bytes.byteLength > rule.maxBytes) throw new HttpError(413, `The file is too large. Use ${rule.label}.`);
  if (!looksLike(mime, file.bytes.subarray(0, 16))) throw new HttpError(400, "The file does not look like its type. Export it again as " + rule.label + ".");
  return { type, mime, filename: safeFilename(file.filename) };
}

const fail = (status: number): never => {
  throw new HttpError(status >= 500 ? 502 : 400, "Meta did not accept the sample file. Try a different file, or try again in a moment.");
};

/** Uploads the sample to Meta (create an upload session, then send the bytes) and returns the handle for header_handle. */
export async function uploadTemplateHeaderSample(tenantId: string, file: { bytes: Uint8Array; mime: string; filename: string }): Promise<HeaderMedia> {
  const appId = process.env.META_APP_ID;
  if (!appId) throw new HttpError(503, "Uploading sample media is not set up on this server yet.");
  const checked = checkUpload(file);
  const token = await getAccessToken(tenantId);
  const base = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

  const sessionUrl = new URL(`${base}/${appId}/uploads`);
  sessionUrl.searchParams.set("file_length", String(file.bytes.byteLength));
  sessionUrl.searchParams.set("file_type", checked.mime);
  sessionUrl.searchParams.set("file_name", checked.filename);
  const proof = appSecretProof(token);
  if (proof) sessionUrl.searchParams.set("appsecret_proof", proof);
  const session = await call(sessionUrl.toString(), { method: "POST", headers: { Authorization: `Bearer ${token}` } });
  const sessionId = (session as { id?: unknown } | null)?.id;
  if (typeof sessionId !== "string" || !/^[A-Za-z0-9:_.\-]{1,200}$/.test(sessionId)) return fail(502);

  const copy = new Uint8Array(file.bytes.byteLength);
  copy.set(file.bytes);
  const sent = await call(`${base}/${sessionId}${proof ? `?appsecret_proof=${proof}` : ""}`, { method: "POST", headers: { Authorization: `OAuth ${token}`, file_offset: "0", "Content-Type": "application/octet-stream" }, body: copy });
  const handle = (sent as { h?: unknown } | null)?.h;
  if (typeof handle !== "string" || !handle) return fail(502);
  return { type: checked.type, handle, mime: checked.mime, filename: checked.filename };
}

/** One more try after a network error or a 5xx from Meta: both steps can be repeated safely (a new session, or the same bytes at offset 0). */
async function call(url: string, init: RequestInit, attempt = 1): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    if (attempt < 2) return call(url, init, attempt + 1);
    throw new HttpError(502, "We could not reach Meta to upload the sample file. Try again in a moment.");
  }
  const text = await response.text();
  if (!response.ok) {
    if (response.status >= 500 && attempt < 2) return call(url, init, attempt + 1);
    return fail(response.status);
  }
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return fail(502);
  }
}

/** Reads a request body as bytes, enforcing the byte limit while streaming. */
export async function readBytesLimited(request: Request, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > maxBytes) throw new HttpError(413, "The file is too large.");
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new HttpError(413, "The file is too large.");
    }
    chunks.push(value);
  }
  return new Uint8Array(Buffer.concat(chunks));
}
