/**
 * Fake Meta for Page and Instagram publishing, Live video, results and Threads (docs/specs/PAGE-IG-PUBLISHING-INSIGHTS-LIVE-THREADS-SPEC.md
 * 8.3; package SOC-03). A scripted fetch stub on the conventions of ./fake-meta.ts and ./fake-meta-promote.ts: it never calls the
 * network, keeps its own clock, records every call without its token, and can be mounted over HTTP by e2e/fake-meta-server.ts
 * (SOC-21) through `respond()`, a plain handler of (method, host, path, headers, body).
 *
 * Hosts:
 * - graph.facebook.com (and a loopback GRAPH_BASE_URL): F1-F14, I1-I11, L0-L9, R1-R6, the resumable upload session (F4, F5);
 * - graph-video.facebook.com: F6 (multipart, with the resumable handle);
 * - rupload.facebook.com: F8 (/video-upload/v26.0/{video-id}) and I6 (/ig-api-upload/v26.0/{container-id});
 * - graph.threads.com and graph.threads.net: T2-T17, R7-R9.
 * A loopback request whose path starts with /__host/<host>/ is answered as that host (the SOC-02 and SOC-05 e2e hooks).
 *
 * Behaviours (8.3):
 * - resumable offsets: an upload session and a rupload keep the bytes received, so a dropped upload resumes from the offset Meta
 *   reports (GET upload:{id}, GET {video-id}?fields=status);
 * - containers and videos change over time: IN_PROGRESS for `containerPolls` status reads and `containerMs` of the clock (after the
 *   bytes arrived, for resumable containers), then FINISHED; an Instagram container not published within 24 h becomes EXPIRED; a
 *   Reel's publishing phase completes after `videoPolls` status reads;
 * - live videos move with the ingest (startIngest / stopIngest), Go live, End and the scheduled start time, with viewers, comments
 *   and reactions;
 * - insights answers in Meta's shapes, from a deterministic generator or values a test sets, with empty sets and deprecated metrics;
 * - every 3.5 error (SOCIAL_ERRORS, by name), and network drops before the request is sent (refused: safe to retry) or after it was
 *   sent and applied (the unclear case), optionally after only part of an upload's bytes arrived.
 *
 * Tokens are checked like Meta does: Page edges and Instagram publishing need the Page token, the resumable session and Instagram
 * insights the user token (VERIFY V-R6: `verify.igInsightsPageToken` lets the Page token through), Threads calls a Threads token
 * with the right permission.
 *
 * VERIFY rows modelled with the documented shape (each switchable in `verify`): V-F2 album maximum, V-F4 Reel finish value and
 * post_id, V-I8 Instagram error codes, V-I10 alt_text on carousel children, V-L2 event_params form, V-L3 ingest health, V-L6 cancel by
 * status or DELETE, V-T5 reply field names, V-T9 the Threads app access token form. Also V-F3, V-F9, V-I4, V-L4, V-L7, V-L8, V-R5.
 */

export const SOCIAL_APP_ID = "1799000000000077";
export const SOCIAL_PAGE_ID = "104857600777";
export const SOCIAL_PAGE_TOKEN = `FAKE_SOCIAL_PAGE_TOKEN_${SOCIAL_PAGE_ID}`;
export const SOCIAL_USER_TOKEN = "FAKE_SOCIAL_USER_TOKEN";
export const SOCIAL_IG_ID = "17841400000000777";
export const THREADS_APP_ID = "1799000000000088";
export const THREADS_APP_SECRET = "fake-threads-app-secret";
export const THREADS_USER_ID = "26000000000000777";
export const THREADS_USERNAME = "sunrise_realty";
export const THREADS_TOKEN = "FAKE_THREADS_LONG_TOKEN";
export const THREADS_REDIRECT_URI = "https://wa.example.test/api/meta-connect/threads/callback";
/** Every Threads permission Edwyz asks for (T1). */
export const THREADS_ALL_SCOPES = ["threads_basic", "threads_content_publish", "threads_manage_insights", "threads_read_replies", "threads_manage_replies", "threads_delete"];
/** The hosts the fake answers (and loopback). */
export const SOCIAL_HOSTS = ["graph.facebook.com", "graph-video.facebook.com", "rupload.facebook.com", "graph.threads.com", "graph.threads.net"] as const;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** The earliest Threads insights timestamp Meta accepts (R7). */
const THREADS_INSIGHTS_EPOCH = 1712991600;

// ----- Errors (3.5) -----

export type SocialMetaError = { status: number; code: number; subcode?: number; message: string };

/** One answer for each 3.5 row, as Meta sends it. Codes marked VERIFY are modelled from the docs or third parties (V-I8, V-I9). */
export const SOCIAL_ERRORS = {
  token_expired: { status: 400, code: 190, subcode: 463, message: "Error validating access token: Session has expired on Friday, 30-Oct-26 10:00:00 PDT." },
  permission_10: { status: 403, code: 10, message: "(#10) Application does not have permission for this action" },
  permission_200: { status: 403, code: 200, message: "(#200) Permissions error" },
  permission_3: { status: 400, code: 3, message: "(#3) Application does not have the capability to make this API call." },
  live_followers: { status: 400, code: 200, subcode: 1363144, message: "(#200) Your Page needs at least 100 followers to go live." },
  live_account_age: { status: 400, code: 200, subcode: 1363120, message: "(#200) Your account must be at least 60 days old to go live." },
  rate_limit_4: { status: 400, code: 4, message: "(#4) Application request limit reached" },
  rate_limit_17: { status: 400, code: 17, message: "(#17) User request limit reached" },
  rate_limit_32: { status: 400, code: 32, message: "(#32) Page request limit reached" },
  rate_limit_613: { status: 400, code: 613, message: "(#613) Calls to this api have exceeded the rate limit." },
  rate_limit_80001: { status: 400, code: 80001, message: "(#80001) There have been too many calls to this Page account." },
  rate_limit_80002: { status: 400, code: 80002, message: "(#80002) There have been too many calls to this Instagram account." },
  spam_368: { status: 400, code: 368, message: "The action attempted has been deemed abusive or is otherwise disallowed" },
  live_time_1000: { status: 400, code: 1000, message: "Invalid time for an event" },
  /** VERIFY V-I8. */
  ig_quota: { status: 400, code: 9, subcode: 2207042, message: "Application request limit reached" },
  /** VERIFY V-I8. */
  ig_aspect: { status: 400, code: 36003, subcode: 2207009, message: "The aspect ratio is not supported." },
  /** VERIFY V-I8. */
  ig_image_size: { status: 400, code: 100, subcode: 2207004, message: "The image is too large to download. It should be less than 8 MiB." },
  /** VERIFY V-I8. */
  ig_image_format: { status: 400, code: 100, subcode: 2207005, message: "The image format is not supported." },
  /** VERIFY V-I8. */
  ig_video: { status: 400, code: 352, subcode: 2207026, message: "The video format is not supported." },
  /** VERIFY V-I9: subcode not confirmed; Meta's wording is what errors.ts recognises until SOC-20 records it. */
  ppa_facebook: { status: 403, code: 200, subcode: 1404006, message: "(#200) This Page requires Page Publishing Authorization before it can publish." },
  /** VERIFY V-I9. */
  ppa_instagram: { status: 403, code: 10, subcode: 2207050, message: "(#10) The linked Page must complete Page Publishing Authorization." },
  /** VERIFY V-I8. */
  download_facebook: { status: 400, code: 100, message: "(#100) Failed to download the file from the provided url" },
  /** VERIFY V-I8. */
  download_instagram: { status: 400, code: 9004, subcode: 2207052, message: "The media could not be fetched from this uri." },
  /** VERIFY: Threads names the error; the code and subcode are modelled. */
  threads_link_limit: { status: 400, code: 100, message: "THREADS_API__LINK_LIMIT_EXCEEDED: The post has too many links." },
  unknown_code: { status: 400, code: 2500, message: "An active access token must be used to query information about the current user." },
  server_error: { status: 500, code: 2, message: "An unexpected error has occurred. Please retry your request later." },
} satisfies Record<string, SocialMetaError>;

export type SocialErrorName = keyof typeof SOCIAL_ERRORS;
export const SOCIAL_ERROR_NAMES = Object.keys(SOCIAL_ERRORS) as SocialErrorName[];

/** Threads container error_message values (T11). */
export const THREADS_CONTAINER_ERRORS = [
  "FAILED_DOWNLOADING_VIDEO",
  "FAILED_PROCESSING_AUDIO",
  "FAILED_PROCESSING_VIDEO",
  "INVALID_ASPEC_RATIO",
  "INVALID_BIT_RATE",
  "INVALID_DURATION",
  "INVALID_FRAME_RATE",
  "INVALID_AUDIO_CHANNELS",
  "INVALID_AUDIO_CHANNEL_LAYOUT",
  "UNKNOWN",
] as const;
export type ThreadsContainerError = (typeof THREADS_CONTAINER_ERRORS)[number];

// ----- Types -----

export type SocialVerifyModel = {
  /** V-F2: the album maximum (10). */
  albumMax: number;
  /** V-F4: which Reel finish value Meta accepts ("finish", as the examples use). */
  reelsFinish: "finish" | "complete" | "either";
  /** V-F4: GET {video-id}?fields=post_id answers a post id. */
  reelPostId: boolean;
  /** V-F3: the resumable session accepts video/quicktime (false: MP4 only, the documented list). */
  resumableMov: boolean;
  /** V-F9: a Page Story can be deleted (false). */
  pageStoryDelete: boolean;
  /** V-I4: the Instagram rupload path with the version, without it, or both. */
  igRupload: "versioned" | "unversioned" | "either";
  /** V-I10: carousel child images accept alt_text (true). */
  igChildAltText: boolean;
  /** V-L2: event_params as an object ({start_time}), a bare timestamp, or both. */
  eventParams: "object" | "bare" | "either";
  /** V-L4: live_views is returned (true). */
  liveViews: boolean;
  /** V-L6: a scheduled live is canceled by status, by DELETE, or both. */
  liveCancel: "status" | "delete" | "either";
  /** V-L7: comments carry from{name} (false: needs pages_read_user_content). */
  commentNames: boolean;
  /** V-L8: reactions return a summary count (true). */
  reactionsSummary: boolean;
  /** V-R5: follower_count is accepted (true); false refuses it and accepts follows_and_unfollows with breakdown=follow_type. */
  igFollowerCount: boolean;
  /** V-R6: Instagram insights accept the Page token too (false: the user token only, as the references name). */
  igInsightsPageToken: boolean;
  /** V-T9: the Threads app access token form for debug_token. */
  threadsAppToken: "TH" | "plain" | "either";
};

const DEFAULT_VERIFY: SocialVerifyModel = {
  albumMax: 10,
  reelsFinish: "finish",
  reelPostId: true,
  resumableMov: false,
  pageStoryDelete: false,
  igRupload: "either",
  igChildAltText: true,
  eventParams: "either",
  liveViews: true,
  liveCancel: "either",
  commentNames: false,
  reactionsSummary: true,
  igFollowerCount: true,
  igInsightsPageToken: false,
  threadsAppToken: "either",
};

export type FakeMetaSocialOptions = {
  now?: Date;
  /** Refuse a token of the wrong kind for its edge (default true). */
  strictTokens?: boolean;
  /** Page followers (default 250). Under 100 refuses a live with 1363144. */
  followers?: number;
  /** Age of the Facebook account in days (default 400). Under 60 refuses a live with 1363120. */
  accountAgeDays?: number;
  igFollowers?: number;
  /** Instagram's quota_total (default 100; the guide also says 50, D23). */
  igQuotaTotal?: number;
  /** Status reads a container stays IN_PROGRESS (default 1). */
  containerPolls?: number;
  /** And at least this long on the fake clock after it became ready to process (default 0). */
  containerMs?: number;
  /** Status reads a Reel or video Story stays in its publishing phase after finish (default 1). */
  videoPolls?: number;
  verify?: Partial<SocialVerifyModel>;
};

