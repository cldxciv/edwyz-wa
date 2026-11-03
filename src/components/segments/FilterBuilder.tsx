"use client";

import { useId, useState } from "react";
import { Button, Input, Select, cn } from "@/components/ui";
import { isAttributeField, attributeKey, attributeField, kindOf } from "@/lib/segments/filter";
import {
  type Draft,
  MAX_CONDITIONS,
  OP_LABELS,
  OTHER_ATTRIBUTE,
  blankRule,
  changeField,
  changeOp,
  countryOptions,
  fieldOptions,
  needsValue,
  opsFor,
  ruleProblem,
  selectValueFor,
} from "./helpers";

type Props = {
  value: Draft;
  onChange: (next: Draft) => void;
  attributeKeys: readonly string[];
  tags: readonly string[];
  /** Show every rule's red "fill in" message (after the person tried to continue). Without it a rule shows its message once the person leaves its value. */
  showProblems?: boolean;
  idPrefix?: string;
};

const selectClass = "min-w-0";

/**
 * A stack of plain-language rules ("Tag is tagged vip", "Last message from them in the last (days) 30"). The person chooses whether
 * contacts must match all of the rules or any of them. Works at 360 px: each rule becomes a small card. The columns follow the
 * width of the builder, not the window, so a rule inside a dialog gets two rows instead of four cramped selects.
 */
