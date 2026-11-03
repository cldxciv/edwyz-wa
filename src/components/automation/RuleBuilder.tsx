"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Alert, Button, Card, ErrorState, FormField, Input, Select, Skeleton, apiFetch, confirm, toast } from "@/components/ui";
import { PageHeader } from "@/components/app/PageHeader";
import { canManage, useApi, useRole } from "@/components/contacts/hooks";
import { LIMITS, type Trigger, type TriggerType } from "@/lib/automation/v2/model";
import { OPT_OUT_SCHEDULED } from "@/lib/contacts/opt-out";
import { ActionList } from "./ActionEditor";
import { GroupEditor } from "./ConditionEditor";
import { guardedNavigationPath } from "@/components/templates/helpers";
import { DAY_LABELS, browserTimezone, humanError, ownSubmit, timezoneOptions } from "./helpers";
import { linkButton } from "./linkButton";
import {
  STARTERS,
  TRIGGERS,
  WAIT_CHOICES,
  applyTrigger,
  cardProblems,
  defaultTrigger,
  draftFromRow,
  draftWarnings,
  emptyDraftV2,
  hasProblems,
  namesFrom,
  summaryOf,
  templateFillProblem,
  toBody,
  triggerProblem,
  validateDraftV2,
  EMPTY_OPTIONS,
  STATUS_CHOICES,
  type DraftProblems,
  type Options,
  type RuleDraftV2,
  type RuleRow,
} from "./rulesV2";

const zones = timezoneOptions();
const UNITS = [
  { label: "minutes", factor: 1 },
  { label: "hours", factor: 60 },
  { label: "days", factor: 1440 },
] as const;

function Step({ n, title, hint, error, children }: { n: number; title: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`step-${n}`} className="rounded-card border border-border bg-raised p-5 shadow-raised">
      <div className="mb-4 flex items-start gap-3">
        <span aria-hidden className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-sm font-semibold text-on-accent">
          {n}
        </span>
        <div className="min-w-0">
          <h2 id={`step-${n}`} className="text-base font-semibold tracking-tight">
            {title}
          </h2>
          {hint && <p className="mt-0.5 text-sm text-muted">{hint}</p>}
        </div>
      </div>
      <div className="space-y-4">{children}</div>
      {error && (
        <p role="alert" data-problem className="mt-3 text-sm font-medium text-bad-fg">
          {error}
        </p>
      )}
    </section>
  );
}

