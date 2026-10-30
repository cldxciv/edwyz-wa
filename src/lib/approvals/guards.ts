import { createHmac, timingSafeEqual } from "node:crypto";
import { createLimiter } from "@/lib/ratelimit";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const isWellFormedToken = (t: unknown): t is string => typeof t === "string" && TOKEN_PATTERN.test(t);

export const decideIpLimiter = createLimiter(20, 15 * 60 * 1000, "approval-decide-ip");
export const decideTokenLimiter = createLimiter(10, 60 * 60 * 1000, "approval-decide-token");
export const viewIpLimiter = createLimiter(120, 5 * 60 * 1000, "approval-view-ip");
export const resendUserLimiter = createLimiter(10, 60 * 60 * 1000, "approval-resend-user");

const NONCE_TTL_MS = 2 * 60 * 60 * 1000;
const usedNonces = new Map<string, number>();

export function resetApprovalLimits() {
  decideIpLimiter.clear();
  decideTokenLimiter.clear();
  viewIpLimiter.clear();
  resendUserLimiter.clear();
  usedNonces.clear();
}

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error("SESSION_SECRET must be set to a random string of at least 32 characters");
  return s;
}

const mac = (tokenHash: string, ts: string) => createHmac("sha256", secret()).update(`approval-nonce|${tokenHash}|${ts}`).digest("base64url");

/** Form nonce bound to one approval link and a time window; consumed on first successful use. */
export function createNonce(tokenHash: string, now = Date.now()): string {
  const ts = String(now);
  return `${ts}.${mac(tokenHash, ts)}`;
}

export function consumeNonce(tokenHash: string, nonce: string, now = Date.now()): boolean {
  const [ts, sig, extra] = nonce.split(".");
  if (!ts || !sig || extra !== undefined || !/^\d{10,16}$/.test(ts)) return false;
  const age = now - Number(ts);
  if (age < 0 || age > NONCE_TTL_MS) return false;
  const given = Buffer.from(sig);
  const expected = Buffer.from(mac(tokenHash, ts));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
  for (const [k, exp] of usedNonces) if (exp <= now) usedNonces.delete(k);
  if (usedNonces.has(nonce)) return false;
  usedNonces.set(nonce, now + NONCE_TTL_MS);
  return true;
}
