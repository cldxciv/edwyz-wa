import { clearCookies, readCookie, REFRESH_COOKIE } from "@/lib/auth/cookies";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { jsonWithCookies } from "@/lib/auth/http";
import { revokeSessionByToken } from "@/lib/auth/tokens";
import { errorResponse } from "@/lib/tenancy";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const token = readCookie(request, REFRESH_COOKIE);
    if (token) await revokeSessionByToken(token);
    return jsonWithCookies({ ok: true }, clearCookies());
  } catch (e) {
    return errorResponse(e);
  }
}
