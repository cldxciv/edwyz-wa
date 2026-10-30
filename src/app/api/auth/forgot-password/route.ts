import { assertSameOrigin } from "@/lib/auth/csrf";
import { email, readJson } from "@/lib/auth/http";
import { clientIp } from "@/lib/auth/ratelimit";
import { RESET_EMAIL_UNAVAILABLE, emailConfigured } from "@/lib/email/availability";
import { forgotEmailLimiter, forgotIpLimiter } from "@/lib/email/limits";
import { processPasswordResetRequest } from "@/lib/email/flows";
import { HttpError, errorResponse } from "@/lib/tenancy";

const GENERIC = { ok: true, message: "If an account exists for that email, we have sent a link to reset the password." };

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    // Without SMTP nothing could be delivered: a reset token would be created and silently expire while the person waits for mail.
    if (!emailConfigured()) throw new HttpError(503, RESET_EMAIL_UNAVAILABLE);
    const mail = email(await readJson(request));
    const [a, b] = await Promise.all([forgotIpLimiter.consumeShared(clientIp(request)), forgotEmailLimiter.consumeShared(mail)]);
    if (!a || !b) throw new HttpError(429, "Too many requests. Please wait a few minutes and try again.");
    void processPasswordResetRequest(mail).catch(() => console.error("[auth] password reset request failed"));
    return Response.json(GENERIC, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
