import { parseRange } from "@/lib/reports/range";

/** Insight dates are account-local days stored as plain dates, so the time zone is fixed to UTC. Max 366 days. */
export function insightsRange(request: Request): { from: string; to: string } {
  const p = new URL(request.url).searchParams;
  const r = parseRange({ from: p.get("from"), to: p.get("to"), tz: "UTC" });
  return { from: r.from, to: r.to };
}
