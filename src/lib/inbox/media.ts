import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { getAccessToken } from "@/lib/crypto/tokens";
import { GraphError, graphFetch } from "@/lib/graph";
import { HttpError } from "@/lib/tenancy";
import { parseMediaRef } from "@/lib/webhooks/media";

export const MAX_INBOUND_MEDIA_BYTES = 25 * 1048576;
export const INBOUND_MEDIA_QUOTA_BYTES = 500 * 1048576;
export const MEDIA_TIMEOUT_MS = 15_000;
export const CACHE_CONTROL = "private, max-age=300";
const MAX_REDIRECTS = 3;
const STALE_PART_MS = 60 * 60_000;
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const UNAVAILABLE = "This file could not be loaded.";
const GONE = "This file is no longer available.";

/* ---------- mime narrowing ---------- */

const INLINE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/aac": "aac",
  "audio/amr": "amr",
  "audio/mp4": "m4a",
};
const DOWNLOAD: Record<string, string> = {
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "text/plain": "txt",
  "text/csv": "csv",
};

export type NarrowedMime = { mime: string; inline: boolean; ext: string };

/** Reduces whatever mime type was stored to the allow-list. Anything else is served as an opaque download. */
export function narrowMime(raw: string | null | undefined): NarrowedMime {
  const base = (raw ?? "").split(";")[0].trim().toLowerCase();
  if (INLINE[base]) return { mime: base, inline: true, ext: INLINE[base] };
  if (DOWNLOAD[base]) return { mime: base, inline: false, ext: DOWNLOAD[base] };
  return { mime: "application/octet-stream", inline: false, ext: "bin" };
}

/** Used only when neither the message nor Meta gave a mime type: recognises the few formats the proxy serves. */
export function sniffMime(head: Buffer): string | null {
  const text = (from: number, to: number) => head.subarray(from, to).toString("latin1");
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (head.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return "image/png";
  if (text(0, 3) === "GIF") return "image/gif";
  if (text(0, 4) === "RIFF" && text(8, 12) === "WEBP") return "image/webp";
  if (text(4, 8) === "ftyp") return "video/mp4";
  if (text(0, 4) === "OggS") return "audio/ogg";
  if (text(0, 4) === "%PDF") return "application/pdf";
  return null;
}

/* ---------- download from Meta ---------- */

/** A parsed URL when it is https on a Meta media host (no credentials, no custom port), otherwise null. */
export function parseAllowedMediaUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return null;
  const host = url.hostname.toLowerCase();
  const allowed = host === "lookaside.fbsbx.com" || host.endsWith(".fbcdn.net") || host.endsWith(".whatsapp.net");
  return allowed ? url : null;
}

type MediaInfo = { url: string; mime: string | null; size: number | null };

async function lookupMedia(tenantId: string, mediaId: string): Promise<MediaInfo> {
  let info: { url?: unknown; mime_type?: unknown; file_size?: unknown };
  try {
    info = await graphFetch<typeof info>({ tenantId, path: mediaId });
  } catch (e) {
    if (e instanceof GraphError && (e.status === 400 || e.status === 404)) throw new HttpError(404, GONE);
    throw new HttpError(502, UNAVAILABLE);
  }
  if (typeof info?.url !== "string") throw new HttpError(502, UNAVAILABLE);
  const size = Number(info.file_size);
  return { url: info.url, mime: typeof info.mime_type === "string" ? info.mime_type : null, size: Number.isFinite(size) ? size : null };
}

async function fetchFollowing(url: string, token: string, signal: AbortSignal): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const checked = parseAllowedMediaUrl(current);
    if (!checked) throw new HttpError(502, UNAVAILABLE);
    let res: Response;
    try {
      res = await fetch(checked.toString(), { headers: { Authorization: `Bearer ${token}` }, redirect: "manual", signal });
    } catch {
      throw new HttpError(502, UNAVAILABLE);
    }
    if (res.status < 300 || res.status >= 400) return res;
    const location = res.headers.get("location");
    await res.body?.cancel().catch(() => undefined);
    if (!location) throw new HttpError(502, UNAVAILABLE);
    try {
      current = new URL(location, checked).toString();
    } catch {
      throw new HttpError(502, UNAVAILABLE);
    }
  }
  throw new HttpError(502, UNAVAILABLE);
}

const TOO_BIG = `This file is larger than ${MAX_INBOUND_MEDIA_BYTES / 1048576} MB and cannot be previewed.`;

