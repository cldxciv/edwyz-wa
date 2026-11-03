/**
 * Plan changes (owner decision 4, 2026-10-31): an upgrade applies at once with proration, a downgrade at renewal.
 *
 * Which way a change goes is planMove (./plan-compare.ts), the same rule the billing page uses: price per month, same interval.
 * - Upgrade (the same billing interval, a higher price): Razorpay's subscription update with schedule_change_at "now". Razorpay
 *   charges the prorated difference straight away and switches the plan; when that charge fails the subscription is not
 *   changed. The local plan switches as soon as Razorpay's answer shows the new plan (else the subscription.updated webhook or
 *   the plan-change sweep applies it). The GST invoice for the difference is issued from Razorpay's paid invoice; when that
 *   charge is captured later, the sweep keeps looking for it for three days (billing:upgrade-invoice:<tenantId>).
 * - Downgrade (the same interval, the same price or less): the same update with schedule_change_at "cycle_end". Nothing is
 *   charged now; the billing page says "Changes to <plan> on <date>", and the plan switches when Razorpay renews on the new
 *   plan (webhook, else the sweep). Choosing the current plan again, or "Keep <plan>", drops the planned change
 *   (cancel_scheduled_changes).
 * - A change of billing interval (monthly to yearly or back) is never prorated: it is scheduled for the renewal like a
 *   downgrade, whatever the prices, and the page says so.
 * - Razorpay cannot update every subscription: those paid by UPI AutoPay or a bank e-mandate are refused, and for domestic cards
 *   only the offer can change (razorpay.com/docs/payments/subscriptions/update). Then the change answers 409 with
 *   code "new_subscription_needed" and says what works instead: end the current plan at the end of the period (the existing
 *   Cancel, so nothing is lost) and start a NEW subscription to the chosen plan that begins that day. That new subscription is
 *   created with start_at = the period end (startNextSubscription): the customer authorises it now, the first charge is on
 *   that date, and the webhook moves the workspace onto it when it starts (takeOverIfNext). Until its first payment goes
 *   through (UPI AutoPay and bank mandates can take days), the ended plan does not lock the workspace (status.ts), no second
 *   subscription can be started (settleNextBeforeSubscribe), and the take-over never leaves another subscription charging.
 *   One the customer never approved is cancelled at Razorpay once its start has passed, and erasing the workspace cancels it.
 * - A plan assigned by hand in the admin console has no Razorpay subscription: 409 with the contact-support text.
 *
 * The planned change is kept in PlatformSetting `billing:plan-change:<tenantId>` (no new table: the key holds the workspace id,
 * so workspace erasure removes it). Every step is audited: billing.plan_change_scheduled, billing.plan_changed,
 * billing.plan_change_cancelled, billing.plan_change_unavailable and billing.plan_change_failed.
 */
import type { Plan, Subscription } from "@/generated/prisma/client";
import { audit } from "@/lib/auth/audit";
import { COMPANY } from "@/lib/config";
import { prisma } from "@/lib/db";
import { claimOnce, readState } from "@/lib/lifecycle/state";
import { HttpError, type Actor } from "@/lib/tenancy";
import { issueInvoiceOnce } from "./invoice";
import { sendPaymentReceived } from "./notify";
import { PLAN_CHANGE_PREFIX, planChangeKey } from "./next-subscription";
import { markApplied } from "./ordering";
import { planMove } from "./plan-compare";
import {
  RazorpayRequestError,
  cancelScheduledChanges,
  cancelSubscription,
  createSubscription,
  fetchSubscription,
  listSubscriptionInvoices,
  razorpayKeyId,
  syncPlanToRazorpay,
  updateSubscription,
  verifyCheckoutSignature,
  type RzSubscription,
} from "./razorpay";
import { patchFromEntity } from "./sync";

export const MANUAL_PLAN_TEXT = `Your plan was set up by our team. Contact ${COMPANY.email} to change, renew or cancel it.`;

/** The trial allowance is a plan row too, but nobody subscribes or switches to it. */
const TRIAL_CODE = "trial";

// ===== The planned change =====

type ChangeBase = { toPlanId: string; toPlanName: string; fromPlanId: string; razorpaySubscriptionId: string; at: string; requestedAt: string; requestedBy: string | null };
/**
 * - downgrade: scheduled at Razorpay for the end of the cycle (`at`), on the workspace's own subscription;
 * - upgrade: applied at Razorpay, waiting for Razorpay's answer to show the new plan (rare: normally it switches at once);
 * - next_subscription: a new subscription (`razorpaySubscriptionId`) that starts at `at`, after the current plan was cancelled
 *   at the end of its period; `authorized` once the customer approved it in the payment window; `replaces`: the subscription
 *   it follows (absent on records written before it was kept).
 */
export type PlanChangeState =
  | (ChangeBase & { kind: "downgrade" })
  | (ChangeBase & { kind: "upgrade" })
  | (ChangeBase & { kind: "next_subscription"; authorized: boolean; replaces?: string });

export { PLAN_CHANGE_PREFIX, planChangeKey };

const KINDS = new Set(["downgrade", "upgrade", "next_subscription"]);

function parseState(value: unknown): PlanChangeState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const strings = ["toPlanId", "toPlanName", "fromPlanId", "razorpaySubscriptionId", "at", "requestedAt"] as const;
  if (typeof v.kind !== "string" || !KINDS.has(v.kind) || strings.some((k) => typeof v[k] !== "string")) return null;
  if (Number.isNaN(new Date(v.at as string).getTime())) return null;
  const base = {
    toPlanId: v.toPlanId as string,
    toPlanName: v.toPlanName as string,
    fromPlanId: v.fromPlanId as string,
    razorpaySubscriptionId: v.razorpaySubscriptionId as string,
    at: v.at as string,
    requestedAt: v.requestedAt as string,
    requestedBy: typeof v.requestedBy === "string" ? v.requestedBy : null,
  };
  if (v.kind === "next_subscription") {
    return { ...base, kind: "next_subscription", authorized: v.authorized === true, ...(typeof v.replaces === "string" && v.replaces ? { replaces: v.replaces } : {}) };
  }
  return { ...base, kind: v.kind as "downgrade" | "upgrade" };
}

