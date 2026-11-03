import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Forms page actions (docs/IG-PAGE-ADS-SPEC.md 7.1, 6.5 send_test_lead, D13, D33, D35, PRM-15 / PRM-LF): "Made in Edwyz",
 * Send a test lead, Make a copy to edit, Hide with Undo, Import from Meta, and the server page's canBuild gate. Today's consent
 * wording and blanket opt-in stay as they were for forms not made in Edwyz (e2e/growth-leads.spec.ts).
 */

const jar = vi.hoisted(() => ({ cookies: [] as { name: string; value: string }[] }));
vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => jar.cookies }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }), notFound: () => { throw new Error("NEXT_NOT_FOUND"); } }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children?: ReactNode }) => createElement("a", { href, ...rest }, children),
}));
const auth = vi.hoisted(() => ({ getActor: vi.fn() }));
vi.mock("@/lib/auth", () => auth);
const db = vi.hoisted(() => ({ user: { findUnique: vi.fn() }, spendControl: { findUnique: vi.fn() }, leadForm: { findMany: vi.fn() }, platformSetting: { findMany: vi.fn() } }));
vi.mock("@/lib/db", () => ({ prisma: db }));

import { readFileSync } from "node:fs";
import path from "node:path";
import LeadFormsPage from "@/app/(app)/app/leads/forms/page";
import {
  copyEditHref,
  FORM_BUILDER_PATH,
  FormCard,
  formTags,
  FormsView,
  FORMS_VIEW_TEXT,
  HiddenForms,
  hideWithUndo,
  importableForms,
  pagesFromConnections,
  showAgain,
  testLeadDialog,
  testSent,
  type CardActions,
} from "@/components/leads/FormsView";
import { BUILDER_PATH, FORM_BUILDER_TEXT } from "@/components/promote/form-builder-helpers";
import { toastReducer, initialToastState } from "@/components/ui/toast-state";
import { promoteText } from "@/lib/promote/copy";

const html = (el: ReactElement) => renderToStaticMarkup(el).replace(/<!-- -->/g, "");
const NOW = Date.parse("2026-10-31T10:00:00Z");
const form = (patch: Record<string, unknown> = {}) => ({ id: "f1", metaFormId: "mf1", name: "Diwali enquiries", consentText: "I agree to get WhatsApp messages from Sunrise Salon", status: "active", origin: "created", testLeadUntil: null, ...patch });
const actions = (patch: Partial<CardActions> = {}): CardActions => ({ canBuild: true, now: NOW, testing: false, onTestLead: () => undefined, onHide: () => undefined, ...patch });
const saved = { ...process.env };

beforeEach(() => {
  jar.cookies = [{ name: "wa_access", value: "token" }];
  auth.getActor.mockReset();
  for (const table of Object.values(db)) for (const fn of Object.values(table)) fn.mockReset();
});
afterEach(() => {
  process.env = { ...saved };
});

describe("a form made in Edwyz", () => {
  it("shows 'Made in Edwyz'; registered and imported forms don't", () => {
    expect(formTags({ origin: "created" })).toEqual(["Made in Edwyz"]);
    expect(formTags({ origin: "created" })).toEqual([promoteText("boost.made_in_edwyz")]);
    expect(formTags({ origin: "registered" })).toEqual([]);
    expect(formTags({ origin: "imported" })).toEqual([]);
    expect(formTags({})).toEqual([]);
    const out = html(createElement(FormCard, { form: form(), admin: true, actions: actions() }));
    expect(out).toContain('data-testid="form-made-in-edwyz"');
    expect(out).toContain("Made in Edwyz");
  });

  it("shows its WhatsApp box's words read-only, with no blanket opt-in (D35)", () => {
    const out = html(createElement(FormCard, { form: form(), admin: true, actions: actions() }));
    expect(out).toContain('data-testid="form-created-consent"');
    expect(out).toContain("I agree to get WhatsApp messages from Sunrise Salon");
    expect(out).not.toContain("Count every lead from this form as having agreed");
    expect(out).not.toContain("Save consent wording");
  });

  it("keeps today's consent wording and blanket opt-in for other forms", () => {
    const out = html(createElement(FormCard, { form: form({ origin: "registered", consentText: null }), admin: true, actions: actions({ canBuild: false }) }));
    expect(out).toContain("Consent wording");
    expect(out).toContain("Count every lead from this form as having agreed");
    expect(out).toContain("Save consent wording");
    expect(out).not.toContain("Made in Edwyz");
    expect(out).not.toContain('data-testid="form-actions-f1"');
  });
});

