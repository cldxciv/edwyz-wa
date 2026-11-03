import type { BillingState } from "@/lib/billing";
import { monthStartUtc, resolveLimits, usageFor } from "@/lib/billing/limits";

export type UsageLine = { used: number; limit: number | null };
export type Usage = {
  /** The chosen plan. Null during a free trial (see limitsFrom) and when no plan applies. */
  plan: { name: string } | null;
  /** Where the limits come from: the chosen plan, the free trial's allowance, or nowhere (no limits apply). */
  limitsFrom: "plan" | "trial" | null;
  /** Why there may be no plan (a free trial and its days left, or a workspace that needs none), so the meter can say so. */
  billing: { state: BillingState; trialDaysLeft: number | null };
  periodStart: string;
  contacts: UsageLine;
  /** Members plus open invites, as the seat limit counts them. */
  seats: UsageLine;
  /** Broadcast messages counted the way the monthly limit counts them (see broadcastQuotaWhere in src/lib/billing/limits.ts). */
  broadcastRecipients: UsageLine;
};

export const monthStart = monthStartUtc;

/**
 * The dashboard meter. It reads the same limits (resolveLimits) and the same counts (usageFor) as enforcement and the billing page,
 * so the numbers people see are the numbers a send is refused on, trial limits included.
 */
export async function getUsage(tenantId: string, now = new Date()): Promise<Usage> {
  const [resolved, contacts, seats, recipients] = await Promise.all([
    resolveLimits(tenantId),
    usageFor(tenantId, "contacts", now),
    usageFor(tenantId, "seats", now),
    usageFor(tenantId, "broadcastContacts", now),
  ]);
  const { status, from, planName, limits } = resolved;
  return {
    plan: from === "plan" && planName ? { name: planName } : null,
    limitsFrom: from,
    billing: { state: status.state, trialDaysLeft: status.daysLeftInTrial ?? null },
    periodStart: monthStartUtc(now).toISOString(),
    contacts: { used: contacts, limit: limits?.contactLimit ?? null },
    seats: { used: seats, limit: limits?.seatLimit ?? null },
    broadcastRecipients: { used: recipients, limit: limits?.monthlyBroadcastLimit ?? null },
  };
}
