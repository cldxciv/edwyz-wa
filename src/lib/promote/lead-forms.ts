/**
 * Instant forms built in Edwyz (docs/IG-PAGE-ADS-SPEC.md 3.5 step 2, D13, D33, D35, 4.2 L1 to L4, 4.8, 5.4, 6.4, 6.5,
 * 11.1a decision 2, PRM-10). Meta's App Review needs an owner to be able to create an Instant Form inside Edwyz.
 *
 * - validateSpec checks a form in plain words: 1 to 15 questions with at most 3 of the owner's own and a way to reach the
 *   person; the business's own https privacy link (Edwyz never hosts one); a thank-you button (a wa.me link to the workspace's
 *   WhatsApp number by default, or Call, or Website); the WhatsApp consent box `whatsapp_opt_in`, included by default, optional
 *   and never ticked in advance (D35: the builder refuses to make it required); the form type and the language.
 * - buildForm reads C2 (Lead Gen terms) first and refuses with the `leadgen_tos` Opens Meta fix before any POST, makes the form
 *   on the Page (L2, the Page token, through promote/meta.ts) and registers it with leads/service.createForm as origin
 *   `created`, with the spec and the consent box's words as its consentText (what a lead who ticks it agreed to).
 *   consentAssumed is never set for it.
 * - copyForm: Meta can't change a live form, so editing makes a new form (copiedFromId). A copy of a draft's form keeps the
 *   draft's name suffix. Nothing is archived through the API; hideForm and unhideForm only set and clear LeadForm.hiddenAt (D13).
 * - importForm registers a form already on the Page (L1 and L3) as origin `imported`, with its name, status and questions.
 *   POST /api/leads/forms calls it through importFromRegisterRoute while Promote is open to the caller (E-R7).
 * - sendTestLead (L4): the name and free-text answers read "Edwyz test lead {code}", email and phone get dummy values Meta
 *   accepts, and the lead id Meta answers with is stored for the Page (test-leads.ts, D33). testLeadUntil only shows "Test sent".
 *   At most 10 an hour per form. Refused (409) until lead ingest marks test leads (TEST_LEADS_MARKED_ON_INGEST).
 * - ensureDraftForm (for PRM-09's Start): one form per draft. The draft's current form (the one its ad uses, else the newest,
 *   then its newest copy) is reused, and an ambiguous POST is settled by listing the Page's forms (L1) for the draft's exact
 *   name before anything else runs. The form's name is not part of the comparison, so a default dated name never reads as an
 *   edit.
 *
 * Under SPEND_DRY_RUN nothing reaches Meta: no read, and writes answer with fake ids (promote/meta.ts). Every Meta answer that
 * is not a success becomes plain copy; an answer that may already have reached Meta is never repeated automatically.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { audit } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { GraphError } from "@/lib/graph";
import { consentKind } from "@/lib/leads/fields";
import { fetchFormDefinitionKeys, type FormDefinitionKeys } from "@/lib/leads/form-definition";
import { emptyQuestionInfo, getFormQuestionInfoMany, recordFormDefinition } from "@/lib/leads/form-settings";
import { checkFormPatch, createForm, CREATED_FORM_CONSENT, getForm, listForms, updateForm } from "@/lib/leads/service";
import { createLimiter } from "@/lib/ratelimit";
import { spendDryRun } from "@/lib/spend/flags";
import { HttpError, type Actor } from "@/lib/tenancy";
import { CONSENT_CHECKBOX, LEAD_QUESTION_TYPES, LEAD_QUESTIONS, MAX_FORM_QUESTIONS, MAX_QUALIFYING_QUESTIONS, PRIVACY_LINK_TEXT_MAX, type LeadQuestionType } from "./catalog/lead-questions";
import { promoteText } from "./copy";
import { promoteMeta, PROMOTE_META_MESSAGES, PromoteMetaError, type LeadFormSpec as MetaLeadFormSpec, type LeadFormSummary, type PromoteMeta } from "./meta";
import { classifyMetaError, metaErrorText } from "./review-reasons";
import { accessFor, isDryRun } from "./route-guard";
import { getPromoteSettings, normalizePrivacyUrl, privacyUrlProblem } from "./settings";
import { rememberTestLead, TEST_LEAD_PHONE, TEST_LEAD_PREFIX, TEST_LEADS_MARKED_ON_INGEST, testLeadEmail } from "./test-leads";
import { FORM_TYPES, type FormType, type PromoteLang } from "./types";

// =====================================================================================================================
// Limits and copy
// =====================================================================================================================

export const FORM_NAME_MAX = 100;
/** LeadForm.name holds at most this many characters (leads/service.updateForm). */
const LOCAL_NAME_MAX = 120;
export const CUSTOM_LABEL_MAX = 300;
export const OPTION_TEXT_MAX = 100;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 20;
export const THANK_YOU_TITLE_MAX = 60;
export const THANK_YOU_BODY_MAX = 500;
export const BUTTON_TEXT_MAX = 30;
export const DISCLAIMER_TITLE_MAX = 60;
export const DISCLAIMER_BODY_MAX = 1_000;
export const CHECKBOX_TEXT_MAX = 300;
export const MAX_CHECKBOXES = 5;
export const INTRO_TITLE_MAX = 60;
export const INTRO_LINE_MAX = 200;
export const MAX_INTRO_LINES = 5;
/** Test leads per form per hour (4.8). */
export const TEST_LEADS_PER_HOUR = 10;
/** How long a form shows "Test sent" after a test lead (D33: only a label). */
export const TEST_SENT_MS = 10 * 60_000;
const HOUR_MS = 60 * 60_000;

export const THANK_YOU_KINDS = ["whatsapp", "call", "website"] as const;
export type ThankYouKind = (typeof THANK_YOU_KINDS)[number];

/** The languages Meta offers for instant forms (Marketing API leadgen_forms `locale`; VERIFY V-P7). */
export const FORM_LOCALES = [
  "en_US", "en_GB", "hi_IN", "ar_AR", "cs_CZ", "da_DK", "de_DE", "el_GR", "es_ES", "es_LA", "fi_FI", "fr_FR", "he_IL", "hu_HU", "id_ID", "it_IT",
  "ja_JP", "ko_KR", "nb_NO", "nl_NL", "pl_PL", "pt_BR", "pt_PT", "ro_RO", "ru_RU", "sv_SE", "th_TH", "tr_TR", "vi_VN", "zh_CN", "zh_HK", "zh_TW",
] as const;
export type FormLocale = (typeof FORM_LOCALES)[number];

export const LEAD_FORM_COPY = {
  spec: "Send the form's questions, privacy link and thank-you button.",
  name: `Give the form a name of up to ${FORM_NAME_MAX} characters.`,
  noQuestions: "Add at least one question.",
  maxQuestions: promoteText("form.max_questions"),
  maxQualifying: promoteText("form.max_qualifying"),
  needsContact: promoteText("form.needs_contact"),
  questionType: "Choose a type for each question.",
  duplicate: "Each question can be asked only once. Remove the repeated one.",
  customLabel: `Write each of your own questions, up to ${CUSTOM_LABEL_MAX} characters.`,
  customKey: "A question's key can use small letters, numbers and _ only, and must start with a letter.",
  duplicateKey: "Two of your questions have the same key. Give each its own key.",
  options: `A multiple-choice question needs ${MIN_OPTIONS} to ${MAX_OPTIONS} answers, each up to ${OPTION_TEXT_MAX} characters.`,
  linkText: `The privacy link text can be up to ${PRIVACY_LINK_TEXT_MAX} characters.`,
  thankYouKind: "Choose what the thank-you button does: Chat on WhatsApp, Call or Visit website.",
  waLink: "Use a wa.me link to your WhatsApp number, like https://wa.me/919876543210.",
  noWhatsapp: "Connect your WhatsApp number first, or choose Call or Visit website for the thank-you button.",
  phone: "Add the phone number people should call, with the country code, like +91 98765 43210.",
  website: "Add your website link. It must start with https://",
  thankYouText: `Keep the thank-you title to ${THANK_YOU_TITLE_MAX} characters and its message to ${THANK_YOU_BODY_MAX}.`,
  buttonText: `The button text can be up to ${BUTTON_TEXT_MAX} characters.`,
  consentRequired: promoteText("form.consent_cant_require"),
  precheck: "Boxes can't be ticked in advance. People tick them themselves.",
  checkbox: `Each box needs text of up to ${CHECKBOX_TEXT_MAX} characters and a key of small letters, numbers and _.`,
  maxCheckboxes: `A form can have up to ${MAX_CHECKBOXES} boxes.`,
  disclaimerText: `Keep the consent title to ${DISCLAIMER_TITLE_MAX} characters and its text to ${DISCLAIMER_BODY_MAX.toLocaleString("en-IN")}.`,
  formType: "Choose More people or Fewer, more serious people.",
  locale: "Choose a language Meta offers for forms.",
  intro: `Keep the intro title to ${INTRO_TITLE_MAX} characters and the intro to ${MAX_INTRO_LINES} lines of up to ${INTRO_LINE_MAX} characters.`,
  pageId: "Choose one of your connected Facebook Pages.",
  pageNotFound: "Page not found.",
  pageGone: "This form's Facebook Page isn't connected any more. Reconnect it in Settings, then try again.",
  formNotFound: "Form not found.",
  formId: "Choose a valid lead form.",
  notOnPage: "That form isn't on this Page. Choose one of the Page's forms.",
  draftNotFound: "Draft not found.",
  testLimit: `You can send ${TEST_LEADS_PER_HOUR} test leads an hour to this form. Try again later.`,
  testLeadsNotReady: "Test leads aren't available yet.",
  reconnect: "Your Facebook connection needs a refresh. Reconnect Facebook in Settings, then try again.",
  noPermission: "Meta didn't let Edwyz do this on the Page. Reconnect Facebook and allow lead forms for this Page.",
  metaRefused: "Meta didn't accept this. Check the form and try again.",
  ambiguous: PROMOTE_META_MESSAGES.timeout_ambiguous,
  copyNeedsSpec: "Send the edited form to make a copy.",
} as const;

