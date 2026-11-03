import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * docs/IG-PAGE-ADS-SPEC.md 3.3 step 1, 4.2 B1 to B5, 4.8, 4.9 and PRM-07 acceptance 1 (promote-sources): Facebook posts,
 * Instagram posts and reels and active stories merged newest first, 25 at a time with a cursor; Meta's boost eligibility in
 * plain words (the raw text under "Meta says this can't be boosted" for a reason Edwyz doesn't know); the ₹ badge and "Made in
 * Edwyz"; captions as UntrustedText; the 60 s cache; "Also show on Instagram" from B3 (bounded and cached, false with no
 * Instagram identity); the Instagram tabs hidden for an ads-only identity; and the route's guard (admin only, same site,
 * PROMOTE_ENABLED). Meta is a fake client; there is no network and no database.
 */
const h = vi.hoisted(() => ({
  getActor: vi.fn(),
  assets: vi.fn(),
  ads: vi.fn(),
  targets: vi.fn(),
  meta: {
    listPublishedPosts: vi.fn(),
    listPromotablePosts: vi.fn(),
    listInstagramMedia: vi.fn(),
    listInstagramStories: vi.fn(),
    getPostInstagramEligibility: vi.fn(),
  },
}));
vi.mock("@/lib/auth", () => ({ getActor: (...a: unknown[]) => h.getActor(...a) }));
vi.mock("@/lib/db", () => ({
  prisma: {
    metaAsset: { findMany: (...a: unknown[]) => h.assets(...a) },
    ad: { findMany: (...a: unknown[]) => h.ads(...a) },
    postTarget: { findMany: (...a: unknown[]) => h.targets(...a) },
    user: { findUnique: vi.fn(async () => null) },
  },
}));
vi.mock("@/lib/promote/meta", () => ({ promoteMeta: h.meta }));

import { isUntrustedText } from "@/lib/actions/untrusted";
import type { FacebookPost, InstagramMedia, PageOf } from "@/lib/promote/meta";
import { promoteText } from "@/lib/promote/copy";
import {
  assertSourcesRate,
  B3_CONCURRENCY,
  BOOST_REASON_CODES,
  boostReason,
  chooseIdentity,
  instagramEligibility,
  listSources,
  OLD_REEL_BEFORE,
  reasonCodeOf,
  SOURCES_PAGE_SIZE,
  SourcesCache,
  type SourceAsset,
  type SourcesDeps,
} from "@/lib/promote/sources";
import { PromoteThrottledError } from "@/lib/promote/throttle";
import { HttpError } from "@/lib/tenancy";

const T = "tenant_1";
const NOW = Date.parse("2026-10-31T10:00:00Z");
const HOUR = 3_600_000;
const fbTime = (hoursAgo: number) => new Date(NOW - hoursAgo * HOUR).toISOString().replace(/\.\d{3}Z$/, "+0000");
const igTime = (hoursAgo: number) => new Date(NOW - hoursAgo * HOUR).toISOString().replace(/\.\d{3}Z$/, "+0000");

const post = (id: string, hoursAgo: number, over: Partial<FacebookPost> = {}): FacebookPost => ({
  id,
  message: `Post ${id}`,
  createdTime: fbTime(hoursAgo),
  picture: `https://cdn.example/${id}.jpg`,
  permalink: null,
  statusType: "added_photos",
  mediaType: "photo",
  eligible: true,
  promotableId: `${id}_p`,
  ...over,
});
const media = (id: string, hoursAgo: number, over: Partial<InstagramMedia> = {}): InstagramMedia => ({
  id,
  caption: `Caption ${id}`,
  mediaType: "VIDEO",
  productType: "REELS",
  mediaUrl: `https://cdn.example/${id}.mp4`,
  thumbnailUrl: `https://cdn.example/${id}.jpg`,
  permalink: null,
  timestamp: igTime(hoursAgo),
  boost: { eligible: true, reasons: [] },
  boostAdsCount: 0,
  ...over,
});