async function readCapped(res: Response, signal: AbortSignal): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_INBOUND_MEDIA_BYTES) {
    await res.body?.cancel().catch(() => undefined);
    throw new HttpError(413, TOO_BIG);
  }
  if (!res.body) throw new HttpError(502, UNAVAILABLE);
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_INBOUND_MEDIA_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new HttpError(413, TOO_BIG);
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(signal.aborted ? 504 : 502, UNAVAILABLE);
  }
  return Buffer.concat(chunks, total);
}

/** Resolves a Meta media id with the workspace's token and downloads it, never leaving Meta's media hosts. */
export async function downloadMetaMedia(tenantId: string, mediaId: string): Promise<{ bytes: Buffer; mime: string | null }> {
  const info = await lookupMedia(tenantId, mediaId);
  if (info.size !== null && info.size > MAX_INBOUND_MEDIA_BYTES) throw new HttpError(413, TOO_BIG);
  if (!parseAllowedMediaUrl(info.url)) throw new HttpError(502, UNAVAILABLE);
  let token: string;
  try {
    token = await getAccessToken(tenantId);
  } catch {
    throw new HttpError(502, UNAVAILABLE);
  }
  const signal = AbortSignal.timeout(MEDIA_TIMEOUT_MS);
  const res = await fetchFollowing(info.url, token, signal);
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    if (res.status === 404 || res.status === 410) throw new HttpError(404, GONE);
    throw new HttpError(502, UNAVAILABLE);
  }
  return { bytes: await readCapped(res, signal), mime: info.mime };
}

/* ---------- disk cache ---------- */

const dataRoot = () => path.resolve(process.env.DATA_DIR || "./data", "inbound-media");

/** DATA_DIR/inbound-media/<tenantId>, or null unless the id is plain. */
export function inboundMediaDir(tenantId: string): string | null {
  if (!SAFE_ID.test(tenantId)) return null;
  const root = dataRoot();
  const dir = path.resolve(root, tenantId);
  return dir.startsWith(root + path.sep) ? dir : null;
}

/** DATA_DIR/inbound-media/<tenantId>/<messageId>, or null unless both ids are plain. */
export function inboundMediaPath(tenantId: string, messageId: string): string | null {
  const dir = inboundMediaDir(tenantId);
  if (!dir || !SAFE_ID.test(messageId)) return null;
  const full = path.resolve(dir, messageId);
  return full.startsWith(dir + path.sep) ? full : null;
}

/**
 * Deletes files of one folder (never `keep`) until it fits the quota, oldest first; with maxAgeMs, anything older goes too.
 * Sub-folders are left alone, and partial writes are removed once they are an hour old.
 */
async function trimDir(dir: string, keep: string, quota: number, maxAgeMs: number | null = null, now = Date.now()): Promise<{ files: number; bytes: number }> {
  const out = { files: 0, bytes: 0 };
  const entries: { full: string; size: number; at: number }[] = [];
  // A file that cannot be removed (still open on some platforms) is skipped, not counted.
  const remove = async (full: string, size: number) => {
    if (!(await fs.rm(full, { force: true }).then(() => true, () => false))) return false;
    out.files += 1;
    out.bytes += size;
    return true;
  };
  for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
    const full = path.join(dir, name);
    const st = await fs.stat(full).catch(() => null);
    if (!st?.isFile()) continue;
    if (name.includes(".part-")) {
      if (now - st.mtimeMs > STALE_PART_MS) await fs.rm(full, { force: true });
      continue;
    }
    if (maxAgeMs !== null && name !== keep && now - st.mtimeMs > maxAgeMs && (await remove(full, st.size))) continue;
    entries.push({ full, size: st.size, at: st.mtimeMs });
  }
  let total = entries.reduce((sum, e) => sum + e.size, 0);
  for (const e of entries.sort((a, b) => a.at - b.at)) {
    if (total <= quota) break;
    if (path.basename(e.full) === keep) continue;
    if (await remove(e.full, e.size)) total -= e.size;
  }
  return out;
}

/**
 * Deletes the oldest cached files of a workspace until it fits the quota. Unsent copies of agents' uploads that are more than
 * a day old go at the same time (see trimPendingUploads below). Only counts are logged.
 */
export async function evictOldest(tenantId: string, keep: string, quota = INBOUND_MEDIA_QUOTA_BYTES): Promise<{ files: number; bytes: number }> {
  const dir = inboundMediaDir(tenantId);
  if (!dir) return { files: 0, bytes: 0 };
  const out = await trimDir(dir, keep, quota);
  if (out.files > 0) console.info("[inbound-media] evicted", { tenantId, files: out.files, bytes: out.bytes });
  await trimPendingUploads(tenantId).catch(() => undefined);
  return out;
}

