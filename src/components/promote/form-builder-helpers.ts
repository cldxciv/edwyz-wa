/**
 * The instant-form builder's pure logic (docs/IG-PAGE-ADS-SPEC.md 3.5 step 2, 6.5 create_lead_form, 7.1, 7.3, D13, D35,
 * 11.1a decisions 2 and 5). FormStep, LeadFormPreview and /app/leads/forms/new use it; tests/promote-ui-forms.test.ts runs it.
 *
 * - The UI state (BuilderState) becomes the `spec` of POST /api/leads/forms/build (or /api/leads/forms/{id}/copy). Every text
 *   the person filling the form sees is sent explicitly (thank-you screen, consent box), so the preview and the confirm dialog
 *   show exactly what goes to Meta. The server validates again (promote/lead-forms.validateSpec).
 * - At most 15 questions, at most 3 of the owner's own, and a phone or email question.
 * - The privacy link is the business's own and must be https: Edwyz never hosts one (D13, 11.1a decision 2).
 * - The WhatsApp consent box is optional and never ticked in advance (D35). There is no way to make it required here.
 * - A WhatsApp thank-you button is a wa.me link to the workspace's WhatsApp number.
 *
 * Client-safe: no database, no network, no server-only imports. Pages are English (D23); strings come from promoteText where
 * the catalogue has them, and the few builder-only labels below are English page copy.
 */
import { CONSENT_CHECKBOX, LEAD_QUESTIONS, LEAD_QUESTION_TYPES, MAX_FORM_QUESTIONS, MAX_QUALIFYING_QUESTIONS, type LeadQuestionType } from "@/lib/promote/catalog/lead-questions";
import { promoteText, type PromoteCopyKey } from "@/lib/promote/copy";
import { FORM_PRESET_KEYS, presetQuestions, presetSuggestions, type FormPresetKey, type PresetQuestion } from "@/lib/promote/form-presets";
import type { PromoteAccess } from "@/lib/promote/flags";
import type { FormType, ReadinessStatus } from "@/lib/promote/types";

// =====================================================================================================================
// Limits and copy
// =====================================================================================================================

export { MAX_FORM_QUESTIONS, MAX_QUALIFYING_QUESTIONS };
export const FORM_NAME_MAX = 100;
export const CUSTOM_LABEL_MAX = 300;
export const PRIVACY_URL_MAX = 2_000;
/** Meta's answer limits for a multiple-choice question, as promote/lead-forms.validateSpec checks them. */
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 20;
export const OPTION_TEXT_MAX = 100;
/** At most this many boxes in the consent section (promote/lead-forms MAX_CHECKBOXES). */
export const MAX_BOXES = 5;
/** The languages Meta offers for instant forms; the same list as promote/lead-forms FORM_LOCALES (a test keeps them equal). */
export const FORM_LOCALES = [
  "en_US", "en_GB", "hi_IN", "ar_AR", "cs_CZ", "da_DK", "de_DE", "el_GR", "es_ES", "es_LA", "fi_FI", "fr_FR", "he_IL", "hu_HU", "id_ID", "it_IT",
  "ja_JP", "ko_KR", "nb_NO", "nl_NL", "pl_PL", "pt_BR", "pt_PT", "ro_RO", "ru_RU", "sv_SE", "th_TH", "tr_TR", "vi_VN", "zh_CN", "zh_HK", "zh_TW",
] as const;
/** The server's key rules: a question's own key, and an answer's key. A key that fails is left out and the server makes one. */
const QUESTION_KEY = /^[a-z][a-z0-9_]{0,59}$/;
const OPTION_KEY = /^[a-z0-9][a-z0-9_]{0,59}$/;
export const THANK_YOU_KINDS = ["whatsapp", "call", "website"] as const;
export type ThankYouKind = (typeof THANK_YOU_KINDS)[number];
export const FORM_TYPE_VALUES: readonly FormType[] = ["more_volume", "higher_intent"];

/** Where the builder lives and where it goes after a form is made. */
export const FORMS_PATH = "/app/leads/forms";
export const BUILDER_PATH = "/app/leads/forms/new";