// =====================================================================================================================
// The form spec (5.4 LeadForm.spec)
// =====================================================================================================================

export type FormQuestion = { type: LeadQuestionType; key?: string; label?: string; options?: { key: string; value: string }[] };
export type FormThankYou = { kind: ThankYouKind; title: string; body: string; buttonText: string; url: string | null; phone: string | null };
export type FormCheckbox = { key: string; text: string; required: boolean };
export type FormDisclaimer = { title: string; body: string; checkboxes: FormCheckbox[] };
export type FormIntro = { title: string | null; lines: string[] };
/** What is stored in LeadForm.spec and sent to Meta (L2). No personal data. */
export type FormSpec = {
  name: string;
  questions: FormQuestion[];
  privacyUrl: string;
  privacyLinkText: string;
  intro: FormIntro | null;
  thankYou: FormThankYou;
  disclaimer: FormDisclaimer | null;
  formType: FormType;
  locale: FormLocale;
};
export type FormProblem = { field: string; message: string };
export type SpecResult = { spec: FormSpec; problems: [] } | { spec: null; problems: FormProblem[] };

/** What validateSpec fills in when the spec leaves it out. */
export type SpecContext = {
  /** The workspace's WhatsApp number, for the default wa.me thank-you button (and Call). */
  whatsappNumber?: string | null;
  /** The name in the consent box: "I agree to get WhatsApp messages from {business}". */
  businessName?: string | null;
  /** Promote settings' privacy link, used when the spec has none. */
  privacyUrl?: string | null;
  now?: Date;
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isQuestionType = (v: unknown): v is LeadQuestionType => typeof v === "string" && (LEAD_QUESTION_TYPES as readonly string[]).includes(v);
const isFormLocale = (v: unknown): v is FormLocale => typeof v === "string" && (FORM_LOCALES as readonly string[]).includes(v);
const CONTACT_TYPES = new Set<string>(LEAD_QUESTIONS.filter((r) => r.contact).map((r) => r.type));
const KEY = /^[a-z][a-z0-9_]{0,59}$/;
const OPTION_KEY = /^[a-z0-9][a-z0-9_]{0,59}$/;
const WA_LINK = /^https:\/\/wa\.me\/[1-9][0-9]{6,14}(\?text=[^\s#]{0,500})?$/;
const E164 = /^\+[1-9][0-9]{7,14}$/;

/** Optional text: undefined when left out or empty, null when it is too long or not text (a problem). */
function optText(v: unknown, max: number): string | undefined | null {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") return null;
  const t = v.trim().replace(/[ \t]+/g, " ");
  if (!t) return undefined;
  return t.length > max ? null : t;
}

/** A key from a label: small letters, digits and _, starting with a letter; empty when nothing Latin is left. */
function slug(label: string): string {
  const s = label.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 50);
  return s && /^[a-z]/.test(s) ? s : s ? `q_${s}`.slice(0, 50) : "";
}

const digitsOf = (phone: string | null | undefined): string => (phone ?? "").replace(/[^0-9]/g, "");
const langOf = (locale: FormLocale): PromoteLang => (locale === "hi_IN" ? "hi" : "en");

function defaultName(now: Date): string {
  return `${promoteText("form.title")} ${now.toISOString().slice(0, 10)}`;
}

const THANK_YOU_DEFAULTS: Record<ThankYouKind, { body: string; button: string }> = {
  whatsapp: { body: "We'll reply soon. You can also chat with us on WhatsApp now.", button: promoteText("form.thank_you.whatsapp") },
  call: { body: "We'll get back to you soon. You can also call us now.", button: promoteText("form.thank_you.call") },
  website: { body: "We'll get back to you soon. You can also visit our website.", button: promoteText("form.thank_you.website") },
};
const THANK_YOU_TITLE = "Thanks! We've got your details.";
const DISCLAIMER_TITLE = "WhatsApp messages";

/** The consent box every built form carries by default (D35): optional, never ticked in advance. */
export function consentCheckbox(businessName: string | null | undefined, lang: PromoteLang = "en"): FormCheckbox {
  return { key: CONSENT_CHECKBOX.key, text: promoteText("form.consent_text", { business: businessName?.trim() || "us" }, lang), required: false };
}

function defaultDisclaimer(businessName: string | null | undefined, lang: PromoteLang): FormDisclaimer {
  const business = businessName?.trim() || "us";
  return {
    title: DISCLAIMER_TITLE,
    body: `Tick the box if you'd like messages from ${business} on WhatsApp. You can reply STOP at any time to stop them.`,
    checkboxes: [consentCheckbox(businessName, lang)],
  };
}

/** A box that asks to message the person: the WhatsApp box by its key, or any box whose key or text reads as consent. */
const isConsentBox = (key: string, text: string) => key === CONSENT_CHECKBOX.key || consentKind(key, text) === "consent";

function parseQuestions(raw: unknown, add: (field: string, message: string) => void): FormQuestion[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    add("questions", LEAD_FORM_COPY.noQuestions);
    return [];
  }
  if (raw.length > MAX_FORM_QUESTIONS) add("questions", LEAD_FORM_COPY.maxQuestions);
  const out: FormQuestion[] = [];
  const types = new Set<string>();
  const keys = new Set<string>();
  // Past the limit nothing more is read: the count is already refused.
  raw.slice(0, MAX_FORM_QUESTIONS + 1).forEach((q, i) => {
    const field = `questions.${i}`;
    if (!isObject(q) || !isQuestionType(q.type)) return add(field, LEAD_FORM_COPY.questionType);
    if (q.type !== "CUSTOM") {
      if (types.has(q.type)) add(field, LEAD_FORM_COPY.duplicate);
      types.add(q.type);
      const label = optText(q.label, CUSTOM_LABEL_MAX);
      if (label === null) add(field, LEAD_FORM_COPY.customLabel);
      out.push({ type: q.type, ...(label ? { label } : {}) });
      return;
    }
    const label = optText(q.label, CUSTOM_LABEL_MAX);
    if (!label) return add(field, LEAD_FORM_COPY.customLabel);
    let key: string;
    if (q.key !== undefined && q.key !== null && q.key !== "") {
      if (typeof q.key !== "string" || !KEY.test(q.key)) return add(field, LEAD_FORM_COPY.customKey);
      if (keys.has(q.key)) return add(field, LEAD_FORM_COPY.duplicateKey);
      key = q.key;
    } else {
      const base = slug(label) || `question_${i + 1}`;
      key = base;
      for (let n = 2; keys.has(key); n++) key = `${base}_${n}`;
    }
    keys.add(key);
    let options: { key: string; value: string }[] | undefined;
    if (q.options !== undefined && q.options !== null) {
      if (!Array.isArray(q.options) || q.options.length < MIN_OPTIONS || q.options.length > MAX_OPTIONS) return add(field, LEAD_FORM_COPY.options);
      const optionKeys = new Set<string>();
      options = [];
      for (const [n, o] of (q.options as unknown[]).entries()) {
        const value = isObject(o) ? optText(o.value, OPTION_TEXT_MAX) : optText(o, OPTION_TEXT_MAX);
        if (!value) return add(field, LEAD_FORM_COPY.options);
        const given = isObject(o) && typeof o.key === "string" && o.key ? o.key : null;
        if (given !== null && !OPTION_KEY.test(given)) return add(field, LEAD_FORM_COPY.options);
        let optionKey = given ?? (slug(value) || `option_${n + 1}`);
        for (let m = 2; optionKeys.has(optionKey); m++) optionKey = `${given ?? (slug(value) || `option_${n + 1}`)}_${m}`;
        optionKeys.add(optionKey);
        options.push({ key: optionKey, value });
      }
    }
    out.push({ type: "CUSTOM", key, label, ...(options ? { options } : {}) });
  });
  if (out.filter((q) => q.type === "CUSTOM").length > MAX_QUALIFYING_QUESTIONS) add("questions", LEAD_FORM_COPY.maxQualifying);
  if (out.length > 0 && !out.some((q) => CONTACT_TYPES.has(q.type))) add("questions", LEAD_FORM_COPY.needsContact);
  return out;
}

function parseThankYou(raw: unknown, ctx: SpecContext, add: (field: string, message: string) => void): FormThankYou | null {
  const t = raw === undefined || raw === null ? {} : raw;
  if (!isObject(t)) {
    add("thankYou", LEAD_FORM_COPY.thankYouKind);
    return null;
  }
  const kind = t.kind === undefined || t.kind === null ? "whatsapp" : t.kind;
  if (!(THANK_YOU_KINDS as readonly unknown[]).includes(kind)) {
    add("thankYou.kind", LEAD_FORM_COPY.thankYouKind);
    return null;
  }
  const k = kind as ThankYouKind;
  const title = optText(t.title, THANK_YOU_TITLE_MAX);
  const body = optText(t.body, THANK_YOU_BODY_MAX);
  if (title === null || body === null) add("thankYou", LEAD_FORM_COPY.thankYouText);
  const buttonText = optText(t.buttonText, BUTTON_TEXT_MAX);
  if (buttonText === null) add("thankYou.buttonText", LEAD_FORM_COPY.buttonText);
  let url: string | null = null;
  let phone: string | null = null;
  if (k === "whatsapp") {
    const given = typeof t.url === "string" ? t.url.trim() : "";
    if (given) {
      if (!WA_LINK.test(given)) add("thankYou.url", LEAD_FORM_COPY.waLink);
      else url = given;
    } else {
      const digits = digitsOf(ctx.whatsappNumber);
      if (/^[1-9][0-9]{6,14}$/.test(digits)) url = `https://wa.me/${digits}`;
      else add("thankYou.url", LEAD_FORM_COPY.noWhatsapp);
    }
  } else if (k === "call") {
    const given = typeof t.phone === "string" && t.phone.trim() ? t.phone : ctx.whatsappNumber ? `+${digitsOf(ctx.whatsappNumber)}` : "";
    const normal = given.trim().replace(/[\s()-]/g, "");
    if (!E164.test(normal)) add("thankYou.phone", LEAD_FORM_COPY.phone);
    else phone = normal;
  } else {
    const given = typeof t.url === "string" ? t.url.trim() : "";
    let ok = false;
    try {
      const u = new URL(given);
      ok = u.protocol === "https:" && !u.username && !u.password && /\./.test(u.hostname) && given.length <= 2000;
    } catch {
      ok = false;
    }
    if (!ok) add("thankYou.url", LEAD_FORM_COPY.website);
    else url = new URL(given).toString();
  }
  return { kind: k, title: title || THANK_YOU_TITLE, body: body || THANK_YOU_DEFAULTS[k].body, buttonText: buttonText || THANK_YOU_DEFAULTS[k].button, url, phone };
}

function parseDisclaimer(raw: unknown, ctx: SpecContext, lang: PromoteLang, add: (field: string, message: string) => void): FormDisclaimer | null {
  // Left out: the form carries the WhatsApp box (3.5 "on by default"). null: the owner took the consent section off.
  if (raw === undefined) return defaultDisclaimer(ctx.businessName, lang);
  if (raw === null) return null;
  if (!isObject(raw)) {
    add("disclaimer", LEAD_FORM_COPY.disclaimerText);
    return null;
  }
  const base = defaultDisclaimer(ctx.businessName, lang);
  const title = optText(raw.title, DISCLAIMER_TITLE_MAX);
  const body = optText(raw.body, DISCLAIMER_BODY_MAX);
  if (title === null || body === null) add("disclaimer", LEAD_FORM_COPY.disclaimerText);
  let checkboxes: FormCheckbox[] = base.checkboxes;
  if (raw.checkboxes !== undefined && raw.checkboxes !== null) {
    if (!Array.isArray(raw.checkboxes) || raw.checkboxes.length > MAX_CHECKBOXES) {
      add("disclaimer.checkboxes", LEAD_FORM_COPY.maxCheckboxes);
      return null;
    }
    checkboxes = [];
    const keys = new Set<string>();
    for (const [i, c] of (raw.checkboxes as unknown[]).entries()) {
      const field = `disclaimer.checkboxes.${i}`;
      if (!isObject(c) || typeof c.key !== "string" || !KEY.test(c.key) || keys.has(c.key)) {
        add(field, LEAD_FORM_COPY.checkbox);
        continue;
      }
      keys.add(c.key);
      const given = optText(c.text, CHECKBOX_TEXT_MAX);
      if (given === null) {
        add(field, LEAD_FORM_COPY.checkbox);
        continue;
      }
      const text = given ?? (c.key === CONSENT_CHECKBOX.key ? consentCheckbox(ctx.businessName, lang).text : undefined);
      if (!text) {
        add(field, LEAD_FORM_COPY.checkbox);
        continue;
      }
      const ticked = c.checkedByDefault ?? c.is_checked_by_default;
      if (ticked !== undefined && ticked !== null && ticked !== false) add(field, LEAD_FORM_COPY.precheck);
      const requiredRaw = c.required ?? c.is_required;
      if (requiredRaw !== undefined && requiredRaw !== null && typeof requiredRaw !== "boolean") {
        add(field, LEAD_FORM_COPY.checkbox);
        continue;
      }
      const required = requiredRaw === true;
      // D35: the box that asks to message people stays optional. The builder refuses rather than quietly unticking it.
      if (required && isConsentBox(c.key, text)) add(field, LEAD_FORM_COPY.consentRequired);
      checkboxes.push({ key: c.key, text, required });
    }
  }
  return { title: title || base.title, body: body || base.body, checkboxes };
}

function parseIntro(raw: unknown, add: (field: string, message: string) => void): FormIntro | null {
  if (raw === undefined || raw === null) return null;
  if (!isObject(raw)) {
    add("intro", LEAD_FORM_COPY.intro);
    return null;
  }
  const title = optText(raw.title, INTRO_TITLE_MAX);
  const rawLines = raw.lines ?? raw.content;
  const lines: string[] = [];
  if (rawLines !== undefined && rawLines !== null) {
    const list = typeof rawLines === "string" ? [rawLines] : rawLines;
    if (!Array.isArray(list) || list.length > MAX_INTRO_LINES) {
      add("intro", LEAD_FORM_COPY.intro);
      return null;
    }
    for (const l of list) {
      const t = optText(l, INTRO_LINE_MAX);
      if (t === null) {
        add("intro", LEAD_FORM_COPY.intro);
        return null;
      }
      if (t) lines.push(t);
    }
  }
  if (title === null) {
    add("intro", LEAD_FORM_COPY.intro);
    return null;
  }
  return title || lines.length ? { title: title ?? null, lines } : null;
}

/**
 * Checks a form spec and fills its defaults. Returns the spec, or every problem in plain words (the page shows each next to its
 * field). Nothing here calls Meta or the database.
 */
export function validateSpec(input: unknown, ctx: SpecContext = {}): SpecResult {
  if (!isObject(input)) return { spec: null, problems: [{ field: "spec", message: LEAD_FORM_COPY.spec }] };
  const problems: FormProblem[] = [];
  const add = (field: string, message: string) => void problems.push({ field, message });
  const now = ctx.now ?? new Date();

  let name = "";
  if (input.name !== undefined && input.name !== null) {
    if (typeof input.name !== "string") add("name", LEAD_FORM_COPY.name);
    else {
      name = input.name.trim().replace(/\s+/g, " ");
      if (name.length > FORM_NAME_MAX) add("name", LEAD_FORM_COPY.name);
    }
  }

  const formType = input.formType === undefined || input.formType === null ? "more_volume" : input.formType;
  if (!(FORM_TYPES as readonly unknown[]).includes(formType)) add("formType", LEAD_FORM_COPY.formType);
  const locale = input.locale === undefined || input.locale === null || input.locale === "" ? "en_US" : input.locale;
  if (!isFormLocale(locale)) add("locale", LEAD_FORM_COPY.locale);
  const lang = isFormLocale(locale) ? langOf(locale) : "en";

  const questions = parseQuestions(input.questions, add);

  const givenPrivacy = input.privacyUrl === undefined || input.privacyUrl === null || input.privacyUrl === "" ? (ctx.privacyUrl ?? null) : input.privacyUrl;
  const privacyProblem = privacyUrlProblem(givenPrivacy);
  if (privacyProblem) add("privacyUrl", privacyProblem);
  const linkText = optText(input.privacyLinkText, PRIVACY_LINK_TEXT_MAX);
  if (linkText === null) add("privacyLinkText", LEAD_FORM_COPY.linkText);

  const thankYou = parseThankYou(input.thankYou, ctx, add);
  const disclaimer = parseDisclaimer(input.disclaimer, ctx, lang, add);
  const intro = parseIntro(input.intro, add);

  if (problems.length > 0 || !thankYou) return { spec: null, problems: problems.length ? problems : [{ field: "thankYou", message: LEAD_FORM_COPY.thankYouKind }] };
  return {
    spec: {
      name: name || defaultName(now),
      questions,
      privacyUrl: normalizePrivacyUrl(givenPrivacy as string),
      privacyLinkText: linkText || "Privacy policy",
      intro,
      thankYou,
      disclaimer,
      formType: formType as FormType,
      locale: locale as FormLocale,
    },
    problems: [],
  };
}

/** A form spec that can't be used: 400 with the first problem as the message, and every problem for the page. */
export class FormSpecError extends HttpError {
  readonly problems: FormProblem[];
  constructor(problems: FormProblem[]) {
    super(400, problems[0]?.message ?? LEAD_FORM_COPY.spec);
    this.name = "FormSpecError";
    this.problems = problems;
  }
}

/** The L2 body input for promote/meta.ts (which rebuilds it from allowlisted keys again). */
export function toMetaSpec(spec: FormSpec): MetaLeadFormSpec {
  const t = spec.thankYou;
  return {
    name: spec.name,
    questions: spec.questions.map((q) =>
      q.type === "CUSTOM"
        ? { type: q.type, key: q.key, label: q.label, ...(q.options ? { options: q.options.map((o) => ({ key: o.key, value: o.value })) } : {}) }
        : { type: q.type, ...(q.label ? { label: q.label } : {}) },
    ),
    privacyPolicy: { url: spec.privacyUrl, linkText: spec.privacyLinkText },
    // VERIFY V-P7: a wa.me link behind VIEW_WEBSITE opens WhatsApp; Meta may also offer a WhatsApp button type.
    thankYouPage: {
      title: t.title,
      body: t.body,
      button_type: t.kind === "call" ? "CALL_BUSINESS" : "VIEW_WEBSITE",
      button_text: t.buttonText,
      ...(t.kind === "call" ? { business_phone_number: t.phone } : { website_url: t.url }),
    },
    ...(spec.disclaimer
      ? {
          customDisclaimer: {
            title: spec.disclaimer.title,
            // Meta's custom_disclaimer.body is an object {text, url_entities} (Marketing API leadgen_forms; VERIFY V-P7).
            body: { text: spec.disclaimer.body },
            // D35: never ticked for the person; the consent box is never required (validateSpec refuses that).
            checkboxes: spec.disclaimer.checkboxes.map((c) => ({ key: c.key, text: c.text, is_required: c.required, is_checked_by_default: false })),
          },
        }
      : {}),
    ...(spec.intro ? { contextCard: { ...(spec.intro.title ? { title: spec.intro.title } : {}), style: spec.intro.lines.length > 1 ? "LIST_STYLE" : "PARAGRAPH_STYLE", content: spec.intro.lines } } : {}),
    locale: spec.locale,
    optimizedForQuality: spec.formType === "higher_intent",
  };
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (isObject(v)) return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
}

/**
 * What makes two specs the same form: everything but the name. The name is only a label in Meta's forms library (people filling
 * the form never see it), and validateSpec dates a missing one, so the same unnamed draft would otherwise read as edited every day.
 */
const formKey = (spec: unknown): string => canonical(isObject(spec) ? { ...spec, name: undefined } : spec);

/** A stable hash of a form spec, for the Start card's material (6.5 formSpecHash). The name is left out (formKey). */
export const formSpecHash = (spec: FormSpec): string => createHash("sha256").update(formKey(spec)).digest("hex");

/** LeadForm.consentText holds at most this many characters (leads/service.updateForm). */
const CONSENT_TEXT_MAX = 1_000;

/**
 * The words a person agrees to by ticking the form's consent boxes ("I agree to get WhatsApp messages from {business}"). Stored
 * as the built form's consentText, so lead sync records this sentence as the lead's consent, not the box's key. null when the
 * form has no consent box.
 */
export function consentTextOf(spec: Pick<FormSpec, "disclaimer">): string | null {
  const boxes = spec.disclaimer?.checkboxes.filter((c) => isConsentBox(c.key, c.text)) ?? [];
  const text = boxes.map((c) => c.text.trim()).filter(Boolean).join("\n");
  return text ? text.slice(0, CONSENT_TEXT_MAX) : null;
}

// =====================================================================================================================
// Dependencies
// =====================================================================================================================

export type LeadFormDeps = {
  meta: Pick<PromoteMeta, "getPageReadiness" | "listLeadForms" | "createLeadForm" | "sendTestLead">;
  /** L3 (leads/form-definition.ts, unchanged): the form's questions and consent boxes, or null when Meta can't be read. */
  readDefinition: (tenantId: string, pageAssetId: string, metaFormId: string) => Promise<FormDefinitionKeys | null>;
  now: () => Date;
  /** SPEND_DRY_RUN: no Meta read, and writes answer with fake ids. Routes pass the guard's value. */
  dryRun: boolean;
  /** The code in "Edwyz test lead {code}". */
  code: () => string;
  /** Lead ingest marks test leads (test-leads.ts TEST_LEADS_MARKED_ON_INGEST). False: sendTestLead answers 409. */
  testLeadsReady: boolean;
};

async function readDefinitionWithPageToken(tenantId: string, pageAssetId: string, metaFormId: string): Promise<FormDefinitionKeys | null> {
  try {
    const { getAssetAccess } = await import("@/lib/meta-connect");
    const access = await getAssetAccess(tenantId, pageAssetId);
    return await fetchFormDefinitionKeys(access.token, metaFormId);
  } catch {
    return null;
  }
}

const randomCode = () => randomBytes(4).toString("hex").slice(0, 6).toUpperCase();

function resolveDeps(o: Partial<LeadFormDeps> = {}): LeadFormDeps {
  return {
    meta: o.meta ?? promoteMeta,
    readDefinition: o.readDefinition ?? readDefinitionWithPageToken,
    now: o.now ?? (() => new Date()),
    dryRun: o.dryRun ?? spendDryRun(process.env),
    code: o.code ?? randomCode,
    testLeadsReady: o.testLeadsReady ?? TEST_LEADS_MARKED_ON_INGEST,
  };
}

/** At most 10 test leads an hour per form (4.8), shared by every process through the database. */
export const testLeadLimiter = createLimiter(TEST_LEADS_PER_HOUR, HOUR_MS, "promote-test-lead");

// =====================================================================================================================
// Refusals in plain words
// =====================================================================================================================

export type OpensMetaFix = { kind: "opens_meta"; key: "leadgen_tos"; label: string };

/** Meta's lead ad terms are not accepted for the Page: refused before any POST, with the Opens Meta fix (3.2, 3.5, 4.10). */
export class LeadgenTermsRefusal extends HttpError {
  readonly code = "leadgen_tos" as const;
  readonly fix: OpensMetaFix = { kind: "opens_meta", key: "leadgen_tos", label: promoteText("readiness.leadgen_tos.fix") };
  constructor(pageName: string) {
    super(409, metaErrorText("leadgen_tos", { page: pageName }));
    this.name = "LeadgenTermsRefusal";
  }
}

/**
 * The JSON answer for this module's refusals that carry more than a message: the problems of a spec, or the Opens Meta fix.
 * Routes call it before handing other errors to the guard's errorResponse. null for every other error.
 */
export function leadFormErrorResponse(error: unknown): Response | null {
  if (error instanceof FormSpecError) return Response.json({ error: error.message, problems: error.problems }, { status: 400 });
  if (error instanceof LeadgenTermsRefusal) return Response.json({ error: error.message, code: error.code, fix: error.fix }, { status: 409 });
  return null;
}

const isAmbiguous = (e: unknown): boolean => (e instanceof GraphError || e instanceof PromoteMetaError) && e.ambiguous === true;

/** A Graph error as plain copy; HttpErrors (throttled, timeout, refusals) pass through. */
function plainMetaError(e: unknown, pageName: string): unknown {
  if (!(e instanceof GraphError)) return e;
  if (classifyMetaError({ code: e.code ?? null, subcode: e.subcode ?? null }) === "leadgen_tos") return new LeadgenTermsRefusal(pageName);
  if (e.ambiguous) return new HttpError(504, LEAD_FORM_COPY.ambiguous);
  if (e.code === 190) return new HttpError(409, LEAD_FORM_COPY.reconnect);
  if (e.code === 10 || (e.code !== undefined && e.code >= 200 && e.code < 300)) return new HttpError(403, LEAD_FORM_COPY.noPermission);
  return new HttpError(502, LEAD_FORM_COPY.metaRefused);
}

// =====================================================================================================================
// Shared steps
// =====================================================================================================================

type PageRow = { id: string; externalId: string; name: string | null };
const ASSET_ID = /^[A-Za-z0-9_-]{1,64}$/;
const META_FORM_ID = /^[0-9A-Za-z_]{1,64}$/;
const ROW_ID = /^[A-Za-z0-9_-]{1,64}$/;
const DRAFT_ID = /^[A-Za-z0-9_-]{1,40}$/;

const pageLabel = (page: PageRow) => page.name?.trim() || "this Page";

async function ownPage(tenantId: string, pageAssetId: unknown): Promise<PageRow> {
  if (typeof pageAssetId !== "string" || !ASSET_ID.test(pageAssetId)) throw new HttpError(400, LEAD_FORM_COPY.pageId);
  const page = await prisma.metaAsset.findFirst({ where: { id: pageAssetId, tenantId, type: "page" }, select: { id: true, externalId: true, name: true } });
  if (!page) throw new HttpError(404, LEAD_FORM_COPY.pageNotFound);
  return page;
}

/** What validateSpec fills in for this workspace: its WhatsApp number, the Page's name and the saved privacy link. */
async function specContext(tenantId: string, page: PageRow, now: Date): Promise<SpecContext> {
  const [phone, settings] = await Promise.all([
    prisma.phoneNumber.findFirst({ where: { tenantId }, orderBy: { createdAt: "asc" }, select: { displayPhone: true, verifiedName: true } }),
    getPromoteSettings(tenantId),
  ]);
  return { whatsappNumber: phone?.displayPhone ?? null, businessName: page.name ?? phone?.verifiedName ?? null, privacyUrl: settings.privacyUrl, now };
}

async function checkedSpec(tenantId: string, page: PageRow, input: unknown, deps: LeadFormDeps): Promise<FormSpec> {
  const result = validateSpec(input, await specContext(tenantId, page, deps.now()));
  if (!result.spec) throw new FormSpecError(result.problems);
  return result.spec;
}

/** C2 before any POST: false refuses with the fix; unknown (Meta gave no answer) goes on, and a terms error from L2 maps to the same fix. */
async function assertLeadgenTerms(ctx: { tenantId: string; pageAssetId: string }, page: PageRow, deps: LeadFormDeps): Promise<void> {
  let accepted: boolean | null;
  try {
    accepted = (await deps.meta.getPageReadiness(ctx)).leadgenTermsAccepted;
  } catch (e) {
    throw plainMetaError(e, pageLabel(page));
  }
  if (accepted === false) throw new LeadgenTermsRefusal(pageLabel(page));
}

/** The Page's forms (L1), or null when Meta can't be read. */
async function pageForms(ctx: { tenantId: string; pageAssetId: string }, deps: LeadFormDeps): Promise<LeadFormSummary[] | null> {
  try {
    return (await deps.meta.listLeadForms(ctx, { maxPages: 5 })).items;
  } catch {
    return null;
  }
}

/**
 * After an ambiguous POST: the form with this exact name on the Page. `exact` (a draft's name carries the draft id): any such
 * form. `unregistered`: only when exactly one form has the name and this workspace doesn't know it yet. null when none is found.
 */
async function settleByName(tenantId: string, ctx: { tenantId: string; pageAssetId: string }, name: string, mode: "exact" | "unregistered", deps: LeadFormDeps): Promise<LeadFormSummary | null> {
  const items = await pageForms(ctx, deps);
  if (!items) return null;
  const same = items.filter((f) => f.name === name);
  if (mode === "exact") return same[0] ?? null;
  if (same.length === 0) return null;
  const known = new Set((await prisma.leadForm.findMany({ where: { tenantId, metaFormId: { in: same.map((f) => f.id) } }, select: { metaFormId: true } })).map((r) => r.metaFormId));
  const fresh = same.filter((f) => !known.has(f.id));
  return fresh.length === 1 ? fresh[0] : null;
}

export type LeadFormView = NonNullable<Awaited<ReturnType<typeof getForm>>>;

/** What a created form's LeadForm row is registered with. */
type Registration = { name: string; spec: Prisma.InputJsonValue; formType: FormType | null; locale: string | null; metaStatus: string | null; consentText: string | null };

/** A form made from this spec: the spec, and the consent box's words as the form's consentText. */
const builtFrom = (spec: FormSpec): Registration => ({
  name: spec.name,
  spec: spec as unknown as Prisma.InputJsonValue,
  formType: spec.formType,
  locale: spec.locale,
  // A new form is ACTIVE on Meta (VERIFY V-P7); import and later syncs read the real status.
  metaStatus: "ACTIVE",
  consentText: consentTextOf(spec),
});

async function register(actor: Actor, page: PageRow, metaFormId: string, r: Registration, copiedFromId: string | undefined): Promise<LeadFormView> {
  const form = await createForm(
    actor,
    { metaFormId, pageAssetId: page.id, name: r.name.slice(0, LOCAL_NAME_MAX), consentText: r.consentText },
    { origin: "created", spec: r.spec, formType: r.formType, locale: r.locale, metaStatus: r.metaStatus, ...(copiedFromId ? { copiedFromId } : {}) },
  );
  if (!form) throw new HttpError(404, LEAD_FORM_COPY.formNotFound);
  return form;
}

type CreateHow = { copiedFromId?: string; settle: "exact" | "unregistered"; termsChecked?: boolean };

/** C2, then L2 with the Page token, then the LeadForm row. An ambiguous POST is settled by name, never sent again. */
async function createOnMeta(actor: Actor, page: PageRow, spec: FormSpec, deps: LeadFormDeps, how: CreateHow): Promise<LeadFormView> {
  const ctx = { tenantId: actor.tenantId, pageAssetId: page.id };
  if (!deps.dryRun && !how.termsChecked) await assertLeadgenTerms(ctx, page, deps);
  let metaFormId: string;
  let settled = false;
  try {
    metaFormId = (await deps.meta.createLeadForm(ctx, toMetaSpec(spec))).id;
  } catch (e) {
    if (deps.dryRun || !isAmbiguous(e)) throw plainMetaError(e, pageLabel(page));
    const found = await settleByName(actor.tenantId, ctx, spec.name, how.settle, deps);
    if (!found) throw new HttpError(504, LEAD_FORM_COPY.ambiguous);
    metaFormId = found.id;
    settled = true;
  }
  const form = await register(actor, page, metaFormId, builtFrom(spec), how.copiedFromId);
  await audit({
    tenantId: actor.tenantId,
    userId: actor.userId,
    action: how.copiedFromId ? "lead.form_copied" : "lead.form_created",
    target: form.id,
    meta: { metaFormId, pageAssetId: page.id, formType: spec.formType, settledByName: settled, dryRun: deps.dryRun, ...(how.copiedFromId ? { copiedFromId: how.copiedFromId } : {}) },
  });
  return form;
}

// =====================================================================================================================
// Build, copy, import, hide
// =====================================================================================================================

/** create_lead_form: makes the form on the Page and registers it (origin created, with the spec). Never assumes consent. */
export async function buildForm(actor: Actor, pageAssetId: unknown, spec: unknown, opts: Partial<LeadFormDeps> = {}): Promise<LeadFormView> {
  const deps = resolveDeps(opts);
  const page = await ownPage(actor.tenantId, pageAssetId);
  const checked = await checkedSpec(actor.tenantId, page, spec, deps);
  return createOnMeta(actor, page, checked, deps, { settle: "unregistered" });
}

const copyName = (name: string | null) => {
  const base = (name?.trim() || promoteText("form.title")).slice(0, FORM_NAME_MAX - 7);
  return `${base} (copy)`;
};

/**
 * copy_lead_form: Meta can't change a live form, so an edit makes a new form on the Page with the edited spec, linked to the
 * original by copiedFromId. With no spec, the original's stored spec is copied as it is. The original is left as it is. A copy of
 * a draft's form keeps the draft's name suffix, so ensureDraftForm finds the copy as the draft's form from then on.
 */
export async function copyForm(actor: Actor, formId: unknown, spec: unknown, opts: Partial<LeadFormDeps> = {}): Promise<LeadFormView> {
  const deps = resolveDeps(opts);
  if (typeof formId !== "string" || !ROW_ID.test(formId)) throw new HttpError(404, LEAD_FORM_COPY.formNotFound);
  const source = await prisma.leadForm.findFirst({ where: { id: formId, tenantId: actor.tenantId } });
  if (!source) throw new HttpError(404, LEAD_FORM_COPY.formNotFound);
  const page = await prisma.metaAsset.findFirst({ where: { id: source.pageAssetId, tenantId: actor.tenantId, type: "page" }, select: { id: true, externalId: true, name: true } });
  if (!page) throw new HttpError(409, LEAD_FORM_COPY.pageGone);
  const input = spec === undefined || spec === null ? source.spec : spec;
  if (!isObject(input)) throw new HttpError(400, LEAD_FORM_COPY.copyNeedsSpec);
  const draftId = source.origin === "created" ? draftIdOfName(source.name) : null;
  // The suffix is taken off before the name is checked and put back after, as ensureDraftForm does.
  const bare = (name: string) => (draftId ? withoutDraftSuffix(name, draftId) : name);
  const given = typeof input.name === "string" ? bare(input.name.trim()) : "";
  const named = { ...input, name: given || copyName(source.name ? bare(source.name) : null) };
  const checked = await checkedSpec(actor.tenantId, page, named, deps);
  const final = draftId ? { ...checked, name: draftFormName(checked.name, draftId) } : checked;
  return createOnMeta(actor, page, final, deps, { copiedFromId: source.id, settle: "unregistered" });
}

/** Meta's questions as LeadForm.spec keeps them for an imported form: type, key, label and answers, capped. */
function importedQuestions(raw: unknown[]): FormQuestion[] {
  const out: FormQuestion[] = [];
  for (const q of raw.slice(0, 50)) {
    if (!isObject(q) || typeof q.type !== "string") continue;
    const type = (isQuestionType(q.type) ? q.type : "CUSTOM") as LeadQuestionType;
    const key = typeof q.key === "string" ? q.key.slice(0, 100) : undefined;
    const label = typeof q.label === "string" ? q.label.slice(0, CUSTOM_LABEL_MAX) : undefined;
    const options = Array.isArray(q.options)
      ? q.options
          .slice(0, 50)
          .filter(isObject)
          .map((o, i) => ({ key: typeof o.key === "string" ? o.key.slice(0, 100) : `option_${i + 1}`, value: typeof o.value === "string" ? o.value.slice(0, 200) : "" }))
      : undefined;
    out.push({ type, ...(key ? { key } : {}), ...(label ? { label } : {}), ...(options?.length ? { options } : {}) });
  }
  return out;
}

/** Meta's locale as LeadForm.locale keeps it (en_US). Meta documents the enum in capitals (EN_US), so either is read. */
function metaLocale(v: string | null | undefined): string | null {
  const m = typeof v === "string" ? /^([a-z]{2})_([a-z]{2})$/i.exec(v.trim()) : null;
  return m ? `${m[1].toLowerCase()}_${m[2].toUpperCase()}` : null;
}

const metaStatusOf = (v: string | null | undefined): string | null => (v && /^[A-Z_]{1,40}$/.test(v) ? v : null);

/** LeadForm.spec for a form read from the Page (L1): what Meta says it asks, not a spec Edwyz built. */
const specFromMeta = (found: LeadFormSummary) => ({ source: "meta", questions: importedQuestions(found.questions), privacyUrl: found.privacyPolicyUrl, locale: metaLocale(found.locale) });

/**
 * import_lead_form (E-R7): registers a form that is already on the Page, read from L1 (name, status, locale, questions) and L3
 * (its consent boxes, stored for lead sync so consent rules apply from the first lead). Origin `imported`; a form built in Edwyz
 * keeps origin `created`. Under a dry run nothing is read: the row is registered by its id only.
 */
export async function importForm(actor: Actor, pageAssetId: unknown, metaFormId: unknown, opts: Partial<LeadFormDeps> = {}): Promise<LeadFormView> {
  const deps = resolveDeps(opts);
  const page = await ownPage(actor.tenantId, pageAssetId);
  if (typeof metaFormId !== "string" || !META_FORM_ID.test(metaFormId)) throw new HttpError(400, LEAD_FORM_COPY.formId);
  let form: LeadFormView | undefined;
  if (deps.dryRun) {
    form = await createForm(actor, { metaFormId, pageAssetId: page.id }, { origin: "imported" });
  } else {
    const ctx = { tenantId: actor.tenantId, pageAssetId: page.id };
    let found: LeadFormSummary | undefined;
    try {
      found = (await deps.meta.listLeadForms(ctx, { maxPages: 5 })).items.find((f) => f.id === metaFormId);
    } catch (e) {
      throw plainMetaError(e, pageLabel(page));
    }
    if (!found) throw new HttpError(404, LEAD_FORM_COPY.notOnPage);
    const definition = await deps.readDefinition(actor.tenantId, page.id, metaFormId);
    const name = found.name?.trim().slice(0, LOCAL_NAME_MAX) || undefined;
    const spec = specFromMeta(found);
    form = await createForm(actor, { metaFormId, pageAssetId: page.id, ...(name ? { name } : {}) }, { origin: "imported", spec: spec as unknown as Prisma.InputJsonValue, locale: spec.locale, metaStatus: metaStatusOf(found.status) });
    if (form && definition) {
      const before = (await getFormQuestionInfoMany(actor.tenantId, [form.id])).get(form.id) ?? emptyQuestionInfo();
      await recordFormDefinition(actor.tenantId, form.id, before, definition, deps.now().getTime());
      // Shown with the consent questions just read.
      form = (await getForm(actor.tenantId, form.id)) ?? form;
    }
  }
  if (!form) throw new HttpError(404, LEAD_FORM_COPY.formNotFound);
  await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "lead.form_imported", target: form.id, meta: { metaFormId, pageAssetId: page.id, dryRun: deps.dryRun } });
  return form;
}

