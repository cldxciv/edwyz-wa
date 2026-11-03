/**
 * Instant-form presets by industry (docs/IG-PAGE-ADS-SPEC.md 3.5 step 2, 5.4 LeadForm.spec, D35, PRM-10).
 *
 * Every preset starts with Full name and Phone, which Meta pre-fills from the person's profile, offers Email as an optional
 * question, and adds at most 3 qualifying questions of the industry. A form has at most 15 questions in all. The WhatsApp
 * consent box (key whatsapp_opt_in) is added by promote/lead-forms.validateSpec: optional and never ticked in advance.
 *
 * Meta's WHATSAPP_NUMBER question type is VERIFY V-P7, so the presets ask for PHONE unless the caller asks for the WhatsApp
 * number type on purpose (`whatsappNumber: true`).
 *
 * Pure: data and copy only. No database, no network.
 */
import { MAX_FORM_QUESTIONS, MAX_QUALIFYING_QUESTIONS, type LeadQuestionType } from "./catalog/lead-questions";
import { promoteText, type PromoteCopyKey } from "./copy";
import type { FormType, PromoteLang } from "./types";

export const FORM_PRESET_KEYS = ["generic", "salon", "coaching"] as const;
export type FormPresetKey = (typeof FORM_PRESET_KEYS)[number];
export const isFormPresetKey = (v: unknown): v is FormPresetKey => typeof v === "string" && (FORM_PRESET_KEYS as readonly string[]).includes(v);

/** A question as a form spec holds it (5.4): Meta's type, and for the owner's own questions a key, a label and answers. */
export type PresetQuestion = { type: LeadQuestionType; key?: string; label?: string; options?: { key: string; value: string }[] };

/** One qualifying question of a preset: its key, its copy, and the answers to choose from (none: a free-text answer). */
type Qualifying = { key: string; labelKey: PromoteCopyKey; options?: "weekdays" };

type PresetDef = {
  /** Asked by default (at most 3). */
  questions: readonly Qualifying[];
  /** Offered as chips the owner can add, within the limit of 3. */
  suggestions: readonly Qualifying[];
};

const WHICH_SERVICE: Qualifying = { key: "which_service", labelKey: "form.preset.which_service" };
const PREFERRED_DAY: Qualifying = { key: "preferred_day", labelKey: "form.preset.preferred_day", options: "weekdays" };
const WHICH_CLASS: Qualifying = { key: "which_class", labelKey: "form.preset.which_class" };
const BUDGET: Qualifying = { key: "budget", labelKey: "form.preset.budget" };
const WHEN_START: Qualifying = { key: "when_start", labelKey: "form.preset.when_start" };

/** The industry presets of 3.5. */
export const FORM_PRESETS: Readonly<Record<FormPresetKey, PresetDef>> = Object.freeze({
  generic: { questions: [], suggestions: [WHEN_START, BUDGET] },
  salon: { questions: [WHICH_SERVICE, PREFERRED_DAY], suggestions: [] },
  coaching: { questions: [WHICH_CLASS], suggestions: [PREFERRED_DAY, WHEN_START] },
});

/** Monday first, as people in India read a week. The copy has short names (Mon ... Sun). */
const WEEK: readonly { key: string; copy: PromoteCopyKey }[] = [
  { key: "mon", copy: "weekday.1" },
  { key: "tue", copy: "weekday.2" },
  { key: "wed", copy: "weekday.3" },
  { key: "thu", copy: "weekday.4" },
  { key: "fri", copy: "weekday.5" },
  { key: "sat", copy: "weekday.6" },
  { key: "sun", copy: "weekday.0" },
];

function qualifyingQuestion(q: Qualifying, lang: PromoteLang): PresetQuestion {
  return {
    type: "CUSTOM",
    key: q.key,
    label: promoteText(q.labelKey, {}, lang),
    ...(q.options === "weekdays" ? { options: WEEK.map((d) => ({ key: d.key, value: promoteText(d.copy, {}, lang) })) } : {}),
  };
}

export type PresetOptions = {
  /** Add the optional Email question. */
  email?: boolean;
  /** Ask for the WhatsApp number with Meta's WHATSAPP_NUMBER type instead of PHONE (VERIFY V-P7). */
  whatsappNumber?: boolean;
  /** The language of the question labels (the form's own locale is set apart). */
  lang?: PromoteLang;
};

/** The questions of a preset, in order: Full name, Phone (or WhatsApp number), Email when asked, then the qualifying ones. */
export function presetQuestions(key: FormPresetKey, opts: PresetOptions = {}): PresetQuestion[] {
  const lang = opts.lang ?? "en";
  const preset = FORM_PRESETS[key];
  const out: PresetQuestion[] = [{ type: "FULL_NAME" }, { type: opts.whatsappNumber ? "WHATSAPP_NUMBER" : "PHONE" }];
  if (opts.email) out.push({ type: "EMAIL" });
  for (const q of preset.questions.slice(0, MAX_QUALIFYING_QUESTIONS)) out.push(qualifyingQuestion(q, lang));
  return out.slice(0, MAX_FORM_QUESTIONS);
}

/** The suggestion chips of a preset, as questions ready to add. */
export function presetSuggestions(key: FormPresetKey, lang: PromoteLang = "en"): PresetQuestion[] {
  return FORM_PRESETS[key].suggestions.map((q) => qualifyingQuestion(q, lang));
}

export type PresetSpecInput = PresetOptions & {
  name?: string;
  privacyUrl?: string | null;
  formType?: FormType;
  locale?: string;
};

/**
 * A form spec from a preset, for promote/lead-forms.validateSpec. The thank-you screen and the consent box are left to its
 * defaults (a wa.me button to the workspace number, and the optional WhatsApp box), so every preset validates with a privacy link.
 */
export function presetSpec(key: FormPresetKey, input: PresetSpecInput = {}) {
  return {
    ...(input.name ? { name: input.name } : {}),
    questions: presetQuestions(key, input),
    privacyUrl: input.privacyUrl ?? null,
    formType: input.formType ?? ("more_volume" as FormType),
    locale: input.locale ?? "en_US",
  };
}