/** Builder-only page copy (English pages, D23). Everything the catalogue already has comes from promoteText. */
export const FORM_BUILDER_TEXT = {
  pageTitle: "Make a lead form",
  pageTitleCopy: "Make an edited copy",
  pageDescription: "People fill this form inside Instagram or Facebook. Their answers come to Leads.",
  makeForm: "Make a form",
  copyToEdit: "Make a copy to edit",
  copyNote: promoteText("form.change_note"),
  backToForms: "Back to lead forms",
  name: "Form name",
  nameHint: "Only you see this name. It helps you find the form later.",
  page: "Facebook Page",
  pageHint: "The form is made on this Page. It works for ads on Facebook and Instagram.",
  noPages: "Connect your Facebook Page first. The form is made on your Page.",
  connectPage: "Connect your Facebook page",
  pageGone: "This form's Facebook Page isn't connected any more. Reconnect it in Settings, then try again.",
  presets: "Start from questions for",
  presetLabels: { generic: "Any business", salon: "Salon", coaching: "Coaching" } as Record<FormPresetKey, string>,
  questions: "Questions",
  questionsHint: `Up to ${MAX_FORM_QUESTIONS} questions, with up to ${MAX_QUALIFYING_QUESTIONS} of your own.`,
  questionCount: (n: number) => `${n} of ${MAX_FORM_QUESTIONS} questions`,
  addQuestion: "Add a question",
  addQuestionPick: "Choose a question to add",
  addEmail: `Add ${promoteText("form.q.EMAIL")}`,
  addOwn: "Add your own question",
  addSuggested: (label: string) => `Add "${label}"`,
  prefilled: "Meta fills this in from their profile.",
  ownLabel: "Your question",
  answers: (list: string) => `Answers: ${list}`,
  moveUp: (label: string) => `Move "${label}" up`,
  moveDown: (label: string) => `Move "${label}" down`,
  remove: (label: string) => `Remove "${label}"`,
  moved: (label: string, position: number) => `"${label}" is now question ${position}.`,
  removed: (label: string) => `Removed "${label}".`,
  added: (label: string) => `Added "${label}".`,
  duplicate: "Each question can be asked only once.",
  customLabel: `Write each of your own questions, up to ${CUSTOM_LABEL_MAX} characters.`,
  formType: "Who should the form find?",
  thankYou: "Button on the thank-you screen",
  thankYouHint: "People see it after they send the form.",
  callNumber: "Phone number people should call",
  callHint: "With the country code, like +91 98765 43210.",
  website: "Website link",
  websiteHint: "It must start with https://",
  waTarget: (link: string) => `Opens a WhatsApp chat with you: ${link}`,
  noWhatsapp: "Connect your WhatsApp number first, or choose Call or Visit website for the thank-you button.",
  badPhone: "Add the phone number people should call, with the country code, like +91 98765 43210.",
  badWebsite: "Add your website link. It must start with https://",
  privacyInvalid: "Enter the full link to your privacy policy, starting with https://",
  privacyTooLong: "The privacy policy link is too long. Use a shorter link.",
  nameTooLong: `Give the form a name of up to ${FORM_NAME_MAX} characters.`,
  noQuestions: "Add at least one question.",
  consent: "WhatsApp consent box",
  consentInclude: "Ask people if they want WhatsApp messages",
  consentPreview: "What people see",
  consentOff: "Without this box, leads from this form can't get WhatsApp messages from you.",
  readiness: promoteText("readiness.leadgen_tos"),
  readinessState: { ok: "Done", missing: "Not yet", unknown: "Not checked yet" } as Record<ReadinessStatus, string>,
  rechecking: "Checking with Meta…",
  recheckOk: "Thanks. Meta's lead ad terms are accepted for this Page.",
  recheckMissing: "Meta still shows the terms as not accepted. It can take a few minutes. Try again, or create the form and Edwyz checks with Meta first.",
  recheckUnknown: "Edwyz couldn't check with Meta just now. You can still create the form: Edwyz checks with Meta first.",
  fixProblems: "Fix these to create the form",
  create: "Create form",
  creating: "Creating the form…",
  confirmCreate: "Yes, create the form",
  confirmQuestions: "Questions",
  confirmPrivacy: "Privacy link",
  confirmThankYou: "Thank-you button",
  confirmConsent: "Consent box",
  confirmNoConsent: "No WhatsApp consent box",
  consentOptionalShort: "optional, never ticked for them",
  created: (name: string, page: string) => `Created the form '${name}' on ${page}.`,
  createFailed: "The form wasn't created",
  dryRun: "Test mode: nothing was sent to Meta.",
  previewTitle: "Preview",
  previewNote: "Our preview (approximate). Meta draws the real form.",
  previewLabel: "Form preview",
  previewScreen: (n: number, total: number, title: string) => `Screen ${n} of ${total}: ${title}`,
  previewPrev: "Previous screen",
  previewNext: "Next screen",
  previewIntro: "Meta shows your Page's name and picture at the top of the form.",
  previewContinue: "Continue",
  previewSubmit: "Submit",
  previewPrivacyLink: "Privacy policy",
  previewEmpty: "Add questions to see them here.",
  agentsOnly: "Only owners and admins can make lead forms. Ask one of them to do this.",
  badAnswers: (n: number) => `Question ${n}: Meta needs ${MIN_OPTIONS} to ${MAX_OPTIONS} answers of up to ${OPTION_TEXT_MAX} characters each. Remove this question, then add it again.`,
  questionProblem: (n: number, message: string) => `Question ${n}: ${message}`,
  copyNotesTitle: "Check this copy",
  copySkipped: (list: string) =>
    `These questions weren't copied: ${list}. A form made here can have up to ${MAX_FORM_QUESTIONS} questions, up to ${MAX_QUALIFYING_QUESTIONS} of them your own, and ${MIN_OPTIONS} to ${MAX_OPTIONS} answers for each question with answers.`,
  copyShortened: (list: string) => `Some answers were cut to fit Meta's limits (${MAX_OPTIONS} answers, ${OPTION_TEXT_MAX} characters each): ${list}. Check them in the preview.`,
  copyEnglish: (locale: string) => `The original form's language (${locale}) can't be used here, so this copy is in English.`,
  andMore: (n: number) => `and ${n} more`,
  confirmLanguage: "Language",
  confirmOtherBoxes: "Other boxes",
  requiredBox: "required",
  unsureTitle: "Check before you try again",
  unsure: "We couldn't tell if Meta made the form. It may already be saved. Check before you try again.",
  unsureNetwork: "The connection dropped before Meta answered. The form may already be saved. Check before you try again.",
  unsureCheck: (name: string, page: string) => `Open Lead forms and choose Import from Meta. If '${name}' is on ${page}, import it from there. Don't create it again here.`,
  unsureLink: "Check my lead forms",
} as const;

/** The thank-you screen and consent section people see. Sent explicitly so the preview matches the form (promote/lead-forms defaults). */
export const THANK_YOU_TITLE = "Thanks! We've got your details.";
export const THANK_YOU_BODY: Record<ThankYouKind, string> = {
  whatsapp: "We'll reply soon. You can also chat with us on WhatsApp now.",
  call: "We'll get back to you soon. You can also call us now.",
  website: "We'll get back to you soon. You can also visit our website.",
};
export const CONSENT_SECTION_TITLE = "WhatsApp messages";
export const consentSectionBody = (business: string) => `Tick the box if you'd like messages from ${business} on WhatsApp. You can reply STOP at any time to stop them.`;
const PRIVACY_LINK_TEXT = "Privacy policy";

const thankYouButton = (kind: ThankYouKind) => promoteText(`form.thank_you.${kind}` as PromoteCopyKey);
export const thankYouLabel = thankYouButton;

// =====================================================================================================================
// Shapes
// =====================================================================================================================

/** An answer of a multiple-choice question. An empty key lets the server make one from the answer (a copy drops keys it can't use). */
export type BuilderOption = { key: string; value: string };
export type BuilderQuestion = { uid: string; type: LeadQuestionType; label: string; key?: string; options?: BuilderOption[] };
export type BuilderThankYou = { kind: ThankYouKind; phone: string; website: string };

/** A box in the consent section. The WhatsApp box is never required; no box is ever ticked for people (D35). */
export type FormBox = { key: string; text: string; required: boolean; checkedByDefault: false };

/**
 * What an edited copy keeps from the stored spec that the builder has no field for (a form Eddy or a draft made): its language,
 * intro, privacy link text, thank-you words (while the button kind is the stored one), and the consent section's words and other
 * boxes. Sent back as they were, so the copy reads like the original.
 */
export type CopyExtras = {
  locale?: string;
  intro?: { title: string | null; lines: string[] };
  privacyLinkText?: string;
  thankYou?: { kind: ThankYouKind; title?: string; body?: string; buttonText?: string };
  disclaimer?: { title?: string; body?: string; consentText?: string; others: FormBox[] };
};

