/**
 * Classifies a Graph API request for the transport tripwire (docs/SPEND-CONTROLS-SPEC.md 4.7). Pure: no database, no
 * network. It looks only at the method, the path and the parameters (query string, any query inside the path, and the body),
 * because Meta accepts a write's parameters in any of them.
 *
 *   not_spend             every GET (and DELETE: removing never raises spend); CAPI `<dataset>/events`; `<page>/subscribed_apps`;
 *                         content publishing (`/feed`, `/photos`, `/videos`, `/media`, `/media_publish`); `<user>/permissions`;
 *                         template management; media and resumable uploads (`act_X/video_ads`, IG-PAGE-ADS-SPEC P0-9); pixel
 *                         creation (`act_X/adspixels`, P0-12); number registration; a POST `<id>` that sets no spend field (a
 *                         rename).
 *   ads_create            POST `act_X/{campaigns,adsets,ads,adcreatives}`. The tripwire needs a create permit and status PAUSED
 *                         (creatives have no delivery status and are exempt from the PAUSED rule, erratum 12.1b).
 *   meta_cap              POST `act_X` with `spend_cap` or `spend_cap_action`.
 *   msg_send              POST `<phoneNumberId>/messages` (a read receipt, `status: read` with no recipient, is free).
 *   ads_lowering          POST `<id>` whose only spend field is `status` PAUSED, ARCHIVED or DELETED. Never blocked.
 *   ads_raise_or_unknown  POST `<id>` with any other spend field (status ACTIVE, a budget, a later end, a bid, a spend cap), any
 *                         other POST on an ad account, batch requests, the banned edges and parameters below, and bodies that
 *                         cannot be read. Unknown counts as raising, so it needs a permit.
 *
 * Banned (IG-PAGE-ADS-SPEC 4.7 and D25; bypass rule B15 keeps these names in this file): a write to `<id>/copies`,
 * `<campaign|adset>/budget_schedules`, `act_X/asyncadrequestsets` or `<business>/ad_studies`, a Graph batch, and any write whose
 * parameters carry `creative_test_config` or a minimum spend target at any depth. Each is `ads_raise_or_unknown`, and no permit
 * covers it: the edges are never a single object path, and the parameters are listed in `spendKeys`, which no permit allows.
 * (A split test as `ads_create` waits for Phase 0 request P0-7 and PRM-17.)
 *
 * The `pattern` is the only part of a request that may be logged or audited: ids are replaced, the query and body never appear.
 */
import type { GraphSpendClass } from "./types";

export type GraphCall = {
  method?: string;
  /** The path after the version segment, as src/lib/graph/index.ts takes it; a full Graph URL is accepted too. */
  path: string;
  query?: Readonly<Record<string, string>> | null;
  body?: unknown;
};

/** What the write could do to spend, for the audit and the tests. */
export type SpendDirection = "none" | "lower" | "raise" | "unknown" | "neutral";

export type CreateKind = "campaigns" | "adsets" | "ads" | "adcreatives";

export type GraphClassification = {
  class: GraphSpendClass;
  direction: SpendDirection;
  /** The method Meta will apply (a `method=post` override in the query counts). */
  method: string;
  segments: string[];
  /** Safe to log: "act_{id}/campaigns", "{id}", "{id}/messages". */
  pattern: string;
  /** The ad account in the path ("act_123"), if any. */
  account: string | null;
  /** The object a POST `<id>` writes to, or the phone number id of a message send. */
  objectId: string | null;
  edge: string | null;
  createKind: CreateKind | null;
  /** The spend fields found in the parameters, sorted. A banned parameter (BANNED_PARAMS) counts at any depth. */
  spendKeys: string[];
  /** The merged parameters (query, path query, body) the tripwire checks; access_token and appsecret_proof are left out. */
  params: Readonly<Record<string, unknown>>;
  /** Short reason code. */
  why: string;
};

/**
 * Fields that can raise spend, or whose direction the transport cannot know (4.7, plus the campaign end `stop_time`, ad set
 * spend floors and caps, budget sharing (2.1x, 4.5), the copies `status_option` and the legacy `configured_status`).
 */
export const SPEND_KEYS: readonly string[] = [
  "status",
  "configured_status",
  "daily_budget",
  "lifetime_budget",
  "end_time",
  "stop_time",
  "bid_amount",
  "spend_cap",
  "spend_cap_action",
  "daily_spend_cap",
  "lifetime_spend_cap",
  "daily_min_spend_target",
  "lifetime_min_spend_target",
  "is_adset_budget_sharing_enabled",
  "status_option",
];

