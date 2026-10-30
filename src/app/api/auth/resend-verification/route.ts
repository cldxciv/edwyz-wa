import { getActor } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { VERIFY_EMAIL_UNAVAILABLE, emailConfigured } from "@/lib/email/availability";
import { resendLimiter } from "@/lib/email/limits";
import { prisma } from "@/lib/db";
import { sendVerificationEmail } from "@/lib/email/flows";
import { HttpError, errorResponse } from "@/lib/tenancy";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    const user = await prisma.user.findUnique({ where: { id: actor.userId }, select: { id: true, email: true, name: true, emailVerifiedAt: true } });
    if (!user) throw new HttpError(401, "Not signed in.");
    if (user.emailVerifiedAt) return Response.json({ ok: true, alreadyVerified: true });
    // The gate can be forced on (EMAIL_VERIFICATION_REQUIRED=true) without SMTP; then "link sent" would be a lie and the person stays read-only.
    if (!emailConfigured()) throw new HttpError(503, VERIFY_EMAIL_UNAVAILABLE);
    if (!(await resendLimiter.consumeShared(user.id))) throw new HttpError(429, "A confirmation email was sent recently. Please check your inbox, or try again in a while.");
    await sendVerificationEmail(user);
    return Response.json({ ok: true, alreadyVerified: false });
  } catch (e) {
    return errorResponse(e);
  }
}
