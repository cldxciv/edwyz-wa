/**
 * The typed copy catalogue of Instagram and Facebook Page ads (docs/IG-PAGE-ADS-SPEC.md 3.13, D23, PRM-02).
 *
 * - promoteText(key, vars, lang) fills a template in English, Hindi or Hinglish. Eddy cards use the member's language;
 *   pages use English until PROMOTE_PAGE_LANGS allows more (pageLang()).
 * - Numbers use Western digits with Indian grouping (1,50,000). Money goes through Phase 0's formatMinor with the ad
 *   account's currency and its exponent, never `minor / 100` (3.1a).
 * - Dates and times are in the ad account's time zone (D30); callers pass the zone.
 *
 * Pure: no database, no network. The language files hold data only, so Eddy's catalogue can read them (E-R5).
 */
import { formatMinor, type MinorInput } from "@/lib/spend/money";
import { localParts, resolveTimeZone } from "@/lib/spend/periods";
import { PROMOTE_LANGS, type PromoteLang } from "../types";
import { en, type PromoteCopyKey } from "./en";
import { hi } from "./hi";
import { hinglish } from "./hinglish";

export type { PromoteCopyKey };

/** Every language's templates, keyed alike (the same shape as Eddy's Catalogue). */
export const PROMOTE_COPY: { readonly [L in PromoteLang]: { readonly [K in PromoteCopyKey]: string } } = Object.freeze({ en, hi, hinglish });

/** An amount in the ad account's currency, formatted by formatMoney. */
export type MoneyVar = { minor: MinorInput; currency: string };
export type CopyVars = Record<string, string | number | bigint | MoneyVar | null | undefined>;

const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;

/** The {placeholders} of a template, sorted and without duplicates. */
export function placeholders(template: string): string[] {
  const out = new Set<string>();
  for (const m of template.matchAll(PLACEHOLDER)) out.add(m[1]);
  return [...out].sort();
}

export const isPromoteCopyKey = (v: unknown): v is PromoteCopyKey => typeof v === "string" && Object.prototype.hasOwnProperty.call(en, v);

/** Western digits with Indian grouping: 150000 -> "1,50,000". */
export function formatCount(n: number | bigint): string {
  if (typeof n === "number" && !Number.isFinite(n)) return String(n);
  return new Intl.NumberFormat("en-IN").format(n);
}

/** An amount through Phase 0's formatMinor: the account currency's symbol, exponent and en-IN grouping in every language. */
export function formatMoney(minor: MinorInput, currency: string): string {
  return formatMinor(minor, currency);
}

const isMoney = (v: unknown): v is MoneyVar => !!v && typeof v === "object" && "minor" in v && "currency" in v;

function renderVar(v: CopyVars[string]): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number") return Number.isFinite(v) ? formatCount(v) : null;
  if (typeof v === "bigint") return formatCount(v);
  if (isMoney(v)) return formatMoney(v.minor, v.currency);
  return null;
}

/** Fills {placeholders}. A missing variable stays visible as {name}, so a gap is noticed instead of hidden. */
export function interpolate(template: string, vars: CopyVars = {}): string {
  return template.replace(PLACEHOLDER, (whole, name: string) => renderVar(vars[name]) ?? whole);
}

/** A language from outside; anything unknown is English. */
export const asPromoteLang = (v: unknown): PromoteLang => ((PROMOTE_LANGS as readonly unknown[]).includes(v) ? (v as PromoteLang) : "en");

/** The raw template of a key in a language. */
export function promoteTemplate(key: PromoteCopyKey, lang: PromoteLang = "en"): string {
  return PROMOTE_COPY[asPromoteLang(lang)][key] ?? en[key];
}

/** The copy for a key, filled from vars, in the language (English by default). */
export function promoteText(key: PromoteCopyKey, vars: CopyVars = {}, lang: PromoteLang = "en"): string {
  return interpolate(promoteTemplate(key, lang), vars);
}

/** The same copy in all three languages, for results that carry every language (checkMedia, review reasons). */
export function promoteTextAll(key: PromoteCopyKey, vars: CopyVars = {}): Record<PromoteLang, string> {
  return { en: promoteText(key, vars, "en"), hi: promoteText(key, vars, "hi"), hinglish: promoteText(key, vars, "hinglish") };
}

