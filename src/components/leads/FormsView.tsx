"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Card, EmptyState, ErrorState, FormField, PageHeader, Skeleton, SkeletonText, StatusPill, Textarea, apiFetch, buttonSizes, buttonVariants, cn, confirm, toast } from "@/components/ui";
import { canManage, useRole } from "@/components/contacts/hooks";
import { LeadsNav } from "./LeadsNav";
import { friendlyError } from "./helpers";

type Form = { id: string; metaFormId: string; name: string | null; consentText: string | null; consentAssumed?: boolean; status: string };

function FormCard({ form, admin }: { form: Form; admin: boolean }) {
  const [saved, setSaved] = useState({ text: form.consentText ?? "", assumed: form.consentAssumed === true });
  const [text, setText] = useState(saved.text);
  const [assumed, setAssumed] = useState(saved.assumed);
  const [saving, setSaving] = useState(false);
  const dirty = text !== saved.text || assumed !== saved.assumed;
  const title = form.name ?? "Untitled form";
  const checkId = `assumed-${form.id}`;

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
    <Card title={title} headingLevel="h2" actions={<StatusPill status={form.status} />}>
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
      <details className="mt-4">
        <summary className="min-h-10 cursor-pointer text-xs font-medium text-muted">Details</summary>
        <p className="break-all text-xs text-muted">Meta form ID: {form.metaFormId}</p>
      </details>
    </Card>
  );
}

export function FormsView() {
  const admin = canManage(useRole());
  const [forms, setForms] = useState<Form[] | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    setError("");
    apiFetch<{ items: Form[] }>("/api/leads/forms")
      .then((r) => setForms(r.items))
      .catch((e: unknown) => setError(friendlyError(e)));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div>
      <PageHeader title="Lead forms" description="Each form appears here after its first lead arrives. Set the consent wording so you can prove who agreed to hear from you." />
      <LeadsNav current="/app/leads/forms" />
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
          body="Forms show up here by themselves after the first lead comes in. Connect your Facebook page, then send a test lead from your form to register it."
          action={
            <a className={cn("inline-flex items-center justify-center rounded-full font-semibold", buttonVariants.primary, buttonSizes.md)} href="/app/settings/connections">
              Connect your Facebook page
            </a>
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
              <FormCard key={f.id} form={f} admin={admin} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