describe("the per-form actions", () => {
  it("offers Send a test lead, Make a copy to edit and Hide when the member can build, each with a test id", () => {
    const out = html(createElement(FormCard, { form: form(), admin: true, actions: actions() }));
    expect(out).toContain('data-testid="form-test-lead-f1"');
    expect(out).toContain(">Send a test lead<");
    expect(out).toContain('data-testid="form-copy-f1"');
    expect(out).toContain('href="/app/leads/forms/new?copy=f1"');
    expect(out).toContain(">Make a copy to edit<");
    expect(out).toContain('data-testid="form-hide-f1"');
    expect(out).toContain('aria-label="Hide &#x27;Diwali enquiries&#x27;"');
    // A registered form has no stored questions to copy.
    expect(html(createElement(FormCard, { form: form({ origin: "registered" }), admin: true, actions: actions() }))).not.toContain('data-testid="form-copy-f1"');
  });

  it("copies only forms whose questions are known", () => {
    expect(copyEditHref({ id: "f1", origin: "created" })).toBe("/app/leads/forms/new?copy=f1");
    expect(copyEditHref({ id: "f 2", origin: "imported" })).toBe("/app/leads/forms/new?copy=f%202");
    expect(copyEditHref({ id: "f3", origin: "registered" })).toBeNull();
  });

  it("test-lead copy matches the send_test_lead card", () => {
    expect(testLeadDialog("Diwali enquiries")).toEqual({
      title: "Send a test lead to 'Diwali enquiries'?",
      body: "It shows in Leads as Test. No WhatsApp message is sent.",
      confirmLabel: "Send a test lead",
    });
    expect(testLeadDialog("Diwali enquiries").body).toBe(promoteText("form.test_lead_note"));
    expect(testLeadDialog(null).title).toBe("Send a test lead to 'Untitled form'?");
  });

  it("shows 'Test sent' until testLeadUntil, and only that (D33)", () => {
    const later = new Date(NOW + 5 * 60_000).toISOString();
    expect(testSent({ testLeadUntil: later }, NOW)).toBe(true);
    expect(testSent({ testLeadUntil: later }, NOW + 6 * 60_000)).toBe(false);
    expect(testSent({ testLeadUntil: null }, NOW)).toBe(false);
    expect(testSent({ testLeadUntil: "junk" }, NOW)).toBe(false);
    const out = html(createElement(FormCard, { form: form({ testLeadUntil: later }), admin: true, actions: actions() }));
    expect(out).toContain('data-testid="form-test-sent"');
    expect(out).toContain(promoteText("form.test_sent"));
    expect(html(createElement(FormCard, { form: form(), admin: true, actions: actions() }))).not.toContain('data-testid="form-test-sent"');
  });
});

