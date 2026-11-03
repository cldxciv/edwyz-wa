"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Alert, Button, FormField, Input, Select, Textarea } from "@/components/ui";
import { Disclosure } from "@/components/automation/Disclosure";
import { NODE_META, OPERATOR_TEXT, describeStep, handlesOf, savedVariables } from "./catalog";
import { UNIT_MINUTES, durationProblem, fromDuration, toDuration, type DurationUnit } from "./duration";
import { nextGapKey, nextId } from "./flow";
import { isVariableName, LONG_WAIT_MINUTES, validateNode } from "./validation";
import { LIMITS, TEAM_QUEUE, type FlowDefinition, type FlowNode, type NodeDataMap } from "./types";

export type TemplateOption = { id: string; name: string; status?: string; language?: string; category?: string; components?: unknown };
export type TeamOption = { id: string; name: string };
export type MemberOption = { userId: string; name: string };

type Props = {
  node: FlowNode;
  flow: FlowDefinition;
  templates: TemplateOption[];
  members: MemberOption[];
  teams?: TeamOption[];
  onData: (patch: Record<string, unknown>, structural?: boolean) => void;
  onConnect: (label: string | undefined, to: string) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onSetStart: () => void;
};

type Setter = (patch: Record<string, unknown>, structural?: boolean) => void;

const touch = "max-sm:min-h-10";

/** The heading of the open step. The page moves focus here after adding, copying or jumping to a step. */
export const INSPECTOR_HEADING_ID = "cb-inspector-heading";

type FocusLater = (selector: string) => void;

const parseChoices = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim().slice(0, LIMITS.choiceLength))
    .filter(Boolean)
    .slice(0, LIMITS.choices);


