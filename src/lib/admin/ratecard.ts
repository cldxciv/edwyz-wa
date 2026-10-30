import { audit } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { HttpError } from "@/lib/tenancy";

/*
 * The WhatsApp price list used for cost estimates. It is entered by a super admin from Meta's current rate card and
 * stored under PlatformSetting key "ratecard". Nothing is built in: until it is saved, every estimate says
 * "not configured". Rates are integers per message in the currency's smallest unit (paise for INR, cents for USD), or, with
 * scale 2 ("Rates use 2 extra decimals", docs/SPEND-CONTROLS-SPEC.md 3.1), in hundredths of it: INR 0.115 is 1150.
 * SERVICE is the price of a free-form message inside the 24-hour window; while it is missing, estimates use UTILITY.
 * The rate card's currency is the WhatsApp limits' currency, so it cannot change while workspaces have limits in it (3.1).
 */

export const RATECARD_KEY = "ratecard";
export const RATE_CATEGORIES = ["MARKETING", "UTILITY", "AUTHENTICATION", "SERVICE"] as const;
export type RateCategory = (typeof RATE_CATEGORIES)[number];
export const DEFAULT_COUNTRY = "*";
export const MAX_RATE_ROWS = 300;
export const MAX_RATE_MINOR = 100_000_00;
/** 0: rates are whole minor units. 2: rates are hundredths of a minor unit. */
export const RATE_SCALES = [0, 2] as const;
export type RateScale = (typeof RATE_SCALES)[number];

export type RateRow = Partial<Record<RateCategory, number>>;
export type RateCardData = {
  currency: string;
  /** Country (ISO 3166 alpha-2) or "*" for any country without its own row. */
  rates: Record<string, RateRow>;
  /** Free text, for example the date Meta's list took effect. Shown to admins only. */
  note: string;
  updatedAt: string | null;
  /** 0 (default) or 2: how many extra decimals the rates carry. */
  scale: RateScale;
};

const CURRENCY = /^[A-Z]{3}$/;
const COUNTRY = /^([A-Z]{2}|\*)$/;

/** The largest rate a row may hold at this scale (the same money at either scale). */
export const maxRateFor = (scale: RateScale): number => MAX_RATE_MINOR * 10 ** scale;

function parseScale(value: unknown): RateScale {
  if (value === undefined || value === null || value === "" || value === false || value === 0 || value === "0") return 0;
  if (value === true || value === 2 || value === "2") return 2;
  throw new HttpError(400, "Scale must be 0 (whole units) or 2 (2 extra decimals).");
}

function cleanRate(value: unknown, label: string, scale: RateScale): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = typeof value === "string" ? Number(value.trim()) : value;
  const max = maxRateFor(scale);
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > max) {
    const unit = scale === 2 ? "hundredths of the smallest unit (for example 1150 for 11.5 paise)" : "the smallest unit (for example paise)";
    throw new HttpError(400, `${label} must be a whole number in ${unit}, from 0 to ${max.toLocaleString()}.`);
  }
  return n;
}

/** Validates the admin form body. Rows with no rates are dropped; at least one rate is required. */
export function parseRateCard(body: Record<string, unknown>, now = new Date()): RateCardData {
  const currency = typeof body.currency === "string" ? body.currency.trim().toUpperCase() : "";
  if (!CURRENCY.test(currency)) throw new HttpError(400, "Currency must be a three-letter code such as INR.");
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) : "";
  const scale = parseScale(body.scale);
  const rows = body.rates;
  if (!rows || typeof rows !== "object" || Array.isArray(rows)) throw new HttpError(400, "Rates must be a list of countries.");
  const entries = Array.isArray(rows) ? [] : Object.entries(rows as Record<string, unknown>);
  if (entries.length > MAX_RATE_ROWS) throw new HttpError(400, `Use at most ${MAX_RATE_ROWS} countries.`);
  const rates: Record<string, RateRow> = {};
  for (const [rawCountry, rawRow] of entries) {
    const country = rawCountry.trim().toUpperCase();
    if (!COUNTRY.test(country)) throw new HttpError(400, `"${rawCountry.slice(0, 20)}" is not a two-letter country code. Use * for all other countries.`);
    if (country in rates) throw new HttpError(400, `${country} is listed twice.`);
    if (!rawRow || typeof rawRow !== "object" || Array.isArray(rawRow)) throw new HttpError(400, `Rates for ${country} are not valid.`);
    const row: RateRow = {};
    for (const category of RATE_CATEGORIES) {
      const value = cleanRate((rawRow as Record<string, unknown>)[category], `${country} ${category.toLowerCase()} rate`, scale);
      if (value !== undefined) row[category] = value;
    }
    if (Object.keys(row).length) rates[country] = row;
  }
  if (Object.keys(rates).length === 0) throw new HttpError(400, "Enter at least one rate. To remove the rate card, use Clear rate card.");
  return { currency, rates, note, updatedAt: now.toISOString(), scale };
}

