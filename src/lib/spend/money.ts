/**
 * Money for the spend controls (docs/SPEND-CONTROLS-SPEC.md 3.1). Pure: no database, no network.
 *
 * Every amount is an integer in minor units of an explicit currency, held as a bigint. AI is counted in the pseudo-currency
 * CRD (credits) with exponent 0. Display always goes through formatMinor with the currency exponent; writing `minor / 100`
 * anywhere is a bug. Nothing here clamps: the old decimalToMinor clamps at 2^31-1, which would UNDER-count IDR or VND spend.
 */
import { currencyExponent as baseCurrencyExponent } from "@/lib/ads/insights-money";

/** The pseudo-currency of the AI pot: one unit is one credit. */
export const CRD = "CRD";

/** Display locale for every amount: en-IN grouping in English, Hindi and Hinglish alike (₹1,02,340). */
export const MONEY_LOCALE = "en-IN";

/** A money value in minor units, as stored (bigint) or as it arrives from JSON or the database. */
export type MinorInput = bigint | number | string;

/** Postgres BIGINT, the column type of every stored amount: -2^63 .. 2^63-1. Parsed text outside it is refused up front. */
export const MAX_STORED_MINOR = 9_223_372_036_854_775_807n;
export const MIN_STORED_MINOR = -9_223_372_036_854_775_808n;

/** True when the value fits a BIGINT column. */
export function fitsStoredMinor(value: bigint): boolean {
  return value >= MIN_STORED_MINOR && value <= MAX_STORED_MINOR;
}

function parsedMinor(text: string): bigint {
  const value = BigInt(text);
  if (!fitsStoredMinor(value)) throw new RangeError("Amount is too large.");
  return value;
}

/** Decimal places of the currency's minor unit: 0, 2 or 3. CRD is 0. The table itself lives in src/lib/ads/insights-money.ts. */
export function currencyExponent(currency: string | null | undefined): number {
  if ((currency ?? "").toUpperCase() === CRD) return 0;
  return baseCurrencyExponent(currency);
}

/** True for a three-letter upper-case currency code, including CRD. */
export function isCurrencyCode(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z]{3}$/.test(value);
}

/**
 * Normalises a minor-unit value to bigint. Accepts a bigint, a safe integer, or a string of digits with an optional minus sign.
 * Throws RangeError on anything else (fractions, NaN, unsafe integers, "1e5"), so a bad value never becomes a silent zero.
 * Text outside the BIGINT range is refused too, so an over-long number never reaches the database as a 500.
 */
export function toMinor(value: MinorInput): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new RangeError("Amount is not a whole number of minor units.");
    return BigInt(value);
  }
  if (typeof value === "string" && /^-?\d{1,30}$/.test(value.trim())) return parsedMinor(value.trim());
  throw new RangeError("Amount is not a whole number of minor units.");
}

/** Serialises minor units for a DTO or JSON column: a plain decimal string of the integer ("200000"). */
export function serializeMinor(value: MinorInput): string {
  return toMinor(value).toString();
}

/** Parses a DTO minor-unit string ("200000"). Only non-negative whole numbers are accepted. */
export function parseMinorString(value: string): bigint {
  if (typeof value !== "string" || !/^\d{1,30}$/.test(value.trim())) throw new RangeError("Amount is not a whole number of minor units.");
  return parsedMinor(value.trim());
}

/** Splits minor units into a major-unit decimal string with exactly `exponent` decimals: (2034050n, 2) -> "20340.50". */
function toDecimalString(minor: bigint, exponent: number): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  if (exponent === 0) return `${negative ? "-" : ""}${abs}`;
  const scale = 10n ** BigInt(exponent);
  const whole = abs / scale;
  const frac = (abs % scale).toString().padStart(exponent, "0");
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

/**
 * Major units as a decimal string with the currency exponent, the "standard denomination" Meta's spend_cap write expects
 * (5.5): "20000.00" for INR, "20000" for JPY, "20.000" for KWD.
 */
export function minorToMajorString(minor: MinorInput, currency: string): string {
  return toDecimalString(toMinor(minor), currencyExponent(currency));
}

/**
 * Converts a plain decimal string in major units (Meta's spend, amount_spent or spend_cap) to minor units, with NO clamp.
 * Rounds half up at the exponent, like decimalToMinor. Empty or null is 0. Throws RangeError on anything that is not a plain
 * unsigned decimal, so a malformed value from Meta is never counted as zero spend.
 */
export function decimalToMinorBig(value: string | number | null | undefined, exponent: number): bigint {
  if (value === null || value === undefined || value === "") return 0n;
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > 6) throw new RangeError("Unsupported currency exponent.");
  const text = typeof value === "number" ? numberToPlainString(value) : String(value).trim();
  const m = /^(\d{1,30})(?:\.(\d{0,30}))?$/.exec(text);
  if (!m) throw new RangeError("Amount is not a plain decimal.");
  const frac = m[2] ?? "";
  const kept = frac.slice(0, exponent).padEnd(exponent, "0");
  const roundUp = frac.length > exponent && frac.charCodeAt(exponent) >= 53 ? 1n : 0n;
  return BigInt(m[1]) * 10n ** BigInt(exponent) + BigInt(kept || "0") + roundUp;
}