export async function readPlanChange(tenantId: string): Promise<PlanChangeState | null> {
  const row = await prisma.platformSetting.findUnique({ where: { key: planChangeKey(tenantId) } });
  return parseState(row?.value);
}

async function writePlanChange(tenantId: string, state: PlanChangeState): Promise<void> {
  const key = planChangeKey(tenantId);
  await prisma.platformSetting.upsert({ where: { key }, create: { key, value: state }, update: { value: state } });
}

async function clearPlanChange(tenantId: string): Promise<void> {
  await prisma.platformSetting.deleteMany({ where: { key: planChangeKey(tenantId) } });
}

/** What the billing page shows: "Changes to Growth on 30 Nov 2026" (downgrade, next subscription) or that an upgrade is on its way. */
export type ScheduledChangeView = { kind: PlanChangeState["kind"]; planName: string; at: string; authorized: boolean };

export async function scheduledChangeView(tenantId: string): Promise<ScheduledChangeView | null> {
  try {
    const state = await readPlanChange(tenantId);
    if (!state) return null;
    return { kind: state.kind, planName: state.toPlanName, at: state.at, authorized: state.kind === "next_subscription" ? state.authorized : true };
  } catch {
    return null;
  }
}

// ===== Wording =====

/** "30 Nov 2026", in India's time zone like the rest of the billing copy. */
export function dateText(at: Date | string | null | undefined): string {
  if (!at) return "the end of your current period";
  return new Date(at).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
}

/** How Razorpay names the payment methods it cannot update, in the customer's words. Null: not known. */
export function methodWords(method: string | null | undefined): string | null {
  switch ((method ?? "").toLowerCase()) {
    case "upi":
      return "UPI AutoPay";
    case "emandate":
    case "nach":
      return "a bank mandate";
    case "card":
      return "a card issued in India";
    default:
      return null;
  }
}

/** Payment methods Razorpay never lets us update (no call is made for them). Domestic cards are only known from Razorpay's refusal. */
const NEVER_UPDATABLE = new Set(["upi", "emandate", "nach"]);
/** "Only the offer can be updated": Razorpay's rule for subscriptions paid by a card issued in India. */
const OFFER_ONLY = /only (the )?offers? (can|may)\b/i;
/** A refusal of the update itself ("cannot be updated", "is not supported")... */
const REFUSED = /\b(cannot|can ?not|can't)\b|\bnot (allowed|supported|permitted)\b/i;
const ABOUT_UPDATE = /\bupdat|\bchang|\bmodif/i;
/** ...that names how the subscription is paid. A card on its own is not a refusal: "card declined" is a failed charge. */
const PAYMENT_MEDIUM = /payment (mode|method)|\bupi\b|e-?mandate|\bmandate\b|\bnach\b|\bcards?\b/i;

/**
 * True when Razorpay refused the update for the way the subscription is paid: a 400 saying only the offer can change, or that
 * the update is refused for the payment method (UPI, a mandate, a card), or any 400 on a method Razorpay never updates.
 * Every other refusal (a declined prorated charge, a bad plan, a period mismatch, a pending invoice) is not: the caller passes
 * it on as the usual 502 with Razorpay's own reason.
 */
export function refusedForMethod(error: unknown, method: string | null | undefined): boolean {
  if (!(error instanceof RazorpayRequestError) || error.providerStatus !== 400) return false;
  if (method && NEVER_UPDATABLE.has(method.toLowerCase())) return true;
  const reason = error.providerDescription ?? "";
  return OFFER_ONLY.test(reason) || (REFUSED.test(reason) && ABOUT_UPDATE.test(reason) && PAYMENT_MEDIUM.test(reason));
}

export type NewSubscriptionDetails = { code: "new_subscription_needed"; planId: string; planName: string; endsOn: string | null; method: string | null };

/** 409 with what to do instead: end the current plan at the end of the period, then start the new plan from that day. */
export class PlanChangeNeedsNewSubscription extends HttpError {
  constructor(
    message: string,
    public details: NewSubscriptionDetails,
  ) {
    super(409, message);
  }
}

export function newSubscriptionText(input: { method: string | null; planName: string; endsOn: Date | null }): string {
  const words = methodWords(input.method);
  const why = words
    ? `Your plan is paid with ${words}, and Razorpay cannot change a plan paid this way partway through.`
    : "Razorpay cannot change this plan partway through for the way it is paid.";
  const date = dateText(input.endsOn);
  return `${why} To move to ${input.planName}, end your current plan on ${date} (you keep everything until then), then choose ${input.planName} to start on that day.`;
}

// ===== Applying a switch =====

type SubWithPlan = Subscription & { plan: Plan };
const fromUnix = (v: number | null | undefined) => (typeof v === "number" && v > 0 ? new Date(v * 1000) : null);
const unix = (d: Date) => Math.floor(d.getTime() / 1000);

/** The local plan Razorpay's entity is on, when it differs from the row's. Null when it is the same, unknown, or not given. */
export async function planFromEntity(sub: { planId: string; plan?: { razorpayPlanId?: string | null } | null }, entity: Pick<RzSubscription, "plan_id">): Promise<{ id: string; code: string; name: string } | null> {
  if (!entity.plan_id || entity.plan_id === sub.plan?.razorpayPlanId) return null;
  const local = await prisma.plan.findFirst({ where: { razorpayPlanId: entity.plan_id }, select: { id: true, code: true, name: true } });
  if (!local) {
    console.warn("[billing] Razorpay reports a plan this platform does not know; the workspace keeps its plan");
    return null;
  }
  return local.id === sub.planId ? null : local;
}

/** Audits a switch that took effect and drops the planned change it fulfils. Returns that planned change, or null. */
export async function recordPlanSwitch(input: { tenantId: string; fromCode: string | null; to: { id: string; code: string }; source: string; userId?: string | null }): Promise<PlanChangeState | null> {
  await audit({ tenantId: input.tenantId, userId: input.userId ?? null, action: "billing.plan_changed", target: input.to.id, meta: { from: input.fromCode, to: input.to.code, source: input.source } });
  const pending = await readPlanChange(input.tenantId).catch(() => null);
  if (pending && pending.kind !== "next_subscription" && pending.toPlanId === input.to.id) {
    await clearPlanChange(input.tenantId);
    return pending;
  }
  return null;
}

/**
 * The GST invoice (and receipt) for what an upgrade charged, from Razorpay's paid invoices since the change was asked for.
 * Returns how many paid charges it found (each invoiced once, whoever finds it first), or null when Razorpay could not be read.
 */
async function invoiceChangeCharges(tenantId: string, subscriptionId: string, plan: { name: string; currency: string }, period: { start: Date | null; end: Date | null }, since: Date): Promise<number | null> {
  try {
    const { items } = await listSubscriptionInvoices(subscriptionId);
    let found = 0;
    for (const item of items ?? []) {
      if (item.status !== "paid" || !item.payment_id || !Number.isInteger(item.amount) || (item.amount as number) <= 0) continue;
      const paidAt = fromUnix(item.paid_at);
      // Only what this change charged: earlier periods were invoiced when they were paid.
      if (!paidAt || paidAt.getTime() < since.getTime() - 5 * 60_000) continue;
      found++;
      const { invoice, created } = await issueInvoiceOnce({
        tenantId,
        razorpayPaymentId: item.payment_id,
        totalPaise: item.amount as number,
        currency: item.currency || plan.currency,
        planName: plan.name,
        periodStart: fromUnix(item.billing_start) ?? period.start,
        periodEnd: fromUnix(item.billing_end) ?? period.end,
        paidAt,
      });
      if (created) await sendPaymentReceived({ tenantId, invoiceId: invoice.id, amountPaise: invoice.totalPaise });
    }
    return found;
  } catch {
    console.warn("[billing] could not issue the invoice for a plan upgrade; the plan-change sweep tries again");
    return null;
  }
}

// ----- The upgrade's invoice, until Razorpay has captured the charge -----

/** PlatformSetting `billing:upgrade-invoice:<tenantId>` (holds the workspace id, so erasure removes it). */
export const UPGRADE_INVOICE_PREFIX = "billing:upgrade-invoice:";
const upgradeInvoiceKey = (tenantId: string) => `${UPGRADE_INVOICE_PREFIX}${tenantId}`;
/** How long the sweep keeps looking for an upgrade's paid charge. A recurring debit is usually captured within a day. */
const UPGRADE_INVOICE_WAIT_MS = 3 * 86_400_000;

type UpgradeInvoice = { subscriptionId: string; planName: string; currency: string; since: string; periodStart: string | null; periodEnd: string | null };

function parseUpgradeInvoice(value: unknown): UpgradeInvoice | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (![v.subscriptionId, v.planName, v.currency, v.since].every((s) => typeof s === "string" && s) || Number.isNaN(new Date(v.since as string).getTime())) return null;
  const date = (d: unknown) => (typeof d === "string" && !Number.isNaN(new Date(d).getTime()) ? d : null);
  return { subscriptionId: v.subscriptionId as string, planName: v.planName as string, currency: v.currency as string, since: v.since as string, periodStart: date(v.periodStart), periodEnd: date(v.periodEnd) };
}

