import { planMove } from "@/lib/billing/plan-compare";

export type BannerInput = { state: string; daysLeftInTrial: number | null; reason?: string };
export type Banner = { tone: "warn" | "bad"; text: string };

/** What the workspace banner should say, or null when nothing needs attention. */
export function bannerMessage(status: BannerInput): Banner | null {
  switch (status.state) {
    case "trialing":
      if (status.daysLeftInTrial !== null && status.daysLeftInTrial <= 3) {
        const d = status.daysLeftInTrial;
        return { tone: "warn", text: `Your free trial ends in ${d} ${d === 1 ? "day" : "days"}. Subscribe to keep sending messages.` };
      }
      return null;
    case "past_due_grace":
      return { tone: "warn", text: "Your last payment failed. Choose a plan to subscribe again and keep sending messages." };
    case "locked":
      return { tone: "bad", text: `${status.reason ?? "Your subscription is inactive."} Your workspace is read-only until you subscribe.` };
    case "suspended":
      return { tone: "bad", text: status.reason ?? "This workspace has been suspended. Contact support." };
    default:
      return null;
  }
}

export function intervalLabel(months: number): string {
  if (months === 1) return "month";
  if (months === 12) return "year";
  return `${months} months`;
}

export type PlanLike = {
  pricePaise: number;
  currency: string;
  intervalMonths: number;
  seatLimit: number | null;
  contactLimit: number | null;
  monthlyBroadcastLimit: number | null;
  aiCreditsMonthly?: number | null;
  adAccountLimit?: number | null;
  scheduledPostLimit?: number | null;
  connectedChannelLimit?: number | null;
};

export function priceText(plan: Pick<PlanLike, "pricePaise" | "currency" | "intervalMonths">): string {
  const amount = (plan.pricePaise / 100).toLocaleString("en-IN", { minimumFractionDigits: plan.pricePaise % 100 === 0 ? 0 : 2 });
  return `${plan.currency === "INR" ? "Rs " : `${plan.currency} `}${amount} per ${intervalLabel(plan.intervalMonths)}`;
}

export function limitLines(plan: PlanLike): string[] {
  const n = (v: number) => v.toLocaleString("en-IN");
  return [
    plan.seatLimit !== null ? `Up to ${n(plan.seatLimit)} team seats` : "No fixed limit on team seats",
    plan.contactLimit !== null ? `Up to ${n(plan.contactLimit)} contacts` : "No fixed limit on contacts",
    plan.monthlyBroadcastLimit !== null ? `Up to ${n(plan.monthlyBroadcastLimit)} broadcast messages a month` : "No fixed limit on broadcast messages",
  ];
}

export const NO_PLANS_TEXT = "Plans are not published yet. Contact us.";

export type StateTone = "good" | "info" | "warn" | "bad";
export type StateSummary = { label: string; tone: StateTone; hint: string };

/** One plain sentence per workspace billing state, with the badge label and tone that go with it. */
export function stateSummary(state: string): StateSummary {
  switch (state) {
    case "trialing":
      return { label: "Free trial", tone: "info", hint: "Everything works during your trial. Choose a plan before it ends to keep sending messages." };
    case "active":
      return { label: "Active", tone: "good", hint: "Your subscription is active. You can send messages as normal." };
    case "past_due_grace":
      return { label: "Payment failed", tone: "warn", hint: "Your last payment did not go through. Everything still works for now, but sending will stop unless you subscribe again." };
    case "locked":
      return { label: "Read-only", tone: "bad", hint: "Your workspace is read-only. You can still see your data, but you cannot send until you subscribe." };
    case "suspended":
      return { label: "Suspended", tone: "bad", hint: "This workspace has been suspended. Contact support to find out why and how to restore it." };
    case "exempt":
      return { label: "Complimentary", tone: "good", hint: "Your workspace is on us. No payment is needed." };
    default:
      return { label: "Unknown", tone: "info", hint: "We could not work out your billing state. Refresh the page or contact support." };
  }
}

