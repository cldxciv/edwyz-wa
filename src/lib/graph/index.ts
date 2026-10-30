import { createHmac } from "node:crypto";
import { getAccessToken } from "@/lib/crypto/tokens";
import { GRAPH_API_VERSION } from "@/lib/config";
import { tripwire, type TripwireVia } from "@/lib/spend/tripwire";

export class GraphError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: number,
    public subcode?: number,
    public retryable = false,
    /** True when a message POST may have reached Meta (timeout, reset, 5xx): the send must not be repeated automatically. */
    public ambiguous = false,
  ) {
    super(message);
  }
}

export type GraphRequest = {
  tenantId: string;
  /** Path after the version segment, for example `${phoneNumberId}/messages`. */
  path: string;
  method?: "GET" | "POST" | "DELETE";
  query?: Record<string, string>;
  body?: unknown;
};

export type AppGraphRequest = Omit<GraphRequest, "tenantId">;

/*
 * Retried with backoff (max 4 attempts): Meta codes 4 (app rate limit), 80007 (WABA rate limit),
 * 130429 (throughput limit), 131056 (pair rate limit); HTTP 429, 500, 502, 503, 504; network errors and timeouts.
 * Surfaced immediately: 131026 (message undeliverable), 131047 (24h window closed, needs a template),
 * auth errors (190), invalid parameters and every other code. Retrying these cannot succeed or could double-send.
 */
const RETRYABLE_CODES = new Set([4, 80007, 130429, 131056]);
const NEVER_RETRY_CODES = new Set([131026, 131047]);
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
/** Connection failures that happen before any request bytes leave this host, so a retry cannot double-send. */
const NOT_SENT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);
const MAX_ATTEMPTS = 4;
const TIMEOUT_MS = 20_000;
const BASE_DELAY_MS = 500;

export function isRetryable(status: number, code?: number): boolean {
  if (code !== undefined && NEVER_RETRY_CODES.has(code)) return false;
  if (code !== undefined && RETRYABLE_CODES.has(code)) return true;
  return RETRYABLE_STATUS.has(status);
}

export function backoffDelay(attempt: number, random = Math.random): number {
  const exp = BASE_DELAY_MS * 2 ** (attempt - 1);
  return exp / 2 + random() * (exp / 2);
}

/**
 * appsecret_proof: hex HMAC-SHA256 of the access token keyed with the app secret. Meta requires it on server calls when
 * "Require App Secret" is on, and recommends it always. Returns null (so the parameter is simply left out) when META_APP_SECRET is
 * not set, and for an app access token ("id|secret"), which already is the secret. The value is never logged or put in an error.
 */
export function appSecretProof(token: string, secret = process.env.META_APP_SECRET): string | null {
  if (!secret || !token || token.includes("|")) return null;
  return createHmac("sha256", secret).update(token).digest("hex");
}

/** The query with appsecret_proof added for this token, when a proof can be computed. */
export function withAppSecretProof(token: string, query?: Record<string, string>): Record<string, string> | undefined {
  const proof = appSecretProof(token);
  return proof ? { ...query, appsecret_proof: proof } : query;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function buildUrl(path: string, query?: Record<string, string>): string {
  const url = new URL(`https://graph.facebook.com/${GRAPH_API_VERSION}/${path.replace(/^\/+/, "")}`);
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
  return url.toString();
}

async function attemptOnce<T>(url: string, method: string, headers: Record<string, string>, body: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const code = (error as { cause?: { code?: string } } | null)?.cause?.code;
    const notSent = code !== undefined && NOT_SENT_CODES.has(code);
    throw new GraphError("Network error calling the WhatsApp API", 0, undefined, undefined, true, !notSent);
  }
  const text = await response.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (response.ok) return json as T;
  const err = (json as { error?: { message?: string; code?: number; error_subcode?: number } } | null)?.error;
  const code = typeof err?.code === "number" ? err.code : undefined;
  const subcode = typeof err?.error_subcode === "number" ? err.error_subcode : undefined;
  const message = err?.message ?? `Graph API request failed with status ${response.status}`;
  throw new GraphError(message, response.status, code, subcode, isRetryable(response.status, code));
}

const isMessageSend = (request: AppGraphRequest) => request.method === "POST" && /(^|\/)messages$/.test(request.path);

/** A message POST is retried only on Meta rejections (codes 4, 80007, 130429, 131056) or HTTP 429, or when the connection failed before sending. */
function guardSend(e: GraphError) {
  if (e.ambiguous) e.retryable = false;
  else if (e.status >= 500 && !(e.code !== undefined && RETRYABLE_CODES.has(e.code))) {
    e.retryable = false;
    e.ambiguous = true;
  }
}