export type SocialRequest = { method: string; host: string; path: string; headers?: Record<string, string>; body?: string | Uint8Array | null };
export type SocialResponse =
  | { kind: "response"; status: number; headers: Record<string, string>; body: string }
  /** The connection dropped: before the request was sent (nothing happened) or after it was sent and applied. */
  | { kind: "network"; sent: boolean }
  | { kind: "hang" };

export type TokenKind = "page" | "user" | "threads" | "app" | "unknown" | "none";

export type SocialCall = {
  host: string;
  method: string;
  /** Path without the version or query. */
  path: string;
  /** Query and body fields with secrets and tokens removed; binary bodies are counted, not kept. */
  params: Record<string, unknown>;
  headers: Record<string, string>;
  bytes: number;
  tokenKind: TokenKind;
  status: number;
  outcome: "answered" | "dropped_before_send" | "dropped_after_send" | "hang";
};

export type SocialInjection = {
  host?: string;
  method?: string;
  match?: RegExp;
  kind: "error" | "network" | "hang";
  /** kind "error": the Meta answer (a 3.5 row by name, or any error). */
  error?: SocialErrorName | SocialMetaError;
  /** kind "network": "before" = never sent (refused; safe to retry), "after" = sent and applied, then dropped (default). */
  when?: "before" | "after";
  /** kind "network", when "after", on an upload: only this many bytes reached Meta. */
  bytes?: number;
  /** How many matching requests it hits (default 1). */
  times?: number;
};

type Json = Record<string, unknown>;
type Result = { status: number; body: unknown };

type PagePost = { id: string; pageId: string; kind: "status" | "photo" | "album" | "video" | "reel" | "story"; message: string; link?: string; photoIds?: string[]; videoId?: string; createdAt: number; deleted: boolean; fromEdwyz: boolean };
type Photo = { id: string; pageId: string; url: string; published: boolean; postId?: string; createdAt: number };
type UploadSession = { id: string; fileName: string; fileLength: number; fileType: string; received: number; handle: string | null; used: boolean };
type Video = { id: string; pageId: string; kind: "video" | "reel" | "story"; size: number | null; received: number; finished: boolean; polls: number; description: string; title: string; postId: string | null; deleted: boolean; createdAt: number };
type IgContainer = {
  id: string;
  igId: string;
  mediaType: "IMAGE" | "VIDEO" | "REELS" | "STORIES" | "CAROUSEL";
  isChild: boolean;
  children: string[];
  resumable: boolean;
  size: number | null;
  received: number;
  readySince: number | null;
  polls: number;
  createdAt: number;
  forced: "ERROR" | "EXPIRED" | null;
  publishedId: string | null;
  caption: string;
  params: Json;
};
type IgMedia = { id: string; igId: string; mediaType: string; productType: "FEED" | "REELS" | "STORY"; caption: string; timestamp: number; shortcode: string; fromEdwyz: boolean; childOfAlbum: boolean };
type LiveStatus = "UNPUBLISHED" | "LIVE_NOW" | "SCHEDULED_UNPUBLISHED" | "SCHEDULED_LIVE" | "SCHEDULED_CANCELED" | "LIVE" | "VOD";
type Live = {
  id: string;
  pageId: string;
  status: LiveStatus;
  autoStart: boolean;
  title: string;
  description: string;
  startTime: number | null;
  ingest: boolean;
  viewers: number;
  comments: { id: string; message: string; createdAt: number; from: string | null }[];
  reactions: number;
  startedAt: number | null;
  endedAt: number | null;
  videoId: string;
  deleted: boolean;
};
type ThreadsContainer = {
  id: string;
  userId: string;
  mediaType: "TEXT" | "IMAGE" | "VIDEO" | "CAROUSEL";
  isChild: boolean;
  children: string[];
  text: string;
  replyTo: string | null;
  polls: number;
  createdAt: number;
  forced: { status: "ERROR" | "EXPIRED"; errorMessage?: string } | null;
  publishedId: string | null;
};
type ThreadsMedia = { id: string; userId: string; mediaType: string; text: string; timestamp: number; shortcode: string; deleted: boolean; replyTo: string | null; fromEdwyz: boolean };
type ThreadsReply = { id: string; mediaId: string; username: string; text: string; timestamp: number; hideStatus: "NOT_HUSHED" | "HIDDEN" | "UNHUSHED"; hasReplies: boolean };
type ThreadsToken = { token: string; userId: string; kind: "short" | "long"; issuedAt: number; expiresAt: number; scopes: string[] };

const VERSION = /^\/?v\d+(?:\.\d+)?\//;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const SECRET_KEYS = /^(access_token|client_secret|input_token|code|appsecret_proof|fb_exchange_token)$/i;
/** Deprecated metrics Meta refuses (R1, R4): a request naming one gets #100. */
const DEPRECATED_METRICS = new Set(["page_impressions", "page_impressions_unique", "page_fans", "post_impressions", "impressions"]);
const LIVE_STATUSES_ON_CREATE = new Set(["UNPUBLISHED", "LIVE_NOW", "SCHEDULED_UNPUBLISHED"]);
const REPLY_CONTROLS = new Set(["everyone", "accounts_you_follow", "mentioned_only", "followers_only"]);

const errorBody = (e: SocialMetaError): Result => ({
  status: e.status,
  body: { error: { message: e.message, type: "OAuthException", code: e.code, ...(e.subcode !== undefined ? { error_subcode: e.subcode } : {}), fbtrace_id: "fake-social-trace" } },
});
const bad = (message: string, subcode?: number): Result => errorBody({ status: 400, code: 100, message: `(#100) ${message}`, subcode });
const missing = (): Result => bad("Unsupported request. Object does not exist or cannot be loaded.", 33);
const ok = (body: unknown): Result => ({ status: 200, body });

function fieldsOf(params: Json): Set<string> | null {
  const raw = typeof params.fields === "string" ? params.fields : "";
  if (!raw) return null;
  const out = new Set<string>();
  let depth = 0;
  let current = "";
  for (const ch of raw) {
    if (ch === "{") depth++;
    if (ch === "}") depth--;
    if (ch === "," && depth === 0) {
      out.add(current.replace(/\{.*$/, "").trim());
      current = "";
    } else current += ch;
  }
  if (current.trim()) out.add(current.replace(/\{.*$/, "").trim());
  return out;
}

/** Only the requested top-level fields (and id), as Meta answers. */
function pick(obj: Json, params: Json): Json {
  const f = fieldsOf(params);
  if (!f) return obj;
  const out: Json = {};
  for (const [k, v] of Object.entries(obj)) if (k === "id" || f.has(k)) out[k] = v;
  return out;
}

const hashInt = (s: string) => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7);
const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dayStart = (key: string) => Date.parse(`${key}T00:00:00Z`);
const asTime = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v > 1e12 ? v : v * 1000;
  if (typeof v !== "string" || !v) return null;
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
};
const metaTime = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "+0000");
const str = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));
const truthy = (v: unknown) => v === true || v === "true" || v === "1";
const utf8 = new TextEncoder();
const decoder = new TextDecoder();

/** Threads' 500 characters: emoji count by their UTF-8 bytes. */
function threadsLength(text: string): number {
  let n = 0;
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) {
    n += /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u.test(segment) ? utf8.encode(segment).length : Array.from(segment).length;
  }
  return n;
}
const linkCount = (text: string) => new Set([...text.matchAll(/\b(?:https?:\/\/|www\.)[^\s<>"]+/gi)].map((m) => m[0].replace(/[.,!?;:)\]'"]+$/, "").toLowerCase())).size;