async function tryUpgradeInvoice(tenantId: string, job: UpgradeInvoice): Promise<boolean> {
  const found = await invoiceChangeCharges(
    tenantId,
    job.subscriptionId,
    { name: job.planName, currency: job.currency },
    { start: job.periodStart ? new Date(job.periodStart) : null, end: job.periodEnd ? new Date(job.periodEnd) : null },
    new Date(job.since),
  );
  return found !== null && found > 0;
}

/**
 * Issues the GST invoice for an upgrade that was applied (at once, by the webhook or by the sweep). Razorpay often captures a
 * recurring debit after the plan has switched, so when its paid charge is not there yet the sweep keeps looking for it
 * (reconcileUpgradeInvoices). `since`: when the upgrade was asked for. Never throws.
 */
export async function invoiceUpgradeCharge(tenantId: string, input: { subscriptionId: string; plan: { name: string; currency: string }; period: { start: Date | null; end: Date | null }; since: Date }): Promise<void> {
  const job: UpgradeInvoice = {
    subscriptionId: input.subscriptionId,
    planName: input.plan.name,
    currency: input.plan.currency,
    since: input.since.toISOString(),
    periodStart: input.period.start?.toISOString() ?? null,
    periodEnd: input.period.end?.toISOString() ?? null,
  };
  try {
    if (await tryUpgradeInvoice(tenantId, job)) return;
    const key = upgradeInvoiceKey(tenantId);
    await prisma.platformSetting.upsert({ where: { key }, create: { key, value: job }, update: { value: job } });
  } catch {
    console.warn("[billing] could not keep the upgrade invoice for a later try");
  }
}

/** The sweep's part: looks again for the upgrades' paid charges, and stops looking after three days. Returns how many it invoiced. */
export async function reconcileUpgradeInvoices(now = new Date()): Promise<number> {
  const rows = await prisma.platformSetting.findMany({ where: { key: { startsWith: UPGRADE_INVOICE_PREFIX } }, orderBy: { updatedAt: "asc" }, take: SWEEP_CHECKS });
  let done = 0;
  for (const row of rows) {
    const tenantId = row.key.slice(UPGRADE_INVOICE_PREFIX.length);
    try {
      const job = parseUpgradeInvoice(row.value);
      if (job && (await tryUpgradeInvoice(tenantId, job))) {
        done++;
      } else if (job && now.getTime() - new Date(job.since).getTime() < UPGRADE_INVOICE_WAIT_MS) {
        await touch(row.key, now);
        continue;
      } else if (job) {
        console.warn("[billing] an upgrade's charge was not found at Razorpay within three days; its invoice needs a manual check");
      }
      await prisma.platformSetting.deleteMany({ where: { key: row.key } });
    } catch {
      console.warn("[billing] an upgrade invoice could not be checked");
    }
  }
  return done;
}

