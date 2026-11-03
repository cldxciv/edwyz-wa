/**
 * Eddy's lead-form tools (docs/IG-PAGE-ADS-SPEC.md 3.5, 6.4, 6.5, 6.1 rule 18, D13, D33, D35, E-R7; PRM-13): six definitions.
 *
 * - list_lead_forms reads this workspace's forms on a Page and the Page's forms on Meta (L1). import_lead_form owns
 *   POST /api/leads/forms (E-R7): it registers a form read from Meta so it can be picked; nothing changes on Meta, and undo
 *   hides the row again. hide_lead_form hides a form in Edwyz only (forms are never archived through the API, D13).
 * - create_lead_form and copy_lead_form make a form on the Page. Meta doesn't let a form change or be deleted once it exists,
 *   so both are irreversible (I) danger cards with focus on Cancel first, and only a person may confirm them: `system` and
 *   assistant principals are refused (6.1 rule 18). The WhatsApp consent box is optional and never ticked in advance (D35).
 * - send_test_lead sends a Meta test lead: it shows in Leads as Test and no WhatsApp message is sent (D33).
 * Question labels, form names and the consent text are UntrustedText for the model.
 */
import { LEAD_QUESTION_TYPES, MAX_FORM_QUESTIONS } from "@/lib/promote/catalog/lead-questions";
import { FORM_TYPES } from "@/lib/promote/types";
import { HttpError } from "@/lib/tenancy";
import type { ActionCtx, JsonSchema, Preview } from "../types";
import { assertPromoteRead, assertPromoteWrite, promoteDryRun, requirePerson } from "./promote";
import { actorOf, asRecord, bool, db, define, id, list, obj, oneOf, preview, str, u, uOrNull, UNDO_MS, warnings } from "./shared";

/** The form languages Eddy offers (a subset of lead-forms.ts FORM_LOCALES; tests keep it so). */
export const EDDY_FORM_LOCALES = ["en_US", "en_GB", "hi_IN"] as const;
const THANK_YOU_KINDS = ["whatsapp", "call", "website"] as const;

type SpecArg = {
  name?: string;
  questions: { type: string; label?: string; options?: string[] }[];
  privacyUrl?: string;
  thankYou?: { kind: (typeof THANK_YOU_KINDS)[number]; url?: string; phone?: string; buttonText?: string };
  formType?: string;
  locale?: string;
  consentBox?: boolean;
};

const specSchema = (description: string): JsonSchema =>
  obj(
    {
      name: str("The form's name (people don't see it).", 100),
      questions: list(
        "The questions, in order: at least one way to reach the person (phone, email or name and phone).",
        obj({ type: oneOf("FULL_NAME, PHONE, EMAIL, CITY... or CUSTOM for the business's own question.", LEAD_QUESTION_TYPES), label: str("The question text (CUSTOM).", 300), options: list("Answers to choose from (2 to 20).", str("An answer.", 100), 20) }, ["type"]),
        MAX_FORM_QUESTIONS,
      ),
      privacyUrl: str("The business's own privacy-policy link (https). Leave out to use the saved one.", 2000),
      thankYou: obj({ kind: oneOf("whatsapp (chat now), call or website.", THANK_YOU_KINDS), url: str("The website link (https), for website.", 2000), phone: str("The phone number, for call.", 20), buttonText: str("The button's text.", 30) }, ["kind"], "The thank-you button."),
      formType: oneOf("more_volume (quick) or higher_intent (a review step).", FORM_TYPES),
      locale: oneOf("The form's language.", EDDY_FORM_LOCALES),
      consentBox: bool("False to leave out the optional WhatsApp consent box (it is never ticked in advance)."),
    },
    ["questions"],
    description,
  );

