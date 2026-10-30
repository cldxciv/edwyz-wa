"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { Alert, Button, Card, FormField, Input, apiFetch, confirm, toast } from "@/components/ui";

/** SERVICE (free-form messages) is optional in the form so older saved cards load without it. */
export type RateRowForm = { country: string; MARKETING: string; UTILITY: string; AUTHENTICATION: string; SERVICE?: string };
/** scale 2: every rate carries 2 extra decimals (1150 means 11.5 paise). Missing means 0, whole units. */
export type RateCardForm = { currency: string; note: string; rows: RateRowForm[]; scale?: 0 | 2 };

const CATEGORIES = ["MARKETING", "UTILITY", "AUTHENTICATION", "SERVICE"] as const;
type Category = (typeof CATEGORIES)[number];
const LABEL: Record<Category, string> = { MARKETING: "Marketing", UTILITY: "Utility", AUTHENTICATION: "Authentication", SERVICE: "Service (free-form)" };
const blankRow = (): RateRowForm => ({ country: "", MARKETING: "", UTILITY: "", AUTHENTICATION: "", SERVICE: "" });
const cell = (row: RateRowForm, c: Category): string => row[c] ?? "";

/** Rows to the API shape: country code to a rate per category in whole units of the card's scale. Empty cells are left out. */
export function formToBody(form: RateCardForm) {
  const rates: Record<string, Record<string, string>> = {};
  for (const row of form.rows) {
    const country = row.country.trim().toUpperCase();
    if (!country) continue;
    const entry: Record<string, string> = {};
    for (const c of CATEGORIES) if (cell(row, c).trim() !== "") entry[c] = cell(row, c).trim();
    rates[country] = entry;
  }
  return { currency: form.currency.trim().toUpperCase(), note: form.note, rates, ...(form.scale === 2 ? { scale: 2 } : {}) };
}

/** True when no row has a service price: estimates then use the utility price. */
export function serviceMissing(form: RateCardForm): boolean {
  return !form.rows.some((r) => r.country.trim() !== "" && cell(r, "SERVICE").trim() !== "");
}

/**
 * Switches the form between whole units and 2 extra decimals without changing any price: turning extra decimals on multiplies
 * every rate by 100. Turning them off divides by 100, and is refused (null) while a rate would lose its decimals.
 */
export function rescaleForm(form: RateCardForm, scale: 0 | 2): RateCardForm | null {
  const from = form.scale === 2 ? 2 : 0;
  if (from === scale) return form;
  const convert = (value: string): string | null => {
    const v = value.trim();
    if (v === "" || !/^\d+$/.test(v)) return value;
    const n = BigInt(v);
    if (scale === 2) return (n * 100n).toString();
    return n % 100n === 0n ? (n / 100n).toString() : null;
  };
  const rows: RateRowForm[] = [];
  for (const row of form.rows) {
    const next: RateRowForm = { ...row };
    for (const c of CATEGORIES) {
      const out = convert(cell(row, c));
      if (out === null) return null;
      next[c] = out;
    }
    rows.push(next);
  }
  return { ...form, rows, scale };
}

