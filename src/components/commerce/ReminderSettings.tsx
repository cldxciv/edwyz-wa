"use client";

import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Card, ErrorState, FormField, Input, Select, Skeleton, SkeletonText, apiFetch, toast } from "@/components/ui";
import { useApi } from "@/components/contacts/hooks";
import { DEFAULT_GAPS_MIN, LIFETIME_DAYS, REMINDERS, formatMinutes, friendlyError, gapErrors, lateReminders, parseGap, scheduleRows } from "./helpers";
import type { Options, Settings, Store } from "./types";

type GapKey = "cartGapsMin" | "checkoutGapsMin";
/** Approved templates a reminder cannot fill in come back as `hidden`, with the reason, so the merchant knows why one is missing. */
type ReminderOptions = Options & { hidden?: { id: string; name: string; language: string; reason: string }[] };

const ORDINALS = ["1st", "2nd", "3rd"];

function Schedule({ title, trigger, gaps, errors, disabled, onChange, onReset }: { title: string; trigger: string; gaps: number[]; errors: (string | null)[]; disabled: boolean; onChange: (i: number, value: string) => void; onReset: () => void }) {
  const rows = scheduleRows(gaps);
  const late = lateReminders(gaps);
  return (
    <fieldset className="min-w-0 rounded-card border border-border p-4">
      <legend className="px-1 text-sm font-semibold">{title}</legend>
      <div className="grid gap-3 sm:grid-cols-3">
        {gaps.slice(0, REMINDERS).map((g, i) => (
          <FormField key={i} label={`${ORDINALS[i]} reminder`} hint={i === 0 ? "Minutes after the shopper stops." : `Minutes after the ${ORDINALS[i - 1]} reminder.`} error={errors[i]}>
            <Input type="number" inputMode="numeric" min={1} max={4320} value={g > 0 ? g : ""} disabled={disabled} onChange={(e) => onChange(i, e.target.value)} />
          </FormField>
        ))}
      </div>

      <ol className="mt-4 space-y-1.5 border-l-2 border-border-strong pl-4" aria-label={`${title} timeline`}>
        <li className="relative text-sm">
          <span aria-hidden className="absolute -left-[1.4rem] top-1.5 h-2.5 w-2.5 rounded-full bg-muted" />
          <span className="font-medium">{trigger}</span>
        </li>
        {rows.map((r, i) => (
          <li key={r.number} className="relative text-sm">
            <span aria-hidden className="absolute -left-[1.4rem] top-1.5 h-2.5 w-2.5 rounded-full bg-accent" />
            <span className="font-medium">{ORDINALS[i]} reminder</span>
            <span className="text-muted">
              {" "}
              at {formatMinutes(r.total)}
              {i > 0 ? ` (${formatMinutes(r.gap)} after the one before)` : ""}
              {r.late ? ". Probably too late to send." : ""}
            </span>
          </li>
        ))}
      </ol>
      {late.length > 0 && (
        <Alert className="mt-3" tone="warn">
          Carts expire after {LIFETIME_DAYS} days, so reminder {late.join(" and ")}{" "}may never be sent. Use shorter waits.
        </Alert>
      )}
      {!disabled && (
        <Button className="mt-3" size="sm" variant="ghost" onClick={onReset}>
          Use the recommended timing
        </Button>
      )}
    </fieldset>
  );
}