/** Moves a sweep row to the back of the queue without changing it. */
async function touch(key: string, now: Date): Promise<void> {
  await prisma.platformSetting.updateMany({ where: { key }, data: { updatedAt: now } }).catch(() => undefined);
}

// ===== Changing the plan =====

export type PlanChangeResult =
  | { ok: true; change: "upgraded"; planName: string }
  | { ok: true; change: "processing"; planName: string }
  | { ok: true; change: "scheduled"; planName: string; at: string }
  | { ok: true; change: "kept"; planName: string; endsOn: string | null; ended?: boolean };

/** The workspace's subscription when it can be changed online: Razorpay-billed, active and inside its paid period. */
function liveSubscription(sub: SubWithPlan | null, now: Date): (SubWithPlan & { razorpaySubscriptionId: string; currentPeriodEnd: Date }) | null {
  if (!sub?.razorpaySubscriptionId || sub.status !== "active" || !sub.currentPeriodEnd || sub.currentPeriodEnd.getTime() <= now.getTime()) return null;
  return sub as SubWithPlan & { razorpaySubscriptionId: string; currentPeriodEnd: Date };
}

/** POST /api/billing/change-plan { planId }. Owner only (the route checks): an upgrade charges the saved payment method at once. */
export async function changePlan(actor: Actor, planId: unknown, now = new Date()): Promise<PlanChangeResult> {
  if (typeof planId !== "string" || !planId || planId.length > 64) throw new HttpError(400, "Choose a plan.");
  const [plan, row] = await Promise.all([
    prisma.plan.findFirst({ where: { id: planId, active: true } }),
    prisma.subscription.findUnique({ where: { tenantId: actor.tenantId }, include: { plan: true } }),
  ]);
  if (!plan || plan.code === TRIAL_CODE) throw new HttpError(404, "That plan is not available.");
  if (row && !row.razorpaySubscriptionId && row.status === "active") throw new HttpError(409, MANUAL_PLAN_TEXT);
  const sub = liveSubscription(row, now);
  if (!sub) throw new HttpError(409, "You have no active plan to change. Choose a plan below to subscribe.");
  if (sub.cancelAtPeriodEnd) {
    throw new HttpError(409, `Your plan ends on ${dateText(sub.currentPeriodEnd)}. Choose the plan you want under Plans to start it on that day.`);
  }

  const pending = await readPlanChange(actor.tenantId);
  if (plan.id === sub.planId) {
    // Choosing the plan you are on keeps it: a change planned for the renewal is dropped.
    if (pending?.kind === "downgrade") return cancelPlannedChange(actor, now);
    throw new HttpError(409, `You are already on ${plan.name}.`);
  }
  if (pending?.kind === "upgrade") throw new HttpError(409, "Your last plan change is still being confirmed by the payment provider. Try again in a few minutes.");
  if (pending?.kind === "downgrade" && pending.toPlanId === plan.id) {
    return { ok: true, change: "scheduled", planName: plan.name, at: pending.at };
  }

  const remote = await fetchSubscription(sub.razorpaySubscriptionId);
  if (remote.status !== "active" && remote.status !== "authenticated") {
    throw new HttpError(409, "The payment provider is still processing your plan. Try again in a few minutes.");
  }
  const method = typeof remote.payment_method === "string" ? remote.payment_method : null;
  const needsNew = async () => {
    await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "billing.plan_change_unavailable", target: plan.id, meta: { from: sub.plan.code, to: plan.code, method } });
    return new PlanChangeNeedsNewSubscription(newSubscriptionText({ method, planName: plan.name, endsOn: sub.currentPeriodEnd }), {
      code: "new_subscription_needed",
      planId: plan.id,
      planName: plan.name,
      endsOn: sub.currentPeriodEnd.toISOString(),
      method,
    });
  };
  if (method && NEVER_UPDATABLE.has(method.toLowerCase())) throw await needsNew();

  const { razorpayPlanId } = plan.razorpayPlanId ? { razorpayPlanId: plan.razorpayPlanId } : await syncPlanToRazorpay(plan.id);
  // Price per month within one billing interval; a change of interval waits for the renewal (plan-compare.ts).
  const move = planMove(sub.plan, plan);
  const upgrade = move === "upgrade";

  // A different plan replaces the one planned for the renewal.
  if (pending?.kind === "downgrade") {
    await cancelScheduledChanges(sub.razorpaySubscriptionId);
    await clearPlanChange(actor.tenantId);
    await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "billing.plan_change_cancelled", target: pending.toPlanId, meta: { reason: "replaced", to: plan.code } });
  }

  let updated: RzSubscription;
  try {
    updated = await updateSubscription(sub.razorpaySubscriptionId, { razorpayPlanId, scheduleChangeAt: upgrade ? "now" : "cycle_end" });
  } catch (error) {
    if (refusedForMethod(error, method)) throw await needsNew();
    throw error;
  }
  const base = { toPlanId: plan.id, toPlanName: plan.name, fromPlanId: sub.planId, razorpaySubscriptionId: sub.razorpaySubscriptionId, requestedAt: now.toISOString(), requestedBy: actor.userId };

  if (upgrade) {
    if (updated.plan_id !== razorpayPlanId) {
      // Accepted but not on the new plan yet: the subscription.updated webhook (or the sweep) switches it, and then invoices
      // what was charged since `requestedAt`.
      await writePlanChange(actor.tenantId, { ...base, kind: "upgrade", at: now.toISOString() });
      await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "billing.plan_change_scheduled", target: plan.id, meta: { from: sub.plan.code, to: plan.code, when: "now", confirmed: false } });
      return { ok: true, change: "processing", planName: plan.name };
    }
    const patch = patchFromEntity(updated, sub, now);
    const period = patch?.status === "active" ? { ...(patch.currentPeriodStart ? { currentPeriodStart: patch.currentPeriodStart } : {}), ...(patch.currentPeriodEnd ? { currentPeriodEnd: patch.currentPeriodEnd } : {}) } : {};
    await prisma.subscription.update({ where: { id: sub.id }, data: { planId: plan.id, ...period } });
    // Older webhooks (from before the switch) must not move the workspace back.
    await markApplied(actor.tenantId, unix(now));
    await recordPlanSwitch({ tenantId: actor.tenantId, fromCode: sub.plan.code, to: plan, source: "upgrade", userId: actor.userId });
    await invoiceUpgradeCharge(actor.tenantId, { subscriptionId: sub.razorpaySubscriptionId, plan, period: { start: sub.currentPeriodStart, end: period.currentPeriodEnd ?? sub.currentPeriodEnd }, since: now });
    return { ok: true, change: "upgraded", planName: plan.name };
  }

  const at = fromUnix(updated.change_scheduled_at) ?? sub.currentPeriodEnd;
  await writePlanChange(actor.tenantId, { ...base, kind: "downgrade", at: at.toISOString() });
  const interval: Record<string, number> = move === "interval" ? { fromMonths: sub.plan.intervalMonths, toMonths: plan.intervalMonths } : {};
  await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "billing.plan_change_scheduled", target: plan.id, meta: { from: sub.plan.code, to: plan.code, when: "cycle_end", at: at.toISOString(), ...interval } });
  return { ok: true, change: "scheduled", planName: plan.name, at: at.toISOString() };
}

