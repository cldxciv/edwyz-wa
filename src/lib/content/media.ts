import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { siteUrl } from "@/lib/config";
import { mediaSigningSecret } from "@/lib/creative/secret";
import { HttpError } from "@/lib/tenancy";
import { MAX_IMAGE_BYTES, MAX_VIDEO_BYTES, MEDIA_KEY_PATTERN, type MediaKind } from "./limits";

export const SIGNED_URL_TTL_SECONDS = 3600;
/**
 * The longest link mediaPublicUrl signs, and so the longest verifySignature accepts: 2 hours, for ad videos Meta fetches in its own
 * time (docs/IG-PAGE-ADS-SPEC.md M2, PRM-06). Every other caller keeps the 1-hour default.
 */
export const MAX_SIGNED_URL_TTL_SECONDS = 2 * 3600;
const TENANT_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const TYPES: Record<string, { ext: string; kind: MediaKind }> = {
  "image/jpeg": { ext: "jpg", kind: "image" },
  "image/png": { ext: "png", kind: "image" },
  "video/mp4": { ext: "mp4", kind: "video" },
  "video/quicktime": { ext: "mov", kind: "video" },
};
export const CONTENT_TYPE_BY_EXT: Record<string, string> = { jpg: "image/jpeg", png: "image/png", mp4: "video/mp4", mov: "video/quicktime" };
const SIZE_MESSAGE = `Images can be up to ${MAX_IMAGE_BYTES / 1048576} MB and videos up to ${MAX_VIDEO_BYTES / 1048576} MB.`;

export const DEFAULT_MEDIA_QUOTA_MB = 500;

/** Per-workspace storage cap in bytes (CONTENT_MEDIA_QUOTA_MB, default 500). */
export function mediaQuotaBytes(): number {
  const mb = Number(process.env.CONTENT_MEDIA_QUOTA_MB);
  return (Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_MEDIA_QUOTA_MB) * 1048576;
}

/** What a person sees when the library is full (uploads here, and ad media preparing a crop, promote/media.ts). */
export const mediaQuotaMessage = () => `Your media library is full (${Math.round(mediaQuotaBytes() / 1048576)} MB). Delete files you no longer need and try again.`;
const quotaMessage = mediaQuotaMessage;

const baseDir = () => path.resolve(process.env.DATA_DIR ?? "./data", "content");

/** Absolute path for a tenant's media file, or null when the tenant id or key is not in the strict expected shape. */
export function resolveMediaPath(tenantId: string, key: string): string | null {
  if (!TENANT_PATTERN.test(tenantId) || !MEDIA_KEY_PATTERN.test(key)) return null;
  const base = baseDir();
  const full = path.resolve(base, tenantId, key);
  return full.startsWith(base + path.sep) ? full : null;
}

export const DEFAULT_MEDIA_MAX_FILES = 500;
const BLOCK = 4096;
const STALE_PART_MS = 60 * 60_000;

/** Per-workspace file count cap (CONTENT_MEDIA_MAX_FILES, default 500). */
export function mediaMaxFiles(): number {
  const n = Number(process.env.CONTENT_MEDIA_MAX_FILES);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MEDIA_MAX_FILES;
}

/** What a file costs against the quota: whole disk blocks, so thousands of tiny files cannot hide behind their apparent size. */
const charge = (bytes: number) => Math.max(Math.ceil(bytes / BLOCK), 1) * BLOCK;

const inFlight = new Set<string>();
const reserved = new Map<string, number>();
const locks = new Map<string, Promise<unknown>>();

/** Serialises the room check and the reservation for one workspace, so parallel uploads cannot all see the same free space. */
function withTenantLock<T>(tenantId: string, work: () => Promise<T>): Promise<T> {
  const run = (locks.get(tenantId) ?? Promise.resolve()).then(work, work);
  const tail = run.catch(() => undefined);
  locks.set(tenantId, tail);
  void tail.then(() => {
    if (locks.get(tenantId) === tail) locks.delete(tenantId);
  });
  return run;
}

/** Disk use of the workspace: apparent bytes, quota-charged bytes and file count. Uploads in progress count as files but not as bytes (their room is reserved). Upload leftovers from a crash (.part, over an hour old, not in flight) are removed here. */
export async function mediaUsage(tenantId: string): Promise<{ bytes: number; charged: number; files: number }> {
  const out = { bytes: 0, charged: 0, files: 0 };
  if (!TENANT_PATTERN.test(tenantId)) return out;
  const dir = path.join(baseDir(), tenantId);
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  for (const name of names) {
    const full = path.join(dir, name);
    const st = await fs.stat(full).catch(() => null);
    if (!st) continue;
    if (name.endsWith(".part") && !inFlight.has(full) && Date.now() - st.mtimeMs > STALE_PART_MS) {
      await fs.rm(full, { force: true });
      continue;
    }
    out.files += 1;
    if (inFlight.has(full)) continue;
    out.bytes += st.size;
    out.charged += charge(st.size);
  }
  return out;
}

