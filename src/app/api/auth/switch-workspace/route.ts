import { audit } from "@/lib/auth/audit";
import { getActor } from "@/lib/auth";
import { accessCookie, readCookie, REFRESH_COOKIE } from "@/lib/auth/cookies";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { jsonWithCookies, readJson, str } from "@/lib/auth/http";
import { hashToken, signAccessToken } from "@/lib/auth/tokens";
import { prisma } from "@/lib/db";
import { HttpError, errorResponse } from "@/lib/tenancy";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    const tenantId = str(await readJson(request), "tenantId", "Workspace", 100);
    const membership = await prisma.membership.findUnique({ where: { tenantId_userId: { tenantId, userId: actor.userId } } });
    if (!membership) throw new HttpError(403, "You are not a member of that workspace.");

    const refresh = readCookie(request, REFRESH_COOKIE);
    if (refresh) {
      await prisma.session.updateMany({
        where: { refreshTokenHash: hashToken(refresh), userId: actor.userId, revokedAt: null },
        data: { tenantId },
      });
    }
    await audit({ tenantId, userId: actor.userId, action: "auth.workspace_switched", meta: { from: actor.tenantId } });
    const access = signAccessToken({ sub: actor.userId, tid: tenantId, role: membership.role, sid: refresh ? hashToken(refresh) : undefined });
    return jsonWithCookies({ tenantId, role: membership.role }, [accessCookie(access)]);
  } catch (e) {
    return errorResponse(e);
  }
}