export const BUDGET_KEYS: readonly string[] = ["daily_budget", "lifetime_budget"];
export const END_KEYS: readonly string[] = ["end_time", "stop_time"];
/** Statuses that stop delivery: a write that only sets one of these is lowering (I2). */
export const LOWERING_STATUSES: readonly string[] = ["PAUSED", "ARCHIVED", "DELETED"];

/**
 * Edges that can raise spend outside reserveAds (IG-PAGE-ADS-SPEC 4.7, D25), with the reason code a write to them gets. A write
 * whose path names one of them anywhere is `ads_raise_or_unknown`, whatever its body. No intent mints a permit for them.
 */
const BANNED_EDGES: ReadonlyMap<string, string> = new Map([
  // Copies can set status_option ACTIVE.
  ["copies", "copies"],
  // A high-demand period can spend up to 8x the daily budget.
  ["budget_schedules", "budget_schedule"],
  // An async request set creates or edits ads in bulk, outside the create permit's object count.
  ["asyncadrequestsets", "async_ad_requests"],
  // A split test carries its own dates and budget split; as ads_create it waits for P0-7 and PRM-17.
  ["ad_studies", "ad_study"],
]);

/**
 * Parameters that can raise spend wherever they appear in a write (IG-PAGE-ADS-SPEC 4.7, D25, T1'): a creative test sets its
 * own test budget, and a minimum spend target forces spend onto an ad set. Found at any depth (nested objects, arrays, JSON
 * text Meta parses, and any part of a bracketed form key such as `creative[creative_test_config]`), they make the write
 * `ads_raise_or_unknown` and are listed in `spendKeys`, so no permit covers them.
 */
export const BANNED_PARAMS: readonly string[] = ["creative_test_config", "daily_min_spend_target", "lifetime_min_spend_target"];
const BANNED_PARAM_WHY: ReadonlyMap<string, string> = new Map([
  ["creative_test_config", "creative_test"],
  ["daily_min_spend_target", "min_spend_target"],
  ["lifetime_min_spend_target", "min_spend_target"],
]);
/** Nesting deeper than this is not read: such a write is treated as raising ("deep_body"). Real bodies stay well below it. */
const MAX_PARAM_DEPTH = 32;

const CREATE_EDGES: readonly CreateKind[] = ["campaigns", "adsets", "ads", "adcreatives"];
/** Ad account edges that cannot deliver anything by themselves: creative media and audiences. */
const ACCOUNT_NOT_SPEND_EDGES = new Set(["adimages", "advideos", "customaudiences", "saved_audiences"]);
/**
 * Ad account writes that cannot spend, each with its reason code, allowed only when the body carries no spend field and can be
 * read: a pixel (`create_pixel`, P0-12) and the resumable video upload's start and finish (`PROMOTE_VIDEO=resumable`, P0-9).
 */
const ACCOUNT_NOT_SPEND_WRITES: ReadonlyMap<string, string> = new Map([
  ["adspixels", "pixel_create"],
  ["video_ads", "video_upload"],
]);
/** Object edges that never spend ad money or send a message. */
const NOT_SPEND_EDGES = new Set([
  "events",
  "subscribed_apps",
  "feed",
  "photos",
  "videos",
  "media",
  "media_publish",
  "permissions",
  "message_templates",
  "uploads",
  "register",
  "deregister",
  "request_code",
  "verify_code",
  "whatsapp_business_profile",
  "phone_numbers",
  "assigned_users",
  "content_publishing_limit",
  "comments",
]);
const SECRET_PARAMS = new Set(["access_token", "appsecret_proof", "client_secret"]);
const ACCOUNT = /^act_[A-Za-z0-9]+$/;

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const isBinary = (v: unknown): boolean =>
  v instanceof Uint8Array || v instanceof ArrayBuffer || (typeof Blob !== "undefined" && v instanceof Blob) || (typeof ReadableStream !== "undefined" && v instanceof ReadableStream);

