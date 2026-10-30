/**
 * Meta's messaging limit is the number of different people a business portfolio may start conversations with in a rolling
 * 24 hours. Meta reports it as a tier name. This module is the one place that turns whatever Meta (or an old record) sends
 * into the canonical name we store, and the one place that words it for people.
 */

export const CANONICAL_TIERS = ["TIER_50", "TIER_250", "TIER_1K", "TIER_2K", "TIER_10K", "TIER_100K", "TIER_UNLIMITED"] as const;
export type CanonicalTier = (typeof CANONICAL_TIERS)[number];

export const TIER_PEOPLE: Record<CanonicalTier, number> = {
  TIER_50: 50,
  TIER_250: 250,
  TIER_1K: 1_000,
  TIER_2K: 2_000,
  TIER_10K: 10_000,
  TIER_100K: 100_000,
  TIER_UNLIMITED: Number.POSITIVE_INFINITY,
};

const BY_COUNT = new Map<number, CanonicalTier>(CANONICAL_TIERS.filter((t) => t !== "TIER_UNLIMITED").map((t) => [TIER_PEOPLE[t], t]));

/**
 * The canonical tier name for a value Meta reported, or null when Meta has not set one. Accepts the spellings seen in the wild
 * (TIER_UNLIMITED, UNLIMITED, tier_1k, TIER_1000, a bare number). An unrecognised value is kept upper-cased rather than guessed,
 * so it is visible to support; nothing treats it as a known limit (the throttle then uses the lowest tier).
 */
export function normalizeTier(raw: unknown): string | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return BY_COUNT.get(raw) ?? `TIER_${raw}`;
  if (typeof raw !== "string") return null;
  const value = raw.trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (!value || value === "TIER_NOT_SET" || value === "NOT_SET" || value === "NONE") return null;
  if (value === "UNLIMITED" || value === "TIER_UNLIMITED") return "TIER_UNLIMITED";
  const match = /^(?:TIER_)?(\d+)(K?)$/.exec(value);
  if (match) {
    const people = Number(match[1]) * (match[2] ? 1_000 : 1);
    return BY_COUNT.get(people) ?? value;
  }
  return value.slice(0, 40);
}

export const isCanonicalTier = (tier: string | null | undefined): tier is CanonicalTier => !!tier && (CANONICAL_TIERS as readonly string[]).includes(tier);

/** Different people per 24 hours, or null when the tier is missing or not one we know. */
export function tierPeople(tier: string | null | undefined): number | null {
  const canonical = normalizeTier(tier);
  return isCanonicalTier(canonical) ? TIER_PEOPLE[canonical] : null;
}

/** "250 customers a day", "No daily limit", or a plain note when Meta has not told us. */
export function tierLabel(tier: string | null | undefined): string {
  const people = tierPeople(tier);
  if (people === null) return tier ? "Not recognised yet" : "Not reported yet";
  return people === Infinity ? "No daily limit" : `${people.toLocaleString("en-US")} customers a day`;
}

/** The tier with the larger limit. Unknown tiers lose against known ones. */
export function higherTier(a: string | null | undefined, b: string | null | undefined): string | null {
  const x = tierPeople(a);
  const y = tierPeople(b);
  if (x === null && y === null) return normalizeTier(a) ?? normalizeTier(b);
  if (x === null) return normalizeTier(b);
  if (y === null) return normalizeTier(a);
  return normalizeTier(x >= y ? a : b);
}
