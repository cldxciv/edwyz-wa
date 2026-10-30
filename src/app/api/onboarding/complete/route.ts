import { audit } from "@/lib/auth/audit";
import { readJsonLimited } from "@/lib/http/body";
import { consumeSignupState } from "@/lib/meta-connect/state";
import { isMetaId, runOnboarding } from "@/lib/onboarding";
import { assertSameOrigin, requireOnboardingActor } from "@/lib/onboarding/http";
import { errorResponse, HttpError } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await requireOnboardingActor(request);
    const { code, wabaId, phoneNumberId, state, flow } = await readJsonLimited(request, 16 * 1024);

    if (typeof code !== "string" || code.length < 1 || code.length > 2048) throw new HttpError(400, "Missing authorization code.");
    if (!isMetaId(wabaId) || !isMetaId(phoneNumberId)) throw new HttpError(400, "Missing WhatsApp account details.");

    if (flow !== undefined && flow !== "standard" && flow !== "coexistence") throw new HttpError(400, "Invalid flow.");

    // Bound to this workspace and user and single use: a captured or replayed state is refused before onboarding runs. It is spent
    // only after the request shape is valid, so a malformed request cannot burn a good state.
    await consumeSignupState(actor.tenantId, actor.userId, typeof state === "string" ? state : null);

    const result = await runOnboarding({ tenantId: actor.tenantId, code, wabaId, phoneNumberId, skipRegistration: flow === "coexistence" });
    await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "onboarding.completed", target: phoneNumberId, meta: { ok: result.ok, flow: flow === "coexistence" ? "coexistence" : "standard", reauthorized: result.reauthorized ?? false } });
    return Response.json({ status: result.ok ? "live" : "failed", ...result }, { status: result.ok ? 200 : 502 });
  } catch (e) {
    return errorResponse(e);
  }
}
