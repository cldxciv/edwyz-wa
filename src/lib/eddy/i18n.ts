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
 * - (E-R5, docs/IG-PAGE-ADS-SPEC.md 6.3) `promote.<key>` resolves from src/lib/promote/copy, the ads catalogue, through the one
 *   import below; the activity, done and card lines of Eddy's promotion, lead-form and audience tools (6.4) are registered
 *   here too (PROMOTE_TOOLS_CATALOGUE), so the cards render them in the browser.
 *
 * Pure: no React, no database, no network, and no import of @/lib/spend (Eddy's import boundary, 4.8).
 */
import { PROMOTE_COPY } from "@/lib/promote/copy";
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

// ===== Instagram and Facebook Page ads (docs/IG-PAGE-ADS-SPEC.md 6.3 E-R5, 6.4, 6.5) =====

/** Every key of the ads catalogue (src/lib/promote/copy) under `promote.`, so Eddy's cards and buttons can name them. */
function prefixed(source: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, text] of Object.entries(source)) out[`promote.${key}`] = text;
  return out;
}

/** E-R5: `promote.*` keys resolve from src/lib/promote/copy (one import above, no copy of the strings). */
export const PROMOTE_CATALOGUE: Catalogue<string> = defineCatalogue<string>({ en: prefixed(PROMOTE_COPY.en), hi: prefixed(PROMOTE_COPY.hi), hinglish: prefixed(PROMOTE_COPY.hinglish) });