export type BuilderState = {
  name: string;
  preset: FormPresetKey;
  questions: BuilderQuestion[];
  formType: FormType;
  privacyUrl: string;
  thankYou: BuilderThankYou;
  /** Include the optional WhatsApp consent box (on by default, D35). It is never required and never ticked. */
  askConsent: boolean;
  /** Only on an edited copy: what it keeps from the original (CopyExtras). */
  extras?: CopyExtras;
};

/** What the page knows about the workspace and the chosen Page. */
export type BuilderContext = { whatsappNumber: string | null; businessName: string | null; pageName?: string | null };

export type ConsentBox = { key: string; text: string; required: false; checkedByDefault: false };

/** The `spec` body of POST /api/leads/forms/build and /api/leads/forms/{id}/copy. */
export type FormSpecBody = {
  name: string;
  questions: { type: LeadQuestionType; key?: string; label?: string; options?: { key?: string; value: string }[] }[];
  privacyUrl: string;
  privacyLinkText?: string;
  formType: FormType;
  locale: string;
  intro?: { title: string | null; lines: string[] };
  thankYou: { kind: ThankYouKind; title: string; body: string; buttonText: string; url?: string; phone?: string };
  disclaimer: { title: string; body: string; checkboxes: FormBox[] } | null;
};

export type BuilderField = "name" | "questions" | "privacyUrl" | "thankYou" | "consent" | "form";
export type BuilderProblem = { field: BuilderField; message: string };
export type BuildResult = { spec: FormSpecBody; problems: [] } | { spec: null; problems: BuilderProblem[] };

/** One connected Page as the builder page passes it (server-resolved Opens Meta address, never built in the browser). */
export type BuilderPageOption = { id: string; name: string | null; connectionId: string | null; leadgenTos: ReadinessStatus; leadgenHref: string | null };

/** A Page's name for display; a Page Meta gave no name to reads "Your Facebook Page". */
export const pageLabel = (page: Pick<BuilderPageOption, "name"> | null | undefined) => page?.name?.trim() || "Your Facebook Page";
export type BuilderCopySource = { id: string; name: string | null; pageAssetId: string; spec: unknown };
export type BuilderProps = {
  pages: BuilderPageOption[];
  whatsappNumber: string | null;
  verifiedName: string | null;
  privacyUrl: string | null;
  copyFrom: BuilderCopySource | null;
  /** YYYY-MM-DD, for the default name ("Instant form 2026-10-31", as the server names an unnamed form). */
  today: string;
};

// =====================================================================================================================
// Access
// =====================================================================================================================

/** The builder and the Forms page actions: Promote is open to this member and they may write (owners and admins). */
export function canBuildForms(access: Pick<PromoteAccess, "visible" | "canWrite"> | null | undefined): boolean {
  return Boolean(access?.visible && access.canWrite);
}

// =====================================================================================================================
// Questions
// =====================================================================================================================

const CONTACT_TYPES = new Set<string>(LEAD_QUESTIONS.filter((r) => r.contact).map((r) => r.type));
const PREFILL_TYPES = new Set<string>(LEAD_QUESTIONS.filter((r) => r.prefill).map((r) => r.type));
const isQuestionType = (v: unknown): v is LeadQuestionType => typeof v === "string" && (LEAD_QUESTION_TYPES as readonly string[]).includes(v);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The question's text: the owner's own words, else the catalogue name of Meta's question ("Full name"). */
export function questionLabel(q: Pick<BuilderQuestion, "type" | "label">): string {
  if (q.type === "CUSTOM") return q.label.trim() || promoteText("form.q.CUSTOM");
  return q.label.trim() || promoteText(`form.q.${q.type}` as PromoteCopyKey);
}

export const isPrefilled = (type: LeadQuestionType) => PREFILL_TYPES.has(type);
export const isContactQuestion = (type: LeadQuestionType) => CONTACT_TYPES.has(type);

function nextUid(questions: readonly BuilderQuestion[]): string {
  const used = new Set(questions.map((q) => q.uid));
  for (let n = questions.length + 1; ; n++) if (!used.has(`q${n}`)) return `q${n}`;
}

function fromPreset(q: PresetQuestion, uid: string): BuilderQuestion {
  return { uid, type: q.type, label: q.type === "CUSTOM" ? (q.label ?? "") : "", ...(q.key ? { key: q.key } : {}), ...(q.options ? { options: q.options.map((o) => ({ ...o })) } : {}) };
}

/** The questions of a preset as builder questions: Full name, Phone, Email when asked, then the preset's own. */
export function presetBuilderQuestions(preset: FormPresetKey, opts: { email?: boolean } = {}): BuilderQuestion[] {
  return presetQuestions(preset, { email: opts.email }).map((q, i) => fromPreset(q, `q${i + 1}`));
}

/** A new builder state: the generic preset, More people, the saved privacy link, Chat on WhatsApp, and the consent box on. */
export function newBuilderState(opts: { preset?: FormPresetKey; privacyUrl?: string | null; name?: string; whatsappNumber?: string | null } = {}): BuilderState {
  const preset = opts.preset ?? "generic";
  return {
    name: opts.name ?? "",
    preset,
    questions: presetBuilderQuestions(preset),
    formType: "more_volume",
    privacyUrl: opts.privacyUrl ?? "",
    thankYou: { kind: "whatsapp", phone: opts.whatsappNumber ? `+${digitsOf(opts.whatsappNumber)}` : "", website: "" },
    askConsent: true,
  };
}

/** Switches the preset: the list becomes the preset's questions, keeping Email when it was asked. */
export function applyPreset(state: BuilderState, preset: FormPresetKey): BuilderState {
  const email = state.questions.some((q) => q.type === "EMAIL");
  return { ...state, preset, questions: presetBuilderQuestions(preset, { email }) };
}

export type AddResult = { state: BuilderState; error: string | null };

/** Adds a question at the end, refusing a 16th question, a 4th question of the owner's own, and a repeated Meta question. */
export function addQuestion(state: BuilderState, q: { type: LeadQuestionType; label?: string; key?: string; options?: { key: string; value: string }[] }): AddResult {
  if (state.questions.length >= MAX_FORM_QUESTIONS) return { state, error: promoteText("form.max_questions") };
  if (q.type === "CUSTOM") {
    if (state.questions.filter((x) => x.type === "CUSTOM").length >= MAX_QUALIFYING_QUESTIONS) return { state, error: promoteText("form.max_qualifying") };
    if (q.key && state.questions.some((x) => x.key === q.key)) return { state, error: FORM_BUILDER_TEXT.duplicate };
  } else if (state.questions.some((x) => x.type === q.type)) {
    return { state, error: FORM_BUILDER_TEXT.duplicate };
  }
  const added: BuilderQuestion = {
    uid: nextUid(state.questions),
    type: q.type,
    label: q.type === "CUSTOM" ? (q.label ?? "") : "",
    ...(q.key ? { key: q.key } : {}),
    ...(q.options ? { options: q.options.map((o) => ({ ...o })) } : {}),
  };
  return { state: { ...state, questions: [...state.questions, added] }, error: null };
}

