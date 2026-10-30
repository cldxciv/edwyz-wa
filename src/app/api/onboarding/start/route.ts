import { audit } from "@/lib/auth/audit";
import { issueSignupState } from "@/lib/meta-connect/state";
import { requireOnboardingActor } from "@/lib/onboarding/http";
import { errorResponse, HttpError } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const actor = await requireOnboardingActor(request);
    const { META_ES_CONFIG_ID: configId, META_APP_ID: appId, STATE_SECRET: secret } = process.env;
    if (!configId || !appId || !secret) throw new HttpError(503, "WhatsApp connection is not configured yet.");
    await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "onboarding.started" });
    return Response.json({ configId, appId, state: await issueSignupState(actor.tenantId, actor.userId) });
  } catch (e) {
    return errorResponse(e);
  }
}
