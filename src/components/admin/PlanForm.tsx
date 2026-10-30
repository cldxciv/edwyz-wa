"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import type { PlanCeilingValues } from "@/lib/admin/plans";
import { apiFetch, Button, FormField, Input, Select, Textarea, toast } from "@/components/ui";
import { PLAN_CEILING_CURRENCIES, validateFeatures, validateLimit, validateMoneyText, validatePlanCode, validatePrice } from "./helpers";

export type PlanFormValues = {
  id?: string;
  code: string;
  name: string;
  description: string;
  priceRupees: string;
  intervalMonths: string;
  seatLimit: string;
  contactLimit: string;
  monthlyBroadcastLimit: string;
  aiCreditsMonthly?: string;
  adAccountLimit?: string;
  scheduledPostLimit?: string;
  connectedChannelLimit?: string;
  features: string;
  active: boolean;
  sortOrder: string;
  priceLocked?: boolean;
  /** Spending ceilings of the plan (SpendCeiling rows with scope plan). */
  ceilings?: PlanCeilingValues;
};

export const EMPTY_CEILINGS: PlanCeilingValues = { ads: [{ currency: "INR", daily: "", monthly: "" }], whatsappMonthly: "", aiDaily: "" };

export const EMPTY_PLAN: PlanFormValues = {
  code: "", name: "", description: "", priceRupees: "", intervalMonths: "1", seatLimit: "", contactLimit: "", monthlyBroadcastLimit: "", aiCreditsMonthly: "", adAccountLimit: "", scheduledPostLimit: "", connectedChannelLimit: "", features: "{}", active: true, sortOrder: "0", ceilings: EMPTY_CEILINGS,
};

const LIMIT_FIELDS = ["seatLimit", "contactLimit", "monthlyBroadcastLimit", "aiCreditsMonthly", "adAccountLimit", "scheduledPostLimit", "connectedChannelLimit"] as const;

type Errors = Partial<Record<string, string>>;

/** The ceiling inputs the form sends: adsCeiling_<CUR>_daily / _monthly, adsCeilingNew_*, whatsappCeiling_INR_monthly, aiCeiling_daily. */
export function ceilingFieldErrors(body: Record<string, unknown>): Errors {
  const errors: Errors = {};
  for (const [k, v] of Object.entries(body)) {
    if (!/^(adsCeiling_[A-Z]{3}_(daily|monthly)|adsCeilingNew_(daily|monthly)|whatsappCeiling_INR_monthly|aiCeiling_daily)$/.test(k)) continue;
    const e = validateMoneyText(String(v ?? ""), { wholeOnly: k === "aiCeiling_daily" });
    if (e) errors[k] = e;
  }
  const newCurrency = String(body.adsCeilingNew_currency ?? "");
  if (!newCurrency && (String(body.adsCeilingNew_daily ?? "").trim() || String(body.adsCeilingNew_monthly ?? "").trim())) errors.adsCeilingNew_currency = "Choose the currency of this row.";
  return errors;
}

function check(body: Record<string, unknown>, locked: boolean): Errors {
  const text = (k: string) => String(body[k] ?? "");
  const errors: Errors = { ...ceilingFieldErrors(body) };
  if (!text("name").trim()) errors.name = "Enter a name customers will see, like Starter.";
  if (!locked) {
    const price = validatePrice(text("priceRupees"));
    if (price) errors.priceRupees = price;
  }
  const code = validatePlanCode(text("code"));
  if (code) errors.code = code;
  for (const k of LIMIT_FIELDS) {
    const e = validateLimit(text(k));
    if (e) errors[k] = e;
  }
  const features = validateFeatures(text("features"));
  if (features) errors.features = features;
  return errors;
}

