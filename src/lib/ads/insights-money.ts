/** Currencies whose minor unit equals the major unit (no decimals). VERIFY against Meta's currency list. */
const ZERO_DECIMAL = new Set(["JPY", "KRW", "VND", "CLP", "ISK", "HUF", "UGX", "PYG", "XAF", "XOF", "XPF", "RWF", "KMF", "GNF", "DJF", "VUV"]);
const THREE_DECIMAL = new Set(["BHD", "JOD", "KWD", "OMR", "TND"]);
export const INT_MAX = 2_147_483_647;

export function currencyExponent(currency: string | null | undefined): number {
  const c = (currency ?? "").toUpperCase();
  if (ZERO_DECIMAL.has(c)) return 0;
  return THREE_DECIMAL.has(c) ? 3 : 2;
}

/**
 * Converts the decimal string Meta returns for spend (account currency, major units) to integer minor units.
 * Pure string and integer arithmetic, rounds half up, clamps to the 32-bit column. Throws on anything that is not a plain decimal.
 */
export function decimalToMinor(value: string | number | null | undefined, exponent: number): number {
  if (value === null || value === undefined || value === "") return 0;
  const m = /^(\d{1,12})(?:\.(\d+))?$/.exec(String(value).trim());
  if (!m) throw new RangeError("Spend is not a plain decimal amount.");
  const frac = m[2] ?? "";
  const kept = frac.slice(0, exponent).padEnd(exponent, "0");
  const roundUp = frac.length > exponent && frac.charCodeAt(exponent) >= 53 ? 1 : 0;
  const minor = Number(m[1]) * 10 ** exponent + Number(kept || "0") + roundUp;
  return Math.min(minor, INT_MAX);
}

/** Integer minor units per result, rounded half up. Null when there are no results. */
export function costPerResultMinor(spendMinor: number, results: number): number | null {
  if (results <= 0) return null;
  return Math.floor((spendMinor * 2 + results) / (results * 2));
}

/** Display only: minor units to a localized currency string. Never feed the result back into arithmetic. */
export function formatMinor(minor: number, currency: string | null, locale?: string): string {
  const exp = currencyExponent(currency);
  const major = minor / 10 ** exp;
  if (currency && /^[A-Za-z]{3}$/.test(currency)) {
    try {
      return new Intl.NumberFormat(locale, { style: "currency", currency: currency.toUpperCase() }).format(major);
    } catch {
      // unknown currency code: fall through to a plain number
    }
  }
  return major.toLocaleString(locale, { minimumFractionDigits: exp, maximumFractionDigits: exp });
}
