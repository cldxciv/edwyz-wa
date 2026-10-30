/**
 * Untrusted text in the action layer (docs/EDDY-SPEC.md 4.3 G20, 7.2 item 5). Text that customers, contacts, teammates,
 * templates or outside systems wrote reaches the model only as `{"$untrusted": source, "text": ...}` values inside
 * tool_result blocks:
 * - u(source, text) scrubs the text (ai-agent's scrubber: control, bidi and invisible code points, ASCII and look-alike
 *   angle brackets) and truncates it by grapheme, so a Devanagari conjunct or an emoji sequence is never split;
 * - toModelPayload(result, untrustedPaths) checks that every string at a declared path is UntrustedText (it throws outside
 *   production, so a definition that forgets the wrapper fails its tests, and wraps in production), re-scrubs every
 *   UntrustedText it meets, and caps the payload at 16 KB of JSON.
 * Pure (no database): the scrubber import is pure too.
 */
import { scrubUntrustedText } from "@/lib/ai-agent/untrusted";
import type { UntrustedSource, UntrustedText } from "./types";

export const UNTRUSTED_SOURCES: readonly UntrustedSource[] = [
  "customer_message",
  "contact_name",
  "contact_attribute",
  "lead_field",
  "template_text",
  "workspace_text",
  "teammate_note",
  "external_text",
  "file_name",
];

/** Default cap of one UntrustedText value, in graphemes. Definitions pass a smaller one where the spec says so (500 for bodies). */
export const UNTRUSTED_TEXT_MAX_GRAPHEMES = 2000;
/** The model payload cap of G20: 16 KB of UTF-8 JSON. */
export const MODEL_PAYLOAD_MAX_BYTES = 16 * 1024;
export const ELLIPSIS = "…";

// ===== Graphemes =====

/** Code points after which a cut would leave a half-formed conjunct or a broken emoji sequence. */
const JOINERS = /[\u094D\u09CD\u0A4D\u0ACD\u0B4D\u0BCD\u0C4D\u0CCD\u0D4D\u0DCA\u200C\u200D]$/u;

let segmenter: Intl.Segmenter | null | undefined;
function graphemeSegmenter(): Intl.Segmenter | null {
  if (segmenter === undefined) {
    try {
      segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter("und", { granularity: "grapheme" }) : null;
    } catch {
      segmenter = null;
    }
  }
  return segmenter;
}

/** The text split into user-perceived characters (extended grapheme clusters). */
export function graphemes(text: string): string[] {
  const seg = graphemeSegmenter();
  if (seg) return Array.from(seg.segment(text), (s) => s.segment);
  // Fallback without ICU: a base character with its marks, joined across a virama or a zero-width joiner.
  return text.match(/(?:\P{M}\p{M}*)(?:[\u094D\u09CD\u0A4D\u0ACD\u0B4D\u0BCD\u0C4D\u0CCD\u0D4D\u200D]\P{M}\p{M}*)*|\p{M}+/gu) ?? [];
}

/** The first `limit` graphemes (and whether there were more), without segmenting the rest of a long text. */
function headGraphemes(text: string, limit: number): { parts: string[]; more: boolean } {
  const seg = graphemeSegmenter();
  if (!seg) {
    const all = graphemes(text);
    return { parts: all.slice(0, limit), more: all.length > limit };
  }
  const parts: string[] = [];
  for (const s of seg.segment(text)) {
    if (parts.length === limit) return { parts, more: true };
    parts.push(s.segment);
  }
  return { parts, more: false };
}

/** The grapheme count of a text (its UTF-16 length is an upper bound, so short texts are not segmented). */
export function graphemeCount(text: string): number {
  const seg = graphemeSegmenter();
  if (!seg) return graphemes(text).length;
  let n = 0;
  for (const _ of seg.segment(text)) n++;
  return n;
}

/**
 * At most `max` graphemes, the ellipsis included when the text was cut. A cut never ends on a virama or a joiner (so
 * क्षत्रिय is cut before क्ष, never between क् and ष, even where the platform's segmenter predates Unicode 15.1).
 */
export function truncateGraphemes(text: string, max: number, ellipsis = ELLIPSIS): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  const { parts, more } = headGraphemes(text, max);
  if (!more) return text;
  const keep = parts.slice(0, Math.max(0, max - (ellipsis ? 1 : 0)));
  while (keep.length > 0 && JOINERS.test(keep[keep.length - 1])) keep.pop();
  return `${keep.join("")}${ellipsis}`;
}

// ===== UntrustedText =====

const isSource = (s: unknown): s is UntrustedSource => typeof s === "string" && (UNTRUSTED_SOURCES as readonly string[]).includes(s);