/** Moves a question one place up (-1) or down (+1). Out of range does nothing. */
export function moveQuestion(state: BuilderState, index: number, delta: -1 | 1): BuilderState {
  const to = index + delta;
  if (index < 0 || index >= state.questions.length || to < 0 || to >= state.questions.length) return state;
  const questions = [...state.questions];
  [questions[index], questions[to]] = [questions[to], questions[index]];
  return { ...state, questions };
}

/** Moves a question from one place to another (drag and drop). */
export function reorderQuestion(state: BuilderState, from: number, to: number): BuilderState {
  if (from === to || from < 0 || to < 0 || from >= state.questions.length || to >= state.questions.length) return state;
  const questions = [...state.questions];
  const [moved] = questions.splice(from, 1);
  questions.splice(to, 0, moved);
  return { ...state, questions };
}

export function removeQuestion(state: BuilderState, uid: string): BuilderState {
  return { ...state, questions: state.questions.filter((q) => q.uid !== uid) };
}

export function setQuestionLabel(state: BuilderState, uid: string, label: string): BuilderState {
  return { ...state, questions: state.questions.map((q) => (q.uid === uid && q.type === "CUSTOM" ? { ...q, label: label.slice(0, CUSTOM_LABEL_MAX) } : q)) };
}

export type QuestionChip = { id: string; label: string; question: { type: LeadQuestionType; label?: string; key?: string; options?: { key: string; value: string }[] } };

/** The one-tap chips: Email when it isn't asked yet, then the preset's suggestions that aren't on the list. */
export function suggestionChips(state: BuilderState): QuestionChip[] {
  const out: QuestionChip[] = [];
  if (!state.questions.some((q) => q.type === "EMAIL")) out.push({ id: "email", label: FORM_BUILDER_TEXT.addEmail, question: { type: "EMAIL" } });
  for (const s of presetSuggestions(state.preset)) {
    if (s.key && state.questions.some((q) => q.key === s.key)) continue;
    out.push({ id: s.key ?? s.type, label: FORM_BUILDER_TEXT.addSuggested(s.label ?? ""), question: { type: "CUSTOM", label: s.label, key: s.key, options: s.options } });
  }
  return out;
}

/** Meta's ready-made questions not on the list yet, for the "Add a question" menu (Email first when missing). */
export function addableQuestionTypes(state: BuilderState): LeadQuestionType[] {
  const used = new Set(state.questions.map((q) => q.type));
  return LEAD_QUESTION_TYPES.filter((t) => t !== "CUSTOM" && !used.has(t));
}

export const presetKeys = (): readonly FormPresetKey[] => FORM_PRESET_KEYS;

// =====================================================================================================================
// Privacy link, phone, wa.me
// =====================================================================================================================

/** What is wrong with the privacy link, in plain words, or null (the rules of promote/settings.privacyUrlProblem). */
export function checkPrivacyUrl(value: unknown): string | null {
  if (value === undefined || value === null || (typeof value === "string" && !value.trim())) return promoteText("form.privacy_help");
  if (typeof value !== "string") return FORM_BUILDER_TEXT.privacyInvalid;
  const text = value.trim();
  if (text.length > PRIVACY_URL_MAX) return FORM_BUILDER_TEXT.privacyTooLong;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return /^https?:/i.test(text) ? FORM_BUILDER_TEXT.privacyInvalid : promoteText("form.privacy_https");
  }
  if (url.protocol !== "https:") return promoteText("form.privacy_https");
  if (url.username || url.password || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(url.hostname)) return FORM_BUILDER_TEXT.privacyInvalid;
  return null;
}

const digitsOf = (phone: string | null | undefined) => (phone ?? "").replace(/[^0-9]/g, "");

/** A wa.me link to a WhatsApp number ("+91 98765 43210" -> https://wa.me/919876543210), or null when it isn't a number. */
export function waMeLink(number: string | null | undefined): string | null {
  const digits = digitsOf(number);
  return /^[1-9][0-9]{6,14}$/.test(digits) ? `https://wa.me/${digits}` : null;
}

/** A phone number with its country code in E.164 (+919876543210), or null. */
export function e164(phone: string | null | undefined): string | null {
  const normal = (phone ?? "").trim().replace(/[\s()-]/g, "");
  return /^\+[1-9][0-9]{7,14}$/.test(normal) ? normal : null;
}

function httpsWebsite(value: string): string | null {
  const given = value.trim();
  if (!given || given.length > 2000) return null;
  try {
    const u = new URL(given);
    return u.protocol === "https:" && !u.username && !u.password && /\./.test(u.hostname) ? u.toString() : null;
  } catch {
    return null;
  }
}

/** The business name in the consent box: the Page's name, else the WhatsApp display name, else "us". */
export const businessOf = (ctx: BuilderContext) => ctx.businessName?.trim() || "us";

/** The WhatsApp consent box (D35): key whatsapp_opt_in, optional, never ticked in advance. No required option exists. */
export function consentBox(businessName: string | null | undefined): ConsentBox {
  return { key: CONSENT_CHECKBOX.key, text: promoteText("form.consent_text", { business: businessName?.trim() || "us" }), required: false, checkedByDefault: false };
}

/** The thank-you screen's words: a copy's own words while its button kind is the original's, else ours for the kind. */
export function thankYouWords(state: Pick<BuilderState, "thankYou" | "extras">): { title: string; body: string; buttonText: string } {
  const kind = state.thankYou.kind;
  const kept = state.extras?.thankYou?.kind === kind ? state.extras.thankYou : undefined;
  return { title: kept?.title || THANK_YOU_TITLE, body: kept?.body || THANK_YOU_BODY[kind], buttonText: kept?.buttonText || thankYouButton(kind) };
}

/** The consent section: its title and body, the WhatsApp box (a copy keeps its words), and a copy's other boxes, never ticked. */
export function consentWords(state: Pick<BuilderState, "extras">, ctx: BuilderContext): { title: string; body: string; box: ConsentBox; others: FormBox[] } {
  const business = businessOf(ctx);
  const kept = state.extras?.disclaimer;
  const box = consentBox(business);
  return {
    title: kept?.title || CONSENT_SECTION_TITLE,
    body: kept?.body || consentSectionBody(business),
    box: kept?.consentText ? { ...box, text: kept.consentText } : box,
    others: (kept?.others ?? []).map((b) => ({ key: b.key, text: b.text, required: b.required === true, checkedByDefault: false as const })),
  };
}

