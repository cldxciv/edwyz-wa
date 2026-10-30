import { getActor } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { readJsonLimited } from "@/lib/http/body";
import { activityForViewer, isAutomationKind, teamActivity, turnOffAutomation } from "@/lib/notices/producers/activity";
import { claimToasts, listNotices } from "@/lib/notices/service";
import { errorResponse, hasRole, HttpError } from "@/lib/tenancy";

/**
 * GET /api/notices -> { notices, needsYou, toasts }
 *   The member's notices for the "Needs you" strip (docs/EDDY-SPEC.md 6.7): open, for their role or for them alone, not
 *   dismissed and not of a kind they muted. `toasts` lists the action-needed notices to show as one sticky toast now; each
 *   id is handed out once per member (two tabs never both toast it). Polled every 60 s while the tab is visible and when
 *   Eddy opens; no SSE stream (the inbox keeps its 20 streams per workspace). No AI is involved.
 * GET /api/notices?view=activity -> { activity, canManage }
 *   Menu > Team activity (6.9): one item per automation with its on/off state, the last 24 hours and what waits.
 * POST /api/notices { op: "automation_off", kind, id } -> { ok: true }
 *   Team activity's Turn off: instant (lowering), admins and the owner, through the same services as the Settings pages.
 *   Turning on is never done here: it is a card Eddy builds.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };
const ID = /^[A-Za-z0-9_-]{1,64}$/;

export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    if (request.headers.get("origin") !== null) assertSameOrigin(request);
    const view = new URL(request.url).searchParams.get("view");
    if (view === "activity") {
      const canManage = hasRole(actor, "admin");
      return Response.json({ activity: activityForViewer(await teamActivity(actor.tenantId), canManage), canManage }, { headers: NO_STORE });
    }
    const { notices, needsYou } = await listNotices(actor);
    const toasts = await claimToasts(actor, notices);
    return Response.json({ notices, needsYou, toasts }, { headers: NO_STORE });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    const body = await readJsonLimited(request, 4 * 1024);
    if (body.op !== "automation_off") throw new HttpError(400, "Unknown request.");
    if (!isAutomationKind(body.kind) || typeof body.id !== "string" || !ID.test(body.id)) throw new HttpError(400, "Choose an automation to turn off.");
    await turnOffAutomation(actor, body.kind, body.id);
    return Response.json({ ok: true }, { headers: NO_STORE });
  } catch (e) {
    return errorResponse(e);
  }
}