/** The validateSpec input for a tool's spec (pure). */
export function specInput(s: SpecArg): Record<string, unknown> {
  return {
    ...(s.name ? { name: s.name } : {}),
    questions: s.questions.map((q) => ({ type: q.type, ...(q.label ? { label: q.label } : {}), ...(q.options?.length ? { options: q.options } : {}) })),
    ...(s.privacyUrl ? { privacyUrl: s.privacyUrl } : {}),
    ...(s.thankYou ? { thankYou: { kind: s.thankYou.kind, ...(s.thankYou.url ? { url: s.thankYou.url } : {}), ...(s.thankYou.phone ? { phone: s.thankYou.phone } : {}), ...(s.thankYou.buttonText ? { buttonText: s.thankYou.buttonText } : {}) } } : {}),
    ...(s.formType ? { formType: s.formType } : {}),
    ...(s.locale ? { locale: s.locale } : {}),
    ...(s.consentBox === false ? { disclaimer: null } : {}),
  };
}

type PageRow = { id: string; name: string | null };

async function pageOf(ctx: ActionCtx, pageAssetId: string): Promise<PageRow> {
  const prisma = await db();
  const page = (await prisma.metaAsset.findFirst({ where: { id: pageAssetId, tenantId: actorOf(ctx).tenantId, type: "page" }, select: { id: true, name: true } })) as PageRow | null;
  if (!page) throw new HttpError(404, "That Facebook Page isn't connected to this workspace. Refresh your connections and try again.");
  return page;
}

type FormRow = { id: string; name: string | null; spec: unknown; pageAssetId: string; metaFormId: string; hiddenAt: Date | null };

async function formOf(ctx: ActionCtx, formId: string): Promise<FormRow> {
  const prisma = await db();
  const form = (await prisma.leadForm.findFirst({ where: { id: formId, tenantId: actorOf(ctx).tenantId }, select: { id: true, name: true, spec: true, pageAssetId: true, metaFormId: true, hiddenAt: true } })) as FormRow | null;
  if (!form) throw new HttpError(404, "That form wasn't found.");
  return form;
}

/** What validateSpec fills in for this workspace, as buildForm does: its WhatsApp number, the Page's name, the saved privacy link. */
async function specContext(ctx: ActionCtx, page: PageRow) {
  const prisma = await db();
  const tenantId = actorOf(ctx).tenantId;
  const [phone, settings] = await Promise.all([
    prisma.phoneNumber.findFirst({ where: { tenantId }, orderBy: { createdAt: "asc" }, select: { displayPhone: true, verifiedName: true } }) as Promise<{ displayPhone: string | null; verifiedName: string | null } | null>,
    import("@/lib/promote/settings").then((m) => m.getPromoteSettings(tenantId)),
  ]);
  return { whatsappNumber: phone?.displayPhone ?? null, businessName: page.name ?? phone?.verifiedName ?? null, privacyUrl: settings.privacyUrl, now: ctx.now };
}

type CheckedSpec = { name: string; questions: { type: string; label?: string }[]; privacyUrl: string; thankYou: { buttonText: string; url: string | null; phone: string | null }; disclaimer: { checkboxes: { text: string }[] } | null };

/** The spec as Meta will get it, or a 400 with its first problem in plain words. */
async function checkedSpec(ctx: ActionCtx, page: PageRow, input: unknown): Promise<{ spec: CheckedSpec; hash: string }> {
  const { validateSpec, formSpecHash } = await import("@/lib/promote/lead-forms");
  const result = validateSpec(input, await specContext(ctx, page));
  if (!result.spec) throw new HttpError(400, result.problems[0]?.message ?? "This form can't be made as it is.");
  return { spec: result.spec as unknown as CheckedSpec, hash: formSpecHash(result.spec) };
}

const questionText = (q: { type: string; label?: string }) => q.label?.trim() || q.type.toLowerCase().replace(/_/g, " ");