/** Bytes on disk for the workspace, including uploads still in progress. */
export async function mediaUsageBytes(tenantId: string): Promise<number> {
  return (await mediaUsage(tenantId)).bytes;
}

/** Removes one stored file. Returns false when it does not exist. */
export async function deleteMedia(tenantId: string, key: string): Promise<boolean> {
  const p = resolveMediaPath(tenantId, key);
  if (!p || !(await mediaExists(tenantId, key))) return false;
  await fs.rm(p, { force: true });
  return true;
}

export async function mediaExists(tenantId: string, key: string): Promise<boolean> {
  const p = resolveMediaPath(tenantId, key);
  if (!p) return false;
  return fs.stat(p).then((s) => s.isFile(), () => false);
}

function hasMagic(head: Buffer, ext: string): boolean {
  if (ext === "jpg") return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  if (ext === "png") return head.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return head.subarray(4, 8).toString("latin1") === "ftyp";
}

/** Checks the quota and file count and reserves the room for this upload in one step per workspace. Returns the bytes the upload may use. */
function reserveRoom(tenantId: string, limit: number, declared: number): Promise<number> {
  return withTenantLock(tenantId, async () => {
    const usage = await mediaUsage(tenantId);
    if (usage.files >= mediaMaxFiles()) throw new HttpError(413, `Your media library holds the maximum of ${mediaMaxFiles()} files. Delete files you no longer need and try again.`);
    const room = mediaQuotaBytes() - usage.charged - (reserved.get(tenantId) ?? 0);
    if (room <= 0 || (declared > 0 && charge(declared) > room)) throw new HttpError(413, quotaMessage());
    const grant = declared > 0 ? charge(declared) : Math.min(limit, room);
    reserved.set(tenantId, (reserved.get(tenantId) ?? 0) + grant);
    return grant;
  });
}

function releaseRoom(tenantId: string, grant: number): void {
  const left = (reserved.get(tenantId) ?? 0) - grant;
  if (left > 0) reserved.set(tenantId, left);
  else reserved.delete(tenantId);
}

// ----- Ad crops (docs/IG-PAGE-ADS-SPEC.md 5.5, PRM-06) -----
//
// A crop the browser makes for an ad is uploaded here with { adCrop: true }. Its key carries a mark only this server can make (an
// HMAC of the workspace and the key's random half), so promote/media.ts can tell a crop from the customer's own files without
// trusting the request: retention removes ad-only files, so only a crop this server made may ever be ad-only. Every other key
// is a plain random key, which carries the mark by chance once in 2^64.

const CROP_RANDOM_HEX = 16;
const CROP_MESSAGE = "A crop must be a JPG or PNG image.";

const cropMark = (tenantId: string, random: string) => createHmac("sha256", secret()).update(`ad-crop\n${tenantId}\n${random}`).digest("hex").slice(0, 32 - CROP_RANDOM_HEX);

/** A new key for an ad crop of this workspace: random, with the server's crop mark. */
export function newAdCropKey(tenantId: string, ext: "jpg" | "png"): string {
  const random = randomBytes(CROP_RANDOM_HEX / 2).toString("hex");
  return `${random}${cropMark(tenantId, random)}.${ext}`;
}

/** True when this server made `key` as an ad crop of this workspace. False for every other key, and while no signing key is set. */
export function isAdCropKey(tenantId: string, key: string): boolean {
  if (!TENANT_PATTERN.test(tenantId) || !MEDIA_KEY_PATTERN.test(key) || !/\.(jpg|png)$/.test(key)) return false;
  let expected: string;
  try {
    expected = cropMark(tenantId, key.slice(0, CROP_RANDOM_HEX));
  } catch {
    return false;
  }
  return timingSafeEqual(Buffer.from(key.slice(CROP_RANDOM_HEX, 32), "hex"), Buffer.from(expected, "hex"));
}

/**
 * The ad crops among `keys` that an ad-only AdMedia row holds. listMedia leaves them out: retention removes them with their row,
 * so a post or a reply must not pick them. A crop no row holds (not prepared yet, or another file with the same bytes won) stays
 * in the library, where the customer sees it and can delete it.
 */
async function heldAdCrops(tenantId: string, keys: readonly string[]): Promise<Set<string>> {
  const crops = keys.filter((k) => isAdCropKey(tenantId, k));
  if (crops.length === 0) return new Set();
  const { prisma } = await import("@/lib/db");
  const rows = await prisma.adMedia.findMany({ where: { tenantId, adOnly: true, sourceKey: { in: crops } }, select: { sourceKey: true } });
  return new Set(rows.map((r) => r.sourceKey));
}

/**
 * Streams the body to disk with a hard byte limit, then checks the file signature matches the declared type. The workspace quota is a
 * hard bound: every upload reserves its room up front (counted together with files on disk and with other uploads in progress), so
 * parallel uploads cannot overshoot it. Reservations live in process memory, like the other guards (single web instance).
 * `adCrop`: the upload is a crop the browser made for an ad (a JPG or PNG only); its key carries the server's crop mark.
 */