/** Where the thank-you button goes, or null with the reason in `problem`. */
export function thankYouTarget(t: BuilderThankYou, ctx: BuilderContext): { url?: string; phone?: string; display: string } | { problem: string } {
  if (t.kind === "whatsapp") {
    const url = waMeLink(ctx.whatsappNumber);
    return url ? { url, display: url } : { problem: FORM_BUILDER_TEXT.noWhatsapp };
  }
  if (t.kind === "call") {
    const phone = e164(t.phone);
    return phone ? { phone, display: phone } : { problem: FORM_BUILDER_TEXT.badPhone };
  }
  const url = httpsWebsite(t.website);
  return url ? { url, display: url } : { problem: FORM_BUILDER_TEXT.badWebsite };
}

// =====================================================================================================================
// The spec
// =====================================================================================================================

/** The default form name, as the server names an unnamed form: "Instant form 2026-10-31". */
export const defaultFormName = (today: string) => `${promoteText("form.title")} ${today}`;

/**
 * The spec from the UI state, or every problem in plain words, each tied to the field it belongs to. Nothing here calls the
 * network. The consent box is always optional and unticked; the form type and the thank-you target come from the state.
 */
export function buildFormSpec(state: BuilderState, ctx: BuilderContext, opts: { today?: string } = {}): BuildResult {
  const problems: BuilderProblem[] = [];
  const add = (field: BuilderField, message: string) => {
    if (!problems.some((p) => p.field === field && p.message === message)) problems.push({ field, message });
  };

  const name = state.name.trim().replace(/\s+/g, " ") || defaultFormName(opts.today ?? new Date().toISOString().slice(0, 10));
  if (name.length > FORM_NAME_MAX) add("name", FORM_BUILDER_TEXT.nameTooLong);

  const qs = state.questions;
  if (qs.length === 0) add("questions", FORM_BUILDER_TEXT.noQuestions);
  if (qs.length > MAX_FORM_QUESTIONS) add("questions", promoteText("form.max_questions"));
  if (qs.filter((q) => q.type === "CUSTOM").length > MAX_QUALIFYING_QUESTIONS) add("questions", promoteText("form.max_qualifying"));
  if (qs.length > 0 && !qs.some((q) => isContactQuestion(q.type))) add("questions", promoteText("form.needs_contact"));
  const seen = new Set<string>();
  qs.forEach((q, i) => {
    if (!isQuestionType(q.type)) add("questions", promoteText("draft.bad_value"));
    else if (q.type !== "CUSTOM") {
      if (seen.has(q.type)) add("questions", FORM_BUILDER_TEXT.duplicate);
      seen.add(q.type);
    } else {
      if (!q.label.trim() || q.label.trim().length > CUSTOM_LABEL_MAX) add("questions", FORM_BUILDER_TEXT.customLabel);
      // The answers as the server checks them, so a bad one is named here and not refused by Meta's rules later.
      if (q.options?.length && !answersOk(q.options)) add("questions", FORM_BUILDER_TEXT.badAnswers(i + 1));
    }
  });

  const privacyProblem = checkPrivacyUrl(state.privacyUrl);
  if (privacyProblem) add("privacyUrl", privacyProblem);

  if (!(FORM_TYPE_VALUES as readonly string[]).includes(state.formType)) add("form", promoteText("draft.bad_value"));

  const target = thankYouTarget(state.thankYou, ctx);
  if ("problem" in target) add("thankYou", target.problem);

  if (problems.length > 0 || "problem" in target) return { spec: null, problems };

  const kind = state.thankYou.kind;
  const words = thankYouWords(state);
  const consent = consentWords(state, ctx);
  const extras = state.extras;
  return {
    spec: {
      name,
      questions: qs.map((q) =>
        q.type === "CUSTOM"
          ? {
              type: q.type,
              ...(q.key ? { key: q.key } : {}),
              label: q.label.trim(),
              ...(q.options?.length ? { options: q.options.map((o) => (o.key ? { key: o.key, value: o.value.trim() } : { value: o.value.trim() })) } : {}),
            }
          : { type: q.type },
      ),
      privacyUrl: state.privacyUrl.trim(),
      ...(extras?.privacyLinkText ? { privacyLinkText: extras.privacyLinkText } : {}),
      formType: state.formType,
      locale: extras?.locale ?? "en_US",
      ...(extras?.intro ? { intro: { title: extras.intro.title, lines: [...extras.intro.lines] } } : {}),
      thankYou: { kind, ...words, ...(target.url ? { url: target.url } : {}), ...(target.phone ? { phone: target.phone } : {}) },
      disclaimer: state.askConsent
        ? { title: consent.title, body: consent.body, checkboxes: [consent.box, ...consent.others] }
        : consent.others.length
          ? { title: consent.title, body: consent.body, checkboxes: consent.others }
          : null,
    },
    problems: [],
  };
}

/** Answers the server takes: 2 to 20, each with text of up to 100 characters, and a key (when given) of small letters, digits and _. */
function answersOk(options: readonly BuilderOption[]): boolean {
  if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) return false;
  return options.every((o) => {
    const value = typeof o.value === "string" ? o.value.trim() : "";
    return value.length > 0 && value.length <= OPTION_TEXT_MAX && (!o.key || OPTION_KEY.test(o.key));
  });
}

/** The first problem of each field, for the field's own error line. */
export function problemsByField(problems: readonly BuilderProblem[]): Partial<Record<BuilderField, string>> {
  const out: Partial<Record<BuilderField, string>> = {};
  for (const p of problems) out[p.field] ??= p.message;
  return out;
}

/**
 * The server's problems (validateSpec fields such as "questions.2" or "thankYou.url") as builder fields. A problem with one
 * question keeps its number ("Question 3: …"), so the owner knows which question to fix.
 */
export function problemsFromServer(problems: unknown): BuilderProblem[] {
  if (!Array.isArray(problems)) return [];
  const out: BuilderProblem[] = [];
  for (const p of problems) {
    if (!isObject(p) || typeof p.message !== "string") continue;
    const f = typeof p.field === "string" ? p.field : "";
    const question = /^questions\.(\d{1,3})(\.|$)/.exec(f);
    if (question) {
      out.push({ field: "questions", message: FORM_BUILDER_TEXT.questionProblem(Number(question[1]) + 1, p.message.slice(0, 500)) });
      continue;
    }
    const field: BuilderField = f.startsWith("questions")
      ? "questions"
      : f.startsWith("privacy")
        ? "privacyUrl"
        : f.startsWith("thankYou")
          ? "thankYou"
          : f.startsWith("disclaimer")
            ? "consent"
            : f === "name"
              ? "name"
              : "form";
    out.push({ field, message: p.message.slice(0, 500) });
  }
  return out;
}