function fromStored(value: unknown): RateCardData | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<RateCardData>;
  if (typeof v.currency !== "string" || !CURRENCY.test(v.currency) || !v.rates || typeof v.rates !== "object") return null;
  const scale: RateScale = v.scale === 2 ? 2 : 0;
  const rates: Record<string, RateRow> = {};
  for (const [country, row] of Object.entries(v.rates)) {
    if (!COUNTRY.test(country) || !row || typeof row !== "object") continue;
    const clean: RateRow = {};
    for (const category of RATE_CATEGORIES) {
      const n = (row as RateRow)[category];
      if (typeof n === "number" && Number.isInteger(n) && n >= 0) clean[category] = n;
    }
    if (Object.keys(clean).length) rates[country] = clean;
  }
  if (Object.keys(rates).length === 0) return null;
  return { currency: v.currency, rates, note: typeof v.note === "string" ? v.note : "", updatedAt: typeof v.updatedAt === "string" ? v.updatedAt : null, scale };
}

/** The saved rate card, or null while it is unconfigured (or unreadable). */
export async function getRateCard(): Promise<RateCardData | null> {
  try {
    const row = await prisma.platformSetting.findUnique({ where: { key: RATECARD_KEY } });
    return fromStored(row?.value);
  } catch {
    return null;
  }
}

/** True when no row prices SERVICE: estimates then use the UTILITY rate, and the admin page says so. */
export function serviceRateMissing(card: RateCardData | null): boolean {
  return !!card && !Object.values(card.rates).some((row) => typeof row.SERVICE === "number");
}

/** "Workspaces have WhatsApp limits in INR. Add rates in INR, or ask them to re-enter limits first." (3.1) */
export const currencyLockedCopy = (currency: string): string =>
  `Workspaces have WhatsApp limits in ${currency}. Add rates in ${currency}, or ask them to re-enter limits first.`;

/**
 * How many workspaces have WhatsApp limits (a messaging SpendAllowance row) in this currency. A row whose limits are both Not set
 * counts too (3.1: "while any messaging SpendAllowance exists"), because its currency is still the one the owner works in.
 */
export async function messagingLimitsIn(currency: string): Promise<number> {
  return prisma.spendAllowance.count({ where: { pot: "messaging", currency } });
}

/**
 * Saves the rate card. A currency change is refused (409) while any workspace has WhatsApp limits in the current currency,
 * because those limits would silently stop applying (an owner limit in another currency reads as Not set, 4.4).
 */
export async function saveRateCard(adminUserId: string, body: Record<string, unknown>): Promise<RateCardData> {
  const card = parseRateCard(body);
  const current = await getRateCard();
  if (current && current.currency !== card.currency && (await messagingLimitsIn(current.currency)) > 0) {
    throw new HttpError(409, currencyLockedCopy(current.currency));
  }
  await prisma.platformSetting.upsert({ where: { key: RATECARD_KEY }, create: { key: RATECARD_KEY, value: card }, update: { value: card } });
  await audit({ userId: adminUserId, action: "admin.ratecard.update", meta: { currency: card.currency, countries: Object.keys(card.rates).length, scale: card.scale } });
  return card;
}

export async function clearRateCard(adminUserId: string): Promise<void> {
  await prisma.platformSetting.deleteMany({ where: { key: RATECARD_KEY } });
  await audit({ userId: adminUserId, action: "admin.ratecard.clear" });
}

/**
 * The price for a country and category in whole minor units of the card's currency: its own row first, then the "*" row.
 * A card with 2 extra decimals is divided by 100 and rounded up (3.1: estimates round up), so 1150 (11.5 paise) is 12 and
 * callers that show a price never see a figure 100 times too high. Undefined when neither row has the category. The
 * conservative rules the send gate uses (highest rate for an unpriced country, SERVICE falling back to UTILITY, shared calling
 * codes) live in src/lib/spend/messaging/estimate.ts.
 */
export function rateFor(card: RateCardData, country: string | null, category: string): number | undefined {
  const cat = category.toUpperCase() as RateCategory;
  const own = country ? card.rates[country.toUpperCase()]?.[cat] : undefined;
  const units = own ?? card.rates[DEFAULT_COUNTRY]?.[cat];
  if (units === undefined) return undefined;
  return card.scale === 2 ? Math.ceil(units / 100) : units;
}