function decodeSegment(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Splits a path (or a full Graph URL) into segments and the query it carries. Drops a leading version segment. */
export function normalizePath(raw: string): { segments: string[]; query: Record<string, string> } {
  let text = String(raw ?? "").trim();
  const query: Record<string, string> = {};
  const abs = /^https?:\/\//i.test(text);
  if (abs) {
    try {
      const u = new URL(text);
      u.searchParams.forEach((v, k) => (query[k] = v));
      text = u.pathname;
    } catch {
      // keep the text as it is
    }
  }
  const hash = text.indexOf("#");
  if (hash >= 0) text = text.slice(0, hash);
  const q = text.indexOf("?");
  if (q >= 0) {
    new URLSearchParams(text.slice(q + 1)).forEach((v, k) => (query[k] = v));
    text = text.slice(0, q);
  }
  let segments = text.split("/").map(decodeSegment).flatMap((s) => s.split("/")).map((s) => s.trim()).filter(Boolean);
  if (segments.length && /^v\d+(\.\d+)?$/.test(segments[0])) segments = segments.slice(1);
  return { segments, query };
}

/**
 * Marks a field given twice with different values (query and body, say), or a field the classifier reads given in bracket
 * form (`status[0]`). Which value Meta reads is not documented, so every check treats it as unreadable: it is never PAUSED,
 * never a budget, never a time, and as a method override it counts as a write.
 */
export const CONFLICTING_VALUE: unique symbol = Symbol("conflicting value");

const sameValue = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b) && JSON.stringify(a) !== undefined;
  } catch {
    return false;
  }
};

/**
 * The outer field of a parameter key: Meta builds nested fields from bracketed form keys, so `status[0]` or
 * `targeting[geo_locations]` sets the field before the first bracket.
 */
const outerField = (key: string): string =>
  key
    .split(/[[\]]+/)
    .map((s) => s.trim())
    .find(Boolean) ?? "";

/** Top-level fields the classifier reads by name: the spend fields, a batch, the method override and a message recipient. */
const FIELDS_READ = new Set<string>([...SPEND_KEYS, "batch", "method", "to", "recipient"]);

/**
 * The banned parameters (BANNED_PARAMS) a key names. A bracketed form key sets the fields inside its brackets too
 * (`creative[creative_test_config]`, `cells[0][daily_min_spend_target]`), so the whole key is searched, decoded and in any
 * case, not only its outer field.
 */
const bannedNamesInKey = (key: string): string[] => {
  const text = decodeSegment(key).toLowerCase();
  return BANNED_PARAMS.filter((name) => text.includes(name));
};

/** The parameters Meta will read: query string, query inside the path, then a JSON, urlencoded or FormData body. */
function mergedParams(call: GraphCall, pathQuery: Record<string, string>): { params: Record<string, unknown>; opaque: boolean } {
  const params: Record<string, unknown> = {};
  const put = (k: string, v: unknown) => {
    params[k] = k in params && !sameValue(params[k], v) ? CONFLICTING_VALUE : v;
  };
  for (const [k, v] of Object.entries(pathQuery)) put(k, v);
  for (const [k, v] of Object.entries(call.query ?? {})) put(k, v);
  let opaque = false;
  const body = call.body;
  if (body === undefined || body === null) {
    // no body
  } else if (isPlainObject(body)) {
    for (const [k, v] of Object.entries(body)) put(k, v);
  } else if (typeof FormData !== "undefined" && body instanceof FormData) {
    body.forEach((v, k) => {
      if (typeof v === "string") put(k, v);
    });
  } else if (body instanceof URLSearchParams) {
    body.forEach((v, k) => put(k, v));
  } else if (typeof body === "string") {
    const text = body.trim();
    let parsed: unknown = undefined;
    if (text.startsWith("{")) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
    }
    if (isPlainObject(parsed)) for (const [k, v] of Object.entries(parsed)) put(k, v);
    else if (text) new URLSearchParams(text).forEach((v, k) => put(k, v));
  } else if (!isBinary(body)) {
    opaque = true;
  }
  // A field the classifier reads, given in bracket form (`status[0]=ACTIVE`, `daily_budget[x]=1`, `batch[0][method]=POST`), is
  // set in a shape no check here can read, so it counts as given with an unreadable value, like a conflicting one.
  for (const k of Object.keys(params)) {
    const outer = outerField(k);
    if (outer !== k && FIELDS_READ.has(outer)) params[outer] = CONFLICTING_VALUE;
  }
  for (const k of SECRET_PARAMS) delete params[k];
  return { params, opaque };
}

/**
 * The banned parameters (BANNED_PARAMS) a write carries at any depth: keys of nested objects (every bracket part of a form
 * key), array items, and strings holding JSON (Meta parses fields like `targeting` or `cells` from JSON text). JSON-like text
 * that does not parse is searched as text. `tooDeep` is set when nesting goes past MAX_PARAM_DEPTH, so what lies below was not
 * read.
 */
