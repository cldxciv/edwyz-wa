import { COMPAT_BASE_PATH } from "@/lib/compat/spec";

// Catch-all for API paths that do not exist. Without it Next answers a mistyped address like /api/contact with the HTML "page not
// found" screen, and a client calling res.json() gets a parse error instead of a message. Real routes are more specific, so they win.
export const dynamic = "force-dynamic";

const headers = { "Cache-Control": "no-store" };

function notFound(request: Request) {
  const { pathname } = new URL(request.url);
  // The public API (/docs/errors) promises one error shape on every path under it, including the ones that do not exist.
  if (pathname === COMPAT_BASE_PATH || pathname.startsWith(`${COMPAT_BASE_PATH}/`)) {
    const error = { code: "not_found", message: "No such endpoint. The list of endpoints is at /docs/endpoints." };
    return Response.json({ ok: false, error, timestamp: new Date().toISOString() }, { status: 404, headers });
  }
  return Response.json({ error: "Not found." }, { status: 404, headers });
}

export const GET = notFound;
export const HEAD = notFound;
export const POST = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
export const OPTIONS = notFound;
