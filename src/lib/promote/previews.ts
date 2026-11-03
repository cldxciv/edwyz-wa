/**
 * Placement previews (docs/IG-PAGE-ADS-SPEC.md D18, 7.4, 4.2 P1 and P2, 4.9, PRM-08).
 *
 * - P1: Meta's preview of an unsaved creative, built here with promote/creative-shapes (or, for a saved draft, with the same
 *   ads/builders body launch sends: its AdMedia resolved to Meta hashes and video ids, its ad set's positions), from the ad
 *   account's own act_X/generatepreviews edge. Instagram positions need both the Page and the Instagram account in the body;
 *   without the account they get the local mock instead of a Meta error.
 * - Every id an unsaved spec sends is this workspace's: the Page and the Instagram account connected here, a boosted post of
 *   that Page, an Instagram post with that account, a lead form registered here for that Page. Anything else is a 400 before
 *   any Meta call, so the user token never renders another workspace's content.
 * - P2: a launched creative's own previews ({creative}/previews).
 * - Both go through promote/meta.ts with the user token (Meta refuses Page tokens there). The preview edge without an ad account
 *   in front of it, whose previews anyone can open, is never used.
 * - Only an iframe src matching PREVIEW_IFRAME_SRC is kept from Meta's answer. Everything else (the rest of the body, scripts,
 *   event handlers, any other host) is dropped and never reaches the browser. This pattern is a named exemption and lives only
 *   in this file (the host is VERIFY V-P5; src/lib/security/csp.ts frames both hosts).
 * - ad_format comes from catalog/preview-formats. Positions without one get the local mock.
 * - An in-process LRU keeps each preview for 1 hour, keyed by (workspace, spec hash, ad_format), so the same tab asked again
 *   makes no Meta call (one web instance, Phase 0 risk 13). At most 6 Meta previews per review (a review is one version of
 *   one draft, or of one unsaved spec) and at most 30 a minute per member.
 * - The local mock ("Our preview (approximate)", approximate: true) is returned when PROMOTE_PREVIEWS=local, when Meta is busy
 *   (613 or 17, or a cooldown), for positions without a preview format, when a cap is reached, and when Meta's answer fails or
 *   carries no allowed iframe. It carries the frame and the text limit the browser's PhoneFrame draws.
 */
import { createHash } from "node:crypto";
import { buildCreative, creativeProblems } from "@/lib/ads/builders";
import { TEMPLATES, type AdTemplate, type CreativeInput } from "@/lib/ads/types";
import { prisma } from "@/lib/db";
import { GraphError } from "@/lib/graph";
import { log } from "@/lib/log";
import { HttpError, type Actor } from "@/lib/tenancy";
import { FORMAT_SPECS, groupOfPlacement } from "./catalog/formats";
import { placementRow } from "./catalog/placements";
import { DEFAULT_PREVIEW_TABS, MAX_META_PREVIEWS_PER_REVIEW, PREVIEW_CACHE_MS, previewFormatFor } from "./catalog/preview-formats";
import { buildCreativeShape, type CreativeShapeInput, type ShapeCard, type ShapeMedia } from "./creative-shapes";
import { promotePreviews } from "./flags";
import { promoteMeta, type PromoteMeta } from "./meta";
import { PromoteThrottledError } from "./throttle";
import { isAdFormat, isGoalKey, isPlacementKey, isSourceKind, PLACEMENT_KEYS, type IceBreaker, type PlacementKey } from "./types";

type Env = Record<string, string | undefined>;

// =====================================================================================================================
// The iframe allowlist (the named exemption)
// =====================================================================================================================

/** The only thing kept from Meta's preview body: an iframe src on Meta's preview page (D18, 7.4; host VERIFY V-P5). */
export const PREVIEW_IFRAME_SRC = /^https:\/\/(www|business)\.facebook\.com\/ads\/api\/preview_iframe\.php\?/;

