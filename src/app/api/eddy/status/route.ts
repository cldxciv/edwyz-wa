import { getActor } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { defaultStatusDeps } from "@/lib/eddy/model-binding";
import { eddyHistoryDays } from "@/lib/eddy/settings";
import { eddyStatus } from "@/lib/eddy/status";
import { errorResponse } from "@/lib/tenancy";

/**
 * GET /api/eddy/status -> EddyStatusDTO (docs/EDDY-SPEC.md 5.11, 6.11, 6.14, EDDY-11 acceptance 2 and 6).
 * No model call: the panel asks on shell mount, every 5 minutes and when it opens. The first matching state wins:
 * platform_off (reason not_configured or paused; EDDY_ENABLED defaults to false, so a key alone never switches Eddy on),
 * locked, workspace_off (the owner turns Eddy on, 12.1a decision 6), paused, allowance_used, user_capped, ready.
 * Also: readOnly, canEnable (owner only), ownerNames, the AI allowance, langPref, needsYou, demo, whatsapp, firstUse and
 * spendingStopped, plus historyDays: how long Eddy chats are kept (the platform's configured retention), which the panel's
 * first-use notice, enable card and "Delete my Eddy history" line state (useEddyStatus historyDaysOf, 90 when absent).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    if (request.headers.get("origin") !== null) assertSameOrigin(request);
    const [status, historyDays] = await Promise.all([defaultStatusDeps().then((deps) => eddyStatus(actor, deps)), eddyHistoryDays()]);
    return Response.json({ ...status, historyDays }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