describe("hide with undo", () => {
  it("calls the hide route twice: hide, then { undo: true } from the toast's Undo", async () => {
    const post = vi.fn(async () => ({ ok: true }));
    const success = vi.fn();
    const error = vi.fn();
    const onHidden = vi.fn();
    const onRestored = vi.fn();
    const announce = vi.fn();
    expect(await hideWithUndo({ id: "f1", name: "Diwali enquiries" }, { post, toast: { success, error }, onHidden, onRestored, announce })).toBe(true);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenNthCalledWith(1, "/api/leads/forms/f1/hide", {});
    expect(onHidden).toHaveBeenCalledTimes(1);
    const [title, options] = success.mock.calls[0] as [string, { action: { label: string; onAction: () => void }; duration?: number }];
    expect(title).toBe("Hid 'Diwali enquiries' here. It stays on Meta. Find it under Hidden forms.");
    expect(options.action.label).toBe("Undo");
    expect(announce).toHaveBeenCalledWith("Hid 'Diwali enquiries' here. It stays on Meta. Find it under Hidden forms.");

    options.action.onAction();
    await vi.waitFor(() => expect(onRestored).toHaveBeenCalledTimes(1));
    expect(post).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenNthCalledWith(2, "/api/leads/forms/f1/hide", { undo: true });
    expect(success).toHaveBeenLastCalledWith("'Diwali enquiries' is back on the list.");
    expect(error).not.toHaveBeenCalled();
  });

  it("says so when the form can't be hidden, and offers no Undo", async () => {
    const post = vi.fn(async () => Promise.reject(new Error("Form not found.")));
    const success = vi.fn();
    const error = vi.fn();
    const onHidden = vi.fn();
    expect(await hideWithUndo({ id: "f1", name: null }, { post, toast: { success, error }, onHidden })).toBe(false);
    expect(error).toHaveBeenCalledWith(FORMS_VIEW_TEXT.hideFailed, { description: "Form not found." });
    expect(success).not.toHaveBeenCalled();
    expect(onHidden).not.toHaveBeenCalled();
  });

  it("says so when Undo fails", async () => {
    const post = vi.fn(async (_path: string, body: unknown) => ((body as { undo?: boolean }).undo ? Promise.reject(new Error("Try again.")) : {}));
    const success = vi.fn();
    const error = vi.fn();
    await hideWithUndo({ id: "f1", name: "Diwali enquiries" }, { post, toast: { success, error } });
    (success.mock.calls[0][1] as { action: { onAction: () => void } }).action.onAction();
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith(FORMS_VIEW_TEXT.undoFailed, { description: "Try again." }));
  });

  it("keeps the Undo toast until it is closed: no time limit (WCAG 2.2.1)", async () => {
    const success = vi.fn();
    await hideWithUndo({ id: "f1", name: "Diwali enquiries" }, { post: vi.fn(async () => ({})), toast: { success, error: vi.fn() } });
    const [title, options] = success.mock.calls[0] as [string, { duration?: number; action?: { label: string; onAction: () => void } }];
    expect(options.duration).toBeUndefined();
    // What the toast system makes of these options: an action toast with no duration stays until the person closes it.
    const added = toastReducer(initialToastState, { type: "add", id: "t1", input: { title, tone: "success", ...options }, now: 0 });
    expect(added.toasts[0].duration).toBe(0);
    const anHourLater = toastReducer(added, { type: "tick", now: 60 * 60_000 });
    expect(anHourLater.toasts.map((t) => t.title)).toEqual([title]);
  });

  it("a form hidden with no Undo can still be shown again: it is listed under Hidden forms with Show again", async () => {
    const post = vi.fn(async () => ({}));
    const success = vi.fn();
    const hidden: { id: string; metaFormId: string; name: string | null }[] = [];
    await hideWithUndo({ id: "f1", name: "Diwali enquiries" }, { post, toast: { success, error: vi.fn() }, onHidden: () => hidden.push({ id: "f1", metaFormId: "mf1", name: "Diwali enquiries" }) });
    // The toast's Undo is never pressed.
    expect(post).toHaveBeenCalledTimes(1);
    const list = html(createElement(HiddenForms, { forms: hidden, canShow: true, showing: null, onShow: () => undefined }));
    expect(list).toContain("Hidden forms (1)");
    expect(list).toContain('data-testid="forms-show-f1"');
    expect(list).toContain('aria-label="Show &#x27;Diwali enquiries&#x27; again"');
    expect(list).toContain(">Show again<");

    const onRestored = vi.fn();
    const announce = vi.fn();
    expect(await showAgain(hidden[0], { post, toast: { success, error: vi.fn() }, onRestored, announce })).toBe(true);
    expect(post).toHaveBeenLastCalledWith("/api/leads/forms/f1/hide", { undo: true });
    expect(onRestored).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenLastCalledWith("'Diwali enquiries' is back on the list.");
    expect(success).toHaveBeenLastCalledWith("'Diwali enquiries' is back on the list.");
  });

  it("says so when Show again fails, and keeps the form hidden", async () => {
    const error = vi.fn();
    const onRestored = vi.fn();
    const announce = vi.fn();
    const post = vi.fn(async () => Promise.reject(new Error("Form not found.")));
    expect(await showAgain({ id: "f1", name: "Diwali enquiries" }, { post, toast: { success: vi.fn(), error }, onRestored, announce })).toBe(false);
    expect(error).toHaveBeenCalledWith(FORMS_VIEW_TEXT.showFailed, { description: "Form not found." });
    expect(announce).toHaveBeenCalledWith("We could not show this form again. Form not found.");
    expect(onRestored).not.toHaveBeenCalled();
  });
});

