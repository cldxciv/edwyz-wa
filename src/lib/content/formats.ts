/**
 * Post formats per channel (docs/specs/PAGE-IG-PUBLISHING-INSIGHTS-LIVE-THREADS-SPEC.md 2.1, 2.3 step 7, 4.3; package SOC-03).
 *
 * Pure: no I/O and no server-only import, so the composer in the browser and the API share the same rules. It reads the channel
 * and media types from limits.ts and never changes that file (SOC-10 makes channelProblems() delegate here).
 *
 * - allowedFormats / defaultFormat / formatOptions: which of Post, Reel and Story fit the chosen media (2.1). Story is never the
 *   default. Unknown sizes or lengths (an old file not probed yet) are not held against a format: Meta's own answer is mapped by
 *   errors.ts instead.
 * - formatProblems: the checks shown under each field before saving, with the 2.3 step 7 copy and the one-tap fix that goes with it.
 * - parseTargetOptions: PostTarget.options (4.3). Unknown keys are refused with 400; known keys that don't apply to the channel and
 *   format are dropped; every limit is enforced.
 */
import { HttpError } from "@/lib/tenancy";
import { CHANNEL_LIMITS, MAX_IMAGE_BYTES, MAX_VIDEO_BYTES, type Channel, type MediaKind } from "./limits";

export type Format = "feed" | "reel" | "story";
export const FORMATS: readonly Format[] = ["feed", "reel", "story"];

/** The formats each channel offers. Threads has posts only (text, link, photo, video, carousel). */
export const CHANNEL_FORMATS: Readonly<Record<Channel, readonly Format[]>> = {
  facebook: ["feed", "reel", "story"],
  instagram: ["feed", "reel", "story"],
  threads: ["feed"],
};

/** The short name the owner sees for each channel. */
export const CHANNEL_NAMES: Readonly<Record<Channel, string>> = { facebook: "Facebook", instagram: "Instagram", threads: "Threads" };

/** One chosen media file, as far as it is known. width and height are the display size (after rotation). */
export type FormatMedia = {
  kind: MediaKind;
  /** The library key (`<32 hex>.<ext>`), used for the file type and to point a problem at its file. */
  key?: string;
  mime?: string;
  width?: number;
  height?: number;
  durationMs?: number;
  bytes?: number;
};

/** What the post becomes on one channel: what the publisher sends and what the composer calls it. */
export type PostShape = "text" | "photo" | "album" | "video" | "carousel" | "reel" | "story";

export type ReplyControl = "everyone" | "accounts_you_follow" | "mentioned_only" | "followers_only";
export const REPLY_CONTROLS: readonly ReplyControl[] = ["everyone", "accounts_you_follow", "mentioned_only", "followers_only"];

/** PostTarget.options (4.3): only the keys that apply to the channel and format are kept; unknown keys are refused (400). */
export type PostTargetOptions = {
  /** Per-channel override of ScheduledPost.body, within the channel's limit. */
  text?: string;
  /** Facebook feed video, up to 254 characters. */
  title?: string;
  /** Instagram Reel, default true. */
  shareToFeed?: boolean;
  /** Instagram Reel thumb_offset, 0..durationMs. */
  coverOffsetMs?: number;
  /** Threads, default everyone. */
  replyControl?: ReplyControl;
  /** Threads, 1..50 characters, no "." or "&". */
  topicTag?: string;
  /** Facebook feed and Threads text, default true when the post has a link. */
  linkPreview?: boolean;
};