export function PlanForm({ initial = EMPTY_PLAN }: { initial?: PlanFormValues }) {
  const router = useRouter();
  const editing = !!initial.id;
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [failure, setFailure] = useState<string | null>(null);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const body: Record<string, unknown> = Object.fromEntries([...f.entries()].map(([k, v]) => [k, String(v)]));
    body.active = f.get("active") === "on";
    const found = check(body, !!initial.priceLocked);
    setErrors(found);
    setFailure(null);
    if (Object.keys(found).length > 0) {
      if (found.code || found.features) form.querySelector<HTMLDetailsElement>("details[data-advanced]")?.setAttribute("open", "");
      toast.error("Some fields need fixing. Check the highlighted fields.");
      return;
    }
    setBusy(true);
    try {
      await apiFetch(editing ? `/api/admin/plans/${initial.id}` : "/api/admin/plans", { method: editing ? "PATCH" : "POST", body });
      toast.success(editing ? "Plan saved" : "Plan created");
      if (!editing) form.reset();
      router.refresh();
    } catch (err) {
      setFailure(err instanceof Error ? err.message : "Something went wrong.");
      toast.error(`We could not ${editing ? "save" : "create"} the plan. ${err instanceof Error ? err.message : ""}`.trim());
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="grid gap-4 sm:grid-cols-2">
      <FormField label="Plan name" required error={errors.name} hint="Shown to customers on the billing page.">
        <Input name="name" defaultValue={initial.name} maxLength={80} />
      </FormField>
      <FormField label="Description" optional hint="One short line about who this plan is for.">
        <Input name="description" defaultValue={initial.description} maxLength={500} />
      </FormField>
      <FormField
        label="Price in rupees (GST included)"
        required
        error={errors.priceRupees}
        hint={initial.priceLocked ? "Locked because the plan is published to Razorpay. Use Duplicate as new plan to change the price." : "For example 999 or 999.50. This is what the customer pays, tax included."}
      >
        <Input name="priceRupees" defaultValue={initial.priceRupees} readOnly={initial.priceLocked} inputMode="decimal" />
      </FormField>
      <FormField label="Billing interval" hint={initial.priceLocked ? "Locked after publishing." : "How often the customer is charged."}>
        <Select name="intervalMonths" defaultValue={initial.intervalMonths} disabled={initial.priceLocked}>
          {[1, 3, 6, 12].map((m) => (
            <option key={m} value={m}>
              {m === 1 ? "Every month" : m === 12 ? "Every year" : `Every ${m} months`}
            </option>
          ))}
        </Select>
      </FormField>
      {initial.priceLocked && <input type="hidden" name="intervalMonths" value={initial.intervalMonths} />}
      <FormField label="Team seats" optional error={errors.seatLimit} hint="Leave empty for unlimited.">
        <Input name="seatLimit" inputMode="numeric" defaultValue={initial.seatLimit} />
      </FormField>
      <FormField label="Contacts" optional error={errors.contactLimit} hint="Leave empty for unlimited.">
        <Input name="contactLimit" inputMode="numeric" defaultValue={initial.contactLimit} />
      </FormField>
      <FormField label="Broadcast messages a month" optional error={errors.monthlyBroadcastLimit} hint="Leave empty for unlimited.">
        <Input name="monthlyBroadcastLimit" inputMode="numeric" defaultValue={initial.monthlyBroadcastLimit} />
      </FormField>
      <FormField label="AI credits a month" optional error={errors.aiCreditsMonthly} hint="One reply costs 1 credit, one picture 5. Leave empty to use the platform ceiling (AI_DEFAULT_MONTHLY_CREDITS). AI is never unlimited.">
        <Input name="aiCreditsMonthly" inputMode="numeric" defaultValue={initial.aiCreditsMonthly ?? ""} />
      </FormField>
      <FormField label="Ad accounts" optional error={errors.adAccountLimit} hint="Ad accounts that can carry campaigns. Leave empty for unlimited.">
        <Input name="adAccountLimit" inputMode="numeric" defaultValue={initial.adAccountLimit ?? ""} />
      </FormField>
      <FormField label="Scheduled posts a month" optional error={errors.scheduledPostLimit} hint="Posts created in the content calendar each month. Leave empty for unlimited.">
        <Input name="scheduledPostLimit" inputMode="numeric" defaultValue={initial.scheduledPostLimit ?? ""} />
      </FormField>
      <FormField label="Connected social channels" optional error={errors.connectedChannelLimit} hint="Pages, Instagram and Threads accounts that can carry posts. Leave empty for unlimited.">
        <Input name="connectedChannelLimit" inputMode="numeric" defaultValue={initial.connectedChannelLimit ?? ""} />
      </FormField>
      <PlanCeilingFields ceilings={initial.ceilings ?? EMPTY_CEILINGS} errors={errors} />
      <label className="flex min-h-10 items-center gap-3 text-sm sm:col-span-2">
        <input type="checkbox" name="active" defaultChecked={initial.active} className="h-5 w-5 accent-(--accent)" />
        <span>
          <span className="font-medium">Available to customers</span>
          <span className="block text-xs text-muted">Untick to archive. Existing subscribers keep their plan.</span>
        </span>
      </label>

      <details data-advanced className="rounded-control border border-border p-3 sm:col-span-2">
        <summary className="flex min-h-10 cursor-pointer items-center text-sm font-medium">Advanced options</summary>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <FormField label="Plan code" required error={errors.code} hint="A short internal name, lowercase, like starter. Used to identify the plan.">
            <Input name="code" defaultValue={initial.code} maxLength={40} autoCapitalize="off" spellCheck={false} />
          </FormField>
          <FormField label="Display order" optional hint="Lower numbers appear first.">
            <Input name="sortOrder" type="number" defaultValue={initial.sortOrder} />
          </FormField>
          <FormField label="Extra features (JSON object)" optional error={errors.features} hint='For example {"api": true}. Leave as {} if unsure.' className="sm:col-span-2">
            <Textarea name="features" rows={3} defaultValue={initial.features} className="font-mono" spellCheck={false} />
          </FormField>
        </div>
      </details>

      <div className="sm:col-span-2">
        <Button type="submit" loading={busy}>
          {editing ? "Save plan" : "Create plan"}
        </Button>
        {failure && (
          <p role="alert" className="mt-2 text-sm font-medium text-bad-fg">
            {failure}
          </p>
        )}
      </div>
    </form>
  );
}