describe("hidden forms", () => {
  const hiddenForm = (patch: Record<string, unknown> = {}) => ({ id: "f2", metaFormId: "mf2", name: "Old Diwali form", origin: "imported", consentAssumed: false, ...patch });

  it("lists each hidden form in a closed 'Hidden forms (n)' section, says their leads still come in, and flags a blanket opt-in", () => {
    const out = html(createElement(HiddenForms, { forms: [hiddenForm(), hiddenForm({ id: "f3", name: null, consentAssumed: true })], canShow: true, showing: null, onShow: () => undefined }));
    expect(out).toMatch(/<details[^>]*data-testid="forms-hidden"/);
    expect(out).not.toMatch(/<details[^>]*open/);
    expect(out).toContain("<summary");
    expect(out).toContain("Hidden forms (2)");
    expect(out).toContain(FORMS_VIEW_TEXT.hiddenFormsNote);
    expect(out).toContain("their leads still come in");
    expect(out).toContain('data-testid="forms-show-f2"');
    expect(out).toContain('aria-label="Show &#x27;Untitled form&#x27; again"');
    // Only the form that counts every lead as agreed is flagged.
    expect(out.match(/data-testid="forms-hidden-assumed"/g)).toHaveLength(1);
    expect(out).toContain("Counts every lead as agreed");
    expect(out).toContain("min-h-11");
  });

  it("shows nothing when no form is hidden, and no Show again to a member who can't build", () => {
    expect(html(createElement(HiddenForms, { forms: [], canShow: true, showing: null, onShow: () => undefined }))).toBe("");
    const out = html(createElement(HiddenForms, { forms: [hiddenForm()], canShow: false, showing: null, onShow: () => undefined }));
    expect(out).toContain("Hidden forms (1)");
    expect(out).not.toContain('data-testid="forms-show-f2"');
  });

  it("the Forms page shows the hidden forms it is given", () => {
    const out = html(createElement(FormsView, { canBuild: true, hiddenForms: [hiddenForm()] }));
    expect(out).toContain('data-testid="forms-hidden"');
    expect(out).toContain("Old Diwali form");
    expect(html(createElement(FormsView, { canBuild: true }))).not.toContain('data-testid="forms-hidden"');
  });

  it("the server page gives owners and admins the workspace's hidden forms, and nobody else", async () => {
    process.env.PROMOTE_ENABLED = "on";
    auth.getActor.mockResolvedValue({ userId: "u1", tenantId: "t1", role: "owner" });
    const row = (over: Record<string, unknown>) => ({ id: "f1", metaFormId: "m1", name: null, consentText: null, status: "active", origin: "registered", createdAt: new Date(0), hiddenAt: null, ...over });
    db.leadForm.findMany.mockResolvedValue([row({ id: "f1", name: "Live form" }), row({ id: "f2", metaFormId: "m2", name: "Old Diwali form", origin: "imported", hiddenAt: new Date(0) })]);
    const settings = [{ key: "leads:form-settings:t1:f2", value: { consentAssumed: true } }];
    db.platformSetting.findMany.mockImplementation(async ({ where }: { where: { key: { in: string[] } } }) => settings.filter((s) => where.key.in.includes(s.key)));
    const el = (await LeadFormsPage()) as ReactElement<{ canBuild: boolean; hiddenForms: unknown[] }>;
    expect(el.props.canBuild).toBe(true);
    expect(el.props.hiddenForms).toEqual([{ id: "f2", metaFormId: "m2", name: "Old Diwali form", origin: "imported", consentAssumed: true }]);
    // Hidden ones included: the list is read without the hiddenAt filter, for this workspace only.
    expect(db.leadForm.findMany.mock.calls[0][0].where).toEqual({ tenantId: "t1" });

    db.leadForm.findMany.mockClear();
    auth.getActor.mockResolvedValue({ userId: "u2", tenantId: "t1", role: "agent" });
    expect(((await LeadFormsPage()) as ReactElement<{ hiddenForms: unknown[] }>).props.hiddenForms).toEqual([]);
    expect(db.leadForm.findMany).not.toHaveBeenCalled();

    // A failed read keeps the page working, without the hidden list.
    auth.getActor.mockResolvedValue({ userId: "u1", tenantId: "t1", role: "owner" });
    db.leadForm.findMany.mockRejectedValue(new Error("db down"));
    const fallback = (await LeadFormsPage()) as ReactElement<{ canBuild: boolean; hiddenForms: unknown[] }>;
    expect(fallback.props).toMatchObject({ canBuild: true, hiddenForms: [] });
  });
});

