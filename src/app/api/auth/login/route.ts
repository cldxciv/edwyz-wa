import { createHash } from "node:crypto";
import { audit } from "@/lib/auth/audit";
import { authCookies } from "@/lib/auth/cookies";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { email, jsonWithCookies, password, readJson } from "@/lib/auth/http";
import { hashPassword, needsRehash, verifyPassword } from "@/lib/auth/password";
import { checkLoginLimits, clearLoginLimit, clientIp } from "@/lib/auth/ratelimit";
import { ACCOUNT_DISABLED, createSession, hashToken, signAccessToken } from "@/lib/auth/tokens";
import { prisma } from "@/lib/db";
import { HttpError, errorResponse } from "@/lib/tenancy";

let dummyHash: Promise<string> | null = null;
const BAD = "That email and password combination did not work. Check them and try again.";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const body = await readJson(request);
    const mail = email(body);
    const pass = password(body);
    const ip = clientIp(request);
    await checkLoginLimits(ip, mail);

    const user = await prisma.user.findUnique({ where: { email: mail } });
    dummyHash ??= hashPassword("not-a-real-password");
    const ok = await verifyPassword(pass, user ? user.passwordHash : await dummyHash);
    if (!user || !ok) {
      await audit({ userId: user?.id ?? null, action: "auth.login_failed", meta: { emailHash: createHash("sha256").update(mail).digest("hex").slice(0, 12) } });
      throw new HttpError(401, BAD);
    }

    // Checked only after the password matched, so it does not tell a stranger which emails have accounts. Without this a disabled
    // account got cookies that every page then refused, and the app bounced between /app and /api/auth/continue for ever.
    if (user.disabledAt) {
      await audit({ userId: user.id, action: "auth.login_refused", meta: { reason: "disabled" } });
      throw new HttpError(403, ACCOUNT_DISABLED);
    }
    // The oldest workspace that still exists: a deleted one must not pin the session where every request is refused.
    const membership = await prisma.membership.findFirst({ where: { userId: user.id, tenant: { deletedAt: null } }, orderBy: { createdAt: "asc" } });
    if (!membership) throw new HttpError(403, "This account is not part of a workspace yet. Ask a workspace owner for an invite.");

    await clearLoginLimit(mail, ip);
    if (needsRehash(user.passwordHash)) {
      await hashPassword(pass)
        .then((passwordHash) => prisma.user.update({ where: { id: user.id }, data: { passwordHash } }))
        .catch(() => undefined);
    }
    const refresh = await createSession(user.id, membership.tenantId, request.headers.get("user-agent"));
    await audit({ tenantId: membership.tenantId, userId: user.id, action: "auth.login" });
    const access = signAccessToken({ sub: user.id, tid: membership.tenantId, role: membership.role, sid: hashToken(refresh) });
    return jsonWithCookies(
      { user: { id: user.id, email: user.email, name: user.name }, tenantId: membership.tenantId, role: membership.role },
      authCookies(access, refresh),
    );
  } catch (e) {
    return errorResponse(e);
  }
}
