import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The instant-form builder (docs/IG-PAGE-ADS-SPEC.md 3.5 step 2, 6.5 create_lead_form, 7.1, 7.3, 7.6, D13, D35, PRM-15 / PRM-LF):
 * the pure form-builder-helpers (spec from the UI state, limits, privacy link, consent box, form type, wa.me thank-you, the 4
 * preview screens), the FormStep and preview markup, the grep rules over the new and changed files, and the builder page's
 * promoteAccess gate. Nothing reaches Meta or a database.
 */

const jar = vi.hoisted(() => ({ cookies: [] as { name: string; value: string }[] }));
vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => jar.cookies }) }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  },
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children?: ReactNode }) => createElement("a", { href, ...rest }, children),
}));
const auth = vi.hoisted(() => ({ getActor: vi.fn() }));
vi.mock("@/lib/auth", () => auth);
const db = vi.hoisted(() => ({
  metaAsset: { findMany: vi.fn() },
  phoneNumber: { findFirst: vi.fn() },
  platformSetting: { findUnique: vi.fn() },
  leadForm: { findFirst: vi.fn() },
  user: { findUnique: vi.fn() },
  spendControl: { findUnique: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: db }));

import NewLeadFormPage from "@/app/(app)/app/leads/forms/new/page";
import { CREATE_BAR_CLASS, CreateUnsureNotice, FormStep, LeadFormBuilder } from "@/components/promote/FormStep";
import { LeadFormPreview } from "@/components/promote/LeadFormPreview";
import {
  addQuestion,
  applyPreset,
  buildFormSpec,
  canBuildForms,
  checkPrivacyUrl,
  consentBox,
  copyFromSpec,
  copyName,
  copyNotes,
  createConfirmCopy,
  createRequest,
  defaultFormName,
  FORM_BUILDER_TEXT,
  FORM_LOCALES,
  leadgenStatusOf,
  moveQuestion,
  newBuilderState,
  nextScreenIndex,
  previewScreens,
  problemsByField,
  problemsFromServer,
  recheckLeadgenTerms,
  removeQuestion,
  reorderQuestion,
  runOnce,
  sendCreate,
  setQuestionLabel,
  stateFromSpec,
  suggestionChips,
  waMeLink,
  type BuilderContext,
  type BuilderState,
  type CreateFetch,
} from "@/components/promote/form-builder-helpers";
import { LEAD_QUESTION_TYPES } from "@/lib/promote/catalog/lead-questions";
import { promoteText } from "@/lib/promote/copy";
import { promoteAccess } from "@/lib/promote/flags";
import { FORM_LOCALES as SERVER_FORM_LOCALES, LEAD_FORM_COPY, validateSpec } from "@/lib/promote/lead-forms";
import { metaScreenHref } from "@/lib/meta-connect/meta-screens";

const ROOT = path.resolve(__dirname, "..");
const CTX: BuilderContext = { whatsappNumber: "+91 98765 43210", businessName: "Sunrise Salon", pageName: "Sunrise Salon" };
const PRIVACY = "https://sunrise.example/privacy";
const TODAY = "2026-10-31";
const ready = (patch: Partial<BuilderState> = {}): BuilderState => ({ ...newBuilderState({ privacyUrl: PRIVACY, name: "Diwali enquiries" }), ...patch });
const html = (el: ReactElement) => renderToStaticMarkup(el).replace(/<!-- -->/g, "");
/** Text as React writes it into markup (apostrophes and quotes escaped). */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;");
const saved = { ...process.env };

beforeEach(() => {
  jar.cookies = [{ name: "wa_access", value: "token" }];
  auth.getActor.mockReset();
  for (const table of Object.values(db)) for (const fn of Object.values(table)) fn.mockReset();
});
afterEach(() => {
  process.env = { ...saved };
});

// =====================================================================================================================
// The spec from the UI state
// =====================================================================================================================

describe("building the spec from the UI state", () => {
  it("sends the questions, the privacy link, the form type, the thank-you screen and the consent box, and the server accepts it", () => {
    const r = buildFormSpec(ready(), CTX, { today: TODAY });
    expect(r.problems).toEqual([]);
    expect(r.spec).toEqual({
      name: "Diwali enquiries",
      questions: [{ type: "FULL_NAME" }, { type: "PHONE" }],
      privacyUrl: PRIVACY,
      formType: "more_volume",
      locale: "en_US",
      thankYou: {
        kind: "whatsapp",
        title: "Thanks! We've got your details.",
        body: "We'll reply soon. You can also chat with us on WhatsApp now.",
        buttonText: "Chat on WhatsApp",
        url: "https://wa.me/919876543210",
      },
      disclaimer: {
        title: "WhatsApp messages",
        body: "Tick the box if you'd like messages from Sunrise Salon on WhatsApp. You can reply STOP at any time to stop them.",
        checkboxes: [{ key: "whatsapp_opt_in", text: "I agree to get WhatsApp messages from Sunrise Salon", required: false, checkedByDefault: false }],
      },
    });
    // The server's own validation (promote/lead-forms.validateSpec) takes what the page sends, unchanged.
    const server = validateSpec(r.spec, { whatsappNumber: CTX.whatsappNumber, businessName: CTX.businessName });
    expect(server.problems).toEqual([]);
    expect(server.spec?.questions).toEqual([{ type: "FULL_NAME" }, { type: "PHONE" }]);
    expect(server.spec?.thankYou).toMatchObject({ kind: "whatsapp", url: "https://wa.me/919876543210", buttonText: "Chat on WhatsApp" });
    expect(server.spec?.disclaimer?.checkboxes).toEqual([{ key: "whatsapp_opt_in", text: "I agree to get WhatsApp messages from Sunrise Salon", required: false }]);
  });

  it("names an unnamed form as the server does, and keeps the owner's own questions with their keys and answers", () => {
    const salon = applyPreset(ready({ name: "  " }), "salon");
    const r = buildFormSpec(salon, CTX, { today: TODAY });
    expect(r.spec?.name).toBe(defaultFormName(TODAY));
    expect(r.spec?.name).toBe("Instant form 2026-10-31");
    expect(r.spec?.questions.map((q) => q.type)).toEqual(["FULL_NAME", "PHONE", "CUSTOM", "CUSTOM"]);
    expect(r.spec?.questions[2]).toEqual({ type: "CUSTOM", key: "which_service", label: "Which service?" });
    expect(r.spec?.questions[3]).toMatchObject({ type: "CUSTOM", key: "preferred_day", label: "Preferred day" });
    expect(r.spec?.questions[3].options?.map((o) => o.value)).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    expect(validateSpec(r.spec, { whatsappNumber: CTX.whatsappNumber }).problems).toEqual([]);
  });

  it("ties every problem to its field in plain words", () => {
    const empty = buildFormSpec(ready({ questions: [], privacyUrl: "" }), CTX, { today: TODAY });
    expect(empty.spec).toBeNull();
    const byField = problemsByField(empty.problems);
    expect(byField.questions).toBe("Add at least one question.");
    expect(byField.privacyUrl).toBe("Meta needs a link to your privacy policy. Edwyz can't host one for you.");

    const noContact = removeQuestion(ready(), "q2");
    expect(problemsByField(buildFormSpec(noContact, CTX).problems).questions).toBe(promoteText("form.needs_contact"));

    const own = addQuestion(ready(), { type: "CUSTOM", label: "" }).state;
    expect(problemsByField(buildFormSpec(own, CTX).problems).questions).toBe(FORM_BUILDER_TEXT.customLabel);
    const named = setQuestionLabel(own, own.questions[2].uid, "Which flat size?");
    expect(buildFormSpec(named, CTX).problems).toEqual([]);

    expect(problemsByField(buildFormSpec(ready({ name: "x".repeat(101) }), CTX).problems).name).toBe(FORM_BUILDER_TEXT.nameTooLong);
  });

  it("maps the server's problems (validateSpec fields) to the builder's fields", () => {
    expect(
      problemsFromServer([
        { field: "questions.2", message: "a" },
        { field: "privacyUrl", message: "b" },
        { field: "thankYou.url", message: "c" },
        { field: "disclaimer.checkboxes.0", message: "d" },
        { field: "name", message: "e" },
        { field: "locale", message: "f" },
        "junk",
        { field: "x" },
      ]),
    ).toEqual([
      // A problem with one question keeps its number, so the owner knows which question to fix.
      { field: "questions", message: "Question 3: a" },
      { field: "privacyUrl", message: "b" },
      { field: "thankYou", message: "c" },
      { field: "consent", message: "d" },
      { field: "name", message: "e" },
      { field: "form", message: "f" },
    ]);
    expect(problemsFromServer([{ field: "questions", message: "Add at least one question." }])).toEqual([{ field: "questions", message: "Add at least one question." }]);
    expect(problemsFromServer([{ field: "questions.0.options", message: "x" }])).toEqual([{ field: "questions", message: "Question 1: x" }]);
    expect(problemsFromServer(undefined)).toEqual([]);
  });

  it("checks a question's answers as the server does and names the question, before anything is sent", () => {
    const withAnswers = (options: { key: string; value: string }[]) => ({ ...ready(), questions: [...ready().questions, { uid: "q3", type: "CUSTOM" as const, label: "Budget?", options }] });
    const bad = [
      [{ key: "a", value: "Only one" }],
      Array.from({ length: 21 }, (_, i) => ({ key: `a${i}`, value: `Answer ${i}` })),
      [{ key: "a", value: "x".repeat(101) }, { key: "b", value: "Fine" }],
      [{ key: "a", value: "  " }, { key: "b", value: "Fine" }],
      [{ key: "Under-50L", value: "Under 50L" }, { key: "b", value: "Fine" }],
    ];
    for (const options of bad) {
      const r = buildFormSpec(withAnswers(options), CTX);
      expect(r.spec).toBeNull();
      expect(r.problems).toEqual([{ field: "questions", message: FORM_BUILDER_TEXT.badAnswers(3) }]);
      // The server refuses the same answers.
      const forced = { ...buildFormSpec(ready(), CTX).spec!, questions: [{ type: "FULL_NAME" }, { type: "PHONE" }, { type: "CUSTOM", label: "Budget?", options }] };
      expect(validateSpec(forced, { whatsappNumber: CTX.whatsappNumber }).problems).toEqual([{ field: "questions.2", message: LEAD_FORM_COPY.options }]);
    }
    expect(FORM_BUILDER_TEXT.badAnswers(3)).toMatch(/^Question 3: /);
    // Answers with no key are sent without one, and the server makes the keys.
    const keyless = buildFormSpec(withAnswers([{ key: "", value: "Under 50L" }, { key: "over_50l", value: "Over 50L" }]), CTX).spec!;
    expect(keyless.questions[2].options).toEqual([{ value: "Under 50L" }, { key: "over_50l", value: "Over 50L" }]);
    expect(validateSpec(keyless, { whatsappNumber: CTX.whatsappNumber }).spec?.questions[2].options).toEqual([
      { key: "under_50l", value: "Under 50L" },
      { key: "over_50l", value: "Over 50L" },
    ]);
  });
});

// =====================================================================================================================
// Questions: at most 15, at most 3 of the owner's own, reordered with buttons or by dragging
// =====================================================================================================================

describe("questions", () => {
  it("accepts 15 questions and refuses a 16th", () => {
    let state = ready();
    const others = LEAD_QUESTION_TYPES.filter((t) => t !== "CUSTOM" && t !== "FULL_NAME" && t !== "PHONE");
    for (const type of others.slice(0, 10)) {
      const r = addQuestion(state, { type });
      expect(r.error).toBeNull();
      state = r.state;
    }
    for (const label of ["Which flat size?", "Budget?", "When do you move?"]) {
      const r = addQuestion(state, { type: "CUSTOM", label });
      expect(r.error).toBeNull();
      state = r.state;
    }
    expect(state.questions).toHaveLength(15);
    expect(buildFormSpec(state, CTX).problems).toEqual([]);
    expect(new Set(state.questions.map((q) => q.uid)).size).toBe(15);

    const sixteenth = addQuestion(state, { type: others[10] });
    expect(sixteenth.error).toBe(promoteText("form.max_questions"));
    expect(sixteenth.error).toBe("A form can have at most 15 questions.");
    expect(sixteenth.state).toBe(state);
    // A state that arrives with 16 anyway (a stale tab) is refused before anything is sent.
    const forced = { ...state, questions: [...state.questions, { uid: "q99", type: others[10], label: "" }] };
    expect(problemsByField(buildFormSpec(forced, CTX).problems).questions).toBe("A form can have at most 15 questions.");
  });

  it("refuses a 4th question of the owner's own and a repeated Meta question", () => {
    let state = ready();
    for (const label of ["a?", "b?", "c?"]) state = addQuestion(state, { type: "CUSTOM", label }).state;
    expect(addQuestion(state, { type: "CUSTOM", label: "d?" }).error).toBe(promoteText("form.max_qualifying"));
    expect(addQuestion(state, { type: "PHONE" }).error).toBe(FORM_BUILDER_TEXT.duplicate);
  });

  it("reorders with buttons (up and down, never past the ends) and by dragging", () => {
    const state = applyPreset(ready(), "salon");
    const types = (s: BuilderState) => s.questions.map((q) => q.key ?? q.type);
    expect(types(state)).toEqual(["FULL_NAME", "PHONE", "which_service", "preferred_day"]);
    expect(types(moveQuestion(state, 2, -1))).toEqual(["FULL_NAME", "which_service", "PHONE", "preferred_day"]);
    expect(types(moveQuestion(state, 0, 1))).toEqual(["PHONE", "FULL_NAME", "which_service", "preferred_day"]);
    expect(moveQuestion(state, 0, -1)).toBe(state);
    expect(moveQuestion(state, 3, 1)).toBe(state);
    expect(types(reorderQuestion(state, 3, 0))).toEqual(["preferred_day", "FULL_NAME", "PHONE", "which_service"]);
    expect(reorderQuestion(state, 1, 1)).toBe(state);
  });

  it("offers Email and the preset's suggestions as chips until they are on the list", () => {
    const coaching = applyPreset(ready(), "coaching");
    expect(suggestionChips(coaching).map((c) => c.id)).toEqual(["email", "preferred_day", "when_start"]);
    const withEmail = addQuestion(coaching, suggestionChips(coaching)[0].question).state;
    expect(withEmail.questions.map((q) => q.type)).toContain("EMAIL");
    expect(suggestionChips(withEmail).map((c) => c.id)).toEqual(["preferred_day", "when_start"]);
    // Switching the preset keeps Email.
    expect(applyPreset(withEmail, "salon").questions.map((q) => q.type)).toEqual(["FULL_NAME", "PHONE", "EMAIL", "CUSTOM", "CUSTOM"]);
  });
});

// =====================================================================================================================
// Privacy link, consent box, form type, thank-you
// =====================================================================================================================

describe("the privacy link is the business's own https link", () => {
  it("refuses http, a missing link and a link that isn't one", () => {
    expect(checkPrivacyUrl("http://sunrise.example/privacy")).toBe("The link must start with https://");
    expect(checkPrivacyUrl("http://sunrise.example/privacy")).toBe(promoteText("form.privacy_https"));
    expect(checkPrivacyUrl("")).toBe("Meta needs a link to your privacy policy. Edwyz can't host one for you.");
    expect(checkPrivacyUrl("sunrise.example/privacy")).toBe(promoteText("form.privacy_https"));
    expect(checkPrivacyUrl("https://user:pw@sunrise.example/privacy")).toBe(FORM_BUILDER_TEXT.privacyInvalid);
    expect(checkPrivacyUrl("https://localhost/privacy")).toBe(FORM_BUILDER_TEXT.privacyInvalid);
    expect(checkPrivacyUrl(`https://sunrise.example/${"a".repeat(2001)}`)).toBe(FORM_BUILDER_TEXT.privacyTooLong);
    expect(checkPrivacyUrl(PRIVACY)).toBeNull();
    const r = buildFormSpec(ready({ privacyUrl: "http://sunrise.example/privacy" }), CTX);
    expect(r.spec).toBeNull();
    expect(r.problems).toEqual([{ field: "privacyUrl", message: "The link must start with https://" }]);
  });
});

describe("the WhatsApp consent box (D35)", () => {
  it("is always optional and unticked, and no required option is exposed", () => {
    expect(consentBox("Sunrise Salon")).toEqual({ key: "whatsapp_opt_in", text: "I agree to get WhatsApp messages from Sunrise Salon", required: false, checkedByDefault: false });
    expect(consentBox(null).text).toBe("I agree to get WhatsApp messages from us");
    // The UI state has no field that could make it required or tick it.
    expect(Object.keys(newBuilderState()).filter((k) => /required|checked|ticked/i.test(k))).toEqual([]);
    // Even a state carrying extra keys sends the box optional and unticked.
    const sneaky = { ...ready(), required: true, consentRequired: true, checkedByDefault: true } as unknown as BuilderState;
    const spec = buildFormSpec(sneaky, CTX).spec!;
    expect(spec.disclaimer?.checkboxes).toEqual([{ key: "whatsapp_opt_in", text: "I agree to get WhatsApp messages from Sunrise Salon", required: false, checkedByDefault: false }]);
    // The preview draws it unticked.
    const privacy = previewScreens(ready(), CTX).find((s) => s.key === "privacy");
    expect(privacy).toMatchObject({ consent: { checked: false, required: false, text: "I agree to get WhatsApp messages from Sunrise Salon" } });
    // Leaving it out is allowed (the owner's choice); there is never a required box.
    expect(buildFormSpec(ready({ askConsent: false }), CTX).spec?.disclaimer).toBeNull();
    // FormStep offers no "required" switch for it.
    const source = readFileSync(path.join(ROOT, "src/components/promote/FormStep.tsx"), "utf8");
    expect(source).not.toMatch(/consentRequired|requireConsent|is_required|checkedByDefault/);
    const markup = html(createElement(FormStep, { state: ready(), onChange: () => undefined, ctx: CTX, focusOnMount: false }));
    expect(markup).toContain("I agree to get WhatsApp messages from Sunrise Salon");
    expect(markup).toContain(esc(promoteText("form.consent_optional")));
    expect(markup).not.toMatch(/Make (it|this box) required|Required box/i);
  });
});

describe("form type and thank-you", () => {
  it("higher intent sets formType higher_intent", () => {
    expect(buildFormSpec(ready({ formType: "higher_intent" }), CTX).spec?.formType).toBe("higher_intent");
    expect(buildFormSpec(ready(), CTX).spec?.formType).toBe("more_volume");
    const markup = html(createElement(FormStep, { state: ready(), onChange: () => undefined, ctx: CTX, focusOnMount: false }));
    expect(markup).toContain("More people");
    expect(markup).toContain("Fewer, more serious people (adds a check screen; shows in mobile feeds only)");
  });

  it("a WhatsApp thank-you builds a wa.me link to the workspace number", () => {
    expect(waMeLink("+91 98765 43210")).toBe("https://wa.me/919876543210");
    expect(waMeLink("")).toBeNull();
    expect(buildFormSpec(ready(), CTX).spec?.thankYou).toMatchObject({ kind: "whatsapp", url: "https://wa.me/919876543210", buttonText: "Chat on WhatsApp" });
    const none = buildFormSpec(ready(), { ...CTX, whatsappNumber: null });
    expect(none.problems).toEqual([{ field: "thankYou", message: FORM_BUILDER_TEXT.noWhatsapp }]);
  });

  it("Call uses the phone number with its country code, and Website an https link", () => {
    const call = buildFormSpec(ready({ thankYou: { kind: "call", phone: "+91 98765-43210", website: "" } }), CTX).spec;
    expect(call?.thankYou).toMatchObject({ kind: "call", phone: "+919876543210", buttonText: "Call" });
    expect(call?.thankYou.url).toBeUndefined();
    expect(buildFormSpec(ready({ thankYou: { kind: "call", phone: "98765", website: "" } }), CTX).problems).toEqual([{ field: "thankYou", message: FORM_BUILDER_TEXT.badPhone }]);
    const site = buildFormSpec(ready({ thankYou: { kind: "website", phone: "", website: "https://sunrise.example/book" } }), CTX).spec;
    expect(site?.thankYou).toMatchObject({ kind: "website", url: "https://sunrise.example/book", buttonText: "Visit website" });
    expect(buildFormSpec(ready({ thankYou: { kind: "website", phone: "", website: "http://sunrise.example" } }), CTX).problems).toEqual([{ field: "thankYou", message: FORM_BUILDER_TEXT.badWebsite }]);
    expect(validateSpec(call, { whatsappNumber: CTX.whatsappNumber }).problems).toEqual([]);
    expect(validateSpec(site, {}).problems).toEqual([]);
  });
});

// =====================================================================================================================
// Preview, confirm, copies, Lead Gen terms
// =====================================================================================================================

describe("the preview", () => {
  it("derives the 4 screens in order: intro, questions, privacy, thank-you", () => {
    const screens = previewScreens(applyPreset(ready({ formType: "higher_intent" }), "salon"), CTX);
    expect(screens.map((s) => s.key)).toEqual(["intro", "questions", "privacy", "thank_you"]);
    expect(screens.map((s) => s.title)).toEqual(["Intro", "Questions", "Privacy", "Thank you"]);
    expect(screens[0]).toMatchObject({ pageName: "Sunrise Salon", higherIntent: true });
    expect(screens[1]).toMatchObject({ key: "questions" });
    if (screens[1].key === "questions") {
      expect(screens[1].questions.map((q) => q.label)).toEqual(["Full name", "Phone number", "Which service?", "Preferred day"]);
      expect(screens[1].questions.map((q) => q.prefilled)).toEqual([true, true, false, false]);
    }
    expect(screens[2]).toMatchObject({ url: PRIVACY, linkText: "Privacy policy" });
    expect(screens[3]).toMatchObject({ heading: "Thanks! We've got your details.", button: "Chat on WhatsApp", target: "https://wa.me/919876543210" });
  });

  it("moves with the arrow keys, Home and End, without wrapping", () => {
    expect(nextScreenIndex(0, "ArrowRight", 4)).toBe(1);
    expect(nextScreenIndex(3, "ArrowRight", 4)).toBe(3);
    expect(nextScreenIndex(1, "ArrowLeft", 4)).toBe(0);
    expect(nextScreenIndex(0, "ArrowUp", 4)).toBe(0);
    expect(nextScreenIndex(1, "ArrowDown", 4)).toBe(2);
    expect(nextScreenIndex(2, "Home", 4)).toBe(0);
    expect(nextScreenIndex(0, "End", 4)).toBe(3);
    expect(nextScreenIndex(0, "Enter", 4)).toBeNull();
  });

  it("renders a phone frame with 4 tabs, Previous and Next, and the first screen", () => {
    const out = html(createElement(LeadFormPreview, { screens: previewScreens(ready(), CTX) }));
    for (const key of ["intro", "questions", "privacy", "thank_you"]) expect(out).toContain(`data-testid="form-preview-tab-${key}"`);
    expect(out).toContain('data-testid="form-preview-screen-intro"');
    expect(out).toContain('data-testid="form-preview-prev"');
    expect(out).toContain('data-testid="form-preview-next"');
    expect(out).toContain('role="tablist"');
    expect(out).toContain('aria-selected="true"');
    expect(out).toContain("Screen 1 of 4: Intro");
  });
});

describe("the create confirm (6.5 create_lead_form)", () => {
  it("names the form and the Page, lists what goes to Meta, and warns that it can't be changed or deleted", () => {
    const spec = buildFormSpec(ready(), CTX).spec!;
    expect(createConfirmCopy(spec, "Sunrise Salon")).toEqual({
      title: "Create the form 'Diwali enquiries' on Sunrise Salon?",
      questions: ["Full name", "Phone number"],
      privacyUrl: PRIVACY,
      thankYou: "Chat on WhatsApp: https://wa.me/919876543210",
      consent: "I agree to get WhatsApp messages from Sunrise Salon (optional, never ticked for them)",
      warning: "Meta doesn't let you change or delete a form once it's created.",
    });
    expect(createConfirmCopy(buildFormSpec(ready({ askConsent: false }), CTX).spec!, "Sunrise Salon").consent).toBe("No WhatsApp consent box");
  });
});

describe("an edited copy", () => {
  it("starts from the stored spec and is named as a copy", () => {
    const original = buildFormSpec(applyPreset(ready({ formType: "higher_intent", thankYou: { kind: "website", phone: "", website: "https://sunrise.example/book" } }), "salon"), CTX).spec!;
    const state = stateFromSpec(original, { name: copyName("Diwali enquiries"), whatsappNumber: CTX.whatsappNumber, privacyUrl: null });
    expect(state.name).toBe("Diwali enquiries (copy)");
    expect(state.formType).toBe("higher_intent");
    expect(state.privacyUrl).toBe(PRIVACY);
    expect(state.thankYou).toMatchObject({ kind: "website", website: "https://sunrise.example/book" });
    expect(state.askConsent).toBe(true);
    const again = buildFormSpec(state, CTX).spec!;
    expect(again.questions).toEqual(original.questions);
    expect(stateFromSpec({ ...original, disclaimer: null }, { name: "x" }).askConsent).toBe(false);
    expect(stateFromSpec("junk", { name: "x", privacyUrl: PRIVACY }).questions.map((q) => q.type)).toEqual(["FULL_NAME", "PHONE"]);
    // A copy of a form made here sends the same spec back under its copy name: nothing is lost on the way.
    expect(again).toEqual({ ...original, name: "Diwali enquiries (copy)" });
    expect(copyNotes(copyFromSpec(original, { name: "x" }))).toEqual([]);
  });

  it("copies an imported form: says which questions it left out, fixes answers Meta's rules refuse, and the server accepts the copy", () => {
    // LeadForm.spec of an imported form (promote/lead-forms.specFromMeta): what Meta says the form asks.
    const options = (n: number, value = (i: number) => `Answer ${i + 1}`) => Array.from({ length: n }, (_, i) => ({ key: `Opt-${i + 1}`, value: value(i) }));
    const imported = {
      source: "meta",
      locale: "en_US",
      privacyUrl: PRIVACY,
      questions: [
        { type: "FULL_NAME", key: "full_name", label: "Full name" },
        { type: "PHONE", key: "phone_number", label: "Phone number" },
        { type: "CUSTOM", key: "Budget-Range", label: "Budget?", options: [{ key: "Under-50L", value: "Under 50L" }, { key: "50L-1Cr", value: "50L to 1Cr" }, { key: "over_1cr", value: "Over 1Cr" }] },
        { type: "CUSTOM", key: "flat_size", label: "Which flat size?", options: [...options(24), { key: "long", value: "x".repeat(150) }] },
        { type: "CUSTOM", key: "only_one", label: "Only one answer?", options: [{ key: "yes", value: "Yes" }, { key: "blank", value: "  " }] },
        { type: "CUSTOM", key: "flat_size", label: "When do you move?" },
        { type: "CUSTOM", key: "visit", label: "Want a site visit?" },
        { type: "PHONE", label: "Phone again" },
        { type: "EMAIL", key: "email", label: "Email" },
      ],
    };
    const start = copyFromSpec(imported, { name: copyName("Pune 2 BHK"), whatsappNumber: CTX.whatsappNumber, privacyUrl: null });
    expect(start.state.questions.map((q) => q.label || q.type)).toEqual(["FULL_NAME", "PHONE", "Budget?", "Which flat size?", "When do you move?", "EMAIL"]);
    // One usable answer can't make a multiple-choice question; a 4th question of the owner's own; a repeated Meta question.
    expect(start.skipped).toEqual(["Only one answer?", "Want a site visit?", "Phone again"]);
    expect(start.shortened).toEqual(["Which flat size?"]);
    // Keys the server would refuse are left out (it makes its own); a repeated key too. Answers: at most 20, 100 characters each.
    const budget = start.state.questions[2];
    expect(budget.key).toBeUndefined();
    expect(budget.options).toEqual([{ key: "", value: "Under 50L" }, { key: "", value: "50L to 1Cr" }, { key: "over_1cr", value: "Over 1Cr" }]);
    expect(start.state.questions[3].key).toBe("flat_size");
    expect(start.state.questions[3].options).toHaveLength(20);
    expect(start.state.questions[4].key).toBeUndefined();
    // An imported form says nothing about a consent box: the copy gets the WhatsApp box, as a new form does.
    expect(start.state.askConsent).toBe(true);

    const notes = copyNotes(start);
    expect(notes[0]).toBe(FORM_BUILDER_TEXT.copySkipped('"Only one answer?", "Want a site visit?", "Phone again"'));
    expect(notes[0]).toMatch(/^These questions weren't copied: "Only one answer\?"/);
    expect(notes[1]).toContain('"Which flat size?"');

    const r = buildFormSpec(start.state, CTX);
    expect(r.problems).toEqual([]);
    const server = validateSpec(r.spec, { whatsappNumber: CTX.whatsappNumber, businessName: CTX.businessName });
    expect(server.problems).toEqual([]);
    expect(server.spec?.questions[2].options?.map((o) => o.key)).toEqual(["under_50l", "q_50l_to_1cr", "over_1cr"]);
    expect(server.spec?.questions[3].options).toHaveLength(20);

    // The builder shows the notice.
    const out = html(
      createElement(LeadFormBuilder, {
        pages: [{ id: "pg1", name: "Sunrise Realty", connectionId: "c1", leadgenTos: "ok", leadgenHref: null }],
        whatsappNumber: CTX.whatsappNumber,
        verifiedName: null,
        privacyUrl: PRIVACY,
        copyFrom: { id: "f9", name: "Pune 2 BHK", pageAssetId: "pg1", spec: imported },
        today: TODAY,
      }),
    );
    expect(out).toContain('data-testid="form-copy-notes"');
    expect(out).toContain(esc("These questions weren't copied:"));
    expect(out).toContain(esc('"Want a site visit?"'));
  });

  it("keeps an Eddy form's intro, language, thank-you words and other boxes in a copy, shows them, and the server accepts it", () => {
    const eddy = validateSpec(
      {
        name: "दिवाली ऑफ़र",
        locale: "hi_IN",
        intro: { title: "दिवाली ऑफ़र", lines: ["हेयरकट पर 20% छूट", "सिर्फ़ इस हफ़्ते"] },
        questions: [{ type: "FULL_NAME" }, { type: "PHONE" }, { type: "CUSTOM", key: "service", label: "कौन सी सेवा?" }],
        privacyUrl: PRIVACY,
        privacyLinkText: "गोपनीयता नीति",
        thankYou: { kind: "whatsapp", title: "धन्यवाद!", body: "हम जल्द जवाब देंगे।", buttonText: "WhatsApp पर बात करें" },
        disclaimer: {
          title: "WhatsApp संदेश",
          body: "अगर आप WhatsApp पर संदेश चाहते हैं तो बॉक्स पर टिक करें।",
          checkboxes: [
            { key: "whatsapp_opt_in", text: "मैं Sunrise Salon से WhatsApp संदेश पाने के लिए सहमत हूँ" },
            { key: "terms", text: "I accept the salon's booking terms", required: true },
          ],
        },
      },
      { whatsappNumber: CTX.whatsappNumber, businessName: CTX.businessName },
    ).spec!;
    expect(eddy).toBeTruthy();
    const start = copyFromSpec(eddy, { name: copyName(eddy.name), whatsappNumber: CTX.whatsappNumber });
    expect(start.skipped).toEqual([]);
    expect(start.droppedLocale).toBeNull();
    expect(start.state.askConsent).toBe(true);

    const spec = buildFormSpec(start.state, CTX).spec!;
    expect(spec.locale).toBe("hi_IN");
    expect(spec.intro).toEqual({ title: "दिवाली ऑफ़र", lines: ["हेयरकट पर 20% छूट", "सिर्फ़ इस हफ़्ते"] });
    expect(spec.privacyLinkText).toBe("गोपनीयता नीति");
    expect(spec.thankYou).toMatchObject({ kind: "whatsapp", title: "धन्यवाद!", body: "हम जल्द जवाब देंगे।", buttonText: "WhatsApp पर बात करें", url: "https://wa.me/919876543210" });
    expect(spec.disclaimer).toEqual({
      title: "WhatsApp संदेश",
      body: "अगर आप WhatsApp पर संदेश चाहते हैं तो बॉक्स पर टिक करें।",
      checkboxes: [
        { key: "whatsapp_opt_in", text: "मैं Sunrise Salon से WhatsApp संदेश पाने के लिए सहमत हूँ", required: false, checkedByDefault: false },
        { key: "terms", text: "I accept the salon's booking terms", required: true, checkedByDefault: false },
      ],
    });
    // The server takes the copy as the original was.
    const server = validateSpec(spec, { whatsappNumber: CTX.whatsappNumber, businessName: CTX.businessName });
    expect(server.problems).toEqual([]);
    expect(server.spec).toMatchObject({ locale: "hi_IN", intro: eddy.intro, privacyLinkText: eddy.privacyLinkText, thankYou: eddy.thankYou, disclaimer: eddy.disclaimer });

    // The preview and the confirm show what goes to Meta.
    const screens = previewScreens(start.state, CTX);
    expect(screens[0]).toMatchObject({ intro: { title: "दिवाली ऑफ़र", lines: ["हेयरकट पर 20% छूट", "सिर्फ़ इस हफ़्ते"] } });
    expect(screens[2]).toMatchObject({ linkText: "गोपनीयता नीति", consent: { text: "मैं Sunrise Salon से WhatsApp संदेश पाने के लिए सहमत हूँ", checked: false }, others: [{ text: "I accept the salon's booking terms", required: true, checked: false }] });
    expect(screens[3]).toMatchObject({ heading: "धन्यवाद!", body: "हम जल्द जवाब देंगे।", button: "WhatsApp पर बात करें" });
    expect(html(createElement(LeadFormPreview, { screens }))).toContain("हेयरकट पर 20% छूट");
    const confirm = createConfirmCopy(spec, "Sunrise Salon");
    expect(confirm.language).toBe("hi_IN");
    expect(confirm.otherBoxes).toEqual(["I accept the salon's booking terms (required)"]);
    expect(createConfirmCopy(buildFormSpec(ready(), CTX).spec!, "Sunrise Salon")).not.toHaveProperty("language");

    // Another button kind uses our words for it: the kept words were for the WhatsApp button.
    const call = buildFormSpec({ ...start.state, thankYou: { kind: "call", phone: "+91 98765 43210", website: "" } }, CTX).spec!;
    expect(call.thankYou).toMatchObject({ kind: "call", title: "Thanks! We've got your details.", buttonText: "Call" });
    // Without the WhatsApp box, the other box stays in its section.
    expect(buildFormSpec({ ...start.state, askConsent: false }, CTX).spec?.disclaimer?.checkboxes.map((c) => c.key)).toEqual(["terms"]);
  });

  it("says when the original's language can't be used, and uses Meta's list of languages", () => {
    expect([...FORM_LOCALES]).toEqual([...SERVER_FORM_LOCALES]);
    const start = copyFromSpec({ questions: [{ type: "FULL_NAME" }, { type: "PHONE" }], locale: "ta_IN" }, { name: "x", privacyUrl: PRIVACY });
    expect(start.droppedLocale).toBe("ta_IN");
    expect(buildFormSpec(start.state, CTX).spec?.locale).toBe("en_US");
    expect(copyNotes(start)).toEqual([FORM_BUILDER_TEXT.copyEnglish("ta_IN")]);
  });

  it("names at most five left-out questions, then how many more", () => {
    const many = { questions: [{ type: "FULL_NAME" }, { type: "PHONE" }, ...Array.from({ length: 10 }, (_, i) => ({ type: "CUSTOM", label: `Q${i + 1}?` }))] };
    const start = copyFromSpec(many, { name: "x" });
    expect(start.skipped).toHaveLength(7);
    expect(copyNotes(start)[0]).toContain('"Q4?", "Q5?", "Q6?", "Q7?", "Q8?", and 2 more.');
  });
});

// =====================================================================================================================
// Create: sent once; after an unclear answer, never offered again on this page
// =====================================================================================================================

describe("creating the form", () => {
  const spec = () => buildFormSpec(ready(), CTX).spec!;
  const answer = (status: number, body: unknown, ok = status >= 200 && status < 300) => vi.fn<CreateFetch>(async () => ({ ok, status, json: async () => body }));

  it("posts a new form to /build with the Page, and a copy to /{id}/copy", () => {
    expect(createRequest(null, "pg1", spec())).toEqual({ path: "/api/leads/forms/build", body: { pageAssetId: "pg1", spec: spec() } });
    expect(createRequest("f 1", "pg1", spec())).toEqual({ path: "/api/leads/forms/f%201/copy", body: { spec: spec() } });
  });

  it("a 504 (Meta didn't confirm in time) is unclear: the server's words, sent once, never retried", async () => {
    const fetcher = answer(504, { error: LEAD_FORM_COPY.ambiguous });
    const r = await sendCreate(createRequest(null, "pg1", spec()), fetcher);
    expect(r).toEqual({ ok: false, unsure: true, message: "Meta didn't confirm this in time. It may already be saved. Check before you try again." });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [path, init] = fetcher.mock.calls[0];
    expect(path).toBe("/api/leads/forms/build");
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" } });
    expect(JSON.parse(init.body)).toEqual({ pageAssetId: "pg1", spec: spec() });
  });

  it("a 500, a proxy's 5xx page and a dropped connection are unclear too; a refusal is not", async () => {
    const req = createRequest(null, "pg1", spec());
    expect(await sendCreate(req, answer(500, { error: "Something went wrong." }))).toEqual({ ok: false, unsure: true, message: FORM_BUILDER_TEXT.unsure });
    expect(await sendCreate(req, vi.fn<CreateFetch>(async () => ({ ok: false, status: 502, json: async () => Promise.reject(new SyntaxError("html")) })))).toMatchObject({ unsure: true });
    expect(await sendCreate(req, vi.fn<CreateFetch>(async () => Promise.reject(new TypeError("Failed to fetch"))))).toEqual({ ok: false, unsure: true, message: FORM_BUILDER_TEXT.unsureNetwork });
    // Meta said no (502 with our answer), Lead Gen terms (409) and a spec problem (400) can be fixed and tried again.
    expect(await sendCreate(req, answer(502, { error: LEAD_FORM_COPY.metaRefused }))).toEqual({ ok: false, unsure: false, message: LEAD_FORM_COPY.metaRefused, code: null, problems: undefined });
    expect(await sendCreate(req, answer(409, { error: "Accept Meta's lead ad terms.", code: "leadgen_tos" }))).toMatchObject({ unsure: false, code: "leadgen_tos" });
    const problems = [{ field: "questions.2", message: LEAD_FORM_COPY.options }];
    expect(await sendCreate(req, answer(400, { error: LEAD_FORM_COPY.options, problems }))).toMatchObject({ unsure: false, problems });
    expect(await sendCreate(req, answer(201, { form: { id: "f1" }, dryRun: true }))).toEqual({ ok: true, dryRun: true });
  });

  it("a second tap while the first is on its way sends nothing", async () => {
    const lock = { current: false };
    let release: () => void = () => undefined;
    const run = vi.fn(() => new Promise<string>((resolve) => (release = () => resolve("sent"))));
    const first = runOnce(lock, run);
    const second = runOnce(lock, run);
    expect(await second).toBeUndefined();
    release();
    expect(await first).toBe("sent");
    expect(run).toHaveBeenCalledTimes(1);
    // Once it is done, a new run can start.
    expect(await runOnce(lock, async () => "again")).toBe("again");
  });

  it("after an unclear answer, tells the owner to check Lead forms before trying again, with a link there", () => {
    const out = html(createElement(CreateUnsureNotice, { unsure: { name: "Diwali enquiries", pageName: "Sunrise Salon", message: LEAD_FORM_COPY.ambiguous } }));
    expect(out).toContain('data-testid="form-create-unsure"');
    expect(out).toContain('tabindex="-1"');
    expect(out).toContain("Check before you try again");
    expect(out).toContain(esc(LEAD_FORM_COPY.ambiguous));
    expect(out).toContain(esc("Open Lead forms and choose Import from Meta. If 'Diwali enquiries' is on Sunrise Salon, import it from there. Don't create it again here."));
    expect(out).toMatch(/<a href="\/app\/leads\/forms"[^>]*data-testid="form-create-unsure-check"[^>]*>Check my lead forms<\/a>/);
    expect(out).toContain('role="status"');
    // The builder checks the guard and the unclear state before it sends, and turns Create off after an unclear answer.
    const source = readFileSync(path.join(ROOT, "src/components/promote/FormStep.tsx"), "utf8");
    expect(source).toMatch(/async function confirmCreate\(\) \{\s*if \(busy \|\| unsure \|\| !pending \|\| !page\) return;/);
    expect(source).toContain("await runOnce(sending,");
    expect(source).toMatch(/disabled=\{copyPageGone \|\| unsure !== null\}/);
    // The create is sent only to a literal same-origin path (spend-bypass B12), never to a computed URL.
    expect(source).toContain("fetch(`/api/leads/forms/${");
    expect(source).not.toMatch(/(?<![\w.$])fetch\(\s*(?!`\/api\/leads\/forms\/)/);
  });
});

describe("the Create bar on a phone", () => {
  it("sticks above the bottom menu bar (3.25rem plus the safe area), and to the bottom from md up", () => {
    expect(CREATE_BAR_CLASS).toContain("sticky");
    expect(CREATE_BAR_CLASS).toContain("bottom-[calc(3.25rem+env(safe-area-inset-bottom))]");
    expect(CREATE_BAR_CLASS).toContain("md:bottom-0");
    // The bar's own safe-area padding applies only where there is no menu bar under it.
    expect(CREATE_BAR_CLASS).toContain("md:pb-[max(0.75rem,env(safe-area-inset-bottom))]");
    expect(CREATE_BAR_CLASS).not.toMatch(/(^|\s)pb-\[max/);
    expect(CREATE_BAR_CLASS).not.toMatch(/(^|\s)bottom-0(\s|$)/);
    // The menu bar it clears: fixed to the bottom below md, the same offset the rule builder's sticky bar uses.
    const tabBar = readFileSync(path.join(ROOT, "src/components/app/MobileTabBar.tsx"), "utf8");
    expect(tabBar).toMatch(/fixed inset-x-0 bottom-0 z-30[^"]*md:hidden/);
    expect(readFileSync(path.join(ROOT, "src/components/automation/RuleBuilder.tsx"), "utf8")).toContain("bottom-[calc(3.25rem+env(safe-area-inset-bottom))]");
    const out = html(
      createElement(LeadFormBuilder, {
        pages: [{ id: "pg1", name: "Sunrise Salon", connectionId: "c1", leadgenTos: "ok", leadgenHref: null }],
        whatsappNumber: CTX.whatsappNumber,
        verifiedName: null,
        privacyUrl: PRIVACY,
        copyFrom: null,
        today: TODAY,
      }),
    );
    const bar = /<div class="([^"]+)" data-testid="form-create-bar">/.exec(out)?.[1];
    expect(bar).toBe(CREATE_BAR_CLASS);
    expect(out).not.toContain('data-testid="form-create-unsure"');
    expect(out).not.toContain('data-testid="form-copy-notes"');
  });
});

describe("[I've accepted] re-reads the Lead Gen terms", () => {
  it("refreshes the connection, then reads the leadgen_tos row", async () => {
    const calls: string[] = [];
    const deps = {
      post: vi.fn(async (p: string, body: unknown) => {
        calls.push(`POST ${p} ${JSON.stringify(body)}`);
        return {} as never;
      }),
      get: vi.fn(async (p: string) => {
        calls.push(`GET ${p}`);
        return { rows: [{ check: "facebook_connected", status: "ok" }, { check: "leadgen_tos", status: "ok" }] } as never;
      }),
    };
    expect(await recheckLeadgenTerms({ id: "pg1", connectionId: "c1" }, deps)).toBe("ok");
    expect(calls).toEqual(['POST /api/meta-connect/refresh {"connectionId":"c1"}', "GET /api/promote/prereqs?goal=lead_form&pageAssetId=pg1"]);
  });

  it("still reads the stored answer when the refresh fails, and is unknown when nothing can be read", async () => {
    const failing = { post: vi.fn(async () => Promise.reject(new Error("expired"))), get: vi.fn(async () => ({ rows: [{ check: "leadgen_tos", status: "missing" }] }) as never) };
    expect(await recheckLeadgenTerms({ id: "pg1", connectionId: "c1" }, failing)).toBe("missing");
    const down = { post: vi.fn(), get: vi.fn(async () => Promise.reject(new Error("down"))) };
    expect(await recheckLeadgenTerms({ id: "pg1", connectionId: null }, down)).toBe("unknown");
    expect(down.post).not.toHaveBeenCalled();
    expect(leadgenStatusOf({ rows: [{ check: "leadgen_tos", status: "weird" }] })).toBe("unknown");
  });

  it("shows the server-resolved Opens Meta button and [I've accepted] while the terms aren't accepted", () => {
    const href = metaScreenHref("leadgen_tos", { pageId: "104857600123" });
    const markup = html(
      createElement(FormStep, {
        state: ready(),
        onChange: () => undefined,
        ctx: CTX,
        focusOnMount: false,
        readiness: { status: "missing", href, checking: false, message: null, onRecheck: () => undefined },
      }),
    );
    expect(markup).toContain('data-opens-meta="leadgen_tos"');
    expect(markup).toContain(`href="${href}"`);
    expect(markup).toContain('rel="noopener noreferrer"');
    expect(markup).toContain(esc(promoteText("readiness.leadgen_tos.fix")));
    expect(markup).toContain('data-testid="form-readiness-recheck"');
    expect(markup).toContain("I&#x27;ve accepted");
    const ok = html(createElement(FormStep, { state: ready(), onChange: () => undefined, ctx: CTX, focusOnMount: false, readiness: { status: "ok", href, checking: false, message: null, onRecheck: () => undefined } }));
    expect(ok).not.toContain('data-testid="form-readiness-recheck"');
  });
});

describe("FormStep markup", () => {
  it("has an h2 that takes focus, labelled fields, reorder buttons with full names, 44 px targets and test ids", () => {
    const out = html(createElement(FormStep, { state: applyPreset(ready(), "salon"), onChange: () => undefined, ctx: CTX, focusOnMount: false, errors: { privacyUrl: "The link must start with https://" } }));
    expect(out).toMatch(/<h2[^>]*tabindex="-1"[^>]*data-testid="form-step-heading"[^>]*>Instant form<\/h2>/);
    expect(out).toContain('aria-label="Move &quot;Phone number&quot; up"');
    expect(out).toContain('aria-label="Remove &quot;Which service?&quot;"');
    expect(out).toContain("Meta needs a link to your privacy policy. Edwyz can&#x27;t host one for you.");
    // The privacy error is linked to its input and announced.
    const input = /<input[^>]*data-testid="form-privacy"[^>]*>/.exec(out)?.[0] ?? "";
    expect(input).toContain('aria-invalid="true"');
    const errorId = /id="([^"]+-error)" role="alert"[^>]*>The link must start with https:\/\/</.exec(out)?.[1];
    expect(errorId).toBeTruthy();
    expect(input).toContain(errorId!);
    for (const id of ["form-step", "form-name", "form-preset-salon", "form-question-0", "form-question-up-1", "form-type-higher_intent", "form-privacy", "form-thank-you-whatsapp", "form-consent", "form-chip-email"]) {
      expect(out).toContain(`data-testid="${id}"`);
    }
    expect(out).toContain("Opens a WhatsApp chat with you: https://wa.me/919876543210");
  });
});

// =====================================================================================================================
// Grep rules over the new and changed files (7.6): tokens only, no Meta host
// =====================================================================================================================

const FILES = [
  "src/components/promote/FormStep.tsx",
  "src/components/promote/LeadFormPreview.tsx",
  "src/components/promote/form-builder-helpers.ts",
  "src/app/(app)/app/leads/forms/new/page.tsx",
  "src/app/(app)/app/leads/forms/page.tsx",
  "src/components/leads/FormsView.tsx",
];

describe("the builder's files use design tokens only and name no Meta host", () => {
  it.each(FILES)("%s: no hex colours, no dark:, no raw z-index, no facebook.com", (file) => {
    const code = readFileSync(path.join(ROOT, file), "utf8");
    expect(code).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(code).not.toContain("dark:");
    expect(code).not.toMatch(/z-index|\bz-\[|\bz-\d/);
    expect(code).not.toMatch(/facebook\.com/i);
  });
});

// =====================================================================================================================
// The builder page's gate (promoteAccess)
// =====================================================================================================================

describe("/app/leads/forms/new", () => {
  const page = (copy?: string) => NewLeadFormPage({ searchParams: Promise.resolve(copy === undefined ? {} : { copy }) });

  it("is not found while PROMOTE_ENABLED is off, without looking anyone up", async () => {
    process.env.PROMOTE_ENABLED = "off";
    await expect(page()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(auth.getActor).not.toHaveBeenCalled();
    expect(canBuildForms(promoteAccess({ role: "owner", isPlatformAdmin: false, sandboxAccount: false }, { PROMOTE_ENABLED: "off" }))).toBe(false);
  });

  it("is not found for a customer's member while it is open to Edwyz admins only", async () => {
    process.env.PROMOTE_ENABLED = "admins";
    process.env.PLATFORM_ADMIN_EMAILS = "staff@edwyz.com";
    auth.getActor.mockResolvedValue({ userId: "u1", tenantId: "t1", role: "owner" });
    db.user.findUnique.mockResolvedValue({ email: "owner@shop.in", emailVerifiedAt: new Date(), disabledAt: null, totpEnabledAt: null });
    await expect(page()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(db.metaAsset.findMany).not.toHaveBeenCalled();
  });

  it("tells an agent to ask an owner or admin, and builds nothing", async () => {
    process.env.PROMOTE_ENABLED = "on";
    auth.getActor.mockResolvedValue({ userId: "u1", tenantId: "t1", role: "agent" });
    const out = html((await page()) as ReactElement);
    expect(out).toContain(FORM_BUILDER_TEXT.agentsOnly);
    expect(db.metaAsset.findMany).not.toHaveBeenCalled();
    expect(canBuildForms(promoteAccess({ role: "agent", isPlatformAdmin: false, sandboxAccount: false }, { PROMOTE_ENABLED: "on" }))).toBe(false);
  });

  it("gives an owner the builder with the Pages, the server-resolved lead-terms link, the WhatsApp number and the saved privacy link", async () => {
    process.env.PROMOTE_ENABLED = "on";
    auth.getActor.mockResolvedValue({ userId: "u1", tenantId: "t1", role: "owner" });
    db.metaAsset.findMany.mockResolvedValue([
      { id: "pg1", name: "Sunrise Salon", externalId: "104857600123", connectionId: "c1", meta: { leadgenTosAccepted: false } },
      { id: "pg2", name: "Sunrise Salon", externalId: "104857600123", connectionId: "c2", meta: {} },
      { id: "pg3", name: null, externalId: "222", connectionId: "c1", meta: { leadgenTosAccepted: true } },
    ]);
    db.phoneNumber.findFirst.mockResolvedValue({ displayPhone: "+91 98765 43210", verifiedName: "Sunrise" });
    db.platformSetting.findUnique.mockResolvedValue({ value: { privacyUrl: PRIVACY } });
    const el = (await page()) as ReactElement<Parameters<typeof LeadFormBuilder>[0]>;
    expect(el.type).toBe(LeadFormBuilder);
    expect(el.props.pages).toEqual([
      { id: "pg1", name: "Sunrise Salon", connectionId: "c1", leadgenTos: "missing", leadgenHref: metaScreenHref("leadgen_tos", { pageId: "104857600123" }) },
      { id: "pg3", name: null, connectionId: "c1", leadgenTos: "ok", leadgenHref: metaScreenHref("leadgen_tos", { pageId: "222" }) },
    ]);
    expect(el.props).toMatchObject({ whatsappNumber: "+91 98765 43210", verifiedName: "Sunrise", privacyUrl: PRIVACY, copyFrom: null });
    expect(db.metaAsset.findMany.mock.calls[0][0].where).toMatchObject({ tenantId: "t1", type: "page", status: "active" });
  });

  it("uses the workspace's oldest connected number for Chat on WhatsApp, never an older flagged or disconnected one", async () => {
    process.env.PROMOTE_ENABLED = "on";
    auth.getActor.mockResolvedValue({ userId: "u1", tenantId: "t1", role: "owner" });
    db.metaAsset.findMany.mockResolvedValue([{ id: "pg1", name: "Sunrise Salon", externalId: "104857600123", connectionId: "c1", meta: {} }]);
    db.platformSetting.findUnique.mockResolvedValue(null);
    const numbers = [
      { tenantId: "t1", displayPhone: "+91 90000 00001", verifiedName: "Old number", status: "disconnected", createdAt: new Date("2026-01-01") },
      { tenantId: "t1", displayPhone: "+91 90000 00002", verifiedName: "Flagged", status: "flagged", createdAt: new Date("2026-02-01") },
      { tenantId: "t1", displayPhone: "+91 98765 43210", verifiedName: "Sunrise", status: "connected", createdAt: new Date("2026-03-01") },
    ];
    db.phoneNumber.findFirst.mockImplementation(async ({ where }: { where: { tenantId: string; status?: string } }) => {
      const match = numbers.filter((n) => n.tenantId === where.tenantId && (where.status === undefined || n.status === where.status));
      const first = match.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
      return first ? { displayPhone: first.displayPhone, verifiedName: first.verifiedName } : null;
    });
    const el = (await page()) as ReactElement<Parameters<typeof LeadFormBuilder>[0]>;
    expect(el.props).toMatchObject({ whatsappNumber: "+91 98765 43210", verifiedName: "Sunrise" });
    expect(db.phoneNumber.findFirst.mock.calls[0][0]).toMatchObject({ where: { tenantId: "t1", status: "connected" }, orderBy: { createdAt: "asc" } });
    // The form's thank-you button opens the number that sends the lead welcome.
    const spec = buildFormSpec(newBuilderState({ privacyUrl: PRIVACY, name: "x", whatsappNumber: el.props.whatsappNumber }), { whatsappNumber: el.props.whatsappNumber, businessName: "Sunrise Salon" }).spec!;
    expect(spec.thankYou.url).toBe("https://wa.me/919876543210");

    // No connected number: no number for the WhatsApp button (buildFormSpec then asks for Call or Website).
    numbers.forEach((n) => (n.status = "disconnected"));
    expect(((await page()) as ReactElement<Parameters<typeof LeadFormBuilder>[0]>).props.whatsappNumber).toBeNull();
  });

  it("starts an edited copy from the workspace's own form, and is not found for another workspace's form or a bad id", async () => {
    process.env.PROMOTE_ENABLED = "on";
    auth.getActor.mockResolvedValue({ userId: "u1", tenantId: "t1", role: "admin" });
    db.metaAsset.findMany.mockResolvedValue([{ id: "pg1", name: "Sunrise Salon", externalId: "104857600123", connectionId: "c1", meta: {} }]);
    db.phoneNumber.findFirst.mockResolvedValue(null);
    db.platformSetting.findUnique.mockResolvedValue(null);
    db.leadForm.findFirst.mockResolvedValue({ id: "f1", name: "Diwali enquiries", pageAssetId: "pg1", spec: { questions: [{ type: "FULL_NAME" }, { type: "PHONE" }] } });
    const el = (await page("f1")) as ReactElement<Parameters<typeof LeadFormBuilder>[0]>;
    expect(el.props.copyFrom).toEqual({ id: "f1", name: "Diwali enquiries", pageAssetId: "pg1", spec: { questions: [{ type: "FULL_NAME" }, { type: "PHONE" }] } });
    expect(db.leadForm.findFirst).toHaveBeenCalledWith({ where: { id: "f1", tenantId: "t1" }, select: { id: true, name: true, pageAssetId: true, spec: true } });

    db.leadForm.findFirst.mockResolvedValue(null);
    await expect(page("someone-elses")).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(page("../x")).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("renders the builder: page picker, Create, a lazy preview placeholder and no dialog until Create", () => {
    const out = html(
      createElement(LeadFormBuilder, {
        pages: [{ id: "pg1", name: "Sunrise Salon", connectionId: "c1", leadgenTos: "missing", leadgenHref: metaScreenHref("leadgen_tos", { pageId: "104857600123" }) }],
        whatsappNumber: "+91 98765 43210",
        verifiedName: null,
        privacyUrl: PRIVACY,
        copyFrom: null,
        today: TODAY,
      }),
    );
    expect(out).toContain("<h1");
    expect(out).toContain("Make a lead form");
    expect(out).toContain('data-testid="form-page"');
    expect(out).toContain('data-testid="form-create"');
    expect(out).toContain('value="Instant form 2026-10-31"');
    expect(out).toContain("Meta doesn&#x27;t let you change or delete a form once it&#x27;s created.");
    expect(out).not.toContain('data-testid="form-create-dialog"');
    expect(out).toContain('data-testid="form-readiness-leadgen"');
  });

  it("names the business in the consent box from the Page, else the WhatsApp display name, never the 'Your Facebook Page' label", () => {
    const out = html(
      createElement(LeadFormBuilder, {
        pages: [{ id: "pg3", name: null, connectionId: "c1", leadgenTos: "ok", leadgenHref: null }],
        whatsappNumber: "+91 98765 43210",
        verifiedName: "Sunrise",
        privacyUrl: PRIVACY,
        copyFrom: null,
        today: TODAY,
      }),
    );
    expect(out).toContain("I agree to get WhatsApp messages from Sunrise<");
    expect(out).toContain(">Your Facebook Page</option>");
    expect(out).not.toContain("messages from Your Facebook Page");
  });

  it("asks to connect a Page when there is none", () => {
    const out = html(createElement(LeadFormBuilder, { pages: [], whatsappNumber: null, verifiedName: null, privacyUrl: null, copyFrom: null, today: TODAY }));
    expect(out).toContain(FORM_BUILDER_TEXT.noPages);
    expect(out).toContain('href="/app/settings/connections"');
    expect(out).not.toContain('data-testid="form-create"');
  });
});
