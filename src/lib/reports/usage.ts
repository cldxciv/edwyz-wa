import { getBillingStatus } from "@/lib/billing";
import { prisma } from "@/lib/db";

export type UsageLine = { used: number; limit: number | null };
export type Usage = {
  plan: { name: string } | null;
  periodStart: string;
  contacts: UsageLine;
  seats: UsageLine;
  broadcastRecipients: UsageLine;
};

export const monthStart = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

export async function getUsage(tenantId: string, now = new Date()): Promise<Usage> {
  const from = monthStart(now);
  const billing = await getBillingStatus(tenantId);
  const [plan, contacts, seats, recipients] = await Promise.all([
    billing.planId ? prisma.plan.findUnique({ where: { id: billing.planId }, select: { name: true, seatLimit: true, contactLimit: true, monthlyBroadcastLimit: true } }) : null,
    prisma.contact.count({ where: { tenantId } }),
    prisma.membership.count({ where: { tenantId } }),
    prisma.broadcastRecipient.count({ where: { tenantId, status: { in: ["sent", "delivered", "read"] }, sentAt: { gte: from } } }),
  ]);
  return {
    plan: plan ? { name: plan.name } : null,
    periodStart: from.toISOString(),
    contacts: { used: contacts, limit: plan?.contactLimit ?? null },
    seats: { used: seats, limit: plan?.seatLimit ?? null },
    broadcastRecipients: { used: recipients, limit: plan?.monthlyBroadcastLimit ?? null },
  };
}
