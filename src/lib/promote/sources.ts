/**
 * Posts that can be boosted (docs/IG-PAGE-ADS-SPEC.md 3.3 step 1, 4.2 B1 to B5, 4.8, 4.9; Eddy's list_boostable_posts).
 *
 * - One list, newest first, 25 at a time with a cursor: the Page's published posts (B1, or promotable posts B2 when B1 is
 *   refused), the Instagram account's posts and reels (B4) and its active stories (B5). The tabs (Reels, Posts, Stories,
 *   Facebook) filter the same streams.
 * - Each item says, in plain words, why Meta won't boost it: licensed music, effects or filters, product tags, a reel from
 *   before 15 Oct 2021, IGTV, `is_eligible_for_promotion` false, or Meta's own words under "Meta says this can't be boosted"
 *   when the reason is one Edwyz doesn't know.
 * - A ₹ badge when it was boosted already (`boost_ads_list`, or an Edwyz ad whose `sourcePostRef` is the post), "Made in Edwyz"
 *   when Edwyz published it (`PostTarget.externalId`), and whether it can also show on the other app: for a Facebook post,
 *   Meta's `is_instagram_eligible` (B3), read for the Facebook posts of the returned page only, at most 4 at a time and cached
 *   for 60 s like the upstream pages; false when the Page has no Instagram identity at all.
 * - Captions and Meta's reason texts are someone else's words: they come back as UntrustedText, scrubbed and capped.
 * - Upstream pages are cached for 60 s per workspace, Page or account and cursor, so paging and a second look cost no call; a
 *   member may list 60 times a minute.
 * - An ads-only (Page-backed) Instagram identity can't post or boost, so its Instagram tabs are hidden.
 *
 * Every Meta call goes through promote/meta.ts (classified, throttled, capped). Nothing here names a Meta host.
 */
import { createHash } from "node:crypto";
import type { UntrustedText } from "@/lib/actions/types";
import { u, uOrNull } from "@/lib/actions/untrusted";
import { createLimiter, type Limiter } from "@/lib/ratelimit";
import { HttpError } from "@/lib/tenancy";
import { promoteText, type PromoteCopyKey } from "./copy";
import type { FacebookPost, InstagramMedia, PageOf, PromoteMeta } from "./meta";
import { PromoteThrottledError } from "./throttle";
import type { PromoteLang } from "./types";

// =====================================================================================================================
// Shapes
// =====================================================================================================================

export const SOURCE_KINDS = ["reel", "post", "story"] as const;
export type SourceItemKind = (typeof SOURCE_KINDS)[number];
export const SOURCE_APPS = ["instagram", "facebook"] as const;
export type SourceApp = (typeof SOURCE_APPS)[number];
/** The picker's tabs (3.3): Reels, Posts and Stories are Instagram's; Facebook is the Page's posts. */
export const SOURCE_TABS = ["reels", "posts", "stories", "facebook"] as const;
export type SourceTab = (typeof SOURCE_TABS)[number];

export const isSourceKind = (v: unknown): v is SourceItemKind => typeof v === "string" && (SOURCE_KINDS as readonly string[]).includes(v);
export const isSourceApp = (v: unknown): v is SourceApp => typeof v === "string" && (SOURCE_APPS as readonly string[]).includes(v);

/** Why Meta won't boost a post. `unknown` keeps Meta's own words. */
export const BOOST_REASON_CODES = ["licensed_music", "effects", "product_tags", "old_reel", "igtv", "not_eligible", "unknown"] as const;
export type BoostReasonCode = (typeof BOOST_REASON_CODES)[number];
export type BoostReason = { code: BoostReasonCode; text: string; raw?: UntrustedText };

export type BoostableItem = {
  /** Meta's id: the Instagram media id or the Facebook post id. */
  id: string;
  app: SourceApp;
  kind: SourceItemKind;
  caption: UntrustedText | null;
  thumbnailUrl: string | null;
  permalink: string | null;
  /** ISO time it was posted. */
  createdAt: string | null;
  mediaType: string | null;
  /** The Facebook boost uses this id in the creative. */
  promotableId: string | null;
  /** ok: Meta says it can be boosted. no: it can't (see reasons). unknown: Meta didn't say; it decides when the ad is made. */
  eligibility: "ok" | "no" | "unknown";
  reasons: BoostReason[];
  /** The ₹ badge. */
  boosted: boolean;
  madeInEdwyz: boolean;
  /**
   * "Also show on Facebook" (or Instagram): true when Meta allows it, false when it can't (no Instagram identity for the Page,
   * or B3 says no), null when Meta didn't say (B3 not read or unreadable; Meta decides when the ad is made, VERIFY V-P2).
   */
  alsoShowOn: { app: SourceApp; eligible: boolean | null; label: string };
};

