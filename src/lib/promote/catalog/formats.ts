/**
 * Format specs (docs/IG-PAGE-ADS-SPEC.md 4.6, 3.4, 7.3, D21). Meta Ads Guide values; they reconcile
 * src/lib/creative/constants.ts (marked VERIFY there), which this file supersedes for ads.
 *
 * - Ratios match with a 1% tolerance; the probe's rotation is applied first.
 * - checkMedia(probe, placements) returns plain reasons in English, Hindi and Hinglish, plus the fit chips stored in
 *   AdMedia.fits ("Feed 4:5 ✓", "Stories and Reels 9:16: missing").
 * - checkText enforces Instagram's hard limits (2,200 characters, 30 hashtags) and reports the visible-length counters,
 *   counted in graphemes so Devanagari counts as people see it.
 *
 * Pure: no database, no network.
 */
import { formatDuration, promoteText, promoteTextAll, type PromoteCopyKey } from "../copy";
import type { AdFormat, MediaProbe, MediaRatio, PlacementKey, PromoteLang } from "../types";
import { placementRow, type PlacementGroup } from "./placements";

/** Relative tolerance when matching a ratio (4.6). */
export const RATIO_TOLERANCE = 0.01;
export const RATIOS: Readonly<Record<Exclude<MediaRatio, "other">, number>> = { "1:1": 1, "4:5": 4 / 5, "9:16": 9 / 16, "1.91:1": 1.91 };

export type FormatGroup = "feed" | "stories" | "reels" | "carousel";

export type FormatSpec = {
  group: FormatGroup;
  recommendedRatio: MediaRatio;
  recommendedSize: readonly [number, number];
  acceptedSizes: readonly (readonly [number, number])[];
  ratios: readonly MediaRatio[];
  minWidth: number;
  /** Any width/height between these runs (Meta's guide: feeds take 4:5 tall to 1.91:1 wide); `ratios` show best. */
  ratioRange?: { min: number; max: number };
  /** Visible text before "… more". */
  text: Readonly<Record<string, number>>;
  /** Fractions of the frame that interface elements may cover. */
  safeZone: { top: number; bottom: number; sides: number } | null;
  video?: { minMs: number; maxMs: number; maxIsSplit?: boolean };
};

export const FORMAT_SPECS: Readonly<Record<FormatGroup, FormatSpec>> = {
  feed: {
    group: "feed",
    recommendedRatio: "4:5",
    recommendedSize: [1080, 1350],
    acceptedSizes: [[1440, 1800]],
    ratios: ["4:5", "1:1", "1.91:1"],
    minWidth: 500,
    ratioRange: { min: 4 / 5, max: 1.91 },
    text: { instagramPrimary: 125, instagramHeadline: 40, facebookPrimary: 50, facebookHeadline: 27 },
    safeZone: null,
  },
  stories: {
    group: "stories",
    recommendedRatio: "9:16",
    recommendedSize: [1080, 1920],
    acceptedSizes: [[1440, 2560]],
    ratios: ["9:16"],
    minWidth: 500,
    text: { primary: 125 },
    safeZone: { top: 0.14, bottom: 0.2, sides: 0.06 },
    // Longer videos are split into cards of 60 s (a warning, not a block).
    video: { minMs: 1_000, maxMs: 60_000, maxIsSplit: true },
  },
  reels: {
    group: "reels",
    recommendedRatio: "9:16",
    recommendedSize: [1080, 1920],
    acceptedSizes: [],
    ratios: ["9:16"],
    minWidth: 500,
    text: { primary: 44 },
    safeZone: { top: 0.14, bottom: 0.35, sides: 0.06 },
    // VERIFY: Meta allows Reels ads up to 15 minutes.
    video: { minMs: 1_000, maxMs: 15 * 60_000 },
  },
  carousel: {
    group: "carousel",
    recommendedRatio: "1:1",
    recommendedSize: [1080, 1080],
    acceptedSizes: [],
    ratios: ["1:1", "4:5"],
    minWidth: 500,
    text: { primary: 80, headline: 20, description: 18 },
    safeZone: null,
  },
};

/** Carousel cards (4.6). */
export const CAROUSEL_MIN_CARDS = 2;
export const CAROUSEL_MAX_CARDS = 10;

/** Instagram's hard limits (4.6): over these, Meta creates the ad and never shows it on Instagram. */
export const INSTAGRAM_CAPTION_MAX = 2_200;
export const INSTAGRAM_HASHTAGS_MAX = 30;

