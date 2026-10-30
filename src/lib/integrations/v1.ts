import { assertTenantCanWrite } from "@/lib/billing";
import { readJsonLimited } from "@/lib/http/body";
import { type Actor, errorResponse } from "@/lib/tenancy";
import { type ApiScope, requireApiKey } from "./apikeys";

export const V1_BODY_LIMIT = 64 * 1024;
const headers = { "Cache-Control": "no-store" };

type Handler = (ctx: { actor: Actor; request: Request; body: () => Promise<Record<string, unknown>> }) => Promise<{ status?: number; json: unknown }>;

/** Authenticates by API key only (cookies are ignored), enforces scope, rate limit and, for writes, the billing paywall. */
export async function v1(request: Request, scope: ApiScope | readonly ApiScope[], write: boolean, handler: Handler): Promise<Response> {
  try {
    const { actor } = await requireApiKey(request, scope);
    if (write) await assertTenantCanWrite(actor.tenantId);
    const result = await handler({ actor, request, body: () => readJsonLimited(request, V1_BODY_LIMIT) });
    return Response.json(result.json, { status: result.status ?? 200, headers });
  } catch (e) {
    const res = errorResponse(e);
    res.headers.set("Cache-Control", "no-store");
    if (res.status === 429) res.headers.set("Retry-After", "60");
    return res;
  }
}
