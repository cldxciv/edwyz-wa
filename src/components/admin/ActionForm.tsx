"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { Alert, apiFetch, Button, CopyButton, Dialog, FormField, Input, Select, cn, confirm, toast } from "@/components/ui";
import { actionMode, confirmationMatches } from "./helpers";

export type ActionField = {
  name: string;
  label: string;
  type?: "text" | "number" | "select";
  options?: { value: string; label: string }[];
  defaultValue?: string;
  hint?: string;
  /** The field may be sent empty (its hint says what empty means). Fields are required unless this is set. */
  optional?: boolean;
};

type Props = {
  endpoint: string;
  method?: "POST" | "PATCH";
  label: string;
  description?: string;
  /** Fixed body values, for example the action name. */
  body: Record<string, unknown>;
  fields?: ActionField[];
  /** When set, the admin must type this exact text before the action can run. */
  confirmText?: string;
  needsReason?: boolean;
  danger?: boolean;
};

/** The dialog's input fields: required unless marked optional, so "Leave empty to ..." fields can really be left empty. */
export function ActionFields({ fields }: { fields: readonly ActionField[] }) {
  return (
    <>
      {fields.map((f, i) => (
        <FormField key={f.name} label={f.label} hint={f.hint} required={!f.optional} optional={f.optional}>
          {f.type === "select" ? (
            <Select name={f.name} defaultValue={f.defaultValue} required={!f.optional} data-autofocus={i === 0 ? true : undefined}>
              {f.options?.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          ) : (
            <Input name={f.name} type={f.type ?? "text"} defaultValue={f.defaultValue} required={!f.optional} data-autofocus={i === 0 ? true : undefined} />
          )}
        </FormField>
      ))}
    </>
  );
}

/**
 * One admin action as a row with a button. Actions that need input open a dialog (fields, reason, typed confirmation);
 * actions that need nothing but a decision ask a yes or no question. Request and response shapes are unchanged.
 */
export function ActionForm({ endpoint, method = "POST", label, description, body, fields = [], confirmText, needsReason = true, danger }: Props) {
  const router = useRouter();
  const uid = useId();
  const formId = `${uid}-form`;
  const mode = actionMode({ fieldCount: fields.length, needsReason, confirmText });
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const canSubmit = confirmationMatches(typed, confirmText);

  async function send(payload: Record<string, unknown>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<{ link?: string }>(endpoint, { method, body: payload });
      toast.success(`${label}: done`);
      if (res.link) setLink(res.link);
      router.refresh();
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Something went wrong.";
      setError(message);
      if (mode === "confirm") toast.error(`${label} did not work. ${message}`);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    if (mode === "form") {
      setTyped("");
      setError(null);
      setOpen(true);
      return;
    }
    const ok = await confirm({
      title: `${label}?`,
      body: description ?? "Are you sure you want to do this?",
      confirmLabel: label,
      tone: danger ? "danger" : "default",
    });
    if (ok) await send({ ...body });
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canSubmit) return;
    const form = new FormData(e.currentTarget);
    const payload: Record<string, unknown> = { ...body };
    for (const f of fields) payload[f.name] = String(form.get(f.name) ?? "");
    if (needsReason) payload.reason = String(form.get("reason") ?? "");
    if (confirmText) payload.confirm = typed;
    if (await send(payload)) setOpen(false);
  }

  return (
    <div className={cn("flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-control border p-3", danger ? "border-bad-line" : "border-border")}>
      {description ? <p className="min-w-0 flex-1 basis-56 text-sm text-muted">{description}</p> : <span className="flex-1" />}
      <Button variant="secondary" size="md" className={danger ? "text-bad-fg" : undefined} loading={busy && mode === "confirm"} onClick={start}>
        {label}
      </Button>

      {open && (
        <Dialog
          title={label}
          description={description}
          size="md"
          role={danger ? "alertdialog" : "dialog"}
          dismissible={!busy}
          onClose={() => setOpen(false)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" form={formId} variant={danger ? "danger" : "primary"} loading={busy} disabled={!canSubmit}>
                {label}
              </Button>
            </>
          }
        >
          <form id={formId} onSubmit={submit} className="space-y-4">
            <ActionFields fields={fields} />
            {needsReason && (
              <FormField label="Reason" hint="Saved in the audit log so other admins can see why." required>
                <Input name="reason" maxLength={300} required autoComplete="off" data-autofocus={fields.length === 0 ? true : undefined} />
              </FormField>
            )}
            {confirmText && (
              <FormField label={`Type "${confirmText}" to confirm`} hint="This protects against clicking the wrong workspace, user or plan." required>
                <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" autoCapitalize="off" spellCheck={false} data-autofocus={fields.length === 0 && !needsReason ? true : undefined} />
              </FormField>
            )}
            {error && <Alert tone="bad">{error}</Alert>}
          </form>
        </Dialog>
      )}

      {link && (
        <Dialog
          title="Copy this link now"
          size="md"
          onClose={() => setLink(null)}
          footer={
            <>
              <CopyButton value={link} label="Copy link" size="md" variant="primary" />
              <Button variant="secondary" onClick={() => setLink(null)}>
                Close
              </Button>
            </>
          }
        >
          <Alert tone="warn" title="Shown only once">
            Share it only with the user. It expires in 1 hour.
          </Alert>
          <code className="mt-3 block break-all rounded-control bg-surface p-3 text-xs select-all">{link}</code>
        </Dialog>
      )}
    </div>
  );
}
