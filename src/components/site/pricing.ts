import { intervalLabel } from "@/components/billing/helpers";
import type { PlatformSettings } from "@/lib/platform-settings";

export type PublicPlan = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  pricePaise: number;
  currency: string;
  intervalMonths: number;
  seatLimit: number | null;
  contactLimit: number | null;
  monthlyBroadcastLimit: number | null;
  aiCreditsMonthly: number | null;
  adAccountLimit: number | null;
};

/** The trial allowance is stored as a plan with this code. It is not something people can buy. */
export const TRIAL_PLAN_CODE = "trial";

export const NO_PRICES_TEXT = "Prices not published yet, contact us";

export type Billing = "monthly" | "yearly";

const MONTHS: Record<Billing, number> = { monthly: 1, yearly: 12 };

export function hasBothIntervals(plans: readonly Pick<PublicPlan, "intervalMonths">[]): boolean {
  return plans.some((p) => p.intervalMonths === MONTHS.monthly) && plans.some((p) => p.intervalMonths === MONTHS.yearly);
}

/** The toggle exists only when plans exist for both periods. Without it, every plan is listed with its own period. */
export function chooseBilling(plans: readonly Pick<PublicPlan, "intervalMonths">[], requested: string | undefined): Billing | null {
  if (!hasBothIntervals(plans)) return null;
  return requested === "yearly" ? "yearly" : "monthly";
}

export function plansFor<T extends Pick<PublicPlan, "intervalMonths">>(plans: readonly T[], billing: Billing | null): T[] {
  return billing === null ? [...plans] : plans.filter((p) => p.intervalMonths === MONTHS[billing]);
}

export function formatPrice(plan: Pick<PublicPlan, "pricePaise" | "currency" | "intervalMonths">): { amount: string; per: string } {
  const value = (plan.pricePaise / 100).toLocaleString("en-IN", { minimumFractionDigits: plan.pricePaise % 100 === 0 ? 0 : 2 });
  return { amount: `${plan.currency === "INR" ? "Rs " : `${plan.currency} `}${value}`, per: intervalLabel(plan.intervalMonths) };
}

/**
 * Wording for a limit that the plan leaves unset (null). The product applies no cap there for team seats, contacts and
 * broadcast messages (src/lib/billing/limits.ts treats null as no limit), so this stays "No fixed limit".
 * AI credits are different: a null allowance falls back to a platform ceiling, so it is never described as unlimited.
 * The ad account limit is deliberately not shown anywhere on the public page: nothing in src/lib enforces
 * Plan.adAccountLimit, so advertising a number (or "no limit") would not be truthful. It is still carried on PublicPlan.
 */
export const NO_FIXED_LIMIT = "No fixed limit";
export const FAIR_USE_LIMIT = "Fair-use limit";

export type LimitOptions = {
  /** The platform ceiling applied to a plan with no AI credit allowance (defaultMonthlyCreditCeiling on the server). Omit when unknown. */
  aiDefaultCredits?: number | null;
};

const count = (n: number) => n.toLocaleString("en-IN");

export function limitText(value: number | null): string {
  return value === null ? NO_FIXED_LIMIT : count(value);
}

export function aiCreditsText(value: number | null, opts: LimitOptions = {}): string {
  if (value !== null) return count(value);
  return typeof opts.aiDefaultCredits === "number" ? `${count(opts.aiDefaultCredits)} (${FAIR_USE_LIMIT.toLowerCase()})` : FAIR_USE_LIMIT;
}

const plural = (n: number, one: string, many: string) => `${count(n)} ${n === 1 ? one : many}`;

export function planLimitLines(plan: PublicPlan, opts: LimitOptions = {}): string[] {
  const line = (n: number | null, one: string, many: string, unset: string) => (n === null ? unset : plural(n, one, many));
  const ai =
    plan.aiCreditsMonthly !== null
      ? plural(plan.aiCreditsMonthly, "AI credit a month", "AI credits a month")
      : typeof opts.aiDefaultCredits === "number"
        ? `${plural(opts.aiDefaultCredits, "AI credit a month", "AI credits a month")} (fair-use limit)`
        : "Fair-use limit on AI credits";
  return [
    line(plan.seatLimit, "team seat", "team seats", "No fixed limit on team seats"),
    line(plan.contactLimit, "contact", "contacts", "No fixed limit on contacts"),
    line(plan.monthlyBroadcastLimit, "broadcast message a month", "broadcast messages a month", "No fixed limit on broadcast messages"),
    ai,
  ];
}

/** Short footnote for the AI credit fair-use limit. Null when every plan sets its own allowance. */
export function aiFairUseNote(plans: readonly Pick<PublicPlan, "aiCreditsMonthly">[], opts: LimitOptions = {}): string | null {
  if (!plans.some((p) => p.aiCreditsMonthly === null)) return null;
  const amount = typeof opts.aiDefaultCredits === "number" ? ` of ${count(opts.aiDefaultCredits)} AI credits a month` : "";
  return `AI replies are never unlimited. A plan that does not set its own AI credit allowance has a fair-use limit${amount}.`;
}

/** The trial allowance is not something people can buy, so it never appears on the pricing page. */
export function publicPlans<T extends Pick<PublicPlan, "code">>(plans: readonly T[]): T[] {
  return plans.filter((p) => p.code !== TRIAL_PLAN_CODE);
}

export type ComparisonRow = { key: string; label: string; values: string[] };

const ROWS: { key: string; label: string; text: (p: PublicPlan, opts: LimitOptions) => string }[] = [
  { key: "seats", label: "Team seats", text: (p) => limitText(p.seatLimit) },
  { key: "contacts", label: "Contacts", text: (p) => limitText(p.contactLimit) },
  { key: "broadcasts", label: "Broadcast messages per month", text: (p) => limitText(p.monthlyBroadcastLimit) },
  { key: "ai", label: "AI credits per month", text: (p, o) => aiCreditsText(p.aiCreditsMonthly, o) },
];

export function comparisonRows(plans: readonly PublicPlan[], opts: LimitOptions = {}): ComparisonRow[] {
  return ROWS.map((r) => ({ key: r.key, label: r.label, values: plans.map((p) => r.text(p, opts)) }));
}

function formatRate(bps: number): string {
  return String(Math.round(bps) / 100);
}

export type TaxNote = { main: string; proforma: string | null };

export function taxNote(settings: Pick<PlatformSettings, "gstRateBps" | "sellerGstin">, plans: readonly Pick<PublicPlan, "currency">[]): TaxNote {
  const allInr = plans.length > 0 && plans.every((p) => p.currency === "INR");
  const gst = settings.gstRateBps > 0 ? `include GST at ${formatRate(settings.gstRateBps)} percent` : "are shown before any applicable tax";
  const main = allInr ? `Prices are in Indian rupees (INR) and ${gst}.` : `Prices ${gst}.`;
  const proforma = settings.sellerGstin.trim() ? null : "Until our GST registration number is added to invoices, they are issued as proforma invoices and are not tax invoices.";
  return { main, proforma };
}

export function offersFor(plans: readonly PublicPlan[]) {
  return plans.map((p) => ({ name: p.name, pricePaise: p.pricePaise, currency: p.currency }));
}
