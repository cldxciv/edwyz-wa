import { assertSameOrigin } from "@/lib/auth/csrf";
import { readJson, str } from "@/lib/auth/http";
import { clientIp } from "@/lib/auth/ratelimit";
import { verifyLimiter } from "@/lib/email/limits";
import { prisma } from "@/lib/db";
import { consumeEmailToken } from "@/lib/email/tokens";
import { HttpError, errorResponse } from "@/lib/tenancy";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    if (!(await verifyLimiter.consumeShared(clientIp(request)))) throw new HttpError(429, "Too many attempts. Please wait a few minutes and try again.");
    const token = str(await readJson(request), "token", "Token", 200);
    const userId = await consumeEmailToken(token, "verify");
    if (!userId) throw new HttpError(400, "This confirmation link is invalid or has expired. Request a new one from your account.");
    await prisma.user.updateMany({ where: { id: userId, emailVerifiedAt: null }, data: { emailVerifiedAt: new Date() } });
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
