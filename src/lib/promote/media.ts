/**
 * Ad media: library files sent to the spending ad account on Meta (docs/IG-PAGE-ADS-SPEC.md D21, D34, 3.4 step 2, 4.2 M1 to M3,
 * 4.8, 4.10, 5.1 AdMedia, 5.5, PRM-06).
 *
 * - prepare() reads a file the workspace already has: the content media library (`content`, and `crop`, a crop the browser
 *   made and uploaded there with ?purpose=ad_crop) or Creative Studio storage (`creative`). Byte uploads stay on /api/content/media.
 * - It probes the file (probe.ts), checks it with checkMedia for the placements asked (fits and plain problems), hashes it and
 *   dedupes on (tenantId, adAccountAssetId, sha256): the same file sent twice to one ad account is one row and one upload. The
 *   row is shared by every draft that uses the file, so it stores only what belongs to the file: its fits and the problems for
 *   Automatic placements, and `invalid` only for a block about the file itself (FILE_PROBLEMS). A block that depends on the
 *   placements or the format asked (a carousel card that is not square) comes back in that answer's problems only.
 * - Images go up through M1 (adimages, base64 bytes): the row becomes ready with the image hash. Videos only while
 *   PROMOTE_VIDEO is not off: M2 advideos with a signed file_url that lasts AD_VIDEO_URL_TTL_SECONDS (2 h), or with
 *   PROMOTE_VIDEO=resumable the video_ads start and finish, with the bytes posted to rupload.facebook.com from this file only
 *   (bypass rule B12). A video row stays `processing` until tasks/media.ts sees Meta finish it and stores its thumbnail hash.
 * - prepare() answers well inside the proxy's 60 s: it waits for an image's send at most PREPARE_SEND_WAIT_MS (the send goes on
 *   after the answer, which then says `uploading`), and hands every video to the promote.media task. The page polls get_ad_media.
 * - A failed send is stored in plain words. Errors that may pass (Meta busy or down, a lost connection) are retried by the task
 *   with a growing wait; every send counts one attempt, and the row stops at MAX_ATTEMPTS (the AdMedia_attempts_check): no write
 *   ever goes past it. A person can retry an error by preparing the file again; after the last attempt only a day later, when
 *   the row starts over at one. Errors that need a person (a connection to renew, a file Meta refused, a video Meta may already
 *   hold) wait for that person.
 * - A send holds its row with a lease (UPLOAD_LEASE_MS, longer than the longest send). Every write after the claim matches the
 *   claim's attempts and lease, so a send that outlived its lease and was taken over never overwrites the send that took over.
 * - Crops count in the content media quota (5.5): a crop is refused while the library is over it, with the library's own copy.
 *   Only a crop this server made (content/media.ts isAdCropKey) is `adOnly`, and only while no post, reply material or other
 *   ad media uses its file: retention removes ad-only files 30 days after lastUsedAt, so the request's word is never enough.
 *   markAdMediaUsed() sets lastUsedAt when a draft refers to an item. The same bytes from the customer's own library win.
 * - A row whose file is gone (deleted, or a creative no longer usable) takes the file a later prepare opens, so a retry never
 *   reads a dead key.
 * - SPEND_DRY_RUN (and a sandbox account with SPEND_SIM): promote/meta.ts answers with fake hashes and ids (prefix `dryrun`) and
 *   makes no network call; the byte upload and the thumbnail are skipped for fake ids.
 * - Every Meta call goes through promote/meta.ts, so the spend tripwire classifies it (not_spend). Two plain downloads or uploads
 *   are not Graph calls and live here: the resumable byte upload (rupload.facebook.com only) and Meta's preferred video thumbnail
 *   (Meta's CDN only, *.fbcdn.net), which M1 turns into the thumbnail hash a video creative needs.
 *
 * Every row write sets updatedAt itself. While a video is `processing`, updatedAt is when Meta got it: polls and draft references
 * keep it, so the 30-minute processing limit counts from there.
 */
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import { Readable } from "node:stream";
import type { AdMedia, Prisma } from "@/generated/prisma/client";
import { MEDIA_KEY_PATTERN, mediaKind } from "@/lib/content/limits";
import { isAdCropKey, mediaPublicUrl, mediaQuotaBytes, mediaQuotaMessage, mediaUsage, resolveMediaPath } from "@/lib/content/media";
import { MediaSecretError } from "@/lib/creative/secret";
import { signedAssetUrl } from "@/lib/creative/signed";
import { resolveSafe as resolveCreativePath } from "@/lib/creative/storage";
import { prisma } from "@/lib/db";
import { GraphError } from "@/lib/graph";
import { log } from "@/lib/log";
import type { AssetAccess } from "@/lib/meta-connect";
import { createLimiter } from "@/lib/ratelimit";
import { SpendGuardBypassError } from "@/lib/spend/errors";
import { HttpError } from "@/lib/tenancy";
import { checkMedia, FILE_LIMITS, fitChips, ratioLabel, type MediaCheck, type MediaFit, type MediaProblem } from "./catalog/formats";
import { promoteVideo } from "./flags";
import { PromoteMetaError, promoteMeta, TRANSPORT_GRACE_MS, WRITE_TIMEOUT_MS, type PromoteMeta } from "./meta";
import { probeFile, type MediaProbe as FileProbe } from "./probe";
import { metaErrorText } from "./review-reasons";
import { PromoteThrottledError } from "./throttle";
import { isAdFormat, isPlacementKey, type AdFormat, type MediaProbe, type MediaRatio, type PlacementKey, type PromoteLang } from "./types";

type Env = Record<string, string | undefined>;
type Row = AdMedia;

// =====================================================================================================================
// Limits and copy
// =====================================================================================================================

/** Sends per row at most (the AdMedia_attempts_check). */
export const MAX_ATTEMPTS = 5;
/** How often a video Meta is still processing is checked (M3). */
export const POLL_EVERY_MS = 30_000;
/** How long Meta may take to process a video before the send counts as failed. */
export const PROCESSING_TIMEOUT_MS = 30 * 60_000;
/** The resumable byte upload to rupload.facebook.com gives up after this long. */
export const RUPLOAD_TIMEOUT_MS = 10 * 60_000;
/** One Meta write (M1, M2, video_ads start or finish) ends within this: promote/meta.ts's deadline plus the transport's grace. */
export const META_WRITE_MAX_MS = WRITE_TIMEOUT_MS + TRANSPORT_GRACE_MS;
/**
 * A send holds its row this long; after that the task takes over a send that never finished (a crashed process). Longer than the
 * longest send, a resumable video: start, the byte upload and finish, with three minutes for the token, the file and the database.
 */
