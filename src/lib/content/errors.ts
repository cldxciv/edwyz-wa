/**
 * Meta errors in plain words (docs/specs/PAGE-IG-PUBLISHING-INSIGHTS-LIVE-THREADS-SPEC.md 3.5; package SOC-03), used by the
 * publishers, Live and Results. Each answer becomes {copy, action}:
 * - retry: safe to repeat automatically (Meta refused, or nothing was sent);
 * - wait: a daily limit or a pause; try again after waitMs;
 * - fail: stop and show the copy (the owner fixes something first);
 * - unclear: a create or publish step may have reached Meta (a 5xx or a dropped connection). Never repeated automatically.
 *
 * Raw Meta text never reaches the copy: the message is only matched against known markers, and `ref` carries the numeric code
 * and subcode for support and logs. VERIFY rows (V-I8, V-I9) are marked where a code is not confirmed; SOC-20 records the real
 * codes here.
 */
import { GraphError } from "@/lib/graph";
import { resolveTimeZone } from "@/lib/spend/periods";
import type { Channel } from "./limits";

export type ErrorAction = "retry" | "wait" | "fail" | "unclear";

/** What Edwyz was doing when Meta answered: it picks the permission sentence and the fallback. */
export type ErrorPurpose = "post" | "remove" | "results" | "live" | "replies_read" | "replies_manage";

/** read and upload never create anything on Meta; create and publish do (3.1 idempotency). */
export type ErrorStep = "read" | "upload" | "create" | "publish";

export type ErrorKind =
  | "expired"
  | "permission"
  | "too_few_views"
  | "live_followers"
  | "live_account_age"
  | "rate_limit"
  | "spam_block"
  | "live_time"
  | "ig_quota"
  | "ig_aspect"
  | "ig_image"
  | "ig_video"
  | "ig_container"
  | "ppa"
  | "download"
  | "threads_links"
  | "threads_duration"
  | "threads_video"
  | "threads_download"
  | "quota"
  | "unclear"
  | "transient"
  | "unknown";

export type PlainError = {
  kind: ErrorKind;
  copy: string;
  action: ErrorAction;
  /** Automatic retries this answer allows before it fails (absent: the caller's own limit). */
  retries?: number;
  /** For action "wait": how long to wait before trying again. */
  waitMs?: number;
  /** The connection the owner fixes it with, when the fix is reconnecting. */
  reconnect?: "facebook" | "threads";
  /** The form field the copy belongs under (a live's start time). */
  field?: "when";
  /** Meta's numeric code and subcode, a container status or "network": safe for logs and support, never raw text. */
  ref: string;
};

export type ErrorContext = {
  /** facebook (Page), instagram or threads. Default facebook. */
  channel?: Channel;
  /** Default "post". */
  purpose?: ErrorPurpose;
  /** Default "read" (nothing created). Pass "create" or "publish" for steps that make something on Meta. */
  step?: ErrorStep;
  /** The account's name ("Sunrise Realty", "@sunrise"). Defaults to the channel's name. */
  account?: string;
  /** For the Instagram limit (code 9 / 2207042): Meta's quota_total and when the post can go, when known. */
  quota?: { total?: number; after?: Date | null };
  now?: Date;
  timeZone?: string;
};

/** A Meta failure without the transport's class (tests, or a caller that already unpacked one). */
export type MetaFailure = { status: number; code?: number; subcode?: number; message?: string; ambiguous?: boolean };

// ----- Codes -----

export const RATE_LIMIT_CODES: ReadonlySet<number> = new Set([4, 17, 32, 613, 80001, 80002]);
const EXPIRED_CODES = new Set([190, 102]);
const PERMISSION_CODES = new Set([3, 10, 200]);
export const LIVE_FOLLOWERS_SUBCODE = 1363144;
export const LIVE_ACCOUNT_AGE_SUBCODE = 1363120;
/** VERIFY V-I8: Instagram's "too many posts" answer (third-party sources). */
export const IG_QUOTA = { code: 9, subcode: 2207042 };
/** VERIFY V-I8. */
export const IG_ASPECT = { code: 36003, subcode: 2207009 };
/** VERIFY V-I8: image too large (2207004) and unsupported format (2207005). */
export const IG_IMAGE_SUBCODES: ReadonlySet<number> = new Set([2207004, 2207005]);
/** VERIFY V-I8. */
export const IG_VIDEO_SUBCODE = 2207026;
/** VERIFY V-I8: Instagram's download failures (code 9004; 2207052 "could not be fetched", 2207003 "timeout downloading"). */
export const IG_DOWNLOAD = { code: 9004, subcodes: new Set([2207052, 2207003]) as ReadonlySet<number> };
/** VERIFY V-I8: Facebook's "missing or invalid image file" when it could not fetch the photo URL. */
const FB_DOWNLOAD_CODE = 324;
/**
 * VERIFY V-I9: the Page Publishing Authorization subcodes (Facebook 200, Instagram 10). None is confirmed yet, so PPA is also
 * recognised by Meta's own wording. SOC-20 adds the codes it records.
 */
