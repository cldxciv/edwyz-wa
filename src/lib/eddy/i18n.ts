/**
 * Eddy's i18n (docs/EDDY-SPEC.md 2.4, 6.12, EDDY-12): English, Hindi (Devanagari) and Hinglish (Hindi in Roman script).
 *
 * - `t(lang, key, vars)` is type-safe over the core key union of copy/en.ts.
 * - `makeTranslator(...catalogues)` builds the same kind of function over any area catalogue, so later packages add
 *   their own files under src/lib/eddy/copy/ (each exporting `catalogue = defineCatalogue({en, hi, hinglish})`) without
 *   editing the core files. `registerCatalogue()` makes an area's keys reachable by `translateKey()`, which renders keys
 *   that arrive from the server at run time (a card's titleKey, a done row's summaryKey).
 * - `spendMessage(lang, code, vars)` renders a Phase 0 spend code (src/lib/spend/copy.ts) in the member's language. In
 *   English it is byte-identical to spendCopy() for the same figures (tests/eddy-i18n.test.ts), because Eddy shows
 *   Phase 0's own words (1.4).
 *
 * Pure: no React, no database, no network, and no import of @/lib/spend (Eddy's import boundary, 4.8).
 */
import { EDDY_HTML_LANG, EDDY_LANGS, type EddyLang } from "./contract";
import { en, type CoreKey } from "./copy/en";
import { hi } from "./copy/hi";
import { hinglish } from "./copy/hinglish";

export type { CoreKey, EddyLang };

/** Template variables. Callers format numbers, money and dates first (5.7 formatting); null and undefined count as missing. */
export type Vars = Record<string, string | number | null | undefined>;

/** One catalogue: every key in all three languages. */
export type Catalogue<K extends string> = { readonly en: { readonly [P in K]: string }; readonly hi: { readonly [P in K]: string }; readonly hinglish: { readonly [P in K]: string } };

/** Identity helper that fixes the key union of an area catalogue from its English object. */
export function defineCatalogue<K extends string>(c: { en: { readonly [P in K]: string }; hi: { readonly [P in K]: string }; hinglish: { readonly [P in K]: string } }): Catalogue<K> {
  return Object.freeze({ en: Object.freeze({ ...c.en }), hi: Object.freeze({ ...c.hi }), hinglish: Object.freeze({ ...c.hinglish }) }) as Catalogue<K>;
}

/** The core catalogue (copy/en.ts, copy/hi.ts, copy/hinglish.ts). */
export const CORE: Catalogue<CoreKey> = defineCatalogue<CoreKey>({ en, hi, hinglish });

const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;

/** The {placeholders} of a template, sorted and without duplicates. */
export function placeholders(template: string): string[] {
  const out = new Set<string>();
  for (const m of template.matchAll(PLACEHOLDER)) out.add(m[1]);
  return [...out].sort();
}

const present = (v: unknown): v is string | number => (typeof v === "string" || (typeof v === "number" && Number.isFinite(v)));

/** Fills {placeholders} from vars. A missing variable stays visible as {name}, so a gap is noticed instead of hidden. */
export function interpolate(template: string, vars: Vars = {}): string {
  return template.replace(PLACEHOLDER, (whole, name: string) => {
    const v = vars[name];
    return present(v) ? String(v) : whole;
  });
}

/** A template split into text and variable slots, so a component can render each variable as its own node (6.5). */
export type Part = { kind: "text"; text: string } | { kind: "var"; name: string };

export function templateParts(template: string): Part[] {
  const parts: Part[] = [];
  let last = 0;
  for (const m of template.matchAll(PLACEHOLDER)) {
    const at = m.index ?? 0;
    if (at > last) parts.push({ kind: "text", text: template.slice(last, at) });
    parts.push({ kind: "var", name: m[1] });
    last = at + m[0].length;
  }
  if (last < template.length) parts.push({ kind: "text", text: template.slice(last) });
  return parts;
}

export const isEddyLang = (v: unknown): v is EddyLang => typeof v === "string" && (EDDY_LANGS as readonly string[]).includes(v);

/** A language value from outside (a body field, a stored preference); anything else is English. */
export const asEddyLang = (v: unknown): EddyLang => (isEddyLang(v) ? v : "en");

/** The `lang` attribute of a message: hi, hi-Latn or en (6.3). */
export const htmlLang = (lang: EddyLang): string => EDDY_HTML_LANG[lang] ?? "en";

/** True when at least 30% of the letters are Devanagari, the same bar as language detection (5.7). */
export function isMostlyDevanagari(text: string): boolean {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length === 0) return false;
  const deva = letters.filter((c) => /\p{Script=Devanagari}/u.test(c)).length;
  return deva / letters.length >= 0.3;
}

export type Translator<K extends string> = {
  (lang: EddyLang, key: K, vars?: Vars): string;
  /** True when the key is in this translator's catalogues. */
  has(key: string): key is K;
  /** The raw template, before interpolation (English when the language lacks it). */
  template(lang: EddyLang, key: K): string;
  /** The template split into text and variable slots. */
  parts(lang: EddyLang, key: K): Part[];
  keys(): K[];
};