/**
 * POST /api/billing/change-plan { cancelScheduled: true }: drops the planned change. A downgrade is cancelled at Razorpay
 * (the plan renews as it is); a new subscription that has not started is cancelled at Razorpay before it charges anything
 * (the current plan still ends on its date, as asked when it was cancelled). An upgrade already charged cannot be undone.
 */
export async function cancelPlannedChange(actor: Actor, now = new Date()): Promise<PlanChangeResult & { change: "kept" }> {
  const [pending, row] = await Promise.all([readPlanChange(actor.tenantId), prisma.subscription.findUnique({ where: { tenantId: actor.tenantId }, include: { plan: true } })]);
  if (!pending) throw new HttpError(409, "There is no planned plan change to cancel.");
  if (pending.kind === "upgrade") throw new HttpError(409, "This upgrade is already being applied, so it cannot be cancelled.");
  if (pending.kind === "downgrade") {
    if (row?.razorpaySubscriptionId) await cancelScheduledChanges(row.razorpaySubscriptionId);
  } else {
    try {
      await cancelSubscription(pending.razorpaySubscriptionId, false);
    } catch (error) {
      // A subscription the customer never approved cannot charge anything; one that was approved must be cancelled first.
      if (pending.authorized) throw error;
    }
  }
  await clearPlanChange(actor.tenantId);
  await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "billing.plan_change_cancelled", target: pending.toPlanId, meta: { kind: pending.kind, reason: "owner" } });
  const endsOn = pending.kind === "next_subscription" && row?.currentPeriodEnd && row.currentPeriodEnd > now ? row.currentPeriodEnd.toISOString() : null;
  // Called off after the current plan already ended (its new plan was still waiting for its first payment): nothing runs now.
  const ended = pending.kind === "next_subscription" && !endsOn && !!row?.currentPeriodEnd;
  return { ok: true, change: "kept", planName: row?.plan?.name ?? "", endsOn, ...(ended ? { ended: true } : {}) };
}

/** The plan was cancelled for the end of its period: a downgrade planned for that renewal will not happen. Never throws. */
export async function dropPlannedDowngrade(tenantId: string, userId: string | null): Promise<void> {
  try {
    const pending = await readPlanChange(tenantId);
    if (pending?.kind !== "downgrade" && pending?.kind !== "upgrade") return;
    await clearPlanChange(tenantId);
    await audit({ tenantId, userId, action: "billing.plan_change_cancelled", target: pending.toPlanId, meta: { kind: pending.kind, reason: "plan_cancelled" } });
  } catch {
    console.warn("[billing] could not drop the planned plan change after a cancel");
  }
}

// ===== A new subscription that starts when the current plan ends =====

export type NextSubscriptionInit = { keyId: string; subscriptionId: string; name: string; description: string; startsOn: string };

/** Razorpay statuses in which a subscription can still charge (or is charging). */
const CAN_CHARGE = new Set(["active", "authenticated", "pending"]);

/** The 409 when an approved new plan is waiting to start: a second subscription would charge twice. */
export function nextPendingText(pending: { toPlanName: string; at: string }, now = new Date()): string {
  const started = new Date(pending.at).getTime() <= now.getTime();
  return started
    ? `${pending.toPlanName} is starting. It switches on as soon as its first payment goes through. To choose another plan, cancel that change first.`
    : `${pending.toPlanName} is already set to start on ${dateText(pending.at)}. To choose another plan, cancel that change first.`;
}

/**
 * Before a fresh subscription (startSubscription, when the workspace has no live plan): a new plan set to start when the old one
 * ended must never run beside a second one. Approved (here, or at Razorpay though the payment window's confirmation never
 * reached us): 409, cancel that change first. Already started: the workspace is moved onto it, and 409 says it is on that plan.
 * Never approved: it is cancelled at Razorpay (it has charged nothing) and dropped, so the new checkout is the only one.
 */