/** Files (4.6): Meta takes images up to 30 MB, Edwyz up to 8 MB; videos up to 100 MB in Edwyz. */
export const FILE_LIMITS = Object.freeze({
  imageMimes: ["image/jpeg", "image/png"] as readonly string[],
  imageMaxBytes: 8 * 1024 * 1024,
  metaImageMaxBytes: 30 * 1024 * 1024,
  videoMimes: ["video/mp4", "video/quicktime"] as readonly string[],
  videoMaxBytes: 100 * 1024 * 1024,
});

/** H.264 and HEVC four-ccs and names the probe may report (D21: no transcoding, so anything else is refused). */
const OK_CODECS = new Set(["avc1", "avc3", "h264", "hvc1", "hev1", "hevc", "h265"]);
const CODEC_NAMES: Readonly<Record<string, string>> = { vp09: "VP9", vp9: "VP9", vp08: "VP8", av01: "AV1", av1: "AV1", mp4v: "MPEG-4", prores: "ProRes", apcn: "ProRes" };

/** Width over height as people see it (after rotation). */
function displayRatio(width: number, height: number, rotation: number | null = 0): number {
  const quarter = Math.abs(Math.round((rotation ?? 0) / 90)) % 2 === 1;
  return quarter ? height / width : width / height;
}

const near = (r: number, target: number) => Math.abs(r - target) / target <= RATIO_TOLERANCE;

/** The display ratio after rotation, matched with a 1% tolerance. */
export function ratioOf(width: number, height: number, rotation: number | null = 0): MediaRatio {
  if (!(width > 0) || !(height > 0)) return "other";
  const r = displayRatio(width, height, rotation);
  for (const [name, target] of Object.entries(RATIOS) as [Exclude<MediaRatio, "other">, number][]) {
    if (near(r, target)) return name;
  }
  return "other";
}

/** Common camera and screen ratios, so copy says "16:9" rather than a pixel size. */
const COMMON_RATIOS: readonly (readonly [string, number])[] = [
  ["16:9", 16 / 9],
  ["4:3", 4 / 3],
  ["3:2", 3 / 2],
  ["5:4", 5 / 4],
  ["2:1", 2],
  ["21:9", 21 / 9],
  ["3:4", 3 / 4],
  ["2:3", 2 / 3],
];

/**
 * How copy names a shape: one of the four ratios, else a common one (16:9, 4:3, 3:2...), else "1.6:1" (wide) or "1:1.6"
 * (tall). Never pixels. "other" when the size is unknown.
 */
export function ratioLabel(width: number, height: number, rotation: number | null = 0): string {
  const named = ratioOf(width, height, rotation);
  if (named !== "other" || !(width > 0) || !(height > 0)) return named;
  const r = displayRatio(width, height, rotation);
  const common = COMMON_RATIOS.find(([, target]) => near(r, target));
  if (common) return common[0];
  const short = (x: number) => String(Math.round(x * 100) / 100);
  return r >= 1 ? `${short(r)}:1` : `1:${short(1 / r)}`;
}

/** True when a width/height ratio runs in feeds: 4:5 (tall) to 1.91:1 (wide), with the 1% tolerance. */
export function inFeedRange(ratio: number): boolean {
  const { min, max } = FORMAT_SPECS.feed.ratioRange!;
  return ratio >= min * (1 - RATIO_TOLERANCE) && ratio <= max * (1 + RATIO_TOLERANCE);
}

/** The displayed width (after rotation). */
const displayWidth = (p: MediaProbe) => (Math.abs(Math.round((p.rotation ?? 0) / 90)) % 2 === 1 ? p.height : p.width);

/** The format group a placement's media is judged by (search and side rows show feed media). */
export function groupOfPlacement(key: PlacementKey): Exclude<FormatGroup, "carousel"> {
  const g: PlacementGroup = placementRow(key).group;
  return g === "stories" ? "stories" : g === "reels" ? "reels" : "feed";
}

/** The groups a selection shows in; Automatic (empty) shows in all three. */
export function groupsOf(placements: readonly PlacementKey[]): Set<Exclude<FormatGroup, "carousel">> {
  if (placements.length === 0) return new Set(["feed", "stories", "reels"]);
  return new Set(placements.map(groupOfPlacement));
}