function TriggerFields({ trigger, onChange, timezone, showErrors }: { trigger: Trigger; onChange: (t: Trigger) => void; timezone: string; showErrors: boolean }) {
  const problem = showErrors ? triggerProblem(trigger) : null;
  const err = (field: string) => (problem?.field === field ? problem.message : undefined);
  switch (trigger.type) {
    case "no_customer_response": {
      const unit = [...UNITS].reverse().find((u) => trigger.minutes % u.factor === 0) ?? UNITS[0];
      return (
        <div className="grid grid-cols-2 gap-3 sm:max-w-sm">
          <FormField label="Wait for" error={err("minutes")}>
            <Input type="number" min={1} value={trigger.minutes / unit.factor} onChange={(e) => onChange({ ...trigger, minutes: Math.max(1, Math.round(Number(e.target.value) || 1)) * unit.factor })} />
          </FormField>
          <FormField label="Unit">
            <Select value={unit.label} onChange={(e) => onChange({ ...trigger, minutes: Math.max(1, trigger.minutes / unit.factor) * (UNITS.find((u) => u.label === e.target.value)?.factor ?? 1) })}>
              {UNITS.map((u) => (
                <option key={u.label}>{u.label}</option>
              ))}
            </Select>
          </FormField>
        </div>
      );
    }
    case "scheduled":
      return (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <FormField label="How often">
              <Select value={trigger.repeat} onChange={(e) => onChange({ ...trigger, repeat: e.target.value as typeof trigger.repeat, days: e.target.value === "weekly" ? [1] : [0, 1, 2, 3, 4, 5, 6], date: e.target.value === "once" ? (trigger.date ?? new Date().toISOString().slice(0, 10)) : undefined })}>
                <option value="once">Once</option>
                <option value="daily">Every day</option>
                <option value="weekly">Every week</option>
              </Select>
            </FormField>
            {trigger.repeat === "once" && (
              <FormField label="Date" error={err("date")}>
                <Input type="date" value={trigger.date ?? ""} onChange={(e) => onChange({ ...trigger, date: e.target.value })} />
              </FormField>
            )}
            <FormField label="Time" error={err("time")}>
              <Input type="time" value={trigger.time} onChange={(e) => onChange({ ...trigger, time: e.target.value })} />
            </FormField>
          </div>
          {trigger.repeat === "weekly" && (
            <fieldset aria-describedby={err("days") ? "trigger-days-error" : undefined}>
              <legend className="mb-1.5 text-sm font-medium">On these days</legend>
              <div className="flex flex-wrap gap-1.5">
                {DAY_LABELS.map((label, day) => (
                  <label key={label} className="inline-flex min-h-10 cursor-pointer select-none items-center gap-1.5 rounded-full border border-border-strong bg-raised px-3 text-sm has-[:checked]:border-accent has-[:checked]:bg-accent-soft">
                    <input type="checkbox" className="h-4 w-4 accent-accent" checked={trigger.days.includes(day)} onChange={() => onChange({ ...trigger, days: trigger.days.includes(day) ? trigger.days.filter((d) => d !== day) : [...trigger.days, day].sort() })} />
                    {label}
                  </label>
                ))}
              </div>
              {err("days") && (
                <p id="trigger-days-error" role="alert" data-problem className="mt-1.5 text-xs font-medium text-bad-fg">
                  {err("days")}
                </p>
              )}
            </fieldset>
          )}
          <FormField label="Timezone" error={err("timezone")}>
            <Select value={trigger.timezone || timezone} onChange={(e) => onChange({ ...trigger, timezone: e.target.value })}>
              {(zones.includes(trigger.timezone) ? zones : [trigger.timezone, ...zones]).map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </Select>
          </FormField>
          <p className="text-sm text-muted">It runs for your contacts one by one. Use the If step to choose who, for example a tag or a segment. One run reaches up to 5,000 contacts who fit your conditions, and the history notes it if more were left. A rule you save or switch on after today&apos;s time first runs at the next scheduled time. {OPT_OUT_SCHEDULED} Marketing templates only go to people who agreed to them.</p>
        </div>
      );
    case "tag_added":
    case "tag_removed":
      return (
        <FormField label="Tag" optional error={err("tag")} hint="Leave empty to react to any tag. Runs when a teammate, a contact import, the API, a lead form or a chatbot changes tags. Changes made by another rule do not start rules.">
          <Input value={trigger.tag ?? ""} maxLength={LIMITS.tag} onChange={(e) => onChange({ ...trigger, tag: e.target.value || null })} />
        </FormField>
      );
    case "attribute_changed":
      return (
        <FormField label="Contact detail" required error={err("attribute")} hint="The name of the detail, for example city or order status. Runs when a teammate, a contact import, the API, a lead form or a chatbot changes it. Changes made by another rule do not start rules.">
          <Input value={trigger.attribute} maxLength={LIMITS.attribute} onChange={(e) => onChange({ ...trigger, attribute: e.target.value })} />
        </FormField>
      );
    case "contact_created":
      return <p className="text-sm text-muted">Runs once for each new contact, however they are added: a first message, adding them by hand, a contact import, the API, a lead form or starting a chat from the inbox.</p>;
    case "status_changed":
      return (
        <FormField label="The chat is marked">
          <Select value={trigger.to ?? ""} onChange={(e) => onChange({ ...trigger, to: e.target.value || null })}>
            <option value="">Any status</option>
            {STATUS_CHOICES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </Select>
        </FormField>
      );
    default:
      return null;
  }
}

type FormProps = { initial: RuleDraftV2; ruleId: string | null; options: Options; editable: boolean; onMaterialCreated: () => void };

function BuilderForm({ initial, ruleId, options, editable, onMaterialCreated }: FormProps) {
  const router = useRouter();
  const timezone = useMemo(() => browserTimezone(), []);
  const [draft, setDraft] = useState<RuleDraftV2>(initial);
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const problems: DraftProblems = attempted ? validateDraftV2(draft) : {};
  // Problems that belong to one field are shown under it; the cards keep only the rest.
  const cards = cardProblems(draft, problems);
  const names = useMemo(() => namesFrom(options), [options]);
  const warnings = draftWarnings(draft);
  const set = <K extends keyof RuleDraftV2>(key: K, value: RuleDraftV2[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const sentence = summaryOf(draft, names);
  // Nothing to lose while saving (the page is about to change) or when the form is only for looking.
  const dirty = editable && !busy && JSON.stringify(draft) !== JSON.stringify(initial);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    // Cancel, All rules and the menu are links that navigate on the client, which never fires beforeunload: ask first.
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
      void confirm({ title: "Leave without saving?", body: "This rule has not been saved. If you leave now, your changes are lost.", confirmLabel: "Leave without saving", cancelLabel: "Keep editing", tone: "danger" }).then((ok) => {
        if (ok) router.push(path);
      });
    };
    window.addEventListener("beforeunload", warn);
    document.addEventListener("click", guardLinks, true);
    return () => {
      window.removeEventListener("beforeunload", warn);
      document.removeEventListener("click", guardLinks, true);
    };
  }, [dirty, router]);

  function changeTrigger(type: TriggerType) {
    const result = applyTrigger(draft, defaultTrigger(type, timezone));
    setDraft(result.draft);
    setNote(result.dropped.length ? `We removed ${result.dropped.join(" and ")} because they only work when a customer sends a message.` : null);
  }

  async function submit(e: React.FormEvent) {
    // Only this form's own submit: a dialog's form opened from inside it (a new reply material) must never save the rule.
    if (!ownSubmit(e)) return;
    setAttempted(true);
    setServerError(null);
    const found = validateDraftV2(draft);
    // A template step missing a heading picture or value, a button value, or using another number's account: shown under its field.
    const unfilled = draft.actions.some((a) => templateFillProblem(a, options, draft.phoneNumberId));
    if (hasProblems(found) || unfilled) {
      queueMicrotask(() => formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"], [data-problem]')?.scrollIntoView?.({ block: "center" }));
      return;
    }
    setBusy(true);
    try {
      if (ruleId) await apiFetch(`/api/automation/${ruleId}`, { method: "PATCH", body: toBody(draft) });
      else await apiFetch("/api/automation", { method: "POST", body: toBody(draft) });
      toast.success(ruleId ? `"${draft.name.trim()}" was updated.` : `"${draft.name.trim()}" was created.`);
      router.push("/app/automation");
    } catch (err) {
      setServerError(humanError(err, "save this rule"));
      setBusy(false);
    }
  }

  async function remove() {
    const ok = await confirm({ title: `Delete "${draft.name}"?`, body: "The rule stops running and its history stays in the log. If you only want a break, switch it off instead.", confirmLabel: "Delete rule", tone: "danger" });
    if (!ok || !ruleId) return;
    try {
      await apiFetch(`/api/automation/${ruleId}`, { method: "DELETE" });
      toast.success(`"${draft.name}" was deleted.`);
      router.push("/app/automation");
    } catch (err) {
      toast.error(humanError(err, "delete this rule"));
    }
  }

  const ctxOptions = options;
  const root = draft.filters.root;

  return (
    <form ref={formRef} onSubmit={submit} noValidate className="space-y-5">
      <fieldset disabled={!editable || busy} className="min-w-0 space-y-5 border-0 p-0">
        {serverError && (
          <Alert tone="bad" title="We could not save this rule">
            {serverError}
          </Alert>
        )}
        <Card>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Rule name" required hint="Only your team sees this." error={problems.name}>
              <Input value={draft.name} maxLength={LIMITS.name} placeholder="e.g. Welcome message" onChange={(e) => set("name", e.target.value)} data-autofocus="" />
            </FormField>
            {options.phoneNumbers.length > 1 && (
              <FormField label="Only for this number" optional hint="Leave on all numbers to run for every WhatsApp number.">
                <Select value={draft.phoneNumberId ?? ""} onChange={(e) => set("phoneNumberId", e.target.value || null)}>
                  <option value="">All numbers</option>
                  {options.phoneNumbers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.verifiedName ? `${p.verifiedName} (${p.displayPhone})` : p.displayPhone}
                    </option>
                  ))}
                </Select>
              </FormField>
            )}
          </div>
        </Card>

        <Step n={1} title="When" hint="What starts this rule?" error={cards.trigger}>
          <FormField label="The rule starts when" hint={TRIGGERS.find((t) => t.value === draft.trigger.type)?.help}>
            <Select value={draft.trigger.type} onChange={(e) => changeTrigger(e.target.value as TriggerType)}>
              {TRIGGERS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </Select>
          </FormField>
          <TriggerFields trigger={draft.trigger} onChange={(t) => set("trigger", t)} timezone={timezone} showErrors={attempted} />
          {note && <Alert tone="info">{note}</Alert>}
        </Step>

        <Step n={2} title="If" hint="Optional. Only continue when these are true." error={cards.filters}>
          <GroupEditor group={root} depth={1} ctx={{ trigger: draft.trigger, options: ctxOptions, timezone, showErrors: attempted }} onChange={(g) => set("filters", { ...draft.filters, root: g })} />
        </Step>

        <Step n={3} title="Then" hint="What should happen? Steps run from top to bottom." error={cards.actions}>
          <ActionList actions={draft.actions} trigger={draft.trigger} options={options} phoneNumberId={draft.phoneNumberId} onMaterialCreated={onMaterialCreated} onChange={(a) => set("actions", a)} showErrors={attempted} />
        </Step>

        <details className="rounded-card border border-border bg-raised p-4 shadow-raised">
          <summary className="min-h-10 cursor-pointer text-sm font-semibold leading-10">More options</summary>
          <div className="mt-3 space-y-4">
            <FormField label="Do not run again for the same person for" hint="Stops the rule repeating itself.">
              <Select value={String(draft.cooldownMinutes)} onChange={(e) => set("cooldownMinutes", Number(e.target.value))} className="sm:max-w-xs">
                {(WAIT_CHOICES.some((w) => w.value === draft.cooldownMinutes) ? WAIT_CHOICES : [{ label: `${draft.cooldownMinutes} minutes`, value: draft.cooldownMinutes }, ...WAIT_CHOICES]).map((w) => (
                  <option key={w.value} value={w.value}>
                    {w.label}
                  </option>
                ))}
              </Select>
            </FormField>
            <label className="flex min-h-10 items-start gap-2.5 text-sm">
              <input type="checkbox" className="mt-0.5 h-5 w-5 shrink-0 accent-accent" checked={draft.stopAfterMatch} onChange={(e) => set("stopAfterMatch", e.target.checked)} />
              <span>Stop here: do not run the rules below this one when this rule runs.</span>
            </label>
            <label className="flex min-h-10 items-start gap-2.5 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 h-5 w-5 shrink-0 accent-accent"
                checked={draft.filters.options.allowWhenHumanActive}
                onChange={(e) => set("filters", { ...draft.filters, options: { ...draft.filters.options, allowWhenHumanActive: e.target.checked } })}
              />
              <span>Reply even while a person is handling the chat. By default, replies wait until the agent has been quiet for 30 minutes.</span>
            </label>
            <label className="flex min-h-10 items-start gap-2.5 text-sm">
              <input type="checkbox" className="mt-0.5 h-5 w-5 shrink-0 accent-accent" checked={draft.enabled} onChange={(e) => set("enabled", e.target.checked)} />
              <span>This rule is switched on.</span>
            </label>
          </div>
        </details>

        <Card title="In plain words" description="Check that this says what you mean.">
          <p className="rounded-card bg-surface p-3 text-sm" aria-live="polite">
            {sentence}
          </p>
          {warnings.map((w) => (
            <Alert key={w} tone="warn" className="mt-3">
              {w}
            </Alert>
          ))}
        </Card>
      </fieldset>

      {/* On a phone the bar sticks just above the bottom menu bar (3.25rem tall, see MobileTabBar), not under it. */}
      <div className="sticky bottom-[calc(3.25rem+env(safe-area-inset-bottom))] z-(--z-sticky) -mx-4 flex flex-wrap items-center gap-3 border-t border-border bg-background/95 px-4 py-3 backdrop-blur sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:p-0">
        {editable && (
          <Button type="submit" loading={busy} className="max-sm:flex-1">
            {ruleId ? "Save changes" : "Create rule"}
          </Button>
        )}
        <Link href="/app/automation" className={linkButton("secondary", "md", "max-sm:flex-1")}>
          {editable ? "Cancel" : "Back to rules"}
        </Link>
        {editable && ruleId && (
          <Button type="button" variant="ghost" className="text-bad-fg sm:ml-auto" onClick={() => void remove()} disabled={busy}>
            Delete rule
          </Button>
        )}
      </div>
    </form>
  );
}

