"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Alert, Button, Card, EmptyState, FormField, Input, Select, Textarea, apiFetch, buttonSizes, buttonVariants, cn, confirm, toast } from "@/components/ui";
import { PageHeader } from "@/components/app/PageHeader";
import { MAX_BUTTONS } from "@/lib/templates/validate";
import { canManage, useRole } from "@/components/contacts/hooks";
import { friendlyError } from "@/components/contacts/helpers";
import { Preview } from "./Preview";
import {
  type ButtonDraft,
  CATEGORY_INFO,
  HEADER_KINDS,
  type HeaderKind,
  type HeaderMediaDraft,
  LANGUAGES,
  MEDIA_ACCEPT,
  type TemplateDraft,
  buildComponents,
  buttonErrorTarget,
  countErrors,
  countText,
  detectVariables,
  emptyDraft,
  focusKeyAfterButtonRemoved,
  guardedNavigationPath,
  hasErrors,
  insertAt,
  nextVariable,
  requiredExamples,
  slugifyTemplateName,
  validateDraft,
} from "./helpers";

const linkButton = cn("inline-flex items-center justify-center gap-2 rounded-full font-semibold whitespace-nowrap transition-colors duration-(--dur-fast)", buttonVariants.primary, buttonSizes.md);
const blankButton = (): ButtonDraft => ({ type: "QUICK_REPLY", text: "", url: "", urlExample: "", phone: "" });