export async function settleNextBeforeSubscribe(actor: Actor, now = new Date()): Promise<void> {
  const pending = await readPlanChange(actor.tenantId);
  if (pending?.kind !== "next_subscription") return;
  let approved = pending.authorized;
  if (!approved) {
    const remote = await fetchSubscription(pending.razorpaySubscriptionId).catch(() => null);
    if (remote?.status === "active" && typeof (await takeOverIfNext(remote, { tenantId: actor.tenantId }, null, now)) !== "string") {
      throw new HttpError(409, `You are already on ${pending.toPlanName}.`);
    }
    approved = !!remote && CAN_CHARGE.has(remote.status);
  }
  if (approved) throw new HttpError(409, nextPendingText(pending, now));
  await cancelSubscription(pending.razorpaySubscriptionId, false).catch(() => undefined);
  await clearPlanChange(actor.tenantId);
  await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "billing.plan_change_cancelled", target: pending.toPlanId, meta: { kind: "next_subscription", reason: "replaced" } });
}

/**
 * The second half of "end the current plan, then start the new one": the current plan is cancelled for the end of its period and
 * still open. A new Razorpay subscription is created with start_at = that end, so nothing is paid twice; the customer approves it
 * in the payment window now and the first charge is on that day. The workspace's own row is not touched until it starts.
 */
export async function startNextSubscription(actor: Actor, plan: Plan, current: Subscription & { razorpaySubscriptionId: string; currentPeriodEnd: Date }, now = new Date()): Promise<NextSubscriptionInit> {
  if (plan.code === TRIAL_CODE) throw new HttpError(404, "That plan is not available.");
  const pending = await readPlanChange(actor.tenantId);
  if (pending?.kind === "next_subscription") {
    if (pending.authorized) throw new HttpError(409, nextPendingText(pending, now));
    // An earlier attempt that was never approved: drop it so only one can ever start.
    await cancelSubscription(pending.razorpaySubscriptionId, false).catch(() => undefined);
  }
  const { razorpayPlanId } = plan.razorpayPlanId ? { razorpayPlanId: plan.razorpayPlanId } : await syncPlanToRazorpay(plan.id);
  const created = await createSubscription({
    razorpayPlanId,
    intervalMonths: plan.intervalMonths,
    notes: { tenantId: actor.tenantId, planCode: plan.code, startsAfter: current.razorpaySubscriptionId },
    startAt: unix(current.currentPeriodEnd),
  });
  const at = current.currentPeriodEnd.toISOString();
  await writePlanChange(actor.tenantId, {
    kind: "next_subscription",
    authorized: false,
    replaces: current.razorpaySubscriptionId,
    toPlanId: plan.id,
    toPlanName: plan.name,
    fromPlanId: current.planId,
    razorpaySubscriptionId: created.id,
    at,
    requestedAt: now.toISOString(),
    requestedBy: actor.userId,
  });
  await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "billing.plan_change_scheduled", target: plan.id, meta: { to: plan.code, when: "new_subscription", at } });
  return { keyId: razorpayKeyId(), subscriptionId: created.id, name: "Edwyz WA", description: `${plan.name}, from ${dateText(at)}`, startsOn: at };
}

/**
 * Checkout confirmation for the next subscription (called by confirmCheckout when the id is not the workspace's own). The
 * signature must match that subscription, Razorpay must say the customer approved it (authenticated), and a payment id works
 * once. Nothing about access changes here; the plan switches when the subscription starts. Null: not the next subscription.
 */
export async function confirmNextSubscription(tenantId: string, input: { paymentId: string; subscriptionId: string; signature: string }, now = new Date()): Promise<{ ok: true; scheduled: true; startsOn: string } | { ok: true } | null> {
  const pending = await readPlanChange(tenantId);
  if (pending?.kind !== "next_subscription" || pending.razorpaySubscriptionId !== input.subscriptionId) return null;
  if (!verifyCheckoutSignature(input.paymentId, pending.razorpaySubscriptionId, input.signature)) throw new HttpError(400, "Payment could not be verified.");
  if (pending.authorized) return { ok: true, scheduled: true, startsOn: pending.at };
  const usedKey = `billing:checkout-payment:${tenantId}:${input.paymentId}`;
  if (await readState(usedKey)) throw new HttpError(409, "This payment confirmation was already used. If your plan is not active, contact support.");
  const remote = await fetchSubscription(pending.razorpaySubscriptionId);
  const remoteTenant = remote.notes && !Array.isArray(remote.notes) ? remote.notes.tenantId : undefined;
  if (typeof remoteTenant === "string" && remoteTenant !== tenantId) throw new HttpError(400, "This payment does not match your subscription.");
  if (remote.status === "active") {
    // It has already started (the old period ended meanwhile): move the workspace onto it now.
    await takeOverIfNext(remote, { tenantId }, null, now);
    await claimOnce(usedKey);
    return { ok: true };
  }
  if (remote.status !== "authenticated") {
    throw new HttpError(409, "Your payment method has not been confirmed by the payment provider yet. Your new plan is set up as soon as it is.");
  }
  await writePlanChange(tenantId, { ...pending, authorized: true });
  await claimOnce(usedKey);
  return { ok: true, scheduled: true, startsOn: pending.at };
}

/**
 * The row holds a subscription that is neither the next one nor the one it follows (one started while the next waited).
 * Only one may charge: when the held one can still charge, the next one is cancelled at Razorpay (an error here is thrown,
 * so the webhook or the sweep tries again) and the change is dropped; otherwise the held one is cancelled and audited.
 * Returns a problem string when the next one must not take over.
 */