export const UPLOAD_LEASE_MS = RUPLOAD_TIMEOUT_MS + 2 * META_WRITE_MAX_MS + 3 * 60_000;
/** prepare() waits this long for an image's send; after it, it answers `uploading` and the send goes on (the proxy waits 60 s). */
export const PREPARE_SEND_WAIT_MS = 40_000;
/** A new image row the request sends at once is due for the task only after this, in case the request never got to claim it. */
const INLINE_GRACE_MS = 2 * 60_000;
/** The wait before the task sends again, after attempts 1, 2, 3 and 4. */
export const RETRY_BACKOFF_MS: readonly number[] = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
/** After the last attempt, a person may start over this long after it. */
export const FRESH_START_AFTER_MS = 24 * 3_600_000;
/** The signed file_url Meta fetches a video from lasts this long (M2: at least 2 hours). */
export const AD_VIDEO_URL_TTL_SECONDS = 2 * 3600;
/** Media prepares per workspace per hour (4.8). */
export const MEDIA_PREPARES_PER_HOUR = 30;
/** The largest source file read: Edwyz's video limit. Images are held to FILE_LIMITS.imageMaxBytes by checkMedia. */
export const MAX_SOURCE_BYTES = FILE_LIMITS.videoMaxBytes;
/** The largest thumbnail downloaded from Meta's CDN. */
export const MAX_THUMBNAIL_BYTES = 8 * 1024 * 1024;
const THUMBNAIL_TIMEOUT_MS = 15_000;
const THUMBNAIL_REDIRECTS = 2;
/** The resumable upload host (P0-9). Uploads only, and only from this file. */
export const RUPLOAD_HOST = "rupload.facebook.com";
/** Meta's media CDN: thumbnails come from hosts under it. */
export const META_CDN_SUFFIX = ".fbcdn.net";
const MAX_LIST = 100;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** What a person sees: what happened and what to do. */
export const MEDIA_MESSAGES = {
  videoOff: "Video ads aren't open yet. Choose an image for now.",
  chooseSource: "Choose a file from your media library or Creative Studio.",
  choosePlacements: "Choose where the ad shows from the list.",
  chooseAccount: "Choose the ad account that pays for your ads first.",
  notInLibrary: "That file isn't in your media library any more. Choose another file.",
  creativeMissing: "That creative isn't in Creative Studio any more. Choose another one.",
  creativeNotReady: "This creative is still being made. Try again when it's ready.",
  creativeUnusable: "This creative can't be used in an ad. Choose an image or video creative.",
  creativePolicy: "This creative didn't pass the ad policy check. Choose another one.",
  cropImage: "A crop must be a JPG or PNG image.",
  kindMismatch: "This file isn't what its name says. Upload it again.",
  tooLarge: "This file is too large for an ad. Use one under 100 MB.",
  rateLimited: "You've sent 30 files to Meta in the last hour. Wait a while, then try again.",
  pending: "Waiting to send to Meta.",
  uploading: "Sending to Meta.",
  ready: "Ready for your ad.",
  retrySoon: "Meta couldn't take this file just now. We'll try again in a few minutes.",
  rejected: "Meta didn't accept this file. Check that it opens on your phone, then try again or choose another file.",
  reconnect: "Your Facebook connection needs renewing. Connect again, then try again.",
  accountGone: "This ad account isn't connected any more. Choose your ad account again, then try again.",
  videoUnconfirmed: "Meta didn't confirm it got this video. Try again in a few minutes.",
  processingFailed: "Meta couldn't process this video. Check that it plays on your phone, then try again or choose another file.",
  processingTimeout: "Meta took more than 30 minutes to prepare this video. We'll send it again in a few minutes.",
  thumbnailFailed: "Meta prepared this video, but its cover picture didn't come through. We'll send it again in a few minutes.",
  fileChanged: "This file changed after you chose it. Choose it again.",
  linksOff: "Video links aren't set up on this server yet, so videos can't be sent. Contact Edwyz support.",
  gaveUp: "Meta didn't take this file after 5 tries. Try again tomorrow, or choose another file.",
  unexpected: "Something went wrong sending this file to Meta. Try again in a few minutes.",
} as const;

// =====================================================================================================================
// Types
// =====================================================================================================================

export const AD_MEDIA_SOURCES = ["content", "creative", "crop"] as const;
export type AdMediaSource = (typeof AD_MEDIA_SOURCES)[number];
export const isAdMediaSource = (v: unknown): v is AdMediaSource => typeof v === "string" && (AD_MEDIA_SOURCES as readonly string[]).includes(v);

export type AdMediaStatus = "pending" | "uploading" | "processing" | "ready" | "invalid" | "error";

/** What to send: a library key (content, crop) or a Creative Studio asset id (creative). */
export type PrepareInput = { source: AdMediaSource; key?: string | null; assetId?: string | null; format?: AdFormat | null };

export type MediaMeta = Pick<PromoteMeta, "uploadAdImage" | "createAdVideo" | "startVideoUpload" | "finishVideoUpload" | "getAdVideoStatus">;
export type VideoBytesUpload = { uploadUrl: string; token: string; filePath: string; size: number };

export type MediaDeps = {
  /** The non-spending Graph client (M1 to M3). */
  meta: MediaMeta;
  /** Decrypted access to the ad account (getAssetAccess): the resumable byte upload needs its user token. */
  access: (tenantId: string, assetId: string) => Promise<AssetAccess>;
  env: Env;
  now: () => number;
  /** Meta's preferred thumbnail of a processed video, from Meta's CDN only. */
  downloadThumbnail: (url: string) => Promise<Uint8Array>;
  /** The resumable byte upload to rupload.facebook.com only. */
  uploadVideoBytes: (input: VideoBytesUpload) => Promise<void>;
  /** How long prepare() waits for an image's send before it answers (PREPARE_SEND_WAIT_MS). */
  sendWaitMs: number;
};

export type AdMediaChip = { group: MediaFit; ok: boolean; text: Record<PromoteLang, string> };
export type AdMediaProblem = { code: string; severity: "block" | "warn"; text: Record<PromoteLang, string> };

