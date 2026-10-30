/**
 * Display formatting for Eddy (docs/EDDY-SPEC.md 5.7 "Formatting"). Tools return display strings in the turn's language,
 * built here:
 * - money: minor units with the currency's exponent and en-IN grouping in all three languages (₹1,02,340), exactly as
 *   Phase 0's formatMinor shows it (whole amounts drop the fraction; ₹1,02,340.50 keeps it);
 * - counts: en-IN grouping, Latin digits in every language;
 * - dates: en-IN month names for English and Hinglish ("28 Oct 2026"), Hindi month names for Hindi ("28 अक्टूबर 2026");
 * - times: "2:05 pm" in every language;
 * - truncation by grapheme (Intl.Segmenter), so a Devanagari conjunct (क्ष, त्र) or an emoji sequence is never split.
 *
 * Pure: no database, no network, no import outside src/lib/eddy (Eddy's import boundary, 4.8 test 4). The currency
 * exponent table mirrors src/lib/ads/insights-money.ts, which Eddy's code may not import.
 */
import type { EddyLang } from "./contract";

export const FORMAT_LOCALE = "en-IN";

// ===== Numbers and money =====

const ZERO_DECIMAL = new Set(["JPY", "KRW", "VND", "CLP", "ISK", "HUF", "UGX", "PYG", "XAF", "XOF", "XPF", "RWF", "KMF", "GNF", "DJF", "VUV", "CRD"]);
const THREE_DECIMAL = new Set(["BHD", "JOD", "KWD", "OMR", "TND"]);

/** Decimal places of a currency's minor unit: 0, 2 or 3 (Phase 0 3.1). AI credits (CRD) have none. */
export function currencyExponent(currency: string | null | undefined): number {
  const c = (currency ?? "").toUpperCase();
  if (ZERO_DECIMAL.has(c)) return 0;
  return THREE_DECIMAL.has(c) ? 3 : 2;
}

/** A whole number of minor units as a bigint, or null for anything else (fractions, NaN, "1e5"). */
export function toMinorUnits(value: bigint | number | string | null | undefined): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return Number.isSafeInteger(value) ? BigInt(value) : null;
  if (typeof value === "string" && /^-?\d{1,30}$/.test(value.trim())) return BigInt(value.trim());
  return null;
}

function decimalString(minor: bigint, exponent: number): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  if (exponent === 0) return `${negative ? "-" : ""}${abs}`;
  const scale = 10n ** BigInt(exponent);
  return `${negative ? "-" : ""}${abs / scale}.${(abs % scale).toString().padStart(exponent, "0")}`;
}

/** en-IN digit grouping of an integer string: "102340" -> "1,02,340". Exact for any length. */
function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits;
  const last = digits.slice(-3);
  const rest = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return `${rest},${last}`;
}

/** A count with en-IN grouping and Latin digits: 102340 -> "1,02,340". Non-finite values read as "0". */
export function formatCount(value: number | bigint): string {
  if (typeof value === "bigint") return value < 0n ? `-${groupIndian((-value).toString())}` : groupIndian(value.toString());
  if (!Number.isFinite(value)) return "0";
  const n = Math.trunc(value);
  return n < 0 ? `-${groupIndian(String(-n))}` : groupIndian(String(n));
}

/** The narrow symbols en-IN shows (Phase 0 formatMinor); any other currency reads as its code: "AED 1,250". */
const SYMBOLS: Record<string, string> = { INR: "₹", USD: "$", EUR: "€", GBP: "£", JPY: "¥" };

/**
 * Money in minor units: 10234000n INR -> "₹1,02,340", 10234050n -> "₹1,02,340.50", 1500n JPY -> "¥1,500",
 * 1234n KWD -> "KWD 1.234" (no-break space), 140n CRD -> "140 credits". The same in English, Hindi and Hinglish (5.7). A value that is not a
 * whole number of minor units gives "-", never a guessed amount.
 */
export function formatMoney(minor: bigint | number | string, currency: string | null | undefined, _lang: EddyLang = "en"): string {
  const value = toMinorUnits(minor);
  if (value === null) return "-";
  const code = (currency ?? "").toUpperCase();
  if (code === "CRD") return `${formatCount(value)} ${value === 1n || value === -1n ? "credit" : "credits"}`;
  const exponent = currencyExponent(code);
  const decimal = decimalString(value, exponent);
  const negative = decimal.startsWith("-");
  const [whole, frac = ""] = (negative ? decimal.slice(1) : decimal).split(".");
  const showFraction = exponent > 0 && /[1-9]/.test(frac);
  const number = `${groupIndian(whole)}${showFraction ? `.${frac}` : ""}`;
  const symbol = SYMBOLS[code];
  // Like Intl's narrow currency display: a currency code is followed by a no-break space ("KWD 1.234"), so it never wraps.
  const body = symbol ? `${symbol}${number}` : /^[A-Z]{3}$/.test(code) ? `${code} ${number}` : code ? `${code} ${number}` : number;
  return negative ? `-${body}` : body;
}

/** A percentage the tool computed: 45.25 -> "45.3%" (one decimal at most), null -> "-". */
export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  const rounded = Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
}

// ===== Dates and times =====

const EN_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const EN_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** Hindi month names (hi-IN), the same for the short and the long style. */
export const HI_MONTHS = ["जनवरी", "फ़रवरी", "मार्च", "अप्रैल", "मई", "जून", "जुलाई", "अगस्त", "सितंबर", "अक्टूबर", "नवंबर", "दिसंबर"];

/** A month name (0 = January) in the member's language: Hindi names for `hi`, en-IN names otherwise. */
export function monthName(month0: number, lang: EddyLang, style: "short" | "long" = "short"): string {
  const m = ((Math.trunc(month0) % 12) + 12) % 12;
  if (lang === "hi") return HI_MONTHS[m];
  return style === "long" ? EN_LONG[m] : EN_SHORT[m];
}

