import { getActor } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { requireRole, type Actor } from "@/lib/tenancy";

/** CSRF check, authentication and the admin role, in that order. Every state-changing content route starts here. */
export async function writeActor(request: Request): Promise<Actor> {
  assertSameOrigin(request);
  const actor = await getActor(request);
  requireRole(actor, "admin");
  return actor;
}

export const noStore = { "cache-control": "no-store" };
