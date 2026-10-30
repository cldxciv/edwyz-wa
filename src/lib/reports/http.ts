import { getActor } from "@/lib/auth";
import { type Actor, requireRole } from "@/lib/tenancy";

/** Owner or admin. Exports are GET routes, so the billing paywall (writes only) never blocks them. */
export async function adminActor(request: Request): Promise<Actor> {
  const actor = await getActor(request);
  requireRole(actor, "admin");
  return actor;
}