/**
 * "Spending ceilings for this plan" (docs/SPEND-CONTROLS-SPEC.md 8.3): ads per day and per month, one row per currency with
 * INR first, WhatsApp per month and AI credits per day. Saved as SpendCeiling rows with scope plan; empty means no ceiling.
 */
export function PlanCeilingFields({ ceilings, errors }: { ceilings: PlanCeilingValues; errors: Errors }) {
  const used = new Set(ceilings.ads.map((r) => r.currency));
  const more = PLAN_CEILING_CURRENCIES.filter((c) => !used.has(c));
  return (
    <fieldset className="rounded-control border border-border p-3 sm:col-span-2">
      <legend className="px-1 text-sm font-medium">Spending ceilings for this plan</legend>
      <p className="mb-3 text-xs text-muted">
        The most a workspace on this plan may spend, whatever its own limits say. Amounts are in each currency&apos;s main unit, for example 2000 for ₹2,000, and are the worst case: Meta can spend 75% more than a daily budget on a busy day, so a ₹2,000 ceiling allows about ₹1,142 of daily budgets. Leave a field empty for no ceiling.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        {ceilings.ads.map((r) => (
          <div key={r.currency} className="contents">
            <FormField label={`Ads ceiling per day (${r.currency})`} optional error={errors[`adsCeiling_${r.currency}_daily`]}>
              <Input name={`adsCeiling_${r.currency}_daily`} inputMode="decimal" defaultValue={r.daily} />
            </FormField>
            <FormField label={`Ads ceiling per month (${r.currency})`} optional error={errors[`adsCeiling_${r.currency}_monthly`]}>
              <Input name={`adsCeiling_${r.currency}_monthly`} inputMode="decimal" defaultValue={r.monthly} />
            </FormField>
          </div>
        ))}
        {more.length > 0 && (
          <>
            <FormField label="Add ads ceilings in another currency" optional error={errors.adsCeilingNew_currency} className="sm:col-span-2">
              <Select name="adsCeilingNew_currency" defaultValue="">
                <option value="">No other currency</option>
                {more.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField label="Ads ceiling per day (that currency)" optional error={errors.adsCeilingNew_daily}>
              <Input name="adsCeilingNew_daily" inputMode="decimal" defaultValue="" />
            </FormField>
            <FormField label="Ads ceiling per month (that currency)" optional error={errors.adsCeilingNew_monthly}>
              <Input name="adsCeilingNew_monthly" inputMode="decimal" defaultValue="" />
            </FormField>
          </>
        )}
        <FormField label="WhatsApp ceiling per month (INR)" optional error={errors.whatsappCeiling_INR_monthly} hint="Estimated cost of messages Meta charges for.">
          <Input name="whatsappCeiling_INR_monthly" inputMode="decimal" defaultValue={ceilings.whatsappMonthly} />
        </FormField>
        <FormField label="AI credits per day" optional error={errors.aiCeiling_daily} hint="The monthly credits are set above, under AI credits a month.">
          <Input name="aiCeiling_daily" inputMode="numeric" defaultValue={ceilings.aiDaily} />
        </FormField>
      </div>
    </fieldset>
  );
}
