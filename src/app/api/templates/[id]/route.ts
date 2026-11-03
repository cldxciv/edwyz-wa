import { audit } from "@/lib/auth/audit";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { readJsonObject } from "@/lib/contacts/http";
import { deleteTemplate, exportTemplate, templateDetails, updateTemplate } from "@/lib/templates/service";
import { errorResponse, requireRole } from "@/lib/tenancy";

/**
 * Downloads the template as JSON so it can be imported into another workspace. With ?details=1 it answers
 * { template } instead: status, Meta's rejection reason and the header file, for the template's own page.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await getActor(request);
    const id = (await params).id;
    if (new URL(request.url).searchParams.get("details") === "1") return Response.json({ template: await templateDetails(actor, id) });
    const template = await exportTemplate(actor, id);
    return new Response(JSON.stringify(template, null, 2), {
      headers: { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="${template.name.slice(0, 80)}.json"`, "cache-control": "no-store" },
    });
  } catch (e) {
    return errorResponse(e);
  }
}

/** Saves changes to a draft or a rejected template (the editor on the template's page). Nothing goes to Meta. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const id = (await params).id;
    const template = await updateTemplate(actor, id, await readJsonObject(request));
    await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "template.updated", target: id });
    return Response.json({ template });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const id = (await params).id;
    await deleteTemplate(actor, id);
    await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "template.deleted", target: id });
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
