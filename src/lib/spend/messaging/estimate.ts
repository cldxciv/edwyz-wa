/**
 * WhatsApp cost estimates from the admin rate card (docs/SPEND-CONTROLS-SPEC.md 3.1, 4.9). Pure: the caller passes the card.
 *
 * The estimate is conservative, so a WhatsApp limit is never overrun by a low guess:
 * - a country without a price (no row of its own and no "*" row), or a recipient whose country is unknown, is priced at the
 *   HIGHEST rate on the card for that category;
 * - an unknown category counts as MARKETING;
 * - +1 and +7 numbers are priced at the highest of the countries sharing the calling code (US, Canada and the other +1
 *   countries; Russia and Kazakhstan), because the number alone cannot tell them apart;
 * - free entry point recipients (a click-to-WhatsApp ad conversation started less than 72 hours ago) are priced at 0;
 * - SERVICE is priced at the SERVICE rate, or the UTILITY rate while SERVICE is missing (the admin panel warns);
 * - a category with no price anywhere on the card takes the card's highest rate of any category.
 * Every per-message cost is rounded UP to whole minor units (3.1). With scale 2 a rate of 1150 is 11.5 paise, so one message
 * is estimated at 12 paise, and a bulk estimate is the sum of the per-message estimates, so a bulk hold covers exactly the
 * messages it was made for.
 *
 * With no rate card at all nothing can be priced: the estimate is "not configured" (0 counted), never an invented figure.
 */
import { DEFAULT_COUNTRY, type RateCardData, type RateCategory } from "@/lib/admin/ratecard";
import { countryOfBsuid, countryOfPhone } from "@/lib/broadcasts/country";
import { normalizeCategory, type PricingCategory } from "./origin";

/** Countries that share a calling code: a +1 or +7 number is priced at the highest of them. */
export const SHARED_CALLING_CODES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "1": ["US", "CA", "AG", "AI", "AS", "BB", "BM", "BS", "DM", "DO", "GD", "GU", "JM", "KN", "KY", "LC", "MP", "MS", "PR", "SX", "TC", "TT", "VC", "VG", "VI"],
  "7": ["RU", "KZ"],
});

const SHARED_GROUP_OF: ReadonlyMap<string, readonly string[]> = new Map(Object.values(SHARED_CALLING_CODES).flatMap((group) => group.map((c) => [c, group] as const)));

/**
 * A free entry point (click-to-WhatsApp ad or Page call-to-action) makes Meta's messages free for 72 hours. Spec 4.9 step 4
 * says "under 7 days"; the 72-hour window Meta applies is used because it is the conservative one: a message sent between 72
 * hours and 7 days after the referral is reserved at its price instead of 0, so it can never slip past a used-up limit.
 * Settlement gives the estimate back if Meta reports it as not billable.
 */
export const FREE_ENTRY_POINT_MS = 72 * 3_600_000;

/** The scale of a card: 0 (whole minor units) or 2 (hundredths). Cards saved before scale existed are 0. */
export const scaleOf = (card: Pick<RateCardData, "scale"> | null | undefined): 0 | 2 => (card?.scale === 2 ? 2 : 0);

/** Card units to whole minor units, rounded up (3.1: cost estimates round up). */
export function unitsToMinorCeil(units: bigint, scale: 0 | 2): bigint {
  if (units <= 0n) return 0n;
  if (scale === 0) return units;
  return (units + 99n) / 100n;
}

/** The rate a single card row gives a category, in card units, with SERVICE falling back to UTILITY. */
function rowRate(row: Partial<Record<RateCategory, number>> | undefined, category: PricingCategory): number | undefined {
  if (!row) return undefined;
  const own = row[category];
  if (typeof own === "number") return own;
  return category === "SERVICE" && typeof row.UTILITY === "number" ? row.UTILITY : undefined;
}

/** The highest rate on the card for a category (SERVICE rows without SERVICE count at their UTILITY rate). */
export function highestRate(card: RateCardData, category: PricingCategory): number | undefined {
  let best: number | undefined;
  for (const row of Object.values(card.rates)) {
    const r = rowRate(row, category);
    if (r !== undefined && (best === undefined || r > best)) best = r;
  }
  return best;
}