type Env = Record<string, string | undefined>;

/**
 * POST /api/leads/forms { pageAssetId, metaFormId, name?, consentText?, consentAssumed? } (import_lead_form, E-R7, PRM-10 2b).
 * While Instagram and Facebook Page ads are open to the caller, the form is imported from the Page (importForm: name, status and
 * questions from L1, consent boxes from L3, origin imported). The name, consentText and consentAssumed are checked before Meta is
 * read and applied after, as PATCH /api/leads/forms/{id} applies them. Answers 201 { form } or this module's refusals; null while
 * Promote is hidden from the caller, and the route then registers the form by its id as before.
 */
export async function importFromRegisterRoute(actor: Actor, body: Record<string, unknown>, opts: Partial<LeadFormDeps> & { env?: Env } = {}): Promise<Response | null> {
  const { env = process.env, ...given } = opts;
  if (!(await accessFor(actor, env)).visible) return null;
  const patch = { name: body.name, consentText: body.consentText, consentAssumed: body.consentAssumed };
  try {
    checkFormPatch(patch);
    if (patch.consentAssumed === true && typeof body.metaFormId === "string") {
      // A form built in Edwyz stays origin created when it is imported, and never assumes consent (D35).
      const built = await prisma.leadForm.findFirst({ where: { tenantId: actor.tenantId, metaFormId: body.metaFormId, origin: "created" }, select: { id: true } });
      if (built) throw new HttpError(400, CREATED_FORM_CONSENT);
    }
    let form = await importForm(actor, body.pageAssetId, body.metaFormId, { dryRun: isDryRun(env), ...given });
    if (Object.values(patch).some((v) => v !== undefined)) form = (await updateForm(actor, form.id, patch)) ?? form;
    return Response.json({ form }, { status: 201 });
  } catch (error) {
    const answer = leadFormErrorResponse(error);
    if (answer) return answer;
    throw error;
  }
}