function TextField({ label, value, onChange, max = LIMITS.text, rows = 4, hint, vars, required, optional }: { label: string; value: string; onChange: (v: string) => void; max?: number; rows?: number; hint?: string; vars?: string[]; required?: boolean; optional?: boolean }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  function insert(token: string) {
    const el = ref.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? start;
    onChange((value.slice(0, start) + token + value.slice(end)).slice(0, max));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  }
  return (
    <div className="space-y-2">
      <FormField label={label} required={required} optional={optional} hint={hint ? `${value.length}/${max}. ${hint}` : `${value.length}/${max} characters`}>
        <Textarea ref={ref} rows={rows} value={value} maxLength={max} onChange={(e) => onChange(e.target.value)} />
      </FormField>
      {vars && vars.length > 0 && (
        <div role="group" aria-label="Insert a saved answer" className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted">Add a saved answer:</span>
          {vars.map((v) => (
            <Button key={v} type="button" size="sm" variant="secondary" className={touch} aria-label={`Insert saved answer ${v}`} onClick={() => insert(`{{${v}}}`)}>
              {v}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

function Line({ label, value, onChange, max = 120, placeholder, hint, type = "text", error, required, optional, list }: { label: string; value: string; onChange: (v: string) => void; max?: number; placeholder?: string; hint?: string; type?: string; error?: string | null; required?: boolean; optional?: boolean; list?: string }) {
  return (
    <FormField label={label} hint={hint} error={error} required={required} optional={optional}>
      <Input type={type} value={value} maxLength={max} placeholder={placeholder} list={list} onChange={(e) => onChange(e.target.value)} />
    </FormField>
  );
}

function Pick({ label, value, onChange, children, hint, required }: { label: string; value: string; onChange: (v: string) => void; children: ReactNode; hint?: string; required?: boolean }) {
  return (
    <FormField label={label} hint={hint} required={required}>
      <Select value={value} onChange={(e) => onChange(e.target.value)}>
        {children}
      </Select>
    </FormField>
  );
}

export function Inspector(p: Props) {
  const { node } = p;
  const meta = NODE_META[node.type];
  const set: Setter = (patch, structural = false) => p.onData(patch, structural);
  const handles = handlesOf(node);
  const targets = p.flow.nodes.filter((n) => n.id !== node.id);
  const problems = validateNode(node);
  const isStart = p.flow.start === node.id;
  const root = useRef<HTMLElement>(null);
  const pending = useRef<string | null>(null);
  const focusLater: FocusLater = (selector) => {
    pending.current = selector;
  };
  // After a row is added or removed the button the person used may be gone. Put the focus somewhere useful instead of the page top.
  useEffect(() => {
    const selector = pending.current;
    if (!selector) return;
    pending.current = null;
    root.current?.querySelector<HTMLElement>(selector)?.focus();
  });

  return (
    <section ref={root} aria-label={`${meta.label} settings`} className="space-y-5">
      <div>
        <h2 id={INSPECTOR_HEADING_ID} tabIndex={-1} className="text-base font-semibold outline-offset-4">
          {meta.label}
        </h2>
        <p className="mt-0.5 text-sm text-muted">{meta.help}</p>
        {isStart && <p className="mt-1 text-xs font-medium text-accent-ink">This is the first step. The chat begins here.</p>}
      </div>

      {problems.length > 0 && (
        <Alert tone="warn" title="To finish this step">
          <ul className="list-disc space-y-0.5 pl-4">
            {problems.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </Alert>
      )}

      <Body {...p} set={set} focusLater={focusLater} />

      {handles.length > 0 && (
        <fieldset className="space-y-3 rounded-card border border-border p-3">
          <legend className="px-1 text-sm font-medium">What happens next</legend>
          {handles.map((h) => {
            const current = p.flow.edges.find((e) => e.from === node.id && e.label === h.label)?.to ?? "";
            const label =
              handles.length === 1
                ? "Then go to"
                : node.type === "condition"
                  ? `If the answer is ${h.text.toLowerCase()}, go to`
                  : `If the customer chooses "${h.text}", go to`;
            return (
              <Pick key={h.label ?? "next"} label={label} value={current} onChange={(v) => p.onConnect(h.label, v)}>
                <option value="">Nothing (the chat ends)</option>
                {targets.map((n) => (
                  <option key={n.id} value={n.id}>
                    {describeStep(p.flow.nodes, n)}
                  </option>
                ))}
              </Pick>
            );
          })}
        </fieldset>
      )}

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" className={touch} onClick={p.onDuplicate}>
          Duplicate step
        </Button>
        <Button size="sm" variant="secondary" className={touch} onClick={p.onSetStart} disabled={isStart}>
          {isStart ? "This is the first step" : "Make this the first step"}
        </Button>
        <Button size="sm" variant="ghost" className={`${touch} text-bad-fg`} onClick={p.onDelete}>
          Delete step
        </Button>
      </div>
    </section>
  );
}

function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button type="button" size="sm" variant="ghost" className="mt-[1.625rem] min-h-10 shrink-0" aria-label={label} onClick={onClick}>
      Remove
    </Button>
  );
}

/** What a customer's message does while the bot waits. Same values as the server (src/lib/chatbots/flow.ts DELAY_REPLY_MODES). */
const ON_REPLY: { value: "" | "continue" | "pass"; label: string; hint: string }[] = [
  { value: "", label: "Keep waiting. The bot keeps the message and nothing else answers it", hint: "Chat routing, rules and the AI agent leave the message alone until the bot finishes." },
  { value: "continue", label: "Stop waiting and go on to the next step", hint: "What the customer wrote is saved as {{last_reply}}." },
  {
    value: "pass",
    label: "Keep waiting, and let chat routing and rules see the message",
    hint: "Chat routing can give the chat to a teammate, and rules can tag or assign it. Nothing answers the customer automatically while the bot waits: the AI agent and rule replies stay quiet.",
  },
];

function DelayFields({ minutes, onReply, set }: { minutes: number; onReply?: NodeDataMap["delay"]["onReply"]; set: Setter }) {
  const initial = toDuration(minutes);
  const [amount, setAmount] = useState(String(initial.amount || ""));
  const [unit, setUnit] = useState<DurationUnit>(initial.unit);
  const unitId = useId();
  const replyId = useId();
  const hintId = useId();
  const mode = ON_REPLY.find((o) => o.value === onReply) ?? ON_REPLY[0];
  // Undo, redo and "Undo" on the deleted-step message change the stored value without this box knowing. Always show what is stored.
  const stored = Number.isFinite(minutes) ? Math.max(0, Math.trunc(minutes)) : 0;
  if (fromDuration(Number(amount), unit) !== stored) {
    setAmount(String(initial.amount || ""));
    setUnit(initial.unit);
  }
  const change = (nextAmount: string, nextUnit: DurationUnit) => {
    setAmount(nextAmount);
    setUnit(nextUnit);
    set({ minutes: fromDuration(Number(nextAmount), nextUnit) });
  };
  const problem = amount === "" ? null : durationProblem(fromDuration(Number(amount), unit));
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">Wait for</legend>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
        <FormField label="Amount" error={problem}>
          <Input type="number" inputMode="numeric" min={1} value={amount} onChange={(e) => change(e.target.value, unit)} />
        </FormField>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={unitId} className="text-sm font-medium">
            Unit
          </label>
          <Select id={unitId} value={unit} onChange={(e) => change(amount, e.target.value as DurationUnit)}>
            {(Object.keys(UNIT_MINUTES) as DurationUnit[]).map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </Select>
        </div>
      </div>
      <p className="text-xs text-muted">
        You can wait from 1 minute to 7 days. The customer is not told the bot is waiting. WhatsApp only allows free messages for 24 hours after the customer last wrote, so after a wait of 23 hours or more the next message the bot sends must be Send template. Steps that send nothing, such as Add a tag, can come first.
      </p>
      {stored >= LONG_WAIT_MINUTES && (
        <p className="text-xs font-medium text-warn-fg">This is a long wait. Make Send template the next message after it, or the chatbot cannot be published.</p>
      )}
      <div className="flex flex-col gap-1.5">
        <label htmlFor={replyId} className="text-sm font-medium">
          If the customer writes during the wait
        </label>
        <Select id={replyId} value={mode.value} aria-describedby={hintId} onChange={(e) => set({ onReply: e.target.value || undefined }, true)}>
          {ON_REPLY.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
        <p id={hintId} className="text-xs text-muted">
          {mode.hint}
        </p>
      </div>
    </fieldset>
  );
}

function ChoicesField({ choices, set }: { choices: string[]; set: Setter }) {
  const [text, setText] = useState(choices.join("\n"));
  // Same as the wait box: follow the stored answers after undo or redo.
  if (JSON.stringify(parseChoices(text)) !== JSON.stringify(parseChoices(choices.join("\n")))) setText(choices.join("\n"));
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  return (
    <FormField label="Allowed answers" required hint={`One answer per line, up to ${LIMITS.choices}. ${lines.length} added.`}>
      <Textarea
        rows={4}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          set({ choices: parseChoices(e.target.value) });
        }}
      />
    </FormField>
  );
}

function Body(p: Props & { set: Setter; focusLater: FocusLater }) {
  const { node, set, focusLater } = p;
  const vars = savedVariables(p.flow.nodes);
  const listId = `vars-${node.id}`;
  switch (node.type) {
    case "send_text":
      return <TextField label="Message" required value={node.data.text} vars={vars} onChange={(text) => set({ text })} />;
    case "send_buttons": {
      const d = node.data;
      const used = d.buttons.map((b) => b.id);
      return (
        <>
          <TextField label="Message" required value={d.text} vars={vars} onChange={(text) => set({ text })} />
          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">
              Buttons ({d.buttons.length} of {LIMITS.buttons})
            </legend>
            {d.buttons.map((b, i) => (
              <div key={b.id} data-row={b.id} className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <Line label={`Button ${i + 1}`} required value={b.title} max={LIMITS.buttonTitle} hint={`${b.title.length}/${LIMITS.buttonTitle}`} onChange={(title) => set({ buttons: d.buttons.map((x) => (x.id === b.id ? { ...x, title } : x)) })} />
                </div>
                <RemoveButton label={`Remove button ${i + 1}`} onClick={() => {
                  focusLater(i > 0 ? `[data-row="${d.buttons[i - 1].id}"] input` : '[data-add="buttons"]');
                  set({ buttons: d.buttons.filter((x) => x.id !== b.id) }, true);
                }} />
              </div>
            ))}
            <Button type="button" size="sm" variant="secondary" className={touch} data-add="buttons" disabled={d.buttons.length >= LIMITS.buttons} onClick={() => {
              const id = nextId("b", used);
              focusLater(`[data-row="${id}"] input`);
              set({ buttons: [...d.buttons, { id, title: "" }] }, true);
            }}>
              Add a button
            </Button>
            <p className="text-xs text-muted">WhatsApp allows up to {LIMITS.buttons} buttons. Each button can lead to a different step below.</p>
          </fieldset>
          <FrameFields header={d.header} footer={d.footer} set={set} />
        </>
      );
    }
    case "send_list": {
      const d = node.data;
      const used = d.rows.map((r) => r.id);
      return (
        <>
          <TextField label="Message" required value={d.text} vars={vars} onChange={(text) => set({ text })} />
          <Line label="Menu button text" required value={d.buttonLabel} max={LIMITS.buttonTitle} hint={`What customers tap to open the menu. ${d.buttonLabel.length}/${LIMITS.buttonTitle}`} onChange={(buttonLabel) => set({ buttonLabel })} />
          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">
              Menu options ({d.rows.length} of {LIMITS.rows})
            </legend>
            {d.rows.map((r, i) => (
              <div key={r.id} data-row={r.id} className="space-y-2 rounded-card border border-border p-3">
                <Line label={`Option ${i + 1}`} required value={r.title} max={LIMITS.rowTitle} hint={`${r.title.length}/${LIMITS.rowTitle}`} onChange={(title) => set({ rows: d.rows.map((x) => (x.id === r.id ? { ...x, title } : x)) })} />
                <Line label={`Option ${i + 1} description`} optional value={r.description ?? ""} max={72} onChange={(description) => set({ rows: d.rows.map((x) => (x.id === r.id ? { ...x, description } : x)) })} />
                <Button type="button" size="sm" variant="ghost" className={touch} aria-label={`Remove option ${i + 1}`} onClick={() => {
                  focusLater(i > 0 ? `[data-row="${d.rows[i - 1].id}"] input` : '[data-add="rows"]');
                  set({ rows: d.rows.filter((x) => x.id !== r.id) }, true);
                }}>
                  Remove option
                </Button>
              </div>
            ))}
            <Button type="button" size="sm" variant="secondary" className={touch} data-add="rows" disabled={d.rows.length >= LIMITS.rows} onClick={() => {
              const id = nextId("r", used);
              focusLater(`[data-row="${id}"] input`);
              set({ rows: [...d.rows, { id, title: "" }] }, true);
            }}>
              Add an option
            </Button>
          </fieldset>
          <FrameFields header={d.header} footer={d.footer} set={set} />
        </>
      );
    }
    case "send_template": {
      const d = node.data;
      const keys = Object.keys(d.variables).sort((a, b) => Number(a) - Number(b));
      const chosen = p.templates.find((t) => t.id === d.templateId);
      const needs = templateNeeds(chosen?.components);
      return (
        <>
          <Pick
            label="Template"
            required
            value={d.templateId}
            onChange={(templateId) => {
              const next = p.templates.find((t) => t.id === templateId);
              const count = templateNeeds(next?.components).bodyGaps;
              const variables = Object.fromEntries(Array.from({ length: count }, (_, i) => [String(i + 1), d.variables[String(i + 1)] ?? ""]));
              set({ templateId, variables: count > 0 ? variables : d.variables }, true);
            }}
            hint={p.templates.length === 0 ? "You have no templates yet. Create one in Templates and wait for approval." : "Only approved templates can be sent."}
          >
            <option value="">Choose a template</option>
            {p.templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
                {t.language ? ` (${t.language})` : ""}
                {t.status && t.status.toLowerCase() !== "approved" ? ", not approved yet" : ""}
              </option>
            ))}
          </Pick>
          {d.templateId && (
            <fieldset className="space-y-3">
              <legend className="text-sm font-medium">Fill in the template</legend>
              <p className="text-xs text-muted">If your template has numbered gaps like {"{{1}}"}, say what goes in each one. You can use saved answers, for example {"{{name}}"} or {"{{contact.name}}"}.</p>
              {keys.map((k) => (
                <div key={k} data-row={`gap-${k}`} className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <Line label={`Text for {{${k}}}`} value={d.variables[k]} max={200} onChange={(v) => set({ variables: { ...d.variables, [k]: v } })} />
                  </div>
                  <RemoveButton label={`Remove the text for gap ${k}`} onClick={() => {
                    const before = keys[keys.indexOf(k) - 1];
                    focusLater(before ? `[data-row="gap-${before}"] input` : '[data-add="gaps"]');
                    set({ variables: Object.fromEntries(Object.entries(d.variables).filter(([x]) => x !== k)) }, true);
                  }} />
                </div>
              ))}
              <Button type="button" size="sm" variant="secondary" className={touch} data-add="gaps" disabled={keys.length >= 10} onClick={() => {
                const key = nextGapKey(keys);
                focusLater(`[data-row="gap-${key}"] input`);
                set({ variables: { ...d.variables, [key]: "" } }, true);
              }}>
                Add a gap
              </Button>
              {chosen && keys.length < needs.bodyGaps && <p className="text-xs text-warn-fg">This template has {needs.bodyGaps} gaps in its text. Fill in all of them or it will not be sent.</p>}
            </fieldset>
          )}
          {d.templateId && needs.headerText && (
            <Line label="Text for the header" required value={d.headerVariable ?? ""} max={200} hint="The header of this template has a gap. You can use saved answers." onChange={(headerVariable) => set({ headerVariable })} />
          )}
          {d.templateId && needs.headerMedia && (
            <Line
              label={`Link to the header ${needs.headerMedia}`}
              required
              value={d.headerMediaUrl ?? ""}
              max={500}
              placeholder="https://example.com/picture.jpg"
              hint="The template has a header you must fill. Use a secure https link, or a saved answer such as {{photo}}."
              onChange={(headerMediaUrl) => set({ headerMediaUrl })}
            />
          )}
          {d.templateId && needs.buttonGap && (
            <Line label="Text for the button link" required value={d.buttonVariable ?? ""} max={200} hint="The web address on the button has a gap. You can use saved answers." onChange={(buttonVariable) => set({ buttonVariable })} />
          )}
          {d.templateId && chosen?.category === "MARKETING" && (
            <p className="text-xs text-muted">This is a marketing template, so it is only sent to customers who agreed to marketing messages. For others the bot follows the "If it cannot be sent" path.</p>
          )}
        </>
      );
    }
    case "ask": {
      const d = node.data;
      const nameProblem = d.variable && !isVariableName(d.variable) ? "Use letters, numbers and underscores only, and start with a letter. Example: email" : null;
      return (
        <>
          <TextField label="Question" required value={d.text} vars={vars} onChange={(text) => set({ text })} />
          <Line label="Save the answer as" required value={d.variable} max={40} hint="A short name you can use later, like name or email." error={nameProblem} onChange={(variable) => set({ variable })} />
          <Pick label="What kind of answer" value={d.validate} onChange={(validate) => set({ validate }, true)} hint="If the answer does not fit, the bot asks again.">
            <option value="text">Any text</option>
            <option value="number">A number</option>
            <option value="email">An email address</option>
            <option value="phone">A phone number</option>
            <option value="date">A date</option>
            <option value="choice">One of the allowed answers</option>
          </Pick>
          {d.validate === "choice" && <ChoicesField choices={d.choices ?? []} set={set} />}
          <Disclosure summary="More options" defaultOpen={Boolean(d.retryText)}>
              <TextField label="Message when the answer does not fit" optional rows={2} value={d.retryText ?? ""} hint="Leave empty to use a standard message." onChange={(retryText) => set({ retryText })} />
              <Pick label="If the answer does not fit, ask again" value={String(d.maxRetries)} onChange={(v) => set({ maxRetries: Math.min(5, Math.max(0, Math.trunc(Number(v) || 0))) }, true)} hint="After this many tries the bot stops.">
                <option value="0">Do not ask again</option>
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>
                    Up to {n} {n === 1 ? "time" : "times"}
                  </option>
                ))}
              </Pick>
          </Disclosure>
        </>
      );
    }
    case "condition": {
      const d = node.data;
      return (
        <>
          <datalist id={listId}>
            {vars.map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>
          <Line label="Saved answer to check" required value={d.variable} max={40} list={listId} hint={vars.length ? "Choose one of your saved answers, or type its name." : "Add a question step first, then check its answer here."} onChange={(variable) => set({ variable })} />
          <Pick label="Check whether it" value={d.operator} onChange={(operator) => set({ operator }, true)}>
            {Object.entries(OPERATOR_TEXT).map(([value, text]) => (
              <option key={value} value={value}>
                {text}
              </option>
            ))}
          </Pick>
          {d.operator !== "exists" && <Line label="This value" required value={d.value} max={200} hint={d.operator === "gt" || d.operator === "lt" ? "Enter a number." : undefined} onChange={(value) => set({ value })} />}
        </>
      );
    }
    case "set_attribute":
      return (
        <>
          <Line label="Contact detail" required value={node.data.attribute} max={60} placeholder="e.g. City" hint="The name of the detail to save on the contact." onChange={(attribute) => set({ attribute })} />
          <Line label="Value" value={node.data.value} max={200} hint="You can use a saved answer, for example {{city}}." onChange={(value) => set({ value })} />
        </>
      );
    case "add_tag":
    case "remove_tag":
      return <Line label="Tag" required value={node.data.tag} max={40} placeholder="e.g. New lead" hint="Tags help you find and group contacts later." onChange={(tag) => set({ tag })} />;
    case "delay":
      return <DelayFields minutes={node.data.minutes} onReply={node.data.onReply} set={set} />;
    case "webhook": {
      const d = node.data;
      const urlProblem = d.url.trim() && !/^https:\/\/\S+$/i.test(d.url.trim()) ? "The address must start with https://" : null;
      const saveProblem = d.saveAs && !isVariableName(d.saveAs) ? "Use letters, numbers and underscores only." : null;
      return (
        <>
          <Line label="Web address" required value={d.url} max={500} placeholder="https://example.com/orders" hint="The bot contacts this address and waits up to 5 seconds for a reply." error={urlProblem} onChange={(url) => set({ url })} />
          <Disclosure summary="Advanced options" defaultOpen={d.method === "POST"}>
              <Pick label="How to contact it" value={d.method} onChange={(method) => set({ method }, true)}>
                <option value="GET">Ask for information</option>
                <option value="POST">Send information</option>
              </Pick>
              {d.method === "POST" && <TextField label="Information to send" optional rows={4} max={2000} hint="You can use saved answers." vars={vars} value={d.bodyTemplate ?? ""} onChange={(bodyTemplate) => set({ bodyTemplate })} />}
              <Line label="Save the reply as" optional value={d.saveAs ?? ""} max={40} error={saveProblem} hint="Then you can use the reply in later messages." onChange={(saveAs) => set({ saveAs })} />
          </Disclosure>
        </>
      );
    }
    case "assign": {
      const d = node.data;
      const teams = p.teams ?? [];
      return (
        <>
          {teams.length > 0 && (
            <Pick label="Team" value={d.teamId ?? ""} onChange={(teamId) => set({ teamId: teamId || undefined, userId: d.userId || "round_robin" }, true)} hint="Pick a team to put the chat in that team's queue.">
              <option value="">No team</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Pick>
          )}
          <Pick label={d.teamId ? "Teammate in that team" : "Assign the chat to"} required value={d.userId} onChange={(userId) => set({ userId }, true)}>
            {d.teamId && <option value="">No one in particular (the team picks)</option>}
            <option value="round_robin">The next free teammate{d.teamId ? " of the team" : ""} (shares chats equally)</option>
            {p.members.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.name}
              </option>
            ))}
          </Pick>
        </>
      );
    }
    case "set_status":
      return (
        <Pick label="Mark the chat as" value={node.data.status} onChange={(status) => set({ status }, true)}>
          <option value="open">Open</option>
          <option value="pending">Pending</option>
          <option value="solved">Solved</option>
        </Pick>
      );
    case "handoff": {
      const d = node.data;
      const teams = p.teams ?? [];
      return (
        <>
          <TextField label="Message to the customer" optional rows={3} value={d.message ?? ""} hint="For example: A teammate will reply shortly." vars={vars} onChange={(message) => set({ message })} />
          {teams.length > 0 && (
            <Pick label="Hand the chat to" value={d.teamId ?? ""} onChange={(teamId) => set({ teamId: teamId || undefined, ...(!teamId && d.userId === TEAM_QUEUE ? { userId: undefined } : {}) }, true)}>
              <option value="">Whoever your routing settings choose</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Pick>
          )}
          <Pick label={d.teamId ? "Teammate in that team" : "Or a specific teammate"} value={d.userId ?? ""} onChange={(userId) => set({ userId: userId || undefined }, true)}>
            <option value="">{d.teamId ? "The next free teammate of the team" : "No one in particular"}</option>
            {d.teamId && <option value={TEAM_QUEUE}>No one yet: leave it in the team's queue</option>}
            {p.members.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.name}
              </option>
            ))}
          </Pick>
          <label className="flex min-h-10 items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1 h-5 w-5 accent-(--accent)" checked={d.note !== false} onChange={(e) => set({ note: e.target.checked ? undefined : false })} />
            <span>
              Leave a private note for your team
              <span className="block text-xs text-muted">The note lists what the bot learned, such as names and answers.</span>
            </span>
          </label>
        </>
      );
    }
    case "subscribe":
      return (
        <Line
          label="Where did they agree?"
          optional
          value={node.data.source ?? ""}
          max={100}
          hint="Kept as proof of consent. For example: Said yes in the offers chatbot. Customers who sent STOP stay opted out."
          onChange={(source) => set({ source: source || undefined })}
        />
      );
    case "unsubscribe":
      return (
        <>
          <TextField label="Confirmation to the customer" optional rows={2} value={node.data.message ?? ""} hint="Sent just before they are opted out. Nothing is sent after it." vars={vars} onChange={(message) => set({ message: message || undefined })} />
          <p className="text-sm text-muted">The chatbot stops here.</p>
        </>
      );
    case "end":
      return <p className="text-sm text-muted">The conversation with the bot stops here. Nothing more is sent.</p>;
  }
}

