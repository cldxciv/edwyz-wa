import { createHmac, randomBytes } from "node:crypto";
import { safeEqual } from "@/lib/meta";

const sign = (value: string, secret: string) => createHmac("sha256", secret).update(value).digest("hex");

/** Creates a short-lived signed CSRF state for the Embedded Signup redirect. */
export function createState(secret: string, now = Date.now()): string {
  const body = `${randomBytes(16).toString("hex")}.${now}`;
  return `${body}.${sign(body, secret)}`;
}

export function verifyState(state: string | undefined, secret: string | undefined, now = Date.now(), maxAgeMs = 10 * 60_000): boolean {
  if (!state || !secret) return false;
  const parts = state.split(".");
  if (parts.length !== 3) return false;
  const [nonce, issuedAt, signature] = parts;
  if (!/^[0-9a-f]{32}$/.test(nonce) || !/^\d+$/.test(issuedAt)) return false;
  if (!safeEqual(signature, sign(`${nonce}.${issuedAt}`, secret))) return false;
  const age = now - Number(issuedAt);
  return age >= 0 && age <= maxAgeMs;
}