export type SourceIdentity = {
  page: { assetId: string; name: string | null } | null;
  instagram: { assetId: string; username: string | null; pageBacked: boolean } | null;
};

export type SourcesResult = {
  items: BoostableItem[];
  /** Pass back for the next 25; null at the end. */
  cursor: string | null;
  tabs: SourceTab[];
  identity: SourceIdentity;
  /** The Pages to choose from when there is more than one and none was named. */
  pages: { assetId: string; name: string | null }[];
  needsPageChoice: boolean;
  /** A line for the picker: the ads-only identity, or no Instagram account. */
  note: string | null;
};

export type SourceFilter = {
  source?: SourceApp | null;
  kind?: SourceItemKind | null;
  cursor?: string | null;
  pageAssetId?: string | null;
  igAssetId?: string | null;
  limit?: number;
  lang?: PromoteLang;
};

/** A connected Page or Instagram asset, as stored by discovery (5.4). */
export type SourceAsset = { id: string; type: string; externalId: string; name: string | null; meta: unknown };

// =====================================================================================================================
// Limits and the cache
// =====================================================================================================================

export const SOURCES_PAGE_SIZE = 25;
export const SOURCES_CACHE_TTL_MS = 60_000;
export const SOURCES_CACHE_MAX = 500;
export const SOURCES_PER_MINUTE = 60;
/** Upstream pages read per stream per request at most (a filter can skip a whole page). */
export const MAX_UPSTREAM_PAGES = 3;
/** B3 reads per list at most (the Facebook posts of one returned page), and how many run at once. */
export const MAX_B3_PER_LIST = SOURCES_PAGE_SIZE;
export const B3_CONCURRENCY = 4;
/** Reels posted before this can't be boosted (8.3). */
export const OLD_REEL_BEFORE = Date.parse("2021-10-15T00:00:00Z");
const CAPTION_MAX = 500;
const RAW_REASON_MAX = 300;

type Upstream = { items: unknown[]; after: string | null };

/** The 60 s cache of upstream pages and B3 answers (4.9), in this process (one web instance, Phase 0 risk 13). */
export class SourcesCache {
  private rows = new Map<string, { at: number; value: Promise<unknown> }>();
  constructor(
    private readonly ttlMs = SOURCES_CACHE_TTL_MS,
    private readonly max = SOURCES_CACHE_MAX,
  ) {}

  /** Each key prefix holds one kind of value (`|fb|`, `|ig_media|`, `|ig_stories|` pages, `|b3|` booleans). */
  get<T = Upstream>(key: string, now: number, load: () => Promise<T>): Promise<T> {
    const hit = this.rows.get(key);
    if (hit && now - hit.at < this.ttlMs) return hit.value as Promise<T>;
    const value = load();
    this.rows.delete(key);
    this.rows.set(key, { at: now, value });
    value.catch(() => {
      if (this.rows.get(key)?.value === value) this.rows.delete(key);
    });
    while (this.rows.size > this.max) this.rows.delete(this.rows.keys().next().value as string);
    return value;
  }

  clear(): void {
    this.rows.clear();
  }
}

export const sourcesCache = new SourcesCache();

let limiter: Limiter | null = null;
/** 60 a minute per member (4.8). Throws 429. */
export function assertSourcesRate(actor: { tenantId: string; userId: string }, now?: number): void {
  limiter ??= createLimiter(SOURCES_PER_MINUTE, 60_000, "promote-sources-user");
  if (!limiter.consume(`${actor.tenantId}:${actor.userId}`, now)) throw new HttpError(429, "That's a lot of looking in a minute. Wait a moment and try again.");
}

// =====================================================================================================================
// Eligibility in plain words (3.3, 8.3)
// =====================================================================================================================

