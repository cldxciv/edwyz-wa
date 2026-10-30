/**
 * Canonical JSON and sha256 for the action layer (docs/EDDY-SPEC.md 4.2, 4.3 G3, 4.5): argsHash, previewHash and the
 * toolset hash. The same value always gives the same bytes, whatever the key order or the Unicode normalisation of its
 * strings, so a card's previewHash survives a round trip through the database and the browser.
 *
 * Rules:
 * - object keys are NFC-normalised and sorted by code unit; undefined, function and symbol values are left out;
 * - strings are NFC-normalised; arrays keep their order (undefined and functions become null, as in JSON);
 * - Dates become ISO strings and bigints decimal strings (money is integer minor units);
 * - NaN, Infinity, cycles and two keys that are equal after NFC are refused, never silently changed.
 * Pure: node:crypto only.
 */
import { createHash } from "node:crypto";

export class CanonicalJsonError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalJsonError";
  }
}

const nfc = (s: string) => s.normalize("NFC");

function encode(value: unknown, seen: Set<object>, path: string): string | undefined {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(nfc(value));
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new CanonicalJsonError(`${path} is not a finite number.`);
      return JSON.stringify(Object.is(value, -0) ? 0 : value);
    case "bigint":
      return JSON.stringify(value.toString());
    case "undefined":
    case "function":
    case "symbol":
      return undefined;
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new CanonicalJsonError(`${path} is an invalid date.`);
    return JSON.stringify(value.toISOString());
  }
  const obj = value as object;
  if (seen.has(obj)) throw new CanonicalJsonError(`${path} refers to itself.`);
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      return `[${obj.map((item, i) => encode(item, seen, `${path}[${i}]`) ?? "null").join(",")}]`;
    }
    const withJson = obj as { toJSON?: () => unknown };
    if (typeof withJson.toJSON === "function") return encode(withJson.toJSON(), seen, path);
    const entries = new Map<string, string>();
    for (const rawKey of Object.keys(obj)) {
      const encoded = encode((obj as Record<string, unknown>)[rawKey], seen, `${path}.${rawKey}`);
      if (encoded === undefined) continue;
      const key = nfc(rawKey);
      if (entries.has(key)) throw new CanonicalJsonError(`${path} has two keys that read the same after normalisation ("${key}").`);
      entries.set(key, encoded);
    }
    const keys = [...entries.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${keys.map((k) => `${JSON.stringify(k)}:${entries.get(k)}`).join(",")}}`;
  } finally {
    seen.delete(obj);
  }
}

/** The canonical JSON text of a value. A value with nothing to encode (undefined, a function) gives "null". */
export function canonicalJson(value: unknown): string {
  return encode(value, new Set(), "value") ?? "null";
}

/** A plain, JSON-safe copy in canonical form (keys sorted, strings NFC): what the action layer stores as `args`. */
export function canonicalClone<T = unknown>(value: unknown): T {
  return JSON.parse(canonicalJson(value)) as T;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** sha256 of the canonical JSON of a value. */
export function hashCanonical(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/** ActionRecord.argsHash and ActionInvocation.argsHash. */
export const argsHash = (args: unknown): string => hashCanonical(args);

/** The card's previewHash: confirm must send it back unchanged (4.5). */
export const previewHash = (preview: unknown): string => hashCanonical(preview);