/** The highest rate of any category on the card (for a category the card does not price at all). */
function highestAny(card: RateCardData): number | undefined {
  let best: number | undefined;
  for (const row of Object.values(card.rates)) for (const v of Object.values(row)) if (typeof v === "number" && (best === undefined || v > best)) best = v;
  return best;
}

/** One country's own price: its own row, then the "*" row. Undefined when the country is not priced. */
function countryRate(card: RateCardData, country: string, category: PricingCategory): number | undefined {
  return rowRate(card.rates[country.toUpperCase()], category) ?? rowRate(card.rates[DEFAULT_COUNTRY], category);
}

export type RateQuote = {
  /** Per message, in card units (1/10^scale of a minor unit). */
  units: number;
  scale: 0 | 2;
  /** Per message, whole minor units rounded up. */
  minor: bigint;
  /** How the price was found. */
  basis: "country" | "shared_code" | "highest" | "highest_any";
  /** SERVICE was priced at the UTILITY rate. */
  serviceFallback: boolean;
};

/**
 * The conservative per-message price for a recipient in `country` (ISO code as countryOfPhone gives it, or null when unknown).
 * Null only when the card is missing or prices nothing at all.
 */
export function rateFor(card: RateCardData | null | undefined, country: string | null, categoryInput: string): RateQuote | null {
  if (!card) return null;
  const category = normalizeCategory(categoryInput);
  const scale = scaleOf(card);
  const serviceFallback = category === "SERVICE" && !Object.values(card.rates).some((r) => typeof r.SERVICE === "number");
  const quote = (units: number, basis: RateQuote["basis"]): RateQuote => ({ units, scale, minor: unitsToMinorCeil(BigInt(units), scale), basis, serviceFallback });
  const highest = highestRate(card, category);
  if (highest === undefined) {
    const any = highestAny(card);
    return any === undefined ? null : quote(any, "highest_any");
  }
  if (!country) return quote(highest, "highest");
  const iso = country.toUpperCase();
  const group = SHARED_GROUP_OF.get(iso);
  if (group) {
    // Every country of the code must be priced; one that is not makes the whole code the highest rate.
    let max = -1;
    for (const c of group) {
      const r = countryRate(card, c, category);
      if (r === undefined) return quote(highest, "highest");
      if (r > max) max = r;
    }
    return quote(max, "shared_code");
  }
  const own = countryRate(card, iso, category);
  return own === undefined ? quote(highest, "highest") : quote(own, "country");
}

/** The country a recipient is priced in: from the phone number, else from a BSUID's country prefix, else unknown. */
export function recipientCountry(contact: { phone?: string | null; bsuid?: string | null } | null | undefined): string | null {
  if (contact?.phone) return countryOfPhone(contact.phone);
  if (contact?.bsuid) return countryOfBsuid(contact.bsuid);
  return null;
}

/**
 * True when the conversation came from a click-to-WhatsApp ad less than 72 hours ago. The referral is stored once, from the
 * first inbound message, so the conversation's creation time is when the free window could start at the earliest; a later
 * referral only makes this answer "not free", which is the safe direction.
 */
export function isFreeEntryPoint(conversation: { referral?: unknown; createdAt?: Date | null } | null | undefined, now: Date = new Date()): boolean {
  if (!conversation?.referral || typeof conversation.referral !== "object") return false;
  const started = conversation.createdAt instanceof Date ? conversation.createdAt.getTime() : NaN;
  if (Number.isNaN(started)) return false;
  return now.getTime() - started < FREE_ENTRY_POINT_MS;
}

export type MessageEstimate = {
  configured: boolean;
  currency: string | null;
  /** Whole minor units, rounded up; 0 for a free entry point or while no rate card exists. */
  minor: bigint;
  category: PricingCategory;
  quote: RateQuote | null;
  freeEntryPoint: boolean;
};

