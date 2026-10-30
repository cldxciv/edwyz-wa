export type DeltaView = { value: string; direction: "up" | "down" | "flat"; good?: boolean };

/**
 * Change against the previous period for a Stat. Null when there is nothing to compare.
 * lowerIsBetter flips which direction counts as an improvement (cost per result). Spend passes neutral so it is never coloured.
 */
export function deltaView(current: number | null, previous: number | null, opts: { lowerIsBetter?: boolean; neutral?: boolean } = {}): DeltaView | null {
  if (current === null || previous === null || previous === 0) return null;
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct === 0) return { value: "No change vs previous period", direction: "flat" };
  const direction = pct > 0 ? "up" : "down";
  const improved = opts.lowerIsBetter ? pct < 0 : pct > 0;
  return { value: `${Math.abs(pct)}% vs previous period`, direction, good: opts.neutral ? undefined : improved };
}

/** Meta's quality ranking codes in words ("below_average_35" becomes "Below average"). */
export function qualityLabel(ranking: string | null | undefined): string {
  const text = (ranking ?? "").toLowerCase();
  if (!text) return "Unknown";
  if (text.startsWith("below_average")) return "Below average";
  if (text.startsWith("above_average")) return "Above average";
  if (text.startsWith("average")) return "Average";
  return "Unknown";
}

export type PacingView = { label: string; detail: string; tone: "good" | "warn"; fill: number };

/** Pacing in words. pct is the share of the daily budget actually spent. Colour is never the only signal: the label says under, over or on track. */
export function pacingView(state: "under" | "on_track" | "over", pct: number): PacingView {
  const spent = Math.max(0, Math.round(pct));
  const detail = `Spending ${spent}% of the daily budget`;
  const fill = Math.min(100, spent);
  if (state === "on_track") return { label: "On track", detail, tone: "good", fill };
  if (state === "over") return { label: "Over budget", detail, tone: "warn", fill };
  return { label: "Under budget", detail, tone: "warn", fill };
}

/** Index of the data point nearest to x for evenly spaced points between left and right. */
export function nearestIndex(x: number, left: number, right: number, count: number): number {
  if (count <= 1 || right <= left) return 0;
  const ratio = (x - left) / (right - left);
  return Math.min(count - 1, Math.max(0, Math.round(ratio * (count - 1))));
}

/** Short axis label such as 1.2K, so a tick never overflows the left margin. */
export function compactNumber(n: number): string {
  try {
    return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);
  } catch {
    return String(Math.round(n));
  }
}

/** Plain-language reasons an ad was flagged as getting stale. */
export function fatigueReasons(f: { frequency: number | null; qualityRanking: string | null; reasons: ("frequency" | "quality")[] }): string[] {
  const out: string[] = [];
  if (f.reasons.includes("frequency") && f.frequency !== null) out.push(`Each person has seen it about ${Math.round(f.frequency * 10) / 10} times`);
  if (f.reasons.includes("quality")) out.push(`Meta rates its quality ${qualityLabel(f.qualityRanking).toLowerCase()}`);
  return out;
}