/** An AdMedia row as routes and Eddy show it (get_ad_media, list_ad_media, prepare_ad_media). */
export type AdMediaView = {
  id: string;
  adAccountAssetId: string;
  source: string;
  sourceKey: string;
  kind: "image" | "video";
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  ratio: string | null;
  fits: string[];
  /** "Feed 4:5 ✓", "Stories and Reels 9:16: missing" (3.4, 7.3). */
  chips: AdMediaChip[];
  problems: AdMediaProblem[];
  status: AdMediaStatus;
  ready: boolean;
  /** One plain line for the status chip. */
  message: string;
  error: string | null;
  attempts: number;
  /** True when preparing the file again would send it again. */
  canRetry: boolean;
  /** When the task sends again on its own, if it will. */
  retryAt: string | null;
  metaImageHash: string | null;
  metaVideoId: string | null;
  metaThumbHash: string | null;
  adOnly: boolean;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

// =====================================================================================================================
// Dependencies
// =====================================================================================================================

const defaultDeps = (): MediaDeps => ({
  meta: promoteMeta,
  access: async (tenantId, assetId) => (await import("@/lib/meta-connect")).getAssetAccess(tenantId, assetId),
  env: process.env,
  now: Date.now,
  downloadThumbnail: downloadMetaThumbnail,
  uploadVideoBytes: uploadVideoToRupload,
  sendWaitMs: PREPARE_SEND_WAIT_MS,
});

let testOverrides: Partial<MediaDeps> = {};

/** Tests only: replaces dependencies for every caller (routes and the task) until called again with null. */
export function setMediaDepsForTests(overrides: Partial<MediaDeps> | null): void {
  testOverrides = overrides ?? {};
}

export function mediaDeps(overrides: Partial<MediaDeps> = {}): MediaDeps {
  return { ...defaultDeps(), ...testOverrides, ...overrides };
}

// =====================================================================================================================
// Small helpers
// =====================================================================================================================

/** A fake Meta hash or id from a dry run (promote/meta.ts fakes writes with this prefix). Never sent to Meta again. */
export const isFakeMetaId = (v: string | null | undefined): boolean => typeof v === "string" && v.startsWith("dryrun");

const newId = () => `c${randomBytes(12).toString("hex")}`;
const isUniqueViolation = (e: unknown) => (e as { code?: unknown } | null)?.code === "P2002";
const iso = (d: Date | null | undefined) => (d instanceof Date ? d.toISOString() : null);
const time = (d: Date | null | undefined) => (d instanceof Date ? d.getTime() : 0);
const json = (v: unknown) => v as Prisma.InputJsonValue;

/** The wait before the task sends again after `attempts` sends. */
export function retryDelayMs(attempts: number): number {
  return RETRY_BACKOFF_MS[Math.min(Math.max(attempts, 1), RETRY_BACKOFF_MS.length) - 1];
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** The probe as checkMedia reads it: images at the size people see (EXIF turned), videos with their rotation. */
function catalogProbe(p: FileProbe): MediaProbe {
  if (p.kind === "image") {
    return { kind: "image", mime: p.format === "png" ? "image/png" : "image/jpeg", bytes: p.bytes, width: p.displayWidth, height: p.displayHeight, rotation: null };
  }
  return { kind: "video", mime: p.format === "mov" ? "video/quicktime" : "video/mp4", bytes: p.bytes, width: p.width, height: p.height, rotation: p.rotation, durationMs: p.durationMs, videoCodec: p.codec };
}

function validPlacements(placements: readonly unknown[] | null | undefined): PlacementKey[] {
  if (placements === undefined || placements === null) return [];
  if (!Array.isArray(placements) || placements.length > 30) throw new HttpError(400, MEDIA_MESSAGES.choosePlacements);
  const out = new Set<PlacementKey>();
  for (const p of placements) {
    if (!isPlacementKey(p)) throw new HttpError(400, MEDIA_MESSAGES.choosePlacements);
    out.add(p);
  }
  return [...out];
}

/**
 * Blocks about the file itself, the same for every placement: only these make the shared row `invalid`. The others (a feed
 * shape, a carousel card, a Reel too long) depend on what one draft asks, and come back in that answer only.
 */
export const FILE_PROBLEMS: ReadonlySet<string> = new Set(["image_type", "video_type", "codec", "too_large", "no_size", "too_small", "too_short"]);

function fileBlockOf(check: MediaCheck): MediaProblem | null {
  return check.problems.find((p) => p.severity === "block" && FILE_PROBLEMS.has(p.code)) ?? null;
}

const storedProblems = (check: MediaCheck) => check.problems.map((p) => ({ code: p.code, severity: p.severity, key: p.key, text: p.text }));

// =====================================================================================================================
// Source files
// =====================================================================================================================

type SourceFile = { path: string; size: number; kind: "image" | "video"; source: AdMediaSource; sourceKey: string; adOnly: boolean };

class MediaFileGoneError extends Error {
  constructor(readonly creative: boolean) {
    super("The source file is gone.");
  }
}
class MediaFileChangedError extends Error {}

const CREATIVE_EXT: Readonly<Record<string, "image" | "video">> = { jpg: "image", jpeg: "image", png: "image", mp4: "video", mov: "video" };

async function statFile(path: string): Promise<number | null> {
  const st = await fs.stat(path).catch(() => null);
  return st && st.isFile() ? st.size : null;
}

/** A Creative Studio asset's file, when the asset can be an ad: an image or video that is made and passed the policy check. */
async function creativeFile(tenantId: string, assetId: string): Promise<{ path: string; kind: "image" | "video" }> {
  if (!ID.test(assetId)) throw new HttpError(400, MEDIA_MESSAGES.chooseSource);
  const asset = await prisma.creativeAsset.findFirst({ where: { id: assetId, tenantId }, select: { id: true, kind: true, storageKey: true, status: true, policyCheck: true } });
  if (!asset) throw new HttpError(404, MEDIA_MESSAGES.creativeMissing);
  if (asset.status === "pending") throw new HttpError(409, MEDIA_MESSAGES.creativeNotReady);
  if (asset.status !== "ready" && asset.status !== "approved") throw new HttpError(409, MEDIA_MESSAGES.creativeUnusable);
  const policy = asset.policyCheck as { result?: unknown } | null;
  if (policy && typeof policy === "object" && policy.result === "block") throw new HttpError(409, MEDIA_MESSAGES.creativePolicy);
  const ext = /\.([a-z0-9]{2,5})$/i.exec(asset.storageKey ?? "")?.[1]?.toLowerCase() ?? "";
  const kind = CREATIVE_EXT[ext];
  if (!asset.storageKey || !kind || asset.kind !== kind) throw new HttpError(409, MEDIA_MESSAGES.creativeUnusable);
  return { path: resolveCreativePath(tenantId, asset.storageKey), kind };
}

async function openSource(tenantId: string, input: PrepareInput): Promise<SourceFile> {
  if (input.source === "creative") {
    const assetId = typeof input.assetId === "string" ? input.assetId : "";
    const file = await creativeFile(tenantId, assetId);
    const size = await statFile(file.path);
    if (size === null) throw new HttpError(404, MEDIA_MESSAGES.creativeMissing);
    return { path: file.path, size, kind: file.kind, source: "creative", sourceKey: assetId, adOnly: false };
  }
  const key = typeof input.key === "string" ? input.key : "";
  if (!MEDIA_KEY_PATTERN.test(key)) throw new HttpError(400, MEDIA_MESSAGES.chooseSource);
  const path = resolveMediaPath(tenantId, key);
  if (!path) throw new HttpError(400, MEDIA_MESSAGES.chooseSource);
  const size = await statFile(path);
  if (size === null) throw new HttpError(404, MEDIA_MESSAGES.notInLibrary);
  const kind = mediaKind(key);
  if (input.source === "crop" && kind !== "image") throw new HttpError(400, MEDIA_MESSAGES.cropImage);
  // Retention deletes ad-only files, so the request's word that a file is a crop is never enough: only a crop this server made
  // is ad-only, and only while nothing else uses it. Any other file is the customer's library file (`content`), whatever `from` said.
  const adOnly = isAdCropKey(tenantId, key) && !(await libraryKeyInUse(tenantId, key));
  return { path, size, kind, source: adOnly ? "crop" : "content", sourceKey: key, adOnly };
}

/** True when a scheduled post, a reply material or ad media that is not ad-only uses this library file. */
async function libraryKeyInUse(tenantId: string, key: string): Promise<boolean> {
  const [posts, materials, media] = await Promise.all([
    prisma.scheduledPost.count({ where: { tenantId, mediaKeys: { has: key } } }),
    prisma.replyMaterial.count({ where: { tenantId, mediaKey: key } }),
    prisma.adMedia.count({ where: { tenantId, sourceKey: key, adOnly: false, source: { not: "creative" } } }),
  ]);
  return posts + materials + media > 0;
}

/** True when the row's file is still there (and, for a creative, still usable in an ad). */
async function rowFileExists(row: Row): Promise<boolean> {
  try {
    await fileOfRow(row);
    return true;
  } catch {
    return false;
  }
}

/** The row's file on disk, or MediaFileGoneError when it is no longer there. */
async function fileOfRow(row: Row): Promise<string> {
  let path: string | null = null;
  if (row.source === "creative") {
    try {
      path = (await creativeFile(row.tenantId, row.sourceKey)).path;
    } catch {
      path = null;
    }
  } else if (MEDIA_KEY_PATTERN.test(row.sourceKey)) {
    path = resolveMediaPath(row.tenantId, row.sourceKey);
  }
  if (!path || (await statFile(path)) === null) throw new MediaFileGoneError(row.source === "creative");
  return path;
}

/** The link Meta fetches a video from: signed, and good for AD_VIDEO_URL_TTL_SECONDS. */
export function adVideoUrl(row: Pick<Row, "tenantId" | "source" | "sourceKey">, nowMs: number): string {
  return row.source === "creative"
    ? signedAssetUrl(row.tenantId, row.sourceKey, AD_VIDEO_URL_TTL_SECONDS, nowMs)
    : mediaPublicUrl(row.tenantId, row.sourceKey, nowMs, AD_VIDEO_URL_TTL_SECONDS);
}

/** Crops live in the content library and count in its quota (5.5): none is sent while the library is over it. */
async function assertLibraryRoom(tenantId: string): Promise<void> {
  const usage = await mediaUsage(tenantId);
  if (usage.charged > mediaQuotaBytes()) throw new HttpError(413, mediaQuotaMessage());
}

// =====================================================================================================================
// The rate limit (4.8: media prepares, 30 an hour per workspace)
// =====================================================================================================================

// The name is a literal: tests/ratelimit-migration.test.ts reads every createLimiter() call for a stable, unique name.
export const prepareLimiter = createLimiter(MEDIA_PREPARES_PER_HOUR, 3_600_000, "promote-media-prepare");

/** Takes one of the workspace's 30 prepares this hour, or refuses with 429. */
export function takePrepareSlot(tenantId: string, nowMs?: number): void {
  if (!prepareLimiter.consume(`tenant:${tenantId}`, nowMs)) throw new HttpError(429, MEDIA_MESSAGES.rateLimited);
}

// =====================================================================================================================
// Row writes
// =====================================================================================================================

type Change = Prisma.AdMediaUpdateManyMutationInput;

/**
 * Writes `data` while the row still matches `where` (by default: the same status), and returns the row as written, or null when
 * another writer moved it on first. updatedAt is set to now, or kept (`keepClock`) while a video is processing.
 */
export async function saveAdMedia(row: Row, data: Change, d: Pick<MediaDeps, "now">, opts: { keepClock?: boolean; where?: Prisma.AdMediaWhereInput } = {}): Promise<Row | null> {
  const updatedAt = opts.keepClock ? row.updatedAt : new Date(d.now());
  const where: Prisma.AdMediaWhereInput = { id: row.id, tenantId: row.tenantId, ...(opts.where ?? { status: row.status }) };
  const { count } = await prisma.adMedia.updateMany({ where, data: { ...data, updatedAt } });
  if (count !== 1) return null;
  return { ...row, ...(data as Partial<Row>), updatedAt };
}

/**
 * The row is still as it was read: the same status, attempts and next check. A claim changes all three, so after a claim this
 * is the claim itself (its lease): a write with it lands only while that claim still holds the row.
 */
const unchanged = (row: Row): Prisma.AdMediaWhereInput => ({ status: row.status, attempts: row.attempts, nextCheckAt: row.nextCheckAt });

/** The row as written, or as it is now when another writer moved it on first. */
async function current(row: Row, written: Row | null): Promise<Row> {
  return written ?? (await prisma.adMedia.findFirst({ where: { id: row.id, tenantId: row.tenantId } })) ?? row;
}

/** Rows the task should send (pending, an error with a retry due, a send that never finished) and videos due a check. */
export async function dueAdMedia(nowMs: number, take: number): Promise<{ sends: Row[]; checks: Row[] }> {
  const at = new Date(nowMs);
  const sends = await prisma.adMedia.findMany({
    where: {
      OR: [
        { status: { in: ["pending", "error"] }, attempts: { lt: MAX_ATTEMPTS }, nextCheckAt: { lte: at } },
        { status: "uploading", nextCheckAt: { lte: at } },
      ],
    },
    orderBy: { nextCheckAt: "asc" },
    take,
  });
  const checks = await prisma.adMedia.findMany({ where: { status: "processing", nextCheckAt: { lte: at } }, orderBy: { nextCheckAt: "asc" }, take });
  return { sends, checks };
}

// =====================================================================================================================
// Failures in plain words
// =====================================================================================================================

type Failure = { message: string; retry: boolean; until?: Date };

/** What a failed send means for a person, and whether the task may send again on its own. */
function failureOf(e: unknown, kind: string): Failure {
  if (e instanceof PromoteThrottledError) return { message: e.message, retry: true, until: e.until };
  if (e instanceof MediaFileGoneError) return { message: e.creative ? MEDIA_MESSAGES.creativeMissing : MEDIA_MESSAGES.notInLibrary, retry: false };
  if (e instanceof MediaFileChangedError) return { message: MEDIA_MESSAGES.fileChanged, retry: false };
  if (e instanceof MediaSecretError) return { message: MEDIA_MESSAGES.linksOff, retry: false };
  if (e instanceof SpendGuardBypassError) return { message: MEDIA_MESSAGES.unexpected, retry: false };
  // A video send cut off may already be on Meta: a person decides. The same image sent again gets the same hash, so it may retry.
  if (e instanceof PromoteMetaError) return e.ambiguous && kind === "video" ? { message: MEDIA_MESSAGES.videoUnconfirmed, retry: false } : { message: MEDIA_MESSAGES.retrySoon, retry: true };
  if (e instanceof GraphError) {
    if (e.code === 190 || e.code === 102 || e.status === 401) return { message: MEDIA_MESSAGES.reconnect, retry: false };
    if (e.code === 10 || e.code === 200 || e.code === 294) return { message: MEDIA_MESSAGES.reconnect, retry: false };
    if (e.code === 100 && e.subcode === 33) return { message: MEDIA_MESSAGES.accountGone, retry: false };
    if (e.ambiguous && kind === "video") return { message: MEDIA_MESSAGES.videoUnconfirmed, retry: false };
    if (e.status === 0 || e.status >= 500 || e.ambiguous || e.code === 1 || e.code === 2) return { message: MEDIA_MESSAGES.retrySoon, retry: true };
    return { message: MEDIA_MESSAGES.rejected, retry: false };
  }
  if (e instanceof HttpError) {
    if (e.status === 404) return { message: MEDIA_MESSAGES.accountGone, retry: false };
    if (e.status === 409) return { message: MEDIA_MESSAGES.reconnect, retry: false };
    if (e.status >= 500) return { message: MEDIA_MESSAGES.retrySoon, retry: true };
    return { message: e.message, retry: false };
  }
  return { message: MEDIA_MESSAGES.unexpected, retry: true };
}

/**
 * Stores a failed send of a claimed row: pending again after a throttle (no attempt used), a retry while attempts are left, or a
 * final error. Written only while the claim holds the row; a send that lost its lease leaves the row to the send that took over.
 */
async function storeFailure(row: Row, e: unknown, d: MediaDeps): Promise<Row> {
  const f = failureOf(e, row.kind);
  // Meta's answers and plain refusals are stored for the person; anything else is a bug or an outage worth a log line.
  const expected = e instanceof GraphError || e instanceof MediaFileGoneError || e instanceof MediaFileChangedError || (e instanceof HttpError && !(e instanceof SpendGuardBypassError));
  if (!expected) log.warn("promote.media.send_failed", { err: e, mediaId: row.id, tenantId: row.tenantId });
  let data: Change;
  if (f.until) data = { status: "pending", attempts: Math.max(0, row.attempts - 1), nextCheckAt: f.until, error: f.message };
  else if (!f.retry) data = { status: "error", error: f.message, nextCheckAt: null };
  else if (row.attempts >= MAX_ATTEMPTS) data = { status: "error", error: MEDIA_MESSAGES.gaveUp, nextCheckAt: null };
  else data = { status: "error", error: f.message, nextCheckAt: new Date(d.now() + retryDelayMs(row.attempts)) };
  return current(row, await saveAdMedia(row, data, d, { where: unchanged(row) }));
}

// =====================================================================================================================
// Sending
// =====================================================================================================================

/**
 * True when a send may start now: pending or an error with attempts left (or a day after the last attempt), or a send that never
 * finished (its lease is over).
 */
function sendable(row: Row, nowMs: number): boolean {
  if (row.status === "uploading") return row.nextCheckAt !== null && time(row.nextCheckAt) <= nowMs;
  if (row.status !== "pending" && row.status !== "error") return false;
  return row.attempts < MAX_ATTEMPTS || nowMs - time(row.updatedAt) >= FRESH_START_AFTER_MS;
}

/**
 * Takes the row for one send: status uploading, one attempt used, a lease. Null when another send took it first. Attempts never
 * pass MAX_ATTEMPTS (the AdMedia_attempts_check): a row that used them all starts over at one, and only a day after the last
 * attempt (sendable); an unfinished send on its last attempt never gets here (claimAdMedia ends it).
 */
async function claim(row: Row, d: MediaDeps): Promise<Row | null> {
  const now = d.now();
  if (row.attempts >= MAX_ATTEMPTS && (row.status === "uploading" || now - time(row.updatedAt) < FRESH_START_AFTER_MS)) return null;
  const attempts = row.attempts >= MAX_ATTEMPTS ? 1 : row.attempts + 1;
  return saveAdMedia(row, { status: "uploading", attempts, nextCheckAt: new Date(now + UPLOAD_LEASE_MS), error: null }, d, { where: unchanged(row) });
}

/** One send of a claimed row: M1 for an image, M2 (file_url or resumable) for a video. Every write holds to the claim's lease. */
async function send(row: Row, d: MediaDeps): Promise<Row> {
  const ctx = { tenantId: row.tenantId, adAccountAssetId: row.adAccountAssetId };
  const lease = { where: unchanged(row) };
  try {
    const path = await fileOfRow(row);
    if (row.kind === "image") {
      const bytes = await fs.readFile(path);
      if (createHash("sha256").update(bytes).digest("hex") !== row.sha256) throw new MediaFileChangedError();
      const image = await d.meta.uploadAdImage(ctx, { bytes: new Uint8Array(bytes) });
      return current(row, await saveAdMedia(row, { status: "ready", metaImageHash: image.hash, error: null, nextCheckAt: null }, d, lease));
    }
    const mode = promoteVideo(d.env);
    if (mode === "off") return current(row, await saveAdMedia(row, { status: "error", error: MEDIA_MESSAGES.videoOff, nextCheckAt: null }, d, lease));
    let videoId: string;
    if (mode === "resumable") {
      const size = (await statFile(path)) ?? 0;
      const started = await d.meta.startVideoUpload(ctx, size);
      if (!isFakeMetaId(started.videoId)) {
        if (!started.uploadUrl) throw new PromoteMetaError("bad_response", true);
        const access = await d.access(row.tenantId, row.adAccountAssetId);
        await d.uploadVideoBytes({ uploadUrl: started.uploadUrl, token: access.token, filePath: path, size });
      }
      await d.meta.finishVideoUpload(ctx, started.videoId);
      videoId = started.videoId;
    } else {
      videoId = (await d.meta.createAdVideo(ctx, { fileUrl: adVideoUrl(row, d.now()), name: `Edwyz ad video ${row.sha256.slice(0, 8)}` })).id;
    }
    // updatedAt becomes now: the 30-minute processing limit counts from here.
    return current(row, await saveAdMedia(row, { status: "processing", metaVideoId: videoId, error: null, nextCheckAt: new Date(d.now() + POLL_EVERY_MS) }, d, lease));
  } catch (e) {
    return storeFailure(row, e, d);
  }
}

/**
 * Takes a row for one send when it may be sent now. `claimed` is the row as claimed (uploading, with its lease), or null with
 * `row` as it ends: unchanged when it is not due or another send has it, an error when videos are off or an unfinished send was
 * its last attempt.
 */
export async function claimAdMedia(row: Row, options: { deps?: Partial<MediaDeps> } = {}): Promise<{ claimed: Row | null; row: Row }> {
  const d = mediaDeps(options.deps);
  if (!sendable(row, d.now())) return { claimed: null, row };
  if (row.kind === "video" && promoteVideo(d.env) === "off") {
    return { claimed: null, row: (await saveAdMedia(row, { status: "error", error: MEDIA_MESSAGES.videoOff, nextCheckAt: null }, d, { where: unchanged(row) })) ?? row };
  }
  if (row.status === "uploading" && row.attempts >= MAX_ATTEMPTS) {
    return { claimed: null, row: (await saveAdMedia(row, { status: "error", error: MEDIA_MESSAGES.gaveUp, nextCheckAt: null }, d, { where: unchanged(row) })) ?? row };
  }
  const claimed = await claim(row, d);
  return { claimed, row: claimed ?? row };
}

/** Sends a row claimAdMedia claimed. Returns the row as it ends. */
export async function sendClaimedAdMedia(claimed: Row, options: { deps?: Partial<MediaDeps> } = {}): Promise<Row> {
  return send(claimed, mediaDeps(options.deps));
}

/**
 * Sends a row again when it may be sent now (the task's retries, a stale send, and start_promotion's run for an image not yet on
 * Meta). Returns the row as it ends; unchanged when it is not due or another send has it.
 */
export async function sendAdMedia(row: Row, options: { deps?: Partial<MediaDeps> } = {}): Promise<Row> {
  const d = mediaDeps(options.deps);
  const { claimed, row: after } = await claimAdMedia(row, { deps: d });
  return claimed ? send(claimed, d) : after;
}

/** M1 for the thumbnail of a processed video: Meta's preferred thumbnail, downloaded from Meta's CDN. */
export async function thumbnailHash(row: Pick<Row, "tenantId" | "adAccountAssetId">, thumbnailUrl: string | null, d: MediaDeps): Promise<string> {
  if (!thumbnailUrl) throw new HttpError(502, "Meta sent no thumbnail for this video.");
  const bytes = await d.downloadThumbnail(thumbnailUrl);
  const image = await d.meta.uploadAdImage({ tenantId: row.tenantId, adAccountAssetId: row.adAccountAssetId }, { bytes });
  return image.hash;
}

/** A fake thumbnail hash for a dry-run video, in the shape promote/meta.ts fakes image hashes. */
export const fakeThumbHash = (videoId: string) => `dryrun${createHash("sha256").update(`thumb:${videoId}`).digest("hex").slice(0, 26)}`;

/** Meta's "object does not exist" (#100, subcode 33): the video is gone from the ad account. */
export const isMissingMetaObject = (e: unknown): boolean => e instanceof GraphError && e.code === 100 && e.subcode === 33;

const VIDEO_FAILURE_MESSAGES = {
  timeout: MEDIA_MESSAGES.processingTimeout,
  thumbnail: MEDIA_MESSAGES.thumbnailFailed,
  gone: MEDIA_MESSAGES.retrySoon,
} as const;

/**
 * Stores what a failed video check means. Meta's own processing error is final (the file needs a person). A timeout, a cover
 * picture that never came, or a video gone from the account is sent again by the task while attempts are left.
 */
export async function failVideo(row: Row, reason: "timeout" | "thumbnail" | "failed" | "gone", d: MediaDeps): Promise<Row> {
  let data: Change;
  if (reason === "failed") data = { status: "error", error: MEDIA_MESSAGES.processingFailed, nextCheckAt: null };
  else if (row.attempts >= MAX_ATTEMPTS) data = { status: "error", error: MEDIA_MESSAGES.gaveUp, nextCheckAt: null };
  else data = { status: "error", error: VIDEO_FAILURE_MESSAGES[reason], nextCheckAt: new Date(d.now() + retryDelayMs(row.attempts)) };
  return (await saveAdMedia(row, data, d, { where: { status: "processing" } })) ?? row;
}

// =====================================================================================================================
// prepare_ad_media
// =====================================================================================================================

export type PrepareResult = { media: AdMediaView; created: boolean };

/**
 * prepare_ad_media: probes and checks a library file for `placements` (empty means Automatic), dedupes it per ad account and
 * sends it to Meta unless it is already there or on its way: an image while the request waits up to PREPARE_SEND_WAIT_MS, a
 * video through the promote.media task. Refuses with a plain HttpError: a bad reference, a missing file, a damaged file (the
 * probe's reason), a video while PROMOTE_VIDEO is off, a crop while the library is over its quota. A file with a block about
 * itself (FILE_PROBLEMS) is stored as `invalid` with its reasons and is not sent. The answer's problems are this request's:
 * a block that depends on the placements or format asked shows there, and leaves the shared row and its retries alone.
 */
export async function prepare(
  tenantId: string,
  adAccountAssetId: string,
  input: PrepareInput,
  placements: readonly PlacementKey[] = [],
  options: { userId?: string | null; deps?: Partial<MediaDeps> } = {},
): Promise<PrepareResult> {
  const d = mediaDeps(options.deps);
  if (!input || !isAdMediaSource(input.source)) throw new HttpError(400, MEDIA_MESSAGES.chooseSource);
  if (typeof adAccountAssetId !== "string" || !ID.test(adAccountAssetId)) throw new HttpError(400, MEDIA_MESSAGES.chooseAccount);
  const where = validPlacements(placements);
  const format = input.format === undefined || input.format === null ? undefined : isAdFormat(input.format) ? input.format : undefined;

  const file = await openSource(tenantId, input);
  const videoOff = promoteVideo(d.env) === "off";
  if (file.kind === "video" && videoOff) throw new HttpError(409, MEDIA_MESSAGES.videoOff);
  if (file.size > MAX_SOURCE_BYTES) throw new HttpError(413, MEDIA_MESSAGES.tooLarge);
  if (file.adOnly) await assertLibraryRoom(tenantId);

  const probed = probeFile(file.path);
  if (!probed.ok) throw new HttpError(422, probed.message);
  const probe = catalogProbe(probed.media);
  if (probe.kind !== file.kind) throw new HttpError(422, MEDIA_MESSAGES.kindMismatch);
  const sha256 = await sha256File(file.path);
  // The row is shared by every draft that uses the file: it keeps the file's fits, the problems for Automatic placements and a
  // block about the file itself. This request's own check (its placements and format) goes in the answer only.
  const base = checkMedia(probe);
  const check = where.length > 0 || format ? checkMedia(probe, where, { format }) : base;
  const block = fileBlockOf(base);
  const now = d.now();
  const facts = { fits: base.fits, problems: json(storedProblems(base)), ratio: base.ratio };

  let row = await prisma.adMedia.findFirst({ where: { tenantId, adAccountAssetId, sha256 } });
  let created = false;
  if (!row) {
    const data = {
      id: newId(),
      tenantId,
      adAccountAssetId,
      source: file.source,
      sourceKey: file.sourceKey,
      kind: probe.kind,
      mime: probe.mime,
      bytes: BigInt(probe.bytes),
      sha256,
      width: probe.width,
      height: probe.height,
      durationMs: probe.durationMs ?? null,
      videoCodec: probe.videoCodec ?? null,
      rotation: probe.kind === "video" ? (probe.rotation ?? 0) : null,
      ...facts,
      status: block ? "invalid" : "pending",
      error: block ? block.text.en : null,
      attempts: 0,
      // A video is the task's at once; an image is sent by this request, and the task's only if the request never claims it.
      nextCheckAt: block ? null : new Date(now + (probe.kind === "video" ? 0 : INLINE_GRACE_MS)),
      lastUsedAt: null,
      adOnly: file.adOnly,
      createdByUserId: options.userId ?? null,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    };
    try {
      row = await prisma.adMedia.create({ data });
      created = true;
    } catch (e) {
      // Two prepares of one file at once: the second finds the first one's row.
      if (!isUniqueViolation(e)) throw e;
      row = await prisma.adMedia.findFirst({ where: { tenantId, adAccountAssetId, sha256 } });
      if (!row) throw e;
    }
  }
  if (!created) row = await refresh(row, file, facts, block, d);
  // A request its placements or format block (a carousel card that is not square) sends nothing now: this draft can't use the
  // file, and another draft's send or retry keeps its own schedule (a new row goes with the task's next run).
  const requestBlocked = check.problems.some((p) => p.severity === "block");
  if (row.status !== "invalid" && !requestBlocked && sendable(row, d.now())) row = row.kind === "video" ? await handOff(row, d) : await sendWithin(row, d);
  return { media: viewOf(row, d.now(), check), created };
}

/**
 * An existing row seen again: the file's facts, the file it reads, and `invalid` set or lifted by a block about the file itself.
 * A block that depends on the placements never touches the row (another draft may be waiting on its send or its retry).
 */
async function refresh(row: Row, file: SourceFile, facts: { fits: MediaFit[]; problems: Prisma.InputJsonValue; ratio: MediaRatio }, block: MediaProblem | null, d: MediaDeps): Promise<Row> {
  const data: Change = { ...facts };
  // The file the row reads: the customer's own library file wins over an ad-only crop (retention never removes a file the
  // customer keeps), and the file just opened replaces one that is gone, so a send or a retry never reads a dead key.
  const sameFile = row.source === file.source && row.sourceKey === file.sourceKey;
  if ((row.adOnly && !file.adOnly) || (!sameFile && !(await rowFileExists(row)))) {
    Object.assign(data, { source: file.source, sourceKey: file.sourceKey, adOnly: file.adOnly });
  }
  const now = d.now();
  const spent = row.attempts >= MAX_ATTEMPTS;
  if (block && (row.status === "pending" || row.status === "error" || row.status === "invalid")) {
    Object.assign(data, { status: "invalid", error: block.text.en, nextCheckAt: null });
  } else if (!block && row.status === "invalid") {
    // The block is gone (the checks changed): back to what the row was. Attempts all used stay so until a day after the last.
    if (spent && now - time(row.updatedAt) < FRESH_START_AFTER_MS) Object.assign(data, { status: "error", error: MEDIA_MESSAGES.gaveUp, nextCheckAt: null });
    else Object.assign(data, { status: "pending", error: null, attempts: spent ? 0 : row.attempts, nextCheckAt: new Date(now) });
  }
  // Only a change of status moves updatedAt: it is a processing video's clock and the start of an error's day-long wait, which a
  // row with all its attempts used keeps while it is invalid.
  const keepClock = !("status" in data) || (spent && (data.status === "invalid" || data.status === "error"));
  return current(row, await saveAdMedia(row, data, d, { keepClock, where: unchanged(row) }));
}

/**
 * Videos are sent by the promote.media task, never in the request (a resumable upload runs for minutes). A person's retry of an
 * error becomes due now, starting over when all attempts were used a day ago. A pending row is due already (now, or when Meta's
 * cooldown ends), and an unfinished send is taken over by the task once its lease is over.
 */
async function handOff(row: Row, d: MediaDeps): Promise<Row> {
  if (row.status !== "error") return row;
  const attempts = row.attempts >= MAX_ATTEMPTS ? 0 : row.attempts;
  return current(row, await saveAdMedia(row, { status: "pending", error: null, attempts, nextCheckAt: new Date(d.now()) }, d, { where: unchanged(row) }));
}

/**
 * Sends an image while the request waits at most `sendWaitMs`, well inside the proxy's 60 s. After that it answers with the row as
 * it is (uploading): the send goes on, its lease keeps the task off it, and the page polls get_ad_media.
 */
async function sendWithin(row: Row, d: MediaDeps): Promise<Row> {
  const sending = sendAdMedia(row, { deps: d });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), Math.max(0, d.sendWaitMs));
  });
  try {
    const done = await Promise.race([sending, waited]);
    if (done) return done;
  } finally {
    clearTimeout(timer);
  }
  sending.catch((err: unknown) => log.warn("promote.media.send_failed", { err, mediaId: row.id, tenantId: row.tenantId }));
  return (await prisma.adMedia.findFirst({ where: { id: row.id, tenantId: row.tenantId } })) ?? row;
}