/** hide_lead_form: hides the form in Edwyz only (D13: nothing is archived through the API). undo shows it again. */
export async function hideForm(actor: Actor, formId: unknown, undo = false, opts: Partial<Pick<LeadFormDeps, "now">> = {}): Promise<{ id: string; hidden: boolean }> {
  if (typeof formId !== "string" || !ROW_ID.test(formId)) throw new HttpError(404, LEAD_FORM_COPY.formNotFound);
  const now = (opts.now ?? (() => new Date()))();
  const { count } = await prisma.leadForm.updateMany({ where: { id: formId, tenantId: actor.tenantId }, data: { hiddenAt: undo ? null : now } });
  if (count === 0) throw new HttpError(404, LEAD_FORM_COPY.formNotFound);
  await audit({ tenantId: actor.tenantId, userId: actor.userId, action: undo ? "lead.form_unhidden" : "lead.form_hidden", target: formId });
  return { id: formId, hidden: !undo };
}

export const unhideForm = (actor: Actor, formId: unknown, opts: Partial<Pick<LeadFormDeps, "now">> = {}) => hideForm(actor, formId, true, opts);

/**
 * list_lead_forms: this workspace's forms on the Page, and the Page's forms on Meta (L1) marked with the local row each matches.
 * Registers nothing. Under a dry run the Meta list is empty.
 */
