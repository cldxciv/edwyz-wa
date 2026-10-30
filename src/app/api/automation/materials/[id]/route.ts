import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { deleteMaterial, getMaterial, rulesUsingMaterial, updateMaterial } from "@/lib/automation/v2/materials";
import { readJsonLimited } from "@/lib/http/body";
import { errorResponse, HttpError, requireRole } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/** GET -> { material, usedBy: [rule names] }. Any member can read. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await getActor(request);
    const { id } = await params;
    const material = await getMaterial(actor.tenantId, id);
    if (!material) throw new HttpError(404, "Reply material not found.");
    return Response.json({ material, usedBy: await rulesUsingMaterial(actor.tenantId, id) });
  } catch (e) {
    return errorResponse(e);
  }
}

/** PATCH any subset of the material fields (admin or owner) -> { material } */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    return Response.json({ material: await updateMaterial(actor.tenantId, (await params).id, await readJsonLimited(request, 16 * 1024)) });
  } catch (e) {
    return errorResponse(e);
  }
}

/** DELETE (admin or owner) -> { ok: true }. Rules that still send it will skip that step and log why. */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    await deleteMaterial(actor.tenantId, (await params).id);
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
