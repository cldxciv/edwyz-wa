import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeDb } from "./helpers/fake-db";

/**
 * docs/IG-PAGE-ADS-SPEC.md D21, D34, 4.2 M1 to M3, 4.8, 5.1 AdMedia, 5.5 and PRM-06 (promote-media), against the fake Meta of 9.3
 * and the in-memory database: dedupe by sha256 per ad account, an image becomes a hash, a video goes processing then ready with a
 * thumbnail hash, signed file_url links of at least 2 hours, the resumable upload to rupload.facebook.com only, errors in plain
 * words with at most 5 attempts, the 30-minute processing limit, the dry run with no network call, the content quota for crops,
 * adOnly and lastUsedAt, the routes' guards and rate limit, and every request classified not_spend.
 *
 * The review fixes: only a crop this server made is ad-only, never a file a post, a reply or other ad media uses; attempts never
 * pass 5 (the in-memory AdMedia table enforces the 0012 CHECKs and unique index here, as Postgres does); a row whose file is gone
 * takes the file prepared next; every write after a claim holds to its lease, which outlasts the longest send; the request
 * answers within PREPARE_SEND_WAIT_MS and hands videos to the task; the task keeps to its budget and runs resumable uploads
 * beside the pass; and a block that depends on the placements never changes the shared row.
 */

const h = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  type Delegate = Record<string, (args: never) => Promise<unknown>>;
  const STATUSES = ["pending", "uploading", "processing", "ready", "invalid", "error"];
  const SOURCES = ["content", "creative", "ig_copy", "crop"];
  /** What Postgres refuses (prisma/migrations/0012_ig_page_ads): the AdMedia CHECKs, and the (tenantId, adAccountAssetId, sha256) unique index. */
  function assertRow(row: Row, others: Row[]): void {
    const attempts = row.attempts;
    if (typeof attempts !== "number" || !Number.isInteger(attempts) || attempts < 0 || attempts > 5) throw new Error(`AdMedia violates check constraint "AdMedia_attempts_check" (attempts ${String(attempts)})`);
    if (!STATUSES.includes(String(row.status))) throw new Error(`AdMedia violates check constraint "AdMedia_status_check" (${String(row.status)})`);
    if (!SOURCES.includes(String(row.source))) throw new Error(`AdMedia violates check constraint "AdMedia_source_check" (${String(row.source)})`);
    if (others.some((o) => o.id !== row.id && o.tenantId === row.tenantId && o.adAccountAssetId === row.adAccountAssetId && o.sha256 === row.sha256)) {
      throw Object.assign(new Error("Unique constraint failed on AdMedia_tenant_account_sha_key"), { code: "P2002" });
    }
  }
  /** Wraps the fake's AdMedia writes with those checks, and lets scheduledPost.count read `mediaKeys: { has }`. */
  function enforce(db: { prisma: Record<string, unknown>; rows: (name: string) => Row[] }): void {
    const media = db.prisma.adMedia as Delegate;
    const create = media.create as (args: { data: Row }) => Promise<unknown>;
    const updateMany = media.updateMany as (args: { where?: Row; data: Row }) => Promise<{ count: number }>;
    const findMany = media.findMany as (args: { where?: Row }) => Promise<Row[]>;
    (media as Record<string, unknown>).create = async (args: { data: Row }) => {
      assertRow(args.data, db.rows("adMedia"));
      return create(args);
    };
    (media as Record<string, unknown>).updateMany = async (args: { where?: Row; data: Row }) => {
      // One statement: every matching row is checked as written before any is changed.
      const all = db.rows("adMedia");
      for (const r of await findMany({ where: args.where })) assertRow({ ...r, ...args.data }, all);
      return updateMany(args);
    };
    (db.prisma.scheduledPost as Record<string, unknown>).count = async ({ where }: { where: Row & { mediaKeys?: { has?: string } } }) => {
      const { mediaKeys, ...rest } = where;
      return db.rows("scheduledPost").filter((r) => Object.entries(rest).every(([k, v]) => r[k] === v) && (!mediaKeys?.has || ((r.mediaKeys as string[] | undefined) ?? []).includes(mediaKeys.has))).length;
    };
  }
  return { db: null as unknown as FakeDb, getActor: vi.fn(), enforce };
});
vi.mock("@/lib/db", async () => {
  const { createFakeDb } = await import("./helpers/fake-db");
  h.db = createFakeDb();
  h.enforce(h.db as unknown as Parameters<typeof h.enforce>[0]);
  return { prisma: h.db.prisma };
});
vi.mock("@/lib/auth", () => ({ getActor: h.getActor }));

import { GET as getOneRoute } from "@/app/api/promote/media/[id]/route";
import { GET as listRoute, POST as prepareRoute } from "@/app/api/promote/media/route";
import { isAdCropKey, listMedia, MAX_SIGNED_URL_TTL_SECONDS, mediaPublicUrl, mediaQuotaMessage, newAdCropKey, saveUpload, SIGNED_URL_TTL_SECONDS, verifySignature } from "@/lib/content/media";
import { GraphError } from "@/lib/graph";
import type { AssetAccess } from "@/lib/meta-connect";
import {
  AD_VIDEO_URL_TTL_SECONDS,
  downloadMetaThumbnail,
  FILE_PROBLEMS,
  FRESH_START_AFTER_MS,
  getAdMedia,
  markAdMediaUsed,
  MAX_ATTEMPTS,
  MEDIA_MESSAGES,
  MEDIA_PREPARES_PER_HOUR,
  type MediaDeps,
  META_WRITE_MAX_MS,
  metaCdnUrl,
  POLL_EVERY_MS,
  prepare,
  PREPARE_SEND_WAIT_MS,
  prepareLimiter,
  PROCESSING_TIMEOUT_MS,
  RETRY_BACKOFF_MS,
  RUPLOAD_TIMEOUT_MS,
  ruploadUrl,
  sendAdMedia,
  setMediaDepsForTests,
  UPLOAD_LEASE_MS,
  uploadVideoToRupload,
} from "@/lib/promote/media";
import { type AdImage, createPromoteMeta, type PromoteMeta } from "@/lib/promote/meta";
import { PROMOTE_NOT_FOUND, PROMOTE_WRITERS_ONLY } from "@/lib/promote/route-guard";
import { backgroundUploads, MEDIA_TASK_BATCH, MEDIA_TASK_BUDGET_MS, runMediaTask, settleBackgroundUploads } from "@/lib/promote/tasks/media";
import { createThrottle, type SettingStore } from "@/lib/promote/throttle";
import { classify } from "@/lib/spend/classify";
import { HttpError } from "@/lib/tenancy";
import { createFakeMetaPromote, FAKE_USER_TOKEN, type FakeMetaPromote } from "./helpers/fake-meta-promote";

const ORIGIN = "https://wa.edwyz.com";
const T = "tenant_1";
const OTHER = "tenant_2";
const ACCOUNT = "ad_asset";
const ACCOUNT_2 = "ad_asset_2";
const T0 = Date.parse("2026-10-31T10:00:00Z");
const DATA = mkdtempSync(path.join(tmpdir(), "promote-media-"));
const SECRET = "9f3a6c1e8b2d47f05a7e9c3b1d6f4a82c5e0b7391d8a6f2e4c7b0a9d3e5f1862";
const SECRET_2 = "3c7e1a9f5b2d8e4c6a0f9b3d7e1c5a8f2b6d0e4a9c3f7b1e5d8a2c6f0b4e9d73";
const SAVED = Object.fromEntries(["DATA_DIR", "CONTENT_MEDIA_SECRET", "CREATIVE_MEDIA_SECRET", "SITE_URL", "PROMOTE_ENABLED", "CONTENT_MEDIA_QUOTA_MB", "PROMOTE_EXPERIMENTAL"].map((k) => [k, process.env[k]]));

// ----- Files -----

const key = (n: number, ext: "jpg" | "png" | "mp4" | "mov") => `${n.toString(16).padStart(32, "0")}.${ext}`;

/** A baseline JPEG of the given size: SOI, SOF0, SOS, image data with no FF byte, EOI. `seed` changes the bytes. */
function jpeg(width: number, height: number, seed = 1): Buffer {
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01];
  const sos = [0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00];
  const data = Array.from({ length: 256 }, (_, i) => (i * 7 + seed) % 200);
  return Buffer.from([0xff, 0xd8, ...sof, ...sos, ...data, 0xff, 0xd9]);
}

const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const zeros = (n: number) => new Array<number>(n).fill(0);
const box = (type: string, ...payload: number[][]) => {
  const body = payload.flat();
  return [...be32(8 + body.length), ...ascii(type), ...body];
};

/** A small MP4: one H.264 video track of the given size and length, moov first. `seed` changes the bytes. */
function mp4(width: number, height: number, durationMs = 15_000, seed = 1): Buffer {
  const matrix = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000].flatMap(be32);
  const tkhd = box("tkhd", [0, 0, 0, 7], zeros(8), be32(1), zeros(4), zeros(4), zeros(8), zeros(8), matrix, be32(width * 0x10000), be32(height * 0x10000));
  const trak = box(
    "trak",
    tkhd,
    box(
      "mdia",
      box("mdhd", [0, 0, 0, 0], zeros(8), be32(1000), be32(durationMs), zeros(4)),
      box("hdlr", [0, 0, 0, 0], zeros(4), ascii("vide"), zeros(12), [0]),
      box("minf", box("vmhd", [0, 0, 0, 1], zeros(8)), box("stbl", box("stsd", [0, 0, 0, 0], be32(1), box("avc1", zeros(78))), box("stts", [0, 0, 0, 0], be32(0)))),
    ),
  );
  const moov = box("moov", box("mvhd", [0, 0, 0, 0], zeros(8), be32(1000), be32(durationMs), zeros(80)), trak);
  const ftyp = box("ftyp", ascii("isom"), be32(512), ascii("isomiso2avc1mp41"));
  const mdat = box("mdat", Array.from({ length: 512 }, (_, i) => (i + seed) % 251));
  return Buffer.from([...ftyp, ...moov, ...mdat]);
}