export const MAX_POST_MEDIA = 20;
/** VERIFY V-F2: the album maximum. 10 until the runbook confirms more. */
export const FACEBOOK_ALBUM_MAX = 10;
export const CAROUSEL_MAX = 20;
export const MIN_VIDEO_MS = 3_000;
/** Facebook Reels guide: 3 to 90 s, 9:16. */
export const FACEBOOK_REEL_MAX_MS = 90_000;
/** Instagram Reels: 3 s to 15 min. */
export const INSTAGRAM_REEL_MAX_MS = 15 * 60_000;
/** One rule for both Story channels (2.1): Facebook allows 90 s and Instagram 60 s, so Edwyz uses 60 s for both. */
export const STORY_MAX_MS = 60_000;
export const THREADS_VIDEO_MAX_MS = 5 * 60_000;
export const INSTAGRAM_STORY_VIDEO_MAX_BYTES = 100 * 1024 * 1024;
/** VERIFY: whether Threads counts unique links or every link; Edwyz counts unique links. */
export const THREADS_MAX_LINKS = 5;
export const TITLE_MAX = 254;
export const TOPIC_TAG_MAX = 50;
/** Instagram feed photos: from 4:5 (upright) to 1.91:1 (wide). */
export const INSTAGRAM_MIN_RATIO = 4 / 5;
export const INSTAGRAM_MAX_RATIO = 1.91;
/** The longest a cover frame may sit into a video when the video's length is not known (Instagram's Reel maximum). */
const COVER_OFFSET_CAP_MS = INSTAGRAM_REEL_MAX_MS;
const RATIO_SLACK = 0.001;

// ----- Small helpers -----

const MB = 1024 * 1024;
const grouped = (n: number) => n.toLocaleString("en-US");