export async function saveUpload(tenantId: string, request: Request, options: { adCrop?: boolean } = {}): Promise<{ key: string; kind: MediaKind; bytes: number }> {
  const type = TYPES[(request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase()];
  if (!type) throw new HttpError(415, "Upload a JPEG or PNG image, or an MP4 or MOV video.");
  if (options.adCrop && type.kind !== "image") throw new HttpError(400, CROP_MESSAGE);
  const limit = type.kind === "image" ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES;
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > limit) throw new HttpError(413, SIZE_MESSAGE);
  if (!request.body) throw new HttpError(400, "The upload is empty.");
  const key = options.adCrop ? newAdCropKey(tenantId, type.ext as "jpg" | "png") : `${randomBytes(16).toString("hex")}.${type.ext}`;
  const final = resolveMediaPath(tenantId, key);
  if (!final) throw new HttpError(400, "Invalid workspace.");
  await fs.mkdir(path.dirname(final), { recursive: true });
  const grant = await reserveRoom(tenantId, limit, declared);
  const tmp = `${final}.part`;
  inFlight.add(tmp);
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  let total = 0;
  let settled = false;
  try {
    handle = await fs.open(tmp, "w+");
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        throw new HttpError(413, SIZE_MESSAGE);
      }
      if (total > grant) {
        await reader.cancel().catch(() => undefined);
        throw new HttpError(413, quotaMessage());
      }
      await handle.write(value);
    }
    if (charge(total) > grant) throw new HttpError(413, quotaMessage());
    const head = Buffer.alloc(12);
    await handle.read(head, 0, 12, 0);
    if (total < 12 || !hasMagic(head, type.ext)) throw new HttpError(400, "The file content does not match its type.");
    await handle.close();
    handle = null;
    // Under the same lock as the room check, so a scan never sees the file half way between "reserved" and "on disk".
    await withTenantLock(tenantId, async () => {
      await fs.rename(tmp, final);
      inFlight.delete(tmp);
      releaseRoom(tenantId, grant);
      settled = true;
    });
  } catch (e) {
    await handle?.close().catch(() => undefined);
    await fs.rm(tmp, { force: true });
    throw e;
  } finally {
    if (!settled) {
      inFlight.delete(tmp);
      releaseRoom(tenantId, grant);
    }
  }
  return { key, kind: type.kind, bytes: total };
}

/** The workspace's library, newest first (at most 200). Ad crops an ad-only AdMedia row holds are not part of it (heldAdCrops). */
export async function listMedia(tenantId: string): Promise<{ key: string; kind: MediaKind; bytes: number; createdAt: string }[]> {
  if (!TENANT_PATTERN.test(tenantId)) return [];
  const dir = path.join(baseDir(), tenantId);
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  const keys = names.filter((n) => MEDIA_KEY_PATTERN.test(n));
  const held = await heldAdCrops(tenantId, keys);
  const out: { key: string; kind: MediaKind; bytes: number; createdAt: string }[] = [];
  for (const key of keys.filter((k) => !held.has(k))) {
    const s = await fs.stat(path.join(dir, key)).catch(() => null);
    if (s) out.push({ key, kind: /\.(mp4|mov)$/.test(key) ? "video" : "image", bytes: s.size, createdAt: s.mtime.toISOString() });
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 200);
}

const secret = () => mediaSigningSecret("CONTENT_MEDIA_SECRET");

const mac = (tenantId: string, key: string, exp: number) => createHmac("sha256", secret()).update(`${tenantId}/${key}:${exp}`).digest("hex");

/**
 * Short-lived public URL that Meta fetches the media from. HMAC-signed over tenant, file and expiry. It lasts `ttlSeconds` (default
 * 1 hour, so content callers are unchanged), at least 1 second and at most MAX_SIGNED_URL_TTL_SECONDS.
 */
export function mediaPublicUrl(tenantId: string, key: string, nowMs = Date.now(), ttlSeconds = SIGNED_URL_TTL_SECONDS): string {
  const ttl = Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? Math.max(1, Math.min(Math.floor(ttlSeconds), MAX_SIGNED_URL_TTL_SECONDS)) : SIGNED_URL_TTL_SECONDS;
  const exp = Math.floor(nowMs / 1000) + ttl;
  return `${siteUrl()}/api/content/media-public/${tenantId}/${key}?exp=${exp}&sig=${mac(tenantId, key, exp)}`;
}

export function verifySignature(tenantId: string, key: string, expRaw: string | null, sig: string | null, nowMs = Date.now()): boolean {
  if (!expRaw || !sig || !/^\d{1,12}$/.test(expRaw) || !/^[a-f0-9]{64}$/.test(sig)) return false;
  const exp = Number(expRaw);
  // No signature this server makes runs longer than MAX_SIGNED_URL_TTL_SECONDS (plus a minute of clock skew).
  if (exp * 1000 < nowMs || exp * 1000 > nowMs + (MAX_SIGNED_URL_TTL_SECONDS + 60) * 1000) return false;
  return timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(mac(tenantId, key, exp), "hex"));
}
