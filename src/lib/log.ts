import { randomBytes } from "node:crypto";
import { describeError, sanitizeMessage } from "@/lib/safe-error";

export type Level = "debug" | "info" | "warn" | "error";
export type Fields = Record<string, unknown>;
export type SerializedError = { kind: string; message?: string };
export type ErrorReport = { err: SerializedError; context: Fields; requestId?: string };
export type ErrorReporter = (report: ErrorReport) => void | Promise<void>;
export type Logger = {
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
  child(bindings: Fields): Logger;
};

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const REDACTED = "[redacted]";
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;
const MAX_DEPTH = 4;
const MAX_STRING = 500;
const MAX_ITEMS = 20;

const SENSITIVE_KEY = /token|secret|password|passwd|authorization|cookie|credential|api[-_]?key|signature|e-?mail|phone|^pin$|^otp$/i;
const CONTENT_KEY = /^(body|text|content|caption|message|messages|payload|html|preview|subject|raw)$/i;

const EMAIL = /[^\s@"'<>]+@[^\s@"'<>]+\.[^\s@"'<>]+/g;
const PHONE = /(?<![\w-])\+?\d[\d\s-]{8,}\d(?![\w-])/g;
const BEARER = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;
const META_TOKEN = /\bEAA[A-Za-z0-9]{16,}/g;
const JWT = /\beyJ[\w-]+\.[\w-]+\.[\w-]+/g;

export function scrubString(value: string): string {
  const cut = value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}...` : value;
  return cut
    .replace(BEARER, "Bearer [redacted]")
    .replace(JWT, REDACTED)
    .replace(META_TOKEN, REDACTED)
    .replace(EMAIL, "[email]")
    .replace(PHONE, "[number]");
}

export function serializeError(error: unknown): SerializedError {
  const kind = describeError(error);
  if (!(error instanceof Error) || /prisma/i.test(kind) || /prisma/i.test(error.name)) return { kind };
  return { kind, message: scrubString(sanitizeMessage(error.message)) };
}

/** Returns a copy that is safe to log: sensitive keys and message bodies are replaced, string values are scrubbed. */
export function redact(value: unknown, depth = 0, key = ""): unknown {
  if (key && (SENSITIVE_KEY.test(key) || CONTENT_KEY.test(key))) return REDACTED;
  if (value === null || value === undefined) return value;
  if (key === "reqId" && typeof value === "string" && SAFE_REQUEST_ID.test(value)) return value;
  if (value instanceof Error) return serializeError(value);
  if (typeof value === "string") return scrubString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "object") return undefined;
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, MAX_ITEMS).map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 50)) out[k] = redact(v, depth + 1, k);
  return out;
}

type Sink = (level: Level, line: string) => void;
const defaultSink: Sink = (level, line) => {
  (level === "warn" || level === "error" ? process.stderr : process.stdout).write(`${line}\n`);
};
let sink: Sink = defaultSink;
let reporter: ErrorReporter | null = null;

/** Tests and alternative transports replace the output. Pass null to restore stdout/stderr. */
export function setLogSink(next: Sink | null) {
  sink = next ?? defaultSink;
}

/** Hook for an external error tracker. Receives scrubbed data only. No vendor is bundled. */
export function setErrorReporter(next: ErrorReporter | null) {
  reporter = next;
}

function threshold(): number {
  const configured = (process.env.LOG_LEVEL ?? "info").toLowerCase() as Level;
  return ORDER[configured] ?? ORDER.info;
}

function notify(fields: Fields, redacted: Fields) {
  if (!reporter || !("err" in fields)) return;
  const { err, ...context } = redacted;
  const requestId = typeof context.reqId === "string" ? context.reqId : undefined;
  try {
    const result = reporter({ err: err as SerializedError, context, requestId });
    if (result && typeof (result as Promise<void>).catch === "function") (result as Promise<void>).catch(() => undefined);
  } catch {
    // a failing reporter must never break the request
  }
}

function emit(level: Level, msg: string, bindings: Fields, fields: Fields | undefined) {
  if (ORDER[level] < threshold()) return;
  const merged = { ...bindings, ...fields };
  const safe = redact(merged) as Fields;
  const entry = { ...safe, t: new Date().toISOString(), level, msg: scrubString(msg) };
  let line: string;
  try {
    line = JSON.stringify(entry);
  } catch {
    line = JSON.stringify({ t: entry.t, level, msg: entry.msg, note: "unserializable fields" });
  }
  sink(level, line);
  if (level === "error") notify(merged, safe);
}

export function createLogger(bindings: Fields = {}): Logger {
  return {
    debug: (msg, fields) => emit("debug", msg, bindings, fields),
    info: (msg, fields) => emit("info", msg, bindings, fields),
    warn: (msg, fields) => emit("warn", msg, bindings, fields),
    error: (msg, fields) => emit("error", msg, bindings, fields),
    child: (extra) => createLogger({ ...bindings, ...extra }),
  };
}

export const log = createLogger();

export const REQUEST_ID_HEADER = "x-request-id";

export const newRequestId = () => randomBytes(8).toString("hex");

/** Reuses an inbound id (set by nginx or the proxy) when it is well formed, otherwise mints one. */
export function getRequestId(source: Request | Headers): string {
  const headers = source instanceof Headers ? source : source.headers;
  const inbound = headers.get(REQUEST_ID_HEADER);
  return inbound && SAFE_REQUEST_ID.test(inbound) ? inbound : newRequestId();
}

/** A logger bound to the request id. Pair with `headers.set(REQUEST_ID_HEADER, id)` on the response. */
export function requestLogger(source: Request | Headers, extra: Fields = {}): { id: string; log: Logger } {
  const id = getRequestId(source);
  return { id, log: log.child({ reqId: id, ...extra }) };
}
