import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { readJsonLimited } from "@/lib/http/body";
import { setContactOwnerAndStage } from "@/lib/teams";
import { errorResponse } from "@/lib/tenancy";

/** PATCH { ownerUserId?: string | null, leadStage?: string | null } (any member) -> { contact: { id, ownerUserId, leadStage } } */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    const { id } = await params;
    const body = await readJsonLimited(request, 2048);
    return Response.json({ contact: await setContactOwnerAndStage(actor, id, { ownerUserId: body.ownerUserId, leadStage: body.leadStage }) });
  } catch (e) {
    return errorResponse(e);
  }
}