export async function listMetaForms(actor: Actor, pageAssetId: unknown, opts: Partial<LeadFormDeps> = {}) {
  const deps = resolveDeps(opts);
  const page = await ownPage(actor.tenantId, pageAssetId);
  const local = await listForms(actor.tenantId, { pageAssetId: page.id });
  const pageView = { id: page.id, name: page.name };
  if (deps.dryRun) return { page: pageView, local, meta: [], complete: true, dryRun: true };
  let res: Awaited<ReturnType<LeadFormDeps["meta"]["listLeadForms"]>>;
  try {
    res = await deps.meta.listLeadForms({ tenantId: actor.tenantId, pageAssetId: page.id });
  } catch (e) {
    throw plainMetaError(e, pageLabel(page));
  }
  const rows = res.items.length
    ? await prisma.leadForm.findMany({ where: { tenantId: actor.tenantId, metaFormId: { in: res.items.map((f) => f.id) } }, select: { id: true, metaFormId: true, origin: true, hiddenAt: true } })
    : [];
  const byMeta = new Map(rows.map((r) => [r.metaFormId, r]));
  const meta = res.items.map((f) => {
    const row = byMeta.get(f.id);
    return {
      metaFormId: f.id,
      name: f.name,
      status: f.status,
      locale: f.locale,
      questions: importedQuestions(f.questions),
      privacyPolicyUrl: f.privacyPolicyUrl,
      createdTime: f.createdTime,
      leadsCount: f.leadsCount,
      localId: row?.id ?? null,
      origin: row?.origin ?? null,
      hidden: row ? row.hiddenAt != null : false,
    };
  });
  return { page: pageView, local, meta, complete: res.complete, dryRun: false };
}