export const PPA_SUBCODES: ReadonlySet<number> = new Set<number>();
const PPA_WORDING = /publishing authori[sz]ation/i;
const DOWNLOAD_WORDING = /\b(download|fetch)/i;
const TOO_FEW_VIEWERS = /not enough viewers/i;
const LIVE_TIME_CODE = 1000;
const SPAM_CODE = 368;

/** Threads' container error_message values (T11) and API error names, as Meta spells them (INVALID_ASPEC_RATIO included). */
const THREADS_VIDEO_ERRORS = [
  "INVALID_ASPEC_RATIO",
  "INVALID_ASPECT_RATIO",
  "INVALID_FRAME_RATE",
  "INVALID_BIT_RATE",
  "FAILED_PROCESSING_VIDEO",
  "FAILED_PROCESSING_AUDIO",
  "INVALID_AUDIO_CHANNELS",
  "INVALID_AUDIO_CHANNEL_LAYOUT",
] as const;
const THREADS_TOKEN = /\b(THREADS_API__[A-Z_]+|FAILED_[A-Z_]+|INVALID_[A-Z_]+|UNKNOWN)\b/;

const RESULTS_PAUSE_MS = 3_600_000;
/** The existing Instagram limit defer (publishers.ts): it claims again only after the reset. */
export const QUOTA_RECHECK_MS = 15 * 60_000;
const MIN_WAIT_MS = 60_000;

// ----- Copy -----

const NAMES: Record<Channel, string> = { facebook: "Facebook", instagram: "Instagram", threads: "Threads" };
const grouped = (n: number) => n.toLocaleString("en-US");

export const ERROR_COPY = {
  expiredFacebook: "Your Facebook connection has expired. Reconnect it in Settings > Meta connections, then try again.",
  expiredThreads: "Your Threads connection has expired. Reconnect Threads in Settings > Meta connections.",
  permission: (doing: string, account: string) => `Edwyz isn't allowed to ${doing} ${account}. Reconnect and allow it.`,
  repliesPermission: (verb: "read" | "manage") => `Edwyz can't ${verb} replies. Connect Threads again and allow it.`,
  tooFewViews: "Too few views to show numbers.",
  liveFollowers: "Facebook lets Pages go live from apps only when they have at least 100 followers.",
  liveAccountAge: "Facebook lets an account go live from apps once it's at least 60 days old.",
  rateLimit: "Meta asked us to slow down. We'll try again in a few minutes.",
  spam: "Facebook blocked this for now because it looked like spam to them. Wait an hour and try again.",
  liveTime: "That start time doesn't work for Facebook. Choose a time within the next 7 days.",
  igAspect: "This photo's shape doesn't fit Instagram. Use a square, an upright 4:5 or a wide 1.91:1 photo.",
  igImage: "Instagram needs a JPEG photo up to 8 MB.",
  igVideo: "Instagram couldn't use this video. Use an MP4 or MOV between 3 seconds and 15 minutes.",
  igContainer: "Instagram couldn't process the media. Try a different file.",
  ppa:
    "Facebook needs you to confirm your identity for this Page before apps can post (Page Publishing Authorization). " +
    "Open your Page on Facebook, follow the steps Facebook shows for publishing authorization, then try again.",
  download: "Meta couldn't download the file from Edwyz. Try again. If it keeps happening, upload the file again.",
  threadsLinks: "Threads allows at most 5 links in one post.",
  threadsDuration: "Threads videos can be up to 5 minutes long.",
  threadsVideo: "Threads couldn't use this video. Export it again as MP4 (H.264, 30 fps) and try again.",
  threadsDownload: "Threads couldn't download the video from Edwyz. Try again.",
  unclearPost: (account: string) => `Meta didn't confirm whether this was posted. Check ${account} first. If it isn't there, post it again.`,
  unclearLive: (account: string) => `Meta didn't confirm whether this worked. Check ${account} on Facebook before you try again.`,
  unclearReply: "Threads didn't confirm whether this worked. Check the post on Threads before you try again.",
  transientBackground: "Meta didn't answer in time. We'll try again in a few minutes.",
  transientNow: "Meta didn't answer in time. Try again in a few minutes.",
  fallbackPost: (channel: string) => `${channel} didn't accept this post. Try again, or change the media.`,
  fallbackRemove: (channel: string) => `${channel} didn't remove this post. Try again in a few minutes.`,
  fallbackLive: "Facebook didn't accept this. Try again in a few minutes.",
  fallbackResults: (channel: string) => `${channel} didn't send your numbers this time. We'll try again later.`,
  fallbackRepliesRead: "Threads didn't send the replies this time. Try again in a few minutes.",
  fallbackRepliesManage: "Threads didn't accept this. Try again in a few minutes.",
} as const;