/** Upstream paging the way promote/meta.ts answers: 25 per page, an `after` cursor, null at the end. */
function paged<T>(items: T[], size = 25) {
  return (_ctx: unknown, opts: { after?: string | null } = {}): Promise<PageOf<T>> => {
    const start = opts.after ? Number(opts.after.slice(1)) : 0;
    const slice = items.slice(start, start + size);
    const next = start + size < items.length ? `p${start + size}` : null;
    return Promise.resolve({ items: slice, after: next, complete: next === null });
  };
}

const PAGE: SourceAsset = { id: "page_a", type: "page", externalId: "111", name: "Shop", meta: { canAdvertise: true } };
const IG: SourceAsset = { id: "ig_a", type: "instagram", externalId: "222", name: "shop", meta: { pageId: "111", username: "shop", pageBacked: false } };

let clock = NOW;
function deps(over: Partial<SourcesDeps> = {}): SourcesDeps {
  return {
    meta: h.meta,
    assets: async () => [PAGE, IG],
    boostedRefs: async () => new Set<string>(),
    madeInEdwyz: async () => new Set<string>(),
    cache: new SourcesCache(),
    now: () => clock,
    ...over,
  };
}

beforeEach(() => {
  clock = NOW;
  for (const fn of Object.values(h.meta)) fn.mockReset();
  h.meta.listPublishedPosts.mockImplementation(paged<FacebookPost>([]));
  h.meta.listPromotablePosts.mockImplementation(paged<FacebookPost>([]));
  h.meta.listInstagramMedia.mockImplementation(paged<InstagramMedia>([]));
  h.meta.listInstagramStories.mockResolvedValue([]);
  h.meta.getPostInstagramEligibility.mockResolvedValue(null);
});

