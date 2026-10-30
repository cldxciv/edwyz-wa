import { getActor } from "@/lib/auth";
import { assignAsActor } from "@/lib/inbox/actor-ops";
import { assertSameOrigin, readJson } from "@/lib/inbox/http";
import { errorResponse, HttpError } from "@/lib/tenancy";

/**
 * PUT { userId: string | null } -> { conversation }
 * The rules (agents take unassigned chats for themselves or release their own; assignment stays in the chat's team pool)
 * live in assignAsActor, which Eddy's assign_conversation uses too (docs/EDDY-SPEC.md 4.4, EDDY-04).
 */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    const body = await readJson(request);
    const userId = body.userId;
    if (userId !== null && (typeof userId !== "string" || !userId)) throw new HttpError(400, "userId must be a string or null.");
    const id = (await params).id;
    const { conversation } = await assignAsActor(actor, id, userId === null ? "none" : (userId as string));
    return Response.json({ conversation });
  } catch (e) {
    return errorResponse(e);
  }
}