/** An edited copy's start: the builder state, and what could not be carried over, in plain words for the builder's notice. */
export type CopyStart = {
  state: BuilderState;
  /** Questions left out: past 15, a 4th of the owner's own, a repeated Meta question, or answers Meta won't take. */
  skipped: string[];
  /** Questions whose answers were cut to Meta's limits (20 answers, 100 characters each). */
  shortened: string[];
  /** The original's language when Meta doesn't offer forms in it here (the copy is in English). */
  droppedLocale: string | null;
};

const oneLine = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, max).trim() : "");

/**
 * A copy's answers as the server takes them: empty answers left out, at most 20, each cut to 100 characters, and a key the
 * server would refuse dropped (it makes its own). null when fewer than 2 answers are left, so the question can't be copied.
 */
function copyAnswers(raw: unknown): { options: BuilderOption[]; cut: boolean } | null {
  if (!Array.isArray(raw) || raw.length === 0) return { options: [], cut: false };
  const options: BuilderOption[] = [];
  let cut = false;
  for (const o of raw) {
    const full = oneLine(isObject(o) ? o.value : o, 10_000);
    if (!full || options.length >= MAX_OPTIONS) {
      cut = true;
      continue;
    }
    const value = full.slice(0, OPTION_TEXT_MAX).trim();
    if (value !== full) cut = true;
    const key = isObject(o) && typeof o.key === "string" && OPTION_KEY.test(o.key) ? o.key : "";
    options.push({ key, value });
  }
  return options.length >= MIN_OPTIONS ? { options, cut } : null;
}

/** What a copy keeps that the builder has no field for (CopyExtras), or undefined when there is nothing. */
function extrasOf(spec: Record<string, unknown>): { extras: CopyExtras | undefined; droppedLocale: string | null } {
  const extras: CopyExtras = {};
  let droppedLocale: string | null = null;
  if (typeof spec.locale === "string" && spec.locale && spec.locale !== "en_US") {
    if ((FORM_LOCALES as readonly string[]).includes(spec.locale)) extras.locale = spec.locale;
    else droppedLocale = spec.locale.slice(0, 20);
  }
  if (isObject(spec.intro)) {
    const lines = (Array.isArray(spec.intro.lines) ? spec.intro.lines : []).map((l) => oneLine(l, 1_000)).filter(Boolean);
    const title = oneLine(spec.intro.title, 1_000) || null;
    if (title || lines.length) extras.intro = { title, lines };
  }
  const linkText = oneLine(spec.privacyLinkText, 1_000);
  if (linkText && linkText !== PRIVACY_LINK_TEXT) extras.privacyLinkText = linkText;
  const t = isObject(spec.thankYou) ? spec.thankYou : null;
  if (t && (THANK_YOU_KINDS as readonly unknown[]).includes(t.kind)) {
    const words = { title: oneLine(t.title, 1_000), body: typeof t.body === "string" ? t.body.trim() : "", buttonText: oneLine(t.buttonText, 1_000) };
    const kept = Object.fromEntries(Object.entries(words).filter(([, v]) => v)) as { title?: string; body?: string; buttonText?: string };
    if (Object.keys(kept).length) extras.thankYou = { kind: t.kind as ThankYouKind, ...kept };
  }
  const d = isObject(spec.disclaimer) ? spec.disclaimer : null;
  if (d) {
    const boxes = Array.isArray(d.checkboxes) ? d.checkboxes.filter(isObject) : [];
    const consentText = oneLine(boxes.find((b) => b.key === CONSENT_CHECKBOX.key)?.text, 1_000);
    const others: FormBox[] = boxes
      .filter((b) => typeof b.key === "string" && b.key !== CONSENT_CHECKBOX.key && QUESTION_KEY.test(b.key) && oneLine(b.text, 1_000))
      .slice(0, MAX_BOXES - 1)
      .map((b) => ({ key: b.key as string, text: oneLine(b.text, 1_000), required: b.required === true || b.is_required === true, checkedByDefault: false }));
    const title = oneLine(d.title, 1_000);
    const body = typeof d.body === "string" ? d.body.trim() : "";
    if (title || body || consentText || others.length) {
      extras.disclaimer = { ...(title ? { title } : {}), ...(body ? { body } : {}), ...(consentText ? { consentText } : {}), others };
    }
  }
  return { extras: Object.keys(extras).length ? extras : undefined, droppedLocale };
}

/**
 * An edited copy's start from a stored spec (a form built here, by Eddy, for a draft, or imported from Meta): its questions,
 * privacy link, form type, thank-you and consent box, and what it keeps from the original (CopyExtras). A question that a form
 * made here can't have is left out and named in `skipped`; answers cut to Meta's limits are named in `shortened`. Never silent.
 */
