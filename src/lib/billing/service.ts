import { prisma } from "@/lib/db";
import { HttpError, type Actor } from "@/lib/tenancy";
import { getSettings } from "@/lib/platform-settings";
import { claimOnce, readState } from "@/lib/lifecycle/state";
import { buyerStateCode, invoiceMetaKey, isValidGstin, issueInvoiceOnce, readInvoiceMeta } from "./invoice";
import { sendPaymentReceived } from "./notify";
import { markApplied } from "./ordering";
import {
  cancelSubscription,
  createSubscription,
  fetchPayment,
  fetchSubscription,
  razorpayConfigured,
  razorpayKeyId,
  syncPlanToRazorpay,
  verifyCheckoutSignature,
} from "./razorpay";
import { getBillingStatus } from "./status";
import { patchFromEntity } from "./sync";


/**
 * Every active plan, including the trial allowance. The pricing page drops the trial with publicPlans().
 * A null limit means the plan sets none; callers must word it truthfully (AI credits fall back to a platform ceiling).
 */
export function listActivePlans() {
  return prisma.plan.findMany({
    where: { active: true },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    select: {
      id: true, code: true, name: true, description: true, pricePaise: true, currency: true, intervalMonths: true,
      seatLimit: true, contactLimit: true, monthlyBroadcastLimit: true, aiCreditsMonthly: true, adAccountLimit: true, scheduledPostLimit: true, connectedChannelLimit: true, features: true,
    },
  });
}

export async function billingOverview(actor: Actor) {
  const [status, subscription, invoices, profile, plans, settings] = await Promise.all([
    getBillingStatus(actor.tenantId),
    prisma.subscription.findUnique({
      where: { tenantId: actor.tenantId },
      select: { status: true, currentPeriodEnd: true, cancelAtPeriodEnd: true, plan: { select: { name: true, pricePaise: true, currency: true, intervalMonths: true } } },
    }),
    prisma.invoice.findMany({
      where: { tenantId: actor.tenantId },
      orderBy: { issuedAt: "desc" },
      take: 20,
      select: { id: true, number: true, status: true, totalPaise: true, currency: true, issuedAt: true, planName: true },
    }),
    prisma.billingProfile.findUnique({ where: { tenantId: actor.tenantId } }),
    listActivePlans(),
    getSettings(),
  ]);
  return { status, subscription, invoices, billingProfile: profile, plans, trialDays: settings.trialDays, paymentsConfigured: razorpayConfigured() };
}

export async function startSubscription(actor: Actor, planId: unknown) {
  if (typeof planId !== "string" || !planId || planId.length > 64) throw new HttpError(400, "Choose a plan.");
  const plan = await prisma.plan.findFirst({ where: { id: planId, active: true } });
  if (!plan) throw new HttpError(404, "That plan is not available.");
  const existing = await prisma.subscription.findUnique({ where: { tenantId: actor.tenantId } });
  const now = new Date();
  if (existing?.status === "active" && existing.currentPeriodEnd && existing.currentPeriodEnd > now) {
    throw new HttpError(409, "You already have an active subscription. Cancel it at the end of the period before choosing another plan.");
  }

  const { razorpayPlanId } = plan.razorpayPlanId ? { razorpayPlanId: plan.razorpayPlanId } : await syncPlanToRazorpay(plan.id);
  const created = await createSubscription({ razorpayPlanId, intervalMonths: plan.intervalMonths, notes: { tenantId: actor.tenantId, planCode: plan.code } });

  const data = { planId: plan.id, status: "expired" as const, razorpaySubscriptionId: created.id, cancelAtPeriodEnd: false, pastDueSince: null };
  await prisma.subscription.upsert({
    where: { tenantId: actor.tenantId },
    create: { tenantId: actor.tenantId, ...data },
    update: existing?.status === "past_due" ? { planId: plan.id, razorpaySubscriptionId: created.id, cancelAtPeriodEnd: false } : data,
  });
  if (existing?.razorpaySubscriptionId && existing.status === "past_due") {
    await cancelSubscription(existing.razorpaySubscriptionId, false).catch(() => undefined);
  }
  return { keyId: razorpayKeyId(), subscriptionId: created.id, name: "Edwyz WA", description: plan.name };
}