const PERMISSION_DOING: Record<"post" | "remove" | "results" | "live", string> = {
  post: "post on",
  remove: "remove posts from",
  results: "read results of",
  live: "go live on",
};

function fallbackCopy(purpose: ErrorPurpose, channel: Channel): string {
  const name = NAMES[channel];
  switch (purpose) {
    case "post":
      return ERROR_COPY.fallbackPost(name);
    case "remove":
      return ERROR_COPY.fallbackRemove(name);
    case "live":
      return ERROR_COPY.fallbackLive;
    case "results":
      return ERROR_COPY.fallbackResults(name);
    case "replies_read":
      return ERROR_COPY.fallbackRepliesRead;
    case "replies_manage":
      return ERROR_COPY.fallbackRepliesManage;
  }
}

function unclearCopy(purpose: ErrorPurpose, account: string): string {
  if (purpose === "live") return ERROR_COPY.unclearLive(account);
  if (purpose === "replies_manage") return ERROR_COPY.unclearReply;
  return ERROR_COPY.unclearPost(account);
}

/** Purposes whose create or publish step can make something twice. Remove is safe to repeat; reads never create. */
const CREATING_PURPOSES: ReadonlySet<ErrorPurpose> = new Set(["post", "live", "replies_manage"]);

const refOf = (code?: number, subcode?: number) => `meta:${code ?? "none"}${subcode !== undefined ? `/${subcode}` : ""}`;

// ----- Times for the wait copy -----

const dayKey = (at: Date, tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);

/** "3:15 pm", "3:15 pm tomorrow" or "3:15 pm on 4 Nov", in the given zone (default Asia/Kolkata). */
export function formatAfter(after: Date, now: Date = new Date(), timeZone?: string): string {
  const tz = resolveTimeZone(timeZone);
  const time = new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: tz })
    .format(after)
    .replace(/\s?(am|pm)$/i, (m) => ` ${m.trim().toLowerCase()}`);
  const today = dayKey(now, tz);
  const day = dayKey(after, tz);
  if (day <= today) return time;
  if (day === dayKey(new Date(now.getTime() + 86_400_000), tz)) return `${time} tomorrow`;
  return `${time} on ${new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: tz }).format(after)}`;
}

const waitFor = (after: Date | null | undefined, now: Date) => (after ? Math.max(after.getTime() - now.getTime(), MIN_WAIT_MS) : QUOTA_RECHECK_MS);

// ----- Daily limits -----

export type QuotaKind = "instagram_posts" | "threads_posts" | "threads_replies" | "threads_deletes" | "facebook_reels";

const QUOTA_DEFAULT_TOTAL: Record<QuotaKind, number | undefined> = {
  instagram_posts: undefined,
  threads_posts: 250,
  threads_replies: 1000,
  threads_deletes: 100,
  facebook_reels: 30,
};

/**
 * A daily limit that is full (3.5, 3.6). Instagram's total is Meta's quota_total and is never assumed (D23). The copy names the
 * time the post goes out (or, for replies and removals, when to try again) in the owner's zone. action "wait".
 */
export function quotaFull(kind: QuotaKind, opts: { total?: number; after?: Date | null; now?: Date; timeZone?: string } = {}): PlainError {
  const now = opts.now ?? new Date();
  const total = opts.total ?? QUOTA_DEFAULT_TOTAL[kind];
  const when = opts.after ? formatAfter(opts.after, now, opts.timeZone) : null;
  const copy = quotaCopy(kind, total, when);
  return { kind: kind === "instagram_posts" ? "ig_quota" : "quota", copy, action: "wait", waitMs: waitFor(opts.after, now), ref: `quota:${kind}` };
}

