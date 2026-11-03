"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Alert, Badge, Button, Card, FormField, Input, Select, apiFetch, cn, toast } from "@/components/ui";
import { parseMajorInput, type MoneyDTO } from "@/lib/spend/money";
import type { AssistantDTO, AutonomyLevel, SpendCapabilities } from "@/lib/spend/types";
import { NOT_SET, toMajorInput } from "./PotCard";

/*
 * The assistants and their levels (docs/SPEND-CONTROLS-SPEC.md 8.1, 7.1, 7.2, 7.5). A row per assistant: its level with the
 * three 8.1 texts, the learning badge and what it would have done, its target cost per lead and the most it may spend.
 * The owner raises; an admin only lowers (a lower level, a smaller number); a team member reads. While
 * ASSISTANT_SPEND_ENABLED is false every assistant only makes suggestions, and the card says so. Saves go to
 * PUT /api/spend/mandates.
 */

export const ASSISTANTS_TITLE = "Assistants";
export const ASSISTANTS_DESCRIPTION = "Assistants watch your ads and messages and suggest changes. You decide how much they may do on their own.";
export const SUGGEST_ONLY_FOR_NOW = "Assistants only make suggestions for now.";
export const ASSISTANT_ON_LABEL = "Assistant on";
export const ASSISTANT_ON_HINT = "Off, it makes no changes of its own. Turning it on the first time starts its 14-day learning period, when it only suggests.";
export const COMING_LATER_TEXT = "Not available yet. Its settings will show here when it's ready.";

/**
 * What a save sends for `enabled`: only a change made with the on/off switch, never a side effect of saving other settings
 * (saving a target cost must not switch an assistant on and start its one-time learning period). Pure.
 */
export function enabledPatch(stored: boolean, chosen: boolean): { enabled: boolean } | Record<string, never> {
  return stored === chosen ? {} : { enabled: chosen };
}

/** "Suggest only: it suggests changes. Nothing happens until someone approves." */
export function levelSentence(a: AssistantDTO, level: number): string {
  const o = a.levelOptions.find((x) => x.level === level) ?? a.levelOptions[0];
  return o ? `${o.label}: ${o.description[0].toLowerCase()}${o.description.slice(1)}` : "";
}

type Props = { assistants: AssistantDTO[]; assistantSpendEnabled: boolean; capabilities: SpendCapabilities; currency: string; onChanged: () => void };

export function AssistantsCard({ assistants, assistantSpendEnabled, capabilities, currency, onChanged }: Props) {
  return (
    <Card id="assistants" title={ASSISTANTS_TITLE} description={ASSISTANTS_DESCRIPTION}>
      {!assistantSpendEnabled && (
        <Alert tone="info" className="mb-4">
          {SUGGEST_ONLY_FOR_NOW}
        </Alert>
      )}
      <ul className="space-y-4">
        {assistants.map((a) => (
          <li key={a.assistantKey} className="rounded-control border border-border p-4">
            <AssistantRow assistant={a} capabilities={capabilities} currency={currency} onChanged={onChanged} />
          </li>
        ))}
      </ul>
    </Card>
  );
}

