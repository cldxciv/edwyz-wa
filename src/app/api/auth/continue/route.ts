import { siteUrl } from "@/lib/config";
import { authCookies, clearCookies, readCookie, REFRESH_COOKIE } from "@/lib/auth/cookies";
import { safeNext } from "@/lib/auth/next";
import { hashToken, rotateRefreshToken, signAccessToken } from "@/lib/auth/tokens";

export const dynamic = "force-dynamic";

function redirect(path: string, cookies: string[] = []) {
  const res = new Response(null, { status: 303, headers: { location: `${siteUrl()}${path}`, "cache-control": "no-store" } });
  for (const c of cookies) res.headers.append("set-cookie", c);
  return res;
}

/**
 * Renews an expired 15-minute sign-in from the long-lived refresh cookie, then returns to the page the visitor asked for.
 * Used by server-rendered pages, which cannot set cookies themselves.
 */
export async function GET(request: Request) {
  const next = safeNext(new URL(request.url).searchParams.get("next"));
  const fail = (cookies: string[] = []) =>
    next.startsWith("/admin")
      ? new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } })
      : redirect(`/login?next=${encodeURIComponent(next)}`, cookies);

  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return fail();

  const token = readCookie(request, REFRESH_COOKIE);
  if (!token) return fail();
  try {
    const rotated = await rotateRefreshToken(token, request.headers.get("user-agent"));
    const access = signAccessToken({ sub: rotated.userId, tid: rotated.tenantId, role: rotated.role, sid: hashToken(rotated.refreshToken) });
    return redirect(next, authCookies(access, rotated.refreshToken));
  } catch {
    return fail(clearCookies());
  }
}
