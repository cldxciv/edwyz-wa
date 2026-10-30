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

export type SubscriptionLike = { status: string; cancelAtPeriodEnd: boolean; currentPeriodEnd: string | null; plan: { name: string } } | null;

export function renewalText(sub: SubscriptionLike): string | null {
  if (!sub?.currentPeriodEnd) return null;
  const date = formatDate(sub.currentPeriodEnd);
  return sub.cancelAtPeriodEnd ? `Ends on ${date}. It will not renew.` : `Renews on ${date}.`;
}

export type PlanChoice = { disabled: boolean; current: boolean; reason: string | null };

export function planChoice(plan: { name: string }, sub: SubscriptionLike, paymentsConfigured: boolean): PlanChoice {
  const activeSub = sub?.status === "active" && !sub.cancelAtPeriodEnd;
  const current = !!sub && sub.status === "active" && sub.plan.name === plan.name;
  if (!paymentsConfigured) return { disabled: true, current, reason: "Online payment is not set up yet. Contact support to subscribe." };
  if (current) return { disabled: true, current, reason: null };
  if (activeSub) return { disabled: true, current, reason: "You already have an active plan. Cancel it first if you want to switch, or contact support." };
  return { disabled: false, current, reason: null };
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
