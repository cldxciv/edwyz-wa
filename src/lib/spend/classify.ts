/**
 * Classifies a Graph API request for the transport tripwire (docs/SPEND-CONTROLS-SPEC.md 4.7). Pure: no database, no
 * network. It looks only at the method, the path and the parameters (query string, any query inside the path, and the body),
 * because Meta accepts a write's parameters in any of them.
 *
 *   not_spend             every GET (and DELETE: removing never raises spend); CAPI `<dataset>/events`; `<page>/subscribed_apps`;
 *                         content publishing (`/feed`, `/photos`, `/videos`, `/media`, `/media_publish`); `<user>/permissions`;
 *                         template management; media and resumable uploads; number registration; a POST `<id>` that sets no
 *                         spend field (a rename).
 *   ads_create            POST `act_X/{campaigns,adsets,ads,adcreatives}`. The tripwire needs a create permit and status PAUSED
 *                         (creatives have no delivery status and are exempt from the PAUSED rule, erratum 12.1b).
 *   meta_cap              POST `act_X` with `spend_cap` or `spend_cap_action`.
 *   msg_send              POST `<phoneNumberId>/messages` (a read receipt, `status: read` with no recipient, is free).
 *   ads_lowering          POST `<id>` whose only spend field is `status` PAUSED, ARCHIVED or DELETED. Never blocked.
 *   ads_raise_or_unknown  POST `<id>` with any other spend field (status ACTIVE, a budget, a later end, a bid, a spend cap), any
 *                         other POST on an ad account, copies, batch requests, and bodies that cannot be read. Unknown counts
 *                         as raising, so it needs a permit.
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
  /** The spend fields found in the parameters, sorted. */
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

const CREATE_EDGES: readonly CreateKind[] = ["campaigns", "adsets", "ads", "adcreatives"];
/** Ad account edges that cannot deliver anything by themselves: creative media and audiences. */
const ACCOUNT_NOT_SPEND_EDGES = new Set(["adimages", "advideos", "customaudiences", "saved_audiences"]);
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
 * Marks a field given twice with different values (query and body, say). Which one Meta reads is not documented, so every
 * check treats it as unreadable: it is never PAUSED, never a budget, never a time.
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
  for (const k of SECRET_PARAMS) delete params[k];
  return { params, opaque };
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
  const override = typeof params.method === "string" ? params.method.toUpperCase() : null;
  if (override === "POST" || override === "DELETE") method = override;
  const spendKeys = SPEND_KEYS.filter((k) => k in params).sort();
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
  if (edge === "copies") return result("ads_raise_or_unknown", "unknown", "copies", { objectId: first });
  if (edge && NOT_SPEND_EDGES.has(edge) && !opaque) return result("not_spend", "none", "edge", { objectId: first });
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
