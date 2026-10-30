// Catch-all for API paths that do not exist. Without it Next answers a mistyped address like /api/contact with the HTML "page not
// found" screen, and a client calling res.json() gets a parse error instead of a message. Real routes are more specific, so they win.
export const dynamic = "force-dynamic";

const notFound = (_request: Request) => Response.json({ error: "Not found." }, { status: 404, headers: { "Cache-Control": "no-store" } });

export const GET = notFound;
export const HEAD = notFound;
export const POST = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
export const OPTIONS = notFound;