export function RuleBuilder({ ruleId, starterId }: { ruleId?: string; starterId?: string }) {
  const role = useRole();
  const editable = canManage(role);
  const options = useApi<Options>("/api/automation/options");
  const existing = useApi<{ rule: RuleRow }>(ruleId ? `/api/automation/${ruleId}` : null);
  const initial = useMemo(() => {
    if (ruleId) return existing.data ? draftFromRow(existing.data.rule) : null;
    const starter = STARTERS.find((s) => s.id === starterId);
    return starter ? starter.build(browserTimezone()) : emptyDraftV2();
  }, [ruleId, starterId, existing.data]);

  // The server answers "Rule not found." for a deleted rule, a mistyped address or another workspace's rule: retrying cannot help.
  const missing = Boolean(ruleId && !existing.data && existing.error && /not found/i.test(existing.error));
  const failed = (ruleId ? existing.error && !existing.data : false) || (options.error && !options.data);
  const isClassic = existing.data && existing.data.rule.version !== 2;

  return (
    <div>
      <PageHeader
        title={ruleId ? "Edit rule" : "New rule"}
        description="A rule has three parts: when it starts, what must be true, and what it does. Rules run in the order shown on the Automation page."
        actions={
          <Link href="/app/automation" className={linkButton("secondary", "md")}>
            All rules
          </Link>
        }
      />
      {role && !editable && (
        <Alert tone="info" className="mb-4">
          You can look at this rule. Only admins and owners can change it.
        </Alert>
      )}
      {missing ? (
        <ErrorState
          title="This rule no longer exists"
          message="It may have been deleted, or the link is wrong. Your other rules are on the Automation page."
          action={
            <Link href="/app/automation" className={linkButton("secondary", "md")}>
              Back to rules
            </Link>
          }
        />
      ) : failed ? (
        <ErrorState title="We could not load this rule" message="Check your connection and try again." action={<Button onClick={() => (existing.retry(), options.retry())}>Try again</Button>} />
      ) : isClassic ? (
        <Alert tone="warn" title="This is a classic auto-reply">
          Convert it from the Automation page to edit it here.
        </Alert>
      ) : !initial || (!options.data && !options.error) ? (
        <div aria-busy="true" className="space-y-4">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : (
        <BuilderForm key={`${ruleId ?? "new"}-${starterId ?? ""}`} initial={initial} ruleId={ruleId ?? null} options={options.data ?? EMPTY_OPTIONS} editable={editable} onMaterialCreated={options.reload} />
      )}
    </div>
  );
}
