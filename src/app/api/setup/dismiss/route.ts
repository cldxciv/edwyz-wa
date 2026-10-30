import { getActor } from "@/lib/auth";
import { audit } from "@/lib/auth/audit";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { readJsonLimited } from "@/lib/http/body";
import { getSetup, isStepId, setDismissed } from "@/lib/setup";
import { errorResponse, HttpError, requireRole } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

const MAX_BODY = 1024;

/** POST { stepId, dismissed } -> the refreshed checklist. "Dismiss for now" hides a step on the dashboard; the step stays on the Getting started page. */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const body = await readJsonLimited(request, MAX_BODY);
    if (!isStepId(body.stepId)) throw new HttpError(400, "Unknown setup step.");
    if (typeof body.dismissed !== "boolean") throw new HttpError(400, "dismissed must be true or false.");
    await setDismissed(actor.tenantId, body.stepId, body.dismissed);
    await audit({ tenantId: actor.tenantId, userId: actor.userId, action: body.dismissed ? "setup.step.dismissed" : "setup.step.restored", target: body.stepId });
    const setup = await getSetup(actor.tenantId);
    return Response.json({ ...setup, canDismiss: true }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
