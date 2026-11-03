/**
 * Prices of the shop (docs/specs/META-CATALOG-COMMERCE-SPEC.md 2.3, 3.4, 5.3 and D-C9). Pure and safe in the browser.
 *
 * Every price is an integer in minor units (bigint) of an explicit currency, formatted only at the edges: "799.00 INR" for
 * Meta (metaPrice) and "₹799" for people (formatPrice). It reuses src/lib/spend/money.ts and adds only what the shop needs:
 * the ways owners type rupees ("Rs. 1,299", "799 INR") and Meta's order webhook prices (a JSON number or a decimal string in
 * major units).
 */
import { currencyExponent, decimalToMinorBig, formatMinor, isCurrencyCode, type MinorInput, minorToMajorString, parseMajorInput, toMinor } from "@/lib/spend/money";

/** The shop's currency unless the workspace has another (2.1). */
export const DEFAULT_SHOP_CURRENCY = "INR";

/** No price may pass one billion in major units (₹1,00,00,00,000): anything above is a typing mistake. */
export const MAX_PRICE_MAJOR = 1_000_000_000n;

/** The largest price in minor units for a currency. */
export function maxPriceMinor(currency: string): bigint {
  return MAX_PRICE_MAJOR * 10n ** BigInt(currencyExponent(currency));
}

/** Meta's price text: major units with the currency's decimals, a space and the code ("799.00 INR", "1500 JPY", "1.234 KWD"). */
export function metaPrice(minor: MinorInput, currency: string): string {
  const code = currency.toUpperCase();
  if (!isCurrencyCode(code)) throw new RangeError("A price needs a three-letter currency code.");
  const value = toMinor(minor);
  if (value < 0n) throw new RangeError("A price can't be below zero.");
  return `${minorToMajorString(value, code)} ${code}`;
}

/** A price for people ("₹1,299", "₹799.50"). */
export function formatPrice(minor: MinorInput, currency: string): string {
  return formatMinor(minor, currency);
}

export type PriceProblem = "empty" | "not_number" | "decimals" | "zero" | "too_large";
export type PriceParse = { ok: true; minor: bigint } | { ok: false; problem: PriceProblem };

/** What an owner typed, cut short for an error message. */
const quoted = (raw: string) => (raw.length > 20 ? `${raw.slice(0, 20)}…` : raw);

/** The example in "Write it like 799." (2.4); with `decimals`, one with the currency's decimals ("799.50", "799.500"). */
export function priceExample(currency: string, decimals = false): string {
  const exponent = currencyExponent(currency);
  return decimals && exponent > 0 ? `799.${"5".padEnd(exponent, "0")}` : "799";
}

/**
 * Parses a price an owner typed in major units: "799", "799.50", "1,299", "₹1,299.00", "Rs. 1,299", "INR 799" or "799 INR"
 * (commas, spaces and the rupee sign are ignored). "799/-", "abc" and "12.345" (too many decimals) are refused, never rounded.
 * Zero and negative prices are refused: a product needs a price above zero.
 */
export function parseRupees(text: string | number | null | undefined, currency: string = DEFAULT_SHOP_CURRENCY): PriceParse {
  if (text === null || text === undefined) return { ok: false, problem: "empty" };
  const code = currency.toUpperCase();
  let cleaned = String(text).trim();
  if (cleaned === "") return { ok: false, problem: "empty" };
  // "Rs", "Rs." and the currency code may stand before or after the number.
  cleaned = cleaned.replace(/^(?:rs\.?|₹)\s*/i, "").replace(/\s*(?:rs\.?)$/i, "");
  if (isCurrencyCode(code)) cleaned = cleaned.replace(new RegExp(`^${code}\\s*|\\s*${code}$`, "i"), "");
  // A minus sign is never part of a price; refuse it instead of letting the parser treat "-5" as a typo.
  if (/-/.test(cleaned)) return { ok: false, problem: "not_number" };
  let minor: bigint | null;
  try {
    minor = parseMajorInput(cleaned, code);
  } catch (e) {
    const message = e instanceof Error ? e.message : "";
    if (/decimal|whole amount/i.test(message)) return { ok: false, problem: "decimals" };
    if (/too large/i.test(message)) return { ok: false, problem: "too_large" };
    return { ok: false, problem: "not_number" };
  }
  if (minor === null) return { ok: false, problem: "empty" };
  if (minor <= 0n) return { ok: false, problem: "zero" };
  if (minor > maxPriceMinor(code)) return { ok: false, problem: "too_large" };
  return { ok: true, minor };
}

/**
 * The plain words for a price problem. `label` is what the price is called on the screen ("price", "sale price").
 * Example (2.4): "The price '799/-' isn't a number. Write it like 799."
 */
export function priceProblemText(problem: PriceProblem, raw: unknown, currency: string = DEFAULT_SHOP_CURRENCY, label = "price"): string {
  const shown = quoted(String(raw ?? "").trim());
  const Label = label.charAt(0).toUpperCase() + label.slice(1);
  switch (problem) {
    case "empty":
      return `Add a ${label}.`;
    case "not_number":
      return `The ${label} '${shown}' isn't a number. Write it like ${priceExample(currency)}.`;
    case "decimals":
      return currencyExponent(currency) === 0
        ? `The ${label} '${shown}' can't have decimals. Write it like ${priceExample(currency)}.`
        : `The ${label} '${shown}' has too many decimals. Write it like ${priceExample(currency, true)}.`;
    case "zero":
      return `${Label} must be more than zero.`;
    case "too_large":
      return `The ${label} '${shown}' is too large. Check the number and try again.`;
  }
}

/**
 * A price from Meta's order webhook (`order.product_items[].item_price`) in minor units of `currency`, or null when it is
 * missing or unusable. Meta's reference types it as an integer but its example is 7.99, so both a JSON number and a decimal
 * string in major units are accepted (VERIFY V-C18 for INR). Negative, non-finite, exponent-notation and absurdly large
 * values give null: a bad number never becomes a price.
 */
export function webhookPriceToMinor(value: unknown, currency: string | null | undefined): bigint | null {
  if (!isCurrencyCode(currency ?? "")) return null;
  const code = currency as string;
  let text: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return null;
    // The shortest round-trip form keeps 0.285 as "0.285" (toFixed would give 0.28499...).
    text = String(value);
    if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
  } else if (typeof value === "string") {
    text = value.trim();
    if (!/^\d{1,15}(?:\.\d{1,12})?$/.test(text)) return null;
  } else return null;
  let minor: bigint;
  try {
    minor = decimalToMinorBig(text, currencyExponent(code));
  } catch {
    return null;
  }
  return minor > maxPriceMinor(code) ? null : minor;
}
