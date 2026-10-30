import { prisma } from "@/lib/db";
import { getSettings } from "@/lib/platform-settings";

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
  } | null;
  graceDays: number;
  now: Date;
};

const DAY_MS = 86_400_000;

/** Pure entitlement rules. Suspension outranks the billing exemption so a suspended workspace can never write. */
export function computeBillingStatus({ tenant, subscription, graceDays, now }: StatusInput): BillingStatus {
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
    if (subscription.status === "active") return make("active", true);
    if (subscription.status === "past_due") {
      const since = subscription.pastDueSince ?? now;
      const graceEnd = since.getTime() + graceDays * DAY_MS;
      if (now.getTime() < graceEnd) return make("past_due_grace", true, "Your last payment failed. Update your payment method before access is locked.");
      return make("locked", false, "Your payment failed and the grace period has ended.");
    }
    if (periodOpen) return make("active", true);
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
      subscription: { select: { status: true, currentPeriodEnd: true, pastDueSince: true, planId: true, plan: { select: { name: true } } } },
    },
  });
  if (!tenant) {
    return { state: "locked", canWrite: false, trialEndsAt: null, daysLeftInTrial: null, planId: null, planName: null, currentPeriodEnd: null, reason: "Workspace not found." };
  }
  const settings = await getSettings();
  const sub = tenant.subscription;
  return computeBillingStatus({
    tenant,
    subscription: sub
      ? { status: sub.status, currentPeriodEnd: sub.currentPeriodEnd, pastDueSince: sub.pastDueSince, planId: sub.planId, planName: sub.plan?.name ?? null }
      : null,
    graceDays: settings.graceDays,
    now: new Date(),
  });
}