const promoteToolsEn = {
  // Activity labels (6.4: 41 tools).
  "status.list_boostable_posts": "Looking at your posts…",
  "status.check_promotion_setup": "Checking what your ads need…",
  "status.get_creative_specs": "Checking ad sizes and text limits…",
  "status.list_ad_media": "Checking your ad pictures and videos…",
  "status.preview_ad": "Making the ad previews…",
  "status.get_promotion": "Opening the ad draft…",
  "status.review_promotion": "Checking the ad before it starts…",
  "status.get_promotion_results": "Checking how your ads did…",
  "status.get_version_comparison": "Comparing the versions…",
  "status.explain_ad_rejection": "Checking Meta's review…",
  "status.get_promote_settings": "Checking your ad settings…",
  "status.create_promotion_draft": "Saving the ad draft…",
  "status.update_promotion_draft": "Changing the ad draft…",
  "status.discard_promotion_draft": "Discarding the ad draft…",
  "status.duplicate_campaign": "Making a copy of the ads…",
  "status.set_promote_settings": "Saving your ad settings…",
  "status.save_promotion_paused": "Preparing to save the ads…",
  "status.start_promotion": "Preparing the ads…",
  "status.change_end_date": "Changing the end date…",
  "status.pick_winning_version": "Preparing to keep the winner…",
  "status.create_instagram_identity": "Preparing the Instagram identity…",
  "status.prepare_ad_media": "Preparing the file for Meta…",
  "status.get_ad_media": "Checking the file…",
  "status.create_pixel": "Preparing the pixel…",
  "status.list_lead_forms": "Looking at your lead forms…",
  "status.import_lead_form": "Adding the form to Edwyz…",
  "status.create_lead_form": "Preparing the form…",
  "status.copy_lead_form": "Preparing a copy of the form…",
  "status.send_test_lead": "Preparing a test lead…",
  "status.hide_lead_form": "Hiding the form…",
  "status.list_audiences": "Checking your audiences…",
  "status.get_audience": "Opening the audience…",
  "status.get_audience_size": "Working out how many people…",
  "status.search_places": "Searching places…",
  "status.search_interests": "Searching interests…",
  "status.save_audience": "Saving the audience…",
  "status.create_audience": "Preparing the audience…",
  "status.create_lookalike": "Preparing the lookalike audience…",
  "status.create_customer_audience": "Counting the contacts…",
  "status.refresh_customer_audience": "Counting the contacts…",
  "status.delete_audience": "Preparing to delete the audience…",
  // Done rows of the undoable tools.
  "done.create_promotion_draft": "Ad draft saved. Nothing was sent to Meta.",
  "done.update_promotion_draft": "Ad draft changed.",
  "done.discard_promotion_draft": "Ad draft discarded. You can undo this for 15 minutes.",
  "done.duplicate_campaign": "Copy saved as a draft. Nothing was sent to Meta.",
  "done.set_promote_settings": "Ad settings saved.",
  "done.import_lead_form": "Form added to Edwyz. Nothing changed on Meta.",
  "done.hide_lead_form": "Form hidden in Edwyz. It stays on your Page.",
  "done.save_audience": "Audience saved in Edwyz.",
  "done.change_end_date": "End date moved earlier.",
  // Cards (6.5).
  "card.save_promotion_paused.title": "Save these ads on Meta without starting them?",
  "card.save_promotion_paused.confirm": "Save without starting",
  "card.save_promotion_paused.done": "Saved on Meta, paused. Nothing is spent until you start them.",
  "card.start_promotion.title": "Start these ads?",
  "card.start_promotion.confirm": "Start ads · up to {amount}",
  "card.start_promotion.done": "Sent to Meta. Meta is reviewing it.",
  "card.change_end_date.title": "Run '{campaign}' until {date}?",
  "card.change_end_date.confirm": "Run longer",
  "card.change_end_date.done": "End date moved.",
  "card.pick_winning_version.title": "Keep version {version} and pause the others?",
  "card.pick_winning_version.confirm": "Keep {version}",
  "card.pick_winning_version.done": "Kept the winner. The other versions are paused.",
  "card.create_instagram_identity.title": "Create an Instagram identity for ads from {page}?",
  "card.create_instagram_identity.confirm": "Create identity",
  "card.create_instagram_identity.done": "The Instagram identity is ready for ads.",
  "card.prepare_ad_media.title": "Send this video to your ad account on Meta?",
  "card.prepare_ad_media.title_image": "Send this picture to your ad account on Meta?",
  "card.prepare_ad_media.confirm": "Send to Meta",
  "card.prepare_ad_media.done": "Sent. Meta is preparing it.",
  "card.create_pixel.title": "Create a Meta pixel for {website}?",
  "card.create_pixel.confirm": "Create pixel",
  "card.create_pixel.done": "The pixel is ready. Add its code to your website.",
  "card.create_lead_form.title": "Create the form '{name}' on {page}?",
  "card.create_lead_form.confirm": "Create form",
  "card.create_lead_form.done": "The form was created on your Page.",
  "card.copy_lead_form.title": "Make a copy of the form '{form}'?",
  "card.copy_lead_form.confirm": "Make copy",
  "card.copy_lead_form.done": "The copy was created on your Page.",
  "card.send_test_lead.title": "Send a test lead to '{form}'?",
  "card.send_test_lead.confirm": "Send test lead",
  "card.send_test_lead.done": "Test lead sent. It shows in Leads as Test.",
  "card.create_audience.title": "Make the audience '{name}' on Meta?",
  "card.create_audience.confirm": "Make audience",
  "card.create_audience.done": "Audience made. Meta is filling it.",
  "card.create_lookalike.title": "Make a {percent}% lookalike of '{seed}'?",
  "card.create_lookalike.confirm": "Make lookalike",
  "card.create_lookalike.done": "Lookalike made. Meta is filling it.",
  "card.create_customer_audience.title": "Share {count} contacts with Meta?",
  "card.create_customer_audience.confirm": "Share {count} contacts",
  "card.create_customer_audience.done": "List made. The contacts are being sent to Meta.",
  "card.refresh_customer_audience.title": "Update '{name}' with {count} contacts?",
  "card.refresh_customer_audience.confirm": "Update list",
  "card.refresh_customer_audience.done": "The list is being updated on Meta.",
  "card.delete_audience.title": "Delete the audience '{name}'?",
  "card.delete_audience.confirm": "Delete audience",
  "card.delete_audience.done": "Audience deleted.",
  // Fact labels.
  "fact.promote.page": "Page",
  "fact.promote.form": "Form",
  "fact.promote.questions": "Questions",
  "fact.promote.privacy": "Privacy link",
  "fact.promote.thank_you": "Thank-you button",
  "fact.promote.consent": "Consent box",
  "fact.promote.audience": "Audience",
  "fact.promote.kind": "Kind",
  "fact.promote.source": "Where people engaged",
  "fact.promote.days": "Days",
  "fact.promote.seed": "Based on",
  "fact.promote.percent": "How similar",
  "fact.promote.count": "Contacts",
  "fact.promote.sample": "Sample",
  "fact.promote.hashing": "How they're shared",
  "fact.promote.basis": "Who is included",
  "fact.promote.file": "File",
  "fact.promote.note": "Note",
  "fact.promote.campaign": "Ads",
  "fact.promote.end_now": "Ends now on",
  "fact.promote.end_new": "New end",
  "fact.promote.by_month": "Worst case by month",
  "fact.promote.keep": "Keep",
  "fact.promote.pause": "Pause",
  "fact.promote.verdict": "Result so far",
  "fact.promote.website": "Website",
  "fact.promote.version": "Version",
  "fact.promote.primary_text": "Text",
  "fact.promote.headline": "Headline",
  "fact.promote.description": "Description",
  "fact.promote.link": "Link",
  "fact.promote.button": "Button",
  "fact.promote.first_message": "First message",
  "fact.promote.quick_question": "Quick question",
  "fact.promote.caption": "Post caption",
  "fact.promote.about": "About",
  "fact.promote.left": "Left",
  "fact.promote.adds": "The extra days can add (worst case)",
  // Card sentences and buttons.
  "eddy_promote.new_tab": "opens in a new tab",
  "eddy_promote.ig_identity_note": "It can run ads only. It can't post or log in.",
  "eddy_promote.form_cant_change": "Meta doesn't let you change or delete a form once it's created.",
  "eddy_promote.test_lead_note": "It shows in Leads as Test. No WhatsApp message is sent.",
  "eddy_promote.media_note": "Meta prepares videos in about 5 to 30 minutes. It isn't shown to anyone until you start an ad.",
  "eddy_promote.pixel_note": "It counts visits and sales on your website once the code is added there. It doesn't spend anything.",
  "eddy_promote.basis": "Only contacts who agreed to get marketing messages and haven't opted out.",
  "eddy_promote.audience_delete_note": "Meta can't bring it back. Ads that use it stop reaching these people.",
  "eddy_promote.saved_paused_note": "Everything is made on Meta, paused. Nothing is spent until you start it.",
  "eddy_promote.end_earlier_note": "Moving the end earlier never needs a limit check.",
  "eddy_promote.pause_note": "Pausing spends nothing. Turning a version back on is a separate card.",
  "eddy_promote.audience_note": "Meta fills the audience over a few hours. Nothing is spent until an ad uses it.",
  "goto.promotion": "Open the ad draft",
} as const;

