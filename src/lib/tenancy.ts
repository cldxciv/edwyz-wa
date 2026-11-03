import { getRequestId, log, newRequestId, REQUEST_ID_HEADER } from "@/lib/log";
import type { Role } from "@/generated/prisma/client";

/** The authenticated caller. Produced by the auth module (src/lib/auth/*) and consumed by every tenant-scoped route. */
export type Actor = { userId: string; tenantId: string; role: Role };

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export const ROLE_RANK: Record<Role, number> = { agent: 1, admin: 2, owner: 3 };

export function hasRole(actor: Actor, minimum: Role): boolean {
  return ROLE_RANK[actor.role] >= ROLE_RANK[minimum];
}

/**
 * Resolves the caller from the request (session cookie or API key) or throws HttpError(401).
 * Implemented in src/lib/auth/index.ts by the auth module; other modules import it from "@/lib/auth".
 */
export type GetActor = (request: Request) => Promise<Actor>;

export function requireRole(actor: Actor, minimum: Role): void {
  if (!hasRole(actor, minimum)) throw new HttpError(403, "You do not have permission to do this.");
}

/**
 * Converts a thrown HttpError (or unknown error) into a JSON Response. Use in every route handler.
 * An unexpected error is logged as `api.unexpected` through @/lib/log (class name and code, a scrubbed message, never a Prisma
 * message, and the error tracker sees it too) with a request id that is also sent back in the x-request-id header, so the
 * "Something went wrong." a customer reports can be found in the logs. Pass the request when the handler has it: the line then
 * carries the method, the path and the id nginx set, instead of a fresh one.
 */
export function errorResponse(error: unknown, request?: Request): Response {
  if (error instanceof HttpError) return Response.json({ error: error.message }, { status: error.status });
  const reqId = request ? getRequestId(request) : newRequestId();
  log.error("api.unexpected", { err: error, reqId, ...(request ? { method: request.method, path: pathOf(request) } : {}) });
  return Response.json({ error: "Something went wrong." }, { status: 500, headers: { [REQUEST_ID_HEADER]: reqId } });
}

/** The path without the query string, which can carry a token. */
function pathOf(request: Request): string | undefined {
  try {
    return new URL(request.url).pathname;
  } catch {
    return undefined;
  }
}