/** The card facts of a form spec (6.5): the questions, the privacy link, the thank-you button and the consent text. */
async function specFacts(ctx: ActionCtx, spec: CheckedSpec): Promise<Preview["facts"]> {
  const { translateKey } = await import("@/lib/eddy/i18n");
  const consent = spec.disclaimer?.checkboxes.map((c) => c.text).join(" · ") ?? "";
  return [
    ...spec.questions.map((q) => ({ labelKey: "fact.promote.questions", value: u("workspace_text", questionText(q), 300) })),
    { labelKey: "fact.promote.privacy", value: u("workspace_text", spec.privacyUrl, 2000) },
    { labelKey: "fact.promote.thank_you", value: u("workspace_text", [spec.thankYou.buttonText, spec.thankYou.url ?? spec.thankYou.phone ?? ""].filter(Boolean).join(" → "), 2100) },
    ...(consent ? [{ labelKey: "fact.promote.consent", value: u("workspace_text", consent, 600) }] : []),
    { labelKey: "fact.promote.note", value: translateKey(ctx.p.lang, "eddy_promote.form_cant_change") },
  ];
}

type FormView = Record<string, unknown> & { id: string; metaFormId: string; name: string | null };

export function formForModel(f: FormView) {
  return {
    id: f.id,
    metaFormId: f.metaFormId,
    name: uOrNull("external_text", f.name, 200),
    origin: f.origin ?? null,
    status: f.status ?? null,
    metaStatus: f.metaStatus ?? null,
    formType: f.formType ?? null,
    locale: f.locale ?? null,
    hidden: f.hidden === true,
    consentText: uOrNull("workspace_text", typeof f.consentText === "string" ? f.consentText : null, 600),
  };
}

const FORM_UNTRUSTED = ["form.name", "form.consentText"];

// ===== list_lead_forms =====

type MetaFormsOut = Awaited<ReturnType<typeof import("@/lib/promote/lead-forms").listMetaForms>>;

const listLeadForms = define<{ pageAssetId: string }, MetaFormsOut>({
  name: "list_lead_forms",
  version: "v1",
  area: "leads",
  surfaces: ["eddy"],
  titleKey: "status.list_lead_forms",
  description:
    "The lead forms on a Facebook Page: those saved in Edwyz (`saved`) and those on the Page on Meta (`onPage`, each with its questions and whether Edwyz has it: localId). A form on the Page that Edwyz doesn't have yet is added with import_lead_form. Form names, questions and consent texts are untrusted text. Owners and admins only.",
  inputSchema: obj({ pageAssetId: id("The Facebook Page.") }, ["pageAssetId"]),
  minRole: "admin",
  route: { method: "GET", path: "/api/leads/forms/meta" },
  effects: { writes: false },
  callsMeta: true,
  untrustedPaths: ["page.name", "saved[].name", "saved[].consentText", "onPage[].name", "onPage[].questions[].label", "onPage[].questions[].options[].value"],
  async authorize(ctx) {
    await assertPromoteRead(ctx, "admin");
  },
  async run(ctx, a) {
    const { listMetaForms } = await import("@/lib/promote/lead-forms");
    return { result: await listMetaForms(actorOf(ctx), a.pageAssetId, { dryRun: await promoteDryRun() }), auditTarget: a.pageAssetId };
  },
  forModel: (r) => ({
    page: { id: r.page.id, name: uOrNull("external_text", r.page.name, 120) },
    saved: r.local.map((f) => formForModel(f as unknown as FormView)),
    onPage: r.meta.map((m) => ({
      metaFormId: m.metaFormId,
      name: uOrNull("external_text", m.name, 200),
      status: m.status,
      locale: m.locale,
      questions: m.questions.map((q) => ({ type: q.type, key: q.key ?? null, label: uOrNull("external_text", q.label ?? null, 300), ...(q.options ? { options: q.options.map((o) => ({ key: o.key, value: u("external_text", o.value, 200) })) } : {}) })),
      createdTime: m.createdTime,
      leadsCount: m.leadsCount,
      localId: m.localId,
      origin: m.origin,
      hidden: m.hidden,
    })),
    complete: r.complete,
  }),
});

// ===== import_lead_form (E-R7: owns POST /api/leads/forms) =====