describe("the merge: newest first, 25 at a time, with a cursor", () => {
  it("merges Facebook posts, Instagram media and stories across upstream pages without losing or repeating one", async () => {
    // Facebook: 30 posts at odd hours; Instagram: 30 reels and posts at even hours; 2 active stories within the last hour.
    const fb = Array.from({ length: 30 }, (_, i) => post(`f${i}`, 2 * i + 1));
    const ig = Array.from({ length: 30 }, (_, i) => media(`m${i}`, 2 * i + 2, i % 3 === 0 ? { productType: "FEED", mediaType: "IMAGE" } : {}));
    const stories = [media("s1", 0.25, { productType: "STORY" }), media("s2", 0.5, { productType: "STORY" })];
    h.meta.listPublishedPosts.mockImplementation(paged(fb));
    h.meta.listInstagramMedia.mockImplementation(paged(ig));
    h.meta.listInstagramStories.mockResolvedValue(stories);
    const d = deps();

    const seen: string[] = [];
    const times: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const r = await listSources(T, { cursor }, d);
      expect(r.items.length).toBeLessThanOrEqual(SOURCES_PAGE_SIZE);
      for (const i of r.items) {
        seen.push(i.id);
        times.push(Date.parse(i.createdAt!));
      }
      cursor = r.cursor;
      pages++;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(62);
    expect(new Set(seen).size).toBe(62);
    expect(seen.slice(0, 4)).toEqual(["s1", "s2", "f0", "m0"]);
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    // The first page of 25 is exactly the 25 newest.
    const first = await listSources(T, {}, d);
    expect(first.items.map((i) => i.id)).toEqual(seen.slice(0, 25));
    expect(first.items.find((i) => i.id === "s1")!.kind).toBe("story");
    expect(first.items.find((i) => i.id === "m0")!.kind).toBe("post");
    expect(first.items.find((i) => i.id === "m1")!.kind).toBe("reel");
    expect(first.tabs).toEqual(["reels", "posts", "stories", "facebook"]);
  });

  it("filters by tab: reels only, stories only, Facebook only", async () => {
    h.meta.listPublishedPosts.mockImplementation(paged([post("f1", 1)]));
    h.meta.listInstagramMedia.mockImplementation(paged([media("r1", 2), media("p1", 3, { productType: "FEED" }), media("r2", 4)]));
    h.meta.listInstagramStories.mockResolvedValue([media("s1", 0.5, { productType: "STORY" })]);
    const d = deps();
    expect((await listSources(T, { source: "instagram", kind: "reel" }, d)).items.map((i) => i.id)).toEqual(["r1", "r2"]);
    expect((await listSources(T, { source: "instagram", kind: "post" }, d)).items.map((i) => i.id)).toEqual(["p1"]);
    expect((await listSources(T, { kind: "story" }, d)).items.map((i) => i.id)).toEqual(["s1"]);
    expect((await listSources(T, { source: "facebook" }, d)).items.map((i) => i.id)).toEqual(["f1"]);
    // Eddy's "latest reel": the first reel.
    expect((await listSources(T, { source: "instagram", kind: "reel", limit: 1 }, d)).items.map((i) => i.id)).toEqual(["r1"]);
  });

  it("refuses a cursor that was changed or belongs to another tab", async () => {
    h.meta.listInstagramMedia.mockImplementation(paged(Array.from({ length: 40 }, (_, i) => media(`m${i}`, i + 1))));
    const d = deps();
    const r = await listSources(T, { source: "instagram", kind: "reel" }, d);
    expect(r.cursor).not.toBeNull();
    await expect(listSources(T, { source: "facebook", cursor: r.cursor }, d)).rejects.toMatchObject({ status: 400 });
    await expect(listSources(T, { source: "instagram", kind: "reel", cursor: `${r.cursor}x` }, d)).rejects.toBeInstanceOf(HttpError);
    await expect(listSources(T, { cursor: "not a cursor!" }, d)).rejects.toMatchObject({ status: 400 });
  });

  it("falls back to promotable posts (B2) when published posts (B1) are refused, but not when Meta is busy", async () => {
    h.meta.listPublishedPosts.mockRejectedValue(new HttpError(403, "no"));
    h.meta.listPromotablePosts.mockImplementation(paged([post("f9", 1)]));
    expect((await listSources(T, { source: "facebook" }, deps())).items.map((i) => i.id)).toEqual(["f9"]);
    h.meta.listPublishedPosts.mockRejectedValue(new PromoteThrottledError({ reason: "cooldown", until: new Date(NOW + 60_000), scope: "page:111", now: NOW }));
    h.meta.listPromotablePosts.mockClear();
    await expect(listSources(T, { source: "facebook" }, deps())).rejects.toBeInstanceOf(PromoteThrottledError);
    expect(h.meta.listPromotablePosts).not.toHaveBeenCalled();
  });
});