/**
 * Called by the browser after Razorpay Checkout reports success. The signature only proves a payment happened once, and it never
 * expires, so it is not enough to switch access on: a saved copy of it would reopen a cancelled or lapsed workspace every month.
 * Access is therefore granted from what Razorpay itself says now. The signature is checked, the subscription is fetched, it must be
 * active there, and the period is the one Razorpay reports (never "now plus a month"). A payment id works once; confirming while the
 * workspace is already active and paid up changes nothing.
 */
export async function confirmCheckout(actor: Actor, body: Record<string, unknown>) {
  const { razorpay_payment_id: paymentId, razorpay_subscription_id: subscriptionId, razorpay_signature: signature } = body;
  if (![paymentId, subscriptionId, signature].every((v) => typeof v === "string" && v.length > 0 && v.length <= 200)) {
    throw new HttpError(400, "Missing payment details.");
  }
  const sub = await prisma.subscription.findUnique({ where: { tenantId: actor.tenantId }, include: { plan: true } });
  if (!sub?.razorpaySubscriptionId || sub.razorpaySubscriptionId !== subscriptionId) throw new HttpError(400, "This payment does not match your subscription.");
  if (!verifyCheckoutSignature(paymentId as string, sub.razorpaySubscriptionId, signature as string)) throw new HttpError(400, "Payment could not be verified.");

  const now = new Date();
  if (sub.status === "active" && sub.currentPeriodEnd && sub.currentPeriodEnd > now) return { ok: true, alreadyActive: true };

  const usedKey = `billing:checkout-payment:${actor.tenantId}:${paymentId as string}`;
  if (await readState(usedKey)) throw new HttpError(409, "This payment confirmation was already used. If your plan is not active, contact support.");

  const remote = await fetchSubscription(sub.razorpaySubscriptionId);
  const remoteTenant = remote.notes && !Array.isArray(remote.notes) ? remote.notes.tenantId : undefined;
  if (typeof remoteTenant === "string" && remoteTenant !== actor.tenantId) throw new HttpError(400, "This payment does not match your subscription.");
  if (remote.status !== "active") {
    throw new HttpError(409, "Your payment has not been confirmed by the payment provider yet. Your plan switches on automatically as soon as it is.");
  }

  const patch = patchFromEntity(remote, sub, now);
  const start = patch?.currentPeriodStart ?? now;
  let end = patch?.currentPeriodEnd;
  if (!end) {
    end = new Date(start);
    end.setUTCMonth(end.getUTCMonth() + sub.plan.intervalMonths);
  }
  await prisma.subscription.update({ where: { id: sub.id }, data: { status: "active", pastDueSince: null, cancelAtPeriodEnd: false, currentPeriodStart: start, currentPeriodEnd: end } });
  await markApplied(actor.tenantId, Math.floor(now.getTime() / 1000));
  await claimOnce(usedKey);
  await issueCheckoutInvoice(actor.tenantId, paymentId as string, sub.plan, start, end, now);
  return { ok: true };
}

/** Best effort: the webhook and the invoice backfill job issue it too, and one payment id never yields two invoices. */
async function issueCheckoutInvoice(tenantId: string, paymentId: string, plan: { name: string; currency: string }, start: Date, end: Date, now: Date) {
  try {
    const payment = await fetchPayment(paymentId);
    if (payment.status !== "captured" || !Number.isInteger(payment.amount) || payment.amount <= 0) return;
    const { invoice, created } = await issueInvoiceOnce({
      tenantId,
      razorpayPaymentId: payment.id || paymentId,
      totalPaise: payment.amount,
      currency: payment.currency || plan.currency,
      planName: plan.name,
      periodStart: start,
      periodEnd: end,
      paidAt: now,
    });
    if (created) await sendPaymentReceived({ tenantId, invoiceId: invoice.id, amountPaise: invoice.totalPaise });
  } catch {
    console.warn("[billing] could not issue the invoice at checkout; the payment webhook or the backfill job will");
  }
}

