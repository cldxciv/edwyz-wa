import { createLimiter } from "@/lib/ratelimit";

const WINDOW = 15 * 60 * 1000;
export const forgotIpLimiter = createLimiter(10, WINDOW, "forgot-ip");
export const forgotEmailLimiter = createLimiter(3, WINDOW, "forgot-email");
export const verifyLimiter = createLimiter(20, WINDOW, "verify-ip");
export const resetLimiter = createLimiter(10, WINDOW, "reset-ip");
export const resendLimiter = createLimiter(3, 60 * 60 * 1000, "resend-user");

export async function resetEmailLimits(): Promise<void> {
  await Promise.all([forgotIpLimiter, forgotEmailLimiter, verifyLimiter, resetLimiter, resendLimiter].map((l) => l.clear()));
}