function putContent(tenant: string, file: string, bytes: Buffer): string {
  const dir = path.join(DATA, "content", tenant);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, file), bytes);
  return file;
}

function putCreative(tenant: string, file: string, bytes: Buffer): void {
  const dir = path.join(DATA, "creative", tenant);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, file), bytes);
}

// ----- Fake Meta, the Graph client and the clock -----

function memoryStore(): SettingStore {
  const rows = new Map<string, unknown>();
  return { get: async (k) => (rows.has(k) ? structuredClone(rows.get(k)) : null), set: async (k, v) => void rows.set(k, structuredClone(v)) };
}

let now = T0;
let env: Record<string, string | undefined> = {};
let fake: FakeMetaPromote;
let meta: PromoteMeta;
let fetchMock: ReturnType<typeof vi.fn>;
let assets: Record<string, AssetAccess>;
let deps: Partial<MediaDeps>;
const ruploads: { url: string; headers: Record<string, string>; bytes: number }[] = [];
const THUMB = jpeg(640, 1138, 99);
const thumbs = vi.fn(async (_url: string) => new Uint8Array(THUMB));

function setup() {
  fake = createFakeMetaPromote();
  fake.base.addAccount({ id: "act_2" });
  ruploads.length = 0;
  fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === "rupload.facebook.com") {
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
      const bytes = (await new Response(init?.body as ReadableStream).arrayBuffer()).byteLength;
      ruploads.push({ url: url.toString(), headers, bytes });
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    return fake.fetch(input, init);
  });
  vi.stubGlobal("fetch", fetchMock);
  assets = {
    [ACCOUNT]: { assetId: ACCOUNT, type: "ad_account", externalId: "act_1", name: "Ads", token: FAKE_USER_TOKEN },
    [ACCOUNT_2]: { assetId: ACCOUNT_2, type: "ad_account", externalId: "act_2", name: "Ads 2", token: FAKE_USER_TOKEN },
  };
  const access = vi.fn(async (_tenantId: string, assetId: string) => {
    const a = assets[assetId];
    if (!a) throw new HttpError(404, "Asset not found.");
    return a;
  });
  meta = createPromoteMeta({
    access,
    sandbox: async () => false,
    store: memoryStore(),
    throttle: createThrottle({ store: memoryStore(), now: () => now }),
    env,
    sleep: async () => undefined,
    now: () => now,
    readTimeoutMs: 2_000,
    writeTimeoutMs: 2_000,
  });
  deps = { meta, access, env, now: () => now, downloadThumbnail: thumbs };
  setMediaDepsForTests(deps);
}

/** A promise the test settles by hand: a Meta call that is still running. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets sends that outlived their answer (a timer, a few database writes) finish. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 30));

/** A crop the browser made for an ad, as /api/content/media?purpose=ad_crop stores it. */
const putCrop = (tenant: string, bytes: Buffer) => putContent(tenant, newAdCropKey(tenant, "jpg"), bytes);

const callsTo = (edge: RegExp, method = "POST") => fake.calls.filter((c) => c.method === method && edge.test(c.path));
const rows = () => h.db.rows("adMedia") as Record<string, unknown>[];
const rowOf = (id: string) => rows().find((r) => r.id === id) as Record<string, unknown>;
const advance = (ms: number) => void (now += ms);

beforeEach(async () => {
  for (const name of Object.keys(h.db.tables)) delete h.db.tables[name];
  now = T0;
  env = {};
  thumbs.mockClear();
  process.env.DATA_DIR = DATA;
  process.env.CONTENT_MEDIA_SECRET = SECRET;
  process.env.CREATIVE_MEDIA_SECRET = SECRET_2;
  process.env.SITE_URL = ORIGIN;
  delete process.env.CONTENT_MEDIA_QUOTA_MB;
  delete process.env.PROMOTE_EXPERIMENTAL;
  process.env.PROMOTE_ENABLED = "on";
  rmSync(DATA, { recursive: true, force: true });
  mkdirSync(DATA, { recursive: true });
  await prepareLimiter.clear();
  h.getActor.mockReset();
  h.getActor.mockResolvedValue({ userId: "u1", tenantId: T, role: "owner" });
  setup();
});

afterEach(async () => {
  await settleBackgroundUploads();
  setMediaDepsForTests(null);
  vi.unstubAllGlobals();
});

