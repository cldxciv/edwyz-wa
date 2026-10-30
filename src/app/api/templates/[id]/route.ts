import { audit } from "@/lib/auth/audit";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { deleteTemplate, exportTemplate } from "@/lib/templates/service";
import { errorResponse, requireRole } from "@/lib/tenancy";

/** Downloads the template as JSON so it can be imported into another workspace. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await getActor(request);
    const template = await exportTemplate(actor, (await params).id);
    return new Response(JSON.stringify(template, null, 2), {
      headers: { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="${template.name.slice(0, 80)}.json"`, "cache-control": "no-store" },
    });
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
