import { NextResponse, type NextRequest } from "next/server";
import { siteUrl } from "@/lib/config";
import { getRequestId, REQUEST_ID_HEADER } from "@/lib/log";
import { CSP_REPORT_PATH, cspHeaders, cspMode, generateNonce } from "@/lib/security/csp";

/**
 * Runs for page requests: attaches a request id, a per-request CSP nonce (policy mode from CSP_MODE) and, under /app
 * and /admin, the requested path so server-rendered pages can return to it after renewing a session.
 */
export function proxy(request: NextRequest) {
  const requestId = getRequestId(request.headers);
  const csp = cspHeaders(cspMode(), generateNonce(), {
    dev: process.env.NODE_ENV !== "production",
    reportUrl: `${siteUrl()}${CSP_REPORT_PATH}`,
  });

  const headers = new Headers(request.headers);
  headers.set(REQUEST_ID_HEADER, requestId);
  for (const [name, value] of Object.entries(csp.request)) headers.set(name, value);
  const { pathname, search } = request.nextUrl;
  if (pathname === "/app" || pathname.startsWith("/app/") || pathname === "/admin" || pathname.startsWith("/admin/")) {
    headers.set("x-pathname", pathname + search);
  }

  const response = NextResponse.next({ request: { headers } });
  response.headers.set(REQUEST_ID_HEADER, requestId);
  for (const [name, value] of Object.entries(csp.response)) response.headers.set(name, value);
  return response;
}

export const config = {
  matcher: ["/((?!api|webhooks|health|_next/static|_next/image|.*\\..*).*)"],
};
