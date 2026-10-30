"use client";

import { useState } from "react";
import { Button, FormField, Input, Select } from "@/components/ui";
import { LIMITS, MESSAGE_TYPES, type Condition, type Group } from "@/lib/automation/v2/model";
import { DAY_LABELS, addKeywords, timezoneOptions } from "./helpers";
import { ATTRIBUTE_OP_LABEL, conditionsFor, defaultCondition, MESSAGE_TYPE_LABEL, type Options } from "./rulesV2";
import type { Trigger } from "@/lib/automation/v2/model";

const zones = timezoneOptions();

const QUIET_CHOICES = [
  { label: "1 hour", value: 60 },
  { label: "6 hours", value: 360 },
  { label: "12 hours", value: 720 },
  { label: "1 day", value: 1440 },
  { label: "7 days", value: 10080 },
];

type Ctx = { trigger: Trigger; options: Options; timezone: string };

function KeywordsField({ value, onChange }: { value: string[]; onChange: (next: string[]) => void }) {
  const [text, setText] = useState("");
  const commit = () => {
    if (text.trim()) onChange(addKeywords(value, text, LIMITS.keywords));
    setText("");
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {value.map((k) => (
          <span key={k} className="inline-flex items-center gap-1 rounded-full border border-border bg-surface py-0.5 pl-2.5 pr-1 text-sm">
            {k}
            <button type="button" aria-label={`Remove the word ${k}`} className="inline-flex h-7 w-7 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-foreground" onClick={() => onChange(value.filter((x) => x !== k))}>
              <span aria-hidden>x</span>
            </button>
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <Input
          aria-label="Add a word or phrase"
          value={text}
          maxLength={LIMITS.keywordLength}
          placeholder="Type a word and press Enter"
          onChange={(e) => (e.target.value.includes(",") ? (onChange(addKeywords(value, e.target.value, LIMITS.keywords)), setText("")) : setText(e.target.value))}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            }
          }}
          onBlur={commit}
        />
        <Button type="button" variant="secondary" onClick={commit} disabled={!text.trim()}>
          Add word
        </Button>
      </div>
    </div>
  );
}

