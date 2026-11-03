import type { CurrencyTotals } from "@/lib/ads/insights-queries";

export type Metric = "spendMinor" | "results" | "clicks";

const METRICS: { key: Metric; label: string }[] = [
  { key: "spendMinor", label: "Spend" },
  { key: "results", label: "Results" },
  { key: "clicks", label: "Clicks" },
];

/** The query string of the insights requests: the date range, and the chosen ad account when there is one. */
export function insightsQuery(range: { from: string; to: string }, account: string): string {
  return `from=${range.from}&to=${range.to}${account ? `&adAccount=${encodeURIComponent(account)}` : ""}`;
}

/** "Main ads (INR)" for the ad account picker. */
export function accountLabel(a: { name: string | null; currency: string | null }): string {
  return `${a.name ?? "Ad account"}${a.currency ? ` (${a.currency})` : ""}`;
}

/** Per-currency totals worth showing: only when there really is more than one currency. */
export function splitByCurrency(rows: CurrencyTotals[] | null | undefined): CurrencyTotals[] | null {
  return rows && rows.length > 1 ? rows : null;
}

/** What the day-by-day chart can show. Spend of different currencies is never drawn as one line. */
export function chartMetrics(split: boolean): { key: Metric; label: string }[] {
  return split ? METRICS.filter((m) => m.key !== "spendMinor") : METRICS;
}
