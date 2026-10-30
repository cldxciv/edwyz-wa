import { audit } from "@/lib/auth/audit";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { readJsonObject } from "@/lib/contacts/http";
import { createSegment, listSegments } from "@/lib/segments/service";
import { errorResponse, requireRole } from "@/lib/tenancy";

export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    return Response.json(await listSegments(actor), { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const body = await readJsonObject(request);
    const segment = await createSegment(actor, { name: body.name, filter: body.filter });
    await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "segment.created", target: segment.id });
    return Response.json({ segment }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
