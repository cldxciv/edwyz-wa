import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { optionalString, plainObject, readJsonObject, stringArray } from "@/lib/contacts/http";
import { createContact, listContacts } from "@/lib/contacts/service";
import { contactScopeWhere, maskContact, searchAllowed, viewerRules } from "@/lib/teams/visibility";
import { HttpError, errorResponse } from "@/lib/tenancy";

export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    const params = new URL(request.url).searchParams;
    const limit = params.get("limit") ? Number(params.get("limit")) : undefined;
    if (limit !== undefined && !Number.isInteger(limit)) throw new HttpError(400, "limit must be an integer.");
    const rules = await viewerRules(actor);
    const masked = rules.maskPhone;
    if (!searchAllowed(params.get("q"), masked)) return Response.json({ items: [], nextCursor: null });
    const result = await listContacts(actor, {
      q: params.get("q") ?? undefined,
      tag: params.get("tag") ?? undefined,
      segmentId: params.get("segmentId") ?? undefined,
      cursor: params.get("cursor") ?? undefined,
      limit,
      maskedPhone: masked,
      scope: contactScopeWhere(actor, rules),
    });
    return Response.json(masked ? { ...result, items: result.items.map((c) => maskContact(c, true)) } : result);
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    const body = await readJsonObject(request);
    const phone = optionalString(body.phone, "phone", 40);
    if (!phone) throw new HttpError(400, "phone is required.");
    if (body.optIn !== undefined && typeof body.optIn !== "boolean") throw new HttpError(400, "optIn must be a boolean.");
    const contact = await createContact(actor, {
      phone,
      name: optionalString(body.name, "name"),
      tags: stringArray(body.tags, "tags"),
      attributes: plainObject(body.attributes, "attributes"),
      optIn: body.optIn as boolean | undefined,
      optInSource: optionalString(body.optInSource, "optInSource", 100),
    });
    return Response.json({ contact }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