export function RateCardEditor({ initial, configured }: { initial: RateCardForm; configured: boolean }) {
  const router = useRouter();
  const scaleId = useId();
  const [form, setForm] = useState<RateCardForm>(initial.rows.length ? initial : { ...initial, rows: [{ ...blankRow(), country: "*" }] });
  const [busy, setBusy] = useState<"save" | "clear" | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const extraDecimals = form.scale === 2;
  const unit = extraDecimals ? "hundredths of the smallest unit, like 1150 for 11.5 paise" : "whole numbers of the smallest unit, like 78 for 78 paise";

  const setRow = (i: number, patch: Partial<RateRowForm>) => setForm((f) => ({ ...f, rows: f.rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)) }));

  function toggleScale(on: boolean) {
    const next = rescaleForm(form, on ? 2 : 0);
    if (!next) {
      setFailure("Some rates use the extra decimals. Round them to whole units (end in 00) before turning extra decimals off.");
      return;
    }
    setFailure(null);
    setForm(next);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy("save");
    setFailure(null);
    try {
      await apiFetch("/api/admin/ratecard", { method: "PUT", body: formToBody(form) });
      toast.success("Rate card saved. New estimates use it from now on.");
      router.refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Something went wrong.";
      setFailure(message);
      toast.error(`We could not save the rate card. ${message}`);
    } finally {
      setBusy(null);
    }
  }

  async function clear() {
    const ok = await confirm({
      title: "Clear the rate card?",
      body: "Cost estimates will say they are not available until you enter a new rate card.",
      confirmLabel: "Clear rate card",
      tone: "danger",
    });
    if (!ok) return;
    setBusy("clear");
    try {
      await apiFetch("/api/admin/ratecard", { method: "DELETE" });
      toast.success("Rate card cleared");
      setForm({ currency: form.currency, note: "", rows: [{ ...blankRow(), country: "*" }], scale: form.scale });
      router.refresh();
    } catch (err) {
      toast.error(`We could not clear the rate card. ${err instanceof Error ? err.message : ""}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-6">
      <Card title="Currency" description="Meta bills in one currency per account. WhatsApp limits use this currency, so it can't change while workspaces have limits in it.">
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Currency code" required hint="Three letters, for example INR.">
            <Input value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })} maxLength={3} autoCapitalize="characters" required />
          </FormField>
          <FormField label="Note" optional hint="Only admins see this. For example the date Meta's price list took effect.">
            <Input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} maxLength={500} />
          </FormField>
          <label htmlFor={scaleId} className="flex min-h-10 items-center gap-3 text-sm sm:col-span-2">
            <input id={scaleId} type="checkbox" checked={extraDecimals} onChange={(e) => toggleScale(e.target.checked)} className="h-5 w-5 accent-(--accent)" />
            <span>
              <span className="font-medium">Rates use 2 extra decimals</span>
              <span className="block text-xs text-muted">Turn on for prices like 11.5 paise: enter 1150. Prices already entered are converted, so nothing changes.</span>
            </span>
          </label>
        </div>
      </Card>

      <Card
        title="Price per message"
        description={`Copy the numbers from Meta's current WhatsApp pricing page. Use * for every country without its own row. Enter ${unit}. Service is the price of a free-form reply inside the 24-hour window.`}
        actions={
          <Button type="button" size="sm" variant="secondary" onClick={() => setForm({ ...form, rows: [...form.rows, blankRow()] })}>
            Add a country
          </Button>
        }
      >
        {serviceMissing(form) && (
          <Alert tone="warn" className="mb-4">
            No service price yet, so free-form replies are estimated at the utility price. Enter Meta&apos;s service price (it is often 0) to fix that.
          </Alert>
        )}
        <ul className="space-y-3">
          {form.rows.map((row, i) => (
            <li key={i} className="rounded-control border border-border bg-surface p-3">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-[7rem_repeat(4,minmax(0,1fr))_auto] lg:items-end">
                <FormField label="Country" hint="Two letters, or *">
                  <Input value={row.country} onChange={(e) => setRow(i, { country: e.target.value.toUpperCase() })} maxLength={2} autoCapitalize="characters" aria-label={`Country code for row ${i + 1}`} />
                </FormField>
                {CATEGORIES.map((c) => (
                  <FormField key={c} label={LABEL[c]}>
                    <Input value={cell(row, c)} onChange={(e) => setRow(i, { [c]: e.target.value.replace(/[^\d]/g, "") })} inputMode="numeric" aria-label={`${LABEL[c]} price for row ${i + 1}`} />
                  </FormField>
                ))}
                <Button type="button" size="sm" variant="ghost" className="max-sm:min-h-10 self-end" onClick={() => setForm({ ...form, rows: form.rows.filter((_, idx) => idx !== i) })} aria-label={`Remove row ${i + 1}`}>
                  Remove
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </Card>

      <div aria-live="polite">{failure && <Alert tone="bad">{failure}</Alert>}</div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" loading={busy === "save"} disabled={busy !== null}>
          Save rate card
        </Button>
        {configured && (
          <Button type="button" variant="secondary" loading={busy === "clear"} disabled={busy !== null} onClick={() => void clear()}>
            Clear rate card
          </Button>
        )}
      </div>
    </form>
  );
}