export async function cancelAtPeriodEnd(actor: Actor) {
  const sub = await prisma.subscription.findUnique({ where: { tenantId: actor.tenantId } });
  if (!sub?.razorpaySubscriptionId || sub.status !== "active") throw new HttpError(409, "There is no active subscription to cancel.");
  if (sub.cancelAtPeriodEnd) return { ok: true, currentPeriodEnd: sub.currentPeriodEnd };
  await cancelSubscription(sub.razorpaySubscriptionId, true);
  await prisma.subscription.update({ where: { id: sub.id }, data: { cancelAtPeriodEnd: true } });
  return { ok: true, currentPeriodEnd: sub.currentPeriodEnd };
}

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

function text(value: unknown, field: string, max: number, required: boolean): string {
  if (value === undefined || value === null || value === "") {
    if (required) throw new HttpError(400, `${field} is required.`);
    return "";
  }
  if (typeof value !== "string" || value.trim().length > max) throw new HttpError(400, `${field} must be up to ${max} characters.`);
  return value.trim();
}

export function validateProfile(body: Record<string, unknown>) {
  const gstin = text(body.gstin, "GSTIN", 15, false).toUpperCase();
  if (gstin && !isValidGstin(gstin)) throw new HttpError(400, "GSTIN must be 15 characters in the standard GSTIN format.");
  const pincode = text(body.pincode, "Pincode", 6, false);
  if (pincode && !/^[1-9][0-9]{5}$/.test(pincode)) throw new HttpError(400, "Pincode must be 6 digits.");
  const billingEmail = text(body.billingEmail, "Billing email", 320, true).toLowerCase();
  if (!EMAIL.test(billingEmail)) throw new HttpError(400, "Enter a valid billing email.");
  return {
    legalName: text(body.legalName, "Legal name", 200, true),
    gstin: gstin || null,
    addressLine: text(body.addressLine, "Address", 300, true),
    state: text(body.state, "State", 60, true),
    pincode: pincode || null,
    billingEmail,
  };
}

export async function saveBillingProfile(actor: Actor, body: Record<string, unknown>) {
  const data = validateProfile(body);
  const saved = await prisma.billingProfile.upsert({ where: { tenantId: actor.tenantId }, create: { tenantId: actor.tenantId, ...data }, update: data });
  await fillInvoicesIssuedWithoutBuyer(actor.tenantId, saved);
  return saved;
}

/**
 * A workspace that paid before entering its billing details got invoices reading "Not provided". Those invoices never carried a buyer,
 * so they are completed once from the profile (and the place of supply is set from it if it was unknown). An invoice that already
 * names a buyer is never rewritten: its buyer details stay as issued.
 */
async function fillInvoicesIssuedWithoutBuyer(tenantId: string, profile: { legalName: string; gstin: string | null; addressLine: string; state: string; pincode: string | null }) {
  try {
    const address = [profile.addressLine, profile.state, profile.pincode].filter(Boolean).join(", ");
    const open = await prisma.invoice.findMany({ where: { tenantId, customerName: null }, select: { id: true, number: true }, take: 100 });
    if (open.length === 0) return;
    await prisma.invoice.updateMany({
      where: { tenantId, customerName: null, id: { in: open.map((i) => i.id) } },
      data: { customerName: profile.legalName, customerGstin: profile.gstin, customerAddress: address },
    });
    const state = buyerStateCode(profile.gstin, address);
    for (const inv of open) {
      const meta = await readInvoiceMeta(inv.number);
      if (meta && meta.buyerStateCode === null && state) {
        await prisma.platformSetting.upsert({ where: { key: invoiceMetaKey(inv.number) }, create: { key: invoiceMetaKey(inv.number), value: { ...meta, buyerStateCode: state } }, update: { value: { ...meta, buyerStateCode: state } } });
      }
    }
  } catch {
    console.warn("[billing] could not complete the buyer details on earlier invoices");
  }
}

export function listInvoices(actor: Actor) {
  return prisma.invoice.findMany({ where: { tenantId: actor.tenantId }, orderBy: { issuedAt: "desc" }, take: 100 });
}

export async function getInvoice(tenantId: string, id: string) {
  const invoice = await prisma.invoice.findFirst({ where: { id, tenantId } });
  if (!invoice) throw new HttpError(404, "Invoice not found.");
  return invoice;
}

