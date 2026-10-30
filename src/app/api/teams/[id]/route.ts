import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { readJsonLimited } from "@/lib/http/body";
import { deleteTeam, updateTeam } from "@/lib/teams";
import { errorResponse, requireRole } from "@/lib/tenancy";

type Ctx = { params: Promise<{ id: string }> };

/** PATCH { name?, isDefault?: true } (admin or owner) -> { ok: true } */
export async function PATCH(request: Request, { params }: Ctx) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const { id } = await params;
    const body = await readJsonLimited(request, 2048);
    await updateTeam(actor, id, { name: body.name, isDefault: body.isDefault });
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}

/** DELETE (admin or owner). The default team cannot be deleted. Its chats go back to the default team. */
export async function DELETE(request: Request, { params }: Ctx) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const { id } = await params;
    await deleteTeam(actor, id);
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
