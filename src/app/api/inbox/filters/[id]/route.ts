import { getActor } from "@/lib/auth";
import { deleteSavedFilter } from "@/lib/inbox/filters";
import { assertSameOrigin } from "@/lib/inbox/http";
import { errorResponse } from "@/lib/tenancy";

/** DELETE -> { ok: true }. Your own views, or a shared one when you are an admin. */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    await deleteSavedFilter(actor, (await params).id);
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
