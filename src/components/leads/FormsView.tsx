"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Badge, Button, Card, Dialog, EmptyState, ErrorState, FormField, PageHeader, Select, Skeleton, SkeletonText, StatusPill, Textarea, apiFetch, buttonSizes, buttonVariants, cn, confirm, toast, type ToastApi } from "@/components/ui";
import { canManage, useRole } from "@/components/contacts/hooks";
import { LeadsNav } from "./LeadsNav";
import { connectedPageCount, friendlyError } from "./helpers";
import { useNow } from "./useNow";

type Form = {
  id: string;
  metaFormId: string;
  name: string | null;
  consentText: string | null;
  consentAssumed?: boolean;
  status: string;
  // Instagram and Facebook Page ads (0012): where the form came from, and the "Test sent" label.
  origin?: string | null;
  testLeadUntil?: string | null;
  pageAssetId?: string | null;
  hidden?: boolean;
};

// =====================================================================================================================
// Helpers (tests/leads-forms-ui.test.ts)
// =====================================================================================================================

/** The form builder's address (form-builder-helpers.BUILDER_PATH; a test keeps them equal). */
export const FORM_BUILDER_PATH = "/app/leads/forms/new";

/**
 * Copy for the Forms page actions (docs/IG-PAGE-ADS-SPEC.md 7.1, 6.5 send_test_lead, D13, D33). Pages are English (D23). The
 * strings shared with the Promote catalogue are written out here, not read from it: every member loads this page, and the
 * catalogue (three languages) would come with it. tests/leads-forms-ui.test.ts keeps them equal to the catalogue's English.
 */
export const FORMS_VIEW_TEXT = {
  madeInEdwyz: "Made in Edwyz",
  makeForm: "Make a form",
  import: "Import from Meta",
  testLead: "Send a test lead",
  testLeadNote: "It shows in Leads as Test. No WhatsApp message is sent.",
  testSent: "Test sent",
  testLeadTitle: (name: string) => `Send a test lead to '${name}'?`,
  testLeadSent: (name: string) => `Sent a test lead to '${name}'. It shows in Leads as Test.`,
  testLeadFailed: "The test lead wasn't sent",
  cancel: "Cancel",
  copy: "Make a copy to edit",
  copyLabel: (name: string) => `Make a copy of '${name}' to edit`,
  hide: "Hide",
  hideLabel: (name: string) => `Hide '${name}'`,
  hidden: (name: string) => `Hid '${name}' here. It stays on Meta. Find it under Hidden forms.`,
  restored: (name: string) => `'${name}' is back on the list.`,
  hideFailed: "We could not hide this form",
  undoFailed: "We could not bring this form back",
  undo: "Undo",
  hiddenForms: (n: number) => `Hidden forms (${n})`,
  hiddenFormsNote: "Hidden only here. These forms stay on Meta, and their leads still come in with the consent settings they had. Show one again to see or change them.",
  hiddenAssumed: "Counts every lead as agreed",
  showAgain: "Show again",
  showAgainLabel: (name: string) => `Show '${name}' again`,
  showFailed: "We could not show this form again",
  importHiddenHere: "Hidden here",
  consentOptional: "People can leave this unticked. They're still a lead, but they get no WhatsApp messages.",
  createdConsent: "WhatsApp box on the form",
  noConsentBox: "This form has no WhatsApp box, so its leads can't get WhatsApp messages.",
  importTitle: "Import a form from Meta",
  importIntro: "Forms already on your Facebook Page. Importing one brings its leads here; nothing changes on Meta.",
  importPage: "Facebook Page",
  importLoading: "Reading the Page's forms…",
  importNone: "Every form on this Page is already here.",
  importDryRun: "Test mode: Edwyz doesn't read Meta, so there is nothing to import.",
  importIncomplete: "Meta sent only part of the list. Import these, then open this again for the rest.",
  importButton: "Import",
  importButtonLabel: (name: string) => `Import '${name}'`,
  imported: (name: string) => `Imported '${name}'.`,
  importFailed: "We could not import this form",
  importNoPages: "Connect your Facebook Page first.",
  connectPage: "Connect your Facebook page",
  close: "Close",
  untitled: "Untitled form",
  leads: (n: number) => (n === 1 ? "1 lead" : `${n} leads`),
} as const;

