import { createHmac, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/db";
import { HttpError } from "@/lib/tenancy";

const BASE = "https://api.razorpay.com/v1";
const TIMEOUT_MS = 15_000;

export type RzSubscription = {
  id: string;
  plan_id?: string;
  status: string;
  current_start?: number | null;
  current_end?: number | null;
  paid_count?: number;
  notes?: Record<string, unknown> | unknown[];
  /** "card", "emandate", "upi"...: how the customer pays. UPI and e-mandate subscriptions cannot be updated. */
  payment_method?: string | null;
  start_at?: number | null;
  has_scheduled_changes?: boolean;
  change_scheduled_at?: number | null;
};

/**
 * A request Razorpay answered with an error. Still an HttpError(502) for every caller that only shows the message; the plan
 * change reads the provider's own status and reason to tell "this payment method cannot be changed" apart.
 */
export class RazorpayRequestError extends HttpError {
  constructor(
    message: string,
    public providerStatus: number,
    public providerCode: string | null,
    public providerDescription: string | null,
  ) {
    super(502, message);
  }
}
export type RzPayment = { id: string; amount: number; currency: string; status: string };
/** One invoice Razorpay raised for a subscription charge (the paid ones carry the payment id). */
export type RzInvoice = {
  id: string;
  status: string;
  payment_id?: string | null;
  amount?: number;
  currency?: string;
  paid_at?: number | null;
  billing_start?: number | null;
  billing_end?: number | null;
};
export type RzPlan = { id: string; period: string; interval: number; item: { amount: number; currency: string; name?: string } };

export function razorpayKeyId(): string {
  return process.env.RAZORPAY_KEY_ID ?? "";
}

export function razorpayConfigured(): boolean {
  return Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
}

async function rz<T>(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<T> {
  const id = process.env.RAZORPAY_KEY_ID;
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!id || !secret) throw new HttpError(503, "Payments are not configured yet. Please contact support.");
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new HttpError(502, "The payment provider did not respond. Please try again.");
  }
  const json = (await res.json().catch(() => ({}))) as { error?: { description?: string; code?: string } };
  if (!res.ok) {
    console.warn("[billing] razorpay request failed", method, path.replace(/[A-Za-z0-9]{8,}/g, ":id"), res.status);
    const description = typeof json.error?.description === "string" ? json.error.description.slice(0, 300) : null;
    throw new RazorpayRequestError(`The payment provider rejected the request${description ? `: ${description}` : "."}`, res.status, typeof json.error?.code === "string" ? json.error.code : null, description);
  }
  return json as T;
}

export function createPlan(input: { name: string; amountPaise: number; currency: string; intervalMonths: number; notes?: Record<string, string> }) {
  return rz<RzPlan>("POST", "/plans", {
    period: "monthly",
    interval: input.intervalMonths,
    item: { name: input.name, amount: input.amountPaise, currency: input.currency },
    notes: input.notes,
  });
}

export const fetchPlan = (id: string) => rz<RzPlan>("GET", `/plans/${encodeURIComponent(id)}`);

/** total_count spans about ten years of billing cycles. */
export function totalCountFor(intervalMonths: number): number {
  return Math.max(1, Math.ceil(120 / Math.max(1, intervalMonths)));
}

/** `startAt` (unix seconds): the first charge waits until then; the customer only authorises the payment method now. */
export function createSubscription(input: { razorpayPlanId: string; intervalMonths: number; notes: Record<string, string>; startAt?: number }) {
  return rz<RzSubscription>("POST", "/subscriptions", {
    plan_id: input.razorpayPlanId,
    total_count: totalCountFor(input.intervalMonths),
    customer_notify: true,
    notes: input.notes,
    ...(input.startAt ? { start_at: input.startAt } : {}),
  });
}

