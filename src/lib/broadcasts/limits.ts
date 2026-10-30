import { TIER_LIMITS } from "./throttle";

export type MeterView =
  | { known: false; label: string }
  | { known: true; limit: number; used: number; percent: number; unlimited: boolean; label: string };

/** Uses only the tier Meta reported. A missing or unrecognised tier is shown as unknown, never guessed. */
export function meterView(tier: string | null | undefined, sentLast24h: number): MeterView {
  const limit = tier ? TIER_LIMITS[tier.toUpperCase()] : undefined;
  if (limit === undefined) return { known: false, label: "Messaging limit unknown" };
  if (limit === Infinity) return { known: true, limit, used: sentLast24h, percent: 0, unlimited: true, label: `${sentLast24h.toLocaleString()} sent in 24 h, no limit` };
  const percent = Math.min(100, Math.round((sentLast24h / limit) * 100));
  return { known: true, limit, used: sentLast24h, percent, unlimited: false, label: `${sentLast24h.toLocaleString()} of ${limit.toLocaleString()} unique recipients in 24 h` };
}

export type QualityView = { label: string; tone: "neutral" | "good" | "warn" | "bad" };

export function qualityView(rating: string | null | undefined): QualityView {
  switch ((rating ?? "").toUpperCase()) {
    case "GREEN":
    case "HIGH":
      return { label: "High", tone: "good" };
    case "YELLOW":
    case "MEDIUM":
      return { label: "Medium", tone: "warn" };
    case "RED":
    case "LOW":
      return { label: "Low", tone: "bad" };
    default:
      return { label: "Unknown", tone: "neutral" };
  }
}