/** The tags a form card shows: "Made in Edwyz" for a form built here (origin created). */
export function formTags(form: Pick<Form, "origin">): string[] {
  return form.origin === "created" ? [FORMS_VIEW_TEXT.madeInEdwyz] : [];
}

/** "Test sent" shows until testLeadUntil (D33: only a label; test leads are recognised by their id and answers). */
export function testSent(form: Pick<Form, "testLeadUntil">, now: number): boolean {
  const until = form.testLeadUntil ? Date.parse(form.testLeadUntil) : NaN;
  return Number.isFinite(until) && until > now;
}

/** The send_test_lead confirm (6.5): "Send a test lead to '{form}'?" and "It shows in Leads as Test. No WhatsApp message is sent." */
export function testLeadDialog(name: string | null | undefined): { title: string; body: string; confirmLabel: string } {
  return { title: FORMS_VIEW_TEXT.testLeadTitle(name?.trim() || FORMS_VIEW_TEXT.untitled), body: FORMS_VIEW_TEXT.testLeadNote, confirmLabel: FORMS_VIEW_TEXT.testLead };
}

/** "Make a copy to edit" goes to the builder with the form's questions; only forms whose questions are known (built or imported). */
export function copyEditHref(form: Pick<Form, "id" | "origin">): string | null {
  return form.origin === "created" || form.origin === "imported" ? `${FORM_BUILDER_PATH}?copy=${encodeURIComponent(form.id)}` : null;
}

/** A form on the Page as GET /api/leads/forms/meta lists it. */
export type MetaFormItem = { metaFormId: string; name: string | null; status?: string | null; leadsCount?: number | null; localId: string | null; origin?: string | null; hidden?: boolean };

/** What the import list offers for a form on the Page: Import (not here yet) or Show again (here, but hidden). */
export type ImportAction = "import" | "show_again";

/**
 * The import list: every form on the Page this workspace doesn't have yet (Import), and every one it has but hid (Show again,
 * so a hidden form can always come back). Forms already on the list are left out.
 */
export function importableForms<T extends Pick<MetaFormItem, "localId" | "hidden">>(items: readonly T[]): (T & { action: ImportAction })[] {
  return items.flatMap((f): (T & { action: ImportAction })[] => (!f.localId ? [{ ...f, action: "import" }] : f.hidden ? [{ ...f, action: "show_again" }] : []));
}

type ConnectionPages = { status: string; assets: { id?: string; type: string; status: string; name?: string | null }[] };

/** The connected Facebook Pages, once each, from GET /api/meta-connect/connections. */
export function pagesFromConnections(connections: readonly ConnectionPages[]): { id: string; name: string }[] {
  const out = new Map<string, string>();
  for (const c of connections) {
    if (c.status === "revoked") continue;
    for (const a of c.assets) if (a.type === "page" && a.status === "active" && a.id && !out.has(a.id)) out.set(a.id, a.name?.trim() || "Facebook Page");
  }
  return [...out].map(([id, name]) => ({ id, name }));
}

export type HideDeps = {
  post: (path: string, body: unknown) => Promise<unknown>;
  toast: Pick<ToastApi, "success" | "error">;
  onHidden?: () => void;
  onRestored?: () => void;
  announce?: (message: string) => void;
};

const hidePath = (id: string) => `/api/leads/forms/${encodeURIComponent(id)}/hide`;

/**
 * Shows a hidden form again: POST /hide { undo: true }. Used by the toast's Undo, the Hidden forms list and the import list, so
 * a hidden form can always come back, long after the toast is gone. Resolves false when it could not be shown.
 */
export async function showAgain(form: Pick<Form, "id" | "name">, deps: Pick<HideDeps, "post" | "toast" | "onRestored" | "announce">, failed: string = FORMS_VIEW_TEXT.showFailed): Promise<boolean> {
  const name = form.name?.trim() || FORMS_VIEW_TEXT.untitled;
  try {
    await deps.post(hidePath(form.id), { undo: true });
  } catch (e) {
    deps.toast.error(failed, { description: friendlyError(e) });
    deps.announce?.(`${failed}. ${friendlyError(e)}`);
    return false;
  }
  deps.onRestored?.();
  deps.announce?.(FORMS_VIEW_TEXT.restored(name));
  deps.toast.success(FORMS_VIEW_TEXT.restored(name));
  return true;
}