afterAll(() => {
  rmSync(DATA, { recursive: true, force: true });
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** Rejects with an HttpError: its status and message. */
async function refusal(promise: Promise<unknown>): Promise<{ status: number; message: string }> {
  try {
    await promise;
  } catch (error) {
    return { status: (error as { status: number }).status, message: (error as Error).message };
  }
  throw new Error("expected a refusal");
}

// =====================================================================================================================
// Images (M1)
// =====================================================================================================================

describe("prepare: images through adimages (M1)", () => {
  it("the same file prepared twice for one account is one row and one adimages call; a second account gets a second row", async () => {
    const file = putContent(T, key(1, "jpg"), jpeg(1080, 1350));
    const first = await prepare(T, ACCOUNT, { source: "content", key: file }, ["instagram_feed"]);
    const again = await prepare(T, ACCOUNT, { source: "content", key: file }, ["instagram_feed"]);
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.media.id).toBe(first.media.id);
    expect(rows()).toHaveLength(1);
    expect(callsTo(/^act_1\/adimages$/)).toHaveLength(1);

    // The same bytes under another library key are the same file.
    const copy = putContent(T, key(2, "jpg"), jpeg(1080, 1350));
    expect((await prepare(T, ACCOUNT, { source: "content", key: copy })).media.id).toBe(first.media.id);
    expect(callsTo(/adimages$/)).toHaveLength(1);

    const second = await prepare(T, ACCOUNT_2, { source: "content", key: file }, ["instagram_feed"]);
    expect(second.created).toBe(true);
    expect(second.media.id).not.toBe(first.media.id);
    expect(rows()).toHaveLength(2);
    expect(callsTo(/^act_2\/adimages$/)).toHaveLength(1);
    expect(rowOf(first.media.id).sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(rowOf(second.media.id).sha256).toBe(rowOf(first.media.id).sha256);
  });

  it("an image ends ready with its hash, size and ratio, and fits and problems follow the placements", async () => {
    const file = putContent(T, key(3, "jpg"), jpeg(1080, 1350));
    const { media } = await prepare(T, ACCOUNT, { source: "content", key: file }, ["instagram_feed", "facebook_feed"]);
    const sent = callsTo(/^act_1\/adimages$/)[0];
    expect(media).toMatchObject({ status: "ready", ready: true, kind: "image", mime: "image/jpeg", width: 1080, height: 1350, ratio: "4:5", adOnly: false, attempts: 1, error: null });
    expect(media.metaImageHash).toMatch(/^[a-f0-9]{32}$/);
    expect(Buffer.from((sent.body as { bytes: string }).bytes, "base64").equals(jpeg(1080, 1350))).toBe(true);
    expect(media.fits).toEqual(["feed", "carousel"]);
    expect(media.problems).toEqual([]);
    expect(media.chips.map((c) => c.text.en)).toEqual(["Feed 4:5 ✓", "Stories and Reels 9:16: missing"]);
    expect(media.message).toBe(MEDIA_MESSAGES.ready);

    // Automatic placements (empty) include Stories and Reels: a 4:5 image there gets plain warnings, and is not sent again.
    const auto = await prepare(T, ACCOUNT, { source: "content", key: file }, []);
    expect(auto.media.problems.map((p) => [p.code, p.severity])).toEqual([
      ["not_tall", "warn"],
      ["image_reel", "warn"],
    ]);
    expect(auto.media.problems[0].text.en).toBe("This image is 4:5. Stories and Reels look best at 9:16; add a tall version.");
    expect(auto.media.status).toBe("ready");
    expect(callsTo(/adimages$/)).toHaveLength(1);

    // A tall version fits Stories and Reels.
    const tall = putContent(T, key(4, "jpg"), jpeg(1080, 1920, 2));
    const t = await prepare(T, ACCOUNT, { source: "content", key: tall }, ["instagram_stories", "instagram_reels"]);
    expect(t.media.fits).toEqual(["stories_reels"]);
    expect(t.media.chips.map((c) => [c.text.en, c.ok])).toEqual([
      ["Feed 4:5: missing", false],
      ["Stories and Reels 9:16 ✓", true],
    ]);
  });

  it("a file checkMedia blocks is stored as invalid with plain reasons and never sent; a damaged file is refused", async () => {
    const small = putContent(T, key(5, "jpg"), jpeg(400, 500));
    const { media } = await prepare(T, ACCOUNT, { source: "content", key: small }, ["instagram_feed"]);
    expect(media.status).toBe("invalid");
    expect(media.problems[0]).toMatchObject({ code: "too_small", severity: "block" });
    expect(media.message).toBe("This is 400 px wide. Meta needs at least 500 px.");
    expect(fetchMock).not.toHaveBeenCalled();

    const broken = putContent(T, key(6, "jpg"), jpeg(1080, 1350).subarray(0, 40));
    expect(await refusal(prepare(T, ACCOUNT, { source: "content", key: broken }))).toMatchObject({ status: 422 });
    expect(await refusal(prepare(T, ACCOUNT, { source: "content", key: key(7, "jpg") }))).toEqual({ status: 404, message: MEDIA_MESSAGES.notInLibrary });
    expect(await refusal(prepare(T, ACCOUNT, { source: "content", key: "../../etc/passwd" }))).toEqual({ status: 400, message: MEDIA_MESSAGES.chooseSource });
    expect(await refusal(prepare(T, ACCOUNT, { source: "content", key: small }, ["nowhere" as never]))).toEqual({ status: 400, message: MEDIA_MESSAGES.choosePlacements });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads Creative Studio files by asset id, only when the creative is made and passed its policy check", async () => {
    putCreative(T, "img1.jpg", jpeg(1080, 1080, 3));
    h.db.seed("creativeAsset", [
      { id: "ca_ready", tenantId: T, kind: "image", storageKey: "img1.jpg", status: "approved", policyCheck: { result: "pass" } },
      { id: "ca_pending", tenantId: T, kind: "image", storageKey: null, status: "pending", policyCheck: null },
      { id: "ca_blocked", tenantId: T, kind: "image", storageKey: "img1.jpg", status: "ready", policyCheck: { result: "block" } },
      { id: "ca_copy", tenantId: T, kind: "copy", storageKey: null, status: "ready", policyCheck: null },
    ]);
    const { media } = await prepare(T, ACCOUNT, { source: "creative", assetId: "ca_ready" }, ["instagram_feed"]);
    expect(media).toMatchObject({ status: "ready", source: "creative", sourceKey: "ca_ready", ratio: "1:1", adOnly: false });
    expect(await refusal(prepare(T, ACCOUNT, { source: "creative", assetId: "ca_pending" }))).toEqual({ status: 409, message: MEDIA_MESSAGES.creativeNotReady });
    expect(await refusal(prepare(T, ACCOUNT, { source: "creative", assetId: "ca_blocked" }))).toEqual({ status: 409, message: MEDIA_MESSAGES.creativePolicy });
    expect(await refusal(prepare(T, ACCOUNT, { source: "creative", assetId: "ca_copy" }))).toEqual({ status: 409, message: MEDIA_MESSAGES.creativeUnusable });
    // Another workspace's asset is not found.
    expect(await refusal(prepare(OTHER, ACCOUNT, { source: "creative", assetId: "ca_ready" }))).toEqual({ status: 404, message: MEDIA_MESSAGES.creativeMissing });
  });
});

// =====================================================================================================================
// Videos (M2, M3) and the task
// =====================================================================================================================

describe("prepare: videos through advideos (M2), then the task (M3)", () => {
  it("with PROMOTE_VIDEO=file_url a video waits for the task, goes processing, then ready after 3 checks, with its thumbnail hash", async () => {
    env.PROMOTE_VIDEO = "file_url";
    fake.setVideoPolls(2);
    const file = putContent(T, key(10, "mp4"), mp4(1080, 1920));
    const { media } = await prepare(T, ACCOUNT, { source: "content", key: file }, ["instagram_stories", "instagram_reels"]);
    // The request sends no video: it answers at once, and the task sends it.
    expect(media).toMatchObject({ status: "pending", kind: "video", mime: "video/mp4", width: 1080, height: 1920, durationMs: 15_000, ratio: "9:16", ready: false, attempts: 0 });
    expect(media.metaVideoId ?? null).toBeNull();
    expect(media.message).toBe(MEDIA_MESSAGES.pending);
    expect(fake.calls).toHaveLength(0);
    expect(await runMediaTask()).toEqual({ uploaded: 1, polled: 0, failed: 0 });
    const sentRow = rowOf(media.id);
    expect(sentRow).toMatchObject({ status: "processing", attempts: 1 });
    expect(String(sentRow.metaVideoId)).toMatch(/^\d+$/);
    expect((await getAdMedia(T, media.id))?.message).toBe("Meta is still preparing your video. This usually takes 5 to 30 minutes.");

    // The file_url is signed, points at the library file, and lasts at least 2 hours.
    const sent = callsTo(/^act_1\/advideos$/);
    expect(sent).toHaveLength(1);
    const url = new URL((sent[0].body as { file_url: string }).file_url);
    expect(url.origin + url.pathname).toBe(`${ORIGIN}/api/content/media-public/${T}/${file}`);
    const exp = url.searchParams.get("exp");
    expect(Number(exp) - Math.floor(now / 1000)).toBeGreaterThanOrEqual(7_200);
    expect(AD_VIDEO_URL_TTL_SECONDS).toBeGreaterThanOrEqual(7_200);
    expect(verifySignature(T, file, exp, url.searchParams.get("sig"), now + 7_100_000)).toBe(true);
    expect(verifySignature(T, file, exp, url.searchParams.get("sig"), now + 7_300_000)).toBe(false);

    // Not due before 30 s.
    expect(await runMediaTask()).toEqual({ uploaded: 0, polled: 0, failed: 0 });
    const clock = rowOf(media.id).updatedAt;
    advance(POLL_EVERY_MS);
    expect(await runMediaTask()).toEqual({ uploaded: 0, polled: 1, failed: 0 });
    expect(rowOf(media.id).status).toBe("processing");
    advance(POLL_EVERY_MS);
    expect(await runMediaTask()).toEqual({ uploaded: 0, polled: 1, failed: 0 });
    expect(rowOf(media.id)).toMatchObject({ status: "processing", updatedAt: clock });
    advance(POLL_EVERY_MS);
    expect(await runMediaTask()).toEqual({ uploaded: 0, polled: 1, failed: 0 });

    const done = rowOf(media.id);
    expect(done).toMatchObject({ status: "ready", nextCheckAt: null, error: null });
    expect(callsTo(/^\d+$/, "GET")).toHaveLength(3);
    // Meta's preferred thumbnail (is_preferred) went up through M1, and its hash is stored.
    expect(thumbs).toHaveBeenCalledTimes(1);
    expect(thumbs.mock.calls[0][0]).toMatch(/_2\.jpg$/);
    const thumbCall = callsTo(/^act_1\/adimages$/);
    expect(thumbCall).toHaveLength(1);
    expect(Buffer.from((thumbCall[0].body as { bytes: string }).bytes, "base64").equals(THUMB)).toBe(true);
    expect(done.metaThumbHash).toMatch(/^[a-f0-9]{32}$/);
    expect(await runMediaTask()).toEqual({ uploaded: 0, polled: 0, failed: 0 });
  });

  it("with PROMOTE_VIDEO=off a video is refused in plain words, before any read or call", async () => {
    const file = putContent(T, key(11, "mp4"), mp4(1080, 1920));
    expect(await refusal(prepare(T, ACCOUNT, { source: "content", key: file }))).toEqual({ status: 409, message: "Video ads aren't open yet. Choose an image for now." });
    expect(rows()).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a Creative Studio video is fetched by Meta from its own signed link, also good for 2 hours", async () => {
    env.PROMOTE_VIDEO = "file_url";
    putCreative(T, "reel.mp4", mp4(1080, 1920, 12_000, 5));
    h.db.seed("creativeAsset", [{ id: "ca_video", tenantId: T, kind: "video", storageKey: "reel.mp4", status: "ready", policyCheck: null }]);
    const { media } = await prepare(T, ACCOUNT, { source: "creative", assetId: "ca_video" });
    expect(media.status).toBe("pending");
    await runMediaTask();
    expect(rowOf(media.id).status).toBe("processing");
    const url = new URL((callsTo(/advideos$/)[0].body as { file_url: string }).file_url);
    expect(url.pathname).toBe(`/api/creative/public/${T}/ca_video`);
    expect(Number(url.searchParams.get("exp")) - Math.floor(now / 1000)).toBe(AD_VIDEO_URL_TTL_SECONDS);
  });

  it("with PROMOTE_VIDEO=resumable the task claims the row and uploads beside its pass: start, bytes to rupload.facebook.com only, finish", async () => {
    env.PROMOTE_VIDEO = "resumable";
    const bytes = mp4(1080, 1080, 8_000, 7);
    const file = putContent(T, key(12, "mp4"), bytes);
    const { media } = await prepare(T, ACCOUNT, { source: "content", key: file });
    expect(media.status).toBe("pending");
    expect(fake.calls).toHaveLength(0);

    // The run claims the row (uploading, with a lease longer than the upload) and returns; the upload runs beside it.
    expect(await runMediaTask()).toEqual({ uploaded: 0, polled: 0, failed: 0 });
    expect(backgroundUploads()).toBe(1);
    expect(rowOf(media.id)).toMatchObject({ status: "uploading", attempts: 1, nextCheckAt: new Date(now + UPLOAD_LEASE_MS) });
    await settleBackgroundUploads();
    expect(backgroundUploads()).toBe(0);
    expect(rowOf(media.id)).toMatchObject({ status: "processing", attempts: 1 });
    const phases = callsTo(/^act_1\/video_ads$/).map((c) => (c.body as { upload_phase: string }).upload_phase);
    expect(phases).toEqual(["start", "finish"]);
    expect(callsTo(/advideos$/)).toHaveLength(0);
    expect(ruploads).toHaveLength(1);
    expect(new URL(ruploads[0].url).hostname).toBe("rupload.facebook.com");
    expect(ruploads[0].headers).toMatchObject({ authorization: `OAuth ${FAKE_USER_TOKEN}`, offset: "0", file_size: String(bytes.length) });
    expect(ruploads[0].bytes).toBe(bytes.length);
  });

  it("runs one resumable upload at a time per process; the next waits for a later run", async () => {
    env.PROMOTE_VIDEO = "resumable";
    const hold = deferred<void>();
    deps.uploadVideoBytes = async () => hold.promise;
    setMediaDepsForTests(deps);
    const a = await prepare(T, ACCOUNT, { source: "content", key: putContent(T, key(13, "mp4"), mp4(1080, 1920, 9_000, 13)) });
    const b = await prepare(T, ACCOUNT, { source: "content", key: putContent(T, key(14, "mp4"), mp4(1080, 1920, 9_000, 14)) });
    await runMediaTask();
    expect(backgroundUploads()).toBe(1);
    expect([rowOf(a.media.id).status, rowOf(b.media.id).status].sort()).toEqual(["pending", "uploading"]);
    // Still running: the next run starts no second upload.
    await runMediaTask();
    expect(backgroundUploads()).toBe(1);
    hold.resolve();
    await settleBackgroundUploads();
    await runMediaTask();
    await settleBackgroundUploads();
    expect([rowOf(a.media.id).status, rowOf(b.media.id).status]).toEqual(["processing", "processing"]);
  });

  it("the byte upload refuses any host but rupload.facebook.com, before any network call", async () => {
    expect(ruploadUrl("https://rupload.facebook.com/video-ads-upload/v26.0/1")).not.toBeNull();
    for (const bad of ["http://rupload.facebook.com/x", "https://rupload.facebook.com.evil.example/x", "https://evil.example/x", "https://user:pw@rupload.facebook.com/x", "https://rupload.facebook.com:8443/x", "not a url"]) {
      expect(ruploadUrl(bad), bad).toBeNull();
    }
    const file = path.join(DATA, "v.mp4");
    writeFileSync(file, mp4(100, 100));
    await expect(uploadVideoToRupload({ uploadUrl: "https://evil.example/upload", token: "t", filePath: file, size: statSync(file).size })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// =====================================================================================================================
// Errors, retries and the time limit
// =====================================================================================================================

describe("errors in plain words, at most 5 attempts, and the 30-minute limit", () => {
  it("Meta errors raise attempts with a growing wait and stop at 5 with a plain error", async () => {
    for (let i = 0; i < MAX_ATTEMPTS; i++) fake.failNextCreate({ match: /adimages$/, status: 500, apply: false });
    const file = putContent(T, key(20, "jpg"), jpeg(1080, 1350, 20));
    const { media } = await prepare(T, ACCOUNT, { source: "content", key: file }, ["instagram_feed"]);
    expect(media).toMatchObject({ status: "error", attempts: 1, error: MEDIA_MESSAGES.retrySoon, canRetry: true });
    expect(media.retryAt).toBe(new Date(now + RETRY_BACKOFF_MS[0]).toISOString());

    for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt++) {
      // Not due yet: nothing is sent.
      expect((await runMediaTask()).uploaded + (await runMediaTask()).failed).toBe(0);
      now = (rowOf(media.id).nextCheckAt as Date).getTime();
      expect(await runMediaTask()).toEqual({ uploaded: 0, polled: 0, failed: 1 });
      expect(rowOf(media.id).attempts).toBe(attempt);
    }
    const last = rowOf(media.id);
    expect(last).toMatchObject({ status: "error", attempts: MAX_ATTEMPTS, nextCheckAt: null, error: MEDIA_MESSAGES.gaveUp });
    expect(String(last.error)).not.toMatch(/OAuthException|#\d|unexpected error|code/i);
    expect(callsTo(/adimages$/)).toHaveLength(MAX_ATTEMPTS);

    // No sixth send: not by the task, and not by the person until a day has passed.
    advance(6 * 3_600_000);
    expect(await runMediaTask()).toEqual({ uploaded: 0, polled: 0, failed: 0 });
    const again = await prepare(T, ACCOUNT, { source: "content", key: file }, ["instagram_feed"]);
    expect(again.media).toMatchObject({ status: "error", canRetry: false, message: MEDIA_MESSAGES.gaveUp });
    expect(callsTo(/adimages$/)).toHaveLength(MAX_ATTEMPTS);
    advance(24 * 3_600_000);
    const fresh = await prepare(T, ACCOUNT, { source: "content", key: file }, ["instagram_feed"]);
    expect(fresh.media).toMatchObject({ status: "ready", attempts: 1 });
    expect(rowOf(media.id).attempts).toBeLessThanOrEqual(MAX_ATTEMPTS);
  });

  it("an error that needs a person is not retried by the task, and a retry by the person sends again", async () => {
    assets[ACCOUNT] = { ...assets[ACCOUNT], token: "EXPIRED_TOKEN" };
    const file = putContent(T, key(21, "jpg"), jpeg(1080, 1350, 21));
    const { media } = await prepare(T, ACCOUNT, { source: "content", key: file });
    expect(media).toMatchObject({ status: "error", attempts: 1, error: MEDIA_MESSAGES.reconnect, retryAt: null, canRetry: true });
    advance(2 * 3_600_000);
    expect(await runMediaTask()).toEqual({ uploaded: 0, polled: 0, failed: 0 });
    expect(callsTo(/adimages$/)).toHaveLength(1);

    assets[ACCOUNT] = { ...assets[ACCOUNT], token: FAKE_USER_TOKEN };
    const retried = await prepare(T, ACCOUNT, { source: "content", key: file });
    expect(retried.media).toMatchObject({ status: "ready", attempts: 2, error: null });
  });

  it("a file deleted before its retry ends in a plain error, with no Meta call", async () => {
    fake.failNextCreate({ match: /adimages$/, status: 500, apply: false });
    const file = putContent(T, key(25, "jpg"), jpeg(1080, 1350, 25));
    const { media } = await prepare(T, ACCOUNT, { source: "content", key: file });
    expect(media.status).toBe("error");
    rmSync(path.join(DATA, "content", T, file));
    now = (rowOf(media.id).nextCheckAt as Date).getTime();
    expect(await runMediaTask()).toEqual({ uploaded: 0, polled: 0, failed: 1 });
    expect(rowOf(media.id)).toMatchObject({ status: "error", attempts: 2, error: MEDIA_MESSAGES.notInLibrary, nextCheckAt: null });
    expect(callsTo(/adimages$/)).toHaveLength(1);
  });

  it("a send that never finished (a crashed process) is taken over by the task once its lease ends", async () => {
    const file = putContent(T, key(26, "jpg"), jpeg(1080, 1350, 26));
    const { media } = await prepare(T, ACCOUNT, { source: "content", key: file });
    // As if the process died mid-send: the row still says uploading, with its lease.
    Object.assign(rowOf(media.id), { status: "uploading", metaImageHash: null, nextCheckAt: new Date(now + UPLOAD_LEASE_MS) });
    expect((await prepare(T, ACCOUNT, { source: "content", key: file })).media.status).toBe("uploading");
    expect(await runMediaTask()).toEqual({ uploaded: 0, polled: 0, failed: 0 });
    advance(UPLOAD_LEASE_MS);
    expect(await runMediaTask()).toEqual({ uploaded: 1, polled: 0, failed: 0 });
    expect(rowOf(media.id)).toMatchObject({ status: "ready", attempts: 2 });
    expect(callsTo(/adimages$/)).toHaveLength(2);
  });

  it("Meta busy (17) puts the send back to pending until the cooldown ends, without using an attempt", async () => {
    fake.throttleNext({ code: 17, match: /adimages$/ });
    const file = putContent(T, key(22, "jpg"), jpeg(1080, 1350, 22));
    const { media } = await prepare(T, ACCOUNT, { source: "content", key: file });
    expect(media).toMatchObject({ status: "pending", attempts: 0 });
    expect(media.message).toMatch(/^Meta is busy right now\. Try again in \d+ minutes?\.$/);
    now = (rowOf(media.id).nextCheckAt as Date).getTime() + 1;
    expect(await runMediaTask()).toEqual({ uploaded: 1, polled: 0, failed: 0 });
    expect(rowOf(media.id)).toMatchObject({ status: "ready", attempts: 1 });
  });

  it("a video still processing after 30 minutes becomes an error with a retry, which sends it again", async () => {
    env.PROMOTE_VIDEO = "file_url";
    fake.setVideoPolls(1_000);
    const file = putContent(T, key(23, "mp4"), mp4(1080, 1350, 20_000, 23));
    const { media } = await prepare(T, ACCOUNT, { source: "content", key: file });
    expect(media.status).toBe("pending");
    expect(await runMediaTask()).toEqual({ uploaded: 1, polled: 0, failed: 0 });
    expect(rowOf(media.id).status).toBe("processing");
    advance(PROCESSING_TIMEOUT_MS - POLL_EVERY_MS);
    expect(await runMediaTask()).toEqual({ uploaded: 0, polled: 1, failed: 0 });
    expect(rowOf(media.id).status).toBe("processing");
    advance(POLL_EVERY_MS);
    expect(await runMediaTask()).toEqual({ uploaded: 0, polled: 1, failed: 1 });
    const timedOut = rowOf(media.id);
    expect(timedOut).toMatchObject({ status: "error", attempts: 1, error: MEDIA_MESSAGES.processingTimeout });
    expect(timedOut.nextCheckAt).toEqual(new Date(now + RETRY_BACKOFF_MS[0]));

    now = (timedOut.nextCheckAt as Date).getTime();
    expect(await runMediaTask()).toEqual({ uploaded: 1, polled: 0, failed: 0 });
    expect(rowOf(media.id)).toMatchObject({ status: "processing", attempts: 2 });
    expect(callsTo(/advideos$/)).toHaveLength(2);
  });

  it("Meta's own processing error is final until the person tries again", async () => {
    env.PROMOTE_VIDEO = "file_url";
    const file = putContent(T, key(24, "mp4"), mp4(1080, 1920, 9_000, 24));
    const { media } = await prepare(T, ACCOUNT, { source: "content", key: file });
    expect(await runMediaTask()).toEqual({ uploaded: 1, polled: 0, failed: 0 });
    vi.spyOn(meta, "getAdVideoStatus").mockResolvedValueOnce({ id: String(rowOf(media.id).metaVideoId), state: "error", progress: null, lengthSec: null, thumbnailUrl: null });
    advance(POLL_EVERY_MS);
    expect(await runMediaTask()).toEqual({ uploaded: 0, polled: 1, failed: 1 });
    expect(rowOf(media.id)).toMatchObject({ status: "error", error: MEDIA_MESSAGES.processingFailed, nextCheckAt: null });
    advance(3_600_000);
    expect(await runMediaTask()).toEqual({ uploaded: 0, polled: 0, failed: 0 });
  });
});

// =====================================================================================================================
// Dry run
// =====================================================================================================================

describe("SPEND_DRY_RUN", () => {
  it("makes no network call and answers with fake hashes and ids, for images and videos, task included", async () => {
    env.SPEND_DRY_RUN = "1";
    env.PROMOTE_VIDEO = "file_url";
    const image = putContent(T, key(30, "jpg"), jpeg(1080, 1350, 30));
    const video = putContent(T, key(31, "mp4"), mp4(1080, 1920, 10_000, 31));
    const a = await prepare(T, ACCOUNT, { source: "content", key: image });
    const b = await prepare(T, ACCOUNT, { source: "content", key: video });
    expect(a.media).toMatchObject({ status: "ready" });
    expect(a.media.metaImageHash).toMatch(/^dryrun[a-f0-9]{26}$/);
    expect(b.media).toMatchObject({ status: "pending" });
    expect(await runMediaTask()).toEqual({ uploaded: 1, polled: 0, failed: 0 });
    expect(String(rowOf(b.media.id).metaVideoId)).toMatch(/^dryrun_video_/);
    advance(POLL_EVERY_MS);
    expect(await runMediaTask()).toEqual({ uploaded: 0, polled: 1, failed: 0 });
    expect(rowOf(b.media.id).status).toBe("ready");
    expect(String(rowOf(b.media.id).metaThumbHash)).toMatch(/^dryrun[a-f0-9]{26}$/);

    env.PROMOTE_VIDEO = "resumable";
    const c = await prepare(T, ACCOUNT, { source: "content", key: putContent(T, key(32, "mp4"), mp4(1080, 1920, 10_000, 32)) });
    await runMediaTask();
    await settleBackgroundUploads();
    expect(rowOf(c.media.id).status).toBe("processing");
    expect(String(rowOf(c.media.id).metaVideoId)).toMatch(/^dryrun_video_/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fake.calls).toHaveLength(0);
    expect(thumbs).not.toHaveBeenCalled();
  });
});

// =====================================================================================================================
// Quota, adOnly and lastUsedAt (5.5)
// =====================================================================================================================

describe("the content quota, adOnly and lastUsedAt", () => {
  it("a crop is refused with the library's own copy while the library is over its quota", async () => {
    const crop = putCrop(T, jpeg(1080, 1920, 40));
    putContent(T, key(41, "jpg"), Buffer.alloc(64 * 1024, 1));
    process.env.CONTENT_MEDIA_QUOTA_MB = "0.05";
    expect(await refusal(prepare(T, ACCOUNT, { source: "crop", key: crop }))).toEqual({ status: 413, message: mediaQuotaMessage() });
    expect(mediaQuotaMessage()).toMatch(/^Your media library is full \(\d+ MB\)\. Delete files you no longer need and try again\.$/);
    expect(rows()).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a crop is ad-only until the same bytes come from the library; a video crop is refused", async () => {
    const crop = putCrop(T, jpeg(1080, 1920, 42));
    const { media } = await prepare(T, ACCOUNT, { source: "crop", key: crop });
    expect(media).toMatchObject({ status: "ready", source: "crop", sourceKey: crop, adOnly: true });
    const library = putContent(T, key(43, "jpg"), jpeg(1080, 1920, 42));
    const again = await prepare(T, ACCOUNT, { source: "content", key: library });
    expect(again.media).toMatchObject({ id: media.id, source: "content", sourceKey: library, adOnly: false, status: "ready" });
    expect(callsTo(/adimages$/)).toHaveLength(1);
    env.PROMOTE_VIDEO = "file_url";
    expect(await refusal(prepare(T, ACCOUNT, { source: "crop", key: putContent(T, key(44, "mp4"), mp4(1080, 1920)) }))).toEqual({ status: 400, message: MEDIA_MESSAGES.cropImage });
  });

  it("markAdMediaUsed sets lastUsedAt for the workspace's own items and keeps updatedAt", async () => {
    const { media } = await prepare(T, ACCOUNT, { source: "content", key: putContent(T, key(45, "jpg"), jpeg(1080, 1350, 45)) });
    const before = rowOf(media.id).updatedAt;
    advance(60_000);
    expect(await markAdMediaUsed(T, [media.id, media.id, "bad id!", "unknown"])).toBe(1);
    expect(rowOf(media.id)).toMatchObject({ lastUsedAt: new Date(now), updatedAt: before });
    expect(await markAdMediaUsed(OTHER, [media.id])).toBe(0);
  });
});

// =====================================================================================================================
// Only a crop this server made is ad-only (retention deletes ad-only files)
// =====================================================================================================================

const adImage = (hash: string): AdImage => ({ hash, url: null, width: null, height: null });

describe("only a crop this server made is ad-only", () => {
  it("a library file sent as from:'crop' stays the customer's: source content, never ad-only", async () => {
    const file = putContent(T, key(80, "jpg"), jpeg(1080, 1350, 80));
    const { media } = await prepare(T, ACCOUNT, { source: "crop", key: file });
    expect(media).toMatchObject({ status: "ready", source: "content", sourceKey: file, adOnly: false });
    expect(rowOf(media.id)).toMatchObject({ source: "content", adOnly: false });
  });

  it("a library file a scheduled post uses never becomes ad-only, not even when its key is a crop's", async () => {
    const file = putContent(T, key(81, "jpg"), jpeg(1080, 1350, 81));
    h.db.seed("scheduledPost", [{ id: "post_1", tenantId: T, mediaKeys: [file], status: "scheduled" }]);
    expect((await prepare(T, ACCOUNT, { source: "crop", key: file })).media).toMatchObject({ source: "content", adOnly: false });

    const crop = putCrop(T, jpeg(1080, 1350, 82));
    h.db.seed("scheduledPost", [{ id: "post_2", tenantId: T, mediaKeys: [key(1, "jpg"), crop], status: "draft" }]);
    const { media } = await prepare(T, ACCOUNT, { source: "crop", key: crop });
    expect(media).toMatchObject({ source: "content", sourceKey: crop, adOnly: false });
    // Another workspace's post does not count.
    const own = putCrop(T, jpeg(1080, 1350, 79));
    h.db.seed("scheduledPost", [{ id: "post_3", tenantId: OTHER, mediaKeys: [own], status: "draft" }]);
    expect((await prepare(T, ACCOUNT, { source: "crop", key: own })).media).toMatchObject({ source: "crop", adOnly: true });
    expect(rows().filter((r) => r.adOnly === true).map((r) => r.sourceKey)).toEqual([own]);
  });

  it("nor a crop a reply material or other ad media uses; a crop mark of another workspace counts for nothing", async () => {
    const material = putCrop(T, jpeg(1080, 1350, 83));
    h.db.seed("replyMaterial", [{ id: "rm_1", tenantId: T, name: "Menu", kind: "media", mediaKey: material }]);
    expect((await prepare(T, ACCOUNT, { source: "crop", key: material })).media).toMatchObject({ source: "content", adOnly: false });

    // Library media of another ad account names the same file.
    const shared = putCrop(T, jpeg(1080, 1350, 84));
    h.db.seed("adMedia", [{ id: "m_other", tenantId: T, adAccountAssetId: ACCOUNT_2, source: "content", sourceKey: shared, sha256: "f".repeat(64), adOnly: false, status: "ready", attempts: 1 }]);
    expect((await prepare(T, ACCOUNT, { source: "crop", key: shared })).media).toMatchObject({ source: "content", adOnly: false });

    const foreign = putContent(OTHER, newAdCropKey(T, "jpg"), jpeg(1080, 1350, 85));
    expect(isAdCropKey(T, foreign)).toBe(true);
    expect(isAdCropKey(OTHER, foreign)).toBe(false);
    expect((await prepare(OTHER, ACCOUNT, { source: "crop", key: foreign })).media).toMatchObject({ source: "content", adOnly: false });
  });

  it("?purpose=ad_crop uploads carry the mark (JPG or PNG only), and the library leaves out the crops ad-only media holds", async () => {
    const upload = (type: string, body: Buffer, adCrop: boolean) => saveUpload(T, new Request(`${ORIGIN}/api/content/media`, { method: "POST", headers: { "content-type": type }, body: new Uint8Array(body) }), { adCrop });
    const plain = await upload("image/jpeg", jpeg(1080, 1350, 86), false);
    const crop = await upload("image/jpeg", jpeg(1080, 1920, 87), true);
    const spare = await upload("image/jpeg", jpeg(1080, 1080, 88), true);
    expect(isAdCropKey(T, plain.key)).toBe(false);
    expect([isAdCropKey(T, crop.key), isAdCropKey(T, spare.key)]).toEqual([true, true]);
    expect(await refusal(upload("video/mp4", mp4(1080, 1920), true))).toEqual({ status: 400, message: "A crop must be a JPG or PNG image." });
    expect((await listMedia(T)).map((m) => m.key).sort()).toEqual([plain.key, crop.key, spare.key].sort());

    const { media } = await prepare(T, ACCOUNT, { source: "crop", key: crop.key });
    expect(media).toMatchObject({ source: "crop", adOnly: true });
    // Held by ad-only media, the crop is no longer offered to posts and replies. One no row holds stays listed, so it can be deleted.
    expect((await listMedia(T)).map((m) => m.key).sort()).toEqual([plain.key, spare.key].sort());
  });
});

// =====================================================================================================================
// Attempts never pass 5 (AdMedia_attempts_check)
// =====================================================================================================================

describe("attempts never pass 5", () => {
  it("the in-memory table refuses what Postgres refuses: attempts outside 0..5, and a second row for one file and account", async () => {
    const { media } = await prepare(T, ACCOUNT, { source: "content", key: putContent(T, key(90, "jpg"), jpeg(1080, 1350, 90)) });
    const table = h.db.prisma.adMedia as { updateMany: (a: unknown) => Promise<unknown>; create: (a: unknown) => Promise<unknown> };
    await expect(table.updateMany({ where: { id: media.id }, data: { attempts: MAX_ATTEMPTS + 1 } })).rejects.toThrow(/AdMedia_attempts_check/);
    await expect(table.create({ data: { ...rowOf(media.id), id: "dup" } })).rejects.toMatchObject({ code: "P2002" });
    expect(rowOf(media.id).attempts).toBe(1);
  });

  it("two prepares of one new file at once make one row and one send", async () => {
    const file = putContent(T, key(99, "jpg"), jpeg(1080, 1350, 99));
    const [x, y] = await Promise.all([prepare(T, ACCOUNT, { source: "content", key: file }), prepare(T, ACCOUNT, { source: "content", key: file })]);
    expect(rows()).toHaveLength(1);
    expect(x.media.id).toBe(y.media.id);
    expect([x.created, y.created].sort()).toEqual([false, true]);
    expect(callsTo(/adimages$/)).toHaveLength(1);
  });

  it("an error with all 5 attempts used stays so through a blocked request and back, until a day after the last", async () => {
    for (let i = 0; i < MAX_ATTEMPTS; i++) fake.failNextCreate({ match: /adimages$/, status: 500, apply: false });
    const file = putContent(T, key(91, "jpg"), jpeg(1920, 1080, 91));
    const { media } = await prepare(T, ACCOUNT, { source: "content", key: file }, ["facebook_feed"]);
    for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt++) {
      now = (rowOf(media.id).nextCheckAt as Date).getTime();
      await runMediaTask();
    }
    expect(rowOf(media.id)).toMatchObject({ status: "error", attempts: MAX_ATTEMPTS, error: MEDIA_MESSAGES.gaveUp });
    const gaveUpAt = rowOf(media.id).updatedAt as Date;

    // A carousel can't use a 16:9 image: that answer says so; the shared row is not made invalid, and its clock stays.
    advance(60_000);
    const carousel = await prepare(T, ACCOUNT, { source: "content", key: file, format: "carousel" });
    expect(carousel.media.status).toBe("error");
    expect(carousel.media.problems).toContainEqual(expect.objectContaining({ code: "ratio_feed", severity: "block" }));
    expect(rowOf(media.id)).toMatchObject({ status: "error", attempts: MAX_ATTEMPTS, updatedAt: gaveUpAt });

    // Back to the feed: no sixth send and no write past the check, until a day after the last attempt.
    const feed = await prepare(T, ACCOUNT, { source: "content", key: file }, ["facebook_feed"]);
    expect(feed.media).toMatchObject({ status: "error", attempts: MAX_ATTEMPTS, canRetry: false, message: MEDIA_MESSAGES.gaveUp });
    expect(callsTo(/adimages$/)).toHaveLength(MAX_ATTEMPTS);
    now = gaveUpAt.getTime() + FRESH_START_AFTER_MS;
    expect((await prepare(T, ACCOUNT, { source: "content", key: file }, ["facebook_feed"])).media).toMatchObject({ status: "ready", attempts: 1 });
  });

  it("a row made invalid after its last attempt comes back as that error, not pending, and starts over a day later at 1", async () => {
    const file = putContent(T, key(92, "jpg"), jpeg(1080, 1350, 92));
    const { media } = await prepare(T, ACCOUNT, { source: "content", key: file });
    // As if the checks had blocked the file for a while: invalid, with all 5 attempts used.
    Object.assign(rowOf(media.id), { status: "invalid", attempts: MAX_ATTEMPTS, error: "Blocked.", metaImageHash: null, nextCheckAt: null, updatedAt: new Date(now) });
    advance(60_000);
    const lifted = await prepare(T, ACCOUNT, { source: "content", key: file });
    expect(lifted.media).toMatchObject({ status: "error", attempts: MAX_ATTEMPTS, message: MEDIA_MESSAGES.gaveUp, canRetry: false });
    expect(await runMediaTask()).toEqual({ uploaded: 0, polled: 0, failed: 0 });
    expect(callsTo(/adimages$/)).toHaveLength(1);
    advance(FRESH_START_AFTER_MS);
    expect((await prepare(T, ACCOUNT, { source: "content", key: file })).media).toMatchObject({ status: "ready", attempts: 1 });
    expect(callsTo(/adimages$/)).toHaveLength(2);
  });

  it("a pending row with all attempts used is not sent again until a day has passed, and then at 1", async () => {
    const file = putContent(T, key(93, "jpg"), jpeg(1080, 1350, 93));
    const { media } = await prepare(T, ACCOUNT, { source: "content", key: file });
    Object.assign(rowOf(media.id), { status: "pending", attempts: MAX_ATTEMPTS, metaImageHash: null, nextCheckAt: new Date(now), updatedAt: new Date(now) });
    expect(await sendAdMedia({ ...rowOf(media.id) } as never)).toMatchObject({ status: "pending", attempts: MAX_ATTEMPTS });
    expect(await runMediaTask()).toEqual({ uploaded: 0, polled: 0, failed: 0 });
    advance(FRESH_START_AFTER_MS);
    expect(await sendAdMedia({ ...rowOf(media.id) } as never)).toMatchObject({ status: "ready", attempts: 1 });
  });
});

// =====================================================================================================================
// A row whose file is gone takes the file prepared next
// =====================================================================================================================

describe("a row whose file is gone takes the file prepared next", () => {
  it("prepare A, a failed send, A deleted, the same bytes as B: B is sent", async () => {
    fake.failNextCreate({ match: /adimages$/, status: 500, apply: false });
    const bytes = jpeg(1080, 1350, 94);
    const a = putContent(T, key(94, "jpg"), bytes);
    const first = await prepare(T, ACCOUNT, { source: "content", key: a });
    expect(first.media).toMatchObject({ status: "error", sourceKey: a });
    rmSync(path.join(DATA, "content", T, a));
    const b = putContent(T, key(95, "jpg"), bytes);
    const second = await prepare(T, ACCOUNT, { source: "content", key: b });
    expect(second.media).toMatchObject({ id: first.media.id, status: "ready", source: "content", sourceKey: b, attempts: 2, error: null });
  });

  it("also after the retry said the file is gone, and from a Creative Studio asset that is gone; a file still there is kept", async () => {
    fake.failNextCreate({ match: /adimages$/, status: 500, apply: false });
    const bytes = jpeg(1080, 1350, 96);
    const c = putContent(T, key(96, "jpg"), bytes);
    const { media } = await prepare(T, ACCOUNT, { source: "content", key: c });
    rmSync(path.join(DATA, "content", T, c));
    now = (rowOf(media.id).nextCheckAt as Date).getTime();
    await runMediaTask();
    expect(rowOf(media.id)).toMatchObject({ status: "error", error: MEDIA_MESSAGES.notInLibrary });
    const d2 = putContent(T, key(97, "jpg"), bytes);
    expect((await prepare(T, ACCOUNT, { source: "content", key: d2 })).media).toMatchObject({ status: "ready", sourceKey: d2, attempts: 3 });
    // A ready row whose file is still there keeps it.
    const e = putContent(T, key(98, "jpg"), bytes);
    expect((await prepare(T, ACCOUNT, { source: "content", key: e })).media).toMatchObject({ status: "ready", sourceKey: d2 });

    fake.failNextCreate({ match: /adimages$/, status: 500, apply: false });
    const art = jpeg(1080, 1080, 4);
    putCreative(T, "art.jpg", art);
    h.db.seed("creativeAsset", [{ id: "ca_art", tenantId: T, kind: "image", storageKey: "art.jpg", status: "ready", policyCheck: null }]);
    const fromStudio = await prepare(T, ACCOUNT, { source: "creative", assetId: "ca_art" });
    expect(fromStudio.media).toMatchObject({ status: "error", source: "creative" });
    h.db.tables.creativeAsset = [];
    const fromLibrary = await prepare(T, ACCOUNT, { source: "content", key: putContent(T, key(99, "jpg"), art) });
    expect(fromLibrary.media).toMatchObject({ id: fromStudio.media.id, status: "ready", source: "content" });
  });
});

// =====================================================================================================================
// Leases, the request's answer and the task's budget
// =====================================================================================================================

describe("a send holds its row with a lease that outlasts it; the request answers in time; the task keeps to its budget", () => {
  it("the lease is longer than the longest send: a resumable video's start, byte upload and finish", () => {
    expect(META_WRITE_MAX_MS).toBeGreaterThanOrEqual(61_000);
    expect(UPLOAD_LEASE_MS).toBeGreaterThan(RUPLOAD_TIMEOUT_MS + 2 * META_WRITE_MAX_MS);
  });

  it("a send that outlived its lease never overwrites the send that took over (a late failure, then a late success)", async () => {
    const slow = deferred<AdImage>();
    const later = deferred<AdImage>();
    vi.spyOn(meta, "uploadAdImage").mockImplementationOnce(() => slow.promise).mockImplementationOnce(() => later.promise);
    const file = putContent(T, key(100, "jpg"), jpeg(1080, 1350, 100));
    const first = await prepare(T, ACCOUNT, { source: "content", key: file }, [], { deps: { sendWaitMs: 50 } });
    // The request answered while its send goes on.
    expect(first.media).toMatchObject({ status: "uploading", attempts: 1, message: MEDIA_MESSAGES.uploading });
    advance(UPLOAD_LEASE_MS - 1);
    expect(await runMediaTask()).toEqual({ uploaded: 0, polled: 0, failed: 0 });

    // The lease ends with the first upload still running: the task takes over; its send runs too, and is slow as well.
    advance(1);
    const takeover = runMediaTask();
    await settle();
    expect(rowOf(first.media.id)).toMatchObject({ status: "uploading", attempts: 2 });
    // The first send fails late: its write holds to its own lease and changes nothing.
    slow.reject(new GraphError("Service unavailable", 503));
    await settle();
    expect(rowOf(first.media.id)).toMatchObject({ status: "uploading", attempts: 2, error: null });
    later.resolve(adImage("b".repeat(32)));
    expect(await takeover).toEqual({ uploaded: 1, polled: 0, failed: 0 });
    expect(rowOf(first.media.id)).toMatchObject({ status: "ready", attempts: 2, metaImageHash: "b".repeat(32), error: null });

    // Late success of a send that lost its lease: the row keeps the send that took over.
    const slow2 = deferred<AdImage>();
    vi.spyOn(meta, "uploadAdImage").mockImplementationOnce(() => slow2.promise);
    const other = await prepare(T, ACCOUNT, { source: "content", key: putContent(T, key(101, "jpg"), jpeg(1080, 1350, 101)) }, [], { deps: { sendWaitMs: 50 } });
    expect(other.media.status).toBe("uploading");
    advance(UPLOAD_LEASE_MS);
    expect(await runMediaTask()).toEqual({ uploaded: 1, polled: 0, failed: 0 });
    const winner = rowOf(other.media.id).metaImageHash;
    slow2.resolve(adImage("c".repeat(32)));
    await settle();
    expect(rowOf(other.media.id)).toMatchObject({ status: "ready", attempts: 2, metaImageHash: winner });
    expect(winner).not.toBe("c".repeat(32));
  });

  it("takes no new row once MEDIA_TASK_BUDGET_MS have passed; the rest waits for the next run", async () => {
    expect(MEDIA_TASK_BATCH).toBeLessThanOrEqual(10);
    expect(MEDIA_TASK_BUDGET_MS).toBeLessThan(15_000);
    for (let i = 0; i < 3; i++) fake.failNextCreate({ match: /adimages$/, status: 500, apply: false });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await prepare(T, ACCOUNT, { source: "content", key: putContent(T, key(102 + i, "jpg"), jpeg(1080, 1350, 102 + i)) })).media.id);
    expect(ids.map((id) => rowOf(id).status)).toEqual(["error", "error", "error"]);
    advance(RETRY_BACKOFF_MS[0]);
    // A slow Meta: each send takes the whole budget.
    const real = meta.uploadAdImage;
    vi.spyOn(meta, "uploadAdImage").mockImplementation(async (ctx, input) => {
      advance(MEDIA_TASK_BUDGET_MS);
      return real(ctx, input);
    });
    for (let run = 1; run <= 3; run++) {
      expect(await runMediaTask()).toEqual({ uploaded: 1, polled: 0, failed: 0 });
      expect(ids.filter((id) => rowOf(id).status === "ready")).toHaveLength(run);
    }
    expect(await runMediaTask({ batch: 1 })).toEqual({ uploaded: 0, polled: 0, failed: 0 });
  });
});

// =====================================================================================================================
// A block that depends on the placements never changes the shared row
// =====================================================================================================================

describe("a block that depends on the placements never changes the shared row", () => {
  it("only blocks about the file itself make a row invalid", () => {
    expect([...FILE_PROBLEMS].sort()).toEqual(["codec", "image_type", "no_size", "too_large", "too_short", "too_small", "video_type"]);
  });

  it("draft A's carousel block leaves draft B's scheduled retry alone, and the row is the same in any order", async () => {
    fake.failNextCreate({ match: /adimages$/, status: 500, apply: false });
    const file = putContent(T, key(110, "jpg"), jpeg(1920, 1080, 110));
    const b = await prepare(T, ACCOUNT, { source: "content", key: file }, ["facebook_feed"]);
    expect(b.media).toMatchObject({ status: "error", attempts: 1, error: MEDIA_MESSAGES.retrySoon });
    const retryAt = rowOf(b.media.id).nextCheckAt as Date;
    const sends = callsTo(/adimages$/).length;

    const a = await prepare(T, ACCOUNT, { source: "content", key: file, format: "carousel" });
    const block = a.media.problems.find((p) => p.severity === "block");
    expect(block).toMatchObject({ code: "ratio_feed" });
    expect(a.media.message).toBe(block?.text.en);
    expect(rowOf(b.media.id)).toMatchObject({ status: "error", attempts: 1, nextCheckAt: retryAt, error: MEDIA_MESSAGES.retrySoon });
    expect(callsTo(/adimages$/)).toHaveLength(sends);
    // The row keeps the file's own problems (Automatic placements), not draft A's.
    expect((await getAdMedia(T, b.media.id))?.problems.map((p) => p.code)).toEqual(["feed_ratio_other", "not_tall", "image_reel"]);

    // B's retry goes ahead on its schedule.
    now = retryAt.getTime();
    expect(await runMediaTask()).toEqual({ uploaded: 1, polled: 0, failed: 0 });
    expect((await prepare(T, ACCOUNT, { source: "content", key: file }, ["facebook_feed"])).media).toMatchObject({ status: "ready", message: MEDIA_MESSAGES.ready });
    const a2 = await prepare(T, ACCOUNT, { source: "content", key: file, format: "carousel" });
    expect(a2.media).toMatchObject({ status: "ready", message: block?.text.en });
    expect(rowOf(b.media.id).status).toBe("ready");
  });

  it("a new file whose only request is blocked is not sent by that request; the task sends it, for other drafts", async () => {
    const file = putContent(T, key(111, "jpg"), jpeg(1920, 1080, 111));
    const { media } = await prepare(T, ACCOUNT, { source: "content", key: file, format: "carousel" });
    expect(media.status).toBe("pending");
    expect(callsTo(/adimages$/)).toHaveLength(0);
    advance(2 * 60_000);
    expect(await runMediaTask()).toEqual({ uploaded: 1, polled: 0, failed: 0 });
    expect(rowOf(media.id).status).toBe("ready");
  });
});

// =====================================================================================================================
// Routes (4.8)
// =====================================================================================================================

const postReq = (body: unknown, origin: string | null = ORIGIN) =>
  new Request(`${ORIGIN}/api/promote/media`, { method: "POST", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify(body) });
const getReq = (pathAndQuery = "/api/promote/media") => new Request(`${ORIGIN}${pathAndQuery}`);
const one = (id: string) => getOneRoute(getReq(`/api/promote/media/${id}`), { params: Promise.resolve({ id }) });
const asJson = async (res: Response) => (await res.json()) as Record<string, unknown>;

describe("routes: POST and GET /api/promote/media, GET /api/promote/media/[id]", () => {
  beforeEach(() => {
    h.db.seed("spendControl", [{ tenantId: T, spendingAdAccountAssetId: ACCOUNT }]);
  });

  it("answer 404 while PROMOTE_ENABLED=off, before looking up the caller", async () => {
    process.env.PROMOTE_ENABLED = "off";
    const file = putContent(T, key(50, "jpg"), jpeg(1080, 1350, 50));
    for (const res of [await prepareRoute(postReq({ from: "content", key: file }), undefined), await listRoute(getReq(), undefined), await one("anything")]) {
      expect(res.status).toBe(404);
      expect(await asJson(res)).toEqual({ error: PROMOTE_NOT_FOUND });
    }
    expect(h.getActor).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(0);
  });

  it("refuses agents (403) and cross-origin POSTs, and sends nothing", async () => {
    const file = putContent(T, key(51, "jpg"), jpeg(1080, 1350, 51));
    const cross = await prepareRoute(postReq({ from: "content", key: file }, "https://evil.example"), undefined);
    expect(cross.status).toBe(403);
    const none = await prepareRoute(postReq({ from: "content", key: file }, null), undefined);
    expect(none.status).toBe(403);
    expect(h.getActor).not.toHaveBeenCalled();

    h.getActor.mockResolvedValue({ userId: "u2", tenantId: T, role: "agent" });
    const agent = await prepareRoute(postReq({ from: "content", key: file }), undefined);
    expect(agent.status).toBe(403);
    expect(await asJson(agent)).toEqual({ error: PROMOTE_WRITERS_ONLY });
    // Reads are admin-only too.
    expect((await listRoute(getReq(), undefined)).status).toBe(403);
    expect(rows()).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("prepares to the spending ad account (201, then 200), and the 31st prepare in an hour gets 429", async () => {
    const file = putContent(T, key(52, "jpg"), jpeg(1080, 1350, 52));
    const first = await prepareRoute(postReq({ from: "content", key: file, placements: ["instagram_feed", "facebook_feed"] }), undefined);
    expect(first.status).toBe(201);
    const media = (await asJson(first)).media as { id: string; status: string; adAccountAssetId: string };
    expect(media).toMatchObject({ status: "ready", adAccountAssetId: ACCOUNT });
    for (let i = 2; i <= MEDIA_PREPARES_PER_HOUR; i++) expect((await prepareRoute(postReq({ from: "content", key: file }), undefined)).status, `prepare ${i}`).toBe(200);
    const over = await prepareRoute(postReq({ from: "content", key: file }), undefined);
    expect(over.status).toBe(429);
    expect(await asJson(over)).toEqual({ error: MEDIA_MESSAGES.rateLimited });
    expect(callsTo(/adimages$/)).toHaveLength(1);
    expect(rows()).toHaveLength(1);
    expect(h.db.rows("auditLog").filter((a) => a.action === "promote.media.prepare")).toHaveLength(MEDIA_PREPARES_PER_HOUR);
    // Another workspace has its own 30.
    h.db.seed("spendControl", [{ tenantId: OTHER, spendingAdAccountAssetId: ACCOUNT }]);
    h.getActor.mockResolvedValue({ userId: "u9", tenantId: OTHER, role: "admin" });
    expect((await prepareRoute(postReq({ from: "content", key: putContent(OTHER, key(53, "jpg"), jpeg(1080, 1350, 53)) }), undefined)).status).toBe(201);
  });

  it("refuses a bad body and a workspace with no spending ad account in plain words", async () => {
    const file = putContent(T, key(54, "jpg"), jpeg(1080, 1350, 54));
    expect(await asJson(await prepareRoute(postReq({ from: "dropbox", key: file }), undefined))).toEqual({ error: MEDIA_MESSAGES.chooseSource });
    expect(await asJson(await prepareRoute(postReq({ from: "content", key: file, placements: ["moon"] }), undefined))).toEqual({ error: MEDIA_MESSAGES.choosePlacements });
    h.db.tables.spendControl = [];
    const res = await prepareRoute(postReq({ from: "content", key: file }), undefined);
    expect(res.status).toBe(409);
    expect(await asJson(res)).toEqual({ error: MEDIA_MESSAGES.chooseAccount });
  });

  it("answers within the wait while Meta is slow (201 uploading, the audit line written); the send lands after the answer", async () => {
    expect(PREPARE_SEND_WAIT_MS).toBeLessThanOrEqual(45_000);
    setMediaDepsForTests({ ...deps, sendWaitMs: 50 });
    const slow = deferred<AdImage>();
    vi.spyOn(meta, "uploadAdImage").mockImplementationOnce(() => slow.promise);
    const file = putContent(T, key(56, "jpg"), jpeg(1080, 1350, 56));
    const res = await prepareRoute(postReq({ from: "content", key: file }), undefined);
    expect(res.status).toBe(201);
    const media = (await asJson(res)).media as { id: string; status: string; message: string };
    expect(media).toMatchObject({ status: "uploading", message: MEDIA_MESSAGES.uploading });
    expect(h.db.rows("auditLog").filter((a) => a.action === "promote.media.prepare")).toHaveLength(1);
    slow.resolve(adImage("d".repeat(32)));
    await settle();
    expect((await asJson(await one(media.id))).media).toMatchObject({ status: "ready", metaImageHash: "d".repeat(32) });
  });

  it("hands a video to the task: 201 pending, with no Meta call in the request", async () => {
    env.PROMOTE_VIDEO = "file_url";
    const res = await prepareRoute(postReq({ from: "content", key: putContent(T, key(57, "mp4"), mp4(1080, 1920, 9_000, 57)) }), undefined);
    expect(res.status).toBe(201);
    const media = (await asJson(res)).media as { id: string; status: string };
    expect(media.status).toBe("pending");
    expect(fake.calls).toHaveLength(0);
    expect(await runMediaTask()).toEqual({ uploaded: 1, polled: 0, failed: 0 });
    expect(rowOf(media.id).status).toBe("processing");
  });

  it("GET [id] gives the status, fit chips and problems; GET lists the workspace's items; other workspaces see 404", async () => {
    const file = putContent(T, key(55, "jpg"), jpeg(1080, 1350, 55));
    const created = (await asJson(await prepareRoute(postReq({ from: "content", key: file }), undefined))).media as { id: string };
    const res = await one(created.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const media = (await asJson(res)).media as { status: string; chips: { text: { en: string } }[]; problems: { code: string }[]; bytes: number };
    expect(media.status).toBe("ready");
    expect(media.chips.map((c) => c.text.en)).toEqual(["Feed 4:5 ✓", "Stories and Reels 9:16: missing"]);
    expect(media.problems.map((p) => p.code)).toEqual(["not_tall", "image_reel"]);
    expect(media.bytes).toBe(jpeg(1080, 1350, 55).length);

    const list = (await asJson(await listRoute(getReq("/api/promote/media?kind=image"), undefined))).media as { id: string }[];
    expect(list.map((m) => m.id)).toEqual([created.id]);
    expect((await asJson(await listRoute(getReq("/api/promote/media?kind=video"), undefined))).media).toEqual([]);

    h.getActor.mockResolvedValue({ userId: "u9", tenantId: OTHER, role: "owner" });
    expect((await one(created.id)).status).toBe(404);
    expect((await asJson(await listRoute(getReq("/api/promote/media?account=all"), undefined))).media).toEqual([]);
  });
});

// =====================================================================================================================
// The tripwire, Meta's CDN and the content links
// =====================================================================================================================

describe("every request is not_spend; thumbnails only from Meta's CDN; content links keep their 1-hour default", () => {
  it("classify() is not_spend for every request the pipeline made", async () => {
    env.PROMOTE_VIDEO = "file_url";
    fake.setVideoPolls(0);
    await prepare(T, ACCOUNT, { source: "content", key: putContent(T, key(60, "jpg"), jpeg(1080, 1350, 60)) });
    await prepare(T, ACCOUNT, { source: "content", key: putContent(T, key(61, "mp4"), mp4(1080, 1920, 10_000, 61)) });
    await runMediaTask();
    env.PROMOTE_VIDEO = "resumable";
    await prepare(T, ACCOUNT_2, { source: "content", key: putContent(T, key(62, "mp4"), mp4(1080, 1920, 10_000, 62)) });
    await runMediaTask();
    await settleBackgroundUploads();
    advance(POLL_EVERY_MS);
    await runMediaTask();
    expect(rows().every((r) => r.status === "ready")).toBe(true);
    expect(callsTo(/advideos$/)).toHaveLength(1);
    expect(callsTo(/video_ads$/)).toHaveLength(2);
    expect(fake.calls.length).toBeGreaterThanOrEqual(8);
    for (const c of fake.calls) {
      expect(c.class, `${c.method} ${c.path}`).toBe("not_spend");
      expect(classify({ method: c.method, path: c.path, query: c.query, body: c.body }).class).toBe("not_spend");
    }
    fake.assertClean();
  });

  it("downloads a thumbnail only over https from *.fbcdn.net, following only redirects that stay there", async () => {
    expect(metaCdnUrl("https://scontent.xx.fbcdn.net/v/t15/1.jpg")).not.toBeNull();
    for (const bad of ["http://scontent.xx.fbcdn.net/1.jpg", "https://fbcdn.net.evil.example/1.jpg", "https://evil.example/1.jpg", "https://u:p@scontent.xx.fbcdn.net/1.jpg", "https://scontent.xx.fbcdn.net:444/1.jpg"]) {
      expect(metaCdnUrl(bad), bad).toBeNull();
    }
    const cdn = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/moved")) return new Response(null, { status: 302, headers: { location: "https://evil.example/x.jpg" } });
      if (url.includes("/text")) return new Response("hello", { status: 200 });
      return new Response(new Uint8Array(THUMB), { status: 200 });
    });
    vi.stubGlobal("fetch", cdn);
    expect(Buffer.from(await downloadMetaThumbnail("https://scontent.xx.fbcdn.net/v/ok.jpg")).equals(THUMB)).toBe(true);
    await expect(downloadMetaThumbnail("https://scontent.xx.fbcdn.net/moved")).rejects.toThrow(/not on Meta's media servers/);
    await expect(downloadMetaThumbnail("https://scontent.xx.fbcdn.net/text")).rejects.toThrow(/not an image/);
    const calls = cdn.mock.calls.length;
    await expect(downloadMetaThumbnail("https://scontent.example.com/v/1.jpg")).rejects.toThrow(/not on Meta's media servers/);
    expect(cdn.mock.calls.length).toBe(calls);
    expect(cdn.mock.calls.every(([u]) => new URL(String(u)).hostname.endsWith(".fbcdn.net"))).toBe(true);
  });

  it("mediaPublicUrl keeps 1 hour by default, takes a longer ttlSeconds up to 2 hours, and verifySignature bounds it", () => {
    const file = key(70, "jpg");
    const exp = (u: string) => Number(new URL(u).searchParams.get("exp"));
    const sec = Math.floor(T0 / 1000);
    expect(SIGNED_URL_TTL_SECONDS).toBe(3_600);
    expect(exp(mediaPublicUrl(T, file, T0)) - sec).toBe(3_600);
    expect(exp(mediaPublicUrl(T, file, T0, 7_200)) - sec).toBe(7_200);
    expect(exp(mediaPublicUrl(T, file, T0, 99_999)) - sec).toBe(MAX_SIGNED_URL_TTL_SECONDS);
    expect(exp(mediaPublicUrl(T, file, T0, Number.NaN)) - sec).toBe(3_600);
    expect(exp(mediaPublicUrl(T, file, T0, -5)) - sec).toBe(3_600);
    const long = new URL(mediaPublicUrl(T, file, T0, 7_200));
    const p = (u: URL) => [u.searchParams.get("exp"), u.searchParams.get("sig")] as const;
    expect(verifySignature(T, file, ...p(long), T0 + 7_000_000)).toBe(true);
    expect(verifySignature(T, file, ...p(long), T0 + 7_201_000)).toBe(false);
    expect(verifySignature(OTHER, file, ...p(long), T0)).toBe(false);
    const short = new URL(mediaPublicUrl(T, file, T0));
    expect(verifySignature(T, file, ...p(short), T0 + 3_601_000)).toBe(false);
  });

  it("the task with nothing due makes no Meta call", async () => {
    expect(await runMediaTask()).toEqual({ uploaded: 0, polled: 0, failed: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