describe("import from Meta", () => {
  it("the import list excludes forms already on the list, and offers Show again for a hidden one instead of leaving it out", () => {
    const items = [
      { metaFormId: "m1", name: "New on the Page", localId: null },
      { metaFormId: "m2", name: "Already here", localId: "f2", origin: "registered", hidden: false },
      { metaFormId: "m3", name: "Hidden here", localId: "f3", origin: "created", hidden: true },
      { metaFormId: "m4", name: "Also new", localId: null },
    ];
    expect(importableForms(items).map((f) => [f.metaFormId, f.action])).toEqual([
      ["m1", "import"],
      ["m3", "show_again"],
      ["m4", "import"],
    ]);
    expect(importableForms([])).toEqual([]);
  });

  it("lists each connected Page once, from live connections only", () => {
    expect(
      pagesFromConnections([
        { status: "active", assets: [{ id: "pg1", type: "page", status: "active", name: "Sunrise Salon" }, { id: "ad1", type: "ad_account", status: "active", name: "Ads" }, { id: "pg2", type: "page", status: "removed", name: "Old" }] },
        { status: "expiring", assets: [{ id: "pg1", type: "page", status: "active", name: "Sunrise Salon" }, { id: "pg3", type: "page", status: "active", name: null }] },
        { status: "revoked", assets: [{ id: "pg4", type: "page", status: "active", name: "Gone" }] },
      ]),
    ).toEqual([
      { id: "pg1", name: "Sunrise Salon" },
      { id: "pg3", name: "Facebook Page" },
    ]);
  });
});

describe("the Forms page", () => {
  it("hides 'Make a form' and 'Import from Meta' while PROMOTE_ENABLED is off, without looking anyone up", async () => {
    process.env.PROMOTE_ENABLED = "off";
    const el = (await LeadFormsPage()) as ReactElement<{ canBuild: boolean }>;
    expect(el.type).toBe(FormsView);
    expect(el.props.canBuild).toBe(false);
    expect(auth.getActor).not.toHaveBeenCalled();
    const out = html(el);
    expect(out).not.toContain("Make a form");
    expect(out).not.toContain('data-testid="forms-make"');
    expect(out).not.toContain('data-testid="forms-import"');
    expect(out).toContain("Lead forms");
  });

  it("passes canBuild to owners and admins while Promote is open, never to agents or a failed sign-in", async () => {
    process.env.PROMOTE_ENABLED = "on";
    auth.getActor.mockResolvedValue({ userId: "u1", tenantId: "t1", role: "owner" });
    expect(((await LeadFormsPage()) as ReactElement<{ canBuild: boolean }>).props.canBuild).toBe(true);
    auth.getActor.mockResolvedValue({ userId: "u1", tenantId: "t1", role: "agent" });
    expect(((await LeadFormsPage()) as ReactElement<{ canBuild: boolean }>).props.canBuild).toBe(false);
    auth.getActor.mockRejectedValue(new Error("Not signed in."));
    expect(((await LeadFormsPage()) as ReactElement<{ canBuild: boolean }>).props.canBuild).toBe(false);
  });

  it("shows 'Make a form' (to the builder) and 'Import from Meta' when the member can build", () => {
    const out = html(createElement(FormsView, { canBuild: true }));
    expect(out).toMatch(/<a href="\/app\/leads\/forms\/new"[^>]*data-testid="forms-make"[^>]*>Make a form<\/a>/);
    expect(out).toContain('data-testid="forms-import"');
    expect(out).toContain(">Import from Meta<");
    expect(out).toContain('aria-live="polite"');
  });
});

describe("the Forms page bundle", () => {
  it("doesn't load the Promote copy catalogue or the builder's helpers (every member loads this page)", () => {
    const source = readFileSync(path.resolve(__dirname, "..", "src/components/leads/FormsView.tsx"), "utf8");
    const imports = source.match(/^import[^;]+;/gm) ?? [];
    expect(imports.join("\n")).not.toMatch(/@\/lib\/promote|@\/components\/promote|spend\//);
  });

  it("its written-out strings match the catalogue's English and the builder's", () => {
    expect(FORM_BUILDER_PATH).toBe(BUILDER_PATH);
    expect(FORMS_VIEW_TEXT.makeForm).toBe(FORM_BUILDER_TEXT.makeForm);
    expect(FORMS_VIEW_TEXT.copy).toBe(FORM_BUILDER_TEXT.copyToEdit);
    expect(FORMS_VIEW_TEXT.madeInEdwyz).toBe(promoteText("boost.made_in_edwyz"));
    expect(FORMS_VIEW_TEXT.import).toBe(promoteText("form.import"));
    expect(FORMS_VIEW_TEXT.testLead).toBe(promoteText("form.test_lead"));
    expect(FORMS_VIEW_TEXT.testLeadNote).toBe(promoteText("form.test_lead_note"));
    expect(FORMS_VIEW_TEXT.testSent).toBe(promoteText("form.test_sent"));
    expect(FORMS_VIEW_TEXT.undo).toBe(promoteText("edit.undo"));
    expect(FORMS_VIEW_TEXT.cancel).toBe(promoteText("card.cancel"));
    expect(FORMS_VIEW_TEXT.consentOptional).toBe(promoteText("form.consent_optional"));
  });
});