/**
 * Moves a subscription to another plan (PATCH /subscriptions/:id). `now` applies at once and Razorpay charges or credits the
 * prorated difference (an upgrade whose charge fails is not applied); `cycle_end` applies when the current cycle ends, with no
 * charge now. Razorpay refuses it for UPI and e-mandate subscriptions, and for domestic cards only the offer can change.
 */
export function updateSubscription(id: string, input: { razorpayPlanId: string; scheduleChangeAt: "now" | "cycle_end" }) {
  return rz<RzSubscription>("PATCH", `/subscriptions/${encodeURIComponent(id)}`, {
    plan_id: input.razorpayPlanId,
    schedule_change_at: input.scheduleChangeAt,
    customer_notify: true,
  });
}

/** Drops a change scheduled for the end of the cycle (the live plan stays as it is). */
export const cancelScheduledChanges = (id: string) => rz<RzSubscription>("POST", `/subscriptions/${encodeURIComponent(id)}/cancel_scheduled_changes`, {});

export const cancelSubscription = (id: string, atCycleEnd = true) =>
  rz<RzSubscription>("POST", `/subscriptions/${encodeURIComponent(id)}/cancel`, { cancel_at_cycle_end: atCycleEnd });

export const fetchPayment = (id: string) => rz<RzPayment>("GET", `/payments/${encodeURIComponent(id)}`);

/** The invoices Razorpay raised for one subscription, newest first. Used to issue our own invoice for a charge whose webhook never arrived. */
export const listSubscriptionInvoices = (subscriptionId: string) =>
  rz<{ items?: RzInvoice[] }>("GET", `/invoices?subscription_id=${encodeURIComponent(subscriptionId)}&count=10`);

export const fetchSubscription = (id: string) => rz<RzSubscription>("GET", `/subscriptions/${encodeURIComponent(id)}`);

function safeEqualHex(expected: string, given: string | null | undefined): boolean {
  if (!given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Checkout success signature: HMAC SHA256 of "payment_id|subscription_id" with the key secret. Use the stored subscription id. */
export function verifyCheckoutSignature(paymentId: string, storedSubscriptionId: string, signature: string, secret = process.env.RAZORPAY_KEY_SECRET): boolean {
  if (!secret) return false;
  const expected = createHmac("sha256", secret).update(`${paymentId}|${storedSubscriptionId}`).digest("hex");
  return safeEqualHex(expected, signature);
}

/** Webhook signature: HMAC SHA256 of the raw body with the webhook secret. */
export function verifyWebhookSignature(rawBody: string, signature: string | null, secret = process.env.RAZORPAY_WEBHOOK_SECRET): boolean {
  if (!secret) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  return safeEqualHex(expected, signature);
}

/**
 * Creates the plan in Razorpay when the plan has no razorpayPlanId. Razorpay plans are immutable, so a plan that already has one
 * is only checked: if the price or interval differs, the admin must create a new plan instead.
 */
export async function syncPlanToRazorpay(planId: string): Promise<{ razorpayPlanId: string }> {
  const plan = await prisma.plan.findUnique({ where: { id: planId } });
  if (!plan) throw new HttpError(404, "Plan not found.");
  if (plan.pricePaise < 100) throw new HttpError(400, "A plan price must be at least 100 paise (Rs 1).");
  if (plan.razorpayPlanId) {
    const remote = await fetchPlan(plan.razorpayPlanId);
    if (remote.item.amount !== plan.pricePaise || remote.item.currency !== plan.currency || remote.interval !== plan.intervalMonths) {
      throw new HttpError(409, "Razorpay plans cannot be changed. Create a new plan with the new price instead.");
    }
    return { razorpayPlanId: plan.razorpayPlanId };
  }
  const created = await createPlan({
    name: plan.name,
    amountPaise: plan.pricePaise,
    currency: plan.currency,
    intervalMonths: plan.intervalMonths,
    notes: { planCode: plan.code },
  });
  await prisma.plan.update({ where: { id: plan.id }, data: { razorpayPlanId: created.id } });
  return { razorpayPlanId: created.id };
}
