"use client";

import { useEffect, useId, useState, type FormEvent } from "react";
import { Alert, Badge, Button, Card, FormField, Input, Select, apiFetch, cn, toast, type Tone } from "@/components/ui";
import { CRD, formatMinor, minorToMajorString, parseMajorInput, type MoneyDTO } from "@/lib/spend/money";
import type { PotStatus, SpendCapabilities, SpendingAccountDTO, MetaOffboardChoice } from "@/lib/spend/types";
import type { PotView, SpendSummaryView } from "@/lib/spend/summary";

/*
 * One pot card of Settings > Spending limits (docs/SPEND-CONTROLS-SPEC.md 8.1): figures, limits and, by role, the inputs.
 * The owner edits both limits (and the currency while no ad account is connected); an admin may only lower a number that
 * exists (the input's max is the current value); a team member sees text only. "Not set" is shown as words, never as a 0.
 * Saving goes to PUT /api/spend/allowances, whose answer carries the fresh summary.
 */

export const NOT_SET = "Not set";

const STATUS: Record<PotStatus, { label: string; tone: Tone }> = {
  ok: { label: "Within limits", tone: "good" },
  near_limit: { label: "Near the limit", tone: "warn" },
  limit_reached: { label: "Limit used up", tone: "bad" },
  not_set: { label: NOT_SET, tone: "warn" },
  currency_mismatch: { label: "Check the currency", tone: "warn" },
  not_connected: { label: "Not connected", tone: "neutral" },
};

export function statusBadge(status: PotStatus): { label: string; tone: Tone } {
  return STATUS[status];
}

const credits = (m: MoneyDTO | null) => (m ? new Intl.NumberFormat("en-IN").format(BigInt(m.minor)) : null);
const shown = (m: MoneyDTO | null | undefined) => m?.formatted ?? NOT_SET;

/** The figure rows of a card, in the 8.1 wording. Pure. */
export function potRows(pot: PotView): { label: string; value: string }[] {
  if (pot.pot === "ads") {
    return [
      { label: "Spent this month", value: pot.month.spent.formatted },
      { label: "Set aside for running ads", value: pot.month.committed.formatted },
      { label: "Left to use", value: shown(pot.month.left) },
      { label: "Today", value: `${pot.today.spent.formatted} spent, up to ${pot.today.committed.formatted} set aside` },
    ];
  }
  if (pot.pot === "messaging") {
    return [
      { label: "Spent this month (estimate)", value: pot.month.spent.formatted },
      { label: "Set aside for broadcasts in progress", value: pot.month.held.formatted },
      { label: "Left", value: shown(pot.month.left) },
    ];
  }
  const used = BigInt(pot.month.spent.minor) + BigInt(pot.month.held.minor);
  const today = BigInt(pot.today.spent.minor) + BigInt(pot.today.held.minor);
  const limit = credits(pot.limits.effectiveMonthly);
  const n = new Intl.NumberFormat("en-IN");
  return [
    { label: "Used this month", value: limit ? `${n.format(used)} of ${limit} credits` : formatMinor(used, CRD) },
    { label: "Today", value: n.format(today) },
  ];
}

/** The owner's limit, and what applies now when a ceiling is lower ("₹2,000 applies for now"). */
export function limitLine(own: MoneyDTO | null, effective: MoneyDTO | null): string {
  if (!own) return effective ? `${NOT_SET} (${effective.formatted} applies for now)` : NOT_SET;
  if (effective && effective.minor !== own.minor && effective.currency === own.currency) return `${own.formatted} (${effective.formatted} applies for now)`;
  return own.formatted;
}

