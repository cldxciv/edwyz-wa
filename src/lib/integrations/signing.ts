import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** sha256= HMAC over `${timestamp}.${body}`. The timestamp is in seconds since the epoch, as a string. */
export function signPayload(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`, "utf8").digest("hex")}`;
}

/** For customers' receivers (and our tests): checks the signature in constant time and rejects stale timestamps. */
export function verifySignature(secret: string, timestamp: string, body: string, signature: string, toleranceSeconds = 300, nowMs = Date.now()): boolean {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowMs / 1000 - ts) > toleranceSeconds) return false;
  const expected = Buffer.from(signPayload(secret, timestamp, body));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export const generateSigningSecret = () => `whsec_${randomBytes(32).toString("base64url")}`;
