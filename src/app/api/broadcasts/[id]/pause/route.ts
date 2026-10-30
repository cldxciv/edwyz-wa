import { audit } from "@/lib/auth/audit";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { pauseBroadcast } from "@/lib/broadcasts/service";
import { errorResponse, requireRole } from "@/lib/tenancy";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const id = (await params).id;
    const broadcast = await pauseBroadcast(actor, id);
    await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "broadcast.paused", target: id });
    return Response.json({ broadcast });
  } catch (e) {
    return errorResponse(e);
  }
}