function bannedParamsIn(params: Readonly<Record<string, unknown>>): { found: string[]; tooDeep: boolean } {
  const found = new Set<string>();
  let tooDeep = false;
  const visit = (value: unknown, depth: number): void => {
    if (depth > MAX_PARAM_DEPTH) {
      tooDeep = true;
      return;
    }
    if (typeof value === "string") {
      const text = value.trim();
      if (!text.startsWith("{") && !text.startsWith("[")) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        for (const k of BANNED_PARAMS) if (text.includes(k)) found.add(k);
        return;
      }
      visit(parsed, depth + 1);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (typeof value === "object" && value !== null && !isBinary(value)) {
      for (const [k, v] of Object.entries(value)) {
        for (const name of bannedNamesInKey(k)) found.add(name);
        visit(v, depth + 1);
      }
    }
  };
  visit(params, 0);
  return { found: [...found].sort(), tooDeep };
}

/** A path safe to log: Graph edge names are kept, ids and anything else become {id}. */
export function pathPattern(segments: readonly string[]): string {
  if (segments.length === 0) return "/";
  return segments
    .map((s) => {
      if (ACCOUNT.test(s)) return "act_{id}";
      if (/^upload:/.test(s)) return "upload:{id}";
      return /^[a-z][a-z_]{0,39}$/.test(s) ? s : "{id}";
    })
    .join("/");
}

const statusOf = (params: Record<string, unknown>): string | null => (typeof params.status === "string" ? params.status.trim().toUpperCase() : params.status === undefined ? null : String(params.status));

/** Classifies one Graph request. See the module header for the rules. */
export function classify(call: GraphCall): GraphClassification {
  const { segments, query: pathQuery } = normalizePath(call.path);
  const { params, opaque } = mergedParams(call, pathQuery);
  let method = String(call.method ?? "GET").toUpperCase();
  // Graph honours a `method` parameter on a request (the old JSONP override); a GET that says method=post is a write.
  const override = typeof params.method === "string" ? params.method.trim().toUpperCase() : null;
  if (override === "POST" || override === "DELETE") method = override;
  // An override that cannot be read (given twice with different values, or in bracket form) counts as a write.
  else if (params.method === CONFLICTING_VALUE) method = "POST";
  const isRead = method === "GET" || method === "HEAD" || method === "OPTIONS" || method === "DELETE";
  // Reads and deletes never raise spend, so their parameters are not searched.
  const banned = isRead ? { found: [] as string[], tooDeep: false } : bannedParamsIn(params);
  const spendKeys = [...new Set([...SPEND_KEYS.filter((k) => k in params), ...banned.found])].sort();
  const pattern = pathPattern(segments);
  const first = segments[0] ?? null;
  const account = segments.find((s) => ACCOUNT.test(s)) ?? null;
  const edge = segments.length >= 2 ? segments[segments.length - 1] : null;
  const base = { method, segments, pattern, account, spendKeys, params, createKind: null as CreateKind | null };
  const result = (cls: GraphSpendClass, direction: SpendDirection, why: string, extra: Partial<GraphClassification> = {}): GraphClassification => ({
    ...base,
    objectId: null,
    edge,
    ...extra,
    class: cls,
    direction,
    why,
  });

  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return result("not_spend", "none", "read");
  if (method === "DELETE") return result("not_spend", "none", "delete");

  // Every other method is treated as a write (POST).
  if (params.batch !== undefined) return result("ads_raise_or_unknown", "unknown", "batch");
  if (segments.length === 0) return result("ads_raise_or_unknown", "unknown", "root_write");
  // Banned edges (4.7, D25): anywhere in the path, whatever the body.
  const bannedEdge = segments.slice(1).find((s) => BANNED_EDGES.has(s));
  if (bannedEdge) return result("ads_raise_or_unknown", "unknown", BANNED_EDGES.get(bannedEdge)!, { objectId: first });
  // Banned parameters at any depth, on any edge (even one that is otherwise not spend).
  if (banned.found.length > 0) return result("ads_raise_or_unknown", "unknown", BANNED_PARAM_WHY.get(banned.found[0])!, { objectId: first });
  if (banned.tooDeep) return result("ads_raise_or_unknown", "unknown", "deep_body", { objectId: first });
  if (first && /^upload:/.test(first)) return result("not_spend", "none", "upload_session");

  if (first && ACCOUNT.test(first)) {
    if (segments.length === 1) {
      if ("spend_cap" in params || "spend_cap_action" in params) return result("meta_cap", "unknown", "spend_cap", { objectId: first });
      return result("ads_raise_or_unknown", "unknown", "account_write", { objectId: first });
    }
    if (segments.length === 2) {
      const e = segments[1];
      if ((CREATE_EDGES as readonly string[]).includes(e)) return result("ads_create", "neutral", "create", { createKind: e as CreateKind });
      if (ACCOUNT_NOT_SPEND_EDGES.has(e)) return result("not_spend", "none", "account_media");
      const why = ACCOUNT_NOT_SPEND_WRITES.get(e);
      if (why && !opaque && spendKeys.length === 0) return result("not_spend", "none", why);
    }
    return result("ads_raise_or_unknown", "unknown", "account_edge");
  }

  if (segments.length === 1) {
    if (opaque) return result("ads_raise_or_unknown", "unknown", "opaque_body", { objectId: first });
    if (spendKeys.length === 0) return result("not_spend", "none", "no_spend_field", { objectId: first });
    const status = statusOf(params);
    if (spendKeys.length === 1 && spendKeys[0] === "status" && status !== null && LOWERING_STATUSES.includes(status)) {
      return result("ads_lowering", "lower", "pause", { objectId: first });
    }
    const onlyStatus = spendKeys.every((k) => k === "status" || k === "configured_status");
    return result("ads_raise_or_unknown", onlyStatus && status === "ACTIVE" ? "raise" : "unknown", onlyStatus ? "status" : "spend_field", { objectId: first });
  }

  if (segments.length === 2 && edge === "messages") {
    const status = statusOf(params);
    if (status === "READ" && params.to === undefined && params.recipient === undefined) return result("not_spend", "none", "read_receipt", { objectId: first });
    return result("msg_send", "raise", "message", { objectId: first });
  }
  if (edge && NOT_SPEND_EDGES.has(edge) && !opaque) return result("not_spend", "none", "edge", { objectId: first });
  // A pixel on a business (C9's alternative to act_X/adspixels, P0-12): not spend while it sets no spend field.
  if (segments.length === 2 && edge === "adspixels" && !opaque && spendKeys.length === 0) return result("not_spend", "none", "pixel_create", { objectId: first });
  if (opaque || spendKeys.length > 0) return result("ads_raise_or_unknown", "unknown", "edge_spend_field", { objectId: first });
  return result("not_spend", "none", "edge_no_spend_field", { objectId: first });
}

