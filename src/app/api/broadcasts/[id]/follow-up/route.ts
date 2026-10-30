import { audit } from "@/lib/auth/audit";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { createFollowUp, followUpTemplates } from "@/lib/broadcasts/followup";
import { optionalString, readJsonObject } from "@/lib/contacts/http";
import { HttpError, errorResponse, requireRole } from "@/lib/tenancy";

/** Approved templates this broadcast's people can be sent next (retry with another template, or a follow-up). */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await getActor(request);
    requireRole(actor, "admin");
    return Response.json({ templates: await followUpTemplates(actor, (await params).id) }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}

/** Creates a draft broadcast for part of this broadcast's people with another template. Nothing is sent until it is started. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const body = await readJsonObject(request);
    const templateId = optionalString(body.templateId, "templateId", 100);
    if (!templateId) throw new HttpError(400, "Choose a template.");
    const id = (await params).id;
    const result = await createFollowUp(actor, id, { templateId, outcome: body.outcome, name: optionalString(body.name, "name", 120) });
    await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "broadcast.follow_up_created", target: result.broadcast.id, meta: { from: id, people: result.people } });
    return Response.json(result, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