/** Writes through a partial file and a rename, so a reader never sees half a file. False on any disk error. */
async function writeAtomic(file: string, bytes: Buffer): Promise<boolean> {
  const part = `${file}.part-${process.pid}-${Date.now()}`;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(part, bytes, { mode: 0o600 });
    await fs.rename(part, file);
    return true;
  } catch {
    await fs.rm(part, { force: true }).catch(() => undefined);
    return false;
  }
}

async function writeCache(tenantId: string, messageId: string, bytes: Buffer): Promise<boolean> {
  const file = inboundMediaPath(tenantId, messageId);
  if (!file || !(await writeAtomic(file, bytes))) return false;
  await evictOldest(tenantId, messageId).catch(() => undefined);
  return true;
}

/* ---------- copies of files agents send ---------- */

/**
 * An agent's attachment goes straight to WhatsApp (upload.ts), never into the workspace's media library, so the library's
 * file and size limits cannot stop a send. A copy is kept so the chat shows the file without asking Meta again: it waits
 * in DATA_DIR/inbound-media/<tenantId>/.pending/<mediaId> until the message is queued, then moves to that message's place in
 * the cache above, where the workspace quota and eviction apply and contact erasure finds it. No message points at a copy that
 * is never sent, so erasure cannot find it: such copies are deleted once they are a day old (sooner when the waiting folder
 * passes its own quota). The check runs whenever the workspace uploads a file, saves a media preview or moves a sent file's
 * copy into the cache; sweepPendingUploads runs it for every workspace at once, for a daily job. A lost copy only means the
 * preview is loaded from Meta instead; nothing here ever fails a send.
 */
export const PENDING_UPLOAD_TTL_MS = 24 * 60 * 60_000;
export const PENDING_UPLOAD_QUOTA_BYTES = 200 * 1048576;
// The dot keeps it apart from message ids (SAFE_ID has none), and eviction skips folders.
const PENDING_DIR = ".pending";

/** DATA_DIR/inbound-media/<tenantId>/.pending/<mediaId>, or null unless both ids are plain. */
export function pendingUploadPath(tenantId: string, mediaId: string): string | null {
  const dir = inboundMediaDir(tenantId);
  if (!dir || !SAFE_ID.test(mediaId)) return null;
  const pending = path.join(dir, PENDING_DIR);
  const full = path.resolve(pending, mediaId);
  return full.startsWith(pending + path.sep) ? full : null;
}

/** Keeps the copy of a file just uploaded to WhatsApp. False when it was not kept (empty, over 25 MB, unsafe id, disk error); never throws. */
export async function keepPendingUpload(tenantId: string, mediaId: string, bytes: Buffer, quota = PENDING_UPLOAD_QUOTA_BYTES): Promise<boolean> {
  if (bytes.length === 0 || bytes.length > MAX_INBOUND_MEDIA_BYTES) return false;
  const file = pendingUploadPath(tenantId, mediaId);
  if (!file || !(await writeAtomic(file, bytes))) return false;
  await trimPendingUploads(tenantId, mediaId, quota).catch(() => undefined);
  return true;
}

/**
 * Deletes a workspace's unsent copies that are more than a day old, then the oldest ones until the waiting folder fits its
 * quota, never `keep` (the copy just written). Only a real folder is trimmed, never one a link points elsewhere. Counts only.
 */
async function trimPendingUploads(tenantId: string, keep = "", quota = PENDING_UPLOAD_QUOTA_BYTES, now = Date.now()): Promise<{ files: number; bytes: number }> {
  const dir = inboundMediaDir(tenantId);
  if (!dir) return { files: 0, bytes: 0 };
  const pending = path.join(dir, PENDING_DIR);
  if (!(await fs.lstat(pending).catch(() => null))?.isDirectory()) return { files: 0, bytes: 0 };
  const out = await trimDir(pending, keep, quota, PENDING_UPLOAD_TTL_MS, now);
  if (out.files > 0) console.info("[inbound-media] removed unsent copies", { tenantId, files: out.files, bytes: out.bytes });
  return out;
}

/**
 * Removes unsent copies more than a day old in every workspace. A workspace's own uploads and media loads already do this for
 * it; this pass is for a daily job, so a file attached and never sent in a workspace where nothing else happens does not stay on
 * disk. Counts only; never throws.
 */