type TemplateNeeds = { bodyGaps: number; headerText: boolean; headerMedia: "picture" | "video" | "document" | null; buttonGap: boolean };

/** What an approved template asks the sender to fill in, read from its components. */
export function templateNeeds(components: unknown): TemplateNeeds {
  const list = Array.isArray(components) ? (components as Record<string, unknown>[]).filter((c) => c && typeof c === "object") : [];
  const type = (c: Record<string, unknown>) => (typeof c.type === "string" ? c.type.toUpperCase() : "");
  let bodyGaps = 0;
  const body = list.find((c) => type(c) === "BODY");
  if (body && typeof body.text === "string") for (const m of body.text.matchAll(/\{\{(\d+)\}\}/g)) bodyGaps = Math.max(bodyGaps, Number(m[1]));
  const header = list.find((c) => type(c) === "HEADER");
  const format = header && typeof header.format === "string" ? header.format.toUpperCase() : "TEXT";
  const headerText = Boolean(header) && format === "TEXT" && /\{\{/.test(String(header?.text ?? ""));
  const headerMedia = !header ? null : format === "IMAGE" ? "picture" : format === "VIDEO" ? "video" : format === "DOCUMENT" ? "document" : null;
  const buttons = list.find((c) => type(c) === "BUTTONS")?.buttons;
  const buttonGap = Array.isArray(buttons) && buttons.some((b) => b && typeof b === "object" && /\{\{/.test(String((b as { url?: unknown }).url ?? "")));
  return { bodyGaps, headerText, headerMedia, buttonGap };
}

function FrameFields({ header, footer, set }: { header?: string; footer?: string; set: Setter }) {
  return (
    <Disclosure summary="Header and footer" defaultOpen={Boolean(header || footer)}>
      <Line label="Header" optional value={header ?? ""} max={LIMITS.headerText} hint={`Bold text above the message. ${(header ?? "").length}/${LIMITS.headerText}`} onChange={(v) => set({ header: v || undefined })} />
      <Line label="Footer" optional value={footer ?? ""} max={LIMITS.footer} hint={`Small grey text under the message. ${(footer ?? "").length}/${LIMITS.footer}`} onChange={(v) => set({ footer: v || undefined })} />
    </Disclosure>
  );
}

export type { NodeDataMap };