export function invoiceStatus(status: string): { label: string; tone: "good" | "info" | "neutral" } {
  if (status === "paid") return { label: "Paid", tone: "good" };
  if (status === "void") return { label: "Cancelled", tone: "neutral" };
  return { label: "Issued", tone: "info" };
}

const RUPEE_PREFIX = (currency: string) => (currency === "INR" ? "Rs " : `${currency} `);

export function formatMoney(paise: number, currency: string): string {
  return `${RUPEE_PREFIX(currency)}${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;
}

export function formatDate(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "";
}

export function planFacts(plan: PlanLike): { label: string; value: string }[] {
  const n = (v: number | null) => (v === null ? "No fixed limit" : v.toLocaleString("en-IN"));
  return [
    { label: "Team seats", value: n(plan.seatLimit) },
    { label: "Contacts", value: n(plan.contactLimit) },
    { label: "Broadcast messages a month", value: n(plan.monthlyBroadcastLimit) },
    ...(plan.aiCreditsMonthly !== undefined ? [{ label: "AI credits a month", value: plan.aiCreditsMonthly === null ? "Platform default" : plan.aiCreditsMonthly.toLocaleString("en-IN") }] : []),
    ...(plan.adAccountLimit !== undefined ? [{ label: "Ad accounts", value: n(plan.adAccountLimit) }] : []),
    ...(plan.scheduledPostLimit !== undefined ? [{ label: "Scheduled posts a month", value: n(plan.scheduledPostLimit) }] : []),
    ...(plan.connectedChannelLimit !== undefined ? [{ label: "Social channels", value: n(plan.connectedChannelLimit) }] : []),
  ];
}

/** Days used and total for the trial progress bar, or null when the trial length is not known. */
export function trialProgress(daysLeft: number | null, trialDays: number): { used: number; total: number } | null {
  if (daysLeft === null || trialDays <= 0) return null;
  const left = Math.min(Math.max(daysLeft, 0), trialDays);
  return { used: trialDays - left, total: trialDays };
}

export function daysLeftText(daysLeft: number): string {
  if (daysLeft <= 0) return "Your trial ends today";
  return `${daysLeft} ${daysLeft === 1 ? "day" : "days"} left in your trial`;
}

/** `manual`: a plan our team assigned by hand. It does not renew by itself and cannot be cancelled or switched online. */
export type SubscriptionLike = { status: string; cancelAtPeriodEnd: boolean; currentPeriodEnd: string | null; plan: { name: string; pricePaise?: number; intervalMonths?: number }; manual?: boolean } | null;

/**
 * A plan change waiting to happen (GET /api/billing `scheduledChange`): a downgrade at the renewal, an upgrade the payment
 * provider has not confirmed yet, or a new subscription that starts when the current plan ends (`authorized` once approved).
 */
export type ScheduledChangeLike = { kind: "downgrade" | "upgrade" | "next_subscription"; planName: string; at: string; authorized: boolean } | null;

/** True for an approved new plan whose start day has come: it is waiting for its first payment to go through. */
const nextStarting = (change: ScheduledChangeLike, now: Date) =>
  !!change && change.kind === "next_subscription" && change.authorized && new Date(change.at).getTime() <= now.getTime();

/** The line under "Your plan" about a planned change: "Changes to Growth on 30 Nov 2026." */
export function scheduledChangeText(change: ScheduledChangeLike, now = new Date()): string | null {
  if (!change) return null;
  if (change.kind === "upgrade") return `Moving to ${change.planName}. It shows here as soon as the payment provider confirms it.`;
  if (change.kind === "next_subscription" && !change.authorized) return `${change.planName} is not set up yet. Choose it again under Plans and finish the payment step to start it on ${formatDate(change.at)}.`;
  if (nextStarting(change, now)) return `${change.planName} is starting. It switches on as soon as its first payment goes through.`;
  return `Changes to ${change.planName} on ${formatDate(change.at)}.`;
}

/**
 * The line under "Your plan" about the paid-until date. Only a live plan (active, or a failed payment Razorpay is still retrying) can
 * renew; a plan that has stopped (a hand-assigned plan past its date, a cancelled or expired one) says when it ended or will end.
 */
export function renewalText(sub: SubscriptionLike, now = new Date()): string | null {
  if (!sub?.currentPeriodEnd) return null;
  const date = formatDate(sub.currentPeriodEnd);
  const live = sub.status === "active" || sub.status === "past_due";
  if (!live && new Date(sub.currentPeriodEnd).getTime() <= now.getTime()) return `Ended on ${date}.`;
  if (sub.manual && sub.status === "active") return `Runs until ${date}. It does not renew by itself.`;
  return sub.cancelAtPeriodEnd || !live ? `Ends on ${date}. It will not renew.` : `Renews on ${date}.`;
}

/** True when the owner may cancel online: an active Razorpay plan that is not already set to end. */
export const canCancelOnline = (sub: SubscriptionLike) => !!sub && sub.status === "active" && !sub.cancelAtPeriodEnd && !sub.manual;

/** True for a live plan our team assigned by hand, which only support can change. */
export const isManualPlan = (sub: SubscriptionLike) => !!sub && sub.status === "active" && !!sub.manual;

/**
 * What a plan card's button does: subscribe (checkout), upgrade now or switch at renewal (POST /api/billing/change-plan),
 * start a new subscription when the current plan ends (checkout with a later start), keep the current plan (drop a planned
 * downgrade), or nothing.
 */
export type PlanAction = "subscribe" | "upgrade" | "downgrade" | "start_later" | "keep" | "none";
export type PlanChoice = { disabled: boolean; current: boolean; reason: string | null; action: PlanAction; label: string };

export type PlanChoiceOptions = {
  /** Only the owner changes a running plan (an upgrade charges the saved payment method). Defaults to true. */
  isOwner?: boolean;
  scheduled?: ScheduledChangeLike;
  now?: Date;
};

export function planChoice(plan: { name: string; pricePaise?: number; intervalMonths?: number }, sub: SubscriptionLike, paymentsConfigured: boolean, opts: PlanChoiceOptions = {}): PlanChoice {
  const isOwner = opts.isOwner ?? true;
  const scheduled = opts.scheduled ?? null;
  const now = opts.now ?? new Date();
  const live = !!sub && sub.status === "active";
  const current = live && sub.plan.name === plan.name;
  const subscribe: PlanChoice = { disabled: false, current, reason: null, action: "subscribe", label: `Subscribe to ${plan.name}` };
  const off = (reason: string | null, label = subscribe.label): PlanChoice => ({ disabled: true, current, reason, action: "none", label });
  if (!paymentsConfigured) return off("Online payment is not set up yet. Contact support to subscribe.", current ? "Current plan" : subscribe.label);
  if (current) {
    // A switch planned for the renewal can be undone from the current plan's card.
    if (scheduled?.kind === "downgrade" && !sub?.manual) {
      return isOwner
        ? { disabled: false, current, reason: `Your plan changes to ${scheduled.planName} on ${formatDate(scheduled.at)}. Keep ${plan.name} to stay on it.`, action: "keep", label: `Keep ${plan.name}` }
        : off("Only the workspace owner can change the plan.", "Current plan");
    }
    return off(null, "Current plan");
  }
  if (isManualPlan(sub)) return off("Your plan was set up by our team. Contact support to change it.");
  // An approved new plan holds the cards even after the current plan has ended: its first payment can take a few days, and
  // a second subscription would charge beside it.
  const approvedNext = scheduled?.kind === "next_subscription" && scheduled.authorized ? scheduled : null;
  if (approvedNext && (!live || !sub || nextStarting(approvedNext, now))) {
    const starting = nextStarting(approvedNext, now);
    if (approvedNext.planName === plan.name) {
      return starting
        ? off(`${plan.name} starts as soon as its first payment goes through.`, "Starting")
        : off(`Your plan changes to ${plan.name} on ${formatDate(approvedNext.at)}.`, `Starts ${formatDate(approvedNext.at)}`);
    }
    return off(`${approvedNext.planName} is already set to start${starting ? "" : ` on ${formatDate(approvedNext.at)}`}. Cancel that change first to choose another plan.`);
  }
  if (!live || !sub) return subscribe;

  const endsOn = sub.currentPeriodEnd ? formatDate(sub.currentPeriodEnd) : "";
  const periodOpen = !sub.currentPeriodEnd || new Date(sub.currentPeriodEnd).getTime() > now.getTime();
  const planned = scheduled && (scheduled.kind !== "next_subscription" || scheduled.authorized) ? scheduled : null;
  if (planned && planned.planName === plan.name) return off(`Your plan changes to ${plan.name} on ${formatDate(planned.at)}.`, `Starts ${formatDate(planned.at)}`);

  if (sub.cancelAtPeriodEnd) {
    if (!periodOpen) return subscribe;
    if (planned?.kind === "next_subscription") return off(`${planned.planName} is already set to start when your plan ends. Cancel that change first to choose another plan.`);
    return {
      disabled: false,
      current,
      reason: `Your current plan ends${endsOn ? ` on ${endsOn}` : ""}. ${plan.name} starts then, and nothing is charged before that day.`,
      action: "start_later",
      label: endsOn ? `Start ${plan.name} on ${endsOn}` : `Start ${plan.name} when your plan ends`,
    };
  }

  // The server's rule (plan-compare.ts): a higher price per month within the same billing interval is an upgrade; a change
  // of interval waits for the renewal whatever the prices.
  const move =
    typeof plan.pricePaise === "number" && typeof sub.plan.pricePaise === "number"
      ? planMove({ pricePaise: sub.plan.pricePaise, intervalMonths: sub.plan.intervalMonths }, { pricePaise: plan.pricePaise, intervalMonths: plan.intervalMonths })
      : "downgrade";
  const upgrade = move === "upgrade";
  const label = upgrade ? `Upgrade to ${plan.name}` : `Switch to ${plan.name}`;
  if (!isOwner) return off("Only the workspace owner can change the plan.", label);
  const startsAtRenewal = `Starts when your current period ends${endsOn ? ` on ${endsOn}` : ""}`;
  if (move === "interval") {
    const billed = `billed per ${intervalLabel(plan.intervalMonths ?? 1)} instead of per ${intervalLabel(sub.plan.intervalMonths ?? 1)}`;
    return { disabled: false, current, reason: `${startsAtRenewal}, because it is ${billed}. Nothing is charged now.`, action: "downgrade", label };
  }
  return upgrade
    ? { disabled: false, current, reason: "Starts now. You pay only the difference for the rest of this period.", action: "upgrade", label }
    : { disabled: false, current, reason: `${startsAtRenewal}. Nothing is charged now.`, action: "downgrade", label };
}

/** The 409 of /api/billing/change-plan when Razorpay cannot change the plan for the way it is paid. */
export type NewSubscriptionNeeded = { error: string; code: "new_subscription_needed"; planId: string; planName: string; endsOn: string | null; method: string | null };

export function isNewSubscriptionNeeded(body: unknown): body is NewSubscriptionNeeded {
  return !!body && typeof body === "object" && (body as { code?: unknown }).code === "new_subscription_needed" && typeof (body as { error?: unknown }).error === "string";
}

/** The toast after a plan change, from the change-plan answer. */
export function planChangeDoneText(result: { change: string; planName: string; at?: string; endsOn?: string | null; ended?: boolean }): string {
  switch (result.change) {
    case "upgraded":
      return `You are now on ${result.planName}.`;
    case "processing":
      return `Moving to ${result.planName}. It shows here as soon as the payment provider confirms it.`;
    case "scheduled":
      return `Changes to ${result.planName} on ${formatDate(result.at)}.`;
    case "kept":
      if (result.ended) return "The new plan will not start. Choose a plan under Plans to continue.";
      return result.endsOn ? `The new plan will not start. Your current plan still ends on ${formatDate(result.endsOn)}.` : `You stay on ${result.planName}.`;
    default:
      return "Your plan was updated.";
  }
}

/** Turns raw errors from the payment flow into something a shop owner can act on. */
export function paymentErrorMessage(raw: string | null | undefined, step: "start" | "confirm" = "start"): string {
  const text = (raw ?? "").trim();
  const generic = !text || /^something went wrong\.?$/i.test(text);
  if (step === "confirm") {
    return "We could not confirm your payment yet. If you were charged, your plan should activate shortly once the payment is confirmed. If it does not, contact support.";
  }
  if (/could not load/i.test(text)) return "The payment window could not open. Check your connection and try again.";
  if (generic) return "We could not start the payment. Check your connection and try again.";
  return text;
}

export function validateGstin(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  return /^[0-9A-Za-z]{15}$/.test(v) ? null : "A GSTIN has 15 letters and numbers, for example 22AAAAA0000A1Z5.";
}

export function validatePincode(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  return /^\d{6}$/.test(v) ? null : "Enter a 6-digit pincode.";
}

export function validateEmail(value: string): string | null {
  const v = value.trim();
  if (!v) return "Enter an email address for invoices.";
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? null : "Enter a valid email address, like accounts@yourshop.com.";
}

export function priceParts(plan: Pick<PlanLike, "pricePaise" | "currency" | "intervalMonths">): { amount: string; per: string } {
  const [amount, per] = priceText(plan).split(" per ");
  return { amount, per: `per ${per}` };
}

export type MeterLine = { kind: string; label: string; used: number; limit: number | null; percent: number | null; monthly: boolean };

const METER_TITLES: Record<string, string> = {
  seats: "Team seats",
  contacts: "Contacts",
  broadcastContacts: "Broadcast messages this month",
  aiCredits: "AI credits this month",
  adAccounts: "Ad accounts in use",
  scheduledPosts: "Scheduled posts this month",
  channels: "Social channels in use",
};

export const meterTitle = (line: Pick<MeterLine, "kind" | "label">) => METER_TITLES[line.kind] ?? line.label;

export function meterSummary(line: Pick<MeterLine, "used" | "limit">): string {
  const n = (v: number) => v.toLocaleString("en-IN");
  return line.limit === null ? `${n(line.used)} used, no limit` : `${n(line.used)} of ${n(line.limit)} used`;
}

/** Words that go next to a meter so its state is never colour only. */
export function meterNote(percent: number | null): string | null {
  if (percent === null) return null;
  if (percent >= 100) return "Limit reached";
  if (percent >= 80) return "Almost full";
  return null;
}

/** One sentence for the workspace banner naming the fullest limits, or null when nothing is at 80 percent. */
export function usageBannerText(alerts: Pick<MeterLine, "kind" | "label" | "used" | "limit" | "percent">[]): { tone: "warn" | "bad"; text: string } | null {
  if (alerts.length === 0) return null;
  const reached = alerts.filter((a) => a.limit !== null && a.used >= a.limit);
  const names = (list: typeof alerts) => list.slice(0, 3).map((a) => meterTitle(a).toLowerCase()).join(", ");
  if (reached.length > 0) return { tone: "bad", text: `You have reached your plan limit for ${names(reached)}. New items of this kind are blocked until you upgrade.` };
  return { tone: "warn", text: `You have used 80% or more of your plan for ${names(alerts)}.` };
}