/** Meta's reason texts are undocumented (B4): known reasons are recognised by their words. */
const REASON_WORDS: readonly [Exclude<BoostReasonCode, "not_eligible" | "unknown">, RegExp][] = [
  ["licensed_music", /music|audio|song|sound|copyright/i],
  ["effects", /effect|filter/i],
  ["product_tags", /product|shopping/i],
  ["igtv", /igtv/i],
  ["old_reel", /2021|too old|older than/i],
];

export function reasonCodeOf(raw: string): BoostReasonCode {
  for (const [code, words] of REASON_WORDS) if (words.test(raw)) return code;
  return "unknown";
}

/** "Meta says this post can't be boosted: it uses licensed music." For an unknown reason, Meta's words under the 8.3a line. */
export function boostReason(code: BoostReasonCode, lang: PromoteLang = "en", raw?: string): BoostReason {
  if (code === "unknown") {
    const said = u("external_text", raw ?? "", RAW_REASON_MAX);
    return { code, text: promoteText("ig.state.cant_boost", { reason: said.text }, lang), raw: said };
  }
  return { code, text: promoteText("error.boost_ineligible", { reason: promoteText(`boost.reason.${code}` as PromoteCopyKey, {}, lang) }, lang) };
}

const timeOf = (iso: string | null): number => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : 0;
};

