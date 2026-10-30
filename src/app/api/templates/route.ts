import { audit } from "@/lib/auth/audit";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { readJsonObject } from "@/lib/contacts/http";
import { createTemplate, listTemplates } from "@/lib/templates/service";
import { errorResponse, requireRole } from "@/lib/tenancy";

export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    const status = new URL(request.url).searchParams.get("status") ?? undefined;
    return Response.json({ templates: await listTemplates(actor, { status }) });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const template = await createTemplate(actor, await readJsonObject(request));
    await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "template.created", target: template.id });
    return Response.json({ template }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
