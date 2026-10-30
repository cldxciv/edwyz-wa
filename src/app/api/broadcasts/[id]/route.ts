import { audit } from "@/lib/auth/audit";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { getBroadcast } from "@/lib/broadcasts/service";
import { type BroadcastPatch, updateBroadcastPlan } from "@/lib/broadcasts/scheduling";
import { parseIsoDate, parseRetryDays } from "@/lib/broadcasts/schedule";
import { readJsonObject } from "@/lib/contacts/http";
import { errorResponse, requireRole } from "@/lib/tenancy";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await getActor(request);
    const cursor = new URL(request.url).searchParams.get("cursor") ?? undefined;
    return Response.json(await getBroadcast(actor, (await params).id, { cursor }));
  } catch (e) {
    return errorResponse(e);
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const body = await readJsonObject(request);
    const patch: BroadcastPatch = {};
    if (body.scheduledAt !== undefined) patch.scheduledAt = body.scheduledAt === null ? null : parseIsoDate(body.scheduledAt, "scheduledAt");
    if (body.retryDays !== undefined) patch.retryDays = parseRetryDays(body.retryDays);
    const id = (await params).id;
    const broadcast = await updateBroadcastPlan(actor, id, patch);
    await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "broadcast.rescheduled", target: id });
    return Response.json({ broadcast });
  } catch (e) {
    return errorResponse(e);
  }
}
