import { prisma } from "@/lib/db";
import { getSettings } from "@/lib/platform-settings";
import { NEXT_START_GRACE_DAYS, approvedNextStart } from "./next-subscription";

export type BillingState = "trialing" | "active" | "past_due_grace" | "locked" | "suspended" | "exempt";

export type BillingStatus = {
  state: BillingState;
  /** False when the workspace may only read data and visit billing (trial over, unpaid, or suspended). */
  canWrite: boolean;
  trialEndsAt: Date | null;
  daysLeftInTrial: number | null;
  planId: string | null;
  planName: string | null;
  currentPeriodEnd: Date | null;
  reason?: string;
};

export type StatusInput = {
  tenant: { status: "active" | "suspended"; suspendedReason: string | null; billingExempt: boolean; trialEndsAt: Date | null };
  subscription: {
    status: "active" | "past_due" | "canceled" | "expired";
    currentPeriodEnd: Date | null;
    pastDueSince: Date | null;
    planId: string;
    planName: string | null;
    /** Assigned by hand in the admin console (no Razorpay subscription): nothing but its paid-until date ends it. */
    manual?: boolean;
  } | null;
  graceDays: number;
  now: Date;
  /**
   * The start of an approved new subscription that takes over when this plan ends (plan-change.ts, "start <plan> on <date>").
   * While its first payment is on its way, the ended plan does not lock the workspace (see NEXT_START_GRACE_DAYS).
   */
  nextSubscriptionStartsAt?: Date | null;
};

const DAY_MS = 86_400_000;

/** Why a workspace whose plan ended still writes: the approved new plan is starting. */
export const NEXT_STARTING_REASON = "Your new plan is starting. It switches on as soon as its first payment goes through.";

/** Pure entitlement rules. Suspension outranks the billing exemption so a suspended workspace can never write. */
export function computeBillingStatus({ tenant, subscription, graceDays, now, nextSubscriptionStartsAt }: StatusInput): BillingStatus {
  const trialEndsAt = tenant.trialEndsAt;
  const base = {
    trialEndsAt,
    daysLeftInTrial: null as number | null,
    planId: subscription?.planId ?? null,
    planName: subscription?.planName ?? null,
    currentPeriodEnd: subscription?.currentPeriodEnd ?? null,
  };
  const make = (state: BillingState, canWrite: boolean, reason?: string): BillingStatus => ({ state, canWrite, ...base, ...(reason ? { reason } : {}) });

  if (tenant.status === "suspended") return make("suspended", false, tenant.suspendedReason ?? "This workspace has been suspended.");
  if (tenant.billingExempt) return make("exempt", true);

  if (subscription) {
    const periodEnd = subscription.currentPeriodEnd;
    const periodOpen = periodEnd !== null && now.getTime() < periodEnd.getTime();
    // A Razorpay plan stays active until Razorpay says otherwise (webhook or the reconcile job). A plan assigned by hand has no such
    // event, so it ends at its paid-until date (the billing worker also marks the row expired, see expireManualPlans).
    if (subscription.status === "active" && subscription.manual && periodEnd !== null && !periodOpen) return make("locked", false, "Your plan has ended.");
    if (subscription.status === "active") return make("active", true);
    if (subscription.status === "past_due") {
      const since = subscription.pastDueSince ?? now;
      const graceEnd = since.getTime() + graceDays * DAY_MS;
      if (now.getTime() < graceEnd) return make("past_due_grace", true, "Your last payment failed. Update your payment method before access is locked.");
      return make("locked", false, "Your payment failed and the grace period has ended.");
    }
    if (periodOpen) return make("active", true);
    // Ended to move to another plan: the approved new subscription starts the day this one ended, and its first payment can
    // take a few days (UPI AutoPay, a bank mandate). Access stays on meanwhile, so the workspace is not locked and its ads are
    // not paused in that gap; the webhook or the plan-change sweep moves the row onto the new plan once it is paid.
    if (periodEnd !== null && nextSubscriptionStartsAt && !subscription.manual && Math.abs(nextSubscriptionStartsAt.getTime() - periodEnd.getTime()) <= DAY_MS) {
      const graceEnd = nextSubscriptionStartsAt.getTime() + Math.max(graceDays, NEXT_START_GRACE_DAYS) * DAY_MS;
      if (now.getTime() < graceEnd) return make("active", true, NEXT_STARTING_REASON);
    }
    if (subscription.currentPeriodEnd !== null) return make("locked", false, "Your subscription has ended.");
  }

  if (trialEndsAt && now.getTime() < trialEndsAt.getTime()) {
    const left = Math.max(1, Math.ceil((trialEndsAt.getTime() - now.getTime()) / DAY_MS));
    return { state: "trialing", canWrite: true, ...base, daysLeftInTrial: left };
  }
  return make("locked", false, "Your free trial has ended. Subscribe to continue.");
}

export async function getBillingStatus(tenantId: string): Promise<BillingStatus> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: {
      status: true,
      suspendedReason: true,
      billingExempt: true,
      trialEndsAt: true,
      subscription: { select: { status: true, currentPeriodEnd: true, pastDueSince: true, planId: true, razorpaySubscriptionId: true, plan: { select: { name: true } } } },
    },
  });
  if (!tenant) {
    return { state: "locked", canWrite: false, trialEndsAt: null, daysLeftInTrial: null, planId: null, planName: null, currentPeriodEnd: null, reason: "Workspace not found." };
  }
  const settings = await getSettings();
  const sub = tenant.subscription;
  const input: StatusInput = {
    tenant,
    subscription: sub
      ? {
          status: sub.status,
          currentPeriodEnd: sub.currentPeriodEnd,
          pastDueSince: sub.pastDueSince,
          planId: sub.planId,
          planName: sub.plan?.name ?? null,
          manual: sub.razorpaySubscriptionId === null,
        }
      : null,
    graceDays: settings.graceDays,
    now: new Date(),
  };
  const status = computeBillingStatus(input);
  // Only a Razorpay plan that has just ended can be waiting for an approved new one: one more read, and only then.
  if (status.state !== "locked" || !sub?.razorpaySubscriptionId || (sub.status !== "canceled" && sub.status !== "expired")) return status;
  const nextSubscriptionStartsAt = await approvedNextStart(tenantId);
  return nextSubscriptionStartsAt ? computeBillingStatus({ ...input, nextSubscriptionStartsAt }) : status;
}