export function TemplateEditor() {
  const router = useRouter();
  const role = useRole();
  const [draft, setDraft] = useState<TemplateDraft>(emptyDraft);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState<null | "draft" | "submit">(null);
  const [showHeader, setShowHeader] = useState(false);
  const [showFooter, setShowFooter] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const errors = validateDraft(draft);
  const shown = touched ? errors : {};
  const set = <K extends keyof TemplateDraft>(key: K, value: TemplateDraft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const examplesNeeded = requiredExamples(draft.body);
  const dirty = JSON.stringify(draft) !== JSON.stringify(emptyDraft());
  const headerOpen = showHeader || draft.header !== "" || draft.headerKind !== "TEXT";
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  function changeHeaderKind(kind: HeaderKind) {
    setDraft((d) => ({ ...d, headerKind: kind, headerMedia: null, ...(kind === "TEXT" ? {} : { header: "", headerExample: "" }) }));
    if (fileRef.current) fileRef.current.value = "";
  }

  async function uploadSample(file: File | undefined) {
    if (!file || draft.headerKind === "TEXT") return;
    setUploading(true);
    try {
      const res = await fetch("/api/templates/media", {
        method: "POST",
        headers: { "content-type": file.type || "application/octet-stream", "x-file-name": encodeURIComponent(file.name) },
        body: file,
        credentials: "same-origin",
      });
      const json = (await res.json().catch(() => ({}))) as { media?: HeaderMediaDraft; error?: string };
      if (!res.ok || !json.media) throw new Error(json.error ?? "The upload did not work.");
      if (json.media.type !== draft.headerKind) throw new Error(`That file is not ${draft.headerKind === "IMAGE" ? "an image" : draft.headerKind === "VIDEO" ? "a video" : "a document"}. Choose a matching file.`);
      setDraft((d) => ({ ...d, headerMedia: json.media ?? null }));
      toast.success("Sample file uploaded");
    } catch (e) {
      toast.error("We could not upload the file", { description: friendlyError(e, "Check your connection and try again.") });
      if (fileRef.current) fileRef.current.value = "";
    } finally {
      setUploading(false);
    }
  }
  const footerOpen = showFooter || draft.footer !== "";

  useEffect(() => {
    if (!dirty || busy) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    // Sidebar, breadcrumb and Back links navigate on the client, which never fires beforeunload.
    const guardLinks = (e: MouseEvent) => {
      const anchor = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor) return;
      const path = guardedNavigationPath(
        {
          href: anchor.getAttribute("href") ?? "",
          target: anchor.target,
          download: anchor.hasAttribute("download"),
          button: e.button,
          modified: e.metaKey || e.ctrlKey || e.shiftKey || e.altKey,
          defaultPrevented: e.defaultPrevented,
        },
        window.location.origin,
        window.location.pathname,
      );
      if (!path) return;
      e.preventDefault();
      e.stopPropagation();
      void confirm({ title: "Leave without saving?", body: "This template has not been saved. What you have written will be lost.", confirmLabel: "Leave page", cancelLabel: "Keep editing", tone: "danger" }).then((ok) => {
        if (ok) router.push(path);
      });
    };
    window.addEventListener("beforeunload", warn);
    document.addEventListener("click", guardLinks, true);
    return () => {
      window.removeEventListener("beforeunload", warn);
      document.removeEventListener("click", guardLinks, true);
    };
  }, [dirty, busy, router]);

  // After the form adds or removes a part, focus moves to a named control so keyboard users keep their place.
  const pendingFocus = useRef<string | null>(null);
  useEffect(() => {
    const key = pendingFocus.current;
    if (!key) return;
    pendingFocus.current = null;
    document.querySelector<HTMLElement>(`[data-focus-key="${key}"]`)?.focus();
  });
  const focusAfter = (key: string) => {
    pendingFocus.current = key;
  };

  function setButton(i: number, patch: Partial<ButtonDraft>) {
    setDraft((d) => ({ ...d, buttons: d.buttons.map((b, idx) => (idx === i ? { ...b, ...patch } : b)) }));
  }

  function insertPlaceholder() {
    const node = bodyRef.current;
    const token = `{{${nextVariable(draft.body)}}}`;
    const result = insertAt(draft.body, node?.selectionStart ?? draft.body.length, token);
    set("body", result.text);
    requestAnimationFrame(() => {
      node?.focus();
      node?.setSelectionRange(result.caret, result.caret);
    });
  }

  async function cancel() {
    if (dirty && !(await confirm({ title: "Discard this template?", body: "What you have written so far will be lost.", confirmLabel: "Discard template", cancelLabel: "Keep editing", tone: "danger" }))) return;
    router.push("/app/templates");
  }

  async function save(submit: boolean) {
    setTouched(true);
    if (hasErrors(errors)) {
      requestAnimationFrame(() => document.querySelector<HTMLElement>('form [aria-invalid="true"]')?.focus());
      return;
    }
    setBusy(submit ? "submit" : "draft");
    let id: string;
    try {
      const { template } = await apiFetch<{ template: { id: string } }>("/api/templates", {
        method: "POST",
        body: {
          name: draft.name,
          language: draft.language,
          category: draft.category,
          components: buildComponents(draft),
          ...(draft.headerKind !== "TEXT" && draft.headerMedia ? { headerMedia: { mime: draft.headerMedia.mime, filename: draft.headerMedia.filename } } : {}),
        },
      });
      id = template.id;
    } catch (e) {
      toast.error("We could not save the template", { description: friendlyError(e, "Check your connection and try again.") });
      setBusy(null);
      return;
    }
    if (submit) {
      try {
        await apiFetch(`/api/templates/${id}/submit`, { method: "POST" });
        toast.success("Template sent to Meta for review", { description: "Review usually takes minutes to a day. The status updates on the Templates page." });
      } catch (e) {
        toast.error("Saved as a draft, but we could not send it for review", { description: `${friendlyError(e, "Check your connection.")} You can send it from the Templates page.` });
      }
    } else {
      toast.success("Draft saved", { description: "Send it for review from the Templates page when you are ready." });
    }
    router.push("/app/templates");
  }

  if (role && !canManage(role)) {
    return (
      <div>
        <PageHeader title="New template" breadcrumbs={[{ label: "Templates", href: "/app/templates" }, { label: "New template" }]} />
        <EmptyState
          title="Only owners and admins can create templates"
          body="Ask an owner or admin to create one. You can use it in broadcasts once Meta approves it."
          action={
            <Link href="/app/templates" className={linkButton}>
              Back to templates
            </Link>
          }
        />
      </div>
    );
  }

  const errorCount = countErrors(errors);

  return (
    <div>
      <PageHeader
        title="New template"
        breadcrumbs={[{ label: "Templates", href: "/app/templates" }, { label: "New template" }]}
        description="Write the message once, send it to Meta for approval, then reuse it in broadcasts. Review usually takes minutes to a day."
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <form
          className="min-w-0 space-y-5"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void save(false);
          }}
        >
          <Card title="Basics" className="space-y-4">
            <FormField label="Template name" required error={shown.name} hint="Only you see this. Spaces turn into underscores, for example order_update.">
              <Input value={draft.name} onChange={(e) => set("name", slugifyTemplateName(e.target.value))} autoComplete="off" spellCheck={false} />
            </FormField>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="Language" hint="The language your message is written in.">
                <Select value={draft.language} onChange={(e) => set("language", e.target.value)}>
                  {LANGUAGES.map(([code, label]) => (
                    <option key={code} value={code}>
                      {label}
                    </option>
                  ))}
                </Select>
              </FormField>
              <FormField label="Type of message" hint={`${CATEGORY_INFO[draft.category].help} Meta may change this if it disagrees.`}>
                <Select value={draft.category} onChange={(e) => set("category", e.target.value as TemplateDraft["category"])}>
                  {(Object.keys(CATEGORY_INFO) as TemplateDraft["category"][]).map((key) => (
                    <option key={key} value={key}>
                      {CATEGORY_INFO[key].label}
                    </option>
                  ))}
                </Select>
              </FormField>
            </div>
          </Card>

          <Card title="Message" className="space-y-4">
            {headerOpen ? (
              <div className="space-y-4 rounded-lg border border-border p-3">
                <FormField label="Header type" optional hint="Text is a bold line. An image, video or document shows above your message.">
                  <Select value={draft.headerKind} onChange={(e) => changeHeaderKind(e.target.value as HeaderKind)}>
                    {HEADER_KINDS.map(([kind, label]) => (
                      <option key={kind} value={kind}>
                        {label}
                      </option>
                    ))}
                  </Select>
                </FormField>
                {draft.headerKind === "TEXT" ? (
                  <>
                    <FormField label="Header" optional error={shown.header} hint={`Bold line at the top. ${countText(draft.header, 60)}.`}>
                      <Input data-focus-key="header-input" value={draft.header} onChange={(e) => set("header", e.target.value)} />
                    </FormField>
                    {detectVariables(draft.header).length > 0 && (
                      <FormField label="Sample value for the header placeholder" required error={shown.headerExample} hint="Meta uses this example during review. Customers never see it.">
                        <Input value={draft.headerExample} onChange={(e) => set("headerExample", e.target.value)} />
                      </FormField>
                    )}
                  </>
                ) : (
                  <FormField
                    label="Sample file for review"
                    required
                    error={shown.headerMedia}
                    hint={`${MEDIA_ACCEPT[draft.headerKind].help} Meta looks at it when it reviews your template. When you send a broadcast you choose the real file for each person.`}
                  >
                    <div className="space-y-2">
                      <input
                        ref={fileRef}
                        type="file"
                        accept={MEDIA_ACCEPT[draft.headerKind].accept}
                        data-focus-key="header-file"
                        className="block w-full text-sm file:mr-3 file:min-h-10 file:rounded-full file:border file:border-border-strong file:bg-raised file:px-4 file:text-sm file:font-semibold"
                        onChange={(e) => void uploadSample(e.target.files?.[0])}
                        disabled={uploading}
                      />
                      <p role="status" aria-live="polite" className="text-sm">
                        {uploading ? "Uploading to Meta..." : draft.headerMedia ? `Ready: ${draft.headerMedia.filename ?? "sample file"}` : "No file added yet."}
                      </p>
                    </div>
                  </FormField>
                )}
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="max-sm:min-h-10"
                  onClick={() => {
                    focusAfter("add-header");
                    setDraft((d) => ({ ...d, header: "", headerExample: "", headerKind: "TEXT", headerMedia: null }));
                    setShowHeader(false);
                  }}
                >
                  Remove header
                </Button>
              </div>
            ) : (
              <div>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  className="max-sm:min-h-10"
                  data-focus-key="add-header"
                  onClick={() => {
                    focusAfter("header-input");
                    setShowHeader(true);
                  }}
                >
                  Add a header
                </Button>
              </div>
            )}

            <FormField
              label="Message"
              required
              error={shown.body}
              hint={`${countText(draft.body, 1024)}. Use placeholders like {{1}} for details that change for each person, such as their name.`}
            >
              <Textarea ref={bodyRef} rows={6} value={draft.body} onChange={(e) => set("body", e.target.value)} />
            </FormField>
            <Button type="button" size="sm" variant="secondary" className="max-sm:min-h-10" onClick={insertPlaceholder}>
              {`Insert placeholder {{${nextVariable(draft.body)}}}`}
            </Button>

            {examplesNeeded > 0 && (
              <fieldset className="space-y-3 rounded-lg border border-border p-3">
                <legend className="px-1 text-sm font-medium">Sample values</legend>
                <p className="text-sm text-muted">Meta asks for an example of each placeholder so it can review your message. Customers never see these.</p>
                {Array.from({ length: examplesNeeded }, (_, i) => (
                  <FormField key={i} label={`Sample for {{${i + 1}}}`} required error={shown.bodyExamples?.[i]}>
                    <Input
                      value={draft.bodyExamples[i] ?? ""}
                      onChange={(e) => {
                        const next = [...draft.bodyExamples];
                        next[i] = e.target.value;
                        set("bodyExamples", next);
                      }}
                    />
                  </FormField>
                ))}
              </fieldset>
            )}

            {footerOpen ? (
              <div className="space-y-3 rounded-lg border border-border p-3">
                <FormField label="Footer" optional error={shown.footer} hint={`Small grey line at the bottom. ${countText(draft.footer, 60)}.`}>
                  <Input data-focus-key="footer-input" value={draft.footer} onChange={(e) => set("footer", e.target.value)} />
                </FormField>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="max-sm:min-h-10"
                  onClick={() => {
                    focusAfter("add-footer");
                    set("footer", "");
                    setShowFooter(false);
                  }}
                >
                  Remove footer
                </Button>
              </div>
            ) : (
              <div>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  className="max-sm:min-h-10"
                  data-focus-key="add-footer"
                  onClick={() => {
                    focusAfter("footer-input");
                    setShowFooter(true);
                  }}
                >
                  Add a footer
                </Button>
              </div>
            )}
          </Card>

          <details className="rounded-card border border-border bg-raised p-4 shadow-raised lg:hidden">
            <summary className="min-h-6 cursor-pointer text-sm font-semibold">Preview your message</summary>
            <div className="mt-3">
              <Preview draft={draft} />
            </div>
          </details>

          <Card
            title="Buttons"
            description={`Optional. Let customers reply or act with one tap. ${draft.buttons.length} of ${MAX_BUTTONS} added.`}
            actions={
              <Button type="button" size="sm" variant="secondary" className="max-sm:min-h-10" disabled={draft.buttons.length >= MAX_BUTTONS}
                data-focus-key="add-button"
                onClick={() => {
                  focusAfter(`button-label-${draft.buttons.length}`);
                  setDraft((d) => ({ ...d, buttons: [...d.buttons, blankButton()] }));
                }}
              >
                Add button
              </Button>
            }
            className="space-y-4"
          >
            {shown.buttons && <Alert tone="bad">{shown.buttons}</Alert>}
            {draft.buttons.length === 0 && <p className="text-sm text-muted">No buttons yet. Buttons are not required.</p>}
            {draft.buttons.map((b, i) => {
              const message = shown.buttonErrors?.[i];
              const target = message ? buttonErrorTarget(b) : null;
              return (
                <fieldset key={i} className="min-w-0 space-y-3 rounded-lg border border-border p-3">
                  <legend className="px-1 text-sm font-medium">Button {i + 1}</legend>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <FormField label="What it does">
                      <Select value={b.type} onChange={(e) => setButton(i, { type: e.target.value as ButtonDraft["type"] })}>
                        <option value="QUICK_REPLY">Sends a quick reply</option>
                        <option value="URL">Opens a website</option>
                        <option value="PHONE_NUMBER">Calls a phone number</option>
                      </Select>
                    </FormField>
                    <FormField label="Button label" required error={target === "text" ? message : null} hint={countText(b.text, 25)}>
                      <Input data-focus-key={`button-label-${i}`} value={b.text} onChange={(e) => setButton(i, { text: e.target.value })} />
                    </FormField>
                  </div>
                  {b.type === "URL" && (
                    <>
                      <FormField label="Website address" required error={target === "url" ? message : null} hint="Must start with https://. End it with {{1}} if part of the address changes for each person.">
                        <Input type="url" inputMode="url" value={b.url} onChange={(e) => setButton(i, { url: e.target.value })} placeholder="https://example.com/orders/{{1}}" />
                      </FormField>
                      {detectVariables(b.url).length > 0 && (
                        <FormField label="Sample address" required error={target === "urlExample" ? message : null} hint="A full example address for Meta's review.">
                          <Input value={b.urlExample} onChange={(e) => setButton(i, { urlExample: e.target.value })} />
                        </FormField>
                      )}
                    </>
                  )}
                  {b.type === "PHONE_NUMBER" && (
                    <FormField label="Phone number to call" required error={target === "phone" ? message : null} hint="With country code.">
                      <Input type="tel" inputMode="tel" value={b.phone} onChange={(e) => setButton(i, { phone: e.target.value })} placeholder="+919876543210" />
                    </FormField>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="max-sm:min-h-10"
                    data-focus-key={`remove-button-${i}`}
                    onClick={() => {
                      focusAfter(focusKeyAfterButtonRemoved(i, draft.buttons.length - 1));
                      setDraft((d) => ({ ...d, buttons: d.buttons.filter((_, idx) => idx !== i) }));
                    }}
                    aria-label={`Remove button ${i + 1}`}
                  >
                    Remove button
                  </Button>
                </fieldset>
              );
            })}
          </Card>

          {touched && errorCount > 0 && (
            <Alert tone="bad" title={`Fix ${errorCount} ${errorCount === 1 ? "thing" : "things"} before saving`}>
              The fields that need attention are marked above.
            </Alert>
          )}

          <div className="flex flex-wrap gap-2">
            <Button type="button" className="max-sm:min-h-11" loading={busy === "submit"} disabled={busy !== null} onClick={() => void save(true)}>
              Save and send for review
            </Button>
            <Button type="submit" variant="secondary" className="max-sm:min-h-11" loading={busy === "draft"} disabled={busy !== null}>
              Save as draft
            </Button>
            <Button type="button" variant="ghost" className="max-sm:min-h-11" disabled={busy !== null} onClick={() => void cancel()}>
              Cancel
            </Button>
          </div>
        </form>

        <aside className="hidden lg:sticky lg:top-6 lg:block lg:self-start">
          <h2 className="mb-2 text-sm font-semibold">Preview</h2>
          <Preview draft={draft} />
          <p className="mt-2 text-xs text-muted">Approximate. WhatsApp may show your message slightly differently.</p>
        </aside>
      </div>
    </div>
  );
}