// =====================================================================================================================
// Reads (get_ad_media, list_ad_media) and use
// =====================================================================================================================

function problemsOf(raw: unknown): AdMediaProblem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((p): p is { code: string; severity: string; text: Record<string, string> } => !!p && typeof p === "object" && typeof (p as { code?: unknown }).code === "string" && typeof (p as { text?: unknown }).text === "object")
    .map((p) => ({ code: p.code, severity: p.severity === "block" ? "block" : "warn", text: { en: String(p.text.en ?? ""), hi: String(p.text.hi ?? p.text.en ?? ""), hinglish: String(p.text.hinglish ?? p.text.en ?? "") } }));
}

function messageOf(row: Row, problems: AdMediaProblem[]): string {
  switch (row.status) {
    case "pending":
      return row.error ?? MEDIA_MESSAGES.pending;
    case "uploading":
      return MEDIA_MESSAGES.uploading;
    case "processing":
      return metaErrorText("media_not_ready");
    case "ready":
      return MEDIA_MESSAGES.ready;
    case "invalid":
      return row.error ?? problems.find((p) => p.severity === "block")?.text.en ?? MEDIA_MESSAGES.rejected;
    default:
      return row.error ?? MEDIA_MESSAGES.unexpected;
  }
}

/**
 * The row as people see it, with the fit chips and plain problems. `request`: the check of one prepare (its placements and
 * format), whose problems replace the stored ones (Automatic placements); a block of it is the status line too, so the person
 * sees why this draft can't use the file.
 */