function quotaCopy(kind: QuotaKind, total: number | undefined, when: string | null): string {
  const goesOut = (what: string) => (when ? `This ${what} will go out after ${when}.` : `This ${what} will go out when the limit resets.`);
  const tryAgain = when ? `Try again after ${when}.` : "Try again later today.";
  switch (kind) {
    case "instagram_posts":
      return `${total ? `Instagram allows ${grouped(total)} posts a day from apps.` : "Instagram's daily limit for posts from apps is reached."} ${goesOut("post")}`;
    case "threads_posts":
      return `Threads allows ${grouped(total ?? 250)} posts a day from apps. ${goesOut("post")}`;
    case "threads_replies":
      return `Threads allows ${grouped(total ?? 1000)} replies a day from apps. ${tryAgain}`;
    case "threads_deletes":
      return `Threads allows ${grouped(total ?? 100)} removals a day from apps. ${tryAgain}`;
    case "facebook_reels":
      return `Facebook allows ${grouped(total ?? 30)} Reels a day from apps for each Page. ${goesOut("Reel")}`;
  }
}

// ----- Containers (I8, T11) -----

/**
 * A container status that ends the post, in plain words, or null while it is fine (IN_PROGRESS, FINISHED, PUBLISHED).
 * Instagram: ERROR or EXPIRED. Threads: ERROR with its error_message (T11), or EXPIRED.
 */
export function containerProblem(channel: "instagram" | "threads", status: string | null | undefined, errorMessage?: string | null): PlainError | null {
  const s = String(status ?? "").toUpperCase();
  if (s !== "ERROR" && s !== "EXPIRED") return null;
  if (channel === "instagram") return { kind: "ig_container", copy: ERROR_COPY.igContainer, action: "fail", ref: `container:${s}` };
  const token = THREADS_TOKEN.exec(String(errorMessage ?? ""))?.[1];
  const mapped = token ? threadsToken(token) : null;
  if (mapped) return { ...mapped, ref: `container:${s}:${token}` };
  return { kind: "unknown", copy: ERROR_COPY.fallbackPost("Threads"), action: "fail", ref: `container:${s}` };
}

function threadsToken(token: string): Omit<PlainError, "ref"> | null {
  if (token === "THREADS_API__LINK_LIMIT_EXCEEDED") return { kind: "threads_links", copy: ERROR_COPY.threadsLinks, action: "fail" };
  if (token === "INVALID_DURATION") return { kind: "threads_duration", copy: ERROR_COPY.threadsDuration, action: "fail" };
  if (token === "FAILED_DOWNLOADING_VIDEO") return { kind: "threads_download", copy: ERROR_COPY.threadsDownload, action: "retry", retries: 1 };
  if ((THREADS_VIDEO_ERRORS as readonly string[]).includes(token) || token.startsWith("FAILED_PROCESSING_")) return { kind: "threads_video", copy: ERROR_COPY.threadsVideo, action: "fail" };
  return null;
}

// ----- The map -----

function unpack(e: unknown): MetaFailure | null {
  if (e instanceof GraphError) return { status: e.status, code: e.code, subcode: e.subcode, message: e.message, ambiguous: e.ambiguous };
  if (e && typeof e === "object" && !(e instanceof Error) && typeof (e as MetaFailure).status === "number") return e as MetaFailure;
  return null;
}

/** The unclear-outcome answer (3.5 last row), also used when a create or publish step was interrupted (3.1). */
export function unclearOutcome(ctx: ErrorContext = {}): PlainError {
  const channel = ctx.channel ?? "facebook";
  return { kind: "unclear", copy: unclearCopy(ctx.purpose ?? "post", ctx.account ?? NAMES[channel]), action: "unclear", ref: "unclear" };
}

/**
 * Maps a Meta answer (a GraphError from graphFetchAs, binary.ts or threadsFetch) to plain words and what to do (3.5). Anything else
 * (a local error) gets the purpose's fallback with action "fail".
 */
