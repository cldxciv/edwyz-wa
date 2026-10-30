import { getActor } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { readJsonLimited } from "@/lib/http/body";
import { isNoticeUpdate, updateNotice } from "@/lib/notices/service";
import { errorResponse, HttpError } from "@/lib/tenancy";

/**
 * PATCH /api/notices/[id] { seen?: true, dismissed?: true, mute?: true } -> { ok: true, kind }
 *   The member's own receipt of one notice (docs/EDDY-SPEC.md 6.7): seen, dismissed, or "Don't show these" (mute the
 *   notice's kind for this member). Works only on a notice the member can see; anything else is 404. Changes nothing
 *   about the notice itself, or what other members see.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ID = /^[A-Za-z0-9_-]{1,64}$/;

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    const { id } = await params;
    if (!ID.test(id)) throw new HttpError(404, "Notice not found.");
    const update = isNoticeUpdate(await readJsonLimited(request, 1024));
    if (!update) throw new HttpError(400, "Send seen, dismissed or mute.");
    const done = await updateNotice(actor, id, update);
    if (!done) throw new HttpError(404, "Notice not found.");
    return Response.json(done, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