export function ReminderSettings({ store, editable }: { store: Store; editable: boolean }) {
  const current = useApi<{ settings: Settings }>(`/api/commerce/stores/${store.id}/settings`);
  const options = useApi<ReminderOptions>("/api/commerce/options");
  const [draft, setDraft] = useState<Settings | null>(null);
  const [saved, setSaved] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (current.data) {
      setDraft(current.data.settings);
      setSaved(current.data.settings);
    }
  }, [current.data]);

  const cartErrors = useMemo(() => gapErrors(draft?.cartGapsMin ?? []), [draft?.cartGapsMin]);
  const checkoutErrors = useMemo(() => gapErrors(draft?.checkoutGapsMin ?? []), [draft?.checkoutGapsMin]);

  if (current.error && !draft) {
    return (
      <Card title="Reminders">
        <ErrorState
          title="We could not load the reminder settings"
          message={current.error}
          action={
            <Button variant="secondary" onClick={current.reload}>
              Try again
            </Button>
          }
        />
      </Card>
    );
  }
  if (!draft || !saved) {
    return (
      <Card title="Reminders" aria-busy="true">
        <SkeletonText lines={4} />
        <Skeleton className="mt-4 h-10 w-40" />
        <span role="status" className="sr-only">
          Loading reminder settings
        </span>
      </Card>
    );
  }

  const settings = draft;
  const dirty = JSON.stringify(settings) !== JSON.stringify(saved);
  const hasGapError = [...cartErrors, ...checkoutErrors].some(Boolean);
  const noTemplates = !!options.data && options.data.templates.length === 0;
  const hidden = options.data?.hidden ?? [];
  const missing = settings.enabled && (!settings.templateId || !settings.phoneNumberId);
  const unverified = store.status !== "active" && store.status !== "disabled";

  const setGap = (key: GapKey, i: number, value: string) => {
    const next = [...settings[key]];
    next[i] = parseGap(value);
    setDraft({ ...settings, [key]: next });
  };

  async function save() {
    if (hasGapError || missing) return;
    setSaving(true);
    setError("");
    try {
      const res = await apiFetch<{ settings: Settings }>(`/api/commerce/stores/${store.id}/settings`, { method: "PUT", body: settings });
      setDraft(res.settings);
      setSaved(res.settings);
      toast.success("Reminder settings saved");
    } catch (err) {
      setError(friendlyError(err, "We could not save these settings."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card title="Reminders" description={`How and when we nudge shoppers who leave ${store.shopDomain} without buying.`}>
      <div className="flex items-start gap-3">
        <input
          id={`enabled-${store.id}`}
          type="checkbox"
          className="mt-1 h-4 w-4 shrink-0 accent-accent"
          disabled={!editable}
          checked={settings.enabled}
          onChange={(e) => setDraft({ ...settings, enabled: e.target.checked })}
          aria-describedby={`enabled-${store.id}-hint`}
        />
        <label htmlFor={`enabled-${store.id}`} className="text-sm">
          <span className="font-medium">Send WhatsApp reminders</span>
          <span id={`enabled-${store.id}-hint`} className="mt-0.5 block text-xs text-muted">
            Only to customers who agreed to WhatsApp messages. A reminder is skipped when the customer buys, replies or sends STOP. Carts expire after {LIFETIME_DAYS}{" "}days.
          </span>
        </label>
      </div>
      {unverified && settings.enabled && (
        <Alert className="mt-3" tone="warn">
          Reminders start only after Shopify confirms the connection.
        </Alert>
      )}

      <div className="mt-5 grid gap-4 md:grid-cols-2">
        <FormField
          label="Reminder message"
          required={settings.enabled}
          hint="Only approved templates a reminder can fill in are listed. Your template can use up to three blanks: {{1}} the customer's first name, {{2}} the cart total, {{3}} the checkout link. A website button ending in {{1}} opens the checkout."
        >
          <Select disabled={!editable || !!options.error} value={settings.templateId ?? ""} onChange={(e) => setDraft({ ...settings, templateId: e.target.value || null })}>
            <option value="">Choose a template</option>
            {options.data?.templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.language})
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="Send from" required={settings.enabled} hint="The WhatsApp number your customers will see.">
          <Select disabled={!editable} value={settings.phoneNumberId ?? ""} onChange={(e) => setDraft({ ...settings, phoneNumberId: e.target.value || null })}>
            <option value="">Choose a number</option>
            {options.data?.phoneNumbers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayPhone}
              </option>
            ))}
          </Select>
        </FormField>
      </div>
      {options.error && (
        <Alert
          className="mt-3"
          tone="bad"
          title="We could not load your templates and numbers"
          action={
            <Button size="sm" variant="secondary" onClick={options.retry}>
              Try again
            </Button>
          }
        >
          {friendlyError(new Error(options.error), "Check your connection and try again.")}
        </Alert>
      )}
      {noTemplates && (
        <Alert className="mt-3" tone="info" title={hidden.length ? "None of your approved templates can be a reminder" : "No approved templates yet"} action={<a className="font-semibold underline underline-offset-2" href="/app/templates">Go to templates</a>}>
          Create a reminder template and wait for Meta to approve it, then come back to choose it.
        </Alert>
      )}
      {hidden.length > 0 && (
        <details className="mt-3 rounded-control border border-border p-3 text-sm">
          <summary className="min-h-8 cursor-pointer font-medium">
            Why {hidden.length === 1 ? "1 approved template is" : `${hidden.length} approved templates are`} not listed
          </summary>
          <ul className="mt-2 space-y-1">
            {hidden.map((t) => (
              <li key={t.id}>
                <span className="font-medium">
                  {t.name} ({t.language})
                </span>
                : <span className="text-muted">{t.reason}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {missing && (
        <Alert className="mt-3" tone="warn">
          Choose a template and a number before turning reminders on.
        </Alert>
      )}

      <h3 className="mb-1 mt-6 text-base font-semibold">When reminders go out</h3>
      <p className="mb-3 text-sm text-muted">
        We send up to {REMINDERS}{" "}reminders per shopper. The first is timed from their last action in your store. Each next one is timed from the reminder before it. Times are in minutes (60 minutes is 1 hour, 1,440 is 1 day).
      </p>
      <div className="grid gap-4 xl:grid-cols-2">
        <Schedule
          title="Left something in the cart"
          trigger="Shopper leaves something in the cart"
          gaps={settings.cartGapsMin}
          errors={cartErrors}
          disabled={!editable}
          onChange={(i, v) => setGap("cartGapsMin", i, v)}
          onReset={() => setDraft({ ...settings, cartGapsMin: [...DEFAULT_GAPS_MIN.cart] })}
        />
        <Schedule
          title="Started checkout but did not pay"
          trigger="Shopper starts checkout and leaves"
          gaps={settings.checkoutGapsMin}
          errors={checkoutErrors}
          disabled={!editable}
          onChange={(i, v) => setGap("checkoutGapsMin", i, v)}
          onReset={() => setDraft({ ...settings, checkoutGapsMin: [...DEFAULT_GAPS_MIN.checkout] })}
        />
      </div>

      {error && (
        <Alert className="mt-4" tone="bad" title="We could not save these settings">
          {error}
        </Alert>
      )}
      {editable ? (
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <Button onClick={() => void save()} loading={saving} disabled={!dirty || hasGapError || missing}>
            Save reminder settings
          </Button>
          {dirty && <span className="text-sm text-muted">You have unsaved changes.</span>}
        </div>
      ) : (
        <p className="mt-4 text-sm text-muted">Only owners and admins can change these settings.</p>
      )}
    </Card>
  );
}