// =====================================================================================================================
// Test leads (L4, D33)
// =====================================================================================================================

/** A US 555-01xx number: reserved as fictional, and a valid E.164 number for Meta (kept in test-leads.ts, which recognises it). */
export { TEST_LEAD_PHONE };

/** Meta's field name for each pre-filled question type that carries a test answer (VERIFY V-P7). */
const TEST_FIELD_NAMES: Partial<Record<LeadQuestionType, { name: string; kind: "text" | "email" | "phone" }>> = {
  FULL_NAME: { name: "full_name", kind: "text" },
  FIRST_NAME: { name: "first_name", kind: "text" },
  LAST_NAME: { name: "last_name", kind: "text" },
  EMAIL: { name: "email", kind: "email" },
  WORK_EMAIL: { name: "work_email", kind: "email" },
  PHONE: { name: "phone_number", kind: "phone" },
  WHATSAPP_NUMBER: { name: "whatsapp_number", kind: "phone" },
  WORK_PHONE_NUMBER: { name: "work_phone_number", kind: "phone" },
};

/**
 * The test answers for a form whose questions are known: "Edwyz test lead {code}" for the name and every free-text answer, a
 * dummy email and phone Meta accepts, and the first answer of a multiple-choice question. Other pre-filled questions are left
 * to Meta's own dummy data ("<test lead: ...>", which lead sync also recognises). undefined when the questions are unknown, so
 * Meta fills every answer itself.
 */