export type PromoteToolKey = keyof typeof promoteToolsEn;
const promoteToolsHi: Record<PromoteToolKey, string> = {
  "status.list_boostable_posts": "आपकी पोस्ट देखी जा रही हैं…",
  "status.check_promotion_setup": "विज्ञापन के लिए ज़रूरी चीज़ें जाँची जा रही हैं…",
  "status.get_creative_specs": "विज्ञापन के साइज़ और टेक्स्ट की सीमा देखी जा रही है…",
  "status.list_ad_media": "विज्ञापन की तस्वीरें और वीडियो देखे जा रहे हैं…",
  "status.preview_ad": "विज्ञापन के प्रीव्यू बनाए जा रहे हैं…",
  "status.get_promotion": "विज्ञापन का ड्राफ़्ट खोला जा रहा है…",
  "status.review_promotion": "शुरू करने से पहले विज्ञापन जाँचा जा रहा है…",
  "status.get_promotion_results": "विज्ञापनों के नतीजे देखे जा रहे हैं…",
  "status.get_version_comparison": "वर्ज़न की तुलना की जा रही है…",
  "status.explain_ad_rejection": "Meta का रिव्यू देखा जा रहा है…",
  "status.get_promote_settings": "विज्ञापन की सेटिंग देखी जा रही है…",
  "status.create_promotion_draft": "विज्ञापन का ड्राफ़्ट सेव किया जा रहा है…",
  "status.update_promotion_draft": "विज्ञापन का ड्राफ़्ट बदला जा रहा है…",
  "status.discard_promotion_draft": "विज्ञापन का ड्राफ़्ट हटाया जा रहा है…",
  "status.duplicate_campaign": "विज्ञापनों की कॉपी बनाई जा रही है…",
  "status.set_promote_settings": "विज्ञापन की सेटिंग सेव की जा रही है…",
  "status.save_promotion_paused": "विज्ञापन सेव करने की तैयारी हो रही है…",
  "status.start_promotion": "विज्ञापन तैयार किए जा रहे हैं…",
  "status.change_end_date": "खत्म होने की तारीख बदली जा रही है…",
  "status.pick_winning_version": "जीतने वाला वर्ज़न रखने की तैयारी हो रही है…",
  "status.create_instagram_identity": "इंस्टाग्राम पहचान की तैयारी हो रही है…",
  "status.prepare_ad_media": "फ़ाइल Meta के लिए तैयार की जा रही है…",
  "status.get_ad_media": "फ़ाइल देखी जा रही है…",
  "status.create_pixel": "पिक्सेल की तैयारी हो रही है…",
  "status.list_lead_forms": "आपके लीड फ़ॉर्म देखे जा रहे हैं…",
  "status.import_lead_form": "फ़ॉर्म Edwyz में जोड़ा जा रहा है…",
  "status.create_lead_form": "फ़ॉर्म की तैयारी हो रही है…",
  "status.copy_lead_form": "फ़ॉर्म की कॉपी की तैयारी हो रही है…",
  "status.send_test_lead": "टेस्ट लीड की तैयारी हो रही है…",
  "status.hide_lead_form": "फ़ॉर्म छिपाया जा रहा है…",
  "status.list_audiences": "आपकी ऑडियंस देखी जा रही हैं…",
  "status.get_audience": "ऑडियंस खोली जा रही है…",
  "status.get_audience_size": "कितने लोग हैं, यह देखा जा रहा है…",
  "status.search_places": "जगहें खोजी जा रही हैं…",
  "status.search_interests": "रुचियाँ खोजी जा रही हैं…",
  "status.save_audience": "ऑडियंस सेव की जा रही है…",
  "status.create_audience": "ऑडियंस की तैयारी हो रही है…",
  "status.create_lookalike": "मिलती-जुलती ऑडियंस की तैयारी हो रही है…",
  "status.create_customer_audience": "कॉन्टैक्ट गिने जा रहे हैं…",
  "status.refresh_customer_audience": "कॉन्टैक्ट गिने जा रहे हैं…",
  "status.delete_audience": "ऑडियंस डिलीट करने की तैयारी हो रही है…",
  "done.create_promotion_draft": "विज्ञापन का ड्राफ़्ट सेव हो गया है। Meta को कुछ नहीं भेजा गया।",
  "done.update_promotion_draft": "विज्ञापन का ड्राफ़्ट बदल दिया गया है।",
  "done.discard_promotion_draft": "विज्ञापन का ड्राफ़्ट हटा दिया गया है। 15 मिनट तक इसे वापस लाया जा सकता है।",
  "done.duplicate_campaign": "कॉपी ड्राफ़्ट के रूप में सेव हो गई है। Meta को कुछ नहीं भेजा गया।",
  "done.set_promote_settings": "विज्ञापन की सेटिंग सेव हो गई है।",
  "done.import_lead_form": "फ़ॉर्म Edwyz में जुड़ गया है। Meta पर कुछ नहीं बदला।",
  "done.hide_lead_form": "फ़ॉर्म Edwyz में छिपा दिया गया है। यह आपके पेज पर बना रहेगा।",
  "done.save_audience": "ऑडियंस Edwyz में सेव हो गई है।",
  "done.change_end_date": "खत्म होने की तारीख पहले कर दी गई है।",
  "card.save_promotion_paused.title": "इन विज्ञापनों को शुरू किए बिना Meta पर सेव करें?",
  "card.save_promotion_paused.confirm": "शुरू किए बिना सेव करें",
  "card.save_promotion_paused.done": "Meta पर रुके हुए रूप में सेव हो गया है। शुरू करने तक कोई खर्च नहीं होगा।",
  "card.start_promotion.title": "ये विज्ञापन शुरू करें?",
  "card.start_promotion.confirm": "विज्ञापन शुरू करें · ज़्यादा से ज़्यादा {amount}",
  "card.start_promotion.done": "Meta को भेज दिया गया। Meta इसका रिव्यू कर रहा है।",
  "card.change_end_date.title": "'{campaign}' को {date} तक चलाएँ?",
  "card.change_end_date.confirm": "ज़्यादा दिन चलाएँ",
  "card.change_end_date.done": "खत्म होने की तारीख बदल दी गई है।",
  "card.pick_winning_version.title": "वर्ज़न {version} रखें और बाकी रोकें?",
  "card.pick_winning_version.confirm": "{version} रखें",
  "card.pick_winning_version.done": "जीतने वाला वर्ज़न रखा गया। बाकी वर्ज़न रोक दिए गए हैं।",
  "card.create_instagram_identity.title": "{page} से विज्ञापनों के लिए इंस्टाग्राम पहचान बनाएँ?",
  "card.create_instagram_identity.confirm": "पहचान बनाएँ",
  "card.create_instagram_identity.done": "विज्ञापनों के लिए इंस्टाग्राम पहचान तैयार है।",
  "card.prepare_ad_media.title": "यह वीडियो Meta पर आपके विज्ञापन खाते में भेजें?",
  "card.prepare_ad_media.title_image": "यह तस्वीर Meta पर आपके विज्ञापन खाते में भेजें?",
  "card.prepare_ad_media.confirm": "Meta को भेजें",
  "card.prepare_ad_media.done": "भेज दिया गया। Meta इसे तैयार कर रहा है।",
  "card.create_pixel.title": "{website} के लिए Meta पिक्सेल बनाएँ?",
  "card.create_pixel.confirm": "पिक्सेल बनाएँ",
  "card.create_pixel.done": "पिक्सेल तैयार है। इसका कोड अपनी वेबसाइट में जोड़ें।",
  "card.create_lead_form.title": "{page} पर '{name}' फ़ॉर्म बनाएँ?",
  "card.create_lead_form.confirm": "फ़ॉर्म बनाएँ",
  "card.create_lead_form.done": "आपके पेज पर फ़ॉर्म बन गया है।",
  "card.copy_lead_form.title": "'{form}' फ़ॉर्म की कॉपी बनाएँ?",
  "card.copy_lead_form.confirm": "कॉपी बनाएँ",
  "card.copy_lead_form.done": "आपके पेज पर कॉपी बन गई है।",
  "card.send_test_lead.title": "'{form}' पर टेस्ट लीड भेजें?",
  "card.send_test_lead.confirm": "टेस्ट लीड भेजें",
  "card.send_test_lead.done": "टेस्ट लीड भेज दी गई। यह लीड्स में टेस्ट के रूप में दिखेगी।",
  "card.create_audience.title": "Meta पर '{name}' ऑडियंस बनाएँ?",
  "card.create_audience.confirm": "ऑडियंस बनाएँ",
  "card.create_audience.done": "ऑडियंस बन गई है। Meta इसमें लोग जोड़ रहा है।",
  "card.create_lookalike.title": "'{seed}' से {percent}% मिलती-जुलती ऑडियंस बनाएँ?",
  "card.create_lookalike.confirm": "मिलती-जुलती ऑडियंस बनाएँ",
  "card.create_lookalike.done": "मिलती-जुलती ऑडियंस बन गई है। Meta इसमें लोग जोड़ रहा है।",
  "card.create_customer_audience.title": "{count} कॉन्टैक्ट Meta के साथ शेयर करें?",
  "card.create_customer_audience.confirm": "{count} कॉन्टैक्ट शेयर करें",
  "card.create_customer_audience.done": "लिस्ट बन गई है। कॉन्टैक्ट Meta को भेजे जा रहे हैं।",
  "card.refresh_customer_audience.title": "'{name}' को {count} कॉन्टैक्ट के साथ अपडेट करें?",
  "card.refresh_customer_audience.confirm": "लिस्ट अपडेट करें",
  "card.refresh_customer_audience.done": "Meta पर लिस्ट अपडेट की जा रही है।",
  "card.delete_audience.title": "'{name}' ऑडियंस डिलीट करें?",
  "card.delete_audience.confirm": "ऑडियंस डिलीट करें",
  "card.delete_audience.done": "ऑडियंस डिलीट कर दी गई।",
  "fact.promote.page": "पेज",
  "fact.promote.form": "फ़ॉर्म",
  "fact.promote.questions": "सवाल",
  "fact.promote.privacy": "प्राइवेसी लिंक",
  "fact.promote.thank_you": "धन्यवाद बटन",
  "fact.promote.consent": "सहमति बॉक्स",
  "fact.promote.audience": "ऑडियंस",
  "fact.promote.kind": "प्रकार",
  "fact.promote.source": "लोग कहाँ जुड़े",
  "fact.promote.days": "दिन",
  "fact.promote.seed": "किस पर आधारित",
  "fact.promote.percent": "कितनी मिलती-जुलती",
  "fact.promote.count": "कॉन्टैक्ट",
  "fact.promote.sample": "उदाहरण",
  "fact.promote.hashing": "कैसे शेयर होंगे",
  "fact.promote.basis": "कौन शामिल है",
  "fact.promote.file": "फ़ाइल",
  "fact.promote.note": "ध्यान दें",
  "fact.promote.campaign": "विज्ञापन",
  "fact.promote.end_now": "अभी खत्म होने की तारीख",
  "fact.promote.end_new": "नई तारीख",
  "fact.promote.by_month": "हर महीने का सबसे ज़्यादा खर्च",
  "fact.promote.keep": "रखें",
  "fact.promote.pause": "रोकें",
  "fact.promote.verdict": "अब तक का नतीजा",
  "fact.promote.website": "वेबसाइट",
  "fact.promote.version": "वर्ज़न",
  "fact.promote.primary_text": "टेक्स्ट",
  "fact.promote.headline": "हेडलाइन",
  "fact.promote.description": "विवरण",
  "fact.promote.link": "लिंक",
  "fact.promote.button": "बटन",
  "fact.promote.first_message": "पहला मैसेज",
  "fact.promote.quick_question": "छोटा सवाल",
  "fact.promote.caption": "पोस्ट का कैप्शन",
  "fact.promote.about": "लगभग",
  "fact.promote.left": "बाकी",
  "fact.promote.adds": "ज़्यादा दिनों का सबसे ज़्यादा खर्च",
  "eddy_promote.new_tab": "नए टैब में खुलता है",
  "eddy_promote.ig_identity_note": "यह सिर्फ़ विज्ञापन चला सकती है। इससे पोस्ट या लॉग इन नहीं किया जा सकता।",
  "eddy_promote.form_cant_change": "बनने के बाद Meta फ़ॉर्म को बदलने या डिलीट करने नहीं देता।",
  "eddy_promote.test_lead_note": "यह लीड्स में टेस्ट के रूप में दिखेगी। कोई WhatsApp मैसेज नहीं भेजा जाता।",
  "eddy_promote.media_note": "Meta को वीडियो तैयार करने में लगभग 5 से 30 मिनट लगते हैं। विज्ञापन शुरू होने तक यह किसी को नहीं दिखता।",
  "eddy_promote.pixel_note": "वेबसाइट पर कोड जोड़ने के बाद यह विज़िट और बिक्री गिनता है। इससे कोई खर्च नहीं होता।",
  "eddy_promote.basis": "सिर्फ़ वे कॉन्टैक्ट जिन्होंने मार्केटिंग मैसेज के लिए हाँ कहा है और बाद में मना नहीं किया।",
  "eddy_promote.audience_delete_note": "Meta इसे वापस नहीं ला सकता। इसे इस्तेमाल करने वाले विज्ञापन इन लोगों तक पहुँचना बंद कर देंगे।",
  "eddy_promote.saved_paused_note": "Meta पर सब कुछ रुके हुए रूप में बनता है। शुरू करने तक कोई खर्च नहीं होता।",
  "eddy_promote.end_earlier_note": "तारीख पहले करने के लिए किसी सीमा की जाँच नहीं होती।",
  "eddy_promote.pause_note": "रोकने से कोई खर्च नहीं होता। किसी वर्ज़न को फिर से चालू करना अलग कार्ड है।",
  "eddy_promote.audience_note": "Meta कुछ घंटों में ऑडियंस भरता है। जब तक कोई विज्ञापन इसका इस्तेमाल न करे, कोई खर्च नहीं होता।",
  "goto.promotion": "विज्ञापन का ड्राफ़्ट खोलें",
};
const promoteToolsHinglish: Record<PromoteToolKey, string> = {
  "status.list_boostable_posts": "Aapki posts dekhi ja rahi hain…",
  "status.check_promotion_setup": "Ads ke liye zaroori cheezein check ki ja rahi hain…",
  "status.get_creative_specs": "Ad ke size aur text ki limit dekhi ja rahi hai…",
  "status.list_ad_media": "Ad ki photos aur videos dekhe ja rahe hain…",
  "status.preview_ad": "Ad ke previews banaye ja rahe hain…",
  "status.get_promotion": "Ad ka draft khola ja raha hai…",
  "status.review_promotion": "Start se pehle ad check kiya ja raha hai…",
  "status.get_promotion_results": "Ads ke results dekhe ja rahe hain…",
  "status.get_version_comparison": "Versions compare kiye ja rahe hain…",
  "status.explain_ad_rejection": "Meta ka review dekha ja raha hai…",
  "status.get_promote_settings": "Ad settings dekhi ja rahi hain…",
  "status.create_promotion_draft": "Ad ka draft save kiya ja raha hai…",
  "status.update_promotion_draft": "Ad ka draft badla ja raha hai…",
  "status.discard_promotion_draft": "Ad ka draft hataya ja raha hai…",
  "status.duplicate_campaign": "Ads ki copy banayi ja rahi hai…",
  "status.set_promote_settings": "Ad settings save ki ja rahi hain…",
  "status.save_promotion_paused": "Ads save karne ki taiyaari ho rahi hai…",
  "status.start_promotion": "Ads taiyaar kiye ja rahe hain…",
  "status.change_end_date": "End date badli ja rahi hai…",
  "status.pick_winning_version": "Jeetne wala version rakhne ki taiyaari ho rahi hai…",
  "status.create_instagram_identity": "Instagram identity ki taiyaari ho rahi hai…",
  "status.prepare_ad_media": "File Meta ke liye taiyaar ki ja rahi hai…",
  "status.get_ad_media": "File dekhi ja rahi hai…",
  "status.create_pixel": "Pixel ki taiyaari ho rahi hai…",
  "status.list_lead_forms": "Aapke lead forms dekhe ja rahe hain…",
  "status.import_lead_form": "Form Edwyz mein joda ja raha hai…",
  "status.create_lead_form": "Form ki taiyaari ho rahi hai…",
  "status.copy_lead_form": "Form ki copy ki taiyaari ho rahi hai…",
  "status.send_test_lead": "Test lead ki taiyaari ho rahi hai…",
  "status.hide_lead_form": "Form chhupaya ja raha hai…",
  "status.list_audiences": "Aapki audiences dekhi ja rahi hain…",
  "status.get_audience": "Audience kholi ja rahi hai…",
  "status.get_audience_size": "Kitne log hain, yeh dekha ja raha hai…",
  "status.search_places": "Jagahein dhoondhi ja rahi hain…",
  "status.search_interests": "Interests dhoondhe ja rahe hain…",
  "status.save_audience": "Audience save ki ja rahi hai…",
  "status.create_audience": "Audience ki taiyaari ho rahi hai…",
  "status.create_lookalike": "Lookalike audience ki taiyaari ho rahi hai…",
  "status.create_customer_audience": "Contacts gine ja rahe hain…",
  "status.refresh_customer_audience": "Contacts gine ja rahe hain…",
  "status.delete_audience": "Audience delete karne ki taiyaari ho rahi hai…",
  "done.create_promotion_draft": "Ad ka draft save ho gaya. Meta ko kuch nahi bheja gaya.",
  "done.update_promotion_draft": "Ad ka draft badal diya gaya.",
  "done.discard_promotion_draft": "Ad ka draft hata diya gaya. 15 minute tak ise wapas laaya ja sakta hai.",
  "done.duplicate_campaign": "Copy draft ke roop mein save ho gayi. Meta ko kuch nahi bheja gaya.",
  "done.set_promote_settings": "Ad settings save ho gayi.",
  "done.import_lead_form": "Form Edwyz mein jud gaya. Meta par kuch nahi badla.",
  "done.hide_lead_form": "Form Edwyz mein chhupa diya gaya. Yeh aapke Page par bana rahega.",
  "done.save_audience": "Audience Edwyz mein save ho gayi.",
  "done.change_end_date": "End date pehle kar di gayi.",
  "card.save_promotion_paused.title": "In ads ko start kiye bina Meta par save karein?",
  "card.save_promotion_paused.confirm": "Start kiye bina save kariye",
  "card.save_promotion_paused.done": "Meta par paused save ho gaya. Start karne tak koi kharcha nahi hoga.",
  "card.start_promotion.title": "Yeh ads start karein?",
  "card.start_promotion.confirm": "Ads start kariye · zyada se zyada {amount}",
  "card.start_promotion.done": "Meta ko bhej diya gaya. Meta iska review kar raha hai.",
  "card.change_end_date.title": "'{campaign}' ko {date} tak chalayein?",
  "card.change_end_date.confirm": "Zyada din chalaiye",
  "card.change_end_date.done": "End date badal di gayi.",
  "card.pick_winning_version.title": "Version {version} rakhein aur baaki rokein?",
  "card.pick_winning_version.confirm": "{version} rakhiye",
  "card.pick_winning_version.done": "Jeetne wala version rakh liya gaya. Baaki versions rok diye gaye.",
  "card.create_instagram_identity.title": "{page} se ads ke liye Instagram identity banayein?",
  "card.create_instagram_identity.confirm": "Identity banaiye",
  "card.create_instagram_identity.done": "Ads ke liye Instagram identity taiyaar hai.",
  "card.prepare_ad_media.title": "Yeh video Meta par aapke ad account mein bhejein?",
  "card.prepare_ad_media.title_image": "Yeh photo Meta par aapke ad account mein bhejein?",
  "card.prepare_ad_media.confirm": "Meta ko bhejiye",
  "card.prepare_ad_media.done": "Bhej diya gaya. Meta ise taiyaar kar raha hai.",
  "card.create_pixel.title": "{website} ke liye Meta pixel banayein?",
  "card.create_pixel.confirm": "Pixel banaiye",
  "card.create_pixel.done": "Pixel taiyaar hai. Iska code apni website mein jodiye.",
  "card.create_lead_form.title": "{page} par '{name}' form banayein?",
  "card.create_lead_form.confirm": "Form banaiye",
  "card.create_lead_form.done": "Aapke Page par form ban gaya.",
  "card.copy_lead_form.title": "'{form}' form ki copy banayein?",
  "card.copy_lead_form.confirm": "Copy banaiye",
  "card.copy_lead_form.done": "Aapke Page par copy ban gayi.",
  "card.send_test_lead.title": "'{form}' par test lead bhejein?",
  "card.send_test_lead.confirm": "Test lead bhejiye",
  "card.send_test_lead.done": "Test lead bhej di gayi. Yeh Leads mein Test ke roop mein dikhegi.",
  "card.create_audience.title": "Meta par '{name}' audience banayein?",
  "card.create_audience.confirm": "Audience banaiye",
  "card.create_audience.done": "Audience ban gayi. Meta ismein log jod raha hai.",
  "card.create_lookalike.title": "'{seed}' jaisi {percent}% lookalike audience banayein?",
  "card.create_lookalike.confirm": "Lookalike banaiye",
  "card.create_lookalike.done": "Lookalike ban gayi. Meta ismein log jod raha hai.",
  "card.create_customer_audience.title": "{count} contacts Meta ke saath share karein?",
  "card.create_customer_audience.confirm": "{count} contacts share kariye",
  "card.create_customer_audience.done": "List ban gayi. Contacts Meta ko bheje ja rahe hain.",
  "card.refresh_customer_audience.title": "'{name}' ko {count} contacts ke saath update karein?",
  "card.refresh_customer_audience.confirm": "List update kariye",
  "card.refresh_customer_audience.done": "Meta par list update ho rahi hai.",
  "card.delete_audience.title": "'{name}' audience delete karein?",
  "card.delete_audience.confirm": "Audience delete kariye",
  "card.delete_audience.done": "Audience delete ho gayi.",
  "fact.promote.page": "Page",
  "fact.promote.form": "Form",
  "fact.promote.questions": "Sawaal",
  "fact.promote.privacy": "Privacy link",
  "fact.promote.thank_you": "Thank-you button",
  "fact.promote.consent": "Consent box",
  "fact.promote.audience": "Audience",
  "fact.promote.kind": "Kis tarah ki",
  "fact.promote.source": "Log kahan jude",
  "fact.promote.days": "Din",
  "fact.promote.seed": "Kis par based",
  "fact.promote.percent": "Kitni milti-julti",
  "fact.promote.count": "Contacts",
  "fact.promote.sample": "Udaharan",
  "fact.promote.hashing": "Kaise share honge",
  "fact.promote.basis": "Kaun shaamil hai",
  "fact.promote.file": "File",
  "fact.promote.note": "Dhyan dein",
  "fact.promote.campaign": "Ads",
  "fact.promote.end_now": "Abhi ki end date",
  "fact.promote.end_new": "Nayi end date",
  "fact.promote.by_month": "Har mahine ka sabse zyada kharcha",
  "fact.promote.keep": "Rakhein",
  "fact.promote.pause": "Rokein",
  "fact.promote.verdict": "Ab tak ka result",
  "fact.promote.website": "Website",
  "fact.promote.version": "Version",
  "fact.promote.primary_text": "Text",
  "fact.promote.headline": "Headline",
  "fact.promote.description": "Description",
  "fact.promote.link": "Link",
  "fact.promote.button": "Button",
  "fact.promote.first_message": "Pehla message",
  "fact.promote.quick_question": "Chhota sawaal",
  "fact.promote.caption": "Post ka caption",
  "fact.promote.about": "Lagbhag",
  "fact.promote.left": "Baaki",
  "fact.promote.adds": "Zyada dinon ka sabse zyada kharcha",
  "eddy_promote.new_tab": "naye tab mein khulta hai",
  "eddy_promote.ig_identity_note": "Yeh sirf ads chala sakti hai. Isse post ya login nahi kiya ja sakta.",
  "eddy_promote.form_cant_change": "Banne ke baad Meta form ko badalne ya delete karne nahi deta.",
  "eddy_promote.test_lead_note": "Yeh Leads mein Test ke roop mein dikhegi. Koi WhatsApp message nahi bheja jaata.",
  "eddy_promote.media_note": "Meta ko video taiyaar karne mein lagbhag 5 se 30 minute lagte hain. Ad start hone tak yeh kisi ko nahi dikhta.",
  "eddy_promote.pixel_note": "Website par code jodne ke baad yeh visits aur sales ginta hai. Isse koi kharcha nahi hota.",
  "eddy_promote.basis": "Sirf woh contacts jinhone marketing messages ke liye haan kaha hai aur baad mein mana nahi kiya.",
  "eddy_promote.audience_delete_note": "Meta ise wapas nahi la sakta. Ise use karne wale ads in logon tak pahunchna band kar denge.",
  "eddy_promote.saved_paused_note": "Meta par sab kuch paused banta hai. Start karne tak koi kharcha nahi hota.",
  "eddy_promote.end_earlier_note": "Date pehle karne ke liye kisi limit ki jaanch nahi hoti.",
  "eddy_promote.pause_note": "Rokne se koi kharcha nahi hota. Kisi version ko phir se chalu karna alag card hai.",
  "eddy_promote.audience_note": "Meta kuch ghanton mein audience bharta hai. Jab tak koi ad ise use na kare, koi kharcha nahi hota.",
  "goto.promotion": "Ad ka draft kholiye",
};

/** The labels of Eddy's promotion, lead-form and audience tools (6.4, 6.5) in all three languages. */
export const PROMOTE_TOOLS_CATALOGUE: Catalogue<PromoteToolKey> = defineCatalogue<PromoteToolKey>({ en: promoteToolsEn, hi: promoteToolsHi, hinglish: promoteToolsHinglish });

registerCatalogue(PROMOTE_CATALOGUE);
registerCatalogue(PROMOTE_TOOLS_CATALOGUE as Catalogue<string>);