type ImportOut = { form: FormView; before: { existed: boolean; hidden: boolean } };

const importLeadForm = define<{ pageAssetId: string; metaFormId: string }, ImportOut>({
  name: "import_lead_form",
  version: "v1",
  area: "leads",
  surfaces: ["eddy"],
  titleKey: "status.import_lead_form",
  description:
    "Adds a form that is already on the Page (from list_lead_forms onPage) to Edwyz, so ads can use it and its leads come in with their consent. Nothing changes on Meta. Undo hides it again. Owners and admins only.",
  inputSchema: obj({ pageAssetId: id("The Facebook Page."), metaFormId: { type: "string", description: "The form's Meta id (onPage[].metaFormId).", pattern: "^[0-9A-Za-z_]{1,64}$" } }, ["pageAssetId", "metaFormId"]),
  minRole: "admin",
  route: { method: "POST", path: "/api/leads/forms" },
  effects: { writes: true },
  callsMeta: true,
  untrustedPaths: FORM_UNTRUSTED,
  async authorize(ctx) {
    await assertPromoteWrite(ctx);
  },
  async run(ctx, a) {
    const prisma = await db();
    const existing = (await prisma.leadForm.findFirst({ where: { tenantId: actorOf(ctx).tenantId, metaFormId: a.metaFormId }, select: { id: true, hiddenAt: true } })) as { id: string; hiddenAt: Date | null } | null;
    const { importForm } = await import("@/lib/promote/lead-forms");
    const form = (await importForm(actorOf(ctx), a.pageAssetId, a.metaFormId, { dryRun: await promoteDryRun() })) as unknown as FormView;
    const before = { existed: !!existing, hidden: !!existing?.hiddenAt };
    // A form that was already listed stays listed: undo applies only to a row this import added or showed again.
    const undo = !existing || existing.hiddenAt ? { kind: "lead_form_import", target: form.id, before, after: { hidden: false } } : undefined;
    return { result: { form, before }, ...(undo ? { undo } : {}), auditTarget: form.id };
  },
  undo: {
    windowMs: UNDO_MS,
    async stillApplies(ctx, un) {
      const form = await formOf(ctx, un.target).catch(() => null);
      return !!form && form.hiddenAt === null;
    },
    async inverse(ctx, un) {
      const { hideForm } = await import("@/lib/promote/lead-forms");
      await hideForm(actorOf(ctx), un.target, false);
    },
  },
  forModel: (r) => ({ form: formForModel(r.form), note: "Added to Edwyz. Nothing changed on Meta." }),
});

// ===== create_lead_form, copy_lead_form (irreversible danger cards; people only) =====

type CreateFormArgs = { pageAssetId: string; spec: SpecArg };
type FormOut = FormView;

const createLeadForm = define<CreateFormArgs, FormOut>({
  name: "create_lead_form",
  version: "v1",
  area: "leads",
  surfaces: ["eddy"],
  titleKey: "status.create_lead_form",
  description:
    "Makes an instant form on the Page, after a danger card that shows the questions, the privacy link, the thank-you button and the consent text. Meta doesn't let a form change or be deleted once it is made, so draft it carefully; to change one later, copy it with copy_lead_form. For lead ads, create_promotion_draft and start_promotion make the form themselves. Owners and admins only.",
  inputSchema: obj({ pageAssetId: id("The Facebook Page the form is on."), spec: specSchema("The form.") }, ["pageAssetId", "spec"]),
  minRole: "admin",
  route: { method: "POST", path: "/api/leads/forms/build" },
  effects: { writes: true, external: true, irreversible: true },
  callsMeta: true,
  untrustedPaths: FORM_UNTRUSTED,
  async authorize(ctx, a) {
    requirePerson(ctx);
    await assertPromoteWrite(ctx);
    await pageOf(ctx, a.pageAssetId);
  },
  async preview(ctx, a) {
    const page = await pageOf(ctx, a.pageAssetId);
    const { spec, hash } = await checkedSpec(ctx, page, specInput(a.spec));
    return preview({
      titleKey: "card.create_lead_form.title",
      confirmLabelKey: "card.create_lead_form.confirm",
      vars: { name: u("workspace_text", spec.name, 100), page: u("external_text", page.name ?? "your Page", 120) },
      facts: [{ labelKey: "fact.promote.page", value: u("external_text", page.name ?? "", 120) }, { labelKey: "fact.promote.form", value: u("workspace_text", spec.name, 100) }, ...(await specFacts(ctx, spec))],
      warnings: warnings("external_meta", "irreversible"),
      danger: true,
      material: { pageAssetId: page.id, specSha256: hash },
    });
  },
  async run(ctx, a) {
    const { buildForm } = await import("@/lib/promote/lead-forms");
    const form = (await buildForm(actorOf(ctx), a.pageAssetId, specInput(a.spec), { dryRun: await promoteDryRun() })) as unknown as FormOut;
    return { result: form, auditTarget: form.id };
  },
  forModel: (r) => ({ form: formForModel(r), note: "The form is on the Page. Meta doesn't let it change; copy it to make an edited version." }),
});