export function viewOf(row: Row, nowMs = Date.now(), request?: MediaCheck): AdMediaView {
  const stored = problemsOf(row.problems);
  const problems = request ? problemsOf(storedProblems(request)) : stored;
  const requestBlock = request?.problems.find((p) => p.severity === "block");
  const fits = Array.isArray(row.fits) ? row.fits.filter((f): f is string => typeof f === "string") : [];
  const width = row.width ?? 0;
  const height = row.height ?? 0;
  const check: MediaCheck = {
    ratio: (row.ratio as MediaRatio | null) ?? "other",
    label: width > 0 && height > 0 ? ratioLabel(width, height, row.rotation ?? 0) : "other",
    fits: fits as MediaFit[],
    problems: [],
  };
  const status = row.status as AdMediaStatus;
  return {
    id: row.id,
    adAccountAssetId: row.adAccountAssetId,
    source: row.source,
    sourceKey: row.sourceKey,
    kind: row.kind === "video" ? "video" : "image",
    mime: row.mime,
    bytes: Number(row.bytes),
    width: row.width,
    height: row.height,
    durationMs: row.durationMs,
    ratio: row.ratio,
    fits,
    chips: fitChips(check),
    problems,
    status,
    ready: status === "ready",
    message: row.status !== "invalid" && requestBlock ? requestBlock.text.en : messageOf(row, stored),
    error: row.error,
    attempts: row.attempts,
    canRetry: status === "error" && sendable(row, nowMs),
    retryAt: (status === "error" || status === "pending") && row.nextCheckAt ? iso(row.nextCheckAt) : null,
    metaImageHash: row.metaImageHash,
    metaVideoId: row.metaVideoId,
    metaThumbHash: row.metaThumbHash,
    adOnly: row.adOnly,
    lastUsedAt: iso(row.lastUsedAt),
    createdAt: iso(row.createdAt) ?? "",
    updatedAt: iso(row.updatedAt) ?? "",
  };
}