/**
 * The language a page renders in (D23): the member's language only when PROMOTE_PAGE_LANGS allows it (pass
 * PromoteAccess.pageLangs), otherwise English. Eddy cards do not use this; they follow the member's Eddy language.
 */
export function pageLang(requested: unknown, allowed: readonly PromoteLang[]): PromoteLang {
  const lang = asPromoteLang(requested);
  return lang === "en" || allowed.includes(lang) ? lang : "en";
}

// ===== Lists, months, dates and durations =====

/** "a", "a and b", "a, b and c" in the language. */
export function joinList(items: readonly string[], lang: PromoteLang = "en"): string {
  if (items.length <= 1) return items[0] ?? "";
  const and = promoteText("list.and", {}, lang);
  return `${items.slice(0, -1).join(", ")} ${and} ${items[items.length - 1]}`;
}

const monthNumber = (month: string | number): number => (typeof month === "number" ? month : Number(month.slice(5, 7)));

/** "November" for "2026-11" (or 11). */
export function monthName(month: string | number, lang: PromoteLang = "en"): string {
  const n = monthNumber(month);
  if (!Number.isInteger(n) || n < 1 || n > 12) throw new RangeError(`Not a month: ${month}`);
  return promoteText(`month.${n}` as PromoteCopyKey, {}, lang);
}

/** "1 Nov" (or "Sun 1 Nov" with the weekday) for an instant in the ad account's zone. Hindi: "1 नवंबर". */
export function formatDay(at: Date, tz: string, lang: PromoteLang = "en", opts: { weekday?: boolean } = {}): string {
  const p = localParts(at, resolveTimeZone(tz));
  const day = `${p.day} ${promoteText(`month.short.${p.month}` as PromoteCopyKey, {}, lang)}`;
  return opts.weekday ? `${promoteText(`weekday.${p.weekday}` as PromoteCopyKey, {}, lang)} ${day}` : day;
}

/** "1 Nov" for a day key "2026-11-01" (no zone needed: the key already is a local day). */
export function formatDayKey(day: string, lang: PromoteLang = "en"): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) throw new RangeError(`Not a day key: ${day}`);
  return `${Number(m[3])} ${promoteText(`month.short.${Number(m[2])}` as PromoteCopyKey, {}, lang)}`;
}

/** "3:40 pm" in the ad account's zone (the same shape as Phase 0's formatCopyTime). */
export function formatTime(at: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: resolveTimeZone(tz) })
    .format(at)
    .replace(/\s?(AM|PM)$/i, (m) => ` ${m.trim().toLowerCase()}`);
}

/** "3 min 10 s", "45 s" or "2 min" (rounded down to whole seconds). */
export function formatDuration(ms: number, lang: PromoteLang = "en"): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const min = Math.floor(total / 60);
  const sec = total % 60;
  if (min === 0) return promoteText("duration.sec", { sec: String(sec) }, lang);
  if (sec === 0) return promoteText("duration.min", { min: String(min) }, lang);
  return promoteText("duration.min_sec", { min: String(min), sec: String(sec) }, lang);
}

/** One figure in Indian words: 1,20,000 -> "1.2 lakh", 35,000 -> "35 thousand", 2,40,00,000 -> "2.4 crore". */
function indianShort(n: number, lang: PromoteLang): string {
  const one = (x: number) => (x >= 10 ? String(Math.round(x)) : String(Math.round(x * 10) / 10));
  if (n >= 1e7) return promoteText("num.crore", { n: one(n / 1e7) }, lang);
  if (n >= 1e5) return promoteText("num.lakh", { n: one(n / 1e5) }, lang);
  if (n >= 1e3) return promoteText("num.thousand", { n: one(n / 1e3) }, lang);
  return formatCount(n);
}

/** The audience size range (3.7): "1.2–1.8 lakh" when both ends share a unit, else "90 thousand–1.2 lakh". */
export function formatPeopleRange(lower: number, upper: number, lang: PromoteLang = "en"): string {
  const lo = indianShort(lower, lang);
  const up = indianShort(upper, lang);
  const unit = (s: string) => s.replace(/^[\d.,]+\s*/, "");
  if (unit(lo) && unit(lo) === unit(up)) return `${lo.replace(/\s*\D+$/u, "")}–${up}`;
  return `${lo}–${up}`;
}
