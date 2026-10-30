import { getActor } from "@/lib/auth";
import { setTagsAsActor } from "@/lib/inbox/actor-ops";
import { assertSameOrigin, readJson } from "@/lib/inbox/http";
import { errorResponse, HttpError } from "@/lib/tenancy";

/**
 * PUT { tags: string[] } (max 20, each up to 40 chars) -> { conversation }
 * Visibility, the act-on rule and the compare-and-set write live in setTagsAsActor, which Eddy's tag_conversations uses
 * with a diff (docs/EDDY-SPEC.md 4.4, EDDY-04).
 */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    const { tags } = await readJson(request);
    if (!Array.isArray(tags) || tags.length > 20 || tags.some((t) => typeof t !== "string" || t.length > 40)) {
      throw new HttpError(400, "tags must be an array of up to 20 short strings.");
    }
    const { conversation } = await setTagsAsActor(actor, (await params).id, { set: tags as string[] });
    return Response.json({ conversation });
  } catch (e) {
    return errorResponse(e);
  }
}
