import { describeError } from "@/lib/safe-error";
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

/** Converts a thrown HttpError (or unknown error) into a JSON Response. Use in every route handler. */
export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) return Response.json({ error: error.message }, { status: error.status });
  console.error("[api] unexpected error:", describeError(error));
  return Response.json({ error: "Something went wrong." }, { status: 500 });
}
