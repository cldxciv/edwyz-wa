import { getActor } from "@/lib/auth";
import { audit } from "@/lib/auth/audit";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { readJson, str } from "@/lib/auth/http";
import { prisma } from "@/lib/db";
import { errorResponse } from "@/lib/tenancy";

/** The signed-in member's own name, as teammates see it in the inbox and the team list. Body: { name }. The email cannot change here. */
export async function PATCH(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    const name = str(await readJson(request), "name", "Name", 100);
    const user = await prisma.user.update({ where: { id: actor.userId }, data: { name }, select: { id: true, email: true, name: true } });
    await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "account.profile_updated" });
    return Response.json({ user }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
