import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { deleteRule, updateRule } from "@/lib/automation/rules";
import { getRule } from "@/lib/automation/v2/service";
import { readJsonLimited } from "@/lib/http/body";
import { errorResponse, HttpError, requireRole } from "@/lib/tenancy";

/** GET -> { rule }. Any member can read. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await getActor(request);
    const rule = await getRule(actor.tenantId, (await params).id);
    if (!rule) throw new HttpError(404, "Rule not found.");
    return Response.json({ rule });
  } catch (e) {
    return errorResponse(e);
  }
}

/** PATCH any subset of rule fields (admin or owner) -> { rule }. Trigger, filters and actions are for v2 rules. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const { id } = await params;
    return Response.json({ rule: await updateRule(actor.tenantId, id, await readJsonLimited(request, 64 * 1024)) });
  } catch (e) {
    return errorResponse(e);
  }
}

/** DELETE (admin or owner) -> { ok: true } */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    await deleteRule(actor.tenantId, (await params).id);
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
