import { SAME_PASSWORD, WRONG_CURRENT_PASSWORD, type PasswordField } from "@/components/account/account-helpers";
import { getActor } from "@/lib/auth";
import { audit } from "@/lib/auth/audit";
import { authCookies } from "@/lib/auth/cookies";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { jsonWithCookies, password, readJson } from "@/lib/auth/http";
import { assertPasswordPolicy, hashPassword, verifyPassword } from "@/lib/auth/password";
import { createSession, hashToken, signAccessToken } from "@/lib/auth/tokens";
import { prisma } from "@/lib/db";
import { sendPasswordChangedEmail } from "@/lib/email/flows";
import { createLimiter } from "@/lib/ratelimit";
import { HttpError, errorResponse } from "@/lib/tenancy";

// Each attempt runs the deliberately slow password check, and a wrong current password is what a stolen session would try.
const limiter = createLimiter(5, 15 * 60 * 1000, "account-password");

/** A refusal the account page shows under the form field it names (see passwordRefusal), not as a toast. */
const refuse = (status: number, error: string, field: PasswordField) => Response.json({ error, field }, { status });

/** The password policy's refusal as text, or null when the new password is acceptable. */
function policyProblem(value: string): string | null {
  try {
    assertPasswordPolicy(value);
    return null;
  } catch (e) {
    if (e instanceof HttpError) return e.message;
    throw e;
  }
}

/**
 * Changes the signed-in member's own password. Body: { currentPassword, newPassword }. Works without email (forgot-password needs
 * SMTP). Every session of the account is signed out, other devices included, and this browser gets a fresh one so it stays signed in.
 */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    if (!(await limiter.consumeShared(actor.userId))) throw new HttpError(429, "Too many attempts. Please wait a few minutes and try again.");
    const body = await readJson(request);
    const current = password(body, "currentPassword");
    const next = password(body, "newPassword");
    const problem = policyProblem(next) ?? (next === current ? SAME_PASSWORD : null);
    if (problem) return refuse(400, problem, "newPassword");

    const user = await prisma.user.findUnique({ where: { id: actor.userId }, select: { id: true, email: true, name: true, passwordHash: true } });
    if (!user) throw new HttpError(401, "Not signed in.");
    // 403, not 401: the person is signed in, only the password they typed is wrong.
    if (!(await verifyPassword(current, user.passwordHash))) return refuse(403, WRONG_CURRENT_PASSWORD, "currentPassword");

    const passwordHash = await hashPassword(next);
    const now = new Date();
    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { passwordHash } });
      // Sessions in their rotation grace (revokedAt still in the future) still mint access tokens, so they end now too.
      await tx.session.updateMany({ where: { userId: user.id, OR: [{ revokedAt: null }, { revokedAt: { gt: now } }] }, data: { revokedAt: now } });
    });
    const refresh = await createSession(user.id, actor.tenantId, request.headers.get("user-agent"));
    await audit({ tenantId: actor.tenantId, userId: user.id, action: "auth.password_changed" });
    await sendPasswordChangedEmail(user).catch(() => console.error("[auth] could not queue the password changed email"));

    const access = signAccessToken({ sub: user.id, tid: actor.tenantId, role: actor.role, sid: hashToken(refresh) });
    return jsonWithCookies({ ok: true }, authCookies(access, refresh));
  } catch (e) {
    return errorResponse(e);
  }
}