export function copyFromSpec(spec: unknown, opts: { name: string; whatsappNumber?: string | null; privacyUrl?: string | null }): CopyStart {
  const base = newBuilderState({ privacyUrl: opts.privacyUrl ?? null, name: opts.name, whatsappNumber: opts.whatsappNumber });
  if (!isObject(spec)) return { state: base, skipped: [], shortened: [], droppedLocale: null };
  const questions: BuilderQuestion[] = [];
  const skipped: string[] = [];
  const shortened: string[] = [];
  const keys = new Set<string>();
  for (const raw of Array.isArray(spec.questions) ? spec.questions : []) {
    if (!isObject(raw)) continue;
    const label = oneLine(raw.label, CUSTOM_LABEL_MAX);
    if (!isQuestionType(raw.type)) {
      if (label) skipped.push(label);
      continue;
    }
    const type = raw.type;
    const name = questionLabel({ type, label });
    if (questions.length >= MAX_FORM_QUESTIONS || (type !== "CUSTOM" && questions.some((q) => q.type === type))) {
      skipped.push(name);
      continue;
    }
    if (type !== "CUSTOM") {
      questions.push({ uid: `q${questions.length + 1}`, type, label: "" });
      continue;
    }
    if (questions.filter((q) => q.type === "CUSTOM").length >= MAX_QUALIFYING_QUESTIONS) {
      skipped.push(name);
      continue;
    }
    const answers = copyAnswers(raw.options);
    if (!answers) {
      skipped.push(name);
      continue;
    }
    if (answers.cut) shortened.push(name);
    // A key the server would refuse, or one already used, is left out: the server makes one from the question.
    const key = typeof raw.key === "string" && QUESTION_KEY.test(raw.key) && !keys.has(raw.key) ? raw.key : null;
    if (key) keys.add(key);
    questions.push({ uid: `q${questions.length + 1}`, type, label, ...(key ? { key } : {}), ...(answers.options.length ? { options: answers.options } : {}) });
  }
  const t = isObject(spec.thankYou) ? spec.thankYou : {};
  const kind: ThankYouKind = (THANK_YOU_KINDS as readonly unknown[]).includes(t.kind) ? (t.kind as ThankYouKind) : "whatsapp";
  const privacy = typeof spec.privacyUrl === "string" && spec.privacyUrl.trim() ? spec.privacyUrl.trim() : base.privacyUrl;
  const { extras, droppedLocale } = extrasOf(spec);
  const d = spec.disclaimer;
  const state: BuilderState = {
    ...base,
    preset: "generic",
    questions: questions.length ? questions : base.questions,
    formType: spec.formType === "higher_intent" ? "higher_intent" : "more_volume",
    privacyUrl: privacy,
    thankYou: {
      kind,
      phone: kind === "call" && typeof t.phone === "string" ? t.phone : base.thankYou.phone,
      website: kind === "website" && typeof t.url === "string" ? t.url : "",
    },
    // A stored spec without a consent section (disclaimer null), or whose section has no WhatsApp box, stays without it. A spec
    // that says nothing (an imported form) gets the box, as a new form does (D35: on by default).
    askConsent: d === null ? false : isObject(d) && Array.isArray(d.checkboxes) ? d.checkboxes.some((b) => isObject(b) && b.key === CONSENT_CHECKBOX.key) : true,
    ...(extras ? { extras } : {}),
  };
  return { state, skipped, shortened, droppedLocale };
}

/** A builder state from a stored spec (a copy to edit); copyFromSpec also says what was left out. */
export function stateFromSpec(spec: unknown, opts: { name: string; whatsappNumber?: string | null; privacyUrl?: string | null }): BuilderState {
  return copyFromSpec(spec, opts).state;
}

/** "A", "B" and "C", or the first five and "and N more". */
export function listNames(names: readonly string[], max = 5): string {
  const quoted = names.slice(0, max).map((n) => `"${n}"`);
  if (names.length > max) quoted.push(FORM_BUILDER_TEXT.andMore(names.length - max));
  return quoted.join(", ");
}

/** The notice an edited copy shows when something wasn't carried over, one line each; empty when everything was. */
export function copyNotes(start: Pick<CopyStart, "skipped" | "shortened" | "droppedLocale">): string[] {
  const out: string[] = [];
  if (start.skipped.length) out.push(FORM_BUILDER_TEXT.copySkipped(listNames(start.skipped)));
  if (start.shortened.length) out.push(FORM_BUILDER_TEXT.copyShortened(listNames(start.shortened)));
  if (start.droppedLocale) out.push(FORM_BUILDER_TEXT.copyEnglish(start.droppedLocale));
  return out;
}

/** The name an edited copy starts with: "{name} (copy)", as the server names a copy. */
export function copyName(name: string | null | undefined): string {
  const base = (name?.trim() || promoteText("form.title")).slice(0, FORM_NAME_MAX - 7);
  return `${base} (copy)`;
}

// =====================================================================================================================
// The confirm dialog (6.5 create_lead_form, copy_lead_form: irreversible, danger, focus on Cancel first)
// =====================================================================================================================

export type CreateConfirmCopy = {
  title: string;
  questions: string[];
  privacyUrl: string;
  thankYou: string;
  consent: string;
  warning: string;
  /** Only when the form isn't in English (a copy keeps the original's language). */
  language?: string;
  /** Only when a copy keeps other boxes from the original. */
  otherBoxes?: string[];
};

/** "Create the form '{name}' on {Page}?" with the questions, the privacy link, the thank-you button and the consent text. */
export function createConfirmCopy(spec: FormSpecBody, pageName: string): CreateConfirmCopy {
  const t = spec.thankYou;
  const consent = spec.disclaimer?.checkboxes.find((c) => c.key === CONSENT_CHECKBOX.key)?.text ?? null;
  const others = spec.disclaimer?.checkboxes.filter((c) => c.key !== CONSENT_CHECKBOX.key) ?? [];
  return {
    title: `Create the form '${spec.name}' on ${pageName.trim() || "your Page"}?`,
    questions: spec.questions.map((q) => questionLabel({ type: q.type, label: q.label ?? "" })),
    privacyUrl: spec.privacyUrl,
    thankYou: `${t.buttonText}: ${t.url ?? t.phone ?? ""}`,
    consent: consent ? `${consent} (${FORM_BUILDER_TEXT.consentOptionalShort})` : FORM_BUILDER_TEXT.confirmNoConsent,
    warning: promoteText("form.permanent_note"),
    ...(spec.locale && spec.locale !== "en_US" ? { language: spec.locale } : {}),
    ...(others.length ? { otherBoxes: others.map((c) => (c.required ? `${c.text} (${FORM_BUILDER_TEXT.requiredBox})` : c.text)) } : {}),
  };
}

// =====================================================================================================================
// The preview (LeadFormPreview): the form's 4 screens, in order
// =====================================================================================================================

export const PREVIEW_SCREEN_KEYS = ["intro", "questions", "privacy", "thank_you"] as const;
export type PreviewScreenKey = (typeof PREVIEW_SCREEN_KEYS)[number];

export type PreviewScreen =
  | { key: "intro"; title: string; pageName: string; note: string; higherIntent: boolean; intro: { title: string | null; lines: string[] } | null }
  | { key: "questions"; title: string; questions: { label: string; prefilled: boolean; options: string[] }[] }
  | {
      key: "privacy";
      title: string;
      linkText: string;
      url: string;
      consent: { title: string; body: string; text: string; checked: false; required: false } | null;
      /** A copy's other boxes, drawn unticked; `section` is the consent section's words when only these are left. */
      others: { text: string; required: boolean; checked: false }[];
      section: { title: string; body: string } | null;
    }
  | { key: "thank_you"; title: string; heading: string; body: string; button: string; target: string | null };