/** The estimate the send gate reserves for one message (4.9 step 4). */
export function estimateMessage(input: {
  card: RateCardData | null | undefined;
  category: string;
  contact?: { phone?: string | null; bsuid?: string | null } | null;
  country?: string | null;
  freeEntryPoint?: boolean;
}): MessageEstimate {
  const category = normalizeCategory(input.category);
  const currency = input.card?.currency ?? null;
  if (input.freeEntryPoint) return { configured: !!input.card, currency, minor: 0n, category, quote: null, freeEntryPoint: true };
  const country = input.country !== undefined ? input.country : recipientCountry(input.contact);
  const quote = rateFor(input.card, country, category);
  return { configured: !!quote, currency, minor: quote?.minor ?? 0n, category, quote, freeEntryPoint: false };
}

export type ConservativeLine = { country: string | null; count: number; perMessageMinor: number | null; totalMinor: number | null; basis: RateQuote["basis"] | "free" | null };

export type ConservativeBreakdown =
  | { configured: false; lines: ConservativeLine[]; count: number }
  | {
      configured: true;
      currency: string;
      /** The bulk hold amount: sum of the per-message estimates. */
      totalMinor: number;
      totalMinorBig: bigint;
      /** Always 0: an unpriced country is priced at the highest rate instead of being left out. */
      unpricedCount: number;
      /** Recipients priced at the highest rate because their country has no price. */
      highestRateCount: number;
      freeCount: number;
      serviceFallback: boolean;
      scale: 0 | 2;
      lines: ConservativeLine[];
      count: number;
    };

/**
 * The conservative estimate for a bulk send (broadcasts, automation runs, API batches): the same shape as
 * broadcasts/cost.ts estimateBreakdown, so callers can switch to it. `free` recipients are priced at 0.
 */
export function estimateBreakdown(input: { category: string; countries: Map<string | null, number>; card: RateCardData | null; free?: number }): ConservativeBreakdown {
  const category = normalizeCategory(input.category);
  const free = Math.max(0, Math.trunc(input.free ?? 0));
  const priced = [...input.countries.entries()].map(([country, n]) => ({ country, n, quote: rateFor(input.card, country, category) }));
  const lines: ConservativeLine[] = priced
    .map(({ country, n, quote }) => ({
      country,
      count: n,
      perMessageMinor: quote ? Number(quote.minor) : null,
      totalMinor: quote ? Number(quote.minor * BigInt(n)) : null,
      basis: quote?.basis ?? null,
    }))
    .sort((a, b) => b.count - a.count);
  const count = lines.reduce((a, l) => a + l.count, 0) + free;
  if (free > 0) lines.push({ country: null, count: free, perMessageMinor: 0, totalMinor: 0, basis: "free" });
  if (!input.card || priced.some((p) => !p.quote)) return { configured: false, lines, count };
  const totalMinorBig = priced.reduce((sum, p) => sum + p.quote!.minor * BigInt(p.n), 0n);
  const highestRateCount = priced.filter((p) => p.quote!.basis === "highest" || p.quote!.basis === "highest_any").reduce((a, p) => a + p.n, 0);
  return {
    configured: true,
    currency: input.card.currency,
    totalMinor: Number(totalMinorBig),
    totalMinorBig,
    unpricedCount: 0,
    highestRateCount,
    freeCount: free,
    serviceFallback: priced.some((p) => p.quote!.serviceFallback),
    scale: scaleOf(input.card),
    lines,
    count,
  };
}

/**
 * What Meta actually charged for one delivered message, for settlement (4.9 "Actual cost"): 0 when Meta said it was not
 * billable, else the card's price for the reported category in whole minor units, rounded up. Null when the card cannot price
 * it (the estimate is then kept).
 */
export function actualCostMinor(input: { card: RateCardData | null | undefined; billable: boolean | null | undefined; category: string | null | undefined; contact?: { phone?: string | null; bsuid?: string | null } | null }): bigint | null {
  if (input.billable === false) return 0n;
  if (input.billable !== true) return null;
  const quote = rateFor(input.card, recipientCountry(input.contact), normalizeCategory(input.category));
  return quote ? quote.minor : null;
}