/**
 * Hide with Undo (D13: forms are hidden in Edwyz only, never archived on Meta). POSTs the hide route, then shows a toast whose
 * Undo POSTs it again with { undo: true }. The toast has no time limit (an action toast stays until it is closed, WCAG 2.2.1),
 * and the form stays under Hidden forms with Show again after that. Resolves false when the form could not be hidden.
 */
export async function hideWithUndo(form: Pick<Form, "id" | "name">, deps: HideDeps): Promise<boolean> {
  const name = form.name?.trim() || FORMS_VIEW_TEXT.untitled;
  try {
    await deps.post(hidePath(form.id), {});
  } catch (e) {
    deps.toast.error(FORMS_VIEW_TEXT.hideFailed, { description: friendlyError(e) });
    return false;
  }
  deps.onHidden?.();
  deps.announce?.(FORMS_VIEW_TEXT.hidden(name));
  deps.toast.success(FORMS_VIEW_TEXT.hidden(name), { action: { label: FORMS_VIEW_TEXT.undo, onAction: () => void showAgain(form, deps, FORMS_VIEW_TEXT.undoFailed) } });
  return true;
}

// =====================================================================================================================
// A form card
// =====================================================================================================================

const TOUCH = "min-h-11";
const linkButton = (variant: keyof typeof buttonVariants) => cn("inline-flex items-center justify-center rounded-full font-semibold", buttonVariants[variant], buttonSizes.md, TOUCH);

export type CardActions = { canBuild: boolean; now: number; testing: boolean; onTestLead: (form: Form) => void; onHide: (form: Form) => void };