/** An ISO time from Meta's "2026-10-30T10:00:00+0000". */
const isoOf = (raw: string | null): string | null => {
  const t = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

const kindOfMedia = (m: InstagramMedia): SourceItemKind => (m.productType === "REELS" ? "reel" : m.productType === "STORY" ? "story" : "post");

/** The reasons an Instagram post can't be boosted, from Meta's answer and the two rules Edwyz knows itself. */
export function instagramEligibility(m: InstagramMedia, lang: PromoteLang = "en"): { eligibility: BoostableItem["eligibility"]; reasons: BoostReason[] } {
  const reasons: BoostReason[] = [];
  const seen = new Set<BoostReasonCode>();
  const add = (r: BoostReason) => {
    if (r.code !== "unknown" && seen.has(r.code)) return;
    seen.add(r.code);
    reasons.push(r);
  };
  if (m.productType === "IGTV" || m.mediaType === "IGTV") add(boostReason("igtv", lang));
  if (m.productType === "REELS" && m.timestamp && timeOf(m.timestamp) > 0 && timeOf(m.timestamp) < OLD_REEL_BEFORE) add(boostReason("old_reel", lang));
  if (m.boost.eligible !== true) {
    for (const raw of m.boost.reasons) add(boostReason(reasonCodeOf(raw), lang, raw));
    if (m.boost.eligible === false && reasons.length === 0) add(boostReason("not_eligible", lang));
  }
  if (reasons.length > 0) return { eligibility: "no", reasons };
  return { eligibility: m.boost.eligible === true ? "ok" : "unknown", reasons };
}

export function facebookEligibility(p: FacebookPost, lang: PromoteLang = "en"): { eligibility: BoostableItem["eligibility"]; reasons: BoostReason[] } {
  if (p.eligible === false) return { eligibility: "no", reasons: [boostReason("not_eligible", lang)] };
  return { eligibility: p.eligible === true ? "ok" : "unknown", reasons: [] };
}

// =====================================================================================================================
// Streams and the merge
// =====================================================================================================================

type Stream = "fb" | "ig_media" | "ig_stories";
type Raw = { stream: Stream; at: number; post?: FacebookPost; media?: InstagramMedia };

/** The streams a query reads, and which of their items it keeps. */
function plan(filter: SourceFilter, instagramUsable: boolean): { streams: Stream[]; keep: (r: Raw) => boolean } {
  const { source = null, kind = null } = filter;
  const ig = instagramUsable && source !== "facebook";
  const fb = source !== "instagram" && (kind === null || kind === "post");
  const streams: Stream[] = [];
  if (fb) streams.push("fb");
  if (ig && kind !== "story") streams.push("ig_media");
  if (ig && (kind === null || kind === "story")) streams.push("ig_stories");
  const keep = (r: Raw) => {
    if (r.stream !== "ig_media" || !r.media) return true;
    const k = kindOfMedia(r.media);
    if (k === "story") return false;
    return kind === null || k === kind;
  };
  return { streams, keep };
}

type StreamState = { after: string | null; offset: number; done: boolean };
const CURSOR_PART = /^[A-Za-z0-9_=-]{1,512}$/;
const MAX_OFFSET = 250;

const fingerprint = (streams: Stream[], identity: SourceIdentity) =>
  createHash("sha256")
    .update([streams.join(","), identity.page?.assetId ?? "", identity.instagram?.assetId ?? ""].join("|"))
    .digest("base64url")
    .slice(0, 12);

export function encodeCursor(q: string, states: StreamState[]): string {
  return Buffer.from(JSON.stringify({ v: 1, q, s: states.map((s) => [s.after, s.offset, s.done ? 1 : 0]) })).toString("base64url");
}

/** The states a cursor carries for this query, or a 400 for a cursor from another query or one that was changed. */
export function decodeCursor(cursor: string, q: string, count: number): StreamState[] {
  const bad = () => new HttpError(400, "That list position is no longer valid. Start from the top.");
  if (cursor.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw bad();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw bad();
  }
  const p = parsed as { v?: unknown; q?: unknown; s?: unknown };
  if (p?.v !== 1 || p.q !== q || !Array.isArray(p.s) || p.s.length !== count) throw bad();
  return (p.s as unknown[]).map((row) => {
    if (!Array.isArray(row) || row.length !== 3) throw bad();
    const [after, offset, done] = row as [unknown, unknown, unknown];
    if (after !== null && (typeof after !== "string" || !CURSOR_PART.test(after))) throw bad();
    if (!Number.isSafeInteger(offset) || (offset as number) < 0 || (offset as number) > MAX_OFFSET) throw bad();
    if (done !== 0 && done !== 1) throw bad();
    return { after: after as string | null, offset: offset as number, done: done === 1 };
  });
}

// =====================================================================================================================
// Dependencies
// =====================================================================================================================

export type SourcesDeps = {
  /** B3 (`getPostInstagramEligibility`) is optional: without it, "Also show on Instagram" stays null (Meta decides). */
  meta: Pick<PromoteMeta, "listPublishedPosts" | "listPromotablePosts" | "listInstagramMedia" | "listInstagramStories"> & Partial<Pick<PromoteMeta, "getPostInstagramEligibility">>;
  /** The workspace's active Pages and Instagram accounts. */
  assets: (tenantId: string) => Promise<SourceAsset[]>;
  /** Of these Meta ids, the ones an Edwyz ad was made from (Ad.sourcePostRef). */
  boostedRefs: (tenantId: string, ids: string[]) => Promise<Set<string>>;
  /** Of these Meta ids, the ones Edwyz published (PostTarget.externalId). */
  madeInEdwyz: (tenantId: string, ids: string[]) => Promise<Set<string>>;
  cache: SourcesCache;
  now: () => number;
};

const defaultDeps = async (): Promise<SourcesDeps> => {
  const [{ prisma }, { promoteMeta }] = await Promise.all([import("@/lib/db"), import("./meta")]);
  return {
    meta: promoteMeta,
    assets: async (tenantId) =>
      (await prisma.metaAsset.findMany({
        where: { tenantId, status: "active", type: { in: ["page", "instagram"] } },
        select: { id: true, type: true, externalId: true, name: true, meta: true },
        orderBy: [{ type: "asc" }, { name: "asc" }],
        take: 200,
      })) as SourceAsset[],
    boostedRefs: async (tenantId, ids) =>
      new Set(
        ids.length === 0
          ? []
          : ((await prisma.ad.findMany({ where: { tenantId, sourcePostRef: { in: ids } }, select: { sourcePostRef: true }, take: 500 })) as { sourcePostRef: string | null }[])
              .map((r) => r.sourcePostRef)
              .filter((r): r is string => typeof r === "string"),
      ),
    madeInEdwyz: async (tenantId, ids) =>
      new Set(
        ids.length === 0
          ? []
          : ((await prisma.postTarget.findMany({ where: { tenantId, externalId: { in: ids } }, select: { externalId: true }, take: 500 })) as { externalId: string | null }[])
              .map((r) => r.externalId)
              .filter((r): r is string => typeof r === "string"),
      ),
    cache: sourcesCache,
    now: Date.now,
  };
};

// =====================================================================================================================
// Identity: which Page and which Instagram account
// =====================================================================================================================

const metaOf = (a: SourceAsset): Record<string, unknown> => (a.meta && typeof a.meta === "object" ? (a.meta as Record<string, unknown>) : {});

/** The Page and Instagram account to list: the ones named, else the only one, else the first Page that can run ads. */
export function chooseIdentity(assets: SourceAsset[], filter: Pick<SourceFilter, "pageAssetId" | "igAssetId">): { identity: SourceIdentity; pages: SourceAsset[]; needsPageChoice: boolean } {
  const pages = assets.filter((a) => a.type === "page");
  const instagram = assets.filter((a) => a.type === "instagram");
  let ig = filter.igAssetId ? (instagram.find((a) => a.id === filter.igAssetId) ?? null) : null;
  if (filter.igAssetId && !ig) throw new HttpError(404, "That Instagram account isn't connected to this workspace.");
  let page = filter.pageAssetId ? (pages.find((a) => a.id === filter.pageAssetId) ?? null) : null;
  if (filter.pageAssetId && !page) throw new HttpError(404, "That Facebook Page isn't connected to this workspace.");
  if (!page && ig) page = pages.find((p) => p.externalId === metaOf(ig!).pageId) ?? null;
  if (!page) page = pages.length === 1 ? pages[0] : (pages.find((p) => metaOf(p).canAdvertise !== false) ?? pages[0] ?? null);
  if (!ig && page) {
    const linked = instagram.filter((a) => metaOf(a).pageId === page!.externalId);
    ig = linked.find((a) => metaOf(a).pageBacked !== true) ?? linked[0] ?? null;
  }
  const igMeta = ig ? metaOf(ig) : {};
  return {
    identity: {
      page: page ? { assetId: page.id, name: page.name } : null,
      instagram: ig ? { assetId: ig.id, username: typeof igMeta.username === "string" ? igMeta.username : ig.name, pageBacked: igMeta.pageBacked === true } : null,
    },
    pages,
    needsPageChoice: pages.length > 1 && !filter.pageAssetId && !filter.igAssetId,
  };
}

// =====================================================================================================================
// The list
// =====================================================================================================================

function toItem(r: Raw, lang: PromoteLang, identity: SourceIdentity): Omit<BoostableItem, "boosted" | "madeInEdwyz"> & { boostCount: number | null } {
  if (r.post) {
    const p = r.post;
    const e = facebookEligibility(p, lang);
    return {
      id: p.id,
      app: "facebook",
      kind: "post",
      caption: uOrNull("external_text", p.message, CAPTION_MAX),
      thumbnailUrl: p.picture,
      permalink: p.permalink,
      createdAt: isoOf(p.createdTime),
      mediaType: p.mediaType,
      promotableId: p.promotableId,
      eligibility: e.eligibility,
      reasons: e.reasons,
      // With no Instagram identity for the Page it can't; otherwise B3 decides (filled in by listSources).
      alsoShowOn: { app: "instagram", eligible: identity.instagram ? null : false, label: promoteText("boost.also_instagram", {}, lang) },
      boostCount: null,
    };
  }
  const m = r.media as InstagramMedia;
  const e = instagramEligibility(m, lang);
  return {
    id: m.id,
    app: "instagram",
    kind: kindOfMedia(m) === "story" || r.stream === "ig_stories" ? "story" : kindOfMedia(m),
    caption: uOrNull("external_text", m.caption, CAPTION_MAX),
    thumbnailUrl: m.thumbnailUrl ?? (m.mediaType === "VIDEO" ? null : m.mediaUrl),
    permalink: m.permalink,
    createdAt: isoOf(m.timestamp),
    mediaType: m.mediaType,
    promotableId: null,
    eligibility: e.eligibility,
    reasons: e.reasons,
    // An Instagram professional account is always linked to a Page (C1), so the boost can also run on Facebook (VERIFY V-P2),
    // as long as that Page is connected here.
    alsoShowOn: { app: "facebook", eligible: identity.page !== null, label: promoteText("boost.also_facebook", {}, lang) },
    boostCount: m.boostAdsCount,
  };
}

/**
 * B3 for these Facebook posts: whether each can also run on Instagram. At most MAX_B3_PER_LIST, B3_CONCURRENCY at a time, each
 * answer cached for 60 s. A post whose read fails is left out (null: Meta decides); once Meta says it is busy, no more are read.
 */
async function instagramEligibilityOf(deps: SourcesDeps, tenantId: string, pageAssetId: string, postIds: string[]): Promise<Map<string, boolean | null>> {
  const out = new Map<string, boolean | null>();
  const read = deps.meta.getPostInstagramEligibility;
  if (typeof read !== "function") return out;
  const queue = postIds.slice(0, MAX_B3_PER_LIST);
  let next = 0;
  let busy = false;
  const lane = async () => {
    while (next < queue.length && !busy) {
      const postId = queue[next++];
      try {
        out.set(postId, await deps.cache.get<boolean | null>(`${tenantId}|b3|${pageAssetId}|${postId}`, deps.now(), () => read({ tenantId, pageAssetId }, postId)));
      } catch (e) {
        if (e instanceof PromoteThrottledError) busy = true;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(B3_CONCURRENCY, queue.length) }, lane));
  return out;
}

/**
 * One page of boostable posts, newest first. The cursor carries, for each stream, the upstream page being read and how far
 * into it this list got, so the next call continues exactly there (the upstream page itself comes from the 60 s cache).
 */
export async function listSources(tenantId: string, filter: SourceFilter = {}, overrides: Partial<SourcesDeps> = {}): Promise<SourcesResult> {
  const complete = (["meta", "assets", "boostedRefs", "madeInEdwyz", "cache", "now"] as const).every((k) => overrides[k] !== undefined);
  const deps: SourcesDeps = complete ? (overrides as SourcesDeps) : { ...(await defaultDeps()), ...overrides };
  const lang = filter.lang ?? "en";
  const limit = Math.min(SOURCES_PAGE_SIZE, Math.max(1, Math.floor(filter.limit ?? SOURCES_PAGE_SIZE)));
  if (filter.source !== undefined && filter.source !== null && !isSourceApp(filter.source)) throw new HttpError(400, "Choose Instagram or Facebook.");
  if (filter.kind !== undefined && filter.kind !== null && !isSourceKind(filter.kind)) throw new HttpError(400, "Choose reels, posts or stories.");

  const chosen = chooseIdentity(await deps.assets(tenantId), filter);
  const { identity } = chosen;
  const igUsable = identity.instagram !== null && !identity.instagram.pageBacked;
  const tabs: SourceTab[] = identity.page ? (igUsable ? [...SOURCE_TABS] : ["facebook"]) : igUsable ? ["reels", "posts", "stories"] : [];
  const note = identity.instagram?.pageBacked ? promoteText("ig.state.ads_only", {}, lang) : identity.page && !identity.instagram ? promoteText("ig.state.no_account", {}, lang) : null;
  const pagesOut = chosen.pages.map((p) => ({ assetId: p.id, name: p.name }));
  const base = { tabs, identity, pages: pagesOut, needsPageChoice: chosen.needsPageChoice, note };

  const { streams: wanted, keep } = plan(filter, igUsable);
  const streams = wanted.filter((s) => (s === "fb" ? identity.page !== null : identity.instagram !== null));
  if (streams.length === 0) return { items: [], cursor: null, ...base };

  const q = fingerprint(streams, identity);
  const states = filter.cursor ? decodeCursor(filter.cursor, q, streams.length) : streams.map(() => ({ after: null, offset: 0, done: false }));

  const upstream = (stream: Stream, after: string | null): Promise<Upstream> => {
    const assetId = stream === "fb" ? identity.page!.assetId : identity.instagram!.assetId;
    return deps.cache.get(`${tenantId}|${stream}|${assetId}|${after ?? ""}`, deps.now(), async () => {
      if (stream === "ig_stories") return { items: await deps.meta.listInstagramStories({ tenantId, instagramAssetId: assetId }), after: null };
      if (stream === "ig_media") {
        const r: PageOf<InstagramMedia> = await deps.meta.listInstagramMedia({ tenantId, instagramAssetId: assetId }, { after });
        return { items: r.items, after: r.after };
      }
      const ctx = { tenantId, pageAssetId: assetId };
      try {
        const r = await deps.meta.listPublishedPosts(ctx, { after });
        return { items: r.items, after: r.after };
      } catch (e) {
        // B2 is the fallback (it includes scheduled and unpublished posts); a busy Meta is not a reason to ask again.
        if (e instanceof PromoteThrottledError) throw e;
        const r = await deps.meta.listPromotablePosts(ctx, { after }).catch(() => Promise.reject(e));
        return { items: r.items, after: r.after };
      }
    });
  };

  type Buffer = { stream: Stream; state: StreamState; page: Raw[]; next: string | null; pos: number; fetches: number; loaded: boolean };
  const toRaw = (stream: Stream, v: unknown): Raw =>
    stream === "fb" ? { stream, at: timeOf((v as FacebookPost).createdTime), post: v as FacebookPost } : { stream, at: timeOf((v as InstagramMedia).timestamp), media: v as InstagramMedia };
  const bufs: Buffer[] = streams.map((stream, i) => ({ stream, state: { ...states[i] }, page: [], next: null, pos: 0, fetches: 0, loaded: false }));
  const load = async (b: Buffer) => {
    const res = await upstream(b.stream, b.state.after);
    b.page = res.items.map((v) => toRaw(b.stream, v));
    b.next = res.after;
    b.pos = Math.min(b.state.offset, b.page.length);
    b.fetches++;
    b.loaded = true;
  };
  await Promise.all(bufs.filter((b) => !b.state.done).map(load));

  /** The next item this stream would give, loading its next upstream page when needed; "stall" when the fetch budget ran out. */
  const head = async (b: Buffer): Promise<Raw | null | "stall"> => {
    for (;;) {
      if (b.state.done) return null;
      while (b.pos < b.page.length && !keep(b.page[b.pos])) b.pos++;
      if (b.pos < b.page.length) return b.page[b.pos];
      if (!b.next) {
        b.state.done = true;
        return null;
      }
      if (b.fetches >= MAX_UPSTREAM_PAGES) return "stall";
      b.state = { after: b.next, offset: 0, done: false };
      await load(b);
    }
  };

  const picked: Raw[] = [];
  while (picked.length < limit) {
    const heads = await Promise.all(bufs.map(head));
    if (heads.includes("stall")) break;
    let best = -1;
    for (let i = 0; i < heads.length; i++) {
      const h = heads[i] as Raw | null;
      if (h && (best < 0 || h.at > (heads[best] as Raw).at)) best = i;
    }
    if (best < 0) break;
    picked.push(heads[best] as Raw);
    bufs[best].pos++;
  }

  const finalStates = bufs.map((b): StreamState => {
    if (b.state.done) return { after: null, offset: 0, done: true };
    if (b.pos >= b.page.length && b.loaded) return b.next ? { after: b.next, offset: 0, done: false } : { after: null, offset: 0, done: true };
    return { after: b.state.after, offset: b.pos, done: false };
  });
  const cursor = finalStates.every((s) => s.done) ? null : encodeCursor(q, finalStates);

  const raw = picked.map((r) => toItem(r, lang, identity));
  const refIds = [...new Set(raw.flatMap((i) => [i.id, ...(i.promotableId ? [i.promotableId] : [])]))];
  // B3 only where the answer can matter: a Facebook post Meta may boost, on a Page with an Instagram identity.
  const askB3 = identity.page && identity.instagram ? raw.filter((i) => i.app === "facebook" && i.eligibility !== "no").map((i) => i.id) : [];
  const [boosted, made, alsoInstagram] = await Promise.all([
    deps.boostedRefs(tenantId, refIds).catch(() => new Set<string>()),
    deps.madeInEdwyz(tenantId, raw.map((i) => i.id)).catch(() => new Set<string>()),
    askB3.length ? instagramEligibilityOf(deps, tenantId, identity.page!.assetId, askB3) : Promise.resolve(new Map<string, boolean | null>()),
  ]);
  const items: BoostableItem[] = raw.map(({ boostCount, ...i }) => ({
    ...i,
    alsoShowOn: i.app === "facebook" && alsoInstagram.has(i.id) ? { ...i.alsoShowOn, eligible: alsoInstagram.get(i.id) ?? null } : i.alsoShowOn,
    boosted: (boostCount ?? 0) > 0 || boosted.has(i.id) || (i.promotableId !== null && boosted.has(i.promotableId)),
    madeInEdwyz: made.has(i.id),
  }));
  return { items, cursor, ...base };
}
