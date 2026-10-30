import { audit } from "@/lib/auth/audit";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { optionalString, plainObject, readJsonObject, stringArray } from "@/lib/contacts/http";
import { deleteContact, updateContact } from "@/lib/contacts/service";
import { assertContactVisible, maskContact, shouldMaskFor } from "@/lib/teams/visibility";
import { HttpError, errorResponse, requireRole } from "@/lib/tenancy";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Ctx) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    const { id } = await params;
    await assertContactVisible(actor, id);
    const body = await readJsonObject(request);
    if (body.optIn !== undefined && typeof body.optIn !== "boolean") throw new HttpError(400, "optIn must be a boolean.");
    const contact = await updateContact(actor, id, {
      name: optionalString(body.name, "name"),
      tags: stringArray(body.tags, "tags"),
      attributes: plainObject(body.attributes, "attributes"),
      optIn: body.optIn as boolean | undefined,
      optInSource: optionalString(body.optInSource, "optInSource", 100),
    });
    return Response.json({ contact: maskContact(contact, await shouldMaskFor(actor)) });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(request: Request, { params }: Ctx) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const { id } = await params;
    await deleteContact(actor, id);
    await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "contact.deleted", target: id });
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
