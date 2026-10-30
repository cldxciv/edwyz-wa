import { getActor } from "@/lib/auth";
import { type Actor, requireRole } from "@/lib/tenancy";

export { assertSameOrigin } from "@/lib/auth/csrf";

/** Owner or admin of the session's tenant. The tenant always comes from the session. */
export async function requireOnboardingActor(request: Request): Promise<Actor> {
  const actor = await getActor(request);
  requireRole(actor, "admin");
  return actor;
}