export type MediaFit = "feed" | "stories_reels" | "carousel";
export type MediaProblemCode =
  | "image_type"
  | "video_type"
  | "codec"
  | "too_large"
  | "no_size"
  | "too_small"
  | "ratio_feed"
  | "video_ratio_feed"
  | "feed_ratio_other"
  | "video_feed_ratio_other"
  | "feed_tall"
  | "not_tall"
  | "video_not_tall"
  | "too_short"
  | "story_long"
  | "reel_too_long"
  | "image_reel";
export type MediaProblem = {
  code: MediaProblemCode;
  severity: "block" | "warn";
  key: PromoteCopyKey;
  /** The plain reason in every language (4.6). */
  text: Record<PromoteLang, string>;
};
/** `label` names the shape for people ("16:9"); `ratio` is the stored value (AdMedia.ratio: the four ratios or other). */
export type MediaCheck = { ratio: MediaRatio; label: string; fits: MediaFit[]; problems: MediaProblem[] };

const mb = (bytes: number) => `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;

const LANGS: readonly PromoteLang[] = ["en", "hi", "hinglish"];

/** A duration in every language ("3 min 10 s", "3 मिनट 10 सेकंड", "3 min 10 sec"). */
const durationAll = (ms: number): Record<PromoteLang, string> => ({ en: formatDuration(ms, "en"), hi: formatDuration(ms, "hi"), hinglish: formatDuration(ms, "hinglish") });

/** A problem with its reason in every language; `perLang` vars differ by language (a duration). */
function problem(code: MediaProblemCode, severity: "block" | "warn", key: PromoteCopyKey, vars: Record<string, string> = {}, perLang: Record<string, Record<PromoteLang, string>> = {}): MediaProblem {
  const text = {} as Record<PromoteLang, string>;
  for (const lang of LANGS) {
    const v: Record<string, string> = { ...vars };
    for (const [name, values] of Object.entries(perLang)) v[name] = values[lang];
    text[lang] = promoteText(key, v, lang);
  }
  return { code, severity, key, text };
}

/**
 * Checks probed media against where it will show (4.6). Blocks: wrong file type or codec, too large, unreadable size,
 * narrower than 500 px, a feed shape outside 4:5 to 1.91:1 (an image taller than 4:5 is cropped by the member; a video
 * wider than 1.91:1 needs another version, since videos can't be cropped here, D21), a carousel card that is not 1:1 or
 * 4:5, a video under 1 s or a Reel over 15 min. Warnings: a feed shape inside the range but not 4:5, 1:1 or 1.91:1
 * (16:9, 4:3, 3:2 run, but 4:5 or 1:1 show bigger), no 9:16 for Stories and Reels ("add a tall version"), a Story video
 * over 60 s (split into cards), a tall version or tall video in feeds (cropped to 4:5), a still image in Reels.
 * Copy names shapes ("16:9"), never pixels, and never asks to crop a video.
 */
export function checkMedia(probe: MediaProbe, placements: readonly PlacementKey[] = [], opts: { format?: AdFormat } = {}): MediaCheck {
  const problems: MediaProblem[] = [];
  const isVideo = probe.kind === "video";
  const groups = groupsOf(placements);

  if (isVideo) {
    if (!FILE_LIMITS.videoMimes.includes(probe.mime)) problems.push(problem("video_type", "block", "media.video_type"));
    const codec = (probe.videoCodec ?? "").trim().toLowerCase();
    if (codec && !OK_CODECS.has(codec)) problems.push(problem("codec", "block", "media.codec", { codec: CODEC_NAMES[codec] ?? codec.toUpperCase() }));
    if (probe.bytes > FILE_LIMITS.videoMaxBytes) problems.push(problem("too_large", "block", "media.too_large", { size: mb(probe.bytes), max: mb(FILE_LIMITS.videoMaxBytes) }));
  } else {
    if (!FILE_LIMITS.imageMimes.includes(probe.mime)) problems.push(problem("image_type", "block", "media.image_type"));
    if (probe.bytes > FILE_LIMITS.imageMaxBytes) problems.push(problem("too_large", "block", "media.too_large", { size: mb(probe.bytes), max: mb(FILE_LIMITS.imageMaxBytes) }));
  }

  if (!probe.width || !probe.height) {
    problems.push(problem("no_size", "block", "media.no_size"));
    return { ratio: "other", label: "other", fits: [], problems };
  }

  const rotation = probe.rotation ?? 0;
  const ratio = ratioOf(probe.width, probe.height, rotation);
  const label = ratioLabel(probe.width, probe.height, rotation);
  const shape = displayRatio(probe.width, probe.height, rotation);
  const feedRange = inFeedRange(shape);
  const width = displayWidth(probe) ?? 0;
  if (width < FORMAT_SPECS.feed.minWidth) problems.push(problem("too_small", "block", "media.too_small", { width: String(width) }));

  if (opts.format === "carousel") {
    if (!FORMAT_SPECS.carousel.ratios.includes(ratio)) {
      problems.push(isVideo ? problem("video_ratio_feed", "block", "media.video_ratio_carousel", { ratio: label }) : problem("ratio_feed", "block", "media.ratio_carousel", { ratio: label }));
    }
  } else {
    if (groups.has("feed") && !FORMAT_SPECS.feed.ratios.includes(ratio)) {
      if (ratio === "9:16" || (isVideo && shape < FORMAT_SPECS.feed.ratioRange!.min)) {
        // Feeds show tall media cropped to 4:5 (a video can't be cropped here, so it runs as it is).
        problems.push(problem("feed_tall", "warn", "media.feed_tall"));
      } else if (feedRange) {
        problems.push(isVideo ? problem("video_feed_ratio_other", "warn", "media.video_feed_ratio_other", { ratio: label }) : problem("feed_ratio_other", "warn", "media.feed_ratio_other", { ratio: label }));
      } else {
        problems.push(isVideo ? problem("video_ratio_feed", "block", "media.video_ratio_feed", { ratio: label }) : problem("ratio_feed", "block", "media.ratio_feed", { ratio: label }));
      }
    }
    if ((groups.has("stories") || groups.has("reels")) && ratio !== "9:16") {
      problems.push(isVideo ? problem("video_not_tall", "warn", "media.video_not_tall", { ratio: label }) : problem("not_tall", "warn", "media.not_tall", { ratio: label }));
    }
    if (!isVideo && groups.has("reels")) problems.push(problem("image_reel", "warn", "media.image_reel"));
  }

  if (isVideo && typeof probe.durationMs === "number") {
    if (probe.durationMs < FORMAT_SPECS.stories.video!.minMs) problems.push(problem("too_short", "block", "media.too_short"));
    if (groups.has("stories") && probe.durationMs > FORMAT_SPECS.stories.video!.maxMs) {
      problems.push(problem("story_long", "warn", "media.story_long", {}, { duration: durationAll(probe.durationMs) }));
    }
    if (groups.has("reels") && probe.durationMs > FORMAT_SPECS.reels.video!.maxMs) {
      problems.push(problem("reel_too_long", "block", "media.reel_too_long", {}, { duration: durationAll(probe.durationMs) }));
    }
  }

  const fits: MediaFit[] = [];
  if (width >= FORMAT_SPECS.feed.minWidth) {
    if (FORMAT_SPECS.feed.ratios.includes(ratio) || (ratio === "other" && feedRange)) fits.push("feed");
    if (ratio === "9:16") fits.push("stories_reels");
    if (FORMAT_SPECS.carousel.ratios.includes(ratio)) fits.push("carousel");
  }
  return { ratio, label, fits, problems };
}

/** The fit chips of a probe (7.3 MediaPicker): "Feed 4:5 ✓", "Stories and Reels 9:16: missing". */
export function fitChips(check: MediaCheck): { group: MediaFit; ok: boolean; text: Record<PromoteLang, string> }[] {
  const chip = (group: MediaFit, ratio: string, ok: boolean) => {
    const groupKey: PromoteCopyKey = group === "feed" ? "media.group.feed" : group === "stories_reels" ? "media.group.stories_reels" : "media.group.carousel";
    const text = {} as Record<PromoteLang, string>;
    for (const lang of LANGS) text[lang] = promoteText(ok ? "media.fit.ok" : "media.fit.missing", { group: promoteText(groupKey, {}, lang), ratio }, lang);
    return { group, ok, text };
  };
  return [
    chip("feed", check.fits.includes("feed") ? check.label || (check.ratio !== "other" ? check.ratio : "4:5") : "4:5", check.fits.includes("feed")),
    chip("stories_reels", "9:16", check.fits.includes("stories_reels")),
  ];
}

// ===== Text (4.6, 3.4) =====

const SEGMENTER = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

/** Characters as people see them (Devanagari conjuncts count once). */
export function countGraphemes(text: string): number {
  if (!SEGMENTER) return Array.from(text).length;
  return [...SEGMENTER.segment(text)].length;
}

/** Hashtags as Instagram counts them: # followed by letters, digits or underscores. */
export function countHashtags(text: string): number {
  return (text.match(/#[\p{L}\p{M}\p{N}_]+/gu) ?? []).length;
}

/**
 * The length checked against Instagram's 2,200 limit: UTF-16 code units, the largest of the usual counts, so the stop is
 * never later than Instagram's own (an emoji counts 2; Devanagari counts per code point).
 */
export const instagramLength = (text: string): number => text.length;

export type TextFields = { primary: string; headline?: string; description?: string };
export type TextProblemCode = "caption_too_long" | "too_many_hashtags";
export type TextProblem = { code: TextProblemCode; severity: "block"; key: PromoteCopyKey; text: Record<PromoteLang, string> };
export type TextCounter = { field: "primary" | "headline" | "description"; platform: "instagram" | "facebook" | "stories" | "reels" | "carousel"; count: number; limit: number };

/** True when the selection (or Automatic with an identity) shows on Instagram. */
export function showsOnInstagram(placements: readonly PlacementKey[], hasInstagramIdentity: boolean): boolean {
  if (placements.length === 0) return hasInstagramIdentity;
  return placements.some((k) => placementRow(k).needsInstagramIdentity);
}

/**
 * Instagram's hard stops (only when the ad shows on Instagram) and the visible-length counters (guidance). The counters
 * follow the format: a carousel uses the carousel limits; otherwise feed, Stories and Reels as shown.
 */
export function checkText(fields: TextFields, placements: readonly PlacementKey[], opts: { hasInstagramIdentity: boolean; format?: AdFormat }): { problems: TextProblem[]; counters: TextCounter[] } {
  const problems: TextProblem[] = [];
  const ig = showsOnInstagram(placements, opts.hasInstagramIdentity);
  if (ig && instagramLength(fields.primary) > INSTAGRAM_CAPTION_MAX) problems.push({ code: "caption_too_long", severity: "block", key: "text.caption_too_long", text: promoteTextAll("text.caption_too_long") });
  const tags = countHashtags(fields.primary);
  if (ig && tags > INSTAGRAM_HASHTAGS_MAX) problems.push({ code: "too_many_hashtags", severity: "block", key: "text.too_many_hashtags", text: promoteTextAll("text.too_many_hashtags", { count: String(tags) }) });

  const counters: TextCounter[] = [];
  const primary = countGraphemes(fields.primary);
  const headline = countGraphemes(fields.headline ?? "");
  if (opts.format === "carousel") {
    const c = FORMAT_SPECS.carousel.text;
    counters.push({ field: "primary", platform: "carousel", count: primary, limit: c.primary }, { field: "headline", platform: "carousel", count: headline, limit: c.headline });
    if (fields.description !== undefined) counters.push({ field: "description", platform: "carousel", count: countGraphemes(fields.description), limit: c.description });
    return { problems, counters };
  }
  const groups = groupsOf(placements);
  const feed = FORMAT_SPECS.feed.text;
  const fb = placements.length === 0 || placements.some((k) => placementRow(k).platform === "facebook");
  if (groups.has("feed") && ig) counters.push({ field: "primary", platform: "instagram", count: primary, limit: feed.instagramPrimary }, { field: "headline", platform: "instagram", count: headline, limit: feed.instagramHeadline });
  if (groups.has("feed") && fb) counters.push({ field: "primary", platform: "facebook", count: primary, limit: feed.facebookPrimary }, { field: "headline", platform: "facebook", count: headline, limit: feed.facebookHeadline });
  if (groups.has("stories")) counters.push({ field: "primary", platform: "stories", count: primary, limit: FORMAT_SPECS.stories.text.primary });
  if (groups.has("reels")) counters.push({ field: "primary", platform: "reels", count: primary, limit: FORMAT_SPECS.reels.text.primary });
  return { problems, counters };
}

/** A carousel needs 2 to 10 cards (4.6). Null when the count is fine. */
export function carouselProblem(cards: number): { key: PromoteCopyKey; text: Record<PromoteLang, string> } | null {
  if (cards >= CAROUSEL_MIN_CARDS && cards <= CAROUSEL_MAX_CARDS) return null;
  return { key: "carousel.cards", text: promoteTextAll("carousel.cards") };
}
