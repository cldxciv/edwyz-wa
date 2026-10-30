import { getActor } from "@/lib/auth";
import { assertSameOrigin, readJson } from "@/lib/inbox/http";
import { requireRole, type Actor } from "@/lib/tenancy";

export async function readActor(request: Request): Promise<Actor> {
  return getActor(request);
}

/** CSRF check plus admin-or-owner role for every state-changing creative route. */
export async function writeActor(request: Request): Promise<Actor> {
  assertSameOrigin(request);
  const actor = await getActor(request);
  requireRole(actor, "admin");
  return actor;
}

export { readJson };
export type Ctx<P extends string = "id"> = { params: Promise<Record<P, string>> };
