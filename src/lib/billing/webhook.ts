import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { sendPaymentFailedNotice } from "@/lib/lifecycle/notices";
import { getSettings } from "@/lib/platform-settings";
import { issueInvoiceOnce } from "./invoice";
import { sendPaymentReceived } from "./notify";
import { verifyWebhookSignature, type RzSubscription } from "./razorpay";
import { isStaleEvent, markApplied } from "./ordering";
import { invoiceUpgradeCharge, planFromEntity, recordPlanSwitch, takeOverIfNext } from "./plan-change";
import { patchFromEntity } from "./sync";

export const WEBHOOK_MAX_BYTES = 1_000_000;

type Entity = Record<string, unknown>;
type Payload = { event?: string; created_at?: number; payload?: { subscription?: { entity?: RzSubscription }; payment?: { entity?: Entity } } };

const FALLBACK_STATUS: Record<string, string> = {
  "subscription.activated": "active",
  "subscription.charged": "active",
  "subscription.resumed": "active",
  "subscription.pending": "pending",
  "subscription.halted": "halted",
  "subscription.cancelled": "cancelled",
  "subscription.completed": "completed",
};

const isUniqueViolation = (e: unknown) => typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002";

/** Drops card and UPI details before the event is stored. */
export function redactPayload(payload: unknown): unknown {
  const clone = JSON.parse(JSON.stringify(payload ?? {})) as Payload;
  const payment = clone.payload?.payment?.entity;
  if (payment) {
    delete payment.card;
    delete payment.vpa;
    delete payment.email;
    delete payment.contact;
  }
  return clone;
}

/** The workspace is now past due: tell the owners straight away instead of waiting for the hourly sweep. Never fails the webhook. */
async function noticeFailure(tenantId: string, pastDueSince: Date): Promise<void> {
  try {
    const [tenant, settings] = await Promise.all([prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }), getSettings()]);
    await sendPaymentFailedNotice({ tenantId, workspaceName: tenant?.name ?? "your workspace", pastDueSince, graceDays: settings.graceDays });
  } catch {
    console.warn("[billing] could not queue the payment failed notice");
  }
}