/** Minor units as the plain number a person types ("2000", "1500.5"). */
export function toMajorInput(m: MoneyDTO | null | undefined): string {
  if (!m) return "";
  return minorToMajorString(m.minor, m.currency).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

export type LimitFormError = { field: "monthly" | "daily" | "form"; message: string };

/** Checks the typed limits before they are sent (the server checks them again). Returns the body or the first problem. Pure. */
export function readLimitForm(
  input: { monthly: string; daily: string; currency: string },
  pot: Pick<PotView, "pot" | "limits" | "edit">,
  role: SpendCapabilities["role"],
): { ok: true; body: { pot: string; monthlyLimitMinor: string | null; dailyLimitMinor: string | null; currency?: string; version: number } } | { ok: false; error: LimitFormError } {
  const parse = (field: "monthly" | "daily", text: string): bigint | null | LimitFormError => {
    try {
      return parseMajorInput(text, input.currency);
    } catch (e) {
      return { field, message: (e as Error).message || "Enter an amount using numbers only." };
    }
  };
  const monthly = parse("monthly", input.monthly);
  if (monthly !== null && typeof monthly === "object") return { ok: false, error: monthly };
  const daily = parse("daily", input.daily);
  if (daily !== null && typeof daily === "object") return { ok: false, error: daily };
  if (role === "admin") {
    for (const [field, value, max] of [["monthly", monthly, pot.edit.maxMonthly], ["daily", daily, pot.edit.maxDaily]] as const) {
      if (max === null) {
        if (value !== null) return { ok: false, error: { field, message: "Only the owner can set a limit that is Not set." } };
        continue;
      }
      if (value === null) return { ok: false, error: { field, message: "Only the owner can clear a limit." } };
      // The same sentence the server answers with (403 spend.only_owner_raise), plus the most this person may enter.
      if (value > BigInt(max.minor)) return { ok: false, error: { field, message: `Only the owner can raise a limit. You can lower it. Enter ${max.formatted} or less.` } };
    }
  }
  if (monthly !== null && daily !== null && daily > monthly) return { ok: false, error: { field: "daily", message: "The daily limit can't be more than the monthly limit." } };
  const currencyChanged = input.currency !== (pot.limits.monthly?.currency ?? pot.limits.daily?.currency ?? input.currency);
  return {
    ok: true,
    body: {
      pot: pot.pot,
      monthlyLimitMinor: monthly === null ? null : monthly.toString(),
      dailyLimitMinor: daily === null ? null : daily.toString(),
      ...(currencyChanged ? { currency: input.currency } : {}),
      version: pot.limits.version,
    },
  };
}

/** Spent, set aside and left as one bar with a legend (8.1: a segmented bar). Text carries the meaning, not the colour. */
export function SegmentedBar({ pot }: { pot: PotView }) {
  const limit = pot.limits.effectiveMonthly;
  if (!limit || BigInt(limit.minor) <= 0n) return null;
  const total = BigInt(limit.minor);
  const pct = (m: MoneyDTO) => Math.min(100, Number((BigInt(m.minor) * 10_000n) / total) / 100);
  const spent = pct(pot.month.spent);
  const aside = Math.min(100 - spent, pct(pot.pot === "ads" ? pot.month.committed : pot.month.held));
  const asideLabel = pot.pot === "ads" ? "set aside" : "held";
  const label = `${pot.month.spent.formatted} spent, ${(pot.pot === "ads" ? pot.month.committed : pot.month.held).formatted} ${asideLabel}, ${shown(pot.month.left)} left of ${limit.formatted} this month`;
  return (
    <div className="mt-3">
      <div role="img" aria-label={label} className="flex h-2.5 w-full overflow-hidden rounded-full bg-surface-2">
        <div className="h-full bg-accent" style={{ width: `${spent}%` }} />
        <div className="h-full bg-warn" style={{ width: `${aside}%` }} />
      </div>
      <p className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted" aria-hidden>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-accent" />
          Spent
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-warn" />
          {pot.pot === "ads" ? "Set aside" : "Held"}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full border border-border-strong bg-surface-2" />
          Left
        </span>
      </p>
    </div>
  );
}

type Props = {
  pot: PotView;
  capabilities: SpendCapabilities;
  /** Ads card only: the spending ad account line and the owner's [Change]. */
  spendingAccount?: SpendingAccountDTO;
  /** The owner's SpendControl version, for choosing the spending ad account. */
  controlVersion?: number;
  onSaved: (summary?: SpendSummaryView) => void;
};

export function PotCard({ pot, capabilities, spendingAccount, controlVersion, onSaved }: Props) {
  const role = capabilities.role;
  const status = statusBadge(pot.status);
  const editable = pot.edit.editable && role !== "agent";
  const ownCurrency = pot.limits.monthly?.currency ?? pot.limits.daily?.currency ?? pot.currency;
  const [monthly, setMonthly] = useState(toMajorInput(pot.limits.monthly));
  const [daily, setDaily] = useState(toMajorInput(pot.limits.daily));
  const [currency, setCurrency] = useState(ownCurrency);
  const [error, setError] = useState<LimitFormError | null>(null);
  const [status2, setStatus2] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [stale, setStale] = useState(false);
  const statusId = useId();
  const headingId = `pot-${pot.pot}`;

  // A save (or a reload) brings a new stored version: show the stored values again, keeping the status line on screen.
  useEffect(() => {
    setMonthly(toMajorInput(pot.limits.monthly));
    setDaily(toMajorInput(pot.limits.daily));
    setCurrency(ownCurrency);
    setStale(false);
  }, [pot.limits.version, pot.limits.monthly?.minor, pot.limits.daily?.minor, ownCurrency]);

  async function save(e: FormEvent) {
    e.preventDefault();
    const read = readLimitForm({ monthly, daily, currency }, pot, role);
    if (!read.ok) {
      setError(read.error);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const res = await apiFetch<{ summary?: SpendSummaryView }>("/api/spend/allowances", { method: "PUT", body: read.body });
      const m = read.body.monthlyLimitMinor ? formatMinor(read.body.monthlyLimitMinor, currency) : NOT_SET;
      const d = read.body.dailyLimitMinor ? formatMinor(read.body.dailyLimitMinor, currency) : NOT_SET;
      const text = `Saved. Monthly limit ${m}, daily limit ${d}.`;
      setStatus2(text);
      toast.success(text);
      onSaved(res.summary);
    } catch (err) {
      const body = (err as { body?: { code?: string } }).body;
      setStale(body?.code === "spend.version");
      setError({ field: "form", message: (err as Error).message });
    } finally {
      setSaving(false);
    }
  }

  const fieldError = (f: "monthly" | "daily") => (error?.field === f ? error.message : null);
  const adminHint = role === "admin" ? "You can lower this. Only the owner can raise it." : undefined;
  // Money fields are text inputs (inputMode decimal): a number input drops "20,000" in Firefox and Safari, which would read
  // as Not set. parseMajorInput takes "₹20,000" and "1,02,340"; the server checks every amount again.

  return (
    <Card
      id={pot.pot === "ads" ? "ads" : pot.pot === "messaging" ? "whatsapp" : "ai"}
      aria-labelledby={headingId}
      title={<span id={headingId}>{pot.title}</span>}
      actions={
        <div className="flex flex-wrap gap-1.5">
          {pot.sampleData && <Badge tone="info">Sample data</Badge>}
          <Badge tone={status.tone} dot>
            {status.label}
          </Badge>
        </div>
      }
    >
      <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
        {potRows(pot).map((r) => (
          <div key={r.label} className="contents">
            <dt className="text-muted">{r.label}</dt>
            <dd className="font-medium tabular-nums">{r.value}</dd>
          </div>
        ))}
        <dt className="text-muted">Monthly limit</dt>
        <dd className="font-medium tabular-nums">{limitLine(pot.limits.monthly, pot.limits.effectiveMonthly)}</dd>
        <dt className="text-muted">Daily limit</dt>
        <dd className="font-medium tabular-nums">{limitLine(pot.limits.daily, pot.limits.effectiveDaily)}</dd>
      </dl>
      <SegmentedBar pot={pot} />

      {pot.notes.length > 0 && (
        <ul className="mt-4 space-y-1.5 text-sm">
          {pot.notes.map((n) => (
            <li key={n} className={cn(n.startsWith(NOT_SET) ? "font-medium text-warn-fg" : "text-foreground")}>
              {n}
            </li>
          ))}
        </ul>
      )}

      {pot.pot === "ads" && spendingAccount && <SpendingAccountLine account={spendingAccount} capabilities={capabilities} controlVersion={controlVersion} onSaved={onSaved} />}

      {editable ? (
        <form className="mt-4 grid gap-3 sm:grid-cols-2" onSubmit={save} noValidate aria-describedby={statusId}>
          <FormField label="Monthly limit" hint={adminHint} error={fieldError("monthly")}>
            <Input type="text" inputMode="decimal" value={monthly} onChange={(e) => setMonthly(e.target.value)} placeholder={NOT_SET} autoComplete="off" />
          </FormField>
          <FormField label="Daily limit" hint={adminHint} error={fieldError("daily")}>
            <Input type="text" inputMode="decimal" value={daily} onChange={(e) => setDaily(e.target.value)} placeholder={NOT_SET} autoComplete="off" />
          </FormField>
          {pot.edit.canChangeCurrency && pot.edit.currencyOptions.length > 1 && (
            <FormField label="Currency" hint={pot.pot === "ads" ? "Use the currency of the ad account you will connect." : undefined}>
              <Select value={currency} onChange={(e) => setCurrency(e.target.value)}>
                {pot.edit.currencyOptions.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            </FormField>
          )}
          <div className="flex flex-wrap items-end gap-2 sm:col-span-2">
            <Button type="submit" loading={saving} className="w-full sm:w-auto">
              {role === "owner" ? "Save limits" : "Lower limits"}
            </Button>
            {role === "owner" && <p className="text-xs text-muted">Leave a box empty for {NOT_SET}.</p>}
          </div>
        </form>
      ) : (
        role !== "owner" && (
          <p className="mt-4 text-xs text-muted">{role === "admin" ? "Only the owner can set a limit that is Not set." : "Only the owner can change spending limits."}</p>
        )
      )}

      <div id={statusId} aria-live="polite" className="mt-3 text-sm">
        {error?.field === "form" ? (
          <Alert tone="bad" action={stale ? <Button size="sm" variant="secondary" onClick={() => onSaved()}>Reload</Button> : undefined}>
            {error.message}
          </Alert>
        ) : (
          status2 && <span className="text-good-fg">{status2}</span>
        )}
      </div>

      {pot.help.length > 0 && (
        <div className="mt-4 space-y-1.5 border-t border-border pt-3 text-xs text-muted">
          {pot.help.map((h) => (
            <p key={h}>{h}</p>
          ))}
        </div>
      )}
    </Card>
  );
}

const CHOICE_LABEL: Record<MetaOffboardChoice, string> = {
  keep: "Keep the current limit on Meta",
  restore: "Put back my old limit",
  remove: "Remove the limit",
};

/** "Spending ad account: Edwyz Store (INR)", with the owner's [Change] or [Choose] (8.1). */
function SpendingAccountLine({ account, capabilities, controlVersion, onSaved }: { account: SpendingAccountDTO; capabilities: SpendCapabilities; controlVersion?: number; onSaved: (s?: SpendSummaryView) => void }) {
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState(account.chosen?.assetId ?? account.accounts[0]?.assetId ?? "");
  const [offboard, setOffboard] = useState<MetaOffboardChoice | null>(null);
  const [askOffboard, setAskOffboard] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const owner = capabilities.canChooseSpendingAccount;
  if (account.accounts.length === 0) return null;
  const chosen = account.chosen;
  const label = chosen ? `${chosen.name ?? chosen.externalId}${chosen.currency ? ` (${chosen.currency})` : ""}` : null;

  async function save() {
    setSaving(true);
    setMessage(null);
    try {
      await apiFetch("/api/spend/control", { method: "PUT", body: { version: controlVersion ?? 0, spendingAdAccountAssetId: choice, ...(offboard ? { offboardChoice: offboard } : {}) } });
      toast.success("Spending ad account saved.");
      setOpen(false);
      onSaved();
    } catch (err) {
      if ((err as Error).message.startsWith("Choose what happens to Meta's spending limit")) setAskOffboard(true);
      setMessage((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-4 rounded-control border border-border p-3 text-sm">
      <p>
        {label ? (
          <>
            Spending ad account: <strong>{label}</strong>
          </>
        ) : (
          "No spending ad account chosen yet."
        )}
      </p>
      {owner && !open && (
        <Button size="sm" variant="secondary" className="mt-2" onClick={() => setOpen(true)}>
          {chosen ? "Change" : "Choose"}
        </Button>
      )}
      {owner && open && (
        <div className="mt-3 grid gap-3">
          <FormField label="Ad account Edwyz can spend from">
            <Select value={choice} onChange={(e) => setChoice(e.target.value)}>
              {account.accounts.map((a) => (
                <option key={a.assetId} value={a.assetId}>
                  {(a.name ?? a.externalId) + (a.currency ? ` (${a.currency})` : "")}
                </option>
              ))}
            </Select>
          </FormField>
          {askOffboard && (
            <fieldset className="grid gap-2">
              <legend className="text-sm font-medium">Meta&apos;s spending limit on your current ad account</legend>
              {(["keep", "restore", "remove"] as const).map((c) => (
                <label key={c} className="flex min-h-10 items-center gap-2">
                  <input type="radio" name="offboard" value={c} checked={offboard === c} onChange={() => setOffboard(c)} />
                  {CHOICE_LABEL[c]}
                </label>
              ))}
            </fieldset>
          )}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" loading={saving} onClick={() => void save()} disabled={askOffboard && !offboard}>
              Save ad account
            </Button>
          </div>
        </div>
      )}
      <div aria-live="polite">{message && <p className="mt-2 text-sm text-bad-fg">{message}</p>}</div>
    </div>
  );
}