function numberToPlainString(value: number): string {
  if (!Number.isFinite(value) || value < 0) throw new RangeError("Amount is not a plain decimal.");
  // toFixed avoids exponent notation for the magnitudes Meta returns; 20 digits keeps every fraction a double can hold.
  return value.toFixed(20).replace(/\.?0+$/, "");
}

/**
 * Parses an amount a person typed in major units ("2,000", "₹ 1,500.50", "20000") into minor units of the currency.
 * Returns null for an empty field ("Not set"). Throws RangeError for anything else, including more decimals than the
 * currency has: a person's limit is never rounded silently.
 */
export function parseMajorInput(text: string | null | undefined, currency: string): bigint | null {
  if (text === null || text === undefined) return null;
  let cleaned = String(text).replace(/[\s,₹$€£¥]/g, "");
  if (isCurrencyCode(currency) && cleaned.toUpperCase().startsWith(currency)) cleaned = cleaned.slice(currency.length);
  if (cleaned === "") return null;
  const exponent = currencyExponent(currency);
  const m = /^(\d{1,24})(?:\.(\d+))?$/.exec(cleaned);
  if (!m) throw new RangeError("Enter an amount using numbers only.");
  if ((m[2] ?? "").length > exponent) throw new RangeError(exponent === 0 ? "Enter a whole amount." : `Use at most ${exponent} decimal places.`);
  const minor = decimalToMinorBig(cleaned, exponent);
  if (!fitsStoredMinor(minor)) throw new RangeError("That amount is too large. Enter a smaller amount.");
  return minor;
}

export type FormatMinorOptions = {
  /** Defaults to en-IN for every language (Eddy 5.7, Phase 0 3.1). */
  locale?: string;
  /** Show the fraction even when it is zero ("₹850.00" instead of "₹850"). Off by default: whole amounts read better. */
  alwaysFraction?: boolean;
};

/**
 * Display only: minor units to a localized string with the currency exponent and en-IN grouping. Whole amounts drop the
 * fraction: 10234000n INR -> "₹1,02,340", 10234050n -> "₹1,02,340.50", 1500n JPY -> "¥1,500", 1234n KWD -> "KWD 1.234".
 * CRD reads as credits: 140n -> "140 credits". Exact for any size (no float conversion). Never feed the result back into maths.
 */
export function formatMinor(minor: MinorInput, currency: string | null | undefined, options: FormatMinorOptions = {}): string {
  const locale = options.locale ?? MONEY_LOCALE;
  const value = toMinor(minor);
  const code = (currency ?? "").toUpperCase();
  if (code === CRD) {
    const count = new Intl.NumberFormat(locale).format(value);
    return `${count} ${value === 1n || value === -1n ? "credit" : "credits"}`;
  }
  const exponent = currencyExponent(code);
  const scale = 10n ** BigInt(exponent);
  const whole = value % scale === 0n && !options.alwaysFraction;
  const decimal = toDecimalString(value, exponent);
  const digits = whole ? 0 : exponent;
  const numberOptions: Intl.NumberFormatOptions = { minimumFractionDigits: digits, maximumFractionDigits: digits };
  // Intl accepts an exact decimal string, so very large amounts are not rounded through a double.
  const asIntl = decimal as Intl.StringNumericLiteral;
  if (isCurrencyCode(code)) {
    try {
      return new Intl.NumberFormat(locale, { style: "currency", currency: code, currencyDisplay: "narrowSymbol", ...numberOptions }).format(asIntl);
    } catch {
      // An unknown code falls through to a plain number with the code in front.
    }
  }
  const plain = new Intl.NumberFormat(locale, numberOptions).format(asIntl);
  return code ? `${code} ${plain}` : plain;
}

/** A formatted amount together with the exact minor units, for DTOs (decimal strings plus formatted text, 3.1). */
export type MoneyDTO = { minor: string; currency: string; formatted: string };

export function toMoneyDTO(minor: MinorInput, currency: string): MoneyDTO {
  const value = toMinor(minor);
  return { minor: value.toString(), currency, formatted: formatMinor(value, currency) };
}

/** Null (or undefined) stays null: it means "Not set" and must never be shown as ₹0. */
export function toMoneyDTOOrNull(minor: MinorInput | null | undefined, currency: string): MoneyDTO | null {
  return minor === null || minor === undefined ? null : toMoneyDTO(minor, currency);
}

/** The smaller of two limits where null means "no limit from this source". Null only when both are null. */
export function minLimit(a: bigint | null | undefined, b: bigint | null | undefined): bigint | null {
  if (a === null || a === undefined) return b ?? null;
  if (b === null || b === undefined) return a;
  return a < b ? a : b;
}

export function maxBig(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

export function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/** Whole percent of part over whole, rounded down. Null when there is no whole (a "Not set" limit). */
export function percentOf(part: bigint, whole: bigint | null | undefined): number | null {
  if (whole === null || whole === undefined || whole <= 0n) return null;
  if (part <= 0n) return 0;
  return Number((part * 100n) / whole);
}
