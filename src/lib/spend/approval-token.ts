/**
 * Approval tokens and fingerprints (docs/SPEND-CONTROLS-SPEC.md 7.3). Pure apart from the random bytes: no database.
 *
 * - The token is 32 random bytes in base64url (43 characters). It goes into the one-tap link (/s/<token>) and is shown to
 *   nobody else; only its SHA-256 (hex) is stored in SpendApproval.tokenHash. It is single use and valid until expiresAt.
 * - The fingerprint is the SHA-256 of a canonical JSON of the exact intent, the current budget and status of every object
 *   the intent touches, and the allowance version. Approving re-computes it: a mismatch means "The ad set changed since this
 *   was asked." (7.3), and the approval fails instead of applying something nobody saw.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const APPROVAL_TOKEN_BYTES = 32;
/** base64url of 32 bytes, no padding. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export type ApprovalToken = { token: string; tokenHash: string };

/** A new single-use token and the hash to store. The token itself is never stored. */
export function newApprovalToken(random: (size: number) => Buffer = randomBytes): ApprovalToken {
  const token = random(APPROVAL_TOKEN_BYTES).toString("base64url");
  return { token, tokenHash: hashApprovalToken(token) };
}

/** True for something shaped like a token we issued (checked before any database read). */
export function isApprovalTokenShape(value: unknown): value is string {
  return typeof value === "string" && TOKEN_SHAPE.test(value);
}

/** The stored form of a token: SHA-256, lowercase hex. */
export function hashApprovalToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Constant-time comparison of a presented token with a stored hash. */
export function tokenMatchesHash(token: string, tokenHash: string): boolean {
  if (!isApprovalTokenShape(token) || !/^[0-9a-f]{64}$/.test(tokenHash)) return false;
  const a = Buffer.from(hashApprovalToken(token), "hex");
  const b = Buffer.from(tokenHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Canonical JSON: object keys sorted (NFC), strings NFC, bigint as a decimal string, Date as ISO, undefined dropped, arrays
 * in order. NaN and Infinity are refused, so two equal intents always give the same text.
 */
export function canonicalJson(value: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): string => {
    if (v === null || v === undefined) return "null";
    if (typeof v === "bigint") return JSON.stringify(v.toString());
    if (typeof v === "number") {
      if (!Number.isFinite(v)) throw new RangeError("A fingerprint cannot hold NaN or Infinity.");
      return JSON.stringify(v);
    }
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "string") return JSON.stringify(v.normalize("NFC"));
    if (v instanceof Date) {
      if (Number.isNaN(v.getTime())) throw new RangeError("A fingerprint cannot hold an invalid date.");
      return JSON.stringify(v.toISOString());
    }
    if (typeof v === "object") {
      if (seen.has(v)) throw new RangeError("A fingerprint cannot hold a cycle.");
      seen.add(v);
      try {
        if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? "null" : walk(x))).join(",")}]`;
        const entries = Object.entries(v as Record<string, unknown>)
          .filter(([, x]) => x !== undefined && typeof x !== "function")
          .map(([k, x]) => [k.normalize("NFC"), x] as const)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${walk(x)}`).join(",")}}`;
      } finally {
        seen.delete(v);
      }
    }
    return "null";
  };
  return walk(value);
}

/** The current state of one object the intent touches, as it was when the approval was asked for. */
export type FingerprintObject = {
  metaObjectId: string;
  status: string | null;
  dailyBudgetMinor: bigint | null;
  lifetimeBudgetMinor?: bigint | null;
  endsAt?: Date | null;
};

export type FingerprintInput = {
  intent: unknown;
  objects: FingerprintObject[];
  /** SpendAllowance.version of the pot (0 when no row exists). */
  allowanceVersion: number;
};

/** SHA-256 (hex) of the canonical intent, the objects' budgets and statuses, and the allowance version. Order-independent in objects. */
export function approvalFingerprint(input: FingerprintInput): string {
  const objects = [...input.objects]
    .map((o) => ({
      metaObjectId: o.metaObjectId,
      status: o.status ?? null,
      dailyBudgetMinor: o.dailyBudgetMinor ?? null,
      lifetimeBudgetMinor: o.lifetimeBudgetMinor ?? null,
      endsAt: o.endsAt ?? null,
    }))
    .sort((a, b) => (a.metaObjectId < b.metaObjectId ? -1 : a.metaObjectId > b.metaObjectId ? 1 : 0));
  const text = canonicalJson({ v: 1, intent: input.intent, objects, allowanceVersion: input.allowanceVersion });
  return createHash("sha256").update(text, "utf8").digest("hex");
}
