"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Alert, Badge, Button, Card, Field, FormField, Input, Select, apiFetch, cn, toast } from "@/components/ui";
import { MAX_DELAY_MINUTES, MAX_STEPS, buildTimeline, describeStep, friendlyError, splitDelay, stepProblems, toMinutes, type DelayUnit } from "./helpers";
import type { StepDraft } from "./types";

export type Sequence = { id: string; name: string; enabled: boolean; steps: Partial<StepDraft>[]; appliesTo: { leadFormId?: string; campaignMetaId?: string } | null };
export type Option = { id: string; name: string; status?: string };

type Draft = StepDraft & { key: number; value: number; unit: DelayUnit };

let draftKey = 0;
const blankStep = (delayMinutes = 60): Draft => ({ key: ++draftKey, delayMinutes, ...splitDelay(delayMinutes), templateId: "", chatbotId: "", stopOnReply: true });

function fromStored(s: Partial<StepDraft>, index: number): Draft {
  const minutes = index === 0 ? 0 : (s.delayMinutes ?? 0);
  return { ...blankStep(minutes), ...s, delayMinutes: minutes, templateId: s.templateId ?? "", chatbotId: s.chatbotId ?? "", stopOnReply: s.stopOnReply !== false };
}

const UNIT_LABEL: Record<DelayUnit, string> = { minutes: "minutes", hours: "hours", days: "days" };