/**
 * Which budget a field sets. The Marketing API field names live here (bypass rule B10 allows them only in the builders, the
 * ads client, read-only field lists and this classifier), so the tripwire asks instead of naming them.
 */
export function budgetFieldKind(key: string): "daily" | "lifetime" | null {
  return key === "daily_budget" ? "daily" : key === "lifetime_budget" ? "lifetime" : null;
}

/** True for a field that sets when delivery ends (ad set `end_time`, campaign `stop_time`). */
export function isEndField(key: string): boolean {
  return (END_KEYS as readonly string[]).includes(key);
}

/**
 * The parts of a write to Meta's spending limit (a `meta_cap` request): the cap value if one is set, the cap action if one is
 * given, and any other spend field in the same request. Bypass rule B9 keeps the field names in this file and metacap/.
 */
export function metaCapFields(c: Pick<GraphClassification, "params" | "spendKeys">): { hasCap: boolean; cap: unknown; action: string | null; others: string[] } {
  const hasCap = "spend_cap" in c.params;
  const rawAction = c.params.spend_cap_action;
  const action = rawAction === undefined ? null : typeof rawAction === "string" ? rawAction.trim().toLowerCase() : "unreadable";
  return { hasCap, cap: c.params.spend_cap, action, others: c.spendKeys.filter((k) => k !== "spend_cap" && k !== "spend_cap_action") };
}

/** Parses a budget value Meta would read (a whole number, as a number or a string) to bigint; null when it is not one. */
export function parseMinorParam(value: unknown): bigint | null {
  if (typeof value === "bigint") return value >= 0n ? value : null;
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  if (typeof value === "string" && /^\d{1,19}$/.test(value.trim())) return BigInt(value.trim());
  return null;
}

/** Parses a spend_cap value (Meta writes it in major units, "standard denomination") to an exact scaled decimal. */
export function parseDecimalParam(value: unknown): { units: bigint; scale: number } | null {
  const text = typeof value === "number" ? (Number.isFinite(value) && value >= 0 ? String(value) : "") : typeof value === "string" ? value.trim() : "";
  const m = /^(\d{1,19})(?:\.(\d{1,6}))?$/.exec(text);
  if (!m) return null;
  const frac = m[2] ?? "";
  return { units: BigInt(m[1] + frac), scale: frac.length };
}

/** Parses an end_time or stop_time the way Meta reads it (ISO 8601 or epoch seconds); null when unreadable. */
export function parseTimeParam(value: unknown): Date | null {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value * 1000);
  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.trim();
  if (/^\d{9,11}$/.test(text)) return new Date(Number(text) * 1000);
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? null : d;
}