export function explainMetaError(e: unknown, ctx: ErrorContext = {}): PlainError {
  const channel = ctx.channel ?? "facebook";
  const purpose = ctx.purpose ?? "post";
  const step = ctx.step ?? "read";
  const account = ctx.account ?? NAMES[channel];
  const reconnect = channel === "threads" ? "threads" : "facebook";
  const failure = unpack(e);
  if (!failure) return { kind: "unknown", copy: fallbackCopy(purpose, channel), action: "fail", ref: "local" };
  const { status, code, subcode } = failure;
  const message = String(failure.message ?? "");
  const ref = refOf(code, subcode);
  const creates = (step === "create" || step === "publish") && CREATING_PURPOSES.has(purpose);
  const background = purpose === "post" || purpose === "results";
  const transient = (r: string): PlainError => ({ kind: "transient", copy: background ? ERROR_COPY.transientBackground : ERROR_COPY.transientNow, action: "retry", ref: r });

  // Nothing left this host: always safe to try again.
  if (status === 0 && !failure.ambiguous) return transient("network");
  // It may have reached Meta.
  if (failure.ambiguous || status === 0) return creates ? { ...unclearOutcome({ ...ctx, channel, purpose, account }), ref: "network" } : transient("network");

  if (code !== undefined && EXPIRED_CODES.has(code)) {
    return { kind: "expired", copy: channel === "threads" ? ERROR_COPY.expiredThreads : ERROR_COPY.expiredFacebook, action: "fail", reconnect, ref };
  }
  if (purpose === "results" && code === 10 && TOO_FEW_VIEWERS.test(message)) return { kind: "too_few_views", copy: ERROR_COPY.tooFewViews, action: "fail", ref };
  if ((code === 200 || code === 10) && ((subcode !== undefined && PPA_SUBCODES.has(subcode)) || PPA_WORDING.test(message))) {
    return { kind: "ppa", copy: ERROR_COPY.ppa, action: "fail", ref };
  }
  if (code === 200 && subcode === LIVE_FOLLOWERS_SUBCODE) return { kind: "live_followers", copy: ERROR_COPY.liveFollowers, action: "fail", ref };
  if (code === 200 && subcode === LIVE_ACCOUNT_AGE_SUBCODE) return { kind: "live_account_age", copy: ERROR_COPY.liveAccountAge, action: "fail", ref };
  if ((code !== undefined && RATE_LIMIT_CODES.has(code)) || status === 429) {
    return purpose === "results"
      ? { kind: "rate_limit", copy: ERROR_COPY.rateLimit, action: "wait", waitMs: RESULTS_PAUSE_MS, ref }
      : { kind: "rate_limit", copy: ERROR_COPY.rateLimit, action: "retry", ref };
  }
  // A 5xx with no rate-limit code: on a create or publish step the post may exist.
  if (status >= 500) return creates ? { ...unclearOutcome({ ...ctx, channel, purpose, account }), ref } : transient(ref);

  if (code === SPAM_CODE) return { kind: "spam_block", copy: ERROR_COPY.spam, action: "fail", ref };
  if (code === LIVE_TIME_CODE && purpose === "live") return { kind: "live_time", copy: ERROR_COPY.liveTime, action: "fail", field: "when", ref };
  if (subcode === IG_QUOTA.subcode) {
    return { ...quotaFull("instagram_posts", { total: ctx.quota?.total, after: ctx.quota?.after, now: ctx.now, timeZone: ctx.timeZone }), ref };
  }
  if (code === IG_ASPECT.code || subcode === IG_ASPECT.subcode) return { kind: "ig_aspect", copy: ERROR_COPY.igAspect, action: "fail", ref };
  if (subcode !== undefined && IG_IMAGE_SUBCODES.has(subcode)) return { kind: "ig_image", copy: ERROR_COPY.igImage, action: "fail", ref };
  if (subcode === IG_VIDEO_SUBCODE) return { kind: "ig_video", copy: ERROR_COPY.igVideo, action: "fail", ref };
  if (
    code === IG_DOWNLOAD.code ||
    (subcode !== undefined && IG_DOWNLOAD.subcodes.has(subcode)) ||
    (channel === "facebook" && (code === FB_DOWNLOAD_CODE || (code === 100 && DOWNLOAD_WORDING.test(message))))
  ) {
    return { kind: "download", copy: ERROR_COPY.download, action: "retry", retries: 1, ref };
  }
  if (channel === "threads" || /THREADS_API__/.test(message)) {
    const token = THREADS_TOKEN.exec(message)?.[1];
    const mapped = token ? threadsToken(token) : null;
    if (mapped) return { ...mapped, ref: `${ref}:${token}` };
  }
  if (code !== undefined && PERMISSION_CODES.has(code) && subcode === undefined) {
    if (purpose === "replies_read" || purpose === "replies_manage") {
      return { kind: "permission", copy: ERROR_COPY.repliesPermission(purpose === "replies_read" ? "read" : "manage"), action: "fail", reconnect, ref };
    }
    return { kind: "permission", copy: ERROR_COPY.permission(PERMISSION_DOING[purpose], account), action: "fail", reconnect, ref };
  }
  return { kind: "unknown", copy: fallbackCopy(purpose, channel), action: "fail", ref };
}