export function FilterBuilder({ value, onChange, attributeKeys, tags, showProblems, idPrefix }: Props) {
  const auto = useId();
  const prefix = idPrefix ?? auto;
  const groups = fieldOptions(attributeKeys).reduce<Record<string, ReturnType<typeof fieldOptions>>>((acc, o) => ((acc[o.group] ??= []).push(o), acc), {});
  const setRule = (i: number, next: Draft["rules"][number]) => onChange({ ...value, rules: value.rules.map((r, idx) => (idx === i ? next : r)) });
  // Rules whose value the person has left, so a new, empty rule is not red before they have typed anything.
  const [left, setLeft] = useState<ReadonlySet<number>>(new Set());
  const leave = (i: number) => setLeft((prev) => (prev.has(i) ? prev : new Set(prev).add(i)));

  return (
    <div className="space-y-3">
      {value.rules.length > 1 && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <label htmlFor={`${prefix}-match`} className="font-medium">
            People must match
          </label>
          <Select id={`${prefix}-match`} value={value.match} onChange={(e) => onChange({ ...value, match: e.target.value as Draft["match"] })} className="w-auto">
            <option value="all">all of the rules</option>
            <option value="any">any of the rules</option>
          </Select>
        </div>
      )}

      <ul className="@container space-y-3">
        {value.rules.map((rule, i) => {
          const kind = kindOf(rule.field);
          const problem = showProblems || left.has(i) ? ruleProblem(rule) : null;
          const selected = selectValueFor(rule.field, attributeKeys);
          const id = `${prefix}-r${i}`;
          return (
            <li key={i} className="rounded-control border border-border bg-surface p-3">
              <div className="grid gap-2 @md:grid-cols-2 @md:items-end @3xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.2fr)_auto]">
                <div className={selectClass}>
                  <label htmlFor={`${id}-field`} className="mb-1 block text-xs font-medium text-muted">
                    Rule {i + 1}: about
                  </label>
                  <Select id={`${id}-field`} value={selected} onChange={(e) => setRule(i, changeField(rule, e.target.value))}>
                    {Object.entries(groups).map(([group, options]) => (
                      <optgroup key={group} label={group}>
                        {options.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </Select>
                </div>
                <div className={selectClass}>
                  <label htmlFor={`${id}-op`} className="mb-1 block text-xs font-medium text-muted">
                    Test
                  </label>
                  <Select id={`${id}-op`} value={rule.op} onChange={(e) => setRule(i, changeOp(rule, e.target.value as typeof rule.op))}>
                    {opsFor(rule.field).map((op) => (
                      <option key={op} value={op}>
                        {OP_LABELS[op]}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="min-w-0">
                  {needsValue(rule.op) ? (
                    <>
                      <label htmlFor={`${id}-value`} className="mb-1 block text-xs font-medium text-muted">
                        Value
                      </label>
                      <ValueInput id={`${id}-value`} rule={rule} tags={tags} invalid={!!problem} onChange={(next) => setRule(i, next)} onBlur={() => leave(i)} />
                    </>
                  ) : (
                    <p className="pb-2 text-sm text-muted">No value needed.</p>
                  )}
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="max-sm:min-h-10 @md:mb-0.5 @md:justify-self-end @3xl:justify-self-auto"
                  aria-label={`Remove rule ${i + 1}`}
                  disabled={value.rules.length === 1 && !value.rules[0].value}
                  onClick={() => {
                    // Positions shift after a removal, so the "left" marks move with the rules that stay.
                    setLeft((prev) => new Set([...prev].filter((n) => n !== i).map((n) => (n > i ? n - 1 : n))));
                    onChange({ ...value, rules: value.rules.length === 1 ? [blankRule()] : value.rules.filter((_, idx) => idx !== i) });
                  }}
                >
                  Remove
                </Button>
              </div>
              {selected === OTHER_ATTRIBUTE && (
                <div className="mt-2 sm:max-w-xs">
                  <label htmlFor={`${id}-key`} className="mb-1 block text-xs font-medium text-muted">
                    Attribute name
                  </label>
                  <Input
                    id={`${id}-key`}
                    value={isAttributeField(rule.field) ? attributeKey(rule.field) : ""}
                    onChange={(e) => setRule(i, { ...rule, field: attributeField(e.target.value.trim().slice(0, 60)) })}
                    placeholder="for example city"
                    maxLength={60}
                    autoComplete="off"
                  />
                </div>
              )}
              {kind === "attribute" && selected !== OTHER_ATTRIBUTE && rule.op === "is" && <p className="mt-1 text-xs text-muted">Matching ignores capital letters.</p>}
              {problem && (
                <p role="alert" className={cn("mt-2 text-sm text-bad-fg")}>
                  {problem}
                </p>
              )}
            </li>
          );
        })}
      </ul>

      <Button type="button" variant="secondary" size="sm" className="max-sm:min-h-10" disabled={value.rules.length >= MAX_CONDITIONS} onClick={() => onChange({ ...value, rules: [...value.rules, blankRule()] })}>
        Add another rule
      </Button>
    </div>
  );
}

function ValueInput({ id, rule, tags, invalid, onChange, onBlur }: { id: string; rule: Draft["rules"][number]; tags: readonly string[]; invalid: boolean; onChange: (r: Draft["rules"][number]) => void; onBlur: () => void }) {
  const kind = kindOf(rule.field);
  const set = (value: string) => onChange({ ...rule, value });
  const value = rule.value ?? "";
  if (kind === "country") {
    return (
      <Select id={id} value={value} aria-invalid={invalid || undefined} onChange={(e) => set(e.target.value)} onBlur={onBlur}>
        <option value="">Choose a country</option>
        {countryOptions().map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
    );
  }
  if (rule.op === "within_days" || rule.op === "older_than_days") {
    return <Input id={id} type="number" inputMode="numeric" min={1} max={3650} value={value} aria-invalid={invalid || undefined} onChange={(e) => set(e.target.value)} onBlur={onBlur} placeholder="30" />;
  }
  if (rule.op === "before" || rule.op === "after") return <Input id={id} type="date" value={value} aria-invalid={invalid || undefined} onChange={(e) => set(e.target.value)} onBlur={onBlur} />;
  if (rule.op === "greater_than" || rule.op === "less_than") return <Input id={id} type="number" inputMode="decimal" value={value} aria-invalid={invalid || undefined} onChange={(e) => set(e.target.value)} onBlur={onBlur} />;
  if (kind === "tag") {
    const list = `${id}-tags`;
    return (
      <>
        <Input id={id} value={value} list={list} aria-invalid={invalid || undefined} onChange={(e) => set(e.target.value)} onBlur={onBlur} maxLength={60} autoComplete="off" placeholder="for example vip" />
        <datalist id={list}>
          {tags.map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
      </>
    );
  }
  return <Input id={id} value={value} aria-invalid={invalid || undefined} onChange={(e) => set(e.target.value)} onBlur={onBlur} maxLength={200} autoComplete="off" />;
}