/** get_ad_media: one row of the workspace, or null. */
export async function getAdMedia(tenantId: string, id: string, options: { deps?: Partial<MediaDeps> } = {}): Promise<AdMediaView | null> {
  if (typeof id !== "string" || !ID.test(id)) return null;
  const row = await prisma.adMedia.findFirst({ where: { id, tenantId } });
  return row ? viewOf(row, mediaDeps(options.deps).now()) : null;
}

export type ListOptions = { adAccountAssetId?: string | null; kind?: "image" | "video" | null; status?: AdMediaStatus | null; limit?: number; deps?: Partial<MediaDeps> };

/** list_ad_media: the workspace's ad media, newest first (at most 100). */
export async function listAdMedia(tenantId: string, options: ListOptions = {}): Promise<AdMediaView[]> {
  const where: Prisma.AdMediaWhereInput = { tenantId };
  if (options.adAccountAssetId) where.adAccountAssetId = options.adAccountAssetId;
  if (options.kind) where.kind = options.kind;
  if (options.status) where.status = options.status;
  const take = Math.min(MAX_LIST, Math.max(1, Math.floor(options.limit ?? 50)));
  const rows = await prisma.adMedia.findMany({ where, orderBy: { createdAt: "desc" }, take });
  const now = mediaDeps(options.deps).now();
  return rows.map((r) => viewOf(r, now));
}