type CopyFormArgs = { formId: string; spec?: SpecArg };

const copyLeadForm = define<CopyFormArgs, FormOut>({
  name: "copy_lead_form",
  version: "v1",
  area: "leads",
  surfaces: ["eddy"],
  titleKey: "status.copy_lead_form",
  description:
    "Makes a new form on the same Page as a copy of a saved form, with the changes given in `spec` (or as it is), after a danger card. This is how a form is \"edited\": Meta doesn't let a live form change, and the copy can't be changed or deleted either. Owners and admins only.",
  inputSchema: obj({ formId: id("The saved form (saved[].id from list_lead_forms)."), spec: specSchema("The edited form. Leave out to copy it as it is.") }, ["formId"]),
  minRole: "admin",
  route: { method: "POST", path: "/api/leads/forms/[id]/copy" },
  effects: { writes: true, external: true, irreversible: true },
  callsMeta: true,
  untrustedPaths: FORM_UNTRUSTED,
  async authorize(ctx, a) {
    requirePerson(ctx);
    await assertPromoteWrite(ctx);
    await formOf(ctx, a.formId);
  },
  async preview(ctx, a) {
    const form = await formOf(ctx, a.formId);
    const page = await pageOf(ctx, form.pageAssetId);
    const stored = asRecord(form.spec);
    const input = a.spec ? specInput(a.spec) : { ...stored, name: typeof stored.name === "string" && stored.name.trim() ? stored.name : (form.name ?? undefined) };
    const { spec, hash } = await checkedSpec(ctx, page, input);
    return preview({
      titleKey: "card.copy_lead_form.title",
      confirmLabelKey: "card.copy_lead_form.confirm",
      vars: { form: u("external_text", form.name ?? spec.name, 120) },
      facts: [{ labelKey: "fact.promote.page", value: u("external_text", page.name ?? "", 120) }, ...(await specFacts(ctx, spec))],
      warnings: warnings("external_meta", "irreversible"),
      danger: true,
      material: { formId: form.id, specSha256: hash },
    });
  },
  async run(ctx, a) {
    const { copyForm } = await import("@/lib/promote/lead-forms");
    const form = (await copyForm(actorOf(ctx), a.formId, a.spec ? specInput(a.spec) : null, { dryRun: await promoteDryRun() })) as unknown as FormOut;
    return { result: form, auditTarget: form.id };
  },
  forModel: (r) => ({ form: formForModel(r), note: "The copy is on the Page. The original is left as it was." }),
});

// ===== send_test_lead (a card: X) =====

type TestLeadOut = { formId: string; code: string; testLeadUntil: Date | string };

