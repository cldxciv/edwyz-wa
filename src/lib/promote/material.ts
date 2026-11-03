/**
 * The Start card's material (docs/IG-PAGE-ADS-SPEC.md 6.5, 6.1 rule 4, 3.1a; Eddy 4.5 G15). Pure.
 *
 * The material is everything a member agreed to when they tapped Start: the budget of each ad set, the dates, the account's
 * time zone and currency, where the ads show, who sees them, every text and link shown verbatim on the card, the first
 * message and quick questions, the media files, the lead form, and the rejected ads a fix copy pauses first. review() hashes
 * it (canonical JSON, sha256) and start() hashes it again from the rows; any difference is a 409 `changed` with a new card.
 *
 * Money that depends on what else is running (Phase 0's headroom) is not material: the worst case is compared with a 0.5%
 * tolerance instead (6.1 rule 4). The row's updatedAt is not hashed either: the launch heartbeat and a refused activation
 * write the row without changing anything the card showed, and hashing it would turn every [Try again] into a 409. What the
 * row holds is hashed field by field instead.
 *
 * For startMode 'now' the start is the account day the run starts on ("now:2026-10-31"), not the instant, so the same card is
 * valid all day and a run reviewed before midnight and started after it gives 409 (its dates moved).
 */
import { canonicalJson, hashCanonical } from "@/lib/actions/canonical";

/** One ad set as the card showed it. */
export type MaterialSet = { key: string; dailyBudgetMinor: bigint | number | null; lifetimeBudgetMinor?: bigint | number | null };

/** The fields of one ad's creative that reach Meta (the Meta ids written at launch are left out). */
export type MaterialCreative = Record<string, unknown>;

export type MaterialInput = {
  campaignId: string;
  sets: readonly MaterialSet[];
  /** "now:<account day>" for startMode 'now', else the ISO start. */
  startsAt: string;
  endsAt: string | null;
  timezone: string;
  currency: string;
  placements: { mode: string; positions: readonly (readonly string[])[] };
  /** Each ad set's targeting without its placements. */
  audiences: readonly unknown[];
  /** Each ad's creative, in launch order. */
  creatives: readonly MaterialCreative[];
  /** The sha256 of every library file the ads use, in creative order. */
  mediaShas: readonly string[];
  /** The text the card shows verbatim: per version the primary text, headline, description, link and button, and a boosted post's caption. */
  text: unknown;
  /** The chat goals' first message and quick questions; null for other goals. */
  welcome: unknown;
  /** The lead form: the saved form chosen, or the spec Start creates (with the privacy link). null for other goals. */
  form: unknown;
  /** Rejected ads a fix copy pauses first (3.9), sorted. */
  pausesAdIds: readonly string[];
};

export type Material = {
  campaignId: string;
  sets: { key: string; dailyBudgetMinor: string | null; lifetimeBudgetMinor: string | null }[];
  startsAt: string;
  endsAt: string | null;
  timezone: string;
  currency: string;
  placementsHash: string;
  audienceHash: string;
  creativeHash: string;
  mediaShas: string[];
  textSha256: string;
  welcomeSha256: string | null;
  formSpecHash: string | null;
  pausesAdIds: string[];
};

const money = (v: bigint | number | null | undefined): string | null => (v === null || v === undefined ? null : String(v));

/** The material of one card, each part hashed so the card can name what changed without carrying the texts twice. */
export function buildMaterial(i: MaterialInput): Material {
  return {
    campaignId: i.campaignId,
    sets: i.sets.map((s) => ({ key: s.key, dailyBudgetMinor: money(s.dailyBudgetMinor), lifetimeBudgetMinor: money(s.lifetimeBudgetMinor) })),
    startsAt: i.startsAt,
    endsAt: i.endsAt,
    timezone: i.timezone,
    currency: i.currency.toUpperCase(),
    placementsHash: hashCanonical(i.placements),
    audienceHash: hashCanonical(i.audiences),
    creativeHash: hashCanonical(i.creatives),
    mediaShas: [...i.mediaShas],
    textSha256: hashCanonical(i.text),
    welcomeSha256: i.welcome === null || i.welcome === undefined ? null : hashCanonical(i.welcome),
    formSpecHash: i.form === null || i.form === undefined ? null : hashCanonical(i.form),
    pausesAdIds: [...i.pausesAdIds].sort(),
  };
}

/** The hash the card carries and Start sends back. */
export function materialHash(m: Material): string {
  return hashCanonical(m);
}

/** The material's fields that differ (for the 409 card's note and the audit trail). Empty when they are the same. */
export function materialDiff(a: Material, b: Material): string[] {
  const out: string[] = [];
  for (const key of Object.keys(a) as (keyof Material)[]) if (canonicalJson(a[key]) !== canonicalJson(b[key])) out.push(key);
  return out;
}

/** The creative fields that are not material: what launch writes (Meta ids, Meta's review), signed links, and Promote's own bookkeeping. */
const NOT_MATERIAL = new Set(["metaCreativeId", "metaReview", "categoryTermsAck", "imageUrl", "leadFormId", "promote"]);

/** One ad's creative as the material hashes it. */
export function creativeMaterial(raw: unknown): MaterialCreative {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter(([k, v]) => !NOT_MATERIAL.has(k) && v !== undefined && v !== null && v !== ""));
}

/** A targeting object without its placements (the placements are hashed on their own). */
export function audienceMaterial(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter(([k]) => k !== "placements"));
}
