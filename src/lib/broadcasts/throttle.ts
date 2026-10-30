import { TIER_PEOPLE, tierPeople } from "@/lib/messaging-limit";

/**
 * Meta's messaging limit: unique people a business portfolio may start conversations with in a rolling 24 hours.
 * Meta reports it as a tier name. The tier names and sizes live in src/lib/messaging-limit.ts (one source of truth); this table is
 * the same data keyed by name, plus UNLIMITED, which Meta also spells that way.
 */
export const TIER_LIMITS: Record<string, number> = { ...TIER_PEOPLE, UNLIMITED: Number.POSITIVE_INFINITY };

export const LOWEST_TIER_LIMIT = TIER_LIMITS.TIER_250;
export const WINDOW_MS = 24 * 60 * 60 * 1000;

export const isKnownTier = (tier: string | null | undefined): boolean => tierPeople(tier) !== null;

/** Unique recipients allowed per rolling 24 hours for one tier. Unknown or missing tiers are treated as 250. */
export function tierLimit(tier: string | null | undefined): number {
  return tierPeople(tier) ?? LOWEST_TIER_LIMIT;
}

/**
 * The limit is shared by every number in a business portfolio, so the portfolio's limit is the highest tier any of its
 * numbers reports. Numbers whose tier is missing or unknown are ignored unless none is known.
 */
export function portfolioLimit(tiers: readonly (string | null | undefined)[]): number {
  const known = tiers.map(tierPeople).filter((n): n is number => n !== null);
  return known.length ? Math.max(...known) : LOWEST_TIER_LIMIT;
}

/** How many recipients may be sent right now, capped by the batch size. */
export function allowedNow(input: { tier: string | null | undefined; sentLast24h: number; batchSize: number; limit?: number }): number {
  const remaining = (input.limit ?? tierLimit(input.tier)) - input.sentLast24h;
  return Math.max(0, Math.min(input.batchSize, remaining));
}

/**
 * The documented rules for moving up from 2,000: in a rolling window, message at least this many different people while quality stays high.
 * These are Meta's published rules as we know them (see docs/wati/campaigns-templates-commerce.md); Meta decides, and can change them.
 */
export const TIER_UP_RULES: { from: number; to: number; uniquePeople: number; days: number }[] = [
  { from: 2_000, to: 10_000, uniquePeople: 1_000, days: 7 },
  { from: 10_000, to: 100_000, uniquePeople: 5_000, days: 7 },
  { from: 100_000, to: Number.POSITIVE_INFINITY, uniquePeople: 500_000, days: 14 },
];

export type NextStep = { toLimit: number; uniquePeople: number | null; days: number; viaVerification: boolean };

/** What it takes to reach the next level from this tier, or null when there is none (unlimited). */
export function nextStep(tier: string | null | undefined): NextStep | null {
  const limit = tierLimit(tier);
  if (limit === Infinity) return null;
  if (limit < 2_000) return { toLimit: 2_000, uniquePeople: 2_000, days: 30, viaVerification: true };
  const rule = TIER_UP_RULES.find((r) => r.from === limit);
  return rule ? { toLimit: rule.to, uniquePeople: rule.uniquePeople, days: rule.days, viaVerification: false } : null;
}

const people = (n: number) => n.toLocaleString("en-US");

/**
 * Plain-language note on how the limit grows. Below 2,000: business verification, or 2,000 different people messaged with high quality
 * in 30 days. From 2,000: 1,000 different people in 7 days for 10,000, 5,000 in 7 days for 100,000, and 500,000 in 14 days for no limit, always
 * while quality stays high.
 */
export function scalingHint(tier: string | null | undefined): string | null {
  const step = nextStep(tier);
  if (!step) return null;
  if (step.viaVerification) return "To reach 2,000 people a day, verify your business with Meta, or message 2,000 different people with high-quality messages within 30 days.";
  const target = step.toLimit === Infinity ? "no daily limit" : `${people(step.toLimit)} people a day`;
  return `Meta raises the limit by itself when your message quality stays high. To reach ${target}, message at least ${people(step.uniquePeople ?? 0)} different people within ${step.days} days.`;
}

/** Days needed to reach everyone given a daily limit and how many were already messaged today. */
export function daysToReach(total: number, limit: number, usedToday: number): number {
  if (limit === Infinity || total <= 0) return total > 0 ? 1 : 0;
  const first = Math.max(0, limit - usedToday);
  if (total <= first) return 1;
  return 1 + Math.ceil((total - first) / limit);
}

/** The tier name of the number with the highest limit in the portfolio, or null when none of them reports a known tier. */
export function topTier(phones: { messagingLimitTier: string | null }[]): string | null {
  let best: string | null = null;
  for (const { messagingLimitTier: tier } of phones) {
    if (isKnownTier(tier) && (best === null || tierLimit(tier) > tierLimit(best))) best = tier;
  }
  return best;
}