/** One form: its consent wording (or, for a form made in Edwyz, its WhatsApp box's words), and the builder actions when allowed. */
export function FormCard({ form, admin, actions }: { form: Form; admin: boolean; actions: CardActions }) {
  const [saved, setSaved] = useState({ text: form.consentText ?? "", assumed: form.consentAssumed === true });
  const [text, setText] = useState(saved.text);
  const [assumed, setAssumed] = useState(saved.assumed);
  const [saving, setSaving] = useState(false);
  const dirty = text !== saved.text || assumed !== saved.assumed;
  const title = form.name ?? FORMS_VIEW_TEXT.untitled;
  const checkId = `assumed-${form.id}`;
  const created = form.origin === "created";
  const tags = formTags(form);
  const copyHref = copyEditHref(form);
  const sent = testSent(form, actions.now);

  async function save() {
    if (assumed && !saved.assumed) {
      const ok = await confirm({
        title: "Count every lead from this form as having agreed?",
        body: "Every lead is recorded as opted in with the wording you entered, even if they did not tick anything. You are responsible for being able to prove they saw it.",
        confirmLabel: "Yes, record consent",
      });
      if (!ok) return;
    }
    setSaving(true);
    try {
      await apiFetch(`/api/leads/forms/${form.id}`, { method: "PATCH", body: { consentText: text.trim() || null, consentAssumed: assumed } });
      setSaved({ text: text.trim(), assumed });
      setText(text.trim());
      toast.success(`Saved consent wording for ${title}`);
    } catch (e) {
      toast.error("We could not save this form", { description: friendlyError(e) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card
      title={title}
      headingLevel="h2"
      data-testid={`form-card-${form.id}`}
      actions={
        <>
          {tags.map((t) => (
            <span key={t} data-testid="form-made-in-edwyz">
              <Badge tone="info">{t}</Badge>
            </span>
          ))}
          <StatusPill status={form.status} />
        </>
      }
    >
      {created ? (
        // A form made in Edwyz: its WhatsApp box is optional and never ticked, and its words are the consent proof (D35).
        <div data-testid="form-created-consent">
          <p className="text-sm font-medium">{FORMS_VIEW_TEXT.createdConsent}</p>
          <p className="mt-1 text-sm">{form.consentText?.trim() || FORMS_VIEW_TEXT.noConsentBox}</p>
          <p className="mt-1 text-xs text-muted">{FORMS_VIEW_TEXT.consentOptional}</p>
        </div>
      ) : (
        <>
          <FormField
            label="Consent wording"
            hint="Copy the sentence from your Facebook form where people agree to get WhatsApp messages. We keep it as proof when a lead ticks or answers yes. Without that answer, a lead is not marked as opted in and cannot get marketing messages."
          >
            <Textarea rows={4} maxLength={1000} value={text} disabled={!admin} onChange={(e) => setText(e.target.value)} placeholder="Example: I agree to receive WhatsApp messages from Acme about my enquiry." />
          </FormField>
          <div className="mt-4 flex items-start gap-3">
            <input id={checkId} type="checkbox" className="mt-1 h-4 w-4 shrink-0 accent-accent" checked={assumed} disabled={!admin} onChange={(e) => setAssumed(e.target.checked)} aria-describedby={`${checkId}-hint`} />
            <label htmlFor={checkId} className="text-sm">
              <span className="font-medium">Count every lead from this form as having agreed</span>
              <span id={`${checkId}-hint`} className="mt-0.5 block text-xs text-muted">
                Use this only when the form has no consent question but shows the wording above to everyone. Off by default.
              </span>
            </label>
          </div>
          {admin && (
            <div className="mt-4">
              <Button onClick={() => void save()} loading={saving} disabled={!dirty}>
                Save consent wording
              </Button>
            </div>
          )}
        </>
      )}
      {actions.canBuild && (
        <div className="mt-4 flex flex-wrap items-center gap-2" data-testid={`form-actions-${form.id}`}>
          {sent && (
            <span data-testid="form-test-sent">
              <Badge tone="good" dot>
                {FORMS_VIEW_TEXT.testSent}
              </Badge>
            </span>
          )}
          <Button variant="secondary" className={TOUCH} loading={actions.testing} onClick={() => actions.onTestLead(form)} data-testid={`form-test-lead-${form.id}`}>
            {FORMS_VIEW_TEXT.testLead}
          </Button>
          {copyHref && (
            <Link href={copyHref} className={linkButton("secondary")} aria-label={FORMS_VIEW_TEXT.copyLabel(title)} data-testid={`form-copy-${form.id}`}>
              {FORMS_VIEW_TEXT.copy}
            </Link>
          )}
          <Button variant="ghost" className={TOUCH} aria-label={FORMS_VIEW_TEXT.hideLabel(title)} onClick={() => actions.onHide(form)} data-testid={`form-hide-${form.id}`}>
            {FORMS_VIEW_TEXT.hide}
          </Button>
        </div>
      )}
      <details className="mt-4">
        <summary className="min-h-10 cursor-pointer text-xs font-medium text-muted">Details</summary>
        <p className="break-all text-xs text-muted">Meta form ID: {form.metaFormId}</p>
      </details>
    </Card>
  );
}

// =====================================================================================================================
// Hidden forms: always reachable, so a hidden form can be shown again long after the Undo toast is gone
// =====================================================================================================================

/** A hidden form as the server page passes it (leads/service.listForms with includeHidden). */
export type HiddenForm = Pick<Form, "id" | "metaFormId" | "name" | "origin" | "consentAssumed">;

/**
 * "Hidden forms (n)": a closed disclosure under the list with each hidden form and Show again. A hidden form still takes in
 * leads with its consent settings, so the owner must always be able to bring it back and see them.
 */
export function HiddenForms({ forms, canShow, showing, onShow }: { forms: readonly HiddenForm[]; canShow: boolean; showing: string | null; onShow: (form: HiddenForm) => void }) {
  if (forms.length === 0) return null;
  return (
    <details className="mt-6 rounded-card border border-border bg-raised p-3" data-testid="forms-hidden">
      <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium">{FORMS_VIEW_TEXT.hiddenForms(forms.length)}</summary>
      <p className="mt-2 text-xs text-muted">{FORMS_VIEW_TEXT.hiddenFormsNote}</p>
      <ul className="mt-3 divide-y divide-border rounded-control border border-border" data-testid="forms-hidden-list">
        {forms.map((f) => {
          const name = f.name?.trim() || FORMS_VIEW_TEXT.untitled;
          return (
            <li key={f.id} className="flex flex-wrap items-center justify-between gap-2 p-3" data-testid={`forms-hidden-item-${f.id}`}>
              <div className="min-w-0">
                <p className="break-words text-sm font-medium">{name}</p>
                {f.consentAssumed ? (
                  <span className="mt-1 inline-block" data-testid="forms-hidden-assumed">
                    <Badge tone="warn">{FORMS_VIEW_TEXT.hiddenAssumed}</Badge>
                  </span>
                ) : null}
              </div>
              {canShow && (
                <Button
                  variant="secondary"
                  className={TOUCH}
                  loading={showing === f.id}
                  disabled={showing !== null && showing !== f.id}
                  aria-label={FORMS_VIEW_TEXT.showAgainLabel(name)}
                  onClick={() => onShow(f)}
                  data-testid={`forms-show-${f.id}`}
                >
                  {FORMS_VIEW_TEXT.showAgain}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </details>
  );
}

// =====================================================================================================================
// Import from Meta (GET /api/leads/forms/meta, POST /api/leads/forms)
// =====================================================================================================================

type MetaList = { meta: MetaFormItem[]; complete?: boolean; dryRun?: boolean };

function ImportDialog({
  pages,
  onClose,
  onImported,
  onShown,
  announce,
}: {
  pages: { id: string; name: string }[];
  onClose: () => void;
  onImported: () => void;
  onShown: (localId: string) => void;
  announce: (m: string) => void;
}) {
  const [pageId, setPageId] = useState(pages[0]?.id ?? "");
  const [list, setList] = useState<MetaList | null>(null);
  const [error, setError] = useState("");
  const [importing, setImporting] = useState<string | null>(null);
  const items = useMemo(() => importableForms(list?.meta ?? []), [list]);

  useEffect(() => {
    if (!pageId) return;
    let live = true;
    setList(null);
    setError("");
    apiFetch<MetaList>(`/api/leads/forms/meta?pageAssetId=${encodeURIComponent(pageId)}`)
      .then((r) => {
        if (live) setList({ meta: Array.isArray(r.meta) ? r.meta : [], complete: r.complete, dryRun: r.dryRun });
      })
      .catch((e: unknown) => {
        if (live) setError(friendlyError(e));
      });
    return () => {
      live = false;
    };
  }, [pageId]);

  async function importOne(item: MetaFormItem) {
    const name = item.name?.trim() || FORMS_VIEW_TEXT.untitled;
    setImporting(item.metaFormId);
    try {
      await apiFetch("/api/leads/forms", { method: "POST", body: { pageAssetId: pageId, metaFormId: item.metaFormId } });
      setList((l) => (l ? { ...l, meta: l.meta.map((m) => (m.metaFormId === item.metaFormId ? { ...m, localId: m.localId ?? "imported" } : m)) } : l));
      toast.success(FORMS_VIEW_TEXT.imported(name));
      announce(FORMS_VIEW_TEXT.imported(name));
      onImported();
    } catch (e) {
      toast.error(FORMS_VIEW_TEXT.importFailed, { description: friendlyError(e) });
    } finally {
      setImporting(null);
    }
  }

  /** A form this workspace has but hid: Show again instead of Import (POST /hide { undo: true }). */
  async function showOne(item: MetaFormItem) {
    const localId = item.localId;
    if (!localId) return;
    setImporting(item.metaFormId);
    const ok = await showAgain(
      { id: localId, name: item.name },
      { post: (path, body) => apiFetch(path, { method: "POST", body }), toast, announce },
    );
    if (ok) {
      setList((l) => (l ? { ...l, meta: l.meta.map((m) => (m.metaFormId === item.metaFormId ? { ...m, hidden: false } : m)) } : l));
      onShown(localId);
    }
    setImporting(null);
  }

  return (
    <Dialog
      title={FORMS_VIEW_TEXT.importTitle}
      description={FORMS_VIEW_TEXT.importIntro}
      onClose={onClose}
      footer={
        <Button variant="secondary" className={TOUCH} onClick={onClose} data-testid="forms-import-close">
          {FORMS_VIEW_TEXT.close}
        </Button>
      }
    >
      <div className="space-y-4" data-testid="forms-import-dialog">
        {pages.length === 0 ? (
          <div className="space-y-3 text-sm">
            <p>{FORMS_VIEW_TEXT.importNoPages}</p>
            <Link href="/app/settings/connections" className={linkButton("primary")} data-testid="forms-import-connect">
              {FORMS_VIEW_TEXT.connectPage}
            </Link>
          </div>
        ) : (
          <>
            {pages.length > 1 && (
              <FormField label={FORMS_VIEW_TEXT.importPage}>
                <Select value={pageId} className={TOUCH} onChange={(e) => setPageId(e.target.value)} data-testid="forms-import-page">
                  {pages.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </FormField>
            )}
            {error ? (
              <Alert tone="bad">{error}</Alert>
            ) : !list ? (
              <div aria-busy="true" className="space-y-2">
                <Skeleton className="h-11 w-full" />
                <Skeleton className="h-11 w-full" />
                <span role="status" className="sr-only">
                  {FORMS_VIEW_TEXT.importLoading}
                </span>
              </div>
            ) : list.dryRun ? (
              <Alert tone="info">{FORMS_VIEW_TEXT.importDryRun}</Alert>
            ) : items.length === 0 ? (
              <p className="text-sm text-muted" role="status">
                {FORMS_VIEW_TEXT.importNone}
              </p>
            ) : (
              <>
                <ul className="divide-y divide-border rounded-control border border-border" data-testid="forms-import-list">
                  {items.map((item) => {
                    const name = item.name?.trim() || FORMS_VIEW_TEXT.untitled;
                    const show = item.action === "show_again";
                    return (
                      <li key={item.metaFormId} className="flex flex-wrap items-center justify-between gap-2 p-3" data-testid={`forms-import-item-${item.metaFormId}`}>
                        <div className="min-w-0">
                          <p className="break-words text-sm font-medium">{name}</p>
                          <p className="text-xs text-muted">
                            {[show ? FORMS_VIEW_TEXT.importHiddenHere : null, item.status ? item.status.toLowerCase() : null, typeof item.leadsCount === "number" ? FORMS_VIEW_TEXT.leads(item.leadsCount) : null]
                              .filter(Boolean)
                              .join(" · ")}
                          </p>
                        </div>
                        <Button
                          variant="secondary"
                          className={TOUCH}
                          loading={importing === item.metaFormId}
                          disabled={importing !== null && importing !== item.metaFormId}
                          aria-label={show ? FORMS_VIEW_TEXT.showAgainLabel(name) : FORMS_VIEW_TEXT.importButtonLabel(name)}
                          onClick={() => void (show ? showOne(item) : importOne(item))}
                          data-testid={show ? `forms-import-show-${item.metaFormId}` : `forms-import-${item.metaFormId}`}
                        >
                          {show ? FORMS_VIEW_TEXT.showAgain : FORMS_VIEW_TEXT.importButton}
                        </Button>
                      </li>
                    );
                  })}
                </ul>
                {list.complete === false && <p className="text-xs text-muted">{FORMS_VIEW_TEXT.importIncomplete}</p>}
              </>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}

// =====================================================================================================================
// The page
// =====================================================================================================================

/** What the "Find my forms" button says it did, in plain words. */
export function findFormsMessage(found: number, problems: string[]): { tone: "good" | "warn"; text: string } {
  const what = found === 0 ? "No lead forms were found on your Facebook Pages." : found === 1 ? "Found 1 lead form on your Facebook Pages." : `Found ${found} lead forms on your Facebook Pages.`;
  if (problems.length) return { tone: "warn", text: `${what} Some Pages could not be read: ${problems.join(" ")}` };
  return { tone: found === 0 ? "warn" : "good", text: what };
}

/**
 * The Forms page. `canBuild` comes from the server page: Instagram and Facebook Page ads are open to this member and they are an
 * owner or admin (form-builder-helpers.canBuildForms). It adds Make a form, Import from Meta, and per form Send a test lead,
 * Make a copy to edit and Hide with Undo, and "Hidden forms (n)" with Show again (`hiddenForms`, also from the server page).
 * Without it the page is what it was: consent wording and Find forms.
 */
export function FormsView({ canBuild = false, hiddenForms = [] }: { canBuild?: boolean; hiddenForms?: HiddenForm[] }) {
  const admin = canManage(useRole());
  const now = useNow(30_000);
  const [forms, setForms] = useState<Form[] | null>(null);
  const [hidden, setHidden] = useState<HiddenForm[]>(hiddenForms);
  const [showing, setShowing] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [finding, setFinding] = useState(false);
  const [found, setFound] = useState<{ tone: "good" | "warn"; text: string } | null>(null);
  const [connections, setConnections] = useState<ConnectionPages[] | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [testFor, setTestFor] = useState<Form | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const pages = connections ? connectedPageCount(connections) : null;
  const pageOptions = useMemo(() => pagesFromConnections(connections ?? []), [connections]);

  const load = useCallback(() => {
    setError("");
    apiFetch<{ items: Form[] }>("/api/leads/forms")
      .then((r) => setForms(r.items))
      .catch((e: unknown) => setError(friendlyError(e)));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    apiFetch<{ connections: ConnectionPages[] }>("/api/meta-connect/connections")
      .then((r) => setConnections(r.connections))
      .catch(() => setConnections(null));
  }, []);

  /** Reads the lead forms of every connected Page from Meta. Each one is added here, so its consent wording applies from the first lead. */
  async function findForms() {
    setFinding(true);
    setFound(null);
    try {
      const r = await apiFetch<{ items: unknown[]; problems: string[] }>("/api/ads/pickers?kind=lead_forms");
      setFound(findFormsMessage(r.items.length, r.problems ?? []));
      load();
    } catch (e) {
      setFound({ tone: "warn", text: friendlyError(e) });
    } finally {
      setFinding(false);
    }
  }

  async function sendTest(form: Form) {
    const name = form.name?.trim() || FORMS_VIEW_TEXT.untitled;
    setTestFor(null);
    setTesting(form.id);
    try {
      const r = await apiFetch<{ testLeadUntil?: string | null }>(`/api/leads/forms/${encodeURIComponent(form.id)}/test-lead`, { method: "POST" });
      const until = typeof r.testLeadUntil === "string" ? r.testLeadUntil : new Date(Date.now() + 10 * 60_000).toISOString();
      setForms((fs) => fs?.map((f) => (f.id === form.id ? { ...f, testLeadUntil: until } : f)) ?? fs);
      toast.success(FORMS_VIEW_TEXT.testLeadSent(name));
      setStatus(FORMS_VIEW_TEXT.testLeadSent(name));
    } catch (e) {
      toast.error(FORMS_VIEW_TEXT.testLeadFailed, { description: friendlyError(e) });
      setStatus(`${FORMS_VIEW_TEXT.testLeadFailed}. ${friendlyError(e)}`);
    } finally {
      setTesting(null);
    }
  }

  const post = (path: string, body: unknown) => apiFetch(path, { method: "POST", body });
  const unhidden = (id: string) => {
    setHidden((h) => h.filter((f) => f.id !== id));
    load();
  };

  function hide(form: Form) {
    void hideWithUndo(form, {
      post,
      toast,
      onHidden: () => {
        setForms((fs) => fs?.filter((f) => f.id !== form.id) ?? fs);
        setHidden((h) => [{ id: form.id, metaFormId: form.metaFormId, name: form.name, origin: form.origin, consentAssumed: form.consentAssumed }, ...h.filter((f) => f.id !== form.id)]);
      },
      onRestored: () => unhidden(form.id),
      announce: setStatus,
    });
  }

  async function show(form: HiddenForm) {
    setShowing(form.id);
    await showAgain(form, { post, toast, onRestored: () => unhidden(form.id), announce: setStatus });
    setShowing(null);
  }

  const findButton = admin ? (
    <Button variant="secondary" onClick={() => void findForms()} loading={finding}>
      Find forms on my Facebook Pages
    </Button>
  ) : null;
  const makeLink = canBuild ? (
    <Link href={FORM_BUILDER_PATH} className={linkButton("primary")} data-testid="forms-make">
      {FORMS_VIEW_TEXT.makeForm}
    </Link>
  ) : null;
  const importButton = canBuild ? (
    <Button variant="secondary" className={TOUCH} onClick={() => setImportOpen(true)} data-testid="forms-import">
      {FORMS_VIEW_TEXT.import}
    </Button>
  ) : null;
  const headerActions =
    makeLink || importButton || findButton ? (
      <>
        {makeLink}
        {importButton}
        {findButton}
      </>
    ) : null;
  const cardActions = (form: Form): CardActions => ({ canBuild, now, testing: testing === form.id, onTestLead: setTestFor, onHide: hide });
  const testCopy = testFor ? testLeadDialog(testFor.name) : null;

  return (
    <div>
      <PageHeader title="Lead forms" description="Your Facebook lead forms. Find them on your Pages, or they appear by themselves with their first lead. Set the consent wording so you can prove who agreed to hear from you." actions={headerActions} />
      <LeadsNav current="/app/leads/forms" />
      <p role="status" aria-live="polite" className="sr-only" data-testid="forms-status">
        {status}
      </p>
      {found && (
        <Alert className="mb-4" tone={found.tone} title={found.tone === "good" ? "Forms updated" : "Check your forms"}>
          <span role="status">{found.text}</span>
        </Alert>
      )}
      {error ? (
        <ErrorState
          title="We could not load your forms"
          message={error}
          action={
            <Button variant="secondary" onClick={load}>
              Try again
            </Button>
          }
        />
      ) : !forms ? (
        <div aria-busy="true" role="status" className="grid gap-4 md:grid-cols-2">
          {[0, 1].map((i) => (
            <Card key={i}>
              <Skeleton className="mb-4 h-5 w-40" />
              <SkeletonText lines={4} />
            </Card>
          ))}
          <span className="sr-only">Loading forms</span>
        </div>
      ) : forms.length === 0 ? (
        <EmptyState
          title="No lead forms yet"
          body={
            admin
              ? pages
                ? "Your Facebook Pages are connected. Find the lead forms on them, or wait for the first lead to come in."
                : "Find the lead forms on your connected Facebook Pages, or wait for the first lead to come in. If your Page is not connected yet, connect it first."
              : "Forms show up here when an owner or admin finds them on your Facebook Pages, or when the first lead comes in."
          }
          action={
            admin || canBuild ? (
              <div className="flex flex-wrap justify-center gap-2">
                {makeLink}
                {importButton}
                {findButton}
                {admin && !pages && (
                  <a className={cn("inline-flex items-center justify-center rounded-full font-semibold", buttonVariants.secondary, buttonSizes.md)} href="/app/settings/connections">
                    Connect your Facebook page
                  </a>
                )}
              </div>
            ) : undefined
          }
        />
      ) : (
        <>
          {!admin && (
            <Alert className="mb-4" tone="info">
              You can see the consent wording, but only owners and admins can change it.
            </Alert>
          )}
          <div className="grid gap-4 md:grid-cols-2">
            {forms.map((f) => (
              <FormCard key={f.id} form={f} admin={admin} actions={cardActions(f)} />
            ))}
          </div>
        </>
      )}

      <HiddenForms forms={hidden} canShow={canBuild} showing={showing} onShow={(f) => void show(f)} />

      {importOpen && <ImportDialog pages={pageOptions} onClose={() => setImportOpen(false)} onImported={load} onShown={unhidden} announce={setStatus} />}

      {testFor && testCopy && (
        <Dialog
          title={testCopy.title}
          size="sm"
          onClose={() => setTestFor(null)}
          footer={
            <>
              <Button variant="secondary" className={TOUCH} onClick={() => setTestFor(null)} data-testid="form-test-lead-cancel">
                {FORMS_VIEW_TEXT.cancel}
              </Button>
              <Button className={TOUCH} data-autofocus="" onClick={() => void sendTest(testFor)} data-testid="form-test-lead-confirm">
                {testCopy.confirmLabel}
              </Button>
            </>
          }
        >
          <p className="text-sm text-muted" data-testid="form-test-lead-dialog">
            {testCopy.body}
          </p>
        </Dialog>
      )}
    </div>
  );
}