export function testFieldData(spec: unknown, code: string): { name: string; values: string[] }[] | undefined {
  const questions = isObject(spec) && Array.isArray(spec.questions) ? spec.questions : null;
  if (!questions || questions.length === 0) return undefined;
  const text = `${TEST_LEAD_PREFIX} ${code}`;
  const out: { name: string; values: string[] }[] = [];
  for (const q of questions.slice(0, 30)) {
    if (!isObject(q) || !isQuestionType(q.type)) continue;
    if (q.type === "CUSTOM") {
      if (typeof q.key !== "string" || !q.key) continue;
      const first = Array.isArray(q.options) && isObject(q.options[0]) ? q.options[0] : null;
      // VERIFY V-P7: whether a multiple-choice answer is the option's key or its text.
      const value = first ? String(first.key ?? first.value ?? "") : text;
      if (value) out.push({ name: q.key, values: [value] });
      continue;
    }
    const field = TEST_FIELD_NAMES[q.type];
    if (!field) continue;
    out.push({ name: field.name, values: [field.kind === "text" ? text : field.kind === "email" ? testLeadEmail(code) : TEST_LEAD_PHONE] });
  }
  return out.length ? out : undefined;
}

/**
 * send_test_lead (L4): a Meta test lead on the form. Its id is stored for the Page (every workspace with the Page reads it), so
 * lead sync tags it Test: no WhatsApp message, no conversion event, no routing notice (D33). testLeadUntil = now + 10 minutes
 * only shows "Test sent". At most 10 an hour per form (429). 409 with nothing sent while lead ingest doesn't mark test leads
 * yet (TEST_LEADS_MARKED_ON_INGEST): the lead would be handled as a real one.
 */
export async function sendTestLead(actor: Actor, formId: unknown, opts: Partial<LeadFormDeps> = {}) {
  const deps = resolveDeps(opts);
  if (!deps.testLeadsReady) throw new HttpError(409, LEAD_FORM_COPY.testLeadsNotReady);
  if (typeof formId !== "string" || !ROW_ID.test(formId)) throw new HttpError(404, LEAD_FORM_COPY.formNotFound);
  const form = await prisma.leadForm.findFirst({ where: { id: formId, tenantId: actor.tenantId } });
  if (!form) throw new HttpError(404, LEAD_FORM_COPY.formNotFound);
  const page = await prisma.metaAsset.findFirst({ where: { id: form.pageAssetId, tenantId: actor.tenantId, type: "page" }, select: { id: true, externalId: true, name: true } });
  if (!page) throw new HttpError(409, LEAD_FORM_COPY.pageGone);
  if (!testLeadLimiter.consume(form.id)) throw new HttpError(429, LEAD_FORM_COPY.testLimit);
  const code = deps.code();
  const now = deps.now();
  let testLeadId: string;
  try {
    testLeadId = (await deps.meta.sendTestLead({ tenantId: actor.tenantId, pageAssetId: page.id }, form.metaFormId, testFieldData(form.spec, code))).id;
  } catch (e) {
    throw plainMetaError(e, pageLabel(page));
  }
  await rememberTestLead(page.externalId, testLeadId, now);
  const testLeadUntil = new Date(now.getTime() + TEST_SENT_MS);
  await prisma.leadForm.updateMany({ where: { id: form.id, tenantId: actor.tenantId }, data: { testLeadUntil } });
  await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "lead.test_lead_sent", target: form.id, meta: { metaFormId: form.metaFormId, testLeadId, dryRun: deps.dryRun } });
  return { formId: form.id, testLeadId, code, testLeadUntil };
}

