import { clientIp } from "@/lib/net/ip";
import { createLimiter } from "@/lib/ratelimit";
import { HttpError } from "@/lib/tenancy";

const WINDOW = 15 * 60 * 1000;
const ipLimiter = createLimiter(30, WINDOW, "login-ip");
const pairLimiter = createLimiter(10, WINDOW, "login-pair");
const emailCeiling = createLimiter(100, WINDOW, "login-email");
const SIGNUP_WINDOW = 60 * 60 * 1000;
const signupIpLimiter = createLimiter(8, SIGNUP_WINDOW, "signup-ip");

export { clientIp };

const pairKey = (ip: string, email: string) => `${ip}|${email}`;

/**
 * Per-IP and per-(email, IP) buckets stop one source from guessing; the much higher per-email ceiling only caps
 * distributed attacks, so a stranger cannot lock the real owner out with a handful of requests.
 */
export async function checkLoginLimits(ip: string, email: string): Promise<void> {
  const [a, b, c] = await Promise.all([ipLimiter.consumeShared(ip), pairLimiter.consumeShared(pairKey(ip, email)), emailCeiling.consumeShared(email)]);
  if (!a || !b || !c) throw new HttpError(429, "Too many attempts. Please wait a few minutes and try again.");
}

/** Every signup costs a password hash and a trial, so one address cannot create workspaces without limit. */
export async function checkSignupLimit(ip: string): Promise<void> {
  if (!(await signupIpLimiter.consumeShared(ip))) throw new HttpError(429, "Too many sign-ups from this connection. Please wait an hour and try again, or contact support.");
}

export async function clearLoginLimit(email: string, ip?: string): Promise<void> {
  if (ip) await pairLimiter.reset(pairKey(ip, email));
}

export async function resetLoginLimits(): Promise<void> {
  await Promise.all([ipLimiter.clear(), pairLimiter.clear(), emailCeiling.clear(), signupIpLimiter.clear()]);
}
