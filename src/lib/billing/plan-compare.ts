/**
 * Which way a plan change goes (owner decision 4). One rule for the server (plan-change.ts) and the billing page (planChoice in
 * src/components/billing/helpers.ts), so the button and what happens always agree. Pure: safe in the browser.
 *
 * - "upgrade": the same billing interval and a higher price per month. It applies now and Razorpay charges the difference.
 * - "downgrade": the same billing interval and the same or a lower price per month. It applies at the renewal; nothing is
 *   charged now, so nobody pays twice in a period.
 * - "interval": monthly to yearly or back (any change of billing interval), whatever the prices. What is left of a prepaid
 *   period cannot be prorated against a different cycle, so it applies at the renewal like a downgrade, and the page says why.
 */
export type PlanMove = "upgrade" | "downgrade" | "interval";

type Priced = { pricePaise: number; intervalMonths?: number | null };

const months = (p: Priced) => (typeof p.intervalMonths === "number" && p.intervalMonths >= 1 ? Math.floor(p.intervalMonths) : 1);

export function planMove(from: Priced, to: Priced): PlanMove {
  const a = months(from);
  const b = months(to);
  if (a !== b) return "interval";
  // Price per month, compared without division: to/b > from/a.
  return to.pricePaise * a > from.pricePaise * b ? "upgrade" : "downgrade";
}