async function settleHeldSubscription(tenantId: string, row: SubWithPlan, entity: RzSubscription, pending: PlanChangeState & { kind: "next_subscription" }): Promise<string | null> {
  const held = row.razorpaySubscriptionId;
  const follows = pending.replaces ? held === pending.replaces : row.cancelAtPeriodEnd;
  if (!held || held === entity.id || follows) return null;
  const heldStatus = await fetchSubscription(held).then((r) => r.status).catch(() => null);
  const heldCharges = heldStatus !== null ? CAN_CHARGE.has(heldStatus) : row.status === "active" || row.status === "past_due";
  if (heldCharges) {
    await cancelSubscription(entity.id, false);
    await clearPlanChange(tenantId);
    // Its first payment may already have gone through: the team checks whether it needs a refund.
    await audit({ tenantId, action: "billing.plan_change_failed", target: pending.toPlanId, meta: { kind: "next_subscription", reason: "another_subscription_live", cancelled: entity.id, kept: held, paidCount: entity.paid_count ?? null } });
    console.warn("[billing] a new plan started beside another live subscription and was cancelled; check whether its first payment needs a refund");
    return "next subscription cancelled: the workspace already has a live subscription";
  }
  if (heldStatus === null || !["cancelled", "completed", "expired"].includes(heldStatus)) {
    await cancelSubscription(held, false).catch(() => undefined);
  }
  await audit({ tenantId, action: "billing.subscription_replaced", target: row.id, meta: { cancelled: held, status: heldStatus, by: entity.id } });
  return null;
}

/**
 * A Razorpay event for a subscription the workspace's row does not hold. When it is the workspace's next subscription and it is
 * now active, the row moves onto it (new subscription id, the new plan, its period) and the planned change is done; a different
 * subscription the row holds is settled first (settleHeldSubscription), so two never charge. When it ended before it started,
 * the planned change is dropped. Anything else: a problem string for the event log.
 */
export async function takeOverIfNext(entity: RzSubscription, notes: Record<string, unknown>, createdAt: number | null, now: Date): Promise<{ sub: SubWithPlan } | string> {
  const tenantId = typeof notes.tenantId === "string" ? notes.tenantId : null;
  if (!tenantId) return "unknown subscription";
  const pending = await readPlanChange(tenantId);
  if (pending?.kind !== "next_subscription" || pending.razorpaySubscriptionId !== entity.id) return "unknown subscription";
  if (entity.status === "active") {
    const row = await prisma.subscription.findUnique({ where: { tenantId }, include: { plan: true } });
    if (!row) return "unknown subscription";
    const refused = await settleHeldSubscription(tenantId, row, entity, pending);
    if (refused) return refused;
    const patch = patchFromEntity(entity, { pastDueSince: null, currentPeriodEnd: null }, now);
    const start = patch?.currentPeriodStart ?? fromUnix(entity.start_at) ?? now;
    const sub = await prisma.subscription.update({
      where: { id: row.id },
      data: {
        razorpaySubscriptionId: entity.id,
        planId: pending.toPlanId,
        status: "active",
        cancelAtPeriodEnd: false,
        pastDueSince: null,
        currentPeriodStart: start,
        ...(patch?.currentPeriodEnd ? { currentPeriodEnd: patch.currentPeriodEnd } : {}),
      },
      include: { plan: true },
    });
    await markApplied(tenantId, createdAt ?? unix(now));
    await clearPlanChange(tenantId);
    await audit({ tenantId, action: "billing.plan_changed", target: pending.toPlanId, meta: { from: row.plan?.code ?? null, to: sub.plan?.code ?? null, source: "new_subscription" } });
    return { sub };
  }
  if (["cancelled", "completed", "expired", "halted"].includes(entity.status)) {
    await clearPlanChange(tenantId);
    await audit({ tenantId, action: "billing.plan_change_failed", target: pending.toPlanId, meta: { kind: "next_subscription", status: entity.status } });
    return "next subscription ended before it started";
  }
  return "next subscription has not started yet";
}

// ===== The sweep: planned changes whose webhook never came =====

/** Rows read per page; every row is looked at (they are few, and one that is not due costs no call). */
const SWEEP_PAGE = 200;
const SWEEP_SCAN_MAX = 5000;
/** Razorpay checks per run. Each check moves its row to the back, so rows that stay unresolved cannot hold up the rest. */
const SWEEP_CHECKS = 50;
const UPGRADE_WAIT_MS = 10 * 60_000;
const RENEWAL_WAIT_MS = 60 * 60_000;

type SweepRow = { key: string; tenantId: string; state: PlanChangeState | null; updatedAt: Date };

async function sweepRows(): Promise<SweepRow[]> {
  const out: SweepRow[] = [];
  let cursor: string | null = null;
  while (out.length < SWEEP_SCAN_MAX) {
    const page: { key: string; value: unknown; updatedAt: Date }[] = await prisma.platformSetting.findMany({
      where: { key: { startsWith: PLAN_CHANGE_PREFIX, ...(cursor ? { gt: cursor } : {}) } },
      orderBy: { key: "asc" },
      take: SWEEP_PAGE,
      select: { key: true, value: true, updatedAt: true },
    });
    for (const row of page) out.push({ key: row.key, tenantId: row.key.slice(PLAN_CHANGE_PREFIX.length), state: parseState(row.value), updatedAt: row.updatedAt });
    if (page.length < SWEEP_PAGE) break;
    cursor = page[page.length - 1].key;
  }
  return out;
}

