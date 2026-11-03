import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { PlanChangeNeedsNewSubscription, cancelPlannedChange, changePlan } from "@/lib/billing/plan-change";
import { readJsonObject } from "@/lib/contacts/http";
import { errorResponse, requireRole } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/**
 * POST { planId } (owner) -> { ok, change: "upgraded" | "processing" | "scheduled" | "kept", planName, at? }
 * POST { cancelScheduled: true } (owner) -> { ok, change: "kept", planName, endsOn }: drops the planned change.
 *
 * An upgrade applies at once and Razorpay charges the prorated difference to the saved payment method, so only the owner may
 * change the plan (as only the owner may cancel it). A downgrade, and any move between monthly and yearly billing, applies at the
 * renewal ("scheduled"). Every step is audited in plan-change.ts.
 * 409 { error, code: "new_subscription_needed", planId, planName, endsOn, method } when Razorpay cannot change the plan for the way
 * it is paid (UPI AutoPay, a bank mandate, a card issued in India): end the plan at the period's end, then start the new one.
 * 409 with the contact-support text for a plan assigned by hand.
 */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "owner");
    const body = await readJsonObject(request);
    const result = body.cancelScheduled === true ? await cancelPlannedChange(actor) : await changePlan(actor, body.planId);
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    if (e instanceof PlanChangeNeedsNewSubscription) return Response.json({ error: e.message, ...e.details }, { status: 409 });
    return errorResponse(e, request);
  }
}
