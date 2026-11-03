"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import type { CeilingCell, SpendSettingsView } from "@/lib/admin/spending";
import { Alert, apiFetch, Badge, Button, Card, Dialog, FormField, Input, Select, toast } from "@/components/ui";
import { POT_NAMES, validateMoneyText, when } from "./helpers";

type Field = {
  name: string;
  label: string;
  type?: "text" | "select";
  options?: { value: string; label: string }[];
  defaultValue?: string;
  hint?: string;
  inputMode?: "decimal" | "numeric" | "text";
  required?: boolean;
  validate?: (value: string) => string | null;
};

/** One change to the spending settings: a button that opens a dialog with the fields and a reason, then PUTs the section. */
export function SettingsDialogButton({
  label,
  title,
  description,
  section,
  fixed = {},
  fields,
  variant = "secondary",
}: {
  label: string;
  title: string;
  description?: string;
  section: string;
  fixed?: Record<string, unknown>;
  fields: Field[];
  variant?: "secondary" | "primary" | "danger" | "ghost";
}) {
  const router = useRouter();
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const body: Record<string, unknown> = { section, ...fixed };
    const found: Record<string, string> = {};
    for (const f of fields) {
      const v = String(form.get(f.name) ?? "");
      const problem = f.validate?.(v) ?? null;
      if (problem) found[f.name] = problem;
      body[f.name] = v;
    }
    body.reason = String(form.get("reason") ?? "");
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<{ text: string }>("/api/admin/spending/settings", { method: "PUT", body });
      toast.success(res.text);
      setOpen(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        variant={variant}
        size="md"
        onClick={() => {
          setError(null);
          setErrors({});
          setOpen(true);
        }}
      >
        {label}
      </Button>
      {open && (
        <Dialog
          title={title}
          description={description}
          size="md"
          dismissible={!busy}
          onClose={() => setOpen(false)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" form={`${uid}-form`} loading={busy}>
                Save
              </Button>
            </>
          }
        >
          <form id={`${uid}-form`} onSubmit={submit} noValidate className="space-y-4">
            {fields.map((f, i) => (
              <FormField key={f.name} label={f.label} hint={f.hint} error={errors[f.name]} required={f.required} optional={!f.required && f.type !== "select"}>
                {f.type === "select" ? (
                  <Select name={f.name} defaultValue={f.defaultValue} data-autofocus={i === 0 ? true : undefined}>
                    {f.options?.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Input name={f.name} defaultValue={f.defaultValue} inputMode={f.inputMode} autoComplete="off" data-autofocus={i === 0 ? true : undefined} />
                )}
              </FormField>
            ))}
            <FormField label="Reason" hint="Saved in the audit log so other admins can see why." required>
              <Input name="reason" maxLength={300} required autoComplete="off" />
            </FormField>
            {error && <Alert tone="bad">{error}</Alert>}
          </form>
        </Dialog>
      )}
    </>
  );
}

const amountHint = (cell: CeilingCell) => (cell.currency === "CRD" ? "In credits, for example 500. Leave empty for Not set." : `In ${cell.currency}, for example 2000. Leave empty for Not set.`);

/** "Limits for new workspaces" or "Platform ceilings": one line per pot and currency, missing rows read "Not set". */
function CeilingTable({ cells, scope, title, description }: { cells: CeilingCell[]; scope: "probation" | "platform"; title: string; description: string }) {
  return (
    <Card title={title} description={description}>
      <ul className="divide-y divide-border">
        {cells.map((c) => {
          const name = `${POT_NAMES[c.pot] ?? c.pot}${c.currency === "CRD" ? "" : `, ${c.currency}`}`;
          return (
            <li key={`${c.pot}:${c.currency}`} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
              <div className="min-w-0 flex-1 basis-56 text-sm">
                <p className="font-medium">{name}</p>
                <p className="tabular-nums">
                  {c.dailyText} a day, {c.monthlyText}{" "}a month
                </p>
                {c.note && <p className="text-xs text-muted">{c.note}</p>}
                {c.updatedAt && <p className="text-xs text-muted">Changed {when(c.updatedAt)}{c.reason ? `. Why: ${c.reason}` : ""}</p>}
              </div>
              <SettingsDialogButton
                label="Change"
                title={`${title}: ${name}`}
                description="Amounts are what Meta or WhatsApp may cost at most (the worst case). Leave both empty to set this row to Not set."
                section="ceiling"
                fixed={{ scope, pot: c.pot, currency: c.currency }}
                fields={[
                  { name: "daily", label: "Most per day", hint: amountHint(c), inputMode: "decimal", defaultValue: c.daily ? majorOf(c.daily) : "", validate: (v) => validateMoneyText(v, { wholeOnly: c.currency === "CRD" }) },
                  { name: "monthly", label: "Most per month", hint: amountHint(c), inputMode: "decimal", defaultValue: c.monthly ? majorOf(c.monthly) : "", validate: (v) => validateMoneyText(v, { wholeOnly: c.currency === "CRD" }) },
                ]}
              />
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

/** "₹2,000" back to the text a person types ("2000"), from the formatted value. */
function majorOf(m: { formatted: string; currency: string }): string {
  return m.formatted.replace(/[^\d.]/g, "");
}

/** /admin/spending/settings. */
export function CeilingsForm({ view }: { view: SpendSettingsView }) {
  const fx = view.fx;
  const n = view.notifier;
  const d = view.defaults;
  const candidates = n.candidates;
  return (
    <div className="space-y-6">
      <CeilingTable
        cells={view.newWorkspace}
        scope="probation"
        title="Limits for new workspaces"
        description="They apply until a workspace has 2 paid invoices or you mark it verified. INR rows are set by default; other currencies read Not set until you add a row or an exchange rate."
      />
      <CeilingTable cells={view.platform} scope="platform" title="Platform ceilings" description="The most any workspace may spend, whatever its plan. Empty means no platform ceiling." />

      <Card title="Exchange rates for limits" description={`INR for one unit of each currency. A rate older than ${fx.maxAgeDays} days is out of date and is not used: limits in that currency then need their own row.`}>
        {fx.rates.length === 0 ? (
          <p className="mb-3 text-sm text-muted">No exchange rates yet.</p>
        ) : (
          <ul className="mb-3 divide-y divide-border">
            {fx.rates.map((r) => (
              <li key={r.currency} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3 text-sm">
                <span className="min-w-0 flex-1 basis-56">
                  <span className="font-medium tabular-nums">
                    1 {r.currency} = {r.rate}{" "}INR
                  </span>{" "}
                  <Badge tone={r.fresh ? "good" : "warn"}>{r.status}</Badge>
                  <span className="block text-xs text-muted">Updated {when(r.updatedAt)}</span>
                </span>
                <span className="flex flex-wrap gap-2">
                  <SettingsDialogButton
                    label="Update"
                    title={`Exchange rate for ${r.currency}`}
                    section="fx"
                    fixed={{ currency: r.currency }}
                    fields={[{ name: "rate", label: `INR for 1 ${r.currency}`, defaultValue: r.rate, inputMode: "decimal", required: true, validate: (v) => (/^\d{1,12}(\.\d{1,10})?$/.test(v.trim()) ? null : "Enter the rate as a number, for example 84.10.") }]}
                  />
                  <SettingsDialogButton label="Remove" title={`Remove the ${r.currency} rate?`} description={`Limits in ${r.currency} then need their own rows.`} section="fx" fixed={{ currency: r.currency, rate: "" }} fields={[]} variant="ghost" />
                </span>
              </li>
            ))}
          </ul>
        )}
        <SettingsDialogButton
          label="Add a rate"
          title="Add an exchange rate"
          section="fx"
          fields={[
            { name: "currency", label: "Currency", hint: "Three letters, like USD.", required: true, validate: (v) => (/^[A-Za-z]{3}$/.test(v.trim()) ? null : "Enter a three-letter currency code, like USD.") },
            { name: "rate", label: "INR for 1 unit", hint: "For example 84.10.", inputMode: "decimal", required: true, validate: (v) => (/^\d{1,12}(\.\d{1,10})?$/.test(v.trim()) ? null : "Enter the rate as a number, for example 84.10.") },
          ]}
        />
      </Card>

      <Card title="Notification sender" description="The WhatsApp number that sends owners their spending alerts, requests and daily summary. It must be in a complimentary, active workspace whose members are all platform admins.">
        {n.settings ? (
          <dl className="mb-3 grid gap-2 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs font-medium text-muted">Number</dt>
              <dd>{n.settings.senderDisplay ?? "Unknown number"}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-muted">Workspace</dt>
              <dd>{n.workspaceName ?? "Not found"}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-muted">Language</dt>
              <dd>{n.settings.language}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-muted">Templates</dt>
              <dd className="break-words font-mono text-xs">{Object.values(n.settings.templates).join(", ")}</dd>
            </div>
          </dl>
        ) : (
          <Alert tone="warn" className="mb-3">
            No sender is set up, so owners get spending alerts in the app only.
          </Alert>
        )}
        {candidates.length === 0 ? (
          <p className="text-sm text-muted">No number is available yet: make the notifier workspace complimentary on its workspace page, connect its number, then come back.</p>
        ) : (
          <SettingsDialogButton
            label={n.settings ? "Change the sender" : "Choose the sender"}
            title="Notification sender"
            description="Only numbers in complimentary, active workspaces are listed, so an unpaid bill or a suspension can never silence owners' alerts."
            section="notifier"
            fields={[
              { name: "phoneNumberId", label: "Number", type: "select", options: candidates.map((c) => ({ value: c.phoneId, label: c.label })), defaultValue: n.settings?.phoneNumberId ?? candidates[0]?.phoneId },
              { name: "language", label: "Template language", defaultValue: n.settings?.language ?? "en", hint: "For example en or en_US." },
              { name: "template_approval", label: "Approval request template", defaultValue: n.settings?.templates.approval ?? "spend_approval_v1" },
              { name: "template_alert", label: "Alert template", defaultValue: n.settings?.templates.alert ?? "spend_alert_v1" },
              { name: "template_digest", label: "Daily summary template", defaultValue: n.settings?.templates.digest ?? "spend_daily_v1" },
              { name: "template_optin", label: "Opt-in template", defaultValue: n.settings?.templates.optin ?? "spend_optin_v1" },
            ]}
          />
        )}
      </Card>

      <Card
        title="Requests and Meta's limit"
        description="Platform defaults, saved for the request and Meta limit routines. Until those routines read them, Edwyz still uses 12 hours for new workspaces' requests and 6 routine changes a day with 4 kept for emergencies (see the spend controls runbook)."
      >
        <dl className="mb-3 grid gap-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs font-medium text-muted">Default request expiry</dt>
            <dd>{d.approvalTtlHours} hours. A request nobody answers is declined automatically.</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted">Meta limit changes a day</dt>
            <dd>
              {d.metaCapRoutinePerDay} routine, {d.metaCapEmergencyReserve} kept for emergencies, at most {d.metaCapRaisesPerDay}{" "}raises. Meta allows 10 a day on each ad account.
            </dd>
          </div>
        </dl>
        {d.updatedAt && <p className="mb-3 text-xs text-muted">Changed {when(d.updatedAt)}</p>}
        <SettingsDialogButton
          label="Change"
          title="Requests and Meta's limit"
          section="defaults"
          fields={[
            { name: "approvalTtlHours", label: "Default request expiry (hours)", defaultValue: String(d.approvalTtlHours), inputMode: "numeric", required: true, hint: "1 to 48.", validate: (v) => (/^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 48 ? null : "Enter a whole number from 1 to 48.") },
            { name: "metaCapRoutinePerDay", label: "Routine Meta limit changes a day", defaultValue: String(d.metaCapRoutinePerDay), inputMode: "numeric", required: true, hint: "1 to 10." },
            { name: "metaCapEmergencyReserve", label: "Changes kept for emergencies", defaultValue: String(d.metaCapEmergencyReserve), inputMode: "numeric", required: true, hint: "Routine plus emergency can't be more than 10." },
            { name: "metaCapRaisesPerDay", label: "Most raises a day", defaultValue: String(d.metaCapRaisesPerDay), inputMode: "numeric", required: true, hint: "No more than the routine changes." },
          ]}
        />
      </Card>
    </div>
  );
}