/** The keys of a catalogue. */
export type CatalogueKey<C> = C extends Catalogue<infer K extends string> ? K : never;

/**
 * A translator over one or more catalogues; later catalogues win on a duplicate key. The catalogues may have different
 * key sets (the core plus an area catalogue), and the translator accepts the keys of all of them.
 */
export function makeTranslator<Cs extends readonly Catalogue<string>[]>(...catalogues: Cs): Translator<CatalogueKey<Cs[number]>> {
  return buildTranslator<CatalogueKey<Cs[number]>>(catalogues);
}

function buildTranslator<K extends string>(catalogues: readonly Catalogue<string>[]): Translator<K> {
  const merged: Record<EddyLang, Record<string, string>> = { en: {}, hi: {}, hinglish: {} };
  for (const c of catalogues) for (const lang of EDDY_LANGS) Object.assign(merged[lang], c[lang]);
  const template = (lang: EddyLang, key: K): string => merged[lang]?.[key] ?? merged.en[key] ?? key;
  const tr = ((lang: EddyLang, key: K, vars?: Vars) => interpolate(template(asEddyLang(lang), key), vars)) as Translator<K>;
  tr.has = (key: string): key is K => Object.prototype.hasOwnProperty.call(merged.en, key);
  tr.template = (lang, key) => template(asEddyLang(lang), key);
  tr.parts = (lang, key) => templateParts(template(asEddyLang(lang), key));
  tr.keys = () => Object.keys(merged.en) as K[];
  return tr;
}

/** The core translator. */
export const t: Translator<CoreKey> = makeTranslator(CORE);

// ===== Starter chips (6.10) =====

/** Starter chips by page, as catalogue keys. A tapped chip sends its own text, in the member's language, as the message. */
export const STARTER_CHIP_KEYS = {
  "inbox.chat": ["start.inbox.summarize", "start.inbox.draft", "start.inbox.why_failed"],
  templates: ["start.templates.rejected", "start.templates.diwali"],
  broadcasts: ["start.broadcasts.cost", "start.broadcasts.yesterday"],
  dashboard: ["start.dashboard.attention", "start.dashboard.next_step"],
  "settings.spending": ["start.spending.left", "start.spending.stop"],
} as const satisfies Record<string, readonly CoreKey[]>;

/** The plain "Go to" buttons that stand in for the starter chips while the AI is unavailable (6.11). */
export const GOTO_KEYS = {
  "inbox.chat": { key: "goto.inbox", path: "/app/inbox" },
  templates: { key: "goto.templates", path: "/app/templates" },
  broadcasts: { key: "goto.broadcasts", path: "/app/broadcasts" },
  dashboard: { key: "goto.dashboard", path: "/app" },
  "settings.spending": { key: "goto.spending", path: "/app/settings/spending" },
} as const satisfies Record<keyof typeof STARTER_CHIP_KEYS, { key: CoreKey; path: string }>;

export type StarterPage = keyof typeof STARTER_CHIP_KEYS;

/** The starter page for a page-context id ("inbox.chat", "broadcasts.detail", "settings.spending"); dashboard otherwise. */
export function starterPageOf(pageId: string | null | undefined): StarterPage {
  const id = typeof pageId === "string" ? pageId : "";
  if (id in STARTER_CHIP_KEYS) return id as StarterPage;
  if (id.startsWith("inbox.") && id !== "inbox.list") return "inbox.chat";
  if (id.startsWith("settings.spending")) return "settings.spending";
  const head = id.split(".", 1)[0];
  return head in STARTER_CHIP_KEYS ? (head as StarterPage) : "dashboard";
}

/** The chips for a page in the member's language: the label is also the text that is sent. */
export function starterChips(lang: EddyLang, pageId: string | null | undefined): { key: CoreKey; label: string; query: string }[] {
  return STARTER_CHIP_KEYS[starterPageOf(pageId)].map((key) => {
    const label = t(lang, key);
    return { key, label, query: label };
  });
}

// ===== Keys that arrive at run time =====

const registry: Catalogue<string>[] = [CORE as Catalogue<string>];

/** Makes an area catalogue's keys reachable by translateKey(). Idempotent. */
export function registerCatalogue(c: Catalogue<string>): void {
  if (!registry.includes(c)) registry.push(c);
}

function findTemplate(lang: EddyLang, key: string): string | null {
  for (let i = registry.length - 1; i >= 0; i--) {
    const c = registry[i];
    const own = c[lang]?.[key];
    if (typeof own === "string") return own;
  }
  for (let i = registry.length - 1; i >= 0; i--) {
    const fallback = registry[i].en?.[key];
    if (typeof fallback === "string") return fallback;
  }
  return null;
}

/** True when some registered catalogue holds the key. */
export function hasKey(key: unknown): key is string {
  return typeof key === "string" && findTemplate("en", key) !== null;
}

/**
 * Renders a key the server sent (a card's titleKey, a fact's labelKey, a done row's summaryKey). An unknown key gives
 * `fallback` when one is passed, otherwise the generic done line, never the raw key.
 */