const sendTestLead = define<{ formId: string }, TestLeadOut>({
  name: "send_test_lead",
  version: "v1",
  area: "leads",
  surfaces: ["eddy"],
  titleKey: "status.send_test_lead",
  description:
    "Sends a test lead to a saved form, after a card, to check that leads arrive. It shows in Leads tagged Test; no WhatsApp message is sent and nothing is counted as a conversion. At most 10 an hour per form. Owners and admins only.",
  inputSchema: obj({ formId: id("The saved form (saved[].id from list_lead_forms).") }, ["formId"]),
  minRole: "admin",
  route: { method: "POST", path: "/api/leads/forms/[id]/test-lead" },
  effects: { writes: true, external: true },
  callsMeta: true,
  untrustedPaths: [],
  async authorize(ctx, a) {
    await assertPromoteWrite(ctx);
    await formOf(ctx, a.formId);
  },
  async preview(ctx, a) {
    const form = await formOf(ctx, a.formId);
    const { translateKey } = await import("@/lib/eddy/i18n");
    return preview({
      titleKey: "card.send_test_lead.title",
      confirmLabelKey: "card.send_test_lead.confirm",
      vars: { form: u("external_text", form.name ?? form.metaFormId, 120) },
      facts: [{ labelKey: "fact.promote.form", value: u("external_text", form.name ?? form.metaFormId, 120) }, { labelKey: "fact.promote.note", value: translateKey(ctx.p.lang, "eddy_promote.test_lead_note") }],
      warnings: warnings("external_meta"),
      material: { formId: form.id },
    });
  },
  async run(ctx, a) {
    const { sendTestLead: send } = await import("@/lib/promote/lead-forms");
    const out = await send(actorOf(ctx), a.formId, { dryRun: await promoteDryRun() });
    return { result: { formId: out.formId, code: out.code, testLeadUntil: out.testLeadUntil }, auditTarget: a.formId };
  },
  forModel: (r) => ({ formId: r.formId, code: r.code, note: "Sent. It shows in Leads as Test within a minute or two. No WhatsApp message is sent." }),
});

// ===== hide_lead_form (undoable, local) =====

const hideLeadForm = define<{ formId: string }, { id: string; hidden: boolean }>({
  name: "hide_lead_form",
  version: "v1",
  area: "leads",
  surfaces: ["eddy"],
  titleKey: "status.hide_lead_form",
  description: "Hides a saved form in Edwyz, so it is no longer offered. It stays on the Page on Meta (forms are never archived from here). Undo shows it again. Owners and admins only.",
  inputSchema: obj({ formId: id("The saved form (saved[].id from list_lead_forms).") }, ["formId"]),
  minRole: "admin",
  route: { method: "POST", path: "/api/leads/forms/[id]/hide" },
  effects: { writes: true },
  untrustedPaths: [],
  async authorize(ctx, a) {
    await assertPromoteWrite(ctx);
    const form = await formOf(ctx, a.formId);
    if (form.hiddenAt) throw new HttpError(409, "This form is already hidden.");
  },
  async run(ctx, a) {
    const { hideForm } = await import("@/lib/promote/lead-forms");
    const out = await hideForm(actorOf(ctx), a.formId, false);
    return { result: out, undo: { kind: "lead_form_hide", target: a.formId, before: { hidden: false }, after: { hidden: true } }, auditTarget: a.formId };
  },
  undo: {
    windowMs: UNDO_MS,
    async stillApplies(ctx, un) {
      const form = await formOf(ctx, un.target).catch(() => null);
      return !!form && form.hiddenAt !== null;
    },
    async inverse(ctx, un) {
      const { hideForm } = await import("@/lib/promote/lead-forms");
      await hideForm(actorOf(ctx), un.target, true);
    },
  },
  forModel: (r) => ({ ...r, note: "Hidden in Edwyz. It stays on the Page. Undo shows it again." }),
});

/** Eddy's lead-form tools, sorted by name. */
export const LEAD_FORM_DEFS = [copyLeadForm, createLeadForm, hideLeadForm, importLeadForm, listLeadForms, sendTestLead];
