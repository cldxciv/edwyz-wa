import { assertTenantCanWrite } from "@/lib/billing";
import { createLimiter } from "@/lib/ratelimit";
import { readJsonLimited } from "@/lib/http/body";
import { authenticateApiKey } from "@/lib/integrations/apikeys";
import { assertScope } from "@/lib/integrations/scopes";
import { describeError } from "@/lib/safe-error";
import { type Actor, HttpError } from "@/lib/tenancy";
import { endpointById, endpointScopes, ERROR_CODES, type EndpointId, isWrite, RATE_LIMIT_REQUESTS, RATE_LIMIT_WINDOW_SECONDS } from "./spec";

export const BODY_LIMIT = 64 * 1024;

const limiter = createLimiter(RATE_LIMIT_REQUESTS, RATE_LIMIT_WINDOW_SECONDS * 1000, "compat-token");
export const resetCompatLimits = () => limiter.clear();

export type Ctx = {
  actor: Actor;
  keyId: string;
  request: Request;
  query: URLSearchParams;
  params: Record<string, string>;
  body: () => Promise<Record<string, unknown>>;
};
export type Result = { status?: number; json: Record<string, unknown> };
export type Handler = (ctx: Ctx) => Promise<Result>;

const codeFor = (status: number) => ERROR_CODES.find((c) => c.status === status)?.code ?? (status >= 500 ? "internal_error" : "invalid_request");

export function errorBody(status: number, message: string) {
  return { ok: false, error: { code: codeFor(status), message }, timestamp: new Date().toISOString() };
}

function failure(e: unknown): Response {
  let status = 500;
  let message = "Something went wrong.";
  if (e instanceof HttpError) {
    status = e.status;
    message = e.message;
  } else {
    console.error("[compat] unexpected error:", describeError(e));
  }
  const headers = new Headers({ "Cache-Control": "no-store" });
  if (status === 429) headers.set("Retry-After", String(RATE_LIMIT_WINDOW_SECONDS));
  return Response.json(errorBody(status, message), { status, headers });
}

/** Authenticates by API key only, then applies the per-key window, the endpoint's scope and, for writes, the billing paywall. */
export async function run(id: EndpointId, handler: Handler, request: Request, params: Record<string, string>): Promise<Response> {
  try {
    const spec = endpointById(id);
    const auth = await authenticateApiKey(request);
    if (!auth) throw new HttpError(401, "Invalid or missing API token. Send Authorization: Bearer <token>.");
    if (!limiter.consume(auth.keyId)) throw new HttpError(429, `Rate limit exceeded: ${RATE_LIMIT_REQUESTS} requests per ${RATE_LIMIT_WINDOW_SECONDS} seconds per token.`);
    assertScope(auth.scopes, endpointScopes(spec));
    if (isWrite(spec)) await assertTenantCanWrite(auth.actor.tenantId);
    const result = await handler({
      actor: auth.actor,
      keyId: auth.keyId,
      request,
      query: new URL(request.url).searchParams,
      params,
      body: () => readJsonLimited(request, BODY_LIMIT),
    });
    return Response.json({ ok: true, ...result.json }, { status: result.status ?? 200, headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return failure(e);
  }
}