/**
 * A draft refers to these items (5.5): lastUsedAt becomes now, which keeps ad-only crops from retention for 30 more days.
 * updatedAt is left alone, so a video's processing clock and the retention of processed originals do not move.
 */
export async function markAdMediaUsed(tenantId: string, ids: readonly string[], options: { deps?: Partial<MediaDeps> } = {}): Promise<number> {
  const list = [...new Set(ids)].filter((id) => typeof id === "string" && ID.test(id)).slice(0, 50);
  if (list.length === 0) return 0;
  const at = new Date(mediaDeps(options.deps).now());
  const rows = await prisma.adMedia.findMany({ where: { tenantId, id: { in: list } }, select: { id: true, updatedAt: true } });
  let n = 0;
  for (const r of rows) n += (await prisma.adMedia.updateMany({ where: { id: r.id, tenantId }, data: { lastUsedAt: at, updatedAt: r.updatedAt } })).count;
  return n;
}

// =====================================================================================================================
// The two transfers that are not Graph calls
// =====================================================================================================================

/** The URL when it is https on Meta's media CDN (*.fbcdn.net), with no credentials and no custom port; else null. */
export function metaCdnUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return null;
  return url.hostname.toLowerCase().endsWith(META_CDN_SUFFIX) ? url : null;
}