function AssistantRow({ assistant: a, capabilities, currency, onChanged }: { assistant: AssistantDTO; capabilities: SpendCapabilities; currency: string; onChanged: () => void }) {
  const m = a.mandate;
  const cur = m?.currency ?? currency;
  const configured = (m?.level ?? 0) as AutonomyLevel;
  const owner = capabilities.canRaiseAssistants;
  // A planned assistant does not exist yet, so nothing it is given would do anything: no form, no switch (registry phase).
  const planned = a.phase === "planned";
  const canEdit = !planned && (owner || (capabilities.canLowerAssistants && !!m));
  const [level, setLevel] = useState<number>(configured);
  const [target, setTarget] = useState(toMajorInput(m?.targetCostPerLead));
  const [daily, setDaily] = useState(toMajorInput(m?.maxDaily));
  const [monthly, setMonthly] = useState(toMajorInput(m?.maxMonthly));
  const storedOn = m?.enabled === true;
  const [on, setOn] = useState(storedOn);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState("");
  const [saving, setSaving] = useState(false);
  const levels = owner ? a.levelOptions : a.levelOptions.filter((o) => o.level <= configured);

  // A new stored version (after a save or a reload): show what is stored, keeping the status line.
  useEffect(() => {
    setLevel(configured);
    setTarget(toMajorInput(m?.targetCostPerLead));
    setDaily(toMajorInput(m?.maxDaily));
    setMonthly(toMajorInput(m?.maxMonthly));
    setOn(m?.enabled === true);
  }, [m?.version, configured, m?.enabled]);

  /**
   * The most the assistant may spend. Empty means "no own ceiling" (only your limits apply), which is MORE room than any
   * number, so an admin may set a number or lower one, but not clear it or raise it (7.2, 8.1).
   */
  function ceiling(text: string, current: MoneyDTO | null, label: string): bigint | null {
    const v = parseMajorInput(text, cur);
    if (!owner && current !== null && (v === null || v > BigInt(current.minor))) {
      throw new RangeError(`Only the owner can raise an assistant's limits. Enter ${current.formatted} or less for ${label}.`);
    }
    return v;
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    let body: Record<string, unknown>;
    try {
      const d = ceiling(daily, m?.maxDaily ?? null, "the daily amount");
      const mo = ceiling(monthly, m?.maxMonthly ?? null, "the monthly amount");
      if (d !== null && mo !== null && d > mo) throw new RangeError("The daily amount can't be more than the monthly amount.");
      // The target cost per lead is the owner's setting; an admin's form shows it as text and never sends it.
      const t = owner ? parseMajorInput(target, cur) : undefined;
      body = {
        assistantKey: a.assistantKey,
        level,
        ...(t !== undefined ? { targetCostPerLeadMinor: t === null ? null : t.toString() } : {}),
        maxDailyMinor: d === null ? null : d.toString(),
        maxMonthlyMinor: mo === null ? null : mo.toString(),
        version: m?.version ?? 0,
        // The owner switches it on or off; an admin may only switch it off (a lowering).
        ...(owner || !on ? enabledPatch(storedOn, on) : {}),
      };
    } catch (err) {
      setError((err as Error).message);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await apiFetch("/api/spend/mandates", { method: "PUT", body });
      const text = `Saved the ${a.label}'s settings.`;
      setDone(text);
      toast.success(text);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={`${a.assistantKey}-name`} className="text-sm font-semibold">
          {a.label}
        </h3>
        {a.shadow.learning && (
          <Badge tone="info" dot>
            Learning
          </Badge>
        )}
        {planned && <Badge tone="neutral">Coming later</Badge>}
        {!planned && !m && <Badge tone="neutral">Suggestions only</Badge>}
      </div>
      {a.shadow.text && <p className="mt-1 text-sm text-muted">{a.shadow.text}</p>}

      {planned ? (
        <p className="mt-1 text-sm text-muted">{COMING_LATER_TEXT}</p>
      ) : canEdit ? (
        <form className="mt-3 grid gap-3 sm:grid-cols-2" onSubmit={save} noValidate>
          <div className="flex flex-wrap items-start justify-between gap-3 sm:col-span-2">
            <div className="min-w-0 flex-1">
              <span id={`${a.assistantKey}-on`} className="text-sm font-medium">
                {ASSISTANT_ON_LABEL}
              </span>
              <p id={`${a.assistantKey}-on-hint`} className="text-xs text-muted">
                {ASSISTANT_ON_HINT}
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={on}
              aria-labelledby={`${a.assistantKey}-name ${a.assistantKey}-on`}
              aria-describedby={`${a.assistantKey}-on-hint`}
              disabled={!owner && !on}
              onClick={() => setOn((v) => !v)}
              className={cn("inline-flex h-7 w-12 shrink-0 items-center rounded-full border border-border-strong p-0.5 transition-colors duration-(--dur-fast) disabled:opacity-50", on ? "bg-accent" : "bg-surface-2")}
            >
              <span aria-hidden className={cn("h-5 w-5 rounded-full bg-raised shadow-raised transition-transform duration-(--dur-fast)", on ? "translate-x-5" : "translate-x-0")} />
            </button>
          </div>
          <FormField label="Level" hint={levelSentence(a, level)} className="sm:col-span-2">
            <Select value={String(level)} onChange={(e) => setLevel(Number(e.target.value))}>
              {levels.map((o) => (
                <option key={o.level} value={o.level}>
                  {o.label}
                </option>
              ))}
            </Select>
          </FormField>
          {owner ? (
            <FormField label="Target cost per lead" hint={`In ${cur}. Leave empty for ${NOT_SET}.`}>
              <Input type="text" inputMode="decimal" autoComplete="off" value={target} onChange={(e) => setTarget(e.target.value)} placeholder={NOT_SET} />
            </FormField>
          ) : (
            <p className="self-end text-sm">
              <span className="text-muted">Target cost per lead: </span>
              {m?.targetCostPerLead?.formatted ?? NOT_SET}
            </p>
          )}
          <FormField label="Most it can spend per day" hint={`Leave empty for no own limit: only your limits apply.`}>
            <Input type="text" inputMode="decimal" autoComplete="off" value={daily} onChange={(e) => setDaily(e.target.value)} placeholder={NOT_SET} />
          </FormField>
          <FormField label="Most it can spend per month">
            <Input type="text" inputMode="decimal" autoComplete="off" value={monthly} onChange={(e) => setMonthly(e.target.value)} placeholder={NOT_SET} />
          </FormField>
          <div className="flex items-end sm:col-span-2">
            <Button type="submit" variant="secondary" loading={saving} className="w-full sm:w-auto">
              {owner ? "Save assistant" : "Lower assistant"}
            </Button>
          </div>
        </form>
      ) : (
        <dl className="mt-3 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
          <dt className="text-muted">{ASSISTANT_ON_LABEL}</dt>
          <dd>{storedOn ? "On" : "Off"}</dd>
          <dt className="text-muted">Level</dt>
          <dd>{levelSentence(a, configured)}</dd>
          <dt className="text-muted">Target cost per lead</dt>
          <dd>{m?.targetCostPerLead?.formatted ?? NOT_SET}</dd>
          <dt className="text-muted">Most it can spend per day</dt>
          <dd>{m?.maxDaily?.formatted ?? NOT_SET}</dd>
          <dt className="text-muted">Most it can spend per month</dt>
          <dd>{m?.maxMonthly?.formatted ?? NOT_SET}</dd>
        </dl>
      )}
      <div aria-live="polite" className="mt-2 text-sm">
        {error ? <p className="text-bad-fg">{error}</p> : done && <p className="text-good-fg">{done}</p>}
      </div>
    </div>
  );
}
