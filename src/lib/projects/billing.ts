/**
 * The billing facts of a project (workspace) row, shared by the overview cards and the New project checks. It goes through the
 * same pure rules as the paywall (computeBillingStatus in src/lib/billing/status.ts), so "Free trial", "Read-only" and the
 * unpaid-project count can never disagree with what the workspace itself enforces.
 */
import type { Prisma } from "@/generated/prisma/client";
import { computeBillingStatus } from "@/lib/billing/status";
import type { BillingFacts } from "./rules";

/** The workspace fields a card and the billing rules need. */
export const PROJECT_TENANT_SELECT = {
  id: true,
  name: true,
  status: true,
  suspendedReason: true,
  billingExempt: true,
  trialEndsAt: true,
  subscription: {
    select: { status: true, currentPeriodEnd: true, pastDueSince: true, cancelAtPeriodEnd: true, planId: true, razorpaySubscriptionId: true, plan: { select: { name: true } } },
  },
} satisfies Prisma.TenantSelect;

export type ProjectTenantRow = Prisma.TenantGetPayload<{ select: typeof PROJECT_TENANT_SELECT }>;

export function billingFactsOf(tenant: ProjectTenantRow, graceDays: number, now: Date): BillingFacts {
  const sub = tenant.subscription;
  // A plan with no Razorpay subscription was assigned by hand in the admin console: it ends at its paid-until date.
  const manual = sub ? sub.razorpaySubscriptionId === null : false;
  const status = computeBillingStatus({
    tenant: { status: tenant.status, suspendedReason: tenant.suspendedReason, billingExempt: tenant.billingExempt, trialEndsAt: tenant.trialEndsAt },
    subscription: sub ? { status: sub.status, currentPeriodEnd: sub.currentPeriodEnd, pastDueSince: sub.pastDueSince, planId: sub.planId, planName: sub.plan?.name ?? null, manual } : null,
    graceDays,
    now,
  });
  return {
    state: status.state,
    trialEndsAt: status.trialEndsAt,
    daysLeftInTrial: status.daysLeftInTrial,
    planName: status.planName,
    subscription: sub ? { status: sub.status, currentPeriodEnd: sub.currentPeriodEnd, pastDueSince: sub.pastDueSince, cancelAtPeriodEnd: sub.cancelAtPeriodEnd, manual } : null,
    graceDays,
  };
}