const isJpegOrPng = (b: Uint8Array) => (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) || (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47);

/**
 * Downloads Meta's preferred thumbnail of a processed video. Only from Meta's CDN: each redirect is checked again, the body is
 * capped at MAX_THUMBNAIL_BYTES, and it must be a JPEG or PNG. No credentials are sent.
 */
export async function downloadMetaThumbnail(raw: string): Promise<Uint8Array> {
  const signal = AbortSignal.timeout(THUMBNAIL_TIMEOUT_MS);
  let current = raw;
  for (let hop = 0; hop <= THUMBNAIL_REDIRECTS; hop++) {
    const url = metaCdnUrl(current);
    if (!url) throw new HttpError(502, "Meta's thumbnail is not on Meta's media servers.");
    const res = await fetch(url.toString(), { method: "GET", redirect: "manual", signal });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      await res.body?.cancel().catch(() => undefined);
      if (!location) break;
      current = new URL(location, url).toString();
      continue;
    }
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => undefined);
      throw new HttpError(502, "Meta's thumbnail couldn't be downloaded.");
    }
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_THUMBNAIL_BYTES) {
      await res.body.cancel().catch(() => undefined);
      throw new HttpError(502, "Meta's thumbnail is too large.");
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_THUMBNAIL_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new HttpError(502, "Meta's thumbnail is too large.");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(Buffer.concat(chunks, total));
    if (!isJpegOrPng(bytes)) throw new HttpError(502, "Meta's thumbnail is not an image.");
    return bytes;
  }
  throw new HttpError(502, "Meta's thumbnail couldn't be downloaded.");
}

/** The upload URL when it is https on rupload.facebook.com, with no credentials and no custom port; else null. */
export function ruploadUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return null;
  return url.hostname.toLowerCase() === RUPLOAD_HOST ? url : null;
}

/**
 * PROMOTE_VIDEO=resumable (M2, B12): posts the video's bytes to the upload_url video_ads start returned, on rupload.facebook.com
 * only, streamed from disk, with the ad account's user token. Sent once; a failure is ambiguous (the bytes may have arrived).
 */
export async function uploadVideoToRupload(input: VideoBytesUpload): Promise<void> {
  const url = ruploadUrl(input.uploadUrl);
  if (!url) throw new PromoteMetaError("bad_response", true);
  const body = Readable.toWeb(createReadStream(input.filePath)) as unknown as ReadableStream<Uint8Array>;
  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    headers: { Authorization: `OAuth ${input.token}`, offset: "0", file_size: String(input.size), "Content-Type": "application/octet-stream" },
    body,
    duplex: "half",
    redirect: "error",
    signal: AbortSignal.timeout(RUPLOAD_TIMEOUT_MS),
  };
  let res: Response;
  try {
    res = await fetch(url.toString(), init);
  } catch {
    throw new GraphError("Network error uploading the video", 0, undefined, undefined, false, true);
  }
  await res.body?.cancel().catch(() => undefined);
  if (!res.ok) throw new GraphError(`Video upload failed with status ${res.status}`, res.status, undefined, undefined, false, res.status >= 500);
}