/** The 4 screens people see, in order: intro, questions, privacy and thank-you. Every box is shown unticked. */
export function previewScreens(state: BuilderState, ctx: BuilderContext): PreviewScreen[] {
  const business = businessOf(ctx);
  const target = thankYouTarget(state.thankYou, ctx);
  const consent = consentWords(state, ctx);
  const words = thankYouWords(state);
  const intro = state.extras?.intro ?? null;
  return [
    {
      key: "intro",
      title: promoteText("form.screen.intro"),
      pageName: ctx.pageName?.trim() || business,
      note: FORM_BUILDER_TEXT.previewIntro,
      higherIntent: state.formType === "higher_intent",
      intro: intro ? { title: intro.title, lines: [...intro.lines] } : null,
    },
    {
      key: "questions",
      title: promoteText("form.screen.questions"),
      questions: state.questions.map((q) => ({ label: questionLabel(q), prefilled: isPrefilled(q.type), options: (q.options ?? []).map((o) => o.value) })),
    },
    {
      key: "privacy",
      title: promoteText("form.screen.privacy"),
      linkText: state.extras?.privacyLinkText || PRIVACY_LINK_TEXT,
      url: state.privacyUrl.trim(),
      consent: state.askConsent ? { title: consent.title, body: consent.body, text: consent.box.text, checked: false, required: false } : null,
      others: consent.others.map((b) => ({ text: b.text, required: b.required, checked: false as const })),
      section: !state.askConsent && consent.others.length ? { title: consent.title, body: consent.body } : null,
    },
    {
      key: "thank_you",
      title: promoteText("form.screen.thank_you"),
      heading: words.title,
      body: words.body,
      button: words.buttonText,
      target: "problem" in target ? null : target.display,
    },
  ];
}

/** The screen an arrow key moves to: Left/Up back, Right/Down on, Home first, End last; no wrapping. null for other keys. */
export function nextScreenIndex(current: number, key: string, count: number): number | null {
  if (count <= 0) return null;
  const last = count - 1;
  const at = Math.min(Math.max(current, 0), last);
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return Math.min(at + 1, last);
    case "ArrowLeft":
    case "ArrowUp":
      return Math.max(at - 1, 0);
    case "Home":
      return 0;
    case "End":
      return last;
    default:
      return null;
  }
}

// =====================================================================================================================
// Lead Gen terms: [I've accepted] re-reads the field
// =====================================================================================================================

export type RecheckDeps = {
  get: <T>(path: string) => Promise<T>;
  post: <T>(path: string, body: unknown) => Promise<T>;
};

/** The leadgen_tos row's status in a GET /api/promote/prereqs answer, or unknown. */
export function leadgenStatusOf(answer: unknown): ReadinessStatus {
  const rows = isObject(answer) && Array.isArray(answer.rows) ? answer.rows : [];
  const row = rows.find((r) => isObject(r) && r.check === "leadgen_tos");
  const status = isObject(row) ? row.status : null;
  return status === "ok" || status === "missing" ? status : "unknown";
}

/**
 * [I've accepted]: asks Meta again through the connection's refresh (discovery re-reads the Page's lead ad terms), then reads
 * the readiness row. A refresh that fails still re-reads what is stored. Never throws: unknown when nothing could be read.
 */
export async function recheckLeadgenTerms(page: Pick<BuilderPageOption, "id" | "connectionId">, deps: RecheckDeps): Promise<ReadinessStatus> {
  if (page.connectionId) {
    try {
      await deps.post("/api/meta-connect/refresh", { connectionId: page.connectionId });
    } catch {
      // Read what is stored.
    }
  }
  try {
    return leadgenStatusOf(await deps.get(`/api/promote/prereqs?goal=lead_form&pageAssetId=${encodeURIComponent(page.id)}`));
  } catch {
    return "unknown";
  }
}

export function recheckMessage(status: ReadinessStatus): string {
  return status === "ok" ? FORM_BUILDER_TEXT.recheckOk : status === "missing" ? FORM_BUILDER_TEXT.recheckMissing : FORM_BUILDER_TEXT.recheckUnknown;
}

// =====================================================================================================================
// Create (POST /api/leads/forms/build or /api/leads/forms/{id}/copy): sent once, never again after an unclear answer
// =====================================================================================================================

export type CreateRequest = { path: string; body: { pageAssetId?: string; spec: FormSpecBody } };

/** A new form goes to /build on the chosen Page; an edited copy to /{id}/copy (the server keeps the original's Page). */
export function createRequest(copyFromId: string | null | undefined, pageAssetId: string, spec: FormSpecBody): CreateRequest {
  return copyFromId ? { path: `/api/leads/forms/${encodeURIComponent(copyFromId)}/copy`, body: { spec } } : { path: "/api/leads/forms/build", body: { pageAssetId, spec } };
}

/**
 * The answer to a create. `unsure`: the form may already be on Meta, and a form there can never be changed or deleted, so the
 * builder must not offer Create again. That is a 504 (Meta didn't confirm in time), a 500 (it can fail after Meta made the form),
 * any 5xx that isn't our own answer (a proxy's page), or a connection that dropped before an answer came.
 */
export type CreateAnswer =
  | { ok: true; dryRun: boolean }
  | { ok: false; unsure: true; message: string }
  | { ok: false; unsure: false; message: string; code: string | null; problems: unknown };

export type CreateFetch = (path: string, init: { method: string; headers: Record<string, string>; body: string; credentials: "same-origin" }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** Sends the create once and reads the answer. Never throws and never retries. */
export async function sendCreate(req: CreateRequest, fetcher: CreateFetch): Promise<CreateAnswer> {
  let res: Awaited<ReturnType<CreateFetch>>;
  try {
    res = await fetcher(req.path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req.body), credentials: "same-origin" });
  } catch {
    return { ok: false, unsure: true, message: FORM_BUILDER_TEXT.unsureNetwork };
  }
  const json = await res.json().catch(() => null);
  const body = isObject(json) ? json : {};
  if (res.ok) return { ok: true, dryRun: body.dryRun === true };
  const error = typeof body.error === "string" && body.error.trim() ? body.error.trim().slice(0, 500) : null;
  if (res.status === 504) return { ok: false, unsure: true, message: error ?? FORM_BUILDER_TEXT.unsure };
  if (res.status === 500 || (res.status > 500 && !error)) return { ok: false, unsure: true, message: FORM_BUILDER_TEXT.unsure };
  return { ok: false, unsure: false, message: error ?? "Something went wrong. Try again.", code: typeof body.code === "string" ? body.code : null, problems: body.problems };
}

/** Runs `run` unless a run is already going (a fast double tap). Resolves undefined for the ignored call. */
export async function runOnce<T>(lock: { current: boolean }, run: () => Promise<T>): Promise<T | undefined> {
  if (lock.current) return undefined;
  lock.current = true;
  try {
    return await run();
  } finally {
    lock.current = false;
  }
}