/** "75 seconds", "1 second". */
export function formatSeconds(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${s} ${s === 1 ? "second" : "seconds"}`;
}

/** "2 min 10 s", "45 s", "2 min" (rounded to whole seconds). */
export function formatMinSec(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const min = Math.floor(total / 60);
  const sec = total % 60;
  if (min === 0) return `${sec} s`;
  return sec === 0 ? `${min} min` : `${min} min ${sec} s`;
}

const extOf = (m: FormatMedia): string | null => {
  const fromKey = m.key?.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  if (fromKey) return fromKey === "jpeg" ? "jpg" : fromKey;
  const mime = m.mime?.toLowerCase();
  if (mime === "image/png") return "png";
  if (mime === "image/jpeg") return "jpg";
  if (mime === "video/quicktime") return "mov";
  if (mime === "video/mp4") return "mp4";
  return null;
};

const known = (n: number | undefined): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
const isUpright = (m: FormatMedia) => known(m.width) && known(m.height) && m.height > m.width;
const isWide = (m: FormatMedia) => known(m.width) && known(m.height) && m.width >= m.height;
/** Within [min, max] ms, or not known (then Meta decides). */
const lengthFits = (m: FormatMedia, min: number, max: number) => !known(m.durationMs) || (m.durationMs >= min && m.durationMs <= max);

type Mix = { count: number; photos: number; videos: number; only: FormatMedia | null };
function mixOf(media: readonly FormatMedia[]): Mix {
  const photos = media.filter((m) => m.kind === "image").length;
  return { count: media.length, photos, videos: media.length - photos, only: media.length === 1 ? media[0] : null };
}

/** An upright video of 3 to 90 s, the 2.1 row where Facebook and Instagram default to a Reel. */
const shortUpright = (m: FormatMedia) => isUpright(m) && known(m.durationMs) && m.durationMs >= MIN_VIDEO_MS && m.durationMs <= FACEBOOK_REEL_MAX_MS;

// ----- Text -----

const EMOJI_GRAPHEME = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u;
const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;

/** Splits into user-perceived characters (grapheme clusters), or code points where Intl.Segmenter is missing. */
function graphemes(text: string): string[] {
  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    return Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text), (s) => s.segment);
  }
  return Array.from(text);
}

/**
 * Threads' count for its 500 characters: an emoji counts as its UTF-8 bytes (a plain smiley is 4, a flag 8, a family joined with
 * ZWJ the bytes of the whole sequence); any other character counts once per code point.
 */
export function threadsTextLength(text: string): number {
  let n = 0;
  for (const g of graphemes(text)) n += EMOJI_GRAPHEME.test(g) ? utf8Bytes(g) : Array.from(g).length;
  return n;
}

/** The length a channel checks against its limit: Threads counts emoji by bytes; Facebook and Instagram count as today. */
export function textLength(channel: Channel, text: string): number {
  return channel === "threads" ? threadsTextLength(text) : text.length;
}

/** The links in a text, each once (case-insensitive), without trailing punctuation. */
export function linksIn(text: string): string[] {
  const seen = new Map<string, string>();
  for (const m of text.matchAll(/\b(?:https?:\/\/|www\.)[^\s<>"]+/gi)) {
    const link = m[0].replace(/[.,!?;:)\]'"]+$/, "");
    if (link && !seen.has(link.toLowerCase())) seen.set(link.toLowerCase(), link);
  }
  return [...seen.values()];
}

// ----- Formats for the chosen media (2.1) -----

export type FormatOption = { format: Format; label: string; allowed: boolean; reason?: string };

const FORMAT_LABELS: Record<Format, string> = { feed: "Post", reel: "Reel", story: "Story" };
const REEL_NEEDS: Record<"facebook" | "instagram", string> = {
  facebook: "Reel needs one video, 3 to 90 seconds.",
  instagram: "Reel needs one video, 3 seconds to 15 minutes.",
};
const STORY_NEEDS = "Story needs one photo or one video up to 60 seconds.";
const FB_ALBUM_LIMIT = "Facebook takes up to 10 photos in one post.";
const FB_NO_MIX = "Facebook can't mix photos and videos in one post.";
const FB_ONE_VIDEO = "Facebook takes one video per post.";
const IG_NEEDS_MEDIA = "Instagram needs a photo or video.";
const IG_VIDEO_IS_REEL = "Instagram posts a single video as a Reel.";
const THREADS_VIDEO_LONG = "Threads videos can be up to 5 minutes long.";
const tooManyFiles = (channel: Channel) => `${CHANNEL_NAMES[channel]} takes up to ${MAX_POST_MEDIA} photos and videos in one post.`;
const notOffered = (channel: Channel, format: Format) => `${CHANNEL_NAMES[channel]} doesn't offer ${FORMAT_LABELS[format]}s.`;

/** Why `format` does not fit `media` on `channel`, or null when it fits (the generic "needs" line of 2.3 step 4). */
function whyNot(channel: Channel, format: Format, mix: Mix): string | null {
  if (!CHANNEL_FORMATS[channel].includes(format)) return notOffered(channel, format);
  const v = mix.only?.kind === "video" ? mix.only : null;
  if (format === "story") {
    if (!mix.only) return STORY_NEEDS;
    if (v && !lengthFits(v, MIN_VIDEO_MS, STORY_MAX_MS)) return STORY_NEEDS;
    return null;
  }
  if (format === "reel") {
    const rule = channel === "facebook" ? "facebook" : "instagram";
    if (!v) return REEL_NEEDS[rule];
    if (channel === "facebook") return lengthFits(v, MIN_VIDEO_MS, FACEBOOK_REEL_MAX_MS) && !isWide(v) ? null : REEL_NEEDS.facebook;
    return lengthFits(v, MIN_VIDEO_MS, INSTAGRAM_REEL_MAX_MS) ? null : REEL_NEEDS.instagram;
  }
  // feed
  if (mix.count > MAX_POST_MEDIA) return channel === "facebook" && mix.videos === 0 ? FB_ALBUM_LIMIT : tooManyFiles(channel);
  if (channel === "facebook") {
    if (mix.photos > 0 && mix.videos > 0) return FB_NO_MIX;
    if (mix.videos > 1) return FB_ONE_VIDEO;
    if (mix.photos > FACEBOOK_ALBUM_MAX) return FB_ALBUM_LIMIT;
    return null;
  }
  if (channel === "instagram") {
    if (mix.count === 0) return IG_NEEDS_MEDIA;
    if (v) return IG_VIDEO_IS_REEL;
    return null;
  }
  if (v && !lengthFits(v, 0, THREADS_VIDEO_MAX_MS)) return THREADS_VIDEO_LONG;
  return null;
}

/** Every format the channel offers, with whether it fits the media and why not (2.3 step 4: "Disabled options say why"). */
export function formatOptions(channel: Channel, media: readonly FormatMedia[]): FormatOption[] {
  const mix = mixOf(media);
  return CHANNEL_FORMATS[channel].map((format) => {
    const reason = whyNot(channel, format, mix);
    return reason ? { format, label: FORMAT_LABELS[format], allowed: false, reason } : { format, label: FORMAT_LABELS[format], allowed: true };
  });
}

/** The formats that fit the media on this channel (2.1). */
export function allowedFormats(channel: Channel, media: readonly FormatMedia[]): Format[] {
  return formatOptions(channel, media)
    .filter((o) => o.allowed)
    .map((o) => o.format);
}

/** The format Edwyz picks for the owner (2.1), or null when the channel can't take this media. Story is never the default. */
export function defaultFormat(channel: Channel, media: readonly FormatMedia[]): Format | null {
  const allowed = new Set(allowedFormats(channel, media));
  const mix = mixOf(media);
  const v = mix.only?.kind === "video" ? mix.only : null;
  if (channel === "facebook") {
    if (v && shortUpright(v) && allowed.has("reel")) return "reel";
    return allowed.has("feed") ? "feed" : null;
  }
  if (channel === "instagram") {
    if (v) return allowed.has("reel") ? "reel" : null;
    return allowed.has("feed") ? "feed" : null;
  }
  return allowed.has("feed") ? "feed" : null;
}

/** What the post becomes on the channel in this format (for the publisher's dispatch and the label). */
export function shapeOf(channel: Channel, format: Format, media: readonly FormatMedia[]): PostShape {
  if (format === "reel" || format === "story") return format;
  const mix = mixOf(media);
  if (mix.count === 0) return "text";
  if (mix.count === 1) return mix.only?.kind === "video" ? (channel === "instagram" ? "reel" : "video") : "photo";
  return channel === "facebook" ? "album" : "carousel";
}

/** The name in the composer and on Eddy's card: "Facebook (Photo)", "Instagram (Post)", "Threads (Carousel)". */
export function formatLabel(channel: Channel, format: Format, media: readonly FormatMedia[]): string {
  const shape = shapeOf(channel, format, media);
  if (channel === "instagram" && shape === "photo") return "Post";
  const labels: Record<PostShape, string> = { text: "Post", photo: "Photo", album: "Album", video: "Video", carousel: "Carousel", reel: "Reel", story: "Story" };
  return labels[shape];
}

// ----- Instagram photo shape -----

/** True when a photo of this size fits Instagram's feed (4:5 to 1.91:1). Unknown sizes pass. */
export function instagramShapeFits(width: number | undefined, height: number | undefined): boolean {
  if (!known(width) || !known(height) || width === 0 || height === 0) return true;
  const ratio = width / height;
  return ratio >= INSTAGRAM_MIN_RATIO - RATIO_SLACK && ratio <= INSTAGRAM_MAX_RATIO + RATIO_SLACK;
}

/**
 * The centre crop for "Crop to fit" (2.3 step 7): 4:5 for a photo that is too tall, 1.91:1 for one that is too wide, or null when
 * the photo already fits. Whole pixels.
 */
export function instagramCrop(width: number, height: number): { x: number; y: number; width: number; height: number } | null {
  if (instagramShapeFits(width, height)) return null;
  if (width / height < INSTAGRAM_MIN_RATIO) {
    const h = Math.min(height, Math.floor(width / INSTAGRAM_MIN_RATIO));
    return { x: 0, y: Math.floor((height - h) / 2), width, height: h };
  }
  const w = Math.min(width, Math.floor(height * INSTAGRAM_MAX_RATIO));
  return { x: Math.floor((width - w) / 2), y: 0, width: w, height };
}

// ----- Checks before saving (2.3 step 7) -----

/** The one-tap fix offered next to a problem, when there is one. */
export type ProblemFix = "make_jpeg" | "crop_to_fit" | "write_shorter" | "post_as_video" | "remove_media";

export type FormatProblem = {
  /** A stable id for the UI and tests. */
  code:
    | "not_offered"
    | "too_many_files"
    | "needs_media"
    | "empty"
    | "text_too_long"
    | "hashtags"
    | "jpeg_only"
    | "photo_shape"
    | "reel_media"
    | "reel_length"
    | "reel_shape"
    | "story_media"
    | "story_length"
    | "album_too_big"
    | "mixed_media"
    | "one_video"
    | "video_as_reel"
    | "threads_links"
    | "threads_video_length"
    | "video_size"
    | "photo_size"
    | "story_video_size";
  message: string;
  fix?: ProblemFix;
  /** The media file the problem is about. */
  mediaKey?: string;
};

export type FormatContext = {
  /** ScheduledPost.link, which Facebook and Threads attach as the link preview. */
  link?: string | null;
  /** The server's video limit (CONTENT_MAX_VIDEO_MB); limits.ts's value when not given. */
  maxVideoBytes?: number;
};

/** The text a channel gets: the per-channel override when there is one, else the post's text. */
export function channelText(body: string, options: PostTargetOptions | undefined): string {
  return typeof options?.text === "string" && options.text.trim() ? options.text : body;
}

const tooLong = (channel: Channel) => {
  const name = CHANNEL_NAMES[channel];
  return `${name} allows ${grouped(CHANNEL_LIMITS[channel].maxChars)} characters. Write a shorter version for ${name}.`;
};

/**
 * Problems that stop this post from going to `channel` as `format`, each with the copy shown under its field and the fix offered
 * there. Empty when the post is fine. `options.text`, when set, is checked instead of `body` (the per-channel override).
 */
export function formatProblems(
  channel: Channel,
  format: Format,
  body: string,
  media: readonly FormatMedia[],
  options: PostTargetOptions = {},
  ctx: FormatContext = {},
): FormatProblem[] {
  const problems: FormatProblem[] = [];
  const add = (p: FormatProblem) => void problems.push(p);
  const name = CHANNEL_NAMES[channel];
  const mix = mixOf(media);
  const v = mix.only?.kind === "video" ? mix.only : null;
  const text = channelText(body, options);

  if (!CHANNEL_FORMATS[channel].includes(format)) return [{ code: "not_offered", message: notOffered(channel, format) }];

  // Text.
  if (textLength(channel, text) > CHANNEL_LIMITS[channel].maxChars) add({ code: "text_too_long", message: tooLong(channel), fix: "write_shorter" });
  const maxTags = CHANNEL_LIMITS[channel].maxHashtags;
  if (maxTags && (text.match(/#[\p{L}\p{N}_]+/gu)?.length ?? 0) > maxTags) add({ code: "hashtags", message: `${name} allows at most ${maxTags} hashtags.` });
  if (channel === "threads") {
    const links = linksIn(text);
    const extra = ctx.link && format === "feed" && mix.count === 0 && options.linkPreview !== false && !links.some((l) => l.toLowerCase() === ctx.link!.toLowerCase()) ? 1 : 0;
    if (links.length + extra > THREADS_MAX_LINKS) add({ code: "threads_links", message: "Threads allows at most 5 links in one post." });
  }

  // Media count and mix.
  if (mix.count > MAX_POST_MEDIA && !(channel === "facebook" && format === "feed" && mix.videos === 0)) {
    add({ code: "too_many_files", message: tooManyFiles(channel), fix: "remove_media" });
  } else if (format === "feed") {
    if (channel === "instagram" && mix.count === 0) add({ code: "needs_media", message: IG_NEEDS_MEDIA });
    if (channel === "instagram" && v) add({ code: "video_as_reel", message: IG_VIDEO_IS_REEL });
    if (channel === "facebook" && mix.photos > 0 && mix.videos > 0) add({ code: "mixed_media", message: FB_NO_MIX });
    else if (channel === "facebook" && mix.videos > 1) add({ code: "one_video", message: FB_ONE_VIDEO });
    else if (channel === "facebook" && mix.photos > FACEBOOK_ALBUM_MAX) {
      const extraPhotos = mix.photos - FACEBOOK_ALBUM_MAX;
      add({ code: "album_too_big", message: `Facebook takes up to 10 photos in one post. Remove ${extraPhotos}, or turn off Facebook for this post.`, fix: "remove_media" });
    }
    if (channel !== "instagram" && mix.count === 0 && !text.trim()) add({ code: "empty", message: `${name} posts need text, a photo or a video.` });
  } else if (format === "reel") {
    if (!v) add({ code: "reel_media", message: REEL_NEEDS[channel === "facebook" ? "facebook" : "instagram"] });
  } else if (!mix.only) {
    add({ code: "story_media", message: STORY_NEEDS });
  }

  // Video length and shape.
  if (v && known(v.durationMs)) {
    const d = v.durationMs;
    if (format === "reel" && channel === "facebook" && (d < MIN_VIDEO_MS || d > FACEBOOK_REEL_MAX_MS)) {
      add({ code: "reel_length", message: `Reels must be 3 to 90 seconds on Facebook. This video is ${formatMinSec(d)}. Post it as a Video instead.`, fix: "post_as_video", mediaKey: v.key });
    }
    if (format === "reel" && channel === "instagram" && (d < MIN_VIDEO_MS || d > INSTAGRAM_REEL_MAX_MS)) {
      add({ code: "reel_length", message: `Instagram Reels must be 3 seconds to 15 minutes. This video is ${formatMinSec(d)}.`, mediaKey: v.key });
    }
    if (format === "story" && d > STORY_MAX_MS) add({ code: "story_length", message: `Stories take videos up to 60 seconds. This video is ${formatSeconds(d)}.`, mediaKey: v.key });
    if (format === "story" && d < MIN_VIDEO_MS) add({ code: "story_length", message: `Stories take videos of at least 3 seconds. This video is ${formatSeconds(d)}.`, mediaKey: v.key });
    if (channel === "threads" && d > THREADS_VIDEO_MAX_MS) add({ code: "threads_video_length", message: THREADS_VIDEO_LONG, mediaKey: v.key });
  }
  if (v && format === "reel" && channel === "facebook" && isWide(v)) {
    add({ code: "reel_shape", message: "Reels must be upright (taller than wide) on Facebook. Post it as a Video instead.", fix: "post_as_video", mediaKey: v.key });
  }

  // Photos on Instagram.
  if (channel === "instagram") {
    for (const m of media) {
      if (m.kind !== "image") continue;
      if (extOf(m) === "png") add({ code: "jpeg_only", message: "Instagram needs a JPEG photo.", fix: "make_jpeg", mediaKey: m.key });
      else if (format === "feed" && !instagramShapeFits(m.width, m.height)) add({ code: "photo_shape", message: "This photo's shape doesn't fit Instagram.", fix: "crop_to_fit", mediaKey: m.key });
    }
  }

  // Sizes.
  const maxVideo = ctx.maxVideoBytes ?? MAX_VIDEO_BYTES;
  for (const m of media) {
    if (!known(m.bytes)) continue;
    if (m.kind === "video" && m.bytes > maxVideo) add({ code: "video_size", message: `Videos can be up to ${Math.floor(maxVideo / MB)} MB.`, mediaKey: m.key });
    else if (m.kind === "video" && channel === "instagram" && format === "story" && m.bytes > INSTAGRAM_STORY_VIDEO_MAX_BYTES) {
      add({ code: "story_video_size", message: "Instagram Stories take videos up to 100 MB.", mediaKey: m.key });
    }
    if (m.kind === "image" && m.bytes > MAX_IMAGE_BYTES) add({ code: "photo_size", message: "Photos can be up to 8 MB.", mediaKey: m.key });
  }
  return problems;
}

// ----- PostTarget.options (4.3) -----

type OptionKey = keyof PostTargetOptions;
const OPTION_KEYS: readonly OptionKey[] = ["text", "title", "shareToFeed", "coverOffsetMs", "replyControl", "topicTag", "linkPreview"];

/** Where each option applies. `text` applies everywhere. */
function applies(key: OptionKey, channel: Channel, format: Format): boolean {
  switch (key) {
    case "text":
      return true;
    case "title":
      return channel === "facebook" && format === "feed";
    case "shareToFeed":
    case "coverOffsetMs":
      return channel === "instagram" && format === "reel";
    case "replyControl":
    case "topicTag":
      return channel === "threads" && format === "feed";
    case "linkPreview":
      return (channel === "facebook" || channel === "threads") && format === "feed";
  }
}

const bad = (message: string): never => {
  throw new HttpError(400, message);
};

/** Reads a format from a request body. Refuses (400) a format the channel doesn't offer. */
export function parseFormat(channel: Channel, raw: unknown): Format {
  if (typeof raw !== "string" || !(FORMATS as readonly string[]).includes(raw)) return bad("format must be feed, reel or story.");
  const format = raw as Format;
  if (!CHANNEL_FORMATS[channel].includes(format)) return bad(notOffered(channel, format));
  return format;
}

/**
 * Validates PostTarget.options for one channel and format (4.3). Unknown keys are refused (400). Known keys that don't apply to
 * this channel and format are dropped, so switching format in the composer never fails a save. Limits: text within the channel's
 * limit (an empty override means "use the post's text" and is dropped), title up to 254 characters, coverOffsetMs a whole number
 * of ms within the video (`ctx.durationMs`, or 15 min when the length is not known), replyControl from the list, topicTag 1 to 50
 * characters without "." or "&".
 */
export function parseTargetOptions(channel: Channel, format: Format, raw: unknown, ctx: { durationMs?: number } = {}): PostTargetOptions {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) return bad("options must be an object.");
  const input = raw as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!(OPTION_KEYS as readonly string[]).includes(key)) return bad(/^[A-Za-z]{1,40}$/.test(key) ? `Unknown option "${key}".` : "Unknown option.");
  }
  const out: PostTargetOptions = {};
  for (const key of OPTION_KEYS) {
    const value = input[key];
    if (value === undefined || !applies(key, channel, format)) continue;
    switch (key) {
      case "text": {
        if (typeof value !== "string") return bad("The text for one channel must be text.");
        if (!value.trim()) break;
        if (textLength(channel, value) > CHANNEL_LIMITS[channel].maxChars) return bad(tooLong(channel));
        out.text = value;
        break;
      }
      case "title": {
        if (typeof value !== "string") return bad("The video title must be text.");
        if (value.length > TITLE_MAX) return bad(`The video title can be up to ${TITLE_MAX} characters.`);
        if (value.trim()) out.title = value;
        break;
      }
      case "shareToFeed":
      case "linkPreview": {
        if (typeof value !== "boolean") return bad(`${key} must be true or false.`);
        out[key] = value;
        break;
      }
      case "coverOffsetMs": {
        const max = known(ctx.durationMs) ? ctx.durationMs : COVER_OFFSET_CAP_MS;
        if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) return bad("Pick a cover frame inside the video.");
        out.coverOffsetMs = value;
        break;
      }
      case "replyControl": {
        if (typeof value !== "string" || !(REPLY_CONTROLS as readonly string[]).includes(value)) return bad("Choose who can reply: everyone, accounts you follow, people you mention or your followers.");
        out.replyControl = value as ReplyControl;
        break;
      }
      case "topicTag": {
        if (typeof value !== "string" || value.length < 1 || value.length > TOPIC_TAG_MAX || /[.&]/.test(value) || !value.trim()) {
          return bad('A topic can be 1 to 50 characters, without "." or "&".');
        }
        out.topicTag = value;
        break;
      }
    }
  }
  return out;
}

/** The options with the 4.3 defaults filled in (shareToFeed true, replyControl everyone, linkPreview true when there is a link). */
export function withDefaults(channel: Channel, format: Format, options: PostTargetOptions, hasLink: boolean): PostTargetOptions {
  const out: PostTargetOptions = { ...options };
  if (applies("shareToFeed", channel, format) && out.shareToFeed === undefined) out.shareToFeed = true;
  if (applies("replyControl", channel, format) && out.replyControl === undefined) out.replyControl = "everyone";
  if (applies("linkPreview", channel, format) && out.linkPreview === undefined) out.linkPreview = hasLink;
  return out;
}
