import { audit } from "@/lib/auth/audit";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { readJsonObject } from "@/lib/contacts/http";
import { deleteSegment, updateSegment } from "@/lib/segments/service";
import { errorResponse, requireRole } from "@/lib/tenancy";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Ctx) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const body = await readJsonObject(request);
    const id = (await params).id;
    const segment = await updateSegment(actor, id, { name: body.name, filter: body.filter });
    await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "segment.updated", target: id });
    return Response.json({ segment });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(request: Request, { params }: Ctx) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const id = (await params).id;
    await deleteSegment(actor, id);
    await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "segment.deleted", target: id });
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
