import { audit } from "@/lib/auth/audit";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { type Actor, errorResponse, HttpError } from "@/lib/tenancy";
import { requirePlatformAdmin } from "./auth";

const MAX_BODY_BYTES = 32 * 1024;
const NO_STORE = { "cache-control": "no-store", "x-robots-tag": "noindex" };

export async function readBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, "The request is too large.");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpError(400, "The request body must be valid JSON.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "The request body must be a JSON object.");
  return body as Record<string, unknown>;
}

export type AdminCtx = { actor: Actor; email: string; request: Request };

/** Wraps an admin route: same-origin check on mutations, then the full admin rule (allowlist, verified email, TOTP step-up), then the handler. */
export async function handleAdmin(request: Request, mutating: boolean, fn: (ctx: AdminCtx) => Promise<unknown>, auditAction?: string): Promise<Response> {
  try {
    const { actor, email } = await requirePlatformAdmin(request);
    if (mutating) assertSameOrigin(request);
    if (auditAction) await audit({ userId: actor.userId, action: auditAction });
    const result = await fn({ actor, email, request });
    return result instanceof Response ? result : Response.json(result, { headers: NO_STORE });
  } catch (e) {
    return errorResponse(e);
  }
}

/**
 * The answer for a method an admin route does not implement. Next would answer such a request with 405 before any check ran, which
 * tells every signed-in customer that the route exists. Routes export this for their other methods so a non-admin gets the same 404 as anywhere else.
 */
export function adminMethodNotAllowed(request: Request): Promise<Response> {
  return handleAdmin(request, false, async () => {
    throw new HttpError(405, "Method not allowed.");
  });
}

export function str(body: Record<string, unknown>, key: string, label: string, max = 200, required = true): string {
  const v = body[key];
  if (v === undefined || v === null || v === "") {
    if (required) throw new HttpError(400, `${label} is required.`);
    return "";
  }
  if (typeof v !== "string") throw new HttpError(400, `${label} is not valid.`);
  const t = v.trim();
  if (required && !t) throw new HttpError(400, `${label} is required.`);
  if (t.length > max) throw new HttpError(400, `${label} is too long.`);
  return t;
}

export function int(body: Record<string, unknown>, key: string, label: string, min: number, max: number): number {
  const v = body[key];
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${label} must be a whole number between ${min} and ${max}.`);
  return n;
}

export function optInt(body: Record<string, unknown>, key: string, label: string, min: number, max: number): number | null {
  const v = body[key];
  if (v === undefined || v === null || v === "") return null;
  return int(body, key, label, min, max);
}

/** Destructive actions need the exact name typed back. */
export function requireConfirmation(expected: string, typed: unknown): void {
  if (typeof typed !== "string" || typed.trim() !== expected.trim() || !expected.trim()) {
    throw new HttpError(400, "Type the exact name to confirm this action.");
  }
}

export function requireReason(body: Record<string, unknown>): string {
  return str(body, "reason", "Reason", 300);
}