function DaysField({ value, onChange }: { value: number[]; onChange: (next: number[]) => void }) {
  return (
    <fieldset>
      <legend className="mb-1.5 text-sm font-medium">Days</legend>
      <div className="flex flex-wrap gap-1.5">
        {DAY_LABELS.map((label, day) => (
          <label key={label} className="inline-flex min-h-10 cursor-pointer select-none items-center gap-1.5 rounded-full border border-border-strong bg-raised px-3 text-sm has-[:checked]:border-accent has-[:checked]:bg-accent-soft">
            <input type="checkbox" className="h-4 w-4 accent-accent" checked={value.includes(day)} onChange={() => onChange(value.includes(day) ? value.filter((d) => d !== day) : [...value, day].sort())} />
            {label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function ConditionFields({ c, onChange, ctx }: { c: Condition; onChange: (next: Condition) => void; ctx: Ctx }) {
  switch (c.type) {
    case "keyword":
      return (
        <div className="space-y-3">
          <FormField label="The message">
            <Select value={c.mode} onChange={(e) => onChange({ ...c, mode: e.target.value as "contains" | "exact" })}>
              <option value="contains">contains any of these words</option>
              <option value="exact">is exactly one of these words</option>
            </Select>
          </FormField>
          <KeywordsField value={c.keywords} onChange={(keywords) => onChange({ ...c, keywords })} />
          <p className="text-xs text-muted">Capital letters do not matter.</p>
        </div>
      );
    case "new_chat":
      return (
        <FormField label="This message is">
          <Select value={c.value ? "yes" : "no"} onChange={(e) => onChange({ ...c, value: e.target.value === "yes" })}>
            <option value="yes">the customer&apos;s first message</option>
            <option value="no">not their first message</option>
          </Select>
        </FormField>
      );
    case "quiet_for":
      return (
        <FormField label="The customer is new, or has been quiet for at least" hint="Good for a welcome message that should come back after a long break.">
          <Select value={String(c.minutes)} onChange={(e) => onChange({ ...c, minutes: Number(e.target.value) })}>
            {(QUIET_CHOICES.some((q) => q.value === c.minutes) ? QUIET_CHOICES : [{ label: `${c.minutes} minutes`, value: c.minutes }, ...QUIET_CHOICES]).map((q) => (
              <option key={q.value} value={q.value}>
                {q.label}
              </option>
            ))}
          </Select>
        </FormField>
      );
    case "message_type":
      return (
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium">The message is any of</legend>
          <div className="flex flex-wrap gap-1.5">
            {MESSAGE_TYPES.map((t) => (
              <label key={t} className="inline-flex min-h-10 cursor-pointer select-none items-center gap-1.5 rounded-full border border-border-strong bg-raised px-3 text-sm has-[:checked]:border-accent has-[:checked]:bg-accent-soft">
                <input type="checkbox" className="h-4 w-4 accent-accent" checked={c.types.includes(t)} onChange={() => onChange({ ...c, types: c.types.includes(t) ? c.types.filter((x) => x !== t) : [...c.types, t] })} />
                {MESSAGE_TYPE_LABEL[t]}
              </label>
            ))}
          </div>
        </fieldset>
      );
    case "time_window":
      return (
        <div className="space-y-3">
          <FormField label="It is">
            <Select value={c.inside ? "inside" : "outside"} onChange={(e) => onChange({ ...c, inside: e.target.value === "inside" })}>
              <option value="outside">outside these hours (for example, when you are closed)</option>
              <option value="inside">inside these hours</option>
            </Select>
          </FormField>
          <DaysField value={c.days} onChange={(days) => onChange({ ...c, days })} />
          <div className="grid grid-cols-2 gap-3">
            <FormField label="From">
              <Input type="time" value={c.start} onChange={(e) => onChange({ ...c, start: e.target.value })} />
            </FormField>
            <FormField label="To">
              <Input type="time" value={c.end} onChange={(e) => onChange({ ...c, end: e.target.value })} />
            </FormField>
          </div>
          <FormField label="Timezone">
            <Select value={c.timezone} onChange={(e) => onChange({ ...c, timezone: e.target.value })}>
              {(zones.includes(c.timezone) ? zones : [c.timezone, ...zones]).map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </Select>
          </FormField>
        </div>
      );
    case "attribute":
      return (
        <div className="grid gap-3 sm:grid-cols-3">
          <FormField label="Contact detail" hint="For example city">
            <Input value={c.name} maxLength={LIMITS.attribute} onChange={(e) => onChange({ ...c, name: e.target.value })} />
          </FormField>
          <FormField label="Compare">
            <Select value={c.op} onChange={(e) => onChange({ ...c, op: e.target.value as typeof c.op })}>
              {Object.entries(ATTRIBUTE_OP_LABEL).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </FormField>
          {c.op !== "exists" && c.op !== "not_exists" && (
            <FormField label="Value">
              <Input value={c.value} maxLength={LIMITS.attributeValue} onChange={(e) => onChange({ ...c, value: e.target.value })} />
            </FormField>
          )}
        </div>
      );
    case "tag":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="The contact">
            <Select value={c.has ? "has" : "not"} onChange={(e) => onChange({ ...c, has: e.target.value === "has" })}>
              <option value="has">has the tag</option>
              <option value="not">does not have the tag</option>
            </Select>
          </FormField>
          <FormField label="Tag">
            <Input value={c.tag} maxLength={LIMITS.tag} onChange={(e) => onChange({ ...c, tag: e.target.value })} />
          </FormField>
        </div>
      );
    case "segment":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="The contact">
            <Select value={c.member ? "in" : "out"} onChange={(e) => onChange({ ...c, member: e.target.value === "in" })}>
              <option value="in">is in the segment</option>
              <option value="out">is not in the segment</option>
            </Select>
          </FormField>
          <FormField label="Segment" hint={ctx.options.segments.length === 0 ? "You have no segments yet." : undefined}>
            <Select value={c.segmentId} onChange={(e) => onChange({ ...c, segmentId: e.target.value })}>
              <option value="">Choose a segment</option>
              {ctx.options.segments.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </FormField>
        </div>
      );
    case "phone":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="The phone number">
            <Select value={c.op} onChange={(e) => onChange({ ...c, op: e.target.value as typeof c.op })}>
              <option value="starts_with">starts with</option>
              <option value="equals">is exactly</option>
              <option value="contains">contains</option>
            </Select>
          </FormField>
          <FormField label="Digits" hint="Use the country code, for example +91 for India.">
            <Input inputMode="tel" value={c.value} maxLength={20} onChange={(e) => onChange({ ...c, value: e.target.value })} />
          </FormField>
        </div>
      );
    case "assignment":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="The chat is">
            <Select value={c.state} onChange={(e) => onChange({ ...c, state: e.target.value as typeof c.state, userId: e.target.value === "user" ? c.userId : null })}>
              <option value="unassigned">not assigned to anyone</option>
              <option value="assigned">assigned to someone</option>
              <option value="user">assigned to a specific person</option>
            </Select>
          </FormField>
          {c.state === "user" && (
            <FormField label="Person">
              <Select value={c.userId ?? ""} onChange={(e) => onChange({ ...c, userId: e.target.value || null })}>
                <option value="">Choose a person</option>
                {ctx.options.members.map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.name}
                  </option>
                ))}
              </Select>
            </FormField>
          )}
        </div>
      );
  }
}

function ConditionRow({ condition, onChange, onRemove, ctx }: { condition: Condition; onChange: (c: Condition) => void; onRemove: () => void; ctx: Ctx }) {
  const choices = conditionsFor(ctx.trigger);
  const known = choices.some((c) => c.value === condition.type);
  return (
    <li className="rounded-card border border-border bg-surface p-3">
      <div className="flex flex-wrap items-end gap-3">
        <FormField label="Check" className="min-w-0 flex-1">
          <Select value={condition.type} onChange={(e) => onChange(defaultCondition(e.target.value as Condition["type"], ctx.timezone))}>
            {!known && <option value={condition.type}>Not available for this start</option>}
            {choices.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </Select>
        </FormField>
        <Button type="button" variant="ghost" size="sm" className="max-sm:min-h-10 text-bad-fg" aria-label="Remove this condition" onClick={onRemove}>
          Remove
        </Button>
      </div>
      <div className="mt-3">
        <ConditionFields c={condition} onChange={onChange} ctx={ctx} />
      </div>
    </li>
  );
}

type GroupProps = { group: Group; onChange: (g: Group) => void; onRemove?: () => void; depth: number; ctx: Ctx };

/** One AND / OR block of conditions. A block can hold other blocks, up to the model's depth limit. */
export function GroupEditor({ group, onChange, onRemove, depth, ctx }: GroupProps) {
  const setItem = (index: number, next: Condition | Group) => onChange({ ...group, items: group.items.map((it, i) => (i === index ? next : it)) });
  const removeItem = (index: number) => onChange({ ...group, items: group.items.filter((_, i) => i !== index) });
  const first = conditionsFor(ctx.trigger)[0].value;
  const nested = depth > 1;

  return (
    <div className={nested ? "space-y-3 rounded-card border border-dashed border-border-strong p-3" : "space-y-3"}>
      {(group.items.length > 1 || nested) && (
        <div className="flex flex-wrap items-center gap-3">
          <FormField label={nested ? "In this group" : "Continue when"} className="min-w-0 flex-1">
            <Select value={group.op} onChange={(e) => onChange({ ...group, op: e.target.value as "and" | "or" })}>
              <option value="and">all of these are true</option>
              <option value="or">any one of these is true</option>
            </Select>
          </FormField>
          {onRemove && (
            <Button type="button" variant="ghost" size="sm" className="max-sm:min-h-10 text-bad-fg" onClick={onRemove}>
              Remove group
            </Button>
          )}
        </div>
      )}
      {group.items.length === 0 ? (
        <p className="text-sm text-muted">{nested ? "This group is empty." : "No conditions: the rule runs every time it starts."}</p>
      ) : (
        <ul className="space-y-3">
          {group.items.map((item, i) =>
            item.type === "group" ? (
              <li key={i}>
                <GroupEditor group={item} depth={depth + 1} ctx={ctx} onChange={(g) => setItem(i, g)} onRemove={() => removeItem(i)} />
              </li>
            ) : (
              <ConditionRow key={i} condition={item} ctx={ctx} onChange={(c) => setItem(i, c)} onRemove={() => removeItem(i)} />
            ),
          )}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="secondary" size="sm" className="max-sm:min-h-10" onClick={() => onChange({ ...group, items: [...group.items, defaultCondition(first, ctx.timezone)] })}>
          Add a condition
        </Button>
        {depth < LIMITS.depth && (
          <Button type="button" variant="ghost" size="sm" className="max-sm:min-h-10" onClick={() => onChange({ ...group, items: [...group.items, { type: "group", op: "or", items: [defaultCondition(first, ctx.timezone)] }] })}>
            Add a group of either/or conditions
          </Button>
        )}
      </div>
    </div>
  );
}
