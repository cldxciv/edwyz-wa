"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Field, FormField, Input, Select, Textarea, cn } from "@/components/ui";
import { Disclosure } from "./Disclosure";
import { Toggle } from "./Toggle";
import { DAY_LABELS, MAX_REPLY, TYPE_HELP, addKeywords, counter, timezoneOptions, validateDraftFields, type RuleDraft } from "./helpers";

export const RULE_FORM_ID = "rule-form";

const COOLDOWNS = [
  { label: "1 minute", value: 1 },
  { label: "5 minutes", value: 5 },
  { label: "1 hour", value: 60 },
  { label: "6 hours", value: 360 },
  { label: "12 hours", value: 720 },
  { label: "1 day", value: 1440 },
  { label: "7 days", value: 10080 },
];

const NAME_EXAMPLE = { welcome: "Welcome message", away: "Closed for the night", keyword: "Price question" } as const;
const REPLY_EXAMPLE = {
  welcome: "Hi, thanks for messaging us. We will get back to you shortly.",
  away: "Thanks for your message. We are closed right now and will reply when we open.",
  keyword: "Our prices start at ... Reply with what you need and we will send a quote.",
} as const;

function Check() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2.5 6.5l2.5 2.5 4.5-5.5" />
    </svg>
  );
}

type Props = {
  initial: RuleDraft;
  busy: boolean;
  /** A problem reported by the server after saving. */
  error: string | null;
  onSubmit: (d: RuleDraft) => void;
};