/** Tags text someone else wrote. It is scrubbed and cut to `maxGraphemes` (default 2,000). */
export function u(source: UntrustedSource, text: string, maxGraphemes = UNTRUSTED_TEXT_MAX_GRAPHEMES): UntrustedText {
  const clean = scrubUntrustedText(typeof text === "string" ? text : String(text ?? ""));
  return { $untrusted: isSource(source) ? source : "external_text", text: truncateGraphemes(clean, maxGraphemes) };
}

/** u() for optional text: null stays null. */
export function uOrNull(source: UntrustedSource, text: string | null | undefined, maxGraphemes = UNTRUSTED_TEXT_MAX_GRAPHEMES): UntrustedText | null {
  return text === null || text === undefined ? null : u(source, text, maxGraphemes);
}

/** True for a well-formed UntrustedText value (exactly the two keys, a known source, a string). */
export function isUntrustedText(value: unknown): value is UntrustedText {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  const v = value as Record<string, unknown>;
  return keys.length === 2 && isSource(v.$untrusted) && typeof v.text === "string";
}

const looksUntrusted = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, "$untrusted");

// ===== Projection (G20) =====

export class UntrustedPathError extends Error {
  constructor(public path: string) {
    super(`Result path "${path}" holds plain text where UntrustedText is required. Wrap it with u(source, text).`);
    this.name = "UntrustedPathError";
  }
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** A JSON-safe copy: Dates to ISO strings, bigints to strings, undefined and functions dropped, UntrustedText re-scrubbed. */
function toJsonSafe(value: unknown, seen: Set<object>): Json | undefined {
  if (value === null) return null;
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) ? value : null;
    case "bigint":
      return value.toString();
    case "undefined":
    case "function":
    case "symbol":
      return undefined;
  }
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const obj = value as object;
  if (seen.has(obj)) return null;
  seen.add(obj);
  try {
    if (Array.isArray(obj)) return obj.map((item) => toJsonSafe(item, seen) ?? null);
    if (looksUntrusted(obj)) {
      const raw = (obj as Record<string, unknown>).text;
      const t = u((obj as Record<string, unknown>).$untrusted as UntrustedSource, typeof raw === "string" ? raw : raw === null || raw === undefined ? "" : JSON.stringify(raw));
      return { $untrusted: t.$untrusted, text: t.text };
    }
    const withJson = obj as { toJSON?: () => unknown };
    if (typeof withJson.toJSON === "function") return toJsonSafe(withJson.toJSON(), seen);
    const out: Record<string, Json> = {};
    for (const [key, item] of Object.entries(obj)) {
      const v = toJsonSafe(item, seen);
      if (v !== undefined) out[key] = v;
    }
    return out;
  } finally {
    seen.delete(obj);
  }
}

type Segment = { key: string | null; each: boolean };

/** "items[].contact.name" -> [{items, each}, {contact}, {name}]; "[].name" starts with a top-level array. */
function parsePath(path: string): Segment[] {
  return path.split(".").filter(Boolean).map((part) => {
    const each = part.endsWith("[]");
    const key = each ? part.slice(0, -2) : part;
    return { key: key === "" ? null : key, each };
  });
}

/** Visits every value at a path; `set` replaces it in place. */
function visitPath(root: { value: Json }, segments: Segment[], visit: (value: Json, set: (v: Json) => void, at: string) => void): void {
  type Holder = Record<string | number, Json>;
  const go = (holder: Holder, key: string | number, i: number, at: string): void => {
    if (i === segments.length) {
      visit(holder[key], (v) => (holder[key] = v), at);
      return;
    }
    const seg = segments[i];
    let h = holder;
    let k = key;
    let label = at;
    if (seg.key !== null) {
      const current = holder[key];
      if (!current || typeof current !== "object" || Array.isArray(current) || isUntrustedText(current)) return;
      h = current as Holder;
      k = seg.key;
      label = at ? `${at}.${seg.key}` : seg.key;
    }
    if (!seg.each) return go(h, k, i + 1, label);
    const list = h[k];
    if (!Array.isArray(list)) return;
    list.forEach((_, j) => go(list as unknown as Holder, j, i + 1, `${label}[${j}]`));
  };
  if (segments.length > 0) go(root as unknown as Holder, "value", 0, "");
}

const encoder = new TextEncoder();
const byteLength = (text: string) => encoder.encode(text).length;

/** Every string node, longest first, for the size cap. */
function stringNodes(value: Json, out: { get: () => string; set: (s: string) => void; untrusted: boolean }[] = []) {
  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      if (typeof item === "string") out.push({ get: () => value[i] as string, set: (s) => (value[i] = s), untrusted: false });
      else stringNodes(item, out);
    });
  } else if (value && typeof value === "object") {
    if (isUntrustedText(value)) {
      const v = value as unknown as UntrustedText;
      out.push({ get: () => v.text, set: (s) => (v.text = s), untrusted: true });
      return out;
    }
    for (const key of Object.keys(value)) {
      const item = value[key];
      if (typeof item === "string") out.push({ get: () => value[key] as string, set: (s) => (value[key] = s), untrusted: false });
      else stringNodes(item, out);
    }
  }
  return out;
}

