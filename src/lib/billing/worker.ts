import { audit } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { pauseAdsForBlockedTenants } from "@/lib/tenant-lifecycle";
import type { WorkerModule } from "@/worker/registry";
import { issueInvoiceOnce } from "./invoice";
import { sendPaymentReceived } from "./notify";
import { markApplied } from "./ordering";
import { reconcilePlanChanges } from "./plan-change";
import { fetchSubscription, listSubscriptionInvoices, razorpayConfigured } from "./razorpay";
import { patchFromEntity } from "./sync";
import { runUsageAlerts } from "./usage-alerts";

const DAY_MS = 86_400_000;

/** Re-reads from Razorpay any subscription whose paid period ended more than a day ago without a webhook moving it on. */
export async function reconcileSubscriptions(now = new Date()): Promise<number> {
  if (!razorpayConfigured()) return 0;
  const stale = await prisma.subscription.findMany({
    where: {
      razorpaySubscriptionId: { not: null },
      status: { in: ["active", "past_due"] },
      currentPeriodEnd: { lt: new Date(now.getTime() - DAY_MS) },
    },
    take: 50,
    orderBy: { currentPeriodEnd: "asc" },
  });
  let changed = 0;
  for (const sub of stale) {
    try {
      const remote = await fetchSubscription(sub.razorpaySubscriptionId as string);
      const patch = patchFromEntity(remote, sub, now);
      if (!patch) continue;
      await prisma.subscription.update({ where: { id: sub.id }, data: patch });
      await markApplied(sub.tenantId, Math.floor(now.getTime() / 1000));
      changed++;
    } catch {
      console.warn("[billing] reconcile failed for one subscription");
    }
  }
  return changed;
}

/**
 * Ends plans assigned by hand in the admin console once their paid-until date has passed. Razorpay plans end through Razorpay
 * (webhook, or reconcileSubscriptions above); a hand-assigned plan has nothing that would end it, so it is marked expired here.
 * Access already ends on the date itself (computeBillingStatus); this keeps the row, the billing page and the admin lists in step.
 * Idempotent: an expired row is never selected again.
 */
export async function expireManualPlans(now = new Date()): Promise<number> {
  const ended = await prisma.subscription.findMany({
    where: { razorpaySubscriptionId: null, status: "active", currentPeriodEnd: { lte: now } },
    select: { id: true, tenantId: true, currentPeriodEnd: true },
    take: 200,
  });
  let changed = 0;
  for (const sub of ended) {
    // The status in the where clause keeps a plan the admin re-assigned in the meantime (a new period, still active) untouched.
    const { count } = await prisma.subscription.updateMany({ where: { id: sub.id, status: "active", razorpaySubscriptionId: null, currentPeriodEnd: { lte: now } }, data: { status: "expired" } });
    if (count === 0) continue;
    changed++;
    await audit({ tenantId: sub.tenantId, action: "billing.manual_plan_expired", target: sub.id, meta: { endedAt: sub.currentPeriodEnd?.toISOString() ?? null } });
  }
  return changed;
}

const BACKFILL_LOOKBACK_DAYS = 3;
const fromUnix = (v: number | null | undefined) => (typeof v === "number" && v > 0 ? new Date(v * 1000) : null);

/**
 * Issues the GST invoice (and sends the receipt) for a paid charge whose webhook never arrived, so a missed event costs a delay and
 * not an invoice. Looks at workspaces whose current paid period began in the last few days and that have no invoice since then; only
 * those cause a call to Razorpay. One payment id never gets two invoices, so running it twice is harmless.
 */
export async function backfillMissingInvoices(now = new Date()): Promise<number> {
  if (!razorpayConfigured()) return 0;
  const recent = await prisma.subscription.findMany({
    where: {
      razorpaySubscriptionId: { not: null },
      status: "active",
      currentPeriodStart: { gte: new Date(now.getTime() - BACKFILL_LOOKBACK_DAYS * DAY_MS) },
    },
    include: { plan: { select: { name: true, currency: true } } },
    take: 50,
    orderBy: { currentPeriodStart: "desc" },
  });
  let issued = 0;
  for (const sub of recent) {
    try {
      const since = new Date((sub.currentPeriodStart as Date).getTime() - DAY_MS);
      if (await prisma.invoice.findFirst({ where: { tenantId: sub.tenantId, issuedAt: { gte: since } }, select: { id: true } })) continue;
      const { items } = await listSubscriptionInvoices(sub.razorpaySubscriptionId as string);
      for (const item of items ?? []) {
        if (item.status !== "paid" || !item.payment_id || !Number.isInteger(item.amount) || (item.amount as number) <= 0) continue;
        const { invoice, created } = await issueInvoiceOnce({
          tenantId: sub.tenantId,
          razorpayPaymentId: item.payment_id,
          totalPaise: item.amount as number,
          currency: item.currency || sub.plan.currency,
          planName: sub.plan.name,
          periodStart: fromUnix(item.billing_start) ?? sub.currentPeriodStart,
          periodEnd: fromUnix(item.billing_end) ?? sub.currentPeriodEnd,
          paidAt: fromUnix(item.paid_at) ?? now,
        });
        if (created) {
          issued++;
          await sendPaymentReceived({ tenantId: sub.tenantId, invoiceId: invoice.id, amountPaise: invoice.totalPaise });
        }
      }
    } catch {
      console.warn("[billing] invoice backfill failed for one subscription");
    }
  }
  return issued;
}

const LOCK_SWEEP_MS = 5 * 60_000;
const USAGE_ALERT_MS = 30 * 60_000;

/**
 * Past-due grace and trial expiry are computed when read (see status.ts), so no job flips them and there is no lock event to hook.
 * The lock sweep is what notices the transition: within LOCK_SWEEP_MS of a workspace becoming locked it pauses that workspace's
 * live ad campaigns (and keeps its Meta connections, so paying resumes everything). It is idempotent: once the campaigns are paused
 * there is nothing left to select, so later runs do no Meta call and write no audit row.
 */
export const worker: WorkerModule = {
  queues: {},
  periodic: [
    { name: "billing-reconcile", everyMs: 15 * 60_000, run: () => reconcileSubscriptions() },
    { name: "billing.manual-plan-expiry", everyMs: 15 * 60_000, run: () => expireManualPlans() },
    { name: "billing.plan-changes", everyMs: 15 * 60_000, run: () => (razorpayConfigured() ? reconcilePlanChanges() : Promise.resolve(0)) },
    { name: "billing-invoice-backfill", everyMs: 30 * 60_000, run: () => backfillMissingInvoices() },
    { name: "billing.lock-pause-ads", everyMs: LOCK_SWEEP_MS, run: () => pauseAdsForBlockedTenants() },
    { name: "billing.usage-alerts", everyMs: USAGE_ALERT_MS, run: () => runUsageAlerts() },
  ],
};