async function applySubscriptionEvent(event: string, payload: Payload): Promise<string | null> {
  const entity = payload.payload?.subscription?.entity;
  if (!entity?.id) return "missing subscription";
  const notes = entity.notes && !Array.isArray(entity.notes) ? entity.notes : {};
  const now = new Date();
  const createdAt = typeof payload.created_at === "number" && Number.isFinite(payload.created_at) ? payload.created_at : null;
  let sub = await prisma.subscription.findUnique({ where: { razorpaySubscriptionId: entity.id }, include: { plan: true } });
  let patch: ReturnType<typeof patchFromEntity> = null;
  let stale = false;
  const payment = payload.payload?.payment?.entity;
  const paid = !!payment && typeof payment.id === "string" && typeof payment.amount === "number" && payment.status === "captured";
  if (!sub) {
    // Not the row's subscription: it may be the new plan that starts when the current one ends (plan-change.ts).
    const taken = await takeOverIfNext({ ...entity, status: entity.status || FALLBACK_STATUS[event] || "" }, notes, createdAt, now);
    if (typeof taken === "string") return taken;
    sub = taken.sub;
  } else {
    if (typeof notes.tenantId !== "string" || notes.tenantId !== sub.tenantId) return "tenant mismatch";

    const status = entity.status || FALLBACK_STATUS[event] || "";
    patch = patchFromEntity({ ...entity, status }, sub, now);
    // A late or retried older event must not undo a newer state. It is still recorded and its payment still invoiced (that is idempotent).
    // The plan Razorpay reports moves with the status: an upgrade applied at once, or a downgrade at renewal (subscription.updated,
    // subscription.charged), never back to an older plan from an older event.
    const newPlan = patch ? await planFromEntity(sub, entity) : null;
    stale = patch ? await isStaleEvent(sub.tenantId, createdAt) : false;
    if (patch && !stale) {
      await prisma.subscription.update({ where: { id: sub.id }, data: { ...patch, ...(newPlan ? { planId: newPlan.id } : {}) } });
      await markApplied(sub.tenantId, createdAt);
      if (newPlan) {
        const fulfilled = await recordPlanSwitch({ tenantId: sub.tenantId, fromCode: sub.plan?.code ?? null, to: newPlan, source: event });
        // The charge that came with it is invoiced under the plan it paid for.
        sub = { ...sub, planId: newPlan.id, plan: { ...sub.plan, id: newPlan.id, code: newPlan.code, name: newPlan.name } };
        // An upgrade this event completes, without its charge in the payload: the charge is found at Razorpay and invoiced
        // (now, or by the plan-change sweep once Razorpay has captured it).
        if (fulfilled?.kind === "upgrade" && !paid && sub.razorpaySubscriptionId) {
          await invoiceUpgradeCharge(sub.tenantId, {
            subscriptionId: sub.razorpaySubscriptionId,
            plan: { name: newPlan.name, currency: sub.plan.currency },
            period: { start: patch.currentPeriodStart ?? sub.currentPeriodStart, end: patch.currentPeriodEnd ?? sub.currentPeriodEnd },
            since: new Date(fulfilled.requestedAt),
          });
        }
      }
      if (patch.status === "past_due" && patch.pastDueSince) await noticeFailure(sub.tenantId, patch.pastDueSince);
    }
  }

  // subscription.updated carries the charge of an upgrade applied at once (the prorated difference).
  if (paid && payment && (event === "subscription.charged" || event === "subscription.activated" || event === "subscription.updated")) {
    const { invoice, created } = await issueInvoiceOnce({
      tenantId: sub.tenantId,
      razorpayPaymentId: payment.id as string,
      totalPaise: payment.amount as number,
      currency: typeof payment.currency === "string" ? payment.currency : sub.plan.currency,
      planName: sub.plan.name,
      periodStart: patch?.currentPeriodStart ?? sub.currentPeriodStart,
      periodEnd: patch?.currentPeriodEnd ?? sub.currentPeriodEnd,
      paidAt: now,
    });
    if (created) await sendPaymentReceived({ tenantId: sub.tenantId, invoiceId: invoice.id, amountPaise: invoice.totalPaise });
  }
  return stale ? "ignored: older than the state already applied" : null;
}

export type WebhookResult = { status: number; body: string };

/** Verifies, de-duplicates and processes one Razorpay webhook delivery. */
export async function handleRazorpayWebhook(rawBody: string, headers: Headers): Promise<WebhookResult> {
  if (!verifyWebhookSignature(rawBody, headers.get("x-razorpay-signature"))) return { status: 401, body: "Invalid signature" };
  let payload: Payload;
  try {
    payload = JSON.parse(rawBody) as Payload;
  } catch {
    return { status: 400, body: "Bad request" };
  }
  const eventId = headers.get("x-razorpay-event-id") || `body-${createHash("sha256").update(rawBody).digest("hex")}`;
  const type = typeof payload.event === "string" ? payload.event.slice(0, 100) : "unknown";

  let recordId: string;
  try {
    recordId = (await prisma.paymentEvent.create({ data: { eventId, type, payload: redactPayload(payload) as object } })).id;
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    const prior = await prisma.paymentEvent.findUnique({ where: { eventId } });
    if (!prior || prior.processedAt) return { status: 200, body: "OK" };
    recordId = prior.id;
  }

  try {
    const problem = type.startsWith("subscription.") ? await applySubscriptionEvent(type, payload) : null;
    await prisma.paymentEvent.update({ where: { id: recordId }, data: { processedAt: new Date(), error: problem } });
    return { status: 200, body: "OK" };
  } catch (e) {
    await prisma.paymentEvent
      .update({ where: { id: recordId }, data: { error: e instanceof Error ? e.message.slice(0, 200) : "failed" } })
      .catch(() => undefined);
    return { status: 500, body: "Processing failed" };
  }
}