/** The buttons live in the dialog footer and submit this form through its id (see RULE_FORM_ID). */
export function RuleForm({ initial, busy, error, onSubmit }: Props) {
  const [draft, setDraft] = useState<RuleDraft>(initial);
  const [kw, setKw] = useState("");
  const [attempted, setAttempted] = useState(false);
  const zones = useMemo(() => timezoneOptions(), []);
  const errorRef = useRef<HTMLDivElement>(null);
  const keywordRef = useRef<HTMLInputElement>(null);

  // A save that the server refused must be seen: the form scrolls inside the dialog, so bring the message to the person.
  useEffect(() => {
    if (!error) return;
    errorRef.current?.scrollIntoView?.({ block: "nearest" });
    errorRef.current?.focus();
  }, [error]);
  const set = <K extends keyof RuleDraft>(key: K, value: RuleDraft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const schedule = draft.schedule;
  const type = draft.type;

  const pending = kw.trim() ? { ...draft, keywords: addKeywords(draft.keywords, kw) } : draft;
  const problems: ReturnType<typeof validateDraftFields> = attempted ? validateDraftFields(pending) : {};

  function commitKeywords() {
    if (kw.trim()) set("keywords", addKeywords(draft.keywords, kw));
    setKw("");
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setAttempted(true);
    if (Object.keys(validateDraftFields(pending)).length === 0) onSubmit(pending);
    else queueMicrotask(() => document.querySelector<HTMLElement>(`#${RULE_FORM_ID} [aria-invalid="true"]`)?.focus());
  }

  const toggleDay = (day: number) => {
    if (!schedule) return;
    const days = schedule.days.includes(day) ? schedule.days.filter((d) => d !== day) : [...schedule.days, day].sort();
    set("schedule", { ...schedule, days });
  };

  const cooldowns = COOLDOWNS.some((c) => c.value === draft.cooldownMinutes) ? COOLDOWNS : [{ label: `${draft.cooldownMinutes} minutes`, value: draft.cooldownMinutes }, ...COOLDOWNS];

  return (
    <form id={RULE_FORM_ID} onSubmit={submit} noValidate className="space-y-5">
      {error && (
        <div ref={errorRef} tabIndex={-1} className="rounded-card">
          <Alert tone="bad" title="We could not save this reply">
            {error}
          </Alert>
        </div>
      )}
      <p className="text-sm text-muted">{TYPE_HELP[type]}</p>

      <FormField label="Name" required hint="Only your team sees this." error={problems.name}>
        <Input value={draft.name} maxLength={80} placeholder={`e.g. ${NAME_EXAMPLE[type]}`} onChange={(e) => set("name", e.target.value)} data-autofocus="" />
      </FormField>

      {type === "keyword" && (
        <>
          <Field
            label="Words that trigger this reply"
            htmlFor="rule-kw"
            required
            hint="Type a word and press Enter or comma. Capital letters do not matter."
            error={problems.keywords}
          >
            <div className={cn("flex flex-wrap items-center gap-1.5 rounded-control border bg-raised p-2 shadow-raised", problems.keywords ? "border-bad" : "border-border-strong")}>
              {draft.keywords.map((k) => (
                <span key={k} className="inline-flex items-center gap-1 rounded-full border border-border bg-surface py-0.5 pl-2.5 pr-1 text-sm">
                  {k}
                  <button
                    type="button"
                    aria-label={`Remove the word ${k}`}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-foreground"
                    onClick={() => {
                      set("keywords", draft.keywords.filter((x) => x !== k));
                      keywordRef.current?.focus();
                    }}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" aria-hidden>
                      <path d="M6 6l12 12M18 6L6 18" />
                    </svg>
                  </button>
                </span>
              ))}
              <input
                id="rule-kw"
                ref={keywordRef}
                className="min-h-8 min-w-[8rem] flex-1 bg-transparent px-1 text-sm text-foreground outline-none placeholder:text-muted"
                value={kw}
                placeholder={draft.keywords.length ? "Add another word" : "For example: price"}
                aria-describedby="rule-kw-hint rule-kw-error"
                aria-invalid={problems.keywords ? true : undefined}
                aria-required
                onChange={(e) => setKw(e.target.value)}
                onBlur={commitKeywords}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === ",") {
                    e.preventDefault();
                    commitKeywords();
                  } else if (e.key === "Backspace" && !kw && draft.keywords.length) set("keywords", draft.keywords.slice(0, -1));
                }}
              />
            </div>
          </Field>
          <FormField label="Match when" hint="Choose &quot;exactly&quot; if the customer should send only the word and nothing else.">
            <Select value={draft.matchMode} onChange={(e) => set("matchMode", e.target.value as "contains" | "exact")}>
              <option value="contains">The message contains one of the words</option>
              <option value="exact">The message is exactly one of the words</option>
            </Select>
          </FormField>
        </>
      )}

      {type === "away" && schedule && (
        <fieldset className="space-y-4 rounded-card border border-border p-4">
          <legend className="px-1 text-sm font-medium">When you are open</legend>
          <p className="text-sm text-muted">Customers who write at any other time get this reply.</p>
          <div>
            <div role="group" aria-label="Days you are open" className="flex flex-wrap gap-2">
              {DAY_LABELS.map((label, i) => {
                const on = schedule.days.includes(i);
                return (
                  <button
                    key={label}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggleDay(i)}
                    className={cn(
                      "inline-flex min-h-10 min-w-14 items-center justify-center gap-1.5 rounded-full border px-3 text-sm font-medium",
                      on ? "border-accent bg-accent text-on-accent" : "border-border-strong bg-raised hover:bg-surface-2",
                    )}
                  >
                    {on && <Check />}
                    {label}
                  </button>
                );
              })}
            </div>
            {problems.days && (
              <p role="alert" className="mt-1.5 text-xs font-medium text-bad-fg">
                {problems.days}
              </p>
            )}
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <FormField label="Opens at" required>
              <Input type="time" value={schedule.start} onChange={(e) => set("schedule", { ...schedule, start: e.target.value })} />
            </FormField>
            <FormField label="Closes at" required>
              <Input type="time" value={schedule.end} onChange={(e) => set("schedule", { ...schedule, end: e.target.value })} />
            </FormField>
            <FormField label="Time zone">
              <Select value={schedule.timezone} onChange={(e) => set("schedule", { ...schedule, timezone: e.target.value })}>
                {(zones.includes(schedule.timezone) ? zones : [schedule.timezone, ...zones]).map((z) => (
                  <option key={z} value={z}>
                    {z.replace(/_/g, " ")}
                  </option>
                ))}
              </Select>
            </FormField>
          </div>
          <p className="text-xs text-muted">If you close later than you open, hours run overnight. For example 22:00 to 06:00 counts as the day it starts on.</p>
        </fieldset>
      )}

      <FormField label="Reply" required hint={`${counter(draft.replyText)} characters. Customers see this exactly as you write it.`} error={problems.replyText}>
        <Textarea rows={4} value={draft.replyText} maxLength={MAX_REPLY} placeholder={`e.g. ${REPLY_EXAMPLE[type]}`} onChange={(e) => set("replyText", e.target.value)} />
      </FormField>

      <div className="rounded-card bg-surface p-3" role="group" aria-label="Preview of the reply">
        <p className="mb-2 text-xs font-medium text-muted">What the customer sees</p>
        <div className="ml-auto max-w-[85%] whitespace-pre-wrap break-words rounded-2xl bg-accent px-3.5 py-2 text-sm text-on-accent">{draft.replyText || "Your reply will appear here."}</div>
      </div>

      <Disclosure summary="More options" openOnce={Boolean(problems.cooldown)}>
          <FormField
            label={type === "welcome" ? "Send again after the customer has been quiet for" : "Do not send this again in the same chat for"}
            hint="Stops the same reply being sent over and over."
            error={problems.cooldown}
          >
            <Select value={draft.cooldownMinutes} onChange={(e) => set("cooldownMinutes", Number(e.target.value))}>
              {cooldowns.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </Select>
          </FormField>
      </Disclosure>

      <div className="flex items-center justify-between gap-3 rounded-card border border-border p-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">Turn this reply on</p>
          <p className="text-xs text-muted">You can switch it off at any time without deleting it.</p>
        </div>
        <Toggle checked={draft.enabled} onChange={(v) => set("enabled", v)} label="Turn this reply on" />
      </div>

      <span className="sr-only" aria-live="polite">
        {busy ? "Saving" : ""}
      </span>
    </form>
  );
}
