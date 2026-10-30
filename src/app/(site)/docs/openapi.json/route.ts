import { buildOpenApi } from "@/lib/compat/openapi";
import { siteUrl } from "@/lib/config";

export const dynamic = "force-dynamic";

/** The public API as an OpenAPI 3.1 document, generated from the same table that registers the routes. */
export function GET() {
  return Response.json(buildOpenApi(siteUrl()), { headers: { "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" } });
}