// =====================================================================================================================
// The draft's form (PRM-09's Start, 3.5)
// =====================================================================================================================

/** The suffix every draft's form name ends with: the draft id, so the form can be found by its exact name (3.5). */
export const draftFormSuffix = (draftId: string) => ` [${draftId}]`;

/** The form name for a draft: the owner's name, shortened so the suffix fits, then the draft id. */
export function draftFormName(name: string, draftId: string): string {
  const suffix = draftFormSuffix(draftId);
  return `${name.slice(0, LOCAL_NAME_MAX - suffix.length).trim()}${suffix}`;
}

const DRAFT_SUFFIX = / \[([A-Za-z0-9_-]{1,40})\]$/;

/** The draft id a form's name ends with (" [draftId]", draftFormSuffix), or null. */
export function draftIdOfName(name: string | null | undefined): string | null {
  const m = typeof name === "string" ? DRAFT_SUFFIX.exec(name) : null;
  return m ? m[1] : null;
}

/** The name without this draft's suffix. */
const withoutDraftSuffix = (name: string, draftId: string): string => {
  const suffix = draftFormSuffix(draftId);
  return name.endsWith(suffix) ? name.slice(0, -suffix.length).trim() : name;
};

/** How many copies deep the draft's current form is looked for (each edit makes one copy). */
const MAX_COPY_HOPS = 50;

/**
 * The draft's current form, a created form on the Page: the one the draft's ad uses (creative.leadFormId), else the newest form
 * named with the draft's suffix; then, because an edit makes a copy (D13) that keeps the suffix, the newest copy of that copy,
 * and so on. The oldest form is never taken just for being first: after an edit it is out of date.
 */
async function findDraftForm(tenantId: string, draftId: string, pageAssetId: string) {
  const scope = { tenantId, pageAssetId, origin: "created" };
  const suffix = draftFormSuffix(draftId);
  const sets = await prisma.adSet.findMany({ where: { tenantId, campaignId: draftId }, select: { id: true } });
  const ads = sets.length ? await prisma.ad.findMany({ where: { tenantId, adSetId: { in: sets.map((s) => s.id) } }, select: { creative: true } }) : [];
  const refs = [...new Set(ads.map((a) => (isObject(a.creative) && typeof a.creative.leadFormId === "string" ? a.creative.leadFormId : null)).filter((x): x is string => Boolean(x)))];
  let form = refs.length
    ? await prisma.leadForm.findFirst({ where: { ...scope, OR: [{ id: { in: refs } }, { metaFormId: { in: refs } }] }, orderBy: { createdAt: "desc" } })
    : null;
  form ??= await prisma.leadForm.findFirst({ where: { ...scope, name: { endsWith: suffix } }, orderBy: { createdAt: "desc" } });
  for (let hop = 0; form && hop < MAX_COPY_HOPS; hop++) {
    const copy = await prisma.leadForm.findFirst({ where: { ...scope, copiedFromId: form.id, name: { endsWith: suffix } }, orderBy: { createdAt: "desc" } });
    if (!copy) break;
    form = copy;
  }
  return form;
}

/**
 * An earlier try for the draft that Meta saved without confirming it (L1): the form with the draft's exact name, else the
 * newest one named with the draft's suffix (an unnamed draft's default name carries the day it was tried).
 */
async function earlierDraftForm(ctx: { tenantId: string; pageAssetId: string }, draftId: string, name: string, deps: LeadFormDeps): Promise<LeadFormSummary | null> {
  const items = await pageForms(ctx, deps);
  if (!items) return null;
  const exact = items.find((f) => f.name === name);
  if (exact) return exact;
  const suffix = draftFormSuffix(draftId);
  const time = (f: LeadFormSummary) => (f.createdTime ? Date.parse(f.createdTime) || 0 : 0);
  return items.filter((f) => f.name?.endsWith(suffix)).sort((a, b) => time(b) - time(a))[0] ?? null;
}

const urlKey = (url: string): string => {
  try {
    return new URL(url.trim()).toString();
  } catch {
    return url.trim();
  }
};

/**
 * Whether the form Meta saved (L1) asks what this spec asks: the same questions in the same order (for the owner's own: key,
 * text and answers; for a pre-filled one: the type, and the text when the spec sets one), the same privacy link, and the same
 * language when Meta says it. False when Meta's answer has no questions or no privacy link to compare.
 */
function savedAsSpec(found: LeadFormSummary, spec: FormSpec): boolean {
  const saved = importedQuestions(found.questions);
  if (saved.length === 0 || saved.length !== spec.questions.length || !found.privacyPolicyUrl) return false;
  const options = (q: FormQuestion) => canonical((q.options ?? []).map((o) => ({ key: o.key, value: o.value })));
  const same = (want: FormQuestion, got: FormQuestion) =>
    want.type === got.type &&
    (want.type === "CUSTOM" ? want.key === got.key && want.label === got.label && options(want) === options(got) : !want.label || want.label === got.label);
  if (!spec.questions.every((q, i) => same(q, saved[i]))) return false;
  if (urlKey(found.privacyPolicyUrl) !== urlKey(spec.privacyUrl)) return false;
  const locale = metaLocale(found.locale);
  return locale === null || locale === spec.locale;
}

/** A form Meta saved from an earlier spec: registered with what Meta says it asks, so the row never misdescribes it. */
const savedFrom = (found: LeadFormSummary, name: string): Registration => ({
  name,
  spec: specFromMeta(found) as unknown as Prisma.InputJsonValue,
  formType: null,
  locale: metaLocale(found.locale),
  metaStatus: metaStatusOf(found.status),
  consentText: null,
});

export type DraftFormResult = { form: LeadFormView; reused: boolean; specMatches: boolean };

/**
 * One form per draft, for PRM-09's Start (3.5): the draft's current form (findDraftForm) is reused and nothing is sent; else
 * C2, then a look at the Page's forms (L1) for an earlier try that Meta never confirmed (earlierDraftForm), then L2. An
 * ambiguous POST is settled by the exact name before anything else runs, and never sent again. `specMatches` is false when the
 * reused form asks something else than this spec (the caller makes a copy for an edit, which keeps the draft's suffix). The name
 * is not compared (formKey). An earlier try whose saved questions or privacy link differ, or can't be compared, is registered
 * with what Meta says it asks and specMatches false.
 */
export async function ensureDraftForm(actor: Actor, draftId: unknown, pageAssetId: unknown, spec: unknown, opts: Partial<LeadFormDeps> = {}): Promise<DraftFormResult> {
  const deps = resolveDeps(opts);
  if (typeof draftId !== "string" || !DRAFT_ID.test(draftId)) throw new HttpError(404, LEAD_FORM_COPY.draftNotFound);
  const draft = await prisma.adCampaign.findFirst({ where: { id: draftId, tenantId: actor.tenantId }, select: { id: true } });
  if (!draft) throw new HttpError(404, LEAD_FORM_COPY.draftNotFound);
  const page = await ownPage(actor.tenantId, pageAssetId);
  const checked = await checkedSpec(actor.tenantId, page, spec, deps);
  const named: FormSpec = { ...checked, name: draftFormName(checked.name, draftId) };

  const linked = await findDraftForm(actor.tenantId, draftId, page.id);
  if (linked) {
    const form = await getForm(actor.tenantId, linked.id);
    if (!form) throw new HttpError(404, LEAD_FORM_COPY.formNotFound);
    return { form, reused: true, specMatches: formKey(linked.spec) === formKey(named) };
  }

  const ctx = { tenantId: actor.tenantId, pageAssetId: page.id };
  if (!deps.dryRun) {
    await assertLeadgenTerms(ctx, page, deps);
    const earlier = await earlierDraftForm(ctx, draftId, named.name, deps);
    if (earlier) {
      const specMatches = savedAsSpec(earlier, named);
      const form = await register(actor, page, earlier.id, specMatches ? builtFrom(named) : savedFrom(earlier, earlier.name ?? named.name), undefined);
      await audit({
        tenantId: actor.tenantId,
        userId: actor.userId,
        action: "lead.form_created",
        target: form.id,
        meta: { metaFormId: earlier.id, pageAssetId: page.id, draftId, settledByName: true, specMatches, dryRun: false },
      });
      return { form, reused: true, specMatches };
    }
  }
  const form = await createOnMeta(actor, page, named, deps, { settle: "exact", termsChecked: true });
  return { form, reused: false, specMatches: true };
}
