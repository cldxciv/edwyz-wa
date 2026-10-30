import { audit } from "@/lib/auth/audit";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { password, readJson, str } from "@/lib/auth/http";
import { assertPasswordPolicy, hashPassword } from "@/lib/auth/password";
import { clientIp } from "@/lib/auth/ratelimit";
import { resetLimiter } from "@/lib/email/limits";
import { prisma } from "@/lib/db";
import { queueEmail } from "@/lib/email";
import { passwordChangedTemplate } from "@/lib/email/templates";
import { consumeEmailToken } from "@/lib/email/tokens";
import { HttpError, errorResponse } from "@/lib/tenancy";

const INVALID = "This reset link is invalid or has expired. Request a new one.";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    if (!(await resetLimiter.consumeShared(clientIp(request)))) throw new HttpError(429, "Too many attempts. Please wait a few minutes and try again.");
    const body = await readJson(request);
    const token = str(body, "token", "Token", 200);
    const pass = password(body);
    assertPasswordPolicy(pass);

    const userId = await consumeEmailToken(token, "reset");
    if (!userId) throw new HttpError(400, INVALID);
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true, name: true, disabledAt: true, emailVerifiedAt: true } });
    if (!user || user.disabledAt) throw new HttpError(400, INVALID);

    const passwordHash = await hashPassword(pass);
    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { passwordHash, emailVerifiedAt: user.emailVerifiedAt ?? new Date() } });
      await tx.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
    });
    await audit({ userId: user.id, action: "auth.password_reset" });
    await queueEmail({ to: user.email, ...passwordChangedTemplate({ name: user.name }) });
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