describe("eligibility in plain words (3.3, 8.3)", () => {
  const reasonText = (code: string) => promoteText("error.boost_ineligible", { reason: promoteText(`boost.reason.${code}` as never) });

  it("maps each known reason to its copy", () => {
    const cases: [InstagramMedia, string][] = [
      [media("a", 1, { boost: { eligible: false, reasons: ["This reel has licensed music"] } }), "licensed_music"],
      [media("b", 1, { boost: { eligible: false, reasons: ["Uses an AR effect"] } }), "effects"],
      [media("c", 1, { boost: { eligible: false, reasons: ["Contains product tags"] } }), "product_tags"],
      [media("d", 1, { productType: "IGTV", boost: { eligible: null, reasons: [] } }), "igtv"],
      [media("e", 1, { timestamp: "2021-06-01T00:00:00+0000", boost: { eligible: null, reasons: [] } }), "old_reel"],
      [media("f", 1, { boost: { eligible: false, reasons: [] } }), "not_eligible"],
    ];
    for (const [m, code] of cases) {
      const e = instagramEligibility(m);
      expect(e.eligibility, code).toBe("no");
      expect(e.reasons.map((r) => r.code), code).toEqual([code]);
      expect(e.reasons[0].text, code).toBe(reasonText(code));
    }
    expect(reasonText("licensed_music")).toBe("Meta says this post can't be boosted: it uses licensed music.");
    expect(Date.parse("2021-10-14T23:59:59Z")).toBeLessThan(OLD_REEL_BEFORE);
  });

  it("shows Meta's raw text under 'Meta says this can't be boosted' for a reason it doesn't know, as untrusted text", () => {
    const e = instagramEligibility(media("x", 1, { boost: { eligible: false, reasons: ["Account under review ‮weird"] } }));
    expect(e.reasons).toHaveLength(1);
    expect(e.reasons[0].code).toBe("unknown");
    expect(e.reasons[0].text).toMatch(/^Meta says this can't be boosted: Account under review/);
    expect(e.reasons[0].text).not.toContain("‮");
    expect(isUntrustedText(e.reasons[0].raw)).toBe(true);
    expect(reasonCodeOf("Something new")).toBe("unknown");
    expect(boostReason("unknown", "hi", "abc").text).toBe(promoteText("ig.state.cant_boost", { reason: "abc" }, "hi"));
    expect(BOOST_REASON_CODES).toContain("unknown");
  });

  it("ignores reason texts when Meta says it can be boosted, and leaves unknown alone", async () => {
    expect(instagramEligibility(media("ok", 1, { boost: { eligible: true, reasons: ["eligible"] } }))).toEqual({ eligibility: "ok", reasons: [] });
    expect(instagramEligibility(media("q", 1, { boost: { eligible: null, reasons: [] } }))).toEqual({ eligibility: "unknown", reasons: [] });
    h.meta.listPublishedPosts.mockImplementation(paged([post("f1", 1, { eligible: false }), post("f2", 2, { eligible: null })]));
    const items = (await listSources(T, { source: "facebook" }, deps())).items;
    expect(items[0]).toMatchObject({ eligibility: "no", reasons: [{ code: "not_eligible", text: reasonText("not_eligible") }] });
    expect(items[1]).toMatchObject({ eligibility: "unknown", reasons: [] });
  });
});

describe("badges, captions and the other app", () => {
  it("sets the ₹ badge from boost_ads_list or an Edwyz ad's sourcePostRef, and 'Made in Edwyz' from PostTarget", async () => {
    h.meta.listPublishedPosts.mockImplementation(paged([post("f1", 1), post("f2", 2), post("f3", 3)]));
    h.meta.listInstagramMedia.mockImplementation(paged([media("m1", 4, { boostAdsCount: 2 }), media("m2", 5)]));
    const boostedRefs = vi.fn(async (_t: string, ids: string[]) => new Set(ids.filter((i) => i === "f2_p" || i === "m2")));
    const madeInEdwyz = vi.fn(async (_t: string, ids: string[]) => new Set(ids.filter((i) => i === "f3")));
    const items = (await listSources(T, {}, deps({ boostedRefs, madeInEdwyz }))).items;
    const by = Object.fromEntries(items.map((i) => [i.id, i]));
    expect(by.f1).toMatchObject({ boosted: false, madeInEdwyz: false });
    expect(by.f2).toMatchObject({ boosted: true, madeInEdwyz: false });
    expect(by.f3).toMatchObject({ boosted: false, madeInEdwyz: true });
    expect(by.m1).toMatchObject({ boosted: true });
    expect(by.m2).toMatchObject({ boosted: true });
    expect(boostedRefs.mock.calls[0][1]).toEqual(expect.arrayContaining(["f1", "f1_p", "m1"]));
    expect(by.f1.alsoShowOn).toEqual({ app: "instagram", eligible: null, label: promoteText("boost.also_instagram") });
    expect(by.m1.alsoShowOn).toEqual({ app: "facebook", eligible: true, label: promoteText("boost.also_facebook") });
  });

  it("returns captions as UntrustedText: scrubbed and capped", async () => {
    const long = "ab".repeat(400);
    h.meta.listInstagramMedia.mockImplementation(paged([media("m1", 1, { caption: "Diwali offer ‮<script>" }), media("m2", 2, { caption: long }), media("m3", 3, { caption: null })]));
    const items = (await listSources(T, { source: "instagram" }, deps())).items;
    expect(isUntrustedText(items[0].caption)).toBe(true);
    expect(items[0].caption!.$untrusted).toBe("external_text");
    expect(items[0].caption!.text).not.toContain("‮");
    expect(items[0].caption!.text).not.toContain("<script>");
    expect(items[1].caption!.text.length).toBeLessThanOrEqual(500);
    expect(items[2].caption).toBeNull();
  });
});

describe("Also show on Instagram (B3)", () => {
  const label = promoteText("boost.also_instagram");
  const eligibleOf = (items: { id: string; alsoShowOn: { eligible: boolean | null } }[]) => Object.fromEntries(items.map((i) => [i.id, i.alsoShowOn.eligible]));

  it("follows is_instagram_eligible for the Facebook posts of the returned page, and caches each answer for 60 s", async () => {
    h.meta.listPublishedPosts.mockImplementation(paged([post("f1", 1), post("f2", 2), post("f3", 3), post("f4", 4, { eligible: false })]));
    h.meta.getPostInstagramEligibility.mockImplementation(async (_ctx: unknown, id: string) => {
      if (id === "f3") throw new HttpError(502, "Meta said no");
      return id === "f1";
    });
    const d = deps();
    const r = await listSources(T, { source: "facebook" }, d);
    // f3's read failed (Meta decides when the ad is made); f4 can't be boosted at all, so it isn't asked about.
    expect(eligibleOf(r.items)).toEqual({ f1: true, f2: false, f3: null, f4: null });
    expect(r.items[0].alsoShowOn).toEqual({ app: "instagram", eligible: true, label });
    expect(h.meta.getPostInstagramEligibility.mock.calls.map((c) => c[1]).sort()).toEqual(["f1", "f2", "f3"]);
    expect(h.meta.getPostInstagramEligibility).toHaveBeenCalledWith({ tenantId: T, pageAssetId: "page_a" }, "f1");
    // Within 60 s the answers come from the cache (a failed one is asked again); after it, from Meta.
    h.meta.getPostInstagramEligibility.mockClear();
    await listSources(T, { source: "facebook" }, d);
    expect(h.meta.getPostInstagramEligibility.mock.calls.map((c) => c[1])).toEqual(["f3"]);
    clock += 61_000;
    h.meta.getPostInstagramEligibility.mockClear();
    await listSources(T, { source: "facebook" }, d);
    expect(h.meta.getPostInstagramEligibility).toHaveBeenCalledTimes(3);
  });

  it("is false with no Instagram identity for the Page, without asking Meta; an ads-only identity still asks", async () => {
    h.meta.listPublishedPosts.mockImplementation(paged([post("f1", 1), post("f2", 2)]));
    h.meta.getPostInstagramEligibility.mockResolvedValue(true);
    const none = await listSources(T, {}, deps({ assets: async () => [PAGE] }));
    expect(eligibleOf(none.items)).toEqual({ f1: false, f2: false });
    expect(h.meta.getPostInstagramEligibility).not.toHaveBeenCalled();
    // The ads-only identity shows ads on Instagram with the Page's name and picture, so a Facebook post can run there too.
    const backed: SourceAsset = { ...IG, meta: { pageId: "111", username: "Shop", pageBacked: true } };
    const ads = await listSources(T, {}, deps({ assets: async () => [PAGE, backed] }));
    expect(eligibleOf(ads.items)).toEqual({ f1: true, f2: true });
    // Instagram posts can also show on Facebook through the Page.
    h.meta.listInstagramMedia.mockImplementation(paged([media("m1", 1)]));
    expect((await listSources(T, { source: "instagram" }, deps())).items[0].alsoShowOn.eligible).toBe(true);
  });

  it("reads at most 25 per list, 4 at a time, and stops once Meta says it is busy; the list still comes back", async () => {
    h.meta.listPublishedPosts.mockImplementation(paged(Array.from({ length: 30 }, (_, i) => post(`f${i}`, i + 1))));
    let running = 0;
    let most = 0;
    h.meta.getPostInstagramEligibility.mockImplementation(async () => {
      most = Math.max(most, ++running);
      await new Promise((r) => setTimeout(r, 2));
      running--;
      return true;
    });
    const r = await listSources(T, { source: "facebook" }, deps());
    expect(r.items).toHaveLength(SOURCES_PAGE_SIZE);
    expect(h.meta.getPostInstagramEligibility).toHaveBeenCalledTimes(SOURCES_PAGE_SIZE);
    expect(most).toBeLessThanOrEqual(B3_CONCURRENCY);
    expect(most).toBeGreaterThan(1);

    h.meta.getPostInstagramEligibility.mockReset().mockRejectedValue(new PromoteThrottledError({ reason: "cooldown", until: new Date(NOW + 60_000), scope: "page:111", now: NOW }));
    const busy = await listSources(T, { source: "facebook" }, deps());
    expect(busy.items).toHaveLength(SOURCES_PAGE_SIZE);
    expect(busy.items.every((i) => i.alsoShowOn.eligible === null)).toBe(true);
    expect(h.meta.getPostInstagramEligibility.mock.calls.length).toBeLessThanOrEqual(B3_CONCURRENCY);
  });
});

describe("the 60 s cache and the rate limit (4.8, 4.9)", () => {
  it("gives one upstream fetch for two calls within 60 s, and fetches again after", async () => {
    h.meta.listInstagramMedia.mockImplementation(paged([media("m1", 1)]));
    const d = deps();
    await listSources(T, { source: "instagram", kind: "reel" }, d);
    await listSources(T, { source: "instagram", kind: "reel" }, d);
    expect(h.meta.listInstagramMedia).toHaveBeenCalledTimes(1);
    clock += 61_000;
    await listSources(T, { source: "instagram", kind: "reel" }, d);
    expect(h.meta.listInstagramMedia).toHaveBeenCalledTimes(2);
  });

  it("does not keep a failed fetch", async () => {
    h.meta.listInstagramMedia.mockRejectedValueOnce(new HttpError(502, "x")).mockImplementation(paged([media("m1", 1)]));
    const d = deps();
    await expect(listSources(T, { source: "instagram" }, d)).rejects.toBeInstanceOf(HttpError);
    expect((await listSources(T, { source: "instagram" }, d)).items).toHaveLength(1);
  });

  it("allows 60 lists a minute per member", () => {
    const who = { tenantId: "t_rate", userId: "u_rate" };
    for (let i = 0; i < 60; i++) assertSourcesRate(who, NOW);
    expect(() => assertSourcesRate(who, NOW)).toThrow(expect.objectContaining({ status: 429 }));
    expect(() => assertSourcesRate({ tenantId: "t_rate", userId: "other" }, NOW)).not.toThrow();
  });
});

describe("identity: an ads-only Instagram account hides the Instagram tabs", () => {
  it("lists Facebook only, never asks Meta for Instagram media, and says why", async () => {
    const backed: SourceAsset = { ...IG, meta: { pageId: "111", username: "Shop", pageBacked: true } };
    h.meta.listPublishedPosts.mockImplementation(paged([post("f1", 1)]));
    const r = await listSources(T, {}, deps({ assets: async () => [PAGE, backed] }));
    expect(r.tabs).toEqual(["facebook"]);
    expect(r.items.map((i) => i.id)).toEqual(["f1"]);
    expect(r.identity.instagram).toMatchObject({ pageBacked: true });
    expect(r.note).toBe(promoteText("ig.state.ads_only"));
    expect(h.meta.listInstagramMedia).not.toHaveBeenCalled();
    expect(h.meta.listInstagramStories).not.toHaveBeenCalled();
    expect((await listSources(T, { source: "instagram", kind: "reel" }, deps({ assets: async () => [PAGE, backed] }))).items).toEqual([]);
  });

  it("prefers the real Instagram account linked to the Page, takes the Page of a chosen account, and refuses unknown ids", () => {
    const backed: SourceAsset = { id: "ig_b", type: "instagram", externalId: "333", name: "Shop", meta: { pageId: "111", pageBacked: true } };
    const page2: SourceAsset = { id: "page_b", type: "page", externalId: "444", name: "Second", meta: {} };
    const ig2: SourceAsset = { id: "ig_c", type: "instagram", externalId: "555", name: "second", meta: { pageId: "444", username: "second" } };
    const all = [PAGE, page2, backed, IG, ig2];
    expect(chooseIdentity(all, {}).identity).toEqual({ page: { assetId: "page_a", name: "Shop" }, instagram: { assetId: "ig_a", username: "shop", pageBacked: false } });
    expect(chooseIdentity(all, {}).needsPageChoice).toBe(true);
    expect(chooseIdentity(all, { igAssetId: "ig_c" }).identity.page).toEqual({ assetId: "page_b", name: "Second" });
    expect(() => chooseIdentity(all, { pageAssetId: "nope" })).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => chooseIdentity(all, { igAssetId: "nope" })).toThrow(expect.objectContaining({ status: 404 }));
  });

  it("a Page with no Instagram account says so and shows the Facebook tab", async () => {
    const r = await listSources(T, {}, deps({ assets: async () => [PAGE] }));
    expect(r.tabs).toEqual(["facebook"]);
    expect(r.note).toBe(promoteText("ig.state.no_account"));
  });
});

