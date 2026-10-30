import { authCookies, clearCookies, readCookie, REFRESH_COOKIE } from "@/lib/auth/cookies";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { jsonWithCookies } from "@/lib/auth/http";
import { hashToken, rotateRefreshToken, signAccessToken } from "@/lib/auth/tokens";
import { HttpError, errorResponse } from "@/lib/tenancy";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const token = readCookie(request, REFRESH_COOKIE);
    if (!token) throw new HttpError(401, "Not signed in.");
    let rotated;
    try {
      rotated = await rotateRefreshToken(token, request.headers.get("user-agent"));
    } catch (e) {
      if (e instanceof HttpError) {
        const res = errorResponse(e);
        for (const c of clearCookies()) res.headers.append("set-cookie", c);
        return res;
      }
      throw e;
    }
    const access = signAccessToken({ sub: rotated.userId, tid: rotated.tenantId, role: rotated.role, sid: hashToken(rotated.refreshToken) });
    return jsonWithCookies({ tenantId: rotated.tenantId, role: rotated.role }, authCookies(access, rotated.refreshToken));
  } catch (e) {
    return errorResponse(e);
  }
}