const PREVIEW_HOSTS: ReadonlySet<string> = new Set(["www.facebook.com", "business.facebook.com"]);
const PREVIEW_PATH = "/ads/api/preview_iframe.php";
const MAX_SRC = 4_096;
const IFRAME_SRC_ATTR = /<iframe\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
// eslint-disable-next-line no-control-regex
const UNSAFE_URL_CHARS = /[\s"'<>\\`\u0000-\u001f\u007f]/;

/** The HTML entities Meta uses inside an attribute value; anything else stays as it is and fails the checks below. */
function decodeAttr(v: string): string {
  return v
    .replace(/&amp;/gi, "&")
    .replace(/&#0*38;/g, "&")
    .replace(/&#x0*26;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

/** A candidate src, re-checked after the URL parser normalised it. Null when anything about it is off. */
function allowedSrc(raw: string): string | null {
  const src = decodeAttr(raw.trim());
  if (!src || src.length > MAX_SRC || UNSAFE_URL_CHARS.test(src) || !PREVIEW_IFRAME_SRC.test(src)) return null;
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !PREVIEW_HOSTS.has(url.hostname) || url.port || url.username || url.password || url.pathname !== PREVIEW_PATH || url.hash) return null;
  const href = url.href;
  return href.length <= MAX_SRC && PREVIEW_IFRAME_SRC.test(href) && !UNSAFE_URL_CHARS.test(href) ? href : null;
}

/**
 * The first allowed iframe src in one of Meta's preview bodies, or null. Nothing else of the body is ever returned: a planted
 * script, an event handler, a second iframe or a foreign host is simply dropped.
 */
export function safePreviewSrc(body: unknown): string | null {
  if (typeof body !== "string" || body.length === 0 || body.length > 64 * 1024) return null;
  for (const m of body.matchAll(IFRAME_SRC_ATTR)) {
    const src = allowedSrc(m[1] ?? m[2] ?? "");
    if (src) return src;
  }
  return null;
}

// =====================================================================================================================
// Formats, labels and the local mock
// =====================================================================================================================

/** Each tab is labelled with where its picture came from (7.4). Pages are English (D23). */
export const PREVIEW_LABELS = { meta: "Meta's preview", local: "Our preview (approximate)" } as const;

/** Meta's ad_format for a position, or null when Meta has none and only the local mock is shown. */
export function previewAdFormat(key: PlacementKey): string | null {
  const f = previewFormatFor(key);
  return f === "local" ? null : f;
}

export type MockFrame = "4:5" | "9:16" | "1:1";
/** What the browser's PhoneFrame needs to draw the local mock: the frame and the visible text before "… more". */
export type PreviewMock = { frame: MockFrame; textLimit: number };

export function mockFor(key: PlacementKey, carousel = false): PreviewMock {
  if (carousel) return { frame: "1:1", textLimit: FORMAT_SPECS.carousel.text.primary };
  const group = groupOfPlacement(key);
  if (group === "stories") return { frame: "9:16", textLimit: FORMAT_SPECS.stories.text.primary };
  if (group === "reels") return { frame: "9:16", textLimit: FORMAT_SPECS.reels.text.primary };
  const instagram = placementRow(key).platform === "instagram";
  return { frame: "4:5", textLimit: instagram ? FORMAT_SPECS.feed.text.instagramPrimary : FORMAT_SPECS.feed.text.facebookPrimary };
}

/** Why a tab shows the local mock. */
export type LocalReason =
  | "previews_off"
  | "no_format"
  | "incomplete"
  | "no_ad_account"
  | "needs_instagram"
  | "review_cap"
  | "member_cap"
  | "busy"
  | "failed"
  | "unsafe";

export type PlacementPreview = {
  placement: PlacementKey;
  /** Meta's ad_format, or null for a position Meta has no preview for. */
  adFormat: string | null;
  source: "meta" | "local";
  /** True for the local mock: what Meta shows may differ. */
  approximate: boolean;
  label: string;
  /** Meta's preview page, only ever a src matching PREVIEW_IFRAME_SRC. */
  src: string | null;
  /** Served from the 1-hour cache, with no Meta call. */
  cached: boolean;
  reason: LocalReason | null;
  mock: PreviewMock;
};

export type PreviewResult = { call: "P1" | "P2" | null; previews: PlacementPreview[] };

// =====================================================================================================================
// The in-process state: the 1-hour cache, the per-review and per-member caps
// =====================================================================================================================

/** At most 30 Meta previews a minute per member (4.8). */
export const MEMBER_PREVIEWS_PER_MINUTE = 30;
const MINUTE = 60_000;
const CACHE_MAX = 1_000;
const REVIEWS_MAX = 2_000;
const MEMBERS_MAX = 5_000;

/** A small LRU map with a time to live: reads refresh the order, the oldest goes first past `max`. */
export class TtlLru<V> {
  private readonly map = new Map<string, { value: V; until: number }>();
  constructor(
    private readonly max: number,
    private readonly ttlMs: number,
  ) {}
  get(key: string, now: number): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.until <= now) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }
  set(key: string, value: V, now: number, ttlMs = this.ttlMs): void {
    this.map.delete(key);
    this.map.set(key, { value, until: now + ttlMs });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
  }
  get size(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
}

export type PreviewState = {
  /** (tenant, spec hash, ad_format) -> the allowed src. */
  cache: TtlLru<string>;
  /** review key -> the cache keys Meta was asked for in that review. */
  reviews: TtlLru<Set<string>>;
  /** member -> Meta previews asked for in the current minute. */
  members: TtlLru<{ count: number }>;
  /** Requests in flight, so two identical tabs at once make one Meta call. */
  inflight: Map<string, Promise<string | null>>;
};

export function createPreviewState(): PreviewState {
  return {
    cache: new TtlLru<string>(CACHE_MAX, PREVIEW_CACHE_MS),
    reviews: new TtlLru<Set<string>>(REVIEWS_MAX, PREVIEW_CACHE_MS),
    members: new TtlLru<{ count: number }>(MEMBERS_MAX, MINUTE),
    inflight: new Map(),
  };
}

// =====================================================================================================================
// What is previewed
// =====================================================================================================================

/** P1: an unsaved creative body. P2: a launched creative. incomplete: the ad can't be built yet (the mock shows instead). */
export type PreviewTarget = { kind: "spec"; creative: Record<string, unknown> } | { kind: "creative"; creativeId: string } | { kind: "incomplete" };

export type PreviewRequest = {
  tenantId: string;
  userId: string;
  /** The ad account the preview edge is called on (the campaign's, or the workspace's spending account). */
  adAccountAssetId: string | null;
  /** The draft the previews belong to; null for an unsaved spec. */
  draftId: string | null;
  target: PreviewTarget;
  placements: readonly PlacementKey[];
  carousel?: boolean;
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Keys sorted at every depth, so the same body always hashes the same. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (isObject(value)) return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
  return value;
}

/** The hash a preview is cached by: the creative body (P1) or the creative id (P2). */
export function specHash(target: PreviewTarget): string {
  const text = target.kind === "creative" ? `creative:${target.creativeId}` : target.kind === "spec" ? `spec:${JSON.stringify(canonical(target.creative))}` : "incomplete";
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

/** Instagram, Threads and WhatsApp Status positions run as an Instagram identity. */
const needsInstagram = (key: PlacementKey): boolean => placementRow(key).needsInstagramIdentity;

/** An Instagram preview needs the Page and the Instagram account in the body (4.2 P1). */
export function instagramReady(creative: Record<string, unknown>): boolean {
  const story = isObject(creative.object_story_spec) ? creative.object_story_spec : {};
  const ig = creative.instagram_user_id ?? story.instagram_user_id;
  const page = story.page_id ?? creative.object_id ?? creative.object_story_id;
  return typeof ig === "string" && ig.length > 0 && typeof page === "string" && page.length > 0;
}

// =====================================================================================================================
// The service
// =====================================================================================================================

export type PreviewDeps = {
  meta: Pick<PromoteMeta, "generatePreviews" | "getCreativePreviews">;
  state: PreviewState;
  env: Env;
  now: () => number;
};

const defaultState = createPreviewState();
const defaultDeps = (): PreviewDeps => ({ meta: promoteMeta, state: defaultState, env: process.env, now: Date.now });

/** Meta said slow down: 613 or 17 (after promote/meta's own back-off), or a cooldown or busy hold already in force. */
function isBusy(e: unknown): boolean {
  if (e instanceof PromoteThrottledError) return true;
  return e instanceof GraphError && (e.code === 613 || e.code === 17);
}

export function createPreviews(overrides: Partial<PreviewDeps> = {}) {
  const deps: PreviewDeps = { ...defaultDeps(), ...overrides };
  const { state } = deps;

  const local = (placement: PlacementKey, adFormat: string | null, reason: LocalReason, carousel: boolean): PlacementPreview => ({
    placement,
    adFormat,
    source: "local",
    approximate: true,
    label: PREVIEW_LABELS.local,
    src: null,
    cached: false,
    reason,
    mock: mockFor(placement, carousel),
  });

  const fromMeta = (placement: PlacementKey, adFormat: string, src: string, cached: boolean, carousel: boolean): PlacementPreview => ({
    placement,
    adFormat,
    source: "meta",
    approximate: false,
    label: PREVIEW_LABELS.meta,
    src,
    cached,
    reason: null,
    mock: mockFor(placement, carousel),
  });

  /** One more Meta preview for this member this minute, or false at 30. */
  function memberBudget(memberKey: string, now: number): boolean {
    const entry = state.members.get(memberKey, now);
    if (!entry) {
      state.members.set(memberKey, { count: 1 }, now);
      return true;
    }
    if (entry.count >= MEMBER_PREVIEWS_PER_MINUTE) return false;
    entry.count += 1;
    return true;
  }

  /** Asks Meta once and keeps only the allowed src. Throws Meta's error (the caller turns it into the mock). */
  async function ask(req: PreviewRequest, target: Exclude<PreviewTarget, { kind: "incomplete" }>, adFormat: string): Promise<string | null> {
    const ctx = { tenantId: req.tenantId, adAccountAssetId: req.adAccountAssetId as string };
    const res = target.kind === "creative" ? await deps.meta.getCreativePreviews(ctx, target.creativeId, adFormat) : await deps.meta.generatePreviews(ctx, { creative: target.creative, adFormat });
    for (const body of res.bodies) {
      const src = safePreviewSrc(body);
      if (src) return src;
    }
    return null;
  }

  /**
   * The previews for each asked position, in order. Never throws for Meta's answers: every failure is a tab with the local
   * mock and its reason.
   */
  async function preview(req: PreviewRequest): Promise<PreviewResult> {
    const placements = [...new Set(req.placements)];
    const carousel = req.carousel === true;
    const call = req.target.kind === "creative" ? "P2" : req.target.kind === "spec" ? "P1" : null;
    const off = promotePreviews(deps.env) === "local";
    const hash = specHash(req.target);
    const reviewKey = `${req.tenantId}|${req.draftId ?? "spec"}|${hash}`;
    const memberKey = `${req.tenantId}|${req.userId}`;
    let busy = false;
    const out: PlacementPreview[] = [];

    for (const placement of placements) {
      const adFormat = previewAdFormat(placement);
      if (off) {
        out.push(local(placement, adFormat, "previews_off", carousel));
        continue;
      }
      if (!adFormat) {
        out.push(local(placement, null, "no_format", carousel));
        continue;
      }
      const target = req.target;
      if (target.kind === "incomplete") {
        out.push(local(placement, adFormat, "incomplete", carousel));
        continue;
      }
      if (!req.adAccountAssetId) {
        out.push(local(placement, adFormat, "no_ad_account", carousel));
        continue;
      }
      if (target.kind === "spec" && needsInstagram(placement) && !instagramReady(target.creative)) {
        out.push(local(placement, adFormat, "needs_instagram", carousel));
        continue;
      }
      const now = deps.now();
      const cacheKey = `${req.tenantId}|${hash}|${adFormat}`;
      const cached = state.cache.get(cacheKey, now);
      if (cached) {
        out.push(fromMeta(placement, adFormat, cached, true, carousel));
        continue;
      }
      if (busy) {
        out.push(local(placement, adFormat, "busy", carousel));
        continue;
      }
      const asked = state.reviews.get(reviewKey, now) ?? new Set<string>();
      if (!asked.has(cacheKey) && asked.size >= MAX_META_PREVIEWS_PER_REVIEW) {
        out.push(local(placement, adFormat, "review_cap", carousel));
        continue;
      }
      const running = state.inflight.get(cacheKey);
      let src: string | null;
      try {
        if (running) src = await running;
        else {
          if (!memberBudget(memberKey, now)) {
            out.push(local(placement, adFormat, "member_cap", carousel));
            continue;
          }
          asked.add(cacheKey);
          state.reviews.set(reviewKey, asked, now);
          const job = ask(req, target, adFormat);
          state.inflight.set(cacheKey, job);
          try {
            src = await job;
          } finally {
            state.inflight.delete(cacheKey);
          }
          if (src) state.cache.set(cacheKey, src, deps.now());
        }
      } catch (e) {
        if (isBusy(e)) busy = true;
        // Ids and codes only: never the body, the token or Meta's message.
        log.warn("promote.preview.fallback", { call, adFormat, code: e instanceof GraphError ? (e.code ?? null) : null, busy: isBusy(e) });
        out.push(local(placement, adFormat, isBusy(e) ? "busy" : "failed", carousel));
        continue;
      }
      out.push(src ? fromMeta(placement, adFormat, src, false, carousel) : local(placement, adFormat, "unsafe", carousel));
    }
    return { call: placements.length ? call : null, previews: out };
  }

  return { preview, state };
}

export type Previews = ReturnType<typeof createPreviews>;

// =====================================================================================================================
// Request bodies: placements, an unsaved spec, or a saved draft
// =====================================================================================================================

/** The positions asked for; the default tabs when none are given. At most every placement once. */
export function parsePlacements(raw: unknown): PlacementKey[] {
  if (raw === undefined || raw === null) return [...DEFAULT_PREVIEW_TABS];
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > PLACEMENT_KEYS.length) throw new HttpError(400, "Choose where to preview the ad.");
  const out: PlacementKey[] = [];
  for (const p of raw) {
    if (!isPlacementKey(p)) throw new HttpError(400, "Choose where to preview the ad.");
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

const META_ID = /^\d{1,30}$/;
const POST_ID = /^\d{1,30}(_\d{1,30})?$/;
const MEDIA_REF = /^[A-Za-z0-9_:-]{1,128}$/;
const CTA_TYPE = /^[A-Z][A-Z_]{1,59}$/;

const bad = (message: string): never => {
  throw new HttpError(400, message);
};

function optText(v: unknown, max: number, message: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || v.length > max) return bad(message);
  return v;
}

function optId(v: unknown, pattern: RegExp, message: string): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  return typeof v === "string" && pattern.test(v) ? v : bad(message);
}

function optLink(v: unknown): string | undefined {
  const s = optText(v, 2_000, "Use a link that starts with https://.");
  if (s === undefined || s.trim() === "") return undefined;
  return /^https:\/\/[^\s]+$/.test(s.trim()) ? s.trim() : bad("Use a link that starts with https://.");
}

function parseMedia(v: unknown): ShapeMedia | undefined {
  if (v === undefined || v === null) return undefined;
  if (!isObject(v)) return bad("The ad's pictures or video are not valid.");
  const m = (k: string) => optId(v[k], MEDIA_REF, "The ad's pictures or video are not valid.");
  return { imageHash: m("imageHash"), verticalImageHash: m("verticalImageHash"), videoId: m("videoId"), verticalVideoId: m("verticalVideoId"), thumbHash: m("thumbHash"), verticalThumbHash: m("verticalThumbHash") };
}

function parseCards(v: unknown): ShapeCard[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.length > 10) return bad("A carousel has 2 to 10 cards.");
  return v.map((raw) => {
    if (!isObject(raw)) return bad("A carousel has 2 to 10 cards.");
    const m = (k: string) => optId(raw[k], MEDIA_REF, "A card's picture or video is not valid.");
    return {
      imageHash: m("imageHash"),
      videoId: m("videoId"),
      thumbHash: m("thumbHash"),
      headline: optText(raw.headline, 255, "A card's headline can be up to 255 characters.") ?? "",
      description: optText(raw.description, 255, "A card's description can be up to 255 characters.") ?? null,
      link: optLink(raw.link) ?? null,
    };
  });
}

function parseWelcome(v: unknown): CreativeShapeInput["welcome"] {
  if (v === undefined || v === null) return undefined;
  if (!isObject(v)) return bad("The welcome message is not valid.");
  const message = optText(v.message, 1_000, "The welcome message can be up to 1,000 characters.") ?? "";
  let iceBreakers: IceBreaker[] | undefined;
  if (v.iceBreakers !== undefined) {
    if (!Array.isArray(v.iceBreakers) || v.iceBreakers.length > 3) return bad("Add up to 3 questions people can tap.");
    iceBreakers = v.iceBreakers.map((q) => (isObject(q) && typeof q.title === "string" && typeof q.response === "string" ? { title: q.title.slice(0, 80), response: q.response.slice(0, 300) } : bad("Each question needs a title and an answer.")));
  }
  return { message, iceBreakers };
}

/**
 * An unsaved spec from the review screen, as creative-shapes takes it. Only the listed fields are read; anything else is ignored.
 * The call-to-action proof switch (ctaOnBoost) is never taken from the browser: the catalog decides it.
 *
 * Every id the preview sends is tied to this workspace's own identities (with assertOwnIdentities): a boosted Facebook post
 * must be a post of the chosen Page ("<pageId>_<post>" or a bare post id), and a boosted Instagram post comes with the
 * Instagram account it belongs to, so the user token never renders another Page's or account's content. A post id of the
 * other source is ignored (a value left over from switching sources).
 */
export function parsePreviewSpec(raw: unknown): CreativeShapeInput {
  if (!isObject(raw)) return bad("There is nothing to preview yet.");
  if (!isGoalKey(raw.goal)) return bad("Choose a goal first.");
  if (!isSourceKind(raw.source)) return bad("Choose what to promote first.");
  if (!isAdFormat(raw.format)) return bad("Choose the kind of ad first.");
  const pageId = optId(raw.pageId, META_ID, "Choose a Facebook Page first.") ?? bad("Choose a Facebook Page first.");
  const positions = raw.positions === undefined || raw.positions === null ? [] : parsePlacements(raw.positions);
  const instagramUserId = optId(raw.instagramUserId, META_ID, "Choose a valid Instagram account.") ?? null;
  const promotableId = raw.source === "fb_post" ? (optId(raw.promotableId, POST_ID, "Choose a valid post.") ?? null) : null;
  if (promotableId?.includes("_") && !promotableId.startsWith(`${pageId}_`)) bad("Choose a post from this Facebook Page.");
  const igMediaId = raw.source === "ig_media" ? (optId(raw.igMediaId, META_ID, "Choose a valid Instagram post.") ?? null) : null;
  if (igMediaId && !instagramUserId) bad("Choose the Instagram account the post is from.");
  return {
    name: (optText(raw.name, 200, "The name can be up to 200 characters.") ?? "").trim() || "Preview",
    goal: raw.goal,
    source: raw.source,
    format: raw.format,
    pageId,
    instagramUserId,
    promotableId,
    alsoInstagram: raw.alsoInstagram === true,
    igEligible: raw.igEligible === true,
    igMediaId,
    primaryText: optText(raw.primaryText, 5_000, "The ad text can be up to 5,000 characters.") ?? null,
    headline: optText(raw.headline, 255, "The headline can be up to 255 characters.") ?? null,
    description: optText(raw.description, 255, "The description can be up to 255 characters.") ?? null,
    link: optLink(raw.link) ?? null,
    ctaType: optId(raw.ctaType, CTA_TYPE, "Choose a valid button.") ?? null,
    leadFormId: optId(raw.leadFormId, META_ID, "Choose a valid lead form.") ?? null,
    welcome: parseWelcome(raw.welcome),
    media: parseMedia(raw.media),
    cards: parseCards(raw.cards),
    positions,
    enhancementsOptIn: raw.enhancementsOptIn === true,
    urlTags: optText(raw.urlTags, 500, "The URL parameters can be up to 500 characters.") ?? null,
  };
}

/** The creative body for an unsaved spec, or incomplete when creative-shapes can't build it yet. */
export function targetForSpec(spec: CreativeShapeInput): PreviewTarget {
  try {
    return { kind: "spec", creative: buildCreativeShape(spec).body };
  } catch (e) {
    if (e instanceof RangeError) return { kind: "incomplete" };
    throw e;
  }
}

const isTemplate = (v: unknown): v is AdTemplate => typeof v === "string" && (TEMPLATES as readonly string[]).includes(v);

/** An AdMedia row as the draft preview reads it: ready, on the campaign's ad account, with what Meta knows it by. */
export type DraftMediaRow = { id: string; kind: string; metaImageHash: string | null; metaVideoId: string | null; metaThumbHash: string | null };

/** What ads/builders says the caller resolves at launch: the Meta media, the ad set's positions, "Also show on Instagram". */
export type DraftResolved = { media?: ShapeMedia; cards?: ShapeCard[]; positions?: readonly PlacementKey[] };

const MEDIA_SLOTS = ["feed", "square", "vertical", "video"] as const;
const ROW_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_CARDS = 10;

/** The AdMedia ids a saved draft's creative names (creative.media slots and creative.cards), at most 14. */
export function draftMediaIds(creative: unknown): string[] {
  const c = isObject(creative) ? creative : {};
  const out = new Set<string>();
  const media = isObject(c.media) ? c.media : {};
  for (const slot of MEDIA_SLOTS) {
    const id = media[slot];
    if (typeof id === "string" && ROW_ID.test(id)) out.add(id);
  }
  if (Array.isArray(c.cards)) {
    for (const card of c.cards.slice(0, MAX_CARDS)) if (isObject(card) && typeof card.mediaId === "string" && ROW_ID.test(card.mediaId)) out.add(card.mediaId);
  }
  return [...out];
}

const textOrNull = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/**
 * creative.media and creative.cards (AdMedia ids) as the Meta image hashes and video ids launch sends (input.media and
 * input.cards of ads/builders buildCreative). A slot whose row is missing, not ready or of the other kind stays empty, so the
 * builder reports the ad as incomplete instead of sending an AdMedia id. Nothing is returned for a creative without them.
 */
export function shapeMediaOf(creative: unknown, rows: readonly DraftMediaRow[]): Pick<DraftResolved, "media" | "cards"> {
  const c = isObject(creative) ? creative : {};
  const byId = new Map(rows.map((r) => [r.id, r]));
  const row = (id: unknown) => (typeof id === "string" ? byId.get(id) : undefined);
  const image = (id: unknown): string | null => {
    const r = row(id);
    return r?.kind === "image" ? textOrNull(r.metaImageHash) : null;
  };
  const video = (id: unknown): { videoId: string; thumbHash: string | null } | null => {
    const r = row(id);
    const videoId = r?.kind === "video" ? textOrNull(r.metaVideoId) : null;
    return videoId ? { videoId, thumbHash: textOrNull(r?.metaThumbHash) } : null;
  };
  const out: Pick<DraftResolved, "media" | "cards"> = {};
  if (isObject(c.media)) {
    const m = c.media;
    const main = video(m.video);
    const tall = video(m.vertical);
    out.media = {
      imageHash: image(m.feed) ?? image(m.square) ?? textOrNull(c.imageHash),
      verticalImageHash: image(m.vertical),
      videoId: main?.videoId ?? null,
      thumbHash: main?.thumbHash ?? null,
      verticalVideoId: tall?.videoId ?? null,
      verticalThumbHash: tall?.thumbHash ?? null,
    };
  }
  if (Array.isArray(c.cards)) {
    out.cards = c.cards.slice(0, MAX_CARDS).map((raw) => {
      const k = isObject(raw) ? raw : {};
      const v = video(k.mediaId);
      return {
        imageHash: v ? null : image(k.mediaId),
        videoId: v?.videoId ?? null,
        thumbHash: v?.thumbHash ?? null,
        headline: typeof k.headline === "string" ? k.headline : "",
        description: textOrNull(k.description),
        link: textOrNull(k.link),
      };
    });
  }
  return out;
}

/** The ad set's chosen positions (AdSet.targeting.placements); empty is Automatic. */
export function draftPositions(targeting: unknown): PlacementKey[] {
  const list = isObject(targeting) && Array.isArray(targeting.placements) ? targeting.placements : [];
  return [...new Set(list.filter(isPlacementKey))];
}

/**
 * A saved draft's ad: P2 once its creative is on Meta, else the same body launch would send (ads/builders buildCreative with
 * the resolved media, the ad set's positions and "Also show on Instagram"), or incomplete while something launch needs is
 * still missing.
 */
export function targetForDraftAd(template: unknown, ad: { name: string; creative: unknown }, resolved: DraftResolved = {}): PreviewTarget {
  const creative = isObject(ad.creative) ? ad.creative : {};
  const metaCreativeId = creative.metaCreativeId;
  if (typeof metaCreativeId === "string" && META_ID.test(metaCreativeId)) return { kind: "creative", creativeId: metaCreativeId };
  if (!isTemplate(template)) return { kind: "incomplete" };
  const input = creative as unknown as CreativeInput;
  if (typeof input.pageId !== "string" || creativeProblems(template, input).length > 0) return { kind: "incomplete" };
  try {
    const body = buildCreative({
      name: ad.name,
      template,
      creative: input,
      ...(resolved.media ? { media: resolved.media } : {}),
      ...(resolved.cards ? { cards: resolved.cards } : {}),
      positions: resolved.positions ?? [],
      alsoInstagram: creative.alsoInstagram === true,
      igEligible: creative.igEligible === true,
    });
    return { kind: "spec", creative: body };
  } catch {
    return { kind: "incomplete" };
  }
}

// =====================================================================================================================
// POST /api/promote/previews
// =====================================================================================================================

type Row = Record<string, unknown>;
type Args = Record<string, unknown>;
/** The tables the route reads (Prisma, or a test double). */
export type PreviewDb = {
  adCampaign: { findFirst(a: Args): Promise<Row | null> };
  adSet: { findMany(a: Args): Promise<Row[]> };
  ad: { findMany(a: Args): Promise<Row[]> };
  adMedia: { findMany(a: Args): Promise<Row[]> };
  leadForm: { findFirst(a: Args): Promise<Row | null> };
  metaAsset: { findFirst(a: Args): Promise<Row | null> };
  spendControl: { findUnique(a: Args): Promise<Row | null> };
};

/** The draft's ad to preview: the one asked for, else the first that is not archived. */
async function draftRequest(db: PreviewDb, actor: Actor, draftId: string, adId: unknown): Promise<Pick<PreviewRequest, "adAccountAssetId" | "draftId" | "target" | "carousel">> {
  if (!ROW_ID.test(draftId)) throw new HttpError(404, "Draft not found.");
  const campaign = await db.adCampaign.findFirst({ where: { id: draftId, tenantId: actor.tenantId }, select: { id: true, adAccountAssetId: true, template: true } });
  if (!campaign) throw new HttpError(404, "Draft not found.");
  const sets = await db.adSet.findMany({ where: { tenantId: actor.tenantId, campaignId: draftId }, select: { id: true, targeting: true } });
  const ads = sets.length
    ? await db.ad.findMany({ where: { tenantId: actor.tenantId, adSetId: { in: sets.map((s) => String(s.id)) }, status: { not: "archived" } }, select: { id: true, adSetId: true, name: true, creative: true, format: true }, orderBy: { createdAt: "asc" } })
    : [];
  const ad = adId === undefined || adId === null ? ads[0] : ads.find((a) => a.id === adId);
  if (!ad) throw new HttpError(404, adId === undefined || adId === null ? "This draft has no ad to preview yet." : "Ad not found.");
  const adAccountAssetId = typeof campaign.adAccountAssetId === "string" ? campaign.adAccountAssetId : null;
  // The media launch sends: this workspace's ready AdMedia rows on the campaign's ad account, by the ids the creative names.
  const mediaIds = draftMediaIds(ad.creative);
  const rows =
    mediaIds.length && adAccountAssetId
      ? await db.adMedia.findMany({
          where: { tenantId: actor.tenantId, adAccountAssetId, id: { in: mediaIds }, status: "ready" },
          select: { id: true, kind: true, metaImageHash: true, metaVideoId: true, metaThumbHash: true },
        })
      : [];
  const set = sets.find((s) => s.id === ad.adSetId);
  const resolved: DraftResolved = { ...shapeMediaOf(ad.creative, rows as DraftMediaRow[]), positions: draftPositions(set?.targeting) };
  return {
    adAccountAssetId,
    draftId,
    target: targetForDraftAd(campaign.template, { name: String(ad.name ?? "Preview"), creative: ad.creative }, resolved),
    carousel: ad.format === "carousel",
  };
}

/**
 * The Page, the Instagram account and the lead form, when given, must be this workspace's own: the Page and the account
 * connected here, the form registered here for that Page.
 */
async function assertOwnIdentities(db: PreviewDb, tenantId: string, spec: CreativeShapeInput): Promise<void> {
  const page = await db.metaAsset.findFirst({ where: { tenantId, type: "page", externalId: spec.pageId }, select: { id: true } });
  if (!page) throw new HttpError(400, "Choose a Facebook Page connected to this workspace.");
  if (spec.instagramUserId) {
    const ig = await db.metaAsset.findFirst({ where: { tenantId, type: "instagram", externalId: spec.instagramUserId }, select: { id: true } });
    if (!ig) throw new HttpError(400, "Choose an Instagram account connected to this workspace.");
  }
  if (spec.leadFormId) {
    const form = await db.leadForm.findFirst({ where: { tenantId, metaFormId: spec.leadFormId, pageAssetId: page.id }, select: { id: true } });
    if (!form) throw new HttpError(400, "Choose a lead form of this Facebook Page.");
  }
}

export type PreviewRouteDeps = { db: PreviewDb; previews: Previews };

let defaultPreviews: Previews | null = null;

/**
 * The route's work: {draftId, adId?} or {spec}, plus placements[]. A draft previews on its campaign's ad account; an unsaved
 * spec on the workspace's spending ad account (D3). Caller: an admin, through promote/route-guard.
 */
export async function previewsForActor(actor: Actor, body: Record<string, unknown>, overrides: Partial<PreviewRouteDeps> = {}): Promise<PreviewResult> {
  const db = overrides.db ?? (prisma as unknown as PreviewDb);
  const previews = overrides.previews ?? (defaultPreviews ??= createPreviews());
  const placements = parsePlacements(body.placements);
  let base: Pick<PreviewRequest, "adAccountAssetId" | "draftId" | "target" | "carousel">;
  if (typeof body.draftId === "string" && body.spec === undefined) {
    base = await draftRequest(db, actor, body.draftId, body.adId);
  } else if (body.spec !== undefined && body.draftId === undefined) {
    const spec = parsePreviewSpec(body.spec);
    await assertOwnIdentities(db, actor.tenantId, spec);
    const control = await db.spendControl.findUnique({ where: { tenantId: actor.tenantId }, select: { spendingAdAccountAssetId: true } });
    const account = control?.spendingAdAccountAssetId;
    base = { adAccountAssetId: typeof account === "string" ? account : null, draftId: null, target: targetForSpec(spec), carousel: spec.format === "carousel" };
  } else {
    throw new HttpError(400, "Send either a draft or an ad to preview.");
  }
  return previews.preview({ tenantId: actor.tenantId, userId: actor.userId, placements, ...base });
}
