import { prisma } from "@/lib/db";
import { getStepStates } from "@/lib/onboarding";
import { requireOnboardingActor } from "@/lib/onboarding/http";
import { getWhatsAppTokenHealth } from "@/lib/onboarding/token-health";
import { errorResponse } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const actor = await requireOnboardingActor(request);
    const [tenant, steps, token] = await Promise.all([
      prisma.tenant.findUnique({ where: { id: actor.tenantId }, select: { onboardingStatus: true } }),
      getStepStates(actor.tenantId),
      getWhatsAppTokenHealth(actor.tenantId),
    ]);
    const status = tenant?.onboardingStatus ?? "not_started";
    const nextAction = status === "live" ? "add_payment_method" : null;
    return Response.json({ status, steps, nextAction, token });
  } catch (e) {
    return errorResponse(e);
  }
}