export const DEFAULT_TIME_ZONE = "Asia/Kolkata";

type Parts = { year: number; month0: number; day: number; hour: number; minute: number };

/** The calendar fields of an instant in a time zone (an unknown zone falls back to Asia/Kolkata). */
export function zonedParts(date: Date, timeZone: string = DEFAULT_TIME_ZONE): Parts {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23" });
  } catch {
    fmt = new Intl.DateTimeFormat("en-US", { timeZone: DEFAULT_TIME_ZONE, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23" });
  }
  const get = (type: string) => Number(fmt.formatToParts(date).find((p) => p.type === type)?.value ?? "0");
  return { year: get("year"), month0: get("month") - 1, day: get("day"), hour: get("hour") % 24, minute: get("minute") };
}

const asDate = (d: Date | string | number): Date | null => {
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? null : date;
};

/** "28 Oct 2026" (en, hinglish) or "28 अक्टूबर 2026" (hi). `year: false` drops the year: "28 Oct", "28 अक्टूबर". */
export function formatDate(d: Date | string | number, lang: EddyLang, opts: { timeZone?: string; year?: boolean; style?: "short" | "long" } = {}): string {
  const date = asDate(d);
  if (!date) return "-";
  const p = zonedParts(date, opts.timeZone);
  const month = monthName(p.month0, lang, opts.style ?? "short");
  return opts.year === false ? `${p.day} ${month}` : `${p.day} ${month} ${p.year}`;
}

/** "2:05 pm", Latin digits in every language (Phase 0's copy shows times the same way). */
export function formatTime(d: Date | string | number, _lang: EddyLang = "en", timeZone?: string): string {
  const date = asDate(d);
  if (!date) return "-";
  const p = zonedParts(date, timeZone);
  const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  return `${h12}:${String(p.minute).padStart(2, "0")} ${p.hour < 12 ? "am" : "pm"}`;
}

/** "28 Oct 2026, 2:05 pm" or "28 अक्टूबर 2026, 2:05 pm". */
export function formatDateTime(d: Date | string | number, lang: EddyLang, timeZone?: string): string {
  const date = asDate(d);
  if (!date) return "-";
  return `${formatDate(date, lang, { timeZone })}, ${formatTime(date, lang, timeZone)}`;
}

const UNITS: Record<EddyLang, { min: string; hour: string; hours: string; day: string; days: string; sec: string }> = {
  en: { sec: "s", min: "min", hour: "h", hours: "h", day: "day", days: "days" },
  hi: { sec: "सेकंड", min: "मिनट", hour: "घंटा", hours: "घंटे", day: "दिन", days: "दिन" },
  hinglish: { sec: "sec", min: "min", hour: "ghanta", hours: "ghante", day: "din", days: "din" },
};

/** A duration in plain words: 45 -> "45 s", 300 -> "5 min", 7500 -> "2 h 5 min", 259200 -> "3 days" (localised units). */
export function formatDuration(seconds: number | null | undefined, lang: EddyLang = "en"): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return "-";
  const u = UNITS[lang] ?? UNITS.en;
  const s = Math.round(seconds);
  if (s < 60) return `${s} ${u.sec}`;
  const minutes = Math.round(s / 60);
  if (minutes < 60) return `${minutes} ${u.min}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    const rest = minutes % 60;
    return `${hours} ${hours === 1 ? u.hour : u.hours}${rest ? ` ${rest} ${u.min}` : ""}`;
  }
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? u.day : u.days}`;
}

// ===== Graphemes =====

let segmenter: Intl.Segmenter | null | undefined;
function graphemeSegmenter(): Intl.Segmenter | null {
  if (segmenter === undefined) {
    try {
      segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter("und", { granularity: "grapheme" }) : null;
    } catch {
      segmenter = null;
    }
  }
  return segmenter;
}

/** Code points after which a cut would leave a half-formed conjunct or a broken emoji sequence (virama, ZWJ, ZWNJ). */
const JOINER_END = /[्্੍્୍்్್്්‌‍]$/u;
const JOINER_START = /^[्্੍્୍்్್്්‌‍]/u;

/** The text as user-perceived characters. A virama or joiner keeps its neighbours in one piece even on an older ICU. */
export function graphemes(text: string): string[] {
  const seg = graphemeSegmenter();
  const raw = seg ? Array.from(seg.segment(text), (s) => s.segment) : (text.match(/(?:\P{M}\p{M}*)(?:[्্੍્୍்్್്‍]\P{M}\p{M}*)*|\p{M}+/gu) ?? []);
  const out: string[] = [];
  for (const g of raw) {
    if (out.length > 0 && (JOINER_END.test(out[out.length - 1]) || JOINER_START.test(g))) out[out.length - 1] += g;
    else out.push(g);
  }
  return out;
}

export const graphemeLength = (text: string): number => graphemes(text).length;

/**
 * At most `max` graphemes, the ellipsis included when the text was cut: "नमस्ते दुनिया" cut to 4 gives "नमस्…" never
 * "नमस्…" with a dangling virama. Text that fits is returned unchanged.
 */
export function truncate(text: string, max: number, ellipsis = "…"): string {
  if (typeof text !== "string" || max <= 0) return "";
  const parts = graphemes(text);
  if (parts.length <= max) return text;
  const keep = parts.slice(0, Math.max(0, max - (ellipsis ? 1 : 0)));
  while (keep.length > 0 && JOINER_END.test(keep[keep.length - 1])) keep.pop();
  return `${keep.join("")}${ellipsis}`;
}