describe("GET /api/promote/sources", () => {
  const ORIGIN = "https://wa.edwyz.com";
  const get = (query = "", headers: Record<string, string> = {}) => new Request(`${ORIGIN}/api/promote/sources${query}`, { headers });

  beforeEach(() => {
    process.env.SITE_URL = ORIGIN;
    process.env.PROMOTE_ENABLED = "on";
    h.getActor.mockReset().mockResolvedValue({ userId: "u_route", tenantId: T, role: "admin" });
    h.assets.mockReset().mockResolvedValue([PAGE, IG]);
    h.ads.mockReset().mockResolvedValue([{ sourcePostRef: "m1" }]);
    h.targets.mockReset().mockResolvedValue([]);
    h.meta.listInstagramMedia.mockImplementation(paged([media("m1", 1), media("m2", 2)]));
  });

  it("answers admins with the list, the tabs and the ₹ badge from Edwyz's own ads", async () => {
    const { GET } = await import("@/app/api/promote/sources/route");
    const res = await GET(get("?source=instagram&kind=reel"), undefined);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { id: string; boosted: boolean; caption: unknown }[]; tabs: string[] };
    expect(body.items.map((i) => i.id)).toEqual(["m1", "m2"]);
    expect(body.items[0].boosted).toBe(true);
    expect(isUntrustedText(body.items[0].caption)).toBe(true);
    expect(body.tabs).toContain("reels");
    expect(h.assets.mock.calls[0][0].where).toMatchObject({ tenantId: T, status: "active" });
  });

  it("is admin only, refuses cross-site requests, checks its inputs and is hidden while PROMOTE_ENABLED is off", async () => {
    const { GET } = await import("@/app/api/promote/sources/route");
    h.getActor.mockResolvedValueOnce({ userId: "u_route", tenantId: T, role: "agent" });
    expect((await GET(get(), undefined)).status).toBe(403);
    expect((await GET(get("", { origin: "https://evil.example" }), undefined)).status).toBe(403);
    expect((await GET(get("", { "sec-fetch-site": "cross-site" }), undefined)).status).toBe(403);
    expect((await GET(get("?source=tiktok"), undefined)).status).toBe(400);
    expect((await GET(get("?kind=live"), undefined)).status).toBe(400);
    process.env.PROMOTE_ENABLED = "off";
    expect((await GET(get(), undefined)).status).toBe(404);
  });
});