function arrays(value: Json, out: Json[][] = []): Json[][] {
  if (Array.isArray(value)) {
    out.push(value);
    for (const item of value) arrays(item, out);
  } else if (value && typeof value === "object" && !isUntrustedText(value)) {
    for (const item of Object.values(value)) arrays(item, out);
  }
  return out;
}

export type ModelPayload = {
  payload: unknown;
  bytes: number;
  truncated: boolean;
  /** Paths whose plain strings were wrapped (production only; outside production they throw). */
  wrapped: string[];
};

export type ModelPayloadOptions = {
  /** Throw on a plain string at a declared path. Default: everywhere except production. */
  strict?: boolean;
  maxBytes?: number;
};

const strictByDefault = () => process.env.NODE_ENV !== "production";

/**
 * The JSON a tool_result carries (G20). Declared paths must hold UntrustedText; every UntrustedText is re-scrubbed; the
 * whole payload is cut to 16 KB by shortening long texts first, then dropping the tail of the largest lists. A payload that
 * was cut says so (`truncated: true` on an object result).
 */
export function toModelPayload(result: unknown, untrustedPaths: readonly string[], options: ModelPayloadOptions = {}): ModelPayload {
  const strict = options.strict ?? strictByDefault();
  const maxBytes = options.maxBytes ?? MODEL_PAYLOAD_MAX_BYTES;
  const root = { value: toJsonSafe(result, new Set()) ?? null };
  const wrapped: string[] = [];

  for (const path of untrustedPaths) {
    visitPath(root, parsePath(path), (value, set, at) => {
      if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") return;
      if (isUntrustedText(value)) return;
      if (Array.isArray(value)) {
        value.forEach((item, i) => {
          if (item === null || isUntrustedText(item) || typeof item === "number" || typeof item === "boolean") return;
          if (strict) throw new UntrustedPathError(`${at}[${i}]`);
          value[i] = u("external_text", typeof item === "string" ? item : JSON.stringify(item)) as unknown as Json;
          wrapped.push(`${at}[${i}]`);
        });
        return;
      }
      if (strict) throw new UntrustedPathError(at || path);
      set(u("external_text", typeof value === "string" ? value : JSON.stringify(value)) as unknown as Json);
      wrapped.push(at || path);
    });
  }

  let text = JSON.stringify(root.value);
  let bytes = byteLength(text);
  let truncated = false;
  if (bytes > maxBytes) {
    truncated = true;
    // Room for the `"truncated":true` marker an object result gets at the end.
    const objectRoot = !!root.value && typeof root.value === "object" && !Array.isArray(root.value) && !isUntrustedText(root.value);
    const limit = objectRoot ? maxBytes - 20 : maxBytes;
    // 1. Shorten long texts in proportion to the overshoot (a few passes; grapheme counts are kept, not recounted).
    const counts = new Map<string, number>();
    for (let pass = 0; pass < 4 && bytes > limit; pass++) {
      const share = Math.min(0.5, (limit / bytes) * 0.9);
      let shortened = false;
      stringNodes(root.value).forEach((node, i) => {
        const floor = node.untrusted ? 64 : 256;
        const current = node.get();
        if (current.length <= floor) return;
        const key = `${i}`;
        const g = counts.get(key) ?? graphemeCount(current);
        if (g <= floor) return;
        const target = Math.max(floor, Math.floor(g * share));
        node.set(truncateGraphemes(current, target));
        counts.set(key, target);
        shortened = true;
      });
      if (!shortened) break;
      text = JSON.stringify(root.value);
      bytes = byteLength(text);
    }
    // 2. Drop the tail of the largest lists.
    for (let pass = 0; pass < 400 && bytes > limit; pass++) {
      const lists = arrays(root.value).filter((a) => a.length > 1);
      if (lists.length === 0) break;
      let largest = lists[0];
      let largestSize = -1;
      for (const list of lists) {
        const size = JSON.stringify(list).length;
        if (size > largestSize) {
          largest = list;
          largestSize = size;
        }
      }
      // Cut in proportion to the overshoot (at least a quarter), so a long list needs few passes.
      const keepShare = Math.min(0.75, Math.max(0.05, (limit / bytes) * 0.9));
      largest.splice(Math.max(1, Math.floor(largest.length * keepShare)));
      text = JSON.stringify(root.value);
      bytes = byteLength(text);
    }
    if (objectRoot) {
      (root.value as Record<string, Json>).truncated = true;
      text = JSON.stringify(root.value);
      bytes = byteLength(text);
    }
    if (bytes > maxBytes) {
      root.value = { truncated: true, note: "The result was too large to show. Ask for fewer items." };
      text = JSON.stringify(root.value);
      bytes = byteLength(text);
    }
  }
  return { payload: root.value, bytes, truncated, wrapped };
}