export async function sweepPendingUploads(now = Date.now()): Promise<{ tenants: number; files: number; bytes: number }> {
  const out = { tenants: 0, files: 0, bytes: 0 };
  for (const tenantId of await fs.readdir(dataRoot()).catch(() => [] as string[])) {
    const dir = inboundMediaDir(tenantId);
    if (!dir || !(await fs.lstat(dir).catch(() => null))?.isDirectory()) continue;
    const removed = await trimPendingUploads(tenantId, "", PENDING_UPLOAD_QUOTA_BYTES, now).catch(() => ({ files: 0, bytes: 0 }));
    out.tenants += 1;
    out.files += removed.files;
    out.bytes += removed.bytes;
  }
  return out;
}

/** Moves the kept copy of an uploaded file to the cache entry of the message that sends it. False when there was none; never throws. */
export async function adoptPendingUpload(tenantId: string, mediaId: string, messageId: string): Promise<boolean> {
  const from = pendingUploadPath(tenantId, mediaId);
  const to = inboundMediaPath(tenantId, messageId);
  if (!from || !to) return false;
  if (!(await fs.rename(from, to).then(() => true, () => false))) return false;
  await evictOldest(tenantId, messageId).catch(() => undefined);
  return true;
}

/** Deletes the cached files of the given messages (data-subject erasure). Returns how many files were removed; never throws. */
export async function removeInboundMediaFiles(tenantId: string, messageIds: readonly string[]): Promise<number> {
  let removed = 0;
  for (const id of messageIds) {
    const file = inboundMediaPath(tenantId, id);
    if (!file) continue;
    if (await fs.rm(file, { force: true }).then(() => true, () => false)) removed += 1;
  }
  return removed;
}

/* ---------- download concurrency ---------- */

/** Downloads buffer whole in memory, so distinct downloads are limited per workspace and per process. */
export const MAX_TENANT_DOWNLOADS = 3;
export const MAX_ACTIVE_DOWNLOADS = 8;
export const MAX_WAITING_DOWNLOADS = 40;
export const DOWNLOAD_WAIT_MS = 20_000;
const BUSY = "Too many files are loading at once. Try again in a moment.";

let activeDownloads = 0;
const activeByTenant = new Map<string, number>();
const waiting = new Set<() => void>();

async function acquireDownloadSlot(tenantId: string): Promise<void> {
  const deadline = Date.now() + DOWNLOAD_WAIT_MS;
  while (activeDownloads >= MAX_ACTIVE_DOWNLOADS || (activeByTenant.get(tenantId) ?? 0) >= MAX_TENANT_DOWNLOADS) {
    const left = deadline - Date.now();
    if (left <= 0 || waiting.size >= MAX_WAITING_DOWNLOADS) throw new HttpError(429, BUSY);
    await new Promise<void>((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        waiting.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, left);
      waiting.add(wake);
    });
  }
  activeDownloads += 1;
  activeByTenant.set(tenantId, (activeByTenant.get(tenantId) ?? 0) + 1);
}

function releaseDownloadSlot(tenantId: string) {
  activeDownloads = Math.max(0, activeDownloads - 1);
  const left = (activeByTenant.get(tenantId) ?? 1) - 1;
  if (left <= 0) activeByTenant.delete(tenantId);
  else activeByTenant.set(tenantId, left);
  for (const wake of [...waiting]) wake();
}

/* ---------- serving ---------- */

/**
 * body() hands the bytes to the response (and from then on owns any open file); close() releases the source when the
 * response is never built. A cached file is opened once and read through that handle, so evicting it afterwards
 * cannot break a response already in progress.
 */
type Source = {
  size: number;
  mime: string | null;
  head: () => Promise<Buffer>;
  body: (start: number, end: number) => BodyInit;
  close: () => Promise<void>;
};

async function fromCache(tenantId: string, messageId: string): Promise<Source | null> {
  const file = inboundMediaPath(tenantId, messageId);
  const handle = file ? await fs.open(file, "r").catch(() => null) : null;
  if (!handle) return null;
  const st = await handle.stat().catch(() => null);
  if (!st?.isFile() || st.size === 0) {
    await handle.close().catch(() => undefined);
    return null;
  }
  return {
    size: st.size,
    mime: null,
    head: async () => {
      const buf = Buffer.alloc(Math.min(st.size, 16));
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
      return buf.subarray(0, bytesRead);
    },
    body: (start, end) => Readable.toWeb(handle.createReadStream({ start, end, autoClose: true })) as unknown as BodyInit,
    close: () => handle.close().catch(() => undefined),
  };
}