export function translateKey(lang: EddyLang, key: string, vars: Vars = {}, fallback?: string): string {
  const template = typeof key === "string" ? findTemplate(asEddyLang(lang), key) : null;
  if (template === null) return fallback ?? t(lang, "done.generic");
  return interpolate(template, vars);
}

/** The raw template of a run-time key, or null. */
export function templateOf(lang: EddyLang, key: string): string | null {
  return findTemplate(asEddyLang(lang), key);
}

/** The first key of `keys` that exists, rendered; `fallback` when none does. */
export function firstKey(lang: EddyLang, keys: readonly string[], vars: Vars = {}, fallback?: string): string {
  for (const key of keys) if (hasKey(key)) return translateKey(lang, key, vars);
  return fallback ?? t(lang, "done.generic");
}

// ===== Phase 0 spend codes (src/lib/spend/copy.ts) =====

/** Every Phase 0 copy code (copy.ts SPEND_COPY_CODES). Listed here so Eddy's code never imports the spend book. */
export const SPEND_CODES = [
  "spend.daily_limit",
  "spend.monthly_limit",
  "spend.no_limit",
  "spend.frozen",
  "spend.platform_frozen",
  "spend.end_date_required",
  "spend.currency",
  "spend.not_spending_account",
  "spend.probation",
  "spend.meta_cap_too_low",
  "spend.meta_rate",
  "spend.broadcast",
  "spend.messaging_limit",
  "ai_quota",
  "spend.busy",
  "spend.only_owner_raise",
  "spend.version",
  "spend.demo",
] as const;
export type SpendCode = (typeof SPEND_CODES)[number];

export const isSpendCode = (code: unknown): code is SpendCode => typeof code === "string" && (SPEND_CODES as readonly string[]).includes(code);

/**
 * Display strings for a spend code, formatted by the server exactly as copy.ts formats them (formatMinor amounts,
 * "1 Nov" dates, "3:40 pm" times). A missing figure drops its sentence, as copy.ts does.
 */
export type SpendVars = {
  left?: string;
  needs?: string;
  cost?: string;
  daily?: string;
  monthly?: string;
  accountCurrency?: string;
  limitCurrency?: string;
  /** spend.meta_rate: when Meta allows the next change. */
  time?: string;
  /** spend.messaging_limit, ai_quota: when the used-up month resets. */
  date?: string;
  minutes?: number | string;
  period?: "day" | "month";
};

/** copy.ts's seeded new-workspace ceilings (Phase 0 12.1a decision 3: INR 2,000 a day and 20,000 a month). */
const PROBATION_DEFAULT = { daily: "₹2,000", monthly: "₹20,000" } as const;

const has = (v: unknown): v is string | number => present(v) && String(v).length > 0;

/** The catalogue keys, in order, that make up the sentence for a code and its figures. */
export function spendKeys(code: SpendCode, v: SpendVars = {}): CoreKey[] {
  const day = v.period === "day";
  switch (code) {
    case "spend.daily_limit":
      return ["spend.daily_limit", ...(has(v.left) ? (["spend.daily_limit.left"] as const) : []), ...(has(v.needs) ? (["spend.daily_limit.needs"] as const) : []), "spend.daily_limit.fix"];
    case "spend.monthly_limit":
      return ["spend.monthly_limit", ...(has(v.left) ? (["spend.monthly_limit.left"] as const) : []), ...(has(v.needs) ? (["spend.monthly_limit.needs"] as const) : []), "spend.monthly_limit.fix"];
    case "spend.currency":
      return [has(v.accountCurrency) && has(v.limitCurrency) ? "spend.currency.named" : "spend.currency"];
    case "spend.meta_rate":
      return ["spend.meta_rate", has(v.time) ? "spend.meta_rate.at" : "spend.meta_rate.hour"];
    case "spend.broadcast":
      if (has(v.cost) && has(v.left)) return [day ? "spend.broadcast.cost_day" : "spend.broadcast.cost"];
      return [day ? "spend.broadcast.day" : "spend.broadcast"];
    case "spend.messaging_limit":
      return [day ? "spend.messaging_limit.day" : has(v.date) ? "spend.messaging_limit.date" : "spend.messaging_limit"];
    case "ai_quota":
      return [day ? "ai_quota.day" : has(v.date) ? "ai_quota" : "ai_quota.month"];
    default:
      return [code];
  }
}

/** A Phase 0 spend code in the member's language; English equals spendCopy(code, params) for the same figures. */
export function spendMessage(lang: EddyLang, code: SpendCode, vars: SpendVars = {}): string {
  const filled: Vars = {
    ...vars,
    minutes: has(vars.minutes) ? vars.minutes : 20,
    daily: has(vars.daily) ? vars.daily : PROBATION_DEFAULT.daily,
    monthly: has(vars.monthly) ? vars.monthly : PROBATION_DEFAULT.monthly,
  };
  delete filled.period;
  return spendKeys(code, vars)
    .map((key) => t(lang, key, filled))
    .join(" ");
}
