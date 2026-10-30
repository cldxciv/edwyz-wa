import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { readJsonLimited } from "@/lib/http/body";
import { getLead, updateLead } from "@/lib/leads/service";
import { errorResponse } from "@/lib/tenancy";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Ctx) {
  try {
    const actor = await getActor(request);
    return Response.json(await getLead(actor.tenantId, (await params).id));
  } catch (e) {
    return errorResponse(e);
  }
}

/** PATCH { status?, assignedToId? }. Any member may change status; only admins reassign. qualified and won queue a conversion event. */
export async function PATCH(request: Request, { params }: Ctx) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    const body = await readJsonLimited(request, 4096);
    return Response.json(await updateLead(actor, (await params).id, { status: body.status, assignedToId: body.assignedToId }));
  } catch (e) {
    return errorResponse(e);
  }
}