function fromMemory(bytes: Buffer, mime: string | null): Source {
  return {
    size: bytes.length,
    mime,
    head: async () => bytes.subarray(0, 16),
    body: (start, end) => new Uint8Array(bytes.buffer, bytes.byteOffset + start, end - start + 1) as unknown as BodyInit,
    close: async () => undefined,
  };
}

/** What one shared download produced. Each caller opens its own handle on the cached file, so streams never share one. */
type Fetched = { bytes: Buffer; mime: string | null };

const inFlight = new Map<string, Promise<Fetched>>();

async function fetchAndStore(tenantId: string, messageId: string, mediaId: string): Promise<Fetched> {
  await acquireDownloadSlot(tenantId);
  let fetched: Fetched;
  try {
    fetched = await downloadMetaMedia(tenantId, mediaId);
  } finally {
    releaseDownloadSlot(tenantId);
  }
  if (fetched.bytes.length === 0) throw new HttpError(502, UNAVAILABLE);
  await writeCache(tenantId, messageId, fetched.bytes);
  return fetched;
}

function load(tenantId: string, messageId: string, mediaId: string): Promise<Fetched> {
  const key = `${tenantId}:${messageId}`;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const run = fetchAndStore(tenantId, messageId, mediaId).finally(() => inFlight.delete(key));
  inFlight.set(key, run);
  return run;
}

async function openSource(tenantId: string, messageId: string, mediaId: string): Promise<Source> {
  const cached = await fromCache(tenantId, messageId);
  if (cached) return cached;
  const fetched = await load(tenantId, messageId, mediaId);
  const opened = await fromCache(tenantId, messageId);
  return opened ? { ...opened, mime: fetched.mime } : fromMemory(fetched.bytes, fetched.mime);
}

/** A single byte range, "none" (serve everything) or "invalid" (416). Several ranges are not supported and are served whole. */
export function parseRange(header: string | null, size: number): { start: number; end: number } | "none" | "invalid" {
  const m = header?.match(/^bytes=(\d*)-(\d*)$/);
  if (!m || (!m[1] && !m[2])) return "none";
  const start = m[1] ? Number(m[1]) : Math.max(size - Number(m[2]), 0);
  const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  return start > end || start >= size ? "invalid" : { start, end };
}

type MessageLookup = (tenantId: string, messageId: string) => Promise<{ mediaUrl: string | null; mediaMime: string | null } | null>;

/**
 * Serves one message's Meta media. The lookup must filter by tenantId: a message of any other workspace is
 * indistinguishable from a missing one.
 */
export async function serveInboundMedia(request: Request, tenantId: string, messageId: string, findMessage: MessageLookup): Promise<Response> {
  if (!SAFE_ID.test(messageId)) throw new HttpError(404, "File not found.");
  const message = await findMessage(tenantId, messageId);
  const mediaId = parseMediaRef(message?.mediaUrl);
  if (!message || !mediaId) throw new HttpError(404, "File not found.");
  const source = await openSource(tenantId, messageId, mediaId);
  let handedOver = false;
  try {
    let narrowed = narrowMime(message.mediaMime ?? source.mime);
    if (narrowed.mime === "application/octet-stream" && !message.mediaMime && !source.mime) {
      const sniffed = sniffMime(await source.head());
      if (sniffed) narrowed = narrowMime(sniffed);
    }
    const headers: Record<string, string> = {
      "content-type": narrowed.mime,
      "content-disposition": narrowed.inline ? "inline" : `attachment; filename="file-${messageId}.${narrowed.ext}"`,
      "x-content-type-options": "nosniff",
      "cache-control": CACHE_CONTROL,
      "accept-ranges": "bytes",
      "content-security-policy": "default-src 'none'; sandbox",
      "cross-origin-resource-policy": "same-origin",
    };
    const range = parseRange(request.headers.get("range"), source.size);
    if (range === "invalid") return new Response(null, { status: 416, headers: { "content-range": `bytes */${source.size}` } });
    if (range === "none") {
      const body = source.body(0, source.size - 1);
      handedOver = true;
      return new Response(body, { headers: { ...headers, "content-length": String(source.size) } });
    }
    const body = source.body(range.start, range.end);
    handedOver = true;
    return new Response(body, {
      status: 206,
      headers: { ...headers, "content-length": String(range.end - range.start + 1), "content-range": `bytes ${range.start}-${range.end}/${source.size}` },
    });
  } finally {
    if (!handedOver) await source.close();
  }
}