export function SequenceBuilder({ initial, templates, chatbots, forms, onSaved, onCancel }: { initial: Sequence | null; templates: Option[]; chatbots: Option[]; forms: Option[]; onSaved: () => void | Promise<void>; onCancel: () => void }) {
  const uid = useId();
  const [name, setName] = useState(initial?.name ?? "");
  const [formId, setFormId] = useState(initial?.appliesTo?.leadFormId ?? "");
  const [campaign, setCampaign] = useState(initial?.appliesTo?.campaignMetaId ?? "");
  const [steps, setSteps] = useState<Draft[]>(initial && initial.steps.length > 0 ? initial.steps.map(fromStored) : [blankStep(0)]);
  const [error, setError] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState("");
  const [focusTick, setFocusTick] = useState(0);
  const focusAfter = useRef<string | null>(null);
  const heading = useRef<HTMLSpanElement>(null);
  const nameId = `${uid}-name`;
  const stepId = (key: number, part: string) => `${uid}-k${key}-${part}`;

  useEffect(() => {
    heading.current?.scrollIntoView({ block: "start" });
    heading.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const id = focusAfter.current;
    if (!id) return;
    focusAfter.current = null;
    document.getElementById(id)?.focus();
  }, [steps, focusTick]);

  function addStep() {
    const step = blankStep();
    focusAfter.current = stepId(step.key, "wait");
    setSteps((all) => [...all, step]);
    setNote(`Step ${steps.length + 1} added. Choose how long to wait and what to send.`);
  }

  function removeStep(i: number) {
    focusAfter.current = stepId(steps[i - 1].key, "h");
    setSteps((all) => all.filter((_, j) => j !== i));
    setNote(`Step ${i + 1} removed. ${steps.length - 1} ${steps.length - 1 === 1 ? "step" : "steps"} left.`);
  }

  const setStep = (i: number, patch: Partial<Draft>) =>
    setSteps((all) =>
      all.map((s, j) => {
        if (j !== i) return s;
        const next = { ...s, ...patch };
        if (patch.value !== undefined || patch.unit !== undefined) next.delayMinutes = toMinutes(next.value, next.unit);
        return next;
      }),
    );

  const timeline = useMemo(() => buildTimeline(steps), [steps]);
  const problems = useMemo(() => stepProblems(steps), [steps]);
  const nameError = submitted && !name.trim() ? "Give the sequence a name so you can find it later." : null;
  const noTemplates = templates.length === 0;

  async function save() {
    setSubmitted(true);
    setError("");
    if (!name.trim() || problems.length > 0) {
      focusAfter.current = !name.trim() ? nameId : stepId(steps[problems[0].index].key, "tpl");
      setFocusTick((n) => n + 1);
      return;
    }
    setSaving(true);
    const body = {
      name: name.trim(),
      steps: steps.map((s, i) => ({
        delayMinutes: i === 0 ? 0 : s.delayMinutes,
        templateId: s.templateId || undefined,
        chatbotId: s.chatbotId || undefined,
        stopOnReply: s.stopOnReply,
        ...(s.params ? { params: s.params } : {}),
      })),
      appliesTo: formId || campaign.trim() ? { ...(formId ? { leadFormId: formId } : {}), ...(campaign.trim() ? { campaignMetaId: campaign.trim() } : {}) } : null,
    };
    try {
      await apiFetch(initial ? `/api/leads/sequences/${initial.id}` : "/api/leads/sequences", { method: initial ? "PATCH" : "POST", body });
      toast.success(initial ? "Follow-up sequence saved" : "Follow-up sequence created");
      await onSaved();
    } catch (e) {
      setError(friendlyError(e, "We could not save this sequence."));
      setSaving(false);
    }
  }

  return (
    <Card
      title={
        <span ref={heading} tabIndex={-1} className="scroll-mt-24 outline-none">
          {initial ? "Edit follow-up sequence" : "New follow-up sequence"}
        </span>
      }
      description="A sequence messages a new lead automatically, one step after another."
    >
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Name" htmlFor={nameId} required error={nameError} hint="For example: Welcome new leads">
          <Input id={nameId} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
        </Field>
        <FormField label="Which leads" hint="Leave on any form to use this sequence for every lead.">
          <Select value={formId} onChange={(e) => setFormId(e.target.value)}>
            <option value="">Leads from any form</option>
            {forms.map((f) => (
              <option key={f.id} value={f.id}>
                Only leads from {f.name}
              </option>
            ))}
          </Select>
        </FormField>
      </div>
      <details className="mt-3" open={Boolean(campaign)}>
        <summary className="min-h-10 cursor-pointer text-sm font-medium">More targeting options</summary>
        <div className="mt-2 max-w-md">
          <FormField label="Only for one campaign" optional hint="Paste the campaign ID from Meta Ads Manager. Leave empty to include every campaign.">
            <Input value={campaign} maxLength={64} inputMode="numeric" onChange={(e) => setCampaign(e.target.value)} />
          </FormField>
        </div>
      </details>

      <h3 className="mb-1 mt-6 text-base font-semibold">Steps</h3>
      <p className="mb-4 text-sm text-muted">The first step goes out as soon as a lead arrives. Each later step waits, then goes out. By default the whole sequence stops as soon as the lead replies, and you can change that for each step.</p>

      {noTemplates && (
        <Alert className="mb-4" tone="info" title="You have no approved message templates yet" action={<a className="font-semibold underline underline-offset-2" href="/app/templates">Go to templates</a>}>
          Steps send an approved template. Create one and wait for approval, or start a chatbot instead.
        </Alert>
      )}

      <p role="status" className="sr-only">
        {note}
      </p>
      <ol className="m-0 list-none p-0">
        {steps.map((s, i) => {
          const entry = timeline[i];
          const problem = submitted ? problems.find((p) => p.index === i) : undefined;
          const last = i === steps.length - 1;
          const stopId = stepId(s.key, "stop");
          const tplId = stepId(s.key, "tpl");
          return (
            <li key={s.key} className="relative flex gap-3 sm:gap-4">
              <div className="flex flex-col items-center" aria-hidden>
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-sm font-semibold text-on-accent">{i + 1}</span>
                {!last && <span className="my-1 w-0.5 flex-1 bg-border-strong" />}
              </div>
              <div className={cn("min-w-0 flex-1", !last && "pb-6")}>
                <div className="rounded-card border border-border bg-surface p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h4 id={stepId(s.key, "h")} tabIndex={-1} className="text-sm font-semibold outline-none">
                      Step {i + 1}
                    </h4>
                    <Badge tone="info">{entry.whenLabel}</Badge>
                  </div>
                  <p className="mt-1 text-sm text-muted" aria-live="polite">
                    {describeStep(s, i, templates, chatbots)}
                  </p>

                  <div className="mt-4 grid gap-4 md:grid-cols-2">
                    {i > 0 && (
                      <fieldset className="min-w-0">
                        <legend className="text-sm font-medium">Wait before sending</legend>
                        <div className="mt-1.5 flex gap-2">
                          <Input id={stepId(s.key, "wait")} aria-label={`Step ${i + 1} wait amount`} type="number" inputMode="numeric" min={0} value={s.value} onChange={(e) => setStep(i, { value: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} />
                          <Select aria-label={`Step ${i + 1} wait unit`} value={s.unit} onChange={(e) => setStep(i, { unit: e.target.value as DelayUnit })}>
                            {(Object.keys(UNIT_LABEL) as DelayUnit[]).map((u) => (
                              <option key={u} value={u}>
                                {UNIT_LABEL[u]}
                              </option>
                            ))}
                          </Select>
                        </div>
                        <p className="mt-1.5 text-xs text-muted">{s.delayMinutes >= MAX_DELAY_MINUTES ? "30 days is the longest wait." : "Counted from the step before."}</p>
                      </fieldset>
                    )}
                    <Field label="Message to send" htmlFor={tplId} error={problem?.message} hint="Only approved templates are listed.">
                      <Select id={tplId} value={s.templateId} onChange={(e) => setStep(i, { templateId: e.target.value })}>
                        <option value="">No message</option>
                        {templates.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <FormField label="Then start a chatbot" optional hint="The chatbot takes over the conversation.">
                      <Select aria-invalid={problem ? true : undefined} aria-describedby={problem ? `${tplId}-error` : undefined} value={s.chatbotId} onChange={(e) => setStep(i, { chatbotId: e.target.value })}>
                        <option value="">No chatbot</option>
                        {chatbots.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </Select>
                    </FormField>
                    {i > 0 && (
                      <div className="flex items-start gap-2 self-center">
                        <input id={stopId} type="checkbox" className="mt-1 h-4 w-4 accent-accent" checked={s.stopOnReply} onChange={(e) => setStep(i, { stopOnReply: e.target.checked })} />
                        <label htmlFor={stopId} className="text-sm">
                          Stop the sequence here if the lead has replied
                          <span className="block text-xs text-muted">Recommended, so nobody gets an automatic message in the middle of a real chat. If you leave this unticked, this step is still sent after a reply.</span>
                        </label>
                      </div>
                    )}
                  </div>
                  {i > 0 && (
                    <Button className="mt-3" size="sm" variant="ghost" onClick={() => removeStep(i)}>
                      Remove step {i + 1}
                    </Button>
                  )}
                </div>
                {!last && <p className="mt-2 pl-1 text-xs font-medium text-muted">{timeline[i + 1].waitLabel}</p>}
              </div>
            </li>
          );
        })}
      </ol>
      {steps.length < MAX_STEPS ? (
        <Button className="mt-4" size="sm" variant="secondary" onClick={addStep}>
          Add another step
        </Button>
      ) : (
        <p className="mt-4 text-sm text-muted">You can have up to {MAX_STEPS} steps.</p>
      )}

      <Alert className="mt-6" tone="neutral" title="Good to know">
        <ul className="ml-4 list-disc space-y-1">
          <li>Marketing templates are skipped for leads who have not agreed to receive them.</li>
          <li>The sequence stops if the lead opts out, or you mark them Won, Lost or Not a real lead.</li>
          <li>If more than one turned-on sequence matches a lead, only the one you created first runs.</li>
        </ul>
      </Alert>

      {error && (
        <Alert className="mt-4" tone="bad" title="We could not save this sequence">
          {error}
        </Alert>
      )}
      <div className="mt-5 flex flex-wrap gap-3">
        <Button onClick={save} loading={saving}>
          Save sequence
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}
