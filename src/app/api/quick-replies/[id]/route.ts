import { getActor } from "@/lib/auth";
import { assertSameOrigin, optString, readJson } from "@/lib/inbox/http";
import { deleteQuickReply, updateQuickReply } from "@/lib/inbox/service";
import { errorResponse, requireRole } from "@/lib/tenancy";

/** PATCH { shortcut?, body? } -> { item } */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    const input = await readJson(request);
    const item = await updateQuickReply(actor.tenantId, (await params).id, {
      shortcut: optString(input, "shortcut", 40),
      body: optString(input, "body", 4000),
    });
    return Response.json({ item });
  } catch (e) {
    return errorResponse(e);
  }
}

/** DELETE (admin or owner only) -> { ok: true } */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    await deleteQuickReply(actor.tenantId, (await params).id);
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
