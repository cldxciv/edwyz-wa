/**
 * Instant-form question types and presets (docs/IG-PAGE-ADS-SPEC.md 3.5, 4.2 L2, 5.4 LeadForm.spec, D35). Pure data and
 * checks; promote/lead-forms (PRM-10) builds the Meta body. Every type is VERIFY against the leadgen_forms reference;
 * WHATSAPP_NUMBER is VERIFY V-P7 in particular.
 */
import type { PromoteCopyKey } from "../copy";
import type { FormType, VerifyState } from "../types";
import { verifyStateOf } from "./verified";

export const LEAD_QUESTION_TYPES = [
  "FULL_NAME",
  "FIRST_NAME",
  "LAST_NAME",
  "EMAIL",
  "PHONE",
  "WHATSAPP_NUMBER",
  "CITY",
  "STATE",
  "ZIP",
  "COUNTRY",
  "STREET_ADDRESS",
  "DOB",
  "GENDER",
  "JOB_TITLE",
  "COMPANY_NAME",
  "WORK_EMAIL",
  "WORK_PHONE_NUMBER",
  "DATE_TIME",
  "CUSTOM",
] as const;
export type LeadQuestionType = (typeof LEAD_QUESTION_TYPES)[number];

export type LeadQuestionRow = {
  type: LeadQuestionType;
  /** Meta fills the answer from the person's profile. */
  prefill: boolean;
  /** A way to reach the person (the form needs at least one). */
  contact: boolean;
  labelKey: PromoteCopyKey;
  verify: VerifyState;
  verifyRefs: readonly string[];
};

const row = (type: LeadQuestionType, prefill: boolean, contact = false, verifyRefs: readonly string[] = ["V-P7"]): LeadQuestionRow => ({
  type,
  prefill,
  contact,
  labelKey: `form.q.${type}` as PromoteCopyKey,
  verify: verifyStateOf(`question.${type}`),
  verifyRefs,
});

export const LEAD_QUESTIONS: readonly LeadQuestionRow[] = [
  row("FULL_NAME", true),
  row("FIRST_NAME", true),
  row("LAST_NAME", true),
  row("EMAIL", true, true),
  row("PHONE", true, true),
  // VERIFY V-P7: Meta's WhatsApp-number question type and whether it pre-fills.
  row("WHATSAPP_NUMBER", true, true, ["V-P7"]),
  row("CITY", true),
  row("STATE", true),
  row("ZIP", true),
  row("COUNTRY", true),
  row("STREET_ADDRESS", true),
  row("DOB", true),
  row("GENDER", true),
  row("JOB_TITLE", true),
  row("COMPANY_NAME", true),
  row("WORK_EMAIL", true, true),
  row("WORK_PHONE_NUMBER", true, true),
  row("DATE_TIME", false),
  row("CUSTOM", false),
];

/** At most 15 questions in all, of which at most 3 are the owner's own (3.5). */
export const MAX_FORM_QUESTIONS = 15;
export const MAX_QUALIFYING_QUESTIONS = 3;
/** Meta's privacy link text limit (L2: link_text ≤ 70). */
export const PRIVACY_LINK_TEXT_MAX = 70;

/** The consent checkbox (D35): optional, never pre-ticked, key whatsapp_opt_in so ingest reads it as consent. */
export const CONSENT_CHECKBOX = Object.freeze({ key: "whatsapp_opt_in", required: false, checkedByDefault: false });

/** The default questions: full name and phone, pre-filled by Meta. Email is offered as an optional chip. */
export const DEFAULT_QUESTIONS: readonly LeadQuestionType[] = ["FULL_NAME", "PHONE"];

/** Qualifying questions from industry templates (3.5), as copy keys; the owner can edit the text. */
export const FORM_PRESETS: Readonly<Record<"salon" | "coaching" | "general", readonly PromoteCopyKey[]>> = {
  salon: ["form.preset.which_service", "form.preset.preferred_day"],
  coaching: ["form.preset.which_class", "form.preset.preferred_day"],
  general: ["form.preset.budget", "form.preset.when_start"],
};

export type FormQuestionInput = { type: LeadQuestionType | string; key?: string; label?: string };
export type FormSpecInput = {
  questions: readonly FormQuestionInput[];
  privacyUrl: string | null;
  formType: FormType;
  checkboxes?: readonly { key: string; required: boolean; checkedByDefault?: boolean }[];
};
export type FormProblemCode = "too_many_questions" | "too_many_custom" | "unknown_type" | "needs_contact" | "privacy_https" | "consent_required";

/** The copy key for each form problem. */
export const FORM_PROBLEM_COPY: Readonly<Record<FormProblemCode, PromoteCopyKey>> = {
  too_many_questions: "form.max_questions",
  too_many_custom: "form.max_qualifying",
  unknown_type: "draft.bad_value",
  needs_contact: "form.needs_contact",
  privacy_https: "form.privacy_https",
  consent_required: "form.consent_cant_require",
};

const isQuestionType = (v: unknown): v is LeadQuestionType => typeof v === "string" && (LEAD_QUESTION_TYPES as readonly string[]).includes(v);

/** What is wrong with a form before it goes to Meta, in order. Empty when the form can be created. */
export function formSpecProblems(spec: FormSpecInput): FormProblemCode[] {
  const out: FormProblemCode[] = [];
  if (spec.questions.length > MAX_FORM_QUESTIONS) out.push("too_many_questions");
  if (spec.questions.filter((q) => q.type === "CUSTOM").length > MAX_QUALIFYING_QUESTIONS) out.push("too_many_custom");
  if (spec.questions.some((q) => !isQuestionType(q.type))) out.push("unknown_type");
  const contacts = new Set(LEAD_QUESTIONS.filter((r) => r.contact).map((r) => r.type as string));
  if (!spec.questions.some((q) => contacts.has(q.type))) out.push("needs_contact");
  if (!spec.privacyUrl || !/^https:\/\/[^\s/]+\.[^\s]+$/i.test(spec.privacyUrl.trim())) out.push("privacy_https");
  const consent = spec.checkboxes?.find((c) => c.key === CONSENT_CHECKBOX.key);
  if (consent && (consent.required || consent.checkedByDefault)) out.push("consent_required");
  return out;
}
