import { createHmac, timingSafeEqual } from "node:crypto";
import { readCookie } from "@/lib/auth/cookies";

export const ADMIN_COOKIE = "wa_admin";
export const STEPUP_TTL_SECONDS = 30 * 60;

function key(): Buffer {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) throw new Error("SESSION_SECRET is not configured");
  return createHmac("sha256", s).update("admin-stepup-v1").digest();
}

const sign = (data: string) => createHmac("sha256", key()).update(data).digest("base64url");

/** Signed value bound to the user id: `<userId>.<expiresAtSeconds>.<signature>`. */
export function signStepUp(userId: string, nowMs = Date.now()): string {
  const body = `${userId}.${Math.floor(nowMs / 1000) + STEPUP_TTL_SECONDS}`;
  return `${body}.${sign(body)}`;
}

export function verifyStepUp(value: string | null | undefined, userId: string, nowMs = Date.now()): boolean {
  if (!value) return false;
  const parts = value.split(".");
  if (parts.length !== 3) return false;
  const [uid, exp, sig] = parts;
  if (uid !== userId || !/^\d+$/.test(exp) || Number(exp) * 1000 <= nowMs) return false;
  const expected = Buffer.from(sign(`${uid}.${exp}`));
  const given = Buffer.from(sig);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function stepUpFromRequest(request: Request, userId: string): boolean {
  try {
    return verifyStepUp(readCookie(request, ADMIN_COOKIE), userId);
  } catch {
    return false;
  }
}

export function stepUpCookie(userId: string): string {
  const parts = [`${ADMIN_COOKIE}=${signStepUp(userId)}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${STEPUP_TTL_SECONDS}`];
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  return parts.join("; ");
}