/**
 * Every Graph request goes through here. The spend controls' transport tripwire runs first, before any network I/O
 * (docs/SPEND-CONTROLS-SPEC.md 4.7): a raising write without a valid permit is audited (SPEND_TRIPWIRE=report) or refused
 * with SpendGuardBypassError (enforce). It checks the caller's own path, query and body, never the added credentials, and
 * counts one permit use per request (retries below do not count again).
 */
async function run<T>(request: AppGraphRequest, headers: Record<string, string>, query: Record<string, string> | undefined, guardAllPosts: boolean, via: TripwireVia): Promise<T> {
  tripwire({ method: request.method ?? "GET", path: request.path, query: request.query, body: request.body }, via);
  const url = buildUrl(request.path, query);
  const hasBody = request.body !== undefined;
  const allHeaders = { Accept: "application/json", ...(hasBody ? { "Content-Type": "application/json" } : {}), ...headers };
  for (let attempt = 1; ; attempt++) {
    try {
      return await attemptOnce<T>(url, request.method ?? "GET", allHeaders, request.body);
    } catch (e) {
      if (e instanceof GraphError && (isMessageSend(request) || (guardAllPosts && request.method === "POST"))) guardSend(e);
      if (!(e instanceof GraphError) || !e.retryable || attempt >= MAX_ATTEMPTS) throw e;
      await sleep(backoffDelay(attempt));
    }
  }
}

/** Calls the Graph API with the tenant's stored token, retrying retryable errors with backoff. Throws GraphError. */
export async function graphFetch<T = unknown>(request: GraphRequest): Promise<T> {
  const token = await getAccessToken(request.tenantId);
  return run<T>(request, { Authorization: `Bearer ${token}` }, withAppSecretProof(token, request.query), false, { via: "tenant", tenantId: request.tenantId });
}

/** For calls made before a tenant token exists (the code exchange). Adds client_id and client_secret to the query, as Meta's oauth endpoint requires. */
export async function appGraphFetch<T = unknown>(request: AppGraphRequest): Promise<T> {
  const id = process.env.META_APP_ID;
  const secret = process.env.META_APP_SECRET;
  if (!id || !secret) throw new Error("META_APP_ID and META_APP_SECRET must be set");
  return run<T>(request, {}, { ...request.query, client_id: id, client_secret: secret }, false, { via: "app" });
}

/** For tokens that are not the tenant's WhatsApp token (Marketing API, Pages, Instagram, Conversions). The caller decrypts the token and never logs it. Every POST is guarded like a message send: an ambiguous failure (5xx or a lost connection) is never retried, so posts, ads and events cannot be created twice. */
export async function graphFetchAs<T = unknown>(token: string, request: AppGraphRequest): Promise<T> {
  if (!token) throw new Error("A Meta access token is required");
  return run<T>(request, { Authorization: `Bearer ${token}` }, withAppSecretProof(token, request.query), true, { via: "token" });
}

export type GraphUploadRequest = {
  tenantId: string;
  /** For example `${phoneNumberId}/media`. */
  path: string;
  /** Plain form fields sent next to the file, for example { messaging_product: "whatsapp" }. */
  fields?: Record<string, string>;
  file: { bytes: Uint8Array; filename: string; mime: string };
};

const UPLOAD_TIMEOUT_MS = 60_000;

/** Multipart upload with the tenant's token (WhatsApp media). Sent once: a lost connection is reported as ambiguous, never retried, so one file cannot be stored twice. */
export async function graphUpload<T = unknown>(request: GraphUploadRequest): Promise<T> {
  // Media uploads are not spend, but they pass the same tripwire first, so this path cannot be used to post a spend write.
  tripwire({ method: "POST", path: request.path, body: { ...request.fields } }, { via: "tenant", tenantId: request.tenantId });
  const token = await getAccessToken(request.tenantId);
  const form = new FormData();
  for (const [key, value] of Object.entries(request.fields ?? {})) form.set(key, value);
  const copy = new Uint8Array(request.file.bytes.byteLength);
  copy.set(request.file.bytes);
  form.set("file", new Blob([copy], { type: request.file.mime }), request.file.filename);
  let response: Response;
  try {
    response = await fetch(buildUrl(request.path, withAppSecretProof(token)), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      body: form,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
  } catch {
    throw new GraphError("Network error uploading to the WhatsApp API", 0, undefined, undefined, false, true);
  }
  const text = await response.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (response.ok) return json as T;
  const err = (json as { error?: { message?: string; code?: number; error_subcode?: number } } | null)?.error;
  const code = typeof err?.code === "number" ? err.code : undefined;
  const subcode = typeof err?.error_subcode === "number" ? err.error_subcode : undefined;
  throw new GraphError(err?.message ?? `Graph API upload failed with status ${response.status}`, response.status, code, subcode, false);
}
