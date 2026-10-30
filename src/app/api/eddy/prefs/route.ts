import { getActor } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { parsePrefsUpdate, prefDTO, updateUserPref, userPref } from "@/lib/eddy/settings";
import { readJsonLimited } from "@/lib/http/body";
import { errorResponse } from "@/lib/tenancy";

/**
 * GET /api/eddy/prefs -> { prefs }
 * PUT /api/eddy/prefs { language?: 'auto'|'en'|'hi'|'hinglish', firstUseAck?: true, proactive?, mutedNoticeKinds? } -> { prefs }
 *   The member's own Eddy preference (docs/EDDY-SPEC.md 5.7, 6.11, EDDY-11 acceptance 5 and 6). The first-use
 *   acknowledgement records firstUseAckAt and firstUseVersion = LEGAL.version, so the notice shows again after a
 *   LEGAL.version bump. Allowed for an unverified member (5.11 critic).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    if (request.headers.get("origin") !== null) assertSameOrigin(request);
    return Response.json({ prefs: prefDTO(await userPref(actor.tenantId, actor.userId)) }, { headers: NO_STORE });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function PUT(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    const update = parsePrefsUpdate(await readJsonLimited(request, 4096));
    return Response.json({ prefs: prefDTO(await updateUserPref(actor, update)) }, { headers: NO_STORE });
  } catch (e) {
    return errorResponse(e);
  }
}
