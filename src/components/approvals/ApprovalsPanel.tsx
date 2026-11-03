"use client";

import { useState } from "react";
import { Alert, Button, Card, CopyButton, Dialog, FormField, Input, Select, Skeleton, StatusPill, apiFetch, confirm, toast } from "@/components/ui";
import { useApi } from "@/components/contacts/hooks";
import { TEMPLATE_MISSING, approvalDates, approvalStatusView, approvalsPath, isOpenApproval, resendBody, resendProblem, type ApprovalRow, type ApprovalSubjectType, type ResendForm } from "./panel-helpers";

type Template = { id: string; name: string; language?: string };

/** The list of approval links sent for one item, newest first, with Send on WhatsApp and Withdraw for open ones. */
export function ApprovalList({ approvals, busy, onSend, onRevoke }: { approvals: ApprovalRow[]; busy: string | null; onSend: (a: ApprovalRow) => void; onRevoke: (a: ApprovalRow) => void }) {
  if (approvals.length === 0) return <p className="text-sm text-muted">Nothing sent for approval yet.</p>;
  return (
    <ul className="divide-y divide-border text-sm">
      {approvals.map((a) => {
        const view = approvalStatusView(a.status);
        return (
          <li key={a.id} className="space-y-2 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <StatusPill status={a.status} label={view.label} tone={view.tone} />
              <span className="text-xs text-muted">{approvalDates(a)}</span>
            </div>
            {a.comment && (
              <p className="break-words rounded-control border border-border bg-surface p-2">
                <span className="font-medium">Your client wrote: </span>
                {a.comment}
              </p>
            )}
            {isOpenApproval(a.status) && (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => onSend(a)}>
                  Send on WhatsApp
                </Button>
                <Button size="sm" variant="ghost" className="text-bad-fg" loading={busy === a.id} disabled={busy !== null} onClick={() => onRevoke(a)}>
                  Withdraw link
                </Button>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Sends a fresh link to the client's WhatsApp. The earlier link stops working, because a link can only be shown once. */
function WhatsAppDialog({ approval, onClose, onSent }: { approval: ApprovalRow; onClose: () => void; onSent: () => void }) {
  const [form, setForm] = useState<ResendForm>({ phone: "", mode: "text", templateId: "" });
  const [touched, setTouched] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const templates = useApi<{ templates: Template[] }>(form.mode === "template" ? "/api/templates?status=approved" : null);
  const problem = resendProblem(form);

  async function send() {
    setTouched(true);
    if (problem) return;
    setSending(true);
    setError("");
    try {
      await apiFetch(`/api/approvals/${encodeURIComponent(approval.id)}/resend`, { method: "POST", body: resendBody(form) });
      toast.success("Sent on WhatsApp. Any link you copied before no longer works.");
      onSent();
    } catch (e) {
      setError((e as Error).message || "We could not send it. Try again.");
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog
      title="Send the approval link on WhatsApp"
      description="Your client gets a new link. Any link you copied before stops working."
      onClose={onClose}
      dismissible={!sending}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={sending}>
            Cancel
          </Button>
          <Button onClick={() => void send()} loading={sending}>
            Send on WhatsApp
          </Button>
        </>
      }
    >
      <form
        noValidate
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <FormField label="Client's WhatsApp number" required hint="With the country code. They must be one of your contacts." error={touched && problem && problem !== TEMPLATE_MISSING ? problem : null}>
          <Input type="tel" inputMode="tel" autoComplete="off" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} data-autofocus="" />
        </FormField>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">How to send it</legend>
          <label className="flex min-h-10 cursor-pointer items-start gap-2.5 text-sm">
            <input type="radio" name="resend-mode" className="mt-0.5 size-4 accent-accent" checked={form.mode === "text"} onChange={() => setForm({ ...form, mode: "text" })} />
            <span>A message. Works only if your client wrote to you in the last 24 hours.</span>
          </label>
          <label className="flex min-h-10 cursor-pointer items-start gap-2.5 text-sm">
            <input type="radio" name="resend-mode" className="mt-0.5 size-4 accent-accent" checked={form.mode === "template"} onChange={() => setForm({ ...form, mode: "template" })} />
            <span>An approved template, for any client who agreed to get your messages. The link goes in its one blank.</span>
          </label>
        </fieldset>
        {form.mode === "template" && (
          <FormField label="Template" required error={touched && problem === TEMPLATE_MISSING ? problem : null} hint={templates.data && templates.data.templates.length === 0 ? "You have no approved templates yet." : undefined}>
            <Select value={form.templateId} onChange={(e) => setForm({ ...form, templateId: e.target.value })} disabled={!templates.data}>
              <option value="">{templates.data ? "Choose a template" : "Loading templates"}</option>
              {(templates.data?.templates ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {t.language ? ` (${t.language})` : ""}
                </option>
              ))}
            </Select>
          </FormField>
        )}
        {error && (
          <Alert tone="bad" title="We could not send it">
            {error}
          </Alert>
        )}
      </form>
    </Dialog>
  );
}

export type ApprovalsPanelProps = {
  subjectType: ApprovalSubjectType;
  subjectId: string;
  /** Show "Send for client approval". Off once the item can no longer change (a running campaign, a decided suggestion). */
  canSend?: boolean;
  title?: string;
  description?: string;
  headingLevel?: "h2" | "h3" | "h4";
  /** Called after a link is created or withdrawn, so the page can refresh what depends on it. */
  onChange?: () => void;
};

/**
 * Client approval for one item: create a link (shown once, to copy), send it on WhatsApp, withdraw it, and see what the
 * client answered. Uses /api/approvals (list and create), /api/approvals/[id]/resend and /api/approvals/[id]/revoke.
 */
export function ApprovalsPanel({ subjectType, subjectId, canSend = true, title = "Client approval", description = "Send your client a link to approve this. They do not need to log in.", headingLevel = "h2", onChange }: ApprovalsPanelProps) {
  const list = useApi<{ approvals: ApprovalRow[] }>(approvalsPath(subjectType, subjectId));
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [sending, setSending] = useState<ApprovalRow | null>(null);
  const approvals = list.data?.approvals ?? [];
  const open = approvals.some((a) => isOpenApproval(a.status));

  async function create() {
    setBusy("create");
    try {
      const res = await apiFetch<{ id: string; url: string }>("/api/approvals", { method: "POST", body: { subjectType, subjectId } });
      setLink(res.url);
      toast.success("Approval link created. Copy it now: it is shown only once.");
      list.reload();
      onChange?.();
    } catch (e) {
      toast.error("We could not create the approval link", { description: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function revoke(a: ApprovalRow) {
    const ok = await confirm({ title: "Withdraw this approval link?", body: "Your client can no longer open it. You can send a new one later.", confirmLabel: "Withdraw link", tone: "danger" });
    if (!ok) return;
    setBusy(a.id);
    try {
      await apiFetch(`/api/approvals/${encodeURIComponent(a.id)}/revoke`, { method: "POST" });
      toast.success("Link withdrawn");
      setLink(null);
      list.reload();
      onChange?.();
    } catch (e) {
      toast.error("We could not withdraw the link", { description: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card title={title} description={description} headingLevel={headingLevel}>
      <div className="space-y-4">
        {link && (
          <Alert tone="good" title="Approval link ready">
            <p>Copy it and send it to your client. For your safety it is shown only once; you can always send a new one on WhatsApp below.</p>
            <p className="mt-2 break-all rounded-control bg-surface p-2 font-mono text-xs">{link}</p>
            <div className="mt-2">
              <CopyButton value={link} label="Copy link" />
            </div>
          </Alert>
        )}
        {list.error && !list.data ? (
          <Alert tone="bad" action={<Button size="sm" variant="secondary" onClick={list.retry}>Try again</Button>}>
            We could not load the approvals sent for this.
          </Alert>
        ) : !list.data ? (
          <div aria-busy="true">
            <span className="sr-only" role="status">Loading approvals</span>
            <Skeleton className="h-12 w-full" />
          </div>
        ) : (
          <ApprovalList approvals={approvals} busy={busy} onSend={setSending} onRevoke={(a) => void revoke(a)} />
        )}
        {canSend && (
          <div className="flex flex-wrap items-center gap-3">
            <Button variant={open ? "secondary" : "primary"} loading={busy === "create"} disabled={busy !== null} onClick={() => void create()}>
              {open ? "Send a new approval link" : "Send for client approval"}
            </Button>
            {open && <span className="text-xs text-muted">A link is already waiting for your client.</span>}
          </div>
        )}
      </div>
      {sending && (
        <WhatsAppDialog
          approval={sending}
          onClose={() => setSending(null)}
          onSent={() => {
            setSending(null);
            setLink(null);
            list.reload();
          }}
        />
      )}
    </Card>
  );
}