/** A downgrade or an upgrade past its time, checked against the workspace's own subscription. True when something changed. */
async function checkOwnChange(tenantId: string, state: PlanChangeState & { kind: "downgrade" | "upgrade" }, now: Date): Promise<boolean> {
  const sub = await prisma.subscription.findUnique({ where: { tenantId }, include: { plan: true } });
  if (!sub?.razorpaySubscriptionId || sub.razorpaySubscriptionId !== state.razorpaySubscriptionId) {
    await clearPlanChange(tenantId);
    return true;
  }
  const remote = await fetchSubscription(sub.razorpaySubscriptionId);
  const local = await planFromEntity(sub, remote);
  if (local) {
    // Razorpay bills another plan than the row says: the planned one (the webhook never came), or some other plan (changed in
    // the dashboard). Either way the row follows what the customer pays for.
    const patch = patchFromEntity(remote, sub, now);
    const period = patch?.status === "active" ? { ...(patch.currentPeriodStart ? { currentPeriodStart: patch.currentPeriodStart } : {}), ...(patch.currentPeriodEnd ? { currentPeriodEnd: patch.currentPeriodEnd } : {}) } : {};
    await prisma.subscription.update({ where: { id: sub.id }, data: { planId: local.id, ...period } });
    await recordPlanSwitch({ tenantId, fromCode: sub.plan.code, to: local, source: "reconcile" });
    if (local.id !== state.toPlanId) {
      await clearPlanChange(tenantId);
      await audit({ tenantId, action: "billing.plan_change_failed", target: state.toPlanId, meta: { kind: state.kind, reason: "plan_moved", to: local.code } });
    } else if (state.kind === "upgrade") {
      await invoiceUpgradeCharge(tenantId, {
        subscriptionId: sub.razorpaySubscriptionId,
        plan: { name: local.name, currency: sub.plan.currency },
        period: { start: period.currentPeriodStart ?? sub.currentPeriodStart, end: period.currentPeriodEnd ?? sub.currentPeriodEnd },
        since: new Date(state.requestedAt),
      });
    }
    return true;
  }
  if (sub.planId === state.toPlanId || state.kind === "upgrade" || !remote.has_scheduled_changes) {
    // Already on it, an upgrade that never took (its charge failed), or a downgrade Razorpay no longer plans.
    await clearPlanChange(tenantId);
    if (sub.planId !== state.toPlanId) await audit({ tenantId, action: "billing.plan_change_failed", target: state.toPlanId, meta: { kind: state.kind } });
    return true;
  }
  return false;
}

/** A next subscription past its start. True when something changed. */
async function checkNextSubscription(tenantId: string, state: PlanChangeState & { kind: "next_subscription" }, now: Date): Promise<boolean> {
  const remote = await fetchSubscription(state.razorpaySubscriptionId);
  if (remote.status === "created") {
    // Never approved, and the day it was to start has passed. Cancelled at Razorpay first (an error is retried next run), so an
    // approval that comes later cannot start it unseen, then dropped: the billing page stops asking to finish it.
    await cancelSubscription(state.razorpaySubscriptionId, false);
    await clearPlanChange(tenantId);
    await audit({ tenantId, action: "billing.plan_change_failed", target: state.toPlanId, meta: { kind: "next_subscription", status: "created", reason: "not_approved" } });
    return true;
  }
  const out = await takeOverIfNext(remote, { tenantId }, null, now);
  return typeof out !== "string" || out.includes("ended") || out.includes("cancelled");
}

/**
 * Every 15 minutes (src/lib/billing/worker.ts): a planned change past its time is checked against Razorpay. A downgrade or upgrade
 * whose subscription now shows the new plan is applied (an upgrade is then invoiced); one Razorpay no longer has (dropped in the
 * dashboard, or a failed upgrade charge) is cleared, and one Razorpay moved to another plan follows that plan. A next subscription
 * that started is taken over, one that ended is cleared, and one never approved is cancelled at Razorpay and cleared. Then the
 * upgrades whose charge Razorpay had not captured yet are invoiced. Returns how many planned changes changed.
 */
export async function reconcilePlanChanges(now = new Date()): Promise<number> {
  const rows = await sweepRows();
  const due: (SweepRow & { state: PlanChangeState })[] = [];
  let changed = 0;
  for (const row of rows) {
    if (!row.state) {
      await clearPlanChange(row.tenantId).catch(() => undefined);
      continue;
    }
    const dueAt = new Date(row.state.at).getTime() + (row.state.kind === "upgrade" ? UPGRADE_WAIT_MS : RENEWAL_WAIT_MS);
    if (dueAt <= now.getTime()) due.push(row as SweepRow & { state: PlanChangeState });
  }
  // Least recently checked first.
  due.sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime() || a.key.localeCompare(b.key));
  for (const row of due.slice(0, SWEEP_CHECKS)) {
    const { tenantId, state } = row;
    try {
      const done = state.kind === "next_subscription" ? await checkNextSubscription(tenantId, state, now) : await checkOwnChange(tenantId, state, now);
      if (done) changed++;
      else await touch(row.key, now);
    } catch {
      console.warn("[billing] a planned plan change could not be checked");
      await touch(row.key, now);
    }
  }
  await reconcileUpgradeInvoices(now).catch(() => console.warn("[billing] the upgrade invoices could not be checked"));
  return changed;
}

// ===== Erasing the workspace =====

/**
 * Workspace erasure (src/lib/lifecycle/erase-workspace.ts) calls this before anything is deleted. A new plan set to start when
 * the old one ended is a Razorpay subscription of its own, and its only record here is the planned change that erasure deletes;
 * left alone it would start and charge every month for a workspace that no longer exists. It is cancelled at Razorpay. When that
 * fails and Razorpay does not show it as ended, erasure stops with 409, unless the operator confirmed the workspace's
 * subscriptions were cancelled in Razorpay (allowActiveSubscription). Returns true when there was one.
 */
export async function cancelNextSubscriptionForErasure(tenantId: string, opts: { allowActiveSubscription?: boolean } = {}): Promise<boolean> {
  const pending = await readPlanChange(tenantId);
  if (pending?.kind !== "next_subscription") return false;
  try {
    await cancelSubscription(pending.razorpaySubscriptionId, false);
  } catch {
    const status = await fetchSubscription(pending.razorpaySubscriptionId).then((r) => r.status).catch(() => null);
    const ended = status !== null && ["cancelled", "completed", "expired"].includes(status);
    if (!ended && !opts.allowActiveSubscription) {
      throw new HttpError(409, "This workspace has a new plan waiting to start at Razorpay, and it could not be cancelled. Cancel it in Razorpay first, or confirm it was cancelled.");
    }
  }
  return true;
}