export function createFakeMetaSocial(opts: FakeMetaSocialOptions = {}) {
  let clock = (opts.now ?? new Date("2026-10-31T10:00:00+05:30")).getTime();
  const verify: SocialVerifyModel = { ...DEFAULT_VERIFY, ...opts.verify };
  const strictTokens = opts.strictTokens ?? true;
  let containerPolls = opts.containerPolls ?? 1;
  let containerMs = opts.containerMs ?? 0;
  let videoPolls = opts.videoPolls ?? 1;
  let igQuotaTotal = opts.igQuotaTotal ?? 100;
  let accountAgeDays = opts.accountAgeDays ?? 400;
  let ids = 0;
  // Meta ids are past 2^53, so they are made with BigInt (a Number would round neighbours onto the same id).
  const nextId = () => (17900000000000000n + BigInt(++ids)).toString();
  const shortcode = () => `C${(++ids).toString(36).toUpperCase()}fake`;
  const now = () => clock;

  const calls: SocialCall[] = [];
  const injections: (SocialInjection & { left: number })[] = [];
  const expiredTokens = new Set<string>();
  const revoked = new Set<string>();

  // ----- Seed -----
  const pages = new Map<string, { id: string; name: string; token: string; followers: number; igId: string | null }>();
  const igAccounts = new Map<string, { id: string; username: string; name: string; followers: number; pageId: string }>();
  pages.set(SOCIAL_PAGE_ID, { id: SOCIAL_PAGE_ID, name: "Sunrise Realty", token: SOCIAL_PAGE_TOKEN, followers: opts.followers ?? 250, igId: SOCIAL_IG_ID });
  igAccounts.set(SOCIAL_IG_ID, { id: SOCIAL_IG_ID, username: "sunrise_realty", name: "Sunrise Realty", followers: opts.igFollowers ?? 1200, pageId: SOCIAL_PAGE_ID });

  const posts = new Map<string, PagePost>();
  const photos = new Map<string, Photo>();
  const sessions = new Map<string, UploadSession>();
  const videos = new Map<string, Video>();
  const containers = new Map<string, IgContainer>();
  const igMedia = new Map<string, IgMedia>();
  const lives = new Map<string, Live>();
  const threadsContainers = new Map<string, ThreadsContainer>();
  const threadsMedia = new Map<string, ThreadsMedia>();
  const replies = new Map<string, ThreadsReply>();
  const threadsTokens = new Map<string, ThreadsToken>();
  const threadsCodes = new Map<string, { userId: string; redirectUri: string; scopes: string[]; expiresAt: number }>();
  const threadsUsers = new Map<string, { id: string; username: string; name: string; followers: number }>();
  const igPublishes: { igId: string; at: number }[] = [];
  const threadsUsage: { userId: string; kind: "post" | "reply" | "delete"; at: number }[] = [];
  const insightValues = new Map<string, Map<string, (day: string) => number | null>>();
  const emptyInsights = new Set<string>();
  const forcedContainers = new Map<string, "ERROR" | "EXPIRED">();
  let nextContainerOutcome: { status: "ERROR" | "EXPIRED"; errorMessage?: string } | null = null;

  threadsUsers.set(THREADS_USER_ID, { id: THREADS_USER_ID, username: THREADS_USERNAME, name: "Sunrise Realty", followers: 830 });
  threadsTokens.set(THREADS_TOKEN, { token: THREADS_TOKEN, userId: THREADS_USER_ID, kind: "long", issuedAt: clock - 2 * DAY, expiresAt: clock + 58 * DAY, scopes: [...THREADS_ALL_SCOPES] });

  // Two posts made outside Edwyz on each account, for the recent-posts lists (R3, I11, R9).
  for (let i = 1; i <= 2; i++) {
    const at = clock - i * DAY;
    const pid = `${SOCIAL_PAGE_ID}_${nextId()}`;
    posts.set(pid, { id: pid, pageId: SOCIAL_PAGE_ID, kind: "status", message: `Open house this weekend ${i}`, createdAt: at, deleted: false, fromEdwyz: false });
    const mid = nextId();
    igMedia.set(mid, { id: mid, igId: SOCIAL_IG_ID, mediaType: "IMAGE", productType: "FEED", caption: `New listing ${i}`, timestamp: at, shortcode: shortcode(), fromEdwyz: false, childOfAlbum: false });
    const tid = nextId();
    threadsMedia.set(tid, { id: tid, userId: THREADS_USER_ID, mediaType: "TEXT_POST", text: `Morning update ${i}`, timestamp: at, shortcode: shortcode(), deleted: false, replyTo: null, fromEdwyz: false });
  }

  // ----- Tokens -----

  function tokenKind(token: string | null): TokenKind {
    if (!token) return "none";
    if (token === SOCIAL_USER_TOKEN) return "user";
    if ([...pages.values()].some((p) => p.token === token)) return "page";
    if (threadsTokens.has(token)) return "threads";
    if (token.includes("|")) return "app";
    return "unknown";
  }

  function needs(kind: TokenKind | TokenKind[], token: string | null): Result | null {
    if (token && expiredTokens.has(token)) return errorBody(SOCIAL_ERRORS.token_expired);
    const want = Array.isArray(kind) ? kind : [kind];
    if (!token) return errorBody({ status: 400, code: 104, message: "An access token is required to request this resource." });
    if (strictTokens && !want.includes(tokenKind(token))) {
      return errorBody({ status: 400, code: 190, message: "Invalid OAuth access token - Cannot parse access token" });
    }
    return null;
  }

  /** A Facebook-side permission switched off by a test (revokePermission). */
  const denied = (permission: string, code: 10 | 200 = 200): Result | null =>
    revoked.has(permission) ? errorBody({ status: 403, code, message: code === 10 ? "(#10) Application does not have permission for this action" : `(#200) Requires ${permission} permission to manage the object` }) : null;

  function threadsAuth(token: string | null, ...scopes: string[]): { row: ThreadsToken } | { error: Result } {
    if (!token) return { error: errorBody({ status: 400, code: 190, message: "Invalid OAuth access token - Cannot parse access token" }) };
    const row = threadsTokens.get(token);
    if (!row || expiredTokens.has(token) || row.expiresAt <= clock) return { error: errorBody(SOCIAL_ERRORS.token_expired) };
    const missingScope = scopes.find((s) => !row.scopes.includes(s));
    if (missingScope) return { error: errorBody(SOCIAL_ERRORS.permission_10) };
    return { row };
  }

  // ----- Status over time -----

  function igStatus(c: IgContainer, read: boolean): string {
    const forced = c.forced ?? forcedContainers.get(c.id) ?? null;
    if (forced) return forced;
    if (c.publishedId) return "PUBLISHED";
    if (clock - c.createdAt > DAY) return "EXPIRED";
    if (c.mediaType === "CAROUSEL") {
      const kids = c.children.map((k) => containers.get(k)).filter((k): k is IgContainer => !!k);
      const states = kids.map((k) => igStatus(k, false));
      if (states.some((s) => s === "ERROR" || s === "EXPIRED")) return "ERROR";
      if (states.some((s) => s !== "FINISHED")) return "IN_PROGRESS";
    }
    if (c.resumable && (c.size === null || c.received < c.size)) return "IN_PROGRESS";
    if (c.readySince === null) c.readySince = clock;
    if (c.polls < containerPolls || clock - c.readySince < containerMs) {
      if (read) c.polls++;
      return "IN_PROGRESS";
    }
    return "FINISHED";
  }

  function threadsStatus(c: ThreadsContainer, read: boolean): { status: string; errorMessage?: string } {
    if (c.forced) return { status: c.forced.status, errorMessage: c.forced.errorMessage };
    if (c.publishedId) return { status: "PUBLISHED" };
    if (clock - c.createdAt > DAY) return { status: "EXPIRED" };
    if (c.mediaType === "CAROUSEL") {
      const kids = c.children.map((k) => threadsContainers.get(k)).filter((k): k is ThreadsContainer => !!k);
      if (kids.some((k) => threadsStatus(k, false).status === "ERROR")) return { status: "ERROR", errorMessage: "UNKNOWN" };
    }
    if (c.polls < containerPolls || clock - c.createdAt < containerMs) {
      if (read) c.polls++;
      return { status: "IN_PROGRESS" };
    }
    return { status: "FINISHED" };
  }

  function liveStatus(l: Live): LiveStatus {
    if (l.status === "SCHEDULED_UNPUBLISHED" || l.status === "SCHEDULED_LIVE") {
      const started = l.startTime !== null && clock >= l.startTime;
      if (l.ingest && started) {
        l.status = "LIVE";
        l.startedAt = l.startedAt ?? clock;
      } else l.status = l.ingest ? "SCHEDULED_LIVE" : "SCHEDULED_UNPUBLISHED";
    }
    // VERIFY V-L3: a LIVE_NOW setup reads as UNPUBLISHED until its stream arrives, then goes LIVE by itself.
    if (l.status === "LIVE_NOW" && l.ingest) {
      l.status = "LIVE";
      l.startedAt = l.startedAt ?? clock;
    }
    return l.status;
  }

  // ----- Quotas -----

  const recent = (rows: { at: number }[]) => rows.filter((r) => clock - r.at < DAY).length;
  const igUsage = (igId: string) => recent(igPublishes.filter((p) => p.igId === igId));
  const threadsUsed = (userId: string, kind: "post" | "reply" | "delete") => recent(threadsUsage.filter((u) => u.userId === userId && u.kind === kind));

  // ----- Insights -----

  function metricValue(objectId: string, metric: string, day: string): number | null {
    const set = insightValues.get(objectId)?.get(metric);
    if (set) return set(day);
    return (hashInt(`${objectId}|${metric}|${day}`) % 500) + 10;
  }
  function dailyValues(objectId: string, metric: string, since: number, until: number) {
    const values: { value: number; end_time: string }[] = [];
    for (let t = dayStart(dayKey(since)); t < until; t += DAY) {
      const v = metricValue(objectId, metric, dayKey(t));
      if (v !== null) values.push({ value: v, end_time: metaTime(t + DAY + 7 * HOUR) });
    }
    return values;
  }
  function insightRange(params: Json, maxDays: number): { since: number; until: number } | Result {
    const since = asTime(params.since) ?? clock - DAY;
    const until = asTime(params.until) ?? clock;
    if (until < since) return bad("The since parameter must be before until.");
    if (until - since > maxDays * DAY) return bad(`Only ${maxDays} days of insights can be viewed at one time.`);
    return { since, until };
  }
  const metricsOf = (params: Json) => str(params.metric).split(",").map((m) => m.trim()).filter(Boolean);
  function deprecated(metrics: string[]): Result | null {
    const old = metrics.find((m) => DEPRECATED_METRICS.has(m));
    return old ? bad(`The value must be a valid insights metric: ${old} is deprecated.`) : null;
  }

  function pageInsights(pageId: string, params: Json): Result {
    const metrics = metricsOf(params);
    const dep = deprecated(metrics);
    if (dep) return dep;
    const range = insightRange(params, 93);
    if ("status" in range) return range;
    // Without read_insights Meta answers an empty dataset (R1).
    if (revoked.has("read_insights") || emptyInsights.has(pageId)) return ok({ data: [] });
    return ok({ data: metrics.map((m) => ({ name: m, period: str(params.period) || "day", values: dailyValues(pageId, m, range.since, range.until), title: m, id: `${pageId}/insights/${m}/day` })) });
  }

  function lifetime(objectId: string, metrics: string[]) {
    return metrics.flatMap((m) => {
      const v = metricValue(objectId, m, "lifetime");
      if (v === null) return [];
      const value = m === "post_reactions_by_type_total" ? { like: v, love: Math.floor(v / 4) } : v;
      return [{ name: m, period: "lifetime", values: [{ value }], title: m, id: `${objectId}/insights/${m}/lifetime` }];
    });
  }

  function igUserInsights(igId: string, params: Json, token: string | null): Result {
    const t = needs(verify.igInsightsPageToken ? ["user", "page"] : "user", token);
    if (t) return t;
    const d = denied("instagram_manage_insights", 10);
    if (d) return d;
    const metrics = metricsOf(params);
    const dep = deprecated(metrics);
    if (dep) return dep;
    const followerMetric = metrics.includes("follower_count");
    if (params.breakdown !== undefined && !(metrics.length === 1 && metrics[0] === "follows_and_unfollows" && params.breakdown === "follow_type")) {
      return errorBody({ status: 500, code: 1, message: "An unknown error has occurred." });
    }
    if (followerMetric && !verify.igFollowerCount) return bad("(follower_count) is not a valid metric. Use follows_and_unfollows.");
    const range = insightRange(params, 30);
    if ("status" in range) return range;
    if (emptyInsights.has(igId)) return ok({ data: [] });
    if (followerMetric && (igAccounts.get(igId)?.followers ?? 0) < 100) return bad("follower_count is only available for accounts with 100 or more followers.");
    if (metrics.length === 1 && metrics[0] === "follows_and_unfollows") {
      const follows = metricValue(igId, "follows", dayKey(range.since)) ?? 0;
      const unfollows = metricValue(igId, "unfollows", dayKey(range.since)) ?? 0;
      return ok({ data: [{ name: "follows_and_unfollows", period: "day", total_value: { value: follows - unfollows, breakdowns: [{ dimension_keys: ["follow_type"], results: [{ dimension_values: ["FOLLOWER"], value: follows }, { dimension_values: ["NON_FOLLOWER"], value: unfollows }] }] } }] });
    }
    if (params.metric_type === "total_value") {
      return ok({
        data: metrics.flatMap((m) => {
          const values = dailyValues(igId, m, range.since, range.until);
          if (values.length === 0) return [];
          return [{ name: m, period: "day", title: m, total_value: { value: values.reduce((s, v) => s + v.value, 0) }, id: `${igId}/insights/${m}/day` }];
        }),
      });
    }
    return ok({ data: metrics.map((m) => ({ name: m, period: "day", values: dailyValues(igId, m, range.since, range.until), title: m, id: `${igId}/insights/${m}/day` })) });
  }

  function igMediaInsights(m: IgMedia, params: Json, token: string | null): Result {
    const t = needs(verify.igInsightsPageToken ? ["user", "page"] : "user", token);
    if (t) return t;
    const d = denied("instagram_manage_insights", 10);
    if (d) return d;
    if (m.childOfAlbum) return bad("Media inside an album has no insights.");
    const metrics = metricsOf(params);
    if (m.productType === "STORY") {
      if (clock - m.timestamp > DAY) return ok({ data: [] });
      const views = metricValue(m.id, "views", "lifetime") ?? 0;
      // Stories under 5 views answer (#10) (R6).
      if (views < 5) return errorBody({ status: 400, code: 10, message: "(#10) Not enough viewers for the media to show insights" });
    }
    if (emptyInsights.has(m.id)) return ok({ data: [] });
    return ok({ data: lifetime(m.id, metrics) });
  }

  function threadsUserInsights(userId: string, params: Json, row: ThreadsToken): Result {
    if (!row.scopes.includes("threads_manage_insights")) return errorBody(SOCIAL_ERRORS.permission_10);
    const metrics = metricsOf(params);
    if (metrics.includes("followers_count") && (params.since !== undefined || params.until !== undefined)) return bad("followers_count does not support since and until.");
    const since = asTime(params.since) ?? clock - DAY;
    const until = asTime(params.until) ?? clock;
    if (since < THREADS_INSIGHTS_EPOCH * 1000) return bad("since must be on or after 1712991600.");
    if (emptyInsights.has(userId)) return ok({ data: [] });
    return ok({
      data: metrics.map((m) => {
        if (m === "views") return { name: m, period: "day", values: dailyValues(userId, m, since, until), title: m, id: `${userId}/insights/${m}/day` };
        if (m === "followers_count") return { name: m, period: "day", total_value: { value: threadsUsers.get(userId)?.followers ?? 0 }, title: m, id: `${userId}/insights/${m}/day` };
        const total = dailyValues(userId, m, since, until).reduce((s, v) => s + v.value, 0);
        return { name: m, period: "day", total_value: { value: total }, title: m, id: `${userId}/insights/${m}/day` };
      }),
    });
  }

  // ----- graph.facebook.com -----

  function pageOf(id: string) {
    return pages.get(id);
  }

  function createPost(pageId: string, kind: PagePost["kind"], message: string, extra: Partial<PagePost> = {}): PagePost {
    const id = `${pageId}_${nextId()}`;
    const p: PagePost = { id, pageId, kind, message, createdAt: clock, deleted: false, fromEdwyz: true, ...extra };
    posts.set(id, p);
    return p;
  }

  function pageWrite(pageId: string, edge: string, params: Json, token: string | null): Result {
    const t = needs("page", token);
    if (t) return t;
    const d = denied("pages_manage_posts");
    if (d) return d;
    if (edge === "feed") {
      const media = params.attached_media;
      const list = typeof media === "string" ? (JSON.parse(media) as unknown) : media;
      if (Array.isArray(list) && list.length > 0) {
        if (list.length > verify.albumMax) return bad(`attached_media takes at most ${verify.albumMax} photos.`);
        const photoIds = list.map((x) => str((x as Json)?.media_fbid));
        for (const pid of photoIds) {
          const ph = photos.get(pid);
          if (!ph || ph.pageId !== pageId || ph.published) return bad(`Invalid media_fbid ${pid}.`);
        }
        const p = createPost(pageId, "album", str(params.message), { photoIds });
        for (const pid of photoIds) photos.get(pid)!.postId = p.id;
        return ok({ id: p.id });
      }
      if (!str(params.message) && !str(params.link)) return bad("The post is empty.");
      const p = createPost(pageId, "status", str(params.message), params.link ? { link: str(params.link) } : {});
      return ok({ id: p.id });
    }
    if (edge === "photos") {
      if (!/^https?:\/\//.test(str(params.url))) return bad("url should represent a valid URL");
      const id = nextId();
      const published = params.published === undefined ? true : truthy(params.published);
      photos.set(id, { id, pageId, url: str(params.url), published, createdAt: clock });
      if (!published) return ok({ id });
      const p = createPost(pageId, "photo", str(params.caption), { photoIds: [id] });
      photos.get(id)!.postId = p.id;
      return ok({ id, post_id: p.id });
    }
    if (edge === "videos") {
      // F6b: Meta fetches the signed URL.
      if (!/^https?:\/\//.test(str(params.file_url))) return bad("file_url should represent a valid URL");
      const v = newVideo(pageId, "video", null);
      v.received = 0;
      v.finished = true;
      v.description = str(params.description);
      v.title = str(params.title);
      v.postId = createPost(pageId, "video", v.description, { videoId: v.id }).id;
      return ok({ id: v.id });
    }
    if (edge === "video_reels" || edge === "video_stories") {
      const kind = edge === "video_reels" ? "reel" : "story";
      const phase = str(params.upload_phase);
      if (phase === "start") {
        const v = newVideo(pageId, kind, null);
        return ok({ video_id: v.id, upload_url: `https://rupload.facebook.com/video-upload/v26.0/${v.id}` });
      }
      const accepted = kind === "story" ? phase === "finish" : verify.reelsFinish === "either" ? phase === "finish" || phase === "complete" : phase === verify.reelsFinish;
      if (!accepted) return bad("upload_phase must be one of start, transfer, finish.");
      const v = videos.get(str(params.video_id));
      if (!v || v.pageId !== pageId || v.kind !== kind) return bad("Invalid video_id.");
      if (v.size === null || v.received < v.size) return bad("The video upload is not complete.", 1363019);
      if (v.finished) return bad("This video was already published.");
      if (kind === "reel" && str(params.video_state) !== "PUBLISHED") return bad("video_state must be PUBLISHED.");
      v.finished = true;
      v.description = str(params.description);
      v.postId = createPost(pageId, kind, v.description, { videoId: v.id }).id;
      return ok(kind === "story" ? { success: true, post_id: v.postId } : { success: true });
    }
    if (edge === "photo_stories") {
      const ph = photos.get(str(params.photo_id));
      if (!ph || ph.pageId !== pageId || ph.published) return bad("Invalid photo_id.");
      const p = createPost(pageId, "story", "", { photoIds: [ph.id] });
      ph.postId = p.id;
      return ok({ success: true, post_id: p.id });
    }
    if (edge === "live_videos") return createLive(pageId, params);
    return bad("Unsupported post request.");
  }

  function newVideo(pageId: string, kind: Video["kind"], size: number | null): Video {
    const v: Video = { id: nextId(), pageId, kind, size, received: 0, finished: false, polls: 0, description: "", title: "", postId: null, deleted: false, createdAt: clock };
    videos.set(v.id, v);
    return v;
  }

  function videoStatus(v: Video, read: boolean): Json {
    const uploaded = v.size !== null && v.received >= v.size;
    let publishing = "not_started";
    if (v.finished) {
      if (v.polls < videoPolls) {
        if (read) v.polls++;
        publishing = "in_progress";
      } else publishing = "complete";
    }
    return {
      video_status: publishing === "complete" ? "ready" : uploaded ? "processing" : "upload_in_progress",
      uploading_phase: { status: uploaded ? "complete" : "in_progress", bytes_transfered: v.received },
      processing_phase: { status: uploaded ? "complete" : "not_started" },
      publishing_phase: { status: publishing, ...(publishing === "complete" ? { publish_status: "published", publish_time: metaTime(clock) } : {}) },
    };
  }

  function createLive(pageId: string, params: Json): Result {
    const d = denied("publish_video");
    if (d) return d;
    const page = pageOf(pageId)!;
    if (page.followers < 100) return errorBody(SOCIAL_ERRORS.live_followers);
    if (accountAgeDays < 60) return errorBody(SOCIAL_ERRORS.live_account_age);
    const status = str(params.status) || "UNPUBLISHED";
    if (!LIVE_STATUSES_ON_CREATE.has(status)) return bad("status must be UNPUBLISHED, LIVE_NOW or SCHEDULED_UNPUBLISHED.");
    if (str(params.title).length > 254) return bad("title: Maximum 254 characters.");
    let startTime: number | null = null;
    if (status === "SCHEDULED_UNPUBLISHED") {
      let ep: unknown = params.event_params;
      if (typeof ep === "string") {
        try {
          ep = JSON.parse(ep);
        } catch {
          // a bare timestamp
        }
      }
      const isObject = typeof ep === "object" && ep !== null;
      if ((isObject && verify.eventParams === "bare") || (!isObject && verify.eventParams === "object")) return bad("Invalid parameter: event_params.");
      startTime = asTime(isObject ? (ep as Json).start_time : ep);
      if (startTime === null || startTime <= clock || startTime > clock + 7 * DAY) return errorBody(SOCIAL_ERRORS.live_time_1000);
    }
    const id = nextId();
    const l: Live = {
      id,
      pageId,
      status: status === "LIVE_NOW" ? "LIVE_NOW" : (status as LiveStatus),
      autoStart: status === "LIVE_NOW",
      title: str(params.title),
      description: str(params.description),
      startTime,
      ingest: false,
      viewers: 0,
      comments: [],
      reactions: 0,
      startedAt: null,
      endedAt: null,
      videoId: nextId(),
      deleted: false,
    };
    lives.set(id, l);
    const key = `FB-${id}-0-AbFakeStreamKey${id.slice(-4)}`;
    return ok({
      id,
      stream_url: `rtmp://live-api-s.facebook.com:80/rtmp/${key}`,
      secure_stream_url: `rtmps://live-api-s.facebook.com:443/rtmp/${key}`,
      stream_secondary_urls: [],
      secure_stream_secondary_urls: [],
      dash_ingest_url: `https://live-api-s.facebook.com/dash/${key}`,
    });
  }

  function liveRead(l: Live, params: Json): Result {
    const status = liveStatus(l);
    const shown = l.status === "LIVE_NOW" ? "UNPUBLISHED" : status;
    // VERIFY V-L3: "receiving" is a master ingest stream with video_bitrate > 0.
    const health = l.ingest ? { video_bitrate: 2_500_000, audio_bitrate: 128_000, video_framerate: 30, video_width: 1280, video_height: 720 } : { video_bitrate: 0, audio_bitrate: 0, video_framerate: 0 };
    return ok(
      pick(
        {
          id: l.id,
          status: shown,
          title: l.title,
          description: l.description,
          ingest_streams: [{ stream_id: "0", is_master: true, stream_health: health }],
          ...(verify.liveViews && (status === "LIVE" || status === "VOD") ? { live_views: status === "LIVE" ? l.viewers : 0 } : {}),
          permalink_url: `/${l.pageId}/videos/${l.videoId}/`,
          video: { id: l.videoId },
          ...(l.startedAt ? { broadcast_start_time: metaTime(l.startedAt) } : {}),
          ...(l.startTime ? { planned_start_time: metaTime(l.startTime) } : {}),
          errors: [],
        },
        params,
      ),
    );
  }

  function liveWrite(l: Live, params: Json): Result {
    const d = denied("publish_video");
    if (d) return d;
    const status = liveStatus(l);
    if (truthy(params.end_live_video)) {
      if (status !== "LIVE") return bad("Only a live broadcast can be ended.");
      l.status = "VOD";
      l.ingest = false;
      l.endedAt = clock;
      return ok({ id: l.id });
    }
    if (params.status === "LIVE_NOW") {
      // L4: "The broadcast goes live if the stream is active."
      if (!l.ingest) return bad("The live video can't start because no stream is being received.", 1969070);
      if (status === "VOD" || status === "SCHEDULED_CANCELED") return bad("This live video has ended.");
      l.status = "LIVE";
      l.startedAt = clock;
      return ok({ id: l.id });
    }
    if (params.status === "SCHEDULED_CANCELED") {
      if (verify.liveCancel === "delete") return bad("Invalid parameter: status.");
      if (status === "LIVE" || status === "VOD") return bad("A live video that has started can't be canceled.");
      l.status = "SCHEDULED_CANCELED";
      return ok({ id: l.id });
    }
    if (status === "VOD" || status === "SCHEDULED_CANCELED") return bad("This live video can't be changed anymore.");
    if (params.title !== undefined) {
      if (str(params.title).length > 254) return bad("title: Maximum 254 characters.");
      l.title = str(params.title);
    }
    if (params.description !== undefined) l.description = str(params.description);
    if (params.event_params !== undefined) {
      let ep: unknown = params.event_params;
      if (typeof ep === "string") {
        try {
          ep = JSON.parse(ep);
        } catch {
          // bare
        }
      }
      const t = asTime(typeof ep === "object" && ep !== null ? (ep as Json).start_time : ep);
      if (t === null || t <= clock || t > clock + 7 * DAY) return errorBody(SOCIAL_ERRORS.live_time_1000);
      l.startTime = t;
    }
    return ok({ id: l.id });
  }

  function igCreate(igId: string, params: Json, token: string | null): Result {
    const t = needs("page", token);
    if (t) return t;
    const d = denied("instagram_content_publish", 10);
    if (d) return d;
    const type = str(params.media_type).toUpperCase() || "IMAGE";
    const isChild = truthy(params.is_carousel_item);
    const resumable = str(params.upload_type) === "resumable";
    const c: IgContainer = {
      id: nextId(),
      igId,
      mediaType: (["IMAGE", "VIDEO", "REELS", "STORIES", "CAROUSEL"].includes(type) ? type : "IMAGE") as IgContainer["mediaType"],
      isChild,
      children: [],
      resumable,
      size: null,
      received: 0,
      readySince: null,
      polls: 0,
      createdAt: clock,
      forced: null,
      publishedId: null,
      caption: str(params.caption),
      params: { ...params },
    };
    if (c.mediaType === "CAROUSEL") {
      if (isChild) return bad("A carousel can't be a carousel item.");
      const kids = str(params.children).split(",").filter(Boolean);
      if (kids.length < 2 || kids.length > 20) return bad("Carousels take 2 to 20 items.", 2207028);
      for (const k of kids) {
        const child = containers.get(k);
        if (!child || !child.isChild || child.igId !== igId) return bad(`Invalid child ${k}.`, 2207028);
        if (child.mediaType === "REELS") return bad("Reels can't be carousel items.", 2207028);
      }
      c.children = kids;
    } else if (c.mediaType === "IMAGE" || (c.mediaType === "STORIES" && !resumable)) {
      if (!/^https?:\/\//.test(str(params.image_url))) return bad("image_url should represent a valid URL");
      if (isChild && params.alt_text !== undefined && !verify.igChildAltText) return bad("alt_text is not supported on carousel items.");
      if (params.alt_text !== undefined && str(params.alt_text).length > 1000) return bad("alt_text: at most 1000 characters.");
    } else if (!resumable && !/^https?:\/\//.test(str(params.video_url))) {
      return bad("video_url or upload_type=resumable is required.");
    }
    if (c.mediaType === "REELS" && isChild) return bad("Reels can't be carousel items.", 2207028);
    if (nextContainerOutcome) {
      c.forced = nextContainerOutcome.status;
      nextContainerOutcome = null;
    }
    containers.set(c.id, c);
    return ok(resumable ? { id: c.id, uri: `https://rupload.facebook.com/ig-api-upload/v26.0/${c.id}` } : { id: c.id });
  }

  function igPublish(igId: string, params: Json, token: string | null): Result {
    const t = needs("page", token);
    if (t) return t;
    const d = denied("instagram_content_publish", 10);
    if (d) return d;
    const c = containers.get(str(params.creation_id));
    if (!c || c.igId !== igId || c.isChild) return bad("Invalid creation_id.");
    if (c.publishedId) return bad("This media has already been published.", 2207008);
    const s = igStatus(c, false);
    if (s !== "FINISHED") return errorBody({ status: 400, code: 9007, subcode: 2207027, message: "Media ID is not available. The media is not ready for publishing, please wait for a moment." });
    if (igUsage(igId) >= igQuotaTotal) return errorBody(SOCIAL_ERRORS.ig_quota);
    const productType = c.mediaType === "REELS" ? "REELS" : c.mediaType === "STORIES" ? "STORY" : "FEED";
    const m: IgMedia = { id: nextId(), igId, mediaType: c.mediaType === "CAROUSEL" ? "CAROUSEL_ALBUM" : c.mediaType === "REELS" ? "VIDEO" : c.mediaType === "STORIES" ? (c.resumable ? "VIDEO" : "IMAGE") : c.mediaType, productType, caption: c.caption, timestamp: clock, shortcode: shortcode(), fromEdwyz: true, childOfAlbum: false };
    igMedia.set(m.id, m);
    c.publishedId = m.id;
    igPublishes.push({ igId, at: clock });
    return ok({ id: m.id });
  }

  function graph(method: string, path: string, params: Json, headers: Record<string, string>, bytes: Uint8Array | null, token: string | null): Result {
    const parts = path.split("/").filter(Boolean);
    const [head, edge, ...rest] = parts;
    if (!head) return missing();
    if (rest.length > 0) return missing();

    // F4 / F5: the resumable upload session (user token).
    if (edge === "uploads" && method === "POST" && /^\d+$/.test(head)) {
      const t = needs("user", token);
      if (t) return t;
      const fileType = str(params.file_type);
      if (fileType !== "video/mp4" && !(verify.resumableMov && fileType === "video/quicktime")) return bad("file_type must be video/mp4.");
      const fileLength = Number(params.file_length);
      if (!Number.isSafeInteger(fileLength) || fileLength <= 0) return bad("file_length must be a positive number.");
      const id = nextId();
      sessions.set(id, { id, fileName: str(params.file_name), fileLength, fileType, received: 0, handle: null, used: false });
      return ok({ id: `upload:${id}` });
    }
    if (head.startsWith("upload:") && !edge) {
      const t = needs("user", token);
      if (t) return t;
      const s = sessions.get(head.slice("upload:".length));
      if (!s) return missing();
      if (method === "GET") return ok({ id: head, file_offset: s.received });
      if (method !== "POST") return bad("Unsupported request.");
      const offset = Number(headers.file_offset ?? 0);
      if (offset !== s.received) return bad(`file_offset ${offset} does not match the bytes received (${s.received}).`);
      const chunk = bytes ?? new Uint8Array(0);
      s.received = Math.min(s.fileLength, s.received + chunk.length);
      if (s.received < s.fileLength) return ok({ id: head, file_offset: s.received });
      s.handle = s.handle ?? `4::fake-handle-${s.id}`;
      return ok({ h: s.handle });
    }

    const page = pageOf(head);
    const ig = igAccounts.get(head);
    if (page) {
      if (method === "POST" && edge) return pageWrite(head, edge, params, token);
      const t = needs("page", token);
      if (t) return t;
      if (method === "GET" && !edge) return ok(pick({ id: page.id, name: page.name, followers_count: page.followers, link: `https://www.facebook.com/${page.id}` }, params));
      if (method === "GET" && edge === "insights") return pageInsights(head, params);
      if (method === "GET" && edge === "published_posts") {
        const d = denied("pages_read_engagement", 10);
        if (d) return d;
        const limit = Math.min(Number(params.limit ?? 25) || 25, 100);
        const data = [...posts.values()]
          .filter((p) => p.pageId === head && !p.deleted && p.kind !== "story")
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(0, limit)
          .map((p) => pick({ id: p.id, message: p.message, created_time: metaTime(p.createdAt), permalink_url: postPermalink(p), status_type: p.kind === "photo" || p.kind === "album" ? "added_photos" : p.kind === "video" || p.kind === "reel" ? "added_video" : "mobile_status_update" }, params));
        return ok({ data });
      }
      if (method === "GET" && edge === "live_videos") return ok({ data: [...lives.values()].filter((l) => l.pageId === head && !l.deleted).map((l) => ({ id: l.id, status: liveStatus(l), title: l.title })) });
      return bad("Unsupported request.");
    }
    if (ig) {
      if (method === "GET" && !edge) {
        const t = needs(["page", "user"], token);
        if (t) return t;
        return ok(pick({ id: ig.id, username: ig.username, name: ig.name, followers_count: ig.followers, media_count: [...igMedia.values()].filter((m) => m.igId === ig.id).length }, params));
      }
      if (method === "GET" && edge === "content_publishing_limit") {
        const t = needs(["page", "user"], token);
        if (t) return t;
        return ok({ data: [{ quota_usage: igUsage(head), config: { quota_total: igQuotaTotal, quota_duration: 86400 } }] });
      }
      if (method === "POST" && edge === "media") return igCreate(head, params, token);
      if (method === "POST" && edge === "media_publish") return igPublish(head, params, token);
      if (method === "GET" && edge === "media") {
        const t = needs(["page", "user"], token);
        if (t) return t;
        const limit = Math.min(Number(params.limit ?? 25) || 25, 100);
        const data = [...igMedia.values()]
          .filter((m) => m.igId === head && !m.childOfAlbum && m.productType !== "STORY")
          .sort((a, b) => b.timestamp - a.timestamp)
          .slice(0, limit)
          .map((m) => pick({ id: m.id, caption: m.caption, media_type: m.mediaType, media_product_type: m.productType, timestamp: metaTime(m.timestamp), permalink: `https://www.instagram.com/p/${m.shortcode}/` }, params));
        return ok({ data });
      }
      if (method === "GET" && edge === "insights") return igUserInsights(head, params, token);
      return bad("Unsupported request.");
    }

    // Objects by id.
    const post = posts.get(head);
    const video = videos.get(head);
    const container = containers.get(head);
    const media = igMedia.get(head);
    const live = lives.get(head);
    if (live && !live.deleted) {
      const t = needs("page", token);
      if (t) return t;
      if (method === "GET" && !edge) {
        const d = denied("publish_video");
        if (d) return d;
        return liveRead(live, params);
      }
      if (method === "POST" && !edge) return liveWrite(live, params);
      if (method === "DELETE" && !edge) {
        if (verify.liveCancel === "status") return bad("Unsupported delete request.");
        const s = liveStatus(live);
        if (s === "LIVE") return bad("A live video that has started can't be deleted.");
        live.deleted = true;
        live.status = "SCHEDULED_CANCELED";
        return ok({ success: true });
      }
      if (method === "GET" && edge === "comments") {
        const limit = Math.min(Number(params.limit ?? 25) || 25, 100);
        const data = [...live.comments]
          .sort((a, b) => (params.order === "reverse_chronological" ? b.createdAt - a.createdAt : a.createdAt - b.createdAt))
          .slice(0, limit)
          .map((c) => ({ id: c.id, message: c.message, created_time: metaTime(c.createdAt), ...(verify.commentNames && c.from ? { from: { name: c.from, id: nextId() } } : {}) }));
        return ok({ data });
      }
      if (method === "GET" && edge === "reactions") return ok(verify.reactionsSummary ? { data: [], summary: { total_count: live.reactions } } : { data: [] });
      return bad("Unsupported request.");
    }
    if (post && !post.deleted) {
      const t = needs("page", token);
      if (t) return t;
      if (method === "GET" && !edge) {
        const d = denied("pages_read_engagement", 10);
        if (d) return d;
        return ok(pick({ id: post.id, message: post.message, created_time: metaTime(post.createdAt), permalink_url: postPermalink(post) }, params));
      }
      if (method === "GET" && edge === "insights") {
        const metrics = metricsOf(params);
        const dep = deprecated(metrics);
        if (dep) return dep;
        if (revoked.has("read_insights") || emptyInsights.has(post.id)) return ok({ data: [] });
        return ok({ data: lifetime(post.id, metrics) });
      }
      if (method === "DELETE" && !edge) {
        const d = denied("pages_manage_posts");
        if (d) return d;
        if (post.kind === "story" && !verify.pageStoryDelete) return bad("Stories can't be deleted through the API.");
        post.deleted = true;
        return ok({ success: true });
      }
      return bad("Unsupported request.");
    }
    if (video && !video.deleted) {
      const t = needs("page", token);
      if (t) return t;
      if (method === "GET" && !edge) {
        const body: Json = { id: video.id, status: videoStatus(video, fieldsOf(params)?.has("status") ?? false), description: video.description, title: video.title };
        if (video.finished) body.permalink_url = video.kind === "reel" ? `/reel/${video.id}/` : `/${video.pageId}/videos/${video.id}/`;
        if (video.finished && video.postId && verify.reelPostId) body.post_id = video.postId;
        return ok(pick(body, params));
      }
      if (method === "GET" && edge === "insights") {
        if (revoked.has("read_insights") || emptyInsights.has(video.id)) return ok({ data: [] });
        return ok({ data: lifetime(video.id, metricsOf(params)) });
      }
      if (method === "DELETE" && !edge) {
        const d = denied("pages_manage_posts");
        if (d) return d;
        if (video.kind === "story" && !verify.pageStoryDelete) return bad("Stories can't be deleted through the API.");
        video.deleted = true;
        if (video.postId) posts.get(video.postId)!.deleted = true;
        return ok({ success: true });
      }
      return bad("Unsupported request.");
    }
    if (container) {
      const t = needs(["page", "user"], token);
      if (t) return t;
      if (method === "GET" && !edge) return ok(pick({ id: container.id, status_code: igStatus(container, true), status: igStatus(container, false) === "ERROR" ? "Error: Media upload has failed with error code 2207026" : "" }, params));
      return bad("Unsupported request.");
    }
    if (media) {
      if (method === "GET" && !edge) {
        const t = needs(["page", "user"], token);
        if (t) return t;
        return ok(pick({ id: media.id, permalink: `https://www.instagram.com/p/${media.shortcode}/`, media_product_type: media.productType, media_type: media.mediaType, timestamp: metaTime(media.timestamp), caption: media.caption }, params));
      }
      if (method === "GET" && edge === "insights") return igMediaInsights(media, params, token);
      return bad("Unsupported request.");
    }
    return missing();
  }

  function postPermalink(p: PagePost): string {
    const n = p.id.split("_")[1];
    if (p.kind === "reel" && p.videoId) return `https://www.facebook.com/reel/${p.videoId}`;
    if (p.kind === "video" && p.videoId) return `https://www.facebook.com/${p.pageId}/videos/${p.videoId}`;
    return `https://www.facebook.com/${p.pageId}/posts/${n}`;
  }

  // ----- graph-video.facebook.com (F6) -----

  function graphVideo(method: string, path: string, params: Json, token: string | null): Result {
    const parts = path.split("/").filter(Boolean);
    if (method !== "POST" || parts.length !== 2 || parts[1] !== "videos" || !pageOf(parts[0])) return missing();
    const t = needs("page", token);
    if (t) return t;
    const d = denied("pages_manage_posts");
    if (d) return d;
    const handle = str(params.fbuploader_video_file_chunk);
    const s = [...sessions.values()].find((x) => x.handle === handle);
    if (!s) return bad("Invalid fbuploader_video_file_chunk.");
    if (s.used) return bad("This upload was already used.");
    s.used = true;
    const v = newVideo(parts[0], "video", s.fileLength);
    v.received = s.fileLength;
    v.finished = true;
    v.title = str(params.title);
    v.description = str(params.description);
    v.postId = createPost(parts[0], "video", v.description, { videoId: v.id }).id;
    return ok({ id: v.id });
  }

  // ----- rupload.facebook.com (F8, I6) -----

  function rupload(method: string, path: string, headers: Record<string, string>, bytes: Uint8Array | null, token: string | null): Result {
    if (method !== "POST") return missing();
    const m = /^\/?(video-upload|ig-api-upload)\/(?:(v\d+(?:\.\d+)?)\/)?(\d+)\/?$/.exec(path);
    if (!m) return missing();
    const [, kind, version, id] = m;
    const chunk = bytes ?? new Uint8Array(0);
    const offset = Number(headers.offset ?? 0);
    const fileSize = Number(headers.file_size ?? NaN);
    if (!Number.isSafeInteger(fileSize) || fileSize <= 0) return bad("file_size header is required.");
    if (kind === "video-upload") {
      const t = needs("page", token);
      if (t) return t;
      const v = videos.get(id);
      if (!v) return missing();
      if (offset !== v.received) return bad(`offset ${offset} does not match the bytes received (${v.received}).`);
      v.size = fileSize;
      v.received = Math.min(fileSize, v.received + chunk.length);
      return ok({ success: true });
    }
    if ((verify.igRupload === "versioned" && !version) || (verify.igRupload === "unversioned" && version)) return missing();
    const t = needs(["page", "user"], token);
    if (t) return t;
    const c = containers.get(id);
    if (!c || !c.resumable) return missing();
    if (offset !== c.received) return bad(`offset ${offset} does not match the bytes received (${c.received}).`);
    c.size = fileSize;
    c.received = Math.min(fileSize, c.received + chunk.length);
    if (c.received >= fileSize) c.readySince = null;
    return ok({ success: true, message: "Upload successful." });
  }

  // ----- graph.threads.com -----

  function threads(method: string, rawPath: string, params: Json, token: string | null): Result {
    const path = rawPath.replace(/^\/+/, "");
    // T2: the code exchange (form-encoded).
    if (path === "oauth/access_token" && method === "POST") {
      if (str(params.client_id) !== THREADS_APP_ID || str(params.client_secret) !== THREADS_APP_SECRET) return errorBody({ status: 400, code: 101, message: "Error validating application. Invalid application ID." });
      if (str(params.grant_type) !== "authorization_code") return bad("grant_type must be authorization_code.");
      const code = threadsCodes.get(str(params.code));
      if (!code || code.expiresAt <= clock) return bad("This authorization code has been used or has expired.", 36007);
      if (code.redirectUri !== str(params.redirect_uri)) return bad("redirect_uri does not match the one in the authorization request.", 36008);
      threadsCodes.delete(str(params.code));
      const short = `FAKE_THREADS_SHORT_${nextId()}`;
      threadsTokens.set(short, { token: short, userId: code.userId, kind: "short", issuedAt: clock, expiresAt: clock + HOUR, scopes: code.scopes });
      return ok({ access_token: short, token_type: "bearer", user_id: code.userId });
    }
    // T3: short-lived to long-lived.
    if (path === "access_token" && method === "GET") {
      if (str(params.grant_type) !== "th_exchange_token" || str(params.client_secret) !== THREADS_APP_SECRET) return bad("Invalid exchange request.");
      const row = threadsTokens.get(str(params.access_token));
      if (!row || row.kind !== "short" || row.expiresAt <= clock || expiredTokens.has(row.token)) return errorBody(SOCIAL_ERRORS.token_expired);
      const long = `FAKE_THREADS_LONG_${nextId()}`;
      threadsTokens.set(long, { token: long, userId: row.userId, kind: "long", issuedAt: clock, expiresAt: clock + 60 * DAY, scopes: row.scopes });
      return ok({ access_token: long, token_type: "bearer", expires_in: 60 * 86400 });
    }
    // T4: refresh (at least 24 h old, unexpired, threads_basic granted).
    if (path === "refresh_access_token" && method === "GET") {
      if (str(params.grant_type) !== "th_refresh_token") return bad("grant_type must be th_refresh_token.");
      const row = threadsTokens.get(str(params.access_token));
      if (!row || row.kind !== "long" || row.expiresAt <= clock || expiredTokens.has(row.token)) return errorBody(SOCIAL_ERRORS.token_expired);
      if (clock - row.issuedAt < DAY) return bad("The token must be at least 24 hours old to be refreshed.");
      if (!row.scopes.includes("threads_basic")) return errorBody(SOCIAL_ERRORS.permission_10);
      const next = `FAKE_THREADS_LONG_${nextId()}`;
      threadsTokens.set(next, { ...row, token: next, issuedAt: clock, expiresAt: clock + 60 * DAY });
      return ok({ access_token: next, token_type: "bearer", expires_in: 60 * 86400 });
    }
    const m = /^v1\.0\/(.+)$/.exec(path);
    if (!m) return missing();
    const parts = m[1].split("/").filter(Boolean);
    const [rawHead, edge, ...rest] = parts;
    if (rest.length > 0 || !rawHead) return missing();

    // T6: debug_token with an app access token (VERIFY V-T9: "TH|id|secret" or "id|secret").
    if (rawHead === "debug_token" && method === "GET") {
      const app = token ?? "";
      const thForm = app === `TH|${THREADS_APP_ID}|${THREADS_APP_SECRET}`;
      const plainForm = app === `${THREADS_APP_ID}|${THREADS_APP_SECRET}`;
      const accepted = verify.threadsAppToken === "TH" ? thForm : verify.threadsAppToken === "plain" ? plainForm : thForm || plainForm;
      if (!accepted) return errorBody({ status: 400, code: 190, message: "Invalid OAuth access token - Cannot parse access token" });
      const row = threadsTokens.get(str(params.input_token));
      const valid = !!row && row.expiresAt > clock && !expiredTokens.has(row.token);
      return ok({ data: { type: "USER", application: "Edwyz", is_valid: valid, scopes: row?.scopes ?? [], expires_at: row ? Math.floor(row.expiresAt / 1000) : 0, user_id: row?.userId ?? "" } });
    }

    const auth = threadsAuth(token, "threads_basic");
    if ("error" in auth) return auth.error;
    const row = auth.row;
    const head = rawHead === "me" ? row.userId : rawHead;
    const user = threadsUsers.get(head);
    if (user && user.id !== row.userId) return errorBody(SOCIAL_ERRORS.permission_10);

    if (user) {
      if (method === "GET" && !edge) return ok(pick({ id: user.id, username: user.username, name: user.name, threads_profile_picture_url: `https://scontent.example.test/${user.id}.jpg`, is_verified: false }, params));
      if (method === "GET" && edge === "threads_publishing_limit") {
        if (!row.scopes.includes("threads_content_publish") || !row.scopes.includes("threads_manage_replies")) return errorBody(SOCIAL_ERRORS.permission_10);
        return ok({
          data: [
            {
              quota_usage: threadsUsed(user.id, "post"),
              config: { quota_total: 250, quota_duration: 86400 },
              reply_quota_usage: threadsUsed(user.id, "reply"),
              reply_config: { quota_total: 1000, quota_duration: 86400 },
              delete_quota_usage: threadsUsed(user.id, "delete"),
              delete_config: { quota_total: 100, quota_duration: 86400 },
            },
          ],
        });
      }
      if (method === "POST" && edge === "threads") return threadsCreate(user.id, params, row);
      if (method === "POST" && edge === "threads_publish") return threadsPublish(user.id, params, row);
      if (method === "GET" && edge === "threads") {
        const limit = Math.min(Number(params.limit ?? 25) || 25, 100);
        const data = [...threadsMedia.values()]
          .filter((t) => t.userId === user.id && !t.deleted && !t.replyTo)
          .sort((a, b) => b.timestamp - a.timestamp)
          .slice(0, limit)
          .map((t) => pick({ id: t.id, text: t.text, timestamp: metaTime(t.timestamp), permalink: threadsPermalink(t), media_type: t.mediaType }, params));
        return ok({ data });
      }
      if (method === "GET" && edge === "threads_insights") return threadsUserInsights(user.id, params, row);
      return bad("Unsupported request.");
    }

    const container = threadsContainers.get(head);
    if (container) {
      if (container.userId !== row.userId) return errorBody(SOCIAL_ERRORS.permission_10);
      if (method === "GET" && !edge) {
        const s = threadsStatus(container, true);
        return ok(pick({ id: container.id, status: s.status, ...(s.errorMessage ? { error_message: s.errorMessage } : {}) }, params));
      }
      return bad("Unsupported request.");
    }
    const tm = threadsMedia.get(head);
    if (tm && !tm.deleted) {
      if (tm.userId !== row.userId) return errorBody(SOCIAL_ERRORS.permission_10);
      if (method === "GET" && !edge) return ok(pick({ id: tm.id, permalink: threadsPermalink(tm), shortcode: tm.shortcode, timestamp: metaTime(tm.timestamp), text: tm.text, media_type: tm.mediaType }, params));
      if (method === "DELETE" && !edge) {
        if (!row.scopes.includes("threads_delete")) return errorBody(SOCIAL_ERRORS.permission_10);
        // VERIFY: Meta's answer when the 100-a-day delete quota is used up (modelled as the rate-limit code).
        if (threadsUsed(row.userId, "delete") >= 100) return errorBody(SOCIAL_ERRORS.rate_limit_4);
        tm.deleted = true;
        threadsUsage.push({ userId: row.userId, kind: "delete", at: clock });
        return ok({ success: true, deleted_id: tm.id });
      }
      if (method === "GET" && edge === "replies") {
        if (!row.scopes.includes("threads_read_replies")) return errorBody(SOCIAL_ERRORS.permission_10);
        // VERIFY V-T5: the documented reply fields.
        const list = [...replies.values()].filter((r) => r.mediaId === tm.id).sort((a, b) => (truthy(params.reverse) ? b.timestamp - a.timestamp : a.timestamp - b.timestamp));
        return ok({ data: list.map((r) => pick({ id: r.id, text: r.text, username: r.username, timestamp: metaTime(r.timestamp), hide_status: r.hideStatus, has_replies: r.hasReplies }, params)) });
      }
      if (method === "GET" && edge === "insights") {
        if (!row.scopes.includes("threads_manage_insights")) return errorBody(SOCIAL_ERRORS.permission_10);
        if (emptyInsights.has(tm.id)) return ok({ data: [] });
        return ok({ data: lifetime(tm.id, metricsOf(params)) });
      }
      return bad("Unsupported request.");
    }
    const reply = replies.get(head);
    if (reply && method === "POST" && edge === "manage_reply") {
      if (!row.scopes.includes("threads_manage_replies")) return errorBody(SOCIAL_ERRORS.permission_10);
      const owner = threadsMedia.get(reply.mediaId);
      if (!owner || owner.userId !== row.userId) return errorBody(SOCIAL_ERRORS.permission_10);
      reply.hideStatus = truthy(params.hide) ? "HIDDEN" : "UNHUSHED";
      return ok({ success: true });
    }
    return missing();
  }

  function threadsPermalink(t: ThreadsMedia): string {
    return `https://www.threads.com/@${threadsUsers.get(t.userId)?.username ?? "user"}/post/${t.shortcode}`;
  }

  function threadsCreate(userId: string, params: Json, row: ThreadsToken): Result {
    const replyTo = params.reply_to_id ? str(params.reply_to_id) : null;
    // VERIFY V-T6: a reply needs threads_manage_replies (and, modelled, threads_content_publish).
    if (replyTo && !row.scopes.includes("threads_manage_replies")) return errorBody(SOCIAL_ERRORS.permission_10);
    if (!row.scopes.includes("threads_content_publish")) return errorBody(SOCIAL_ERRORS.permission_10);
    const type = str(params.media_type).toUpperCase();
    if (!["TEXT", "IMAGE", "VIDEO", "CAROUSEL"].includes(type)) return bad("media_type must be TEXT, IMAGE, VIDEO or CAROUSEL.");
    const text = str(params.text);
    if (threadsLength(text) > 500) return bad("text must be at most 500 characters.");
    if (linkCount(text) + (params.link_attachment && !text.includes(str(params.link_attachment)) ? 1 : 0) > 5) return errorBody(SOCIAL_ERRORS.threads_link_limit);
    if (params.link_attachment !== undefined && type !== "TEXT") return bad("link_attachment is only for TEXT posts.");
    if (params.reply_control !== undefined && !REPLY_CONTROLS.has(str(params.reply_control))) return bad("Invalid reply_control.");
    if (params.topic_tag !== undefined && (str(params.topic_tag).length < 1 || str(params.topic_tag).length > 50 || /[.&]/.test(str(params.topic_tag)))) return bad("Invalid topic_tag.");
    if (params.alt_text !== undefined && str(params.alt_text).length > 1000) return bad("alt_text: at most 1000 characters.");
    const isChild = truthy(params.is_carousel_item);
    let children: string[] = [];
    if (type === "IMAGE" && !/^https?:\/\//.test(str(params.image_url))) return bad("image_url should represent a valid URL");
    if (type === "VIDEO" && !/^https?:\/\//.test(str(params.video_url))) return bad("video_url should represent a valid URL");
    if (type === "CAROUSEL") {
      children = str(params.children).split(",").filter(Boolean);
      if (children.length < 2 || children.length > 20) return bad("Carousels take 2 to 20 items.");
      for (const k of children) {
        const child = threadsContainers.get(k);
        if (!child || !child.isChild || child.userId !== userId) return bad(`Invalid child ${k}.`);
      }
    }
    if (replyTo && !threadsMedia.has(replyTo) && !replies.has(replyTo)) return bad("Invalid reply_to_id.");
    const c: ThreadsContainer = { id: nextId(), userId, mediaType: type as ThreadsContainer["mediaType"], isChild, children, text, replyTo, polls: 0, createdAt: clock, forced: null, publishedId: null };
    if (nextContainerOutcome) {
      c.forced = nextContainerOutcome;
      nextContainerOutcome = null;
    }
    threadsContainers.set(c.id, c);
    return ok({ id: c.id });
  }

  function threadsPublish(userId: string, params: Json, row: ThreadsToken): Result {
    const c = threadsContainers.get(str(params.creation_id));
    if (!c || c.userId !== userId || c.isChild) return bad("Invalid creation_id.");
    if (c.publishedId) return bad("This container was already published.");
    const s = threadsStatus(c, false);
    if (s.status !== "FINISHED") return bad("The media is not ready to be published. Please wait a moment.", 4279009);
    const kind = c.replyTo ? "reply" : "post";
    if (kind === "reply" && !row.scopes.includes("threads_manage_replies")) return errorBody(SOCIAL_ERRORS.permission_10);
    // VERIFY: Meta's answer when a daily quota is used up at publish (modelled as the rate-limit code; T7 is the documented check).
    if (threadsUsed(userId, kind) >= (kind === "reply" ? 1000 : 250)) return errorBody(SOCIAL_ERRORS.rate_limit_4);
    const tm: ThreadsMedia = { id: nextId(), userId, mediaType: c.mediaType === "TEXT" ? "TEXT_POST" : c.mediaType === "CAROUSEL" ? "CAROUSEL_ALBUM" : c.mediaType, text: c.text, timestamp: clock, shortcode: shortcode(), deleted: false, replyTo: c.replyTo, fromEdwyz: true };
    threadsMedia.set(tm.id, tm);
    c.publishedId = tm.id;
    threadsUsage.push({ userId, kind, at: clock });
    if (c.replyTo) {
      const parentMedia = threadsMedia.get(c.replyTo);
      if (parentMedia) replies.set(tm.id, { id: tm.id, mediaId: parentMedia.id, username: threadsUsers.get(userId)?.username ?? "", text: c.text, timestamp: clock, hideStatus: "NOT_HUSHED", hasReplies: false });
    }
    return ok({ id: tm.id });
  }

  // ----- The request pipeline -----

  function takeInjection(host: string, method: string, path: string): SocialInjection | null {
    const i = injections.findIndex((x) => (!x.host || x.host === host) && (!x.method || x.method === method) && (!x.match || x.match.test(path)));
    if (i < 0) return null;
    const inj = injections[i];
    if (--inj.left <= 0) injections.splice(i, 1);
    return inj;
  }

  async function parseBody(body: string | Uint8Array | null | undefined, contentType: string): Promise<{ params: Json; bytes: Uint8Array | null }> {
    if (body === null || body === undefined || (typeof body === "string" && body === "") || (body instanceof Uint8Array && body.length === 0)) return { params: {}, bytes: null };
    const ct = contentType.toLowerCase();
    if (ct.includes("multipart/form-data")) {
      const form = await new Response(typeof body === "string" ? body : new Uint8Array(body), { headers: { "content-type": contentType } }).formData();
      const params: Json = {};
      let bytes: Uint8Array | null = null;
      for (const [k, v] of form.entries()) {
        if (typeof v === "string") params[k] = v;
        else bytes = new Uint8Array(await v.arrayBuffer());
      }
      return { params, bytes };
    }
    const text = typeof body === "string" ? body : null;
    if (ct.includes("application/json") || (text !== null && text.trim().startsWith("{"))) {
      try {
        const parsed = JSON.parse(text ?? decoder.decode(body as Uint8Array));
        return { params: parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Json) : {}, bytes: null };
      } catch {
        return { params: {}, bytes: null };
      }
    }
    if (ct.includes("application/x-www-form-urlencoded")) return { params: Object.fromEntries(new URLSearchParams(text ?? decoder.decode(body as Uint8Array)).entries()), bytes: null };
    // Raw bytes: an upload.
    return { params: {}, bytes: typeof body === "string" ? utf8.encode(body) : body };
  }

  const redact = (params: Json): Json => Object.fromEntries(Object.entries(params).map(([k, v]) => [k, SECRET_KEYS.test(k) ? "[redacted]" : v]));

  /**
   * Answers one request as Meta would. `host` is the Meta host (graph.facebook.com, graph-video.facebook.com, rupload.facebook.com,
   * graph.threads.com); `path` may carry the version and a query. A loopback host routes by /__host/<host>/ (graph.facebook.com
   * otherwise). The body may be text or bytes. Recorded in `calls` without tokens or secrets.
   */
  async function respond(req: SocialRequest): Promise<SocialResponse> {
    let host = req.host.toLowerCase().replace(/:\d+$/, "");
    const url = new URL(req.path, "https://fake.invalid");
    let pathname = url.pathname;
    if (LOOPBACK.has(host) || host.startsWith("127.") || host.startsWith("[::1]")) {
      const routed = /^\/__host\/([a-z0-9.-]+)(\/.*)?$/i.exec(pathname);
      if (routed) {
        host = routed[1].toLowerCase();
        pathname = routed[2] ?? "/";
      } else host = "graph.facebook.com";
    }
    if (host === "graph.threads.net") host = "graph.threads.com";
    const method = (req.method ?? "GET").toUpperCase();
    const headers = Object.fromEntries(Object.entries(req.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const query = Object.fromEntries(url.searchParams.entries());
    const versionless = host === "graph.threads.com" || host === "rupload.facebook.com" ? pathname.replace(/^\/+/, "") : pathname.replace(VERSION, "").replace(/^\/+|\/+$/g, "");
    const auth = headers.authorization ?? "";
    const parsedBody = await parseBody(req.body ?? null, headers["content-type"] ?? "");
    const params: Json = { ...query, ...parsedBody.params };
    const token = /^(?:Bearer|OAuth)\s+(.+)$/i.exec(auth)?.[1] ?? (typeof params.access_token === "string" ? params.access_token : null);
    const record: SocialCall = {
      host,
      method,
      path: versionless,
      params: redact(params),
      headers: Object.fromEntries(Object.entries(headers).filter(([k]) => k === "file_offset" || k === "offset" || k === "file_size" || k === "content-type")),
      bytes: parsedBody.bytes?.length ?? 0,
      tokenKind: tokenKind(host === "graph.threads.com" && versionless === "v1.0/debug_token" ? null : token),
      status: 0,
      outcome: "answered",
    };
    calls.push(record);

    const inj = takeInjection(host, method, versionless);
    if (inj?.kind === "hang") {
      record.outcome = "hang";
      record.status = -1;
      return { kind: "hang" };
    }
    if (inj?.kind === "network" && inj.when === "before") {
      record.outcome = "dropped_before_send";
      return { kind: "network", sent: false };
    }
    if (inj?.kind === "error") {
      const e = typeof inj.error === "string" ? SOCIAL_ERRORS[inj.error] : (inj.error ?? SOCIAL_ERRORS.server_error);
      const r = errorBody(e);
      record.status = r.status;
      return { kind: "response", status: r.status, headers: { "content-type": "application/json" }, body: JSON.stringify(r.body) };
    }
    let bytes = parsedBody.bytes;
    if (inj?.kind === "network" && inj.bytes !== undefined && bytes) bytes = bytes.slice(0, Math.max(0, inj.bytes));

    let result: Result;
    if (!SOCIAL_HOSTS.includes(host as (typeof SOCIAL_HOSTS)[number])) result = errorBody({ status: 404, code: 100, message: `fake-meta-social does not answer ${host}` });
    else if (host === "graph.facebook.com") result = graph(method, versionless, params, headers, bytes, token);
    else if (host === "graph-video.facebook.com") result = graphVideo(method, versionless, params, token);
    else if (host === "rupload.facebook.com") result = rupload(method, versionless, headers, bytes, token);
    else result = threads(method, versionless, params, token);

    if (inj?.kind === "network") {
      record.outcome = "dropped_after_send";
      return { kind: "network", sent: true };
    }
    record.status = result.status;
    return { kind: "response", status: result.status, headers: { "content-type": "application/json" }, body: JSON.stringify(result.body) };
  }

  /**
   * A fetch() for the four Meta hosts and loopback. A drop before sending throws like a refused connection (cause ECONNREFUSED,
   * which the transport knows was never sent); a drop after sending throws like a reset (ECONNRESET: the unclear case). Honours
   * the request's abort signal for hangs.
   */
  async function fetchImpl(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const host = url.hostname.toLowerCase();
    if (!SOCIAL_HOSTS.includes(host as (typeof SOCIAL_HOSTS)[number]) && !LOOPBACK.has(host)) throw new TypeError(`fake-meta-social only answers Meta's social hosts and loopback, not ${host}`);
    const signal = init?.signal ?? null;
    if (signal?.aborted) throw signal.reason ?? new DOMException("aborted", "AbortError");
    let body: Uint8Array | null = null;
    const headers: Record<string, string> = {};
    if (init?.body !== undefined && init.body !== null) {
      const request = new Request(url, { method: init.method ?? "POST", headers: init.headers, body: init.body, duplex: "half" } as RequestInit);
      request.headers.forEach((v, k) => (headers[k] = v));
      body = new Uint8Array(await request.arrayBuffer());
    } else new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const out = await respond({ method: init?.method ?? "GET", host: url.host, path: `${url.pathname}${url.search}`, headers, body });
    if (out.kind === "hang") {
      return new Promise<Response>((_, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason ?? new DOMException("aborted", "AbortError")), { once: true });
      });
    }
    if (out.kind === "network") throw new TypeError("fetch failed", { cause: { code: out.sent ? "ECONNRESET" : "ECONNREFUSED" } });
    return new Response(out.body, { status: out.status, headers: out.headers });
  }

  /** True when this fake owns the request: any of its other hosts, or a graph.facebook.com path on one of its ids or edges. */
  function claims(req: { host: string; path: string }): boolean {
    const host = req.host.toLowerCase().replace(/:\d+$/, "");
    const pathname = new URL(req.path, "https://fake.invalid").pathname;
    if (/^\/__host\//.test(pathname)) return true;
    if (host !== "graph.facebook.com" && !LOOPBACK.has(host)) return SOCIAL_HOSTS.includes(host as (typeof SOCIAL_HOSTS)[number]);
    const [head, edge] = pathname.replace(VERSION, "").replace(/^\/+/, "").split("/");
    if (!head) return false;
    if (head.startsWith("upload:") || edge === "uploads") return true;
    return pages.has(head) || igAccounts.has(head) || posts.has(head) || videos.has(head) || containers.has(head) || igMedia.has(head) || lives.has(head) || photos.has(head);
  }

  const live = (id: string) => {
    const l = lives.get(id);
    if (!l) throw new Error(`fake-meta-social: no live ${id}`);
    return l;
  };

  return {
    calls,
    fetch: fetchImpl,
    respond,
    claims,
    verify,
    pages,
    posts,
    photos,
    sessions,
    videos,
    containers,
    igMedia,
    lives,
    threadsContainers,
    threadsMedia,
    replies,
    threadsTokens,
    now: () => new Date(clock),
    setNow: (d: Date) => void (clock = d.getTime()),
    advance: (ms: number) => void (clock += ms),
    pageToken: (pageId = SOCIAL_PAGE_ID) => pages.get(pageId)?.token ?? "",
    userToken: SOCIAL_USER_TOKEN,
    threadsToken: THREADS_TOKEN,

    // ----- Failures -----
    /** The next matching request(s) fail: a Meta error (a 3.5 row), a dropped connection before or after sending, or a hang. */
    failNext: (inj: SocialInjection) => void injections.push({ ...inj, left: inj.times ?? 1 }),
    /** Shorthand: the next matching request answers this 3.5 error. */
    failNextWith: (name: SocialErrorName, where: { host?: string; method?: string; match?: RegExp } = {}) => void injections.push({ ...where, kind: "error", error: name, left: 1 }),
    /** Every later request with this token answers 190. */
    expireToken: (token: string) => void expiredTokens.add(token),
    /** Switches off a Facebook-side permission (pages_manage_posts, publish_video, read_insights, ...). */
    revokePermission: (permission: string) => void revoked.add(permission),
    grantPermission: (permission: string) => void revoked.delete(permission),

    // ----- Publishing knobs -----
    setContainerPolls: (n: number) => void (containerPolls = n),
    setContainerMs: (ms: number) => void (containerMs = ms),
    setVideoPolls: (n: number) => void (videoPolls = n),
    setIgQuotaTotal: (n: number) => void (igQuotaTotal = n),
    /** Fills Instagram's daily quota with `n` posts made elsewhere in the last 24 h. */
    useIgQuota: (n: number, igId = SOCIAL_IG_ID) => {
      for (let i = 0; i < n; i++) igPublishes.push({ igId, at: clock });
    },
    /** Uses Threads quota (posts, replies or deletes) as if made elsewhere in the last 24 h. */
    useThreadsQuota: (kind: "post" | "reply" | "delete", n: number, userId = THREADS_USER_ID) => {
      for (let i = 0; i < n; i++) threadsUsage.push({ userId, kind, at: clock });
    },
    /** An Instagram container that ends as ERROR or EXPIRED. */
    setContainerOutcome: (id: string, status: "ERROR" | "EXPIRED") => void forcedContainers.set(id, status),
    /** The next Instagram or Threads container created ends with this status (and, for Threads, error_message, T11). */
    failNextContainer: (status: "ERROR" | "EXPIRED", errorMessage?: ThreadsContainerError) => void (nextContainerOutcome = { status, errorMessage }),
    /** Force a Threads container's status (T11). */
    setThreadsContainerOutcome: (id: string, status: "ERROR" | "EXPIRED", errorMessage?: ThreadsContainerError) => {
      const c = threadsContainers.get(id);
      if (!c) throw new Error(`fake-meta-social: no Threads container ${id}`);
      c.forced = { status, errorMessage };
    },
    /** Facebook's own Reel and video Story status (F8, F9), as a test would read it. */
    videoStatus: (id: string) => {
      const v = videos.get(id);
      if (!v) throw new Error(`fake-meta-social: no video ${id}`);
      return videoStatus(v, false);
    },

    // ----- Live -----
    setFollowers: (n: number, pageId = SOCIAL_PAGE_ID) => void (pages.get(pageId)!.followers = n),
    setAccountAgeDays: (n: number) => void (accountAgeDays = n),
    /** The encoder starts sending: ingest health turns positive (VERIFY V-L3); a LIVE_NOW setup goes LIVE by itself. */
    startIngest: (id: string) => void (live(id).ingest = true),
    stopIngest: (id: string) => void (live(id).ingest = false),
    setViewers: (id: string, n: number) => void (live(id).viewers = n),
    addLiveComment: (id: string, message: string, from: string | null = "Asha") => {
      const l = live(id);
      l.comments.push({ id: `${l.id}_${nextId()}`, message, createdAt: clock, from });
    },
    addReactions: (id: string, n: number) => void (live(id).reactions += n),
    liveStatus: (id: string) => liveStatus(live(id)),

    // ----- Insights -----
    /** A metric's value for an object (a Page, post, video, Instagram account or media, Threads user or media): fixed, per day, or null (no data). */
    setInsight: (objectId: string, metric: string, value: number | null | ((day: string) => number | null)) => {
      const map = insightValues.get(objectId) ?? new Map<string, (day: string) => number | null>();
      map.set(metric, typeof value === "function" ? value : () => value);
      insightValues.set(objectId, map);
    },
    /** The object answers an empty dataset (no data yet, never 0). */
    setInsightsEmpty: (objectId: string, empty = true) => void (empty ? emptyInsights.add(objectId) : emptyInsights.delete(objectId)),
    setIgFollowers: (n: number, igId = SOCIAL_IG_ID) => void (igAccounts.get(igId)!.followers = n),
    /** An Instagram post or Story made outside Edwyz (R6, I11). */
    addIgMedia: (m: { productType?: IgMedia["productType"]; caption?: string; at?: Date; childOfAlbum?: boolean } = {}) => {
      const id = nextId();
      igMedia.set(id, { id, igId: SOCIAL_IG_ID, mediaType: m.productType === "REELS" ? "VIDEO" : "IMAGE", productType: m.productType ?? "FEED", caption: m.caption ?? "", timestamp: m.at?.getTime() ?? clock, shortcode: shortcode(), fromEdwyz: false, childOfAlbum: m.childOfAlbum ?? false });
      return id;
    },

    // ----- Threads -----
    /** A one-hour, single-use authorization code for the callback (T1, T2). */
    issueThreadsCode: (o: { userId?: string; redirectUri?: string; scopes?: string[] } = {}) => {
      const code = `FAKE_THREADS_CODE_${nextId()}`;
      threadsCodes.set(code, { userId: o.userId ?? THREADS_USER_ID, redirectUri: o.redirectUri ?? THREADS_REDIRECT_URI, scopes: o.scopes ?? [...THREADS_ALL_SCOPES], expiresAt: clock + HOUR });
      return code;
    },
    /** A Threads token with chosen permissions and age (refresh needs 24 h, T4). */
    addThreadsToken: (o: { token?: string; userId?: string; scopes?: string[]; issuedAt?: Date; expiresAt?: Date } = {}) => {
      const token = o.token ?? `FAKE_THREADS_LONG_${nextId()}`;
      threadsTokens.set(token, { token, userId: o.userId ?? THREADS_USER_ID, kind: "long", issuedAt: o.issuedAt?.getTime() ?? clock - 2 * DAY, expiresAt: o.expiresAt?.getTime() ?? clock + 58 * DAY, scopes: o.scopes ?? [...THREADS_ALL_SCOPES] });
      return token;
    },
    setThreadsScopes: (scopes: string[], token = THREADS_TOKEN) => void (threadsTokens.get(token)!.scopes = [...scopes]),
    /** A reply from someone else under a published Threads post (T15). Its text is untrusted. */
    addThreadsReply: (mediaId: string, r: { username?: string; text: string; at?: Date }) => {
      const id = nextId();
      replies.set(id, { id, mediaId, username: r.username ?? "neighbour_ravi", text: r.text, timestamp: r.at?.getTime() ?? clock, hideStatus: "NOT_HUSHED", hasReplies: false });
      return id;
    },

    reset() {
      calls.length = 0;
      injections.length = 0;
      expiredTokens.clear();
      revoked.clear();
      nextContainerOutcome = null;
    },
  };
}

export type FakeMetaSocial = ReturnType<typeof createFakeMetaSocial>;
