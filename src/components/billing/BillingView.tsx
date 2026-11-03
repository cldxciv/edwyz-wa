"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Alert, Badge, Button, Card, DataTable, EmptyState, ErrorState, FormField, Input, ProgressBar, Skeleton, StatusPill, apiFetch, buttonSizes, buttonVariants, cn, confirm, toast, type Column } from "@/components/ui";
import { PageHeader } from "@/components/app/PageHeader";
import { COMPANY } from "@/lib/config";
import { canManage, useApi, useRole } from "@/components/contacts/hooks";
import { CloseWorkspace } from "./CloseWorkspace";
import { PlanUsage } from "./PlanUsage";
import {
  NO_PLANS_TEXT,
  canCancelOnline,
  daysLeftText,
  formatDate,
  formatMoney,
  invoiceStatus,
  isManualPlan,
  isNewSubscriptionNeeded,
  paymentErrorMessage,
  planChangeDoneText,
  planChoice,
  planFacts,
  priceParts,
  priceText,
  renewalText,
  scheduledChangeText,
  stateSummary,
  trialProgress,
  validateEmail,
  validateGstin,
  validatePincode,
  type NewSubscriptionNeeded,
  type PlanLike,
  type ScheduledChangeLike,
} from "./helpers";

type Plan = PlanLike & { id: string; name: string; description: string | null };
type InvoiceRow = { id: string; number: string; status: string; totalPaise: number; currency: string; issuedAt: string; planName: string };
type Overview = {
  status: { state: string; canWrite: boolean; daysLeftInTrial: number | null; trialEndsAt: string | null; currentPeriodEnd: string | null; planName: string | null; reason?: string };
  subscription: { status: string; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean; plan: { name: string; pricePaise?: number; intervalMonths?: number }; manual?: boolean } | null;
  invoices: InvoiceRow[];
  billingProfile: { legalName: string; gstin: string | null; addressLine: string; state: string; pincode: string | null; billingEmail: string } | null;
  plans: Plan[];
  trialDays: number;
  paymentsConfigured: boolean;
  /** A plan change waiting to happen ("Changes to Growth on 30 Nov 2026"). */
  scheduledChange?: ScheduledChangeLike;
};

type PlanChangeAnswer = { change: string; planName: string; at?: string; endsOn?: string | null; ended?: boolean };

type CheckoutInit = { keyId: string; subscriptionId: string; name: string; description: string };
type CheckoutResult = { razorpay_payment_id: string; razorpay_subscription_id: string; razorpay_signature: string };
type RazorpayCtor = new (options: Record<string, unknown>) => { open: () => void };

function loadCheckout(): Promise<RazorpayCtor> {
  const w = window as unknown as { Razorpay?: RazorpayCtor };
  if (w.Razorpay) return Promise.resolve(w.Razorpay);
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.onload = () => (w.Razorpay ? resolve(w.Razorpay) : reject(new Error("Payment window could not load.")));
    script.onerror = () => reject(new Error("Payment window could not load. Check your connection and try again."));
    document.body.appendChild(script);
  });
}

const linkButton = (variant: keyof typeof buttonVariants, size: keyof typeof buttonSizes = "md") =>
  cn("inline-flex items-center justify-center gap-2 rounded-full font-semibold whitespace-nowrap", buttonVariants[variant], buttonSizes[size]);

function BillingSkeleton() {
  return (
    <div role="status" className="space-y-6">
      <span className="sr-only">Loading billing</span>
      <Skeleton className="h-36 w-full" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

export function BillingView() {
  const role = useRole();
  const { data, error, loading, reload } = useApi<Overview>("/api/billing");
  const [busy, setBusy] = useState<string | null>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const [focusStatus, setFocusStatus] = useState(false);
  // Razorpay could not change the plan for the way it is paid: what to do instead (end at the period's end, then start the new plan).
  const [needsNew, setNeedsNew] = useState<NewSubscriptionNeeded | null>(null);
  const cancelled = data?.subscription?.cancelAtPeriodEnd ?? false;

  // The Cancel button disappears once the cancellation is saved; move focus to the plan status so it is not lost.
  useEffect(() => {
    if (focusStatus && cancelled) {
      statusRef.current?.focus();
      setFocusStatus(false);
    }
  }, [focusStatus, cancelled]);

  if (loading || role === null) {
    return (
      <div>
        <PageHeader title="Billing" description="Your plan, billing details and invoices." />
        <BillingSkeleton />
      </div>
    );
  }
  if (!canManage(role)) {
    return (
      <div>
        <PageHeader title="Billing" />
        <EmptyState title="Billing is for owners and admins" body="Ask a workspace owner or admin to manage the subscription and see invoices." />
      </div>
    );
  }
  if (error || !data) {
    return (
      <div>
        <PageHeader title="Billing" />
        <ErrorState title="We could not load billing" message="Check your connection and try again." action={<Button variant="secondary" onClick={reload}>Try again</Button>} />
      </div>
    );
  }

  const overview = data;
  const isOwner = role === "owner";
  const sub = overview.subscription;
  const summary = stateSummary(overview.status.state);

  async function subscribe(plan: Plan) {
    setBusy(plan.id);
    try {
      const init = await apiFetch<CheckoutInit>("/api/billing/subscribe", { method: "POST", body: { planId: plan.id } });
      const Razorpay = await loadCheckout();
      new Razorpay({
        key: init.keyId,
        subscription_id: init.subscriptionId,
        name: init.name,
        description: init.description,
        handler: (response: CheckoutResult) => {
          apiFetch<{ scheduled?: boolean; startsOn?: string }>("/api/billing/verify", { method: "POST", body: response })
            .then((r) => toast.success(r?.scheduled && r.startsOn ? `All set. ${plan.name} starts on ${formatDate(r.startsOn)}.` : "Payment received. Your plan is being activated."))
            .catch(() => toast.error(paymentErrorMessage(null, "confirm")))
            .finally(() => {
              setBusy(null);
              reload();
            });
        },
        modal: { ondismiss: () => setBusy(null) },
      }).open();
    } catch (e) {
      toast.error(paymentErrorMessage((e as Error).message));
      setBusy(null);
    }
  }

  /** Upgrade now or switch at the renewal (POST /api/billing/change-plan), after the owner confirms what will happen. */
  async function changeTo(plan: Plan, action: "upgrade" | "downgrade") {
    const current = sub?.plan.name ?? "your current plan";
    const until = formatDate(sub?.currentPeriodEnd);
    const ok = await confirm(
      action === "upgrade"
        ? {
            title: `Upgrade to ${plan.name} now?`,
            body: `Your plan changes right away. Razorpay charges your saved payment method only the difference for the rest of this period, then ${priceText(plan)} from your next renewal.`,
            confirmLabel: `Upgrade to ${plan.name}`,
            cancelLabel: `Stay on ${current}`,
          }
        : {
            title: `Switch to ${plan.name}?`,
            body: `You keep ${current} until ${until || "the end of this period"}. From then on you are on ${plan.name} at ${priceText(plan)}. Nothing is charged now.`,
            confirmLabel: `Switch to ${plan.name}`,
            cancelLabel: `Stay on ${current}`,
          },
    );
    if (!ok) return;
    setBusy(plan.id);
    setNeedsNew(null);
    try {
      const result = await apiFetch<PlanChangeAnswer>("/api/billing/change-plan", { method: "POST", body: { planId: plan.id } });
      toast.success(planChangeDoneText(result));
      setFocusStatus(true);
      reload();
    } catch (e) {
      const body = (e as { body?: unknown }).body;
      if (isNewSubscriptionNeeded(body)) setNeedsNew(body);
      else toast.error(`We could not change your plan. ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  /** Drops the planned change: the plan renews as it is (or the new subscription will not start). */
  async function keepPlan() {
    setBusy("keep");
    try {
      const result = await apiFetch<PlanChangeAnswer>("/api/billing/change-plan", { method: "POST", body: { cancelScheduled: true } });
      toast.success(planChangeDoneText(result));
      reload();
    } catch (e) {
      toast.error(`We could not cancel the planned change. ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  function choose(plan: Plan, action: string) {
    if (action === "upgrade" || action === "downgrade") return void changeTo(plan, action);
    if (action === "keep") return void keepPlan();
    return void subscribe(plan);
  }

  async function cancel() {
    const until = formatDate(sub?.currentPeriodEnd);
    const ok = await confirm({
      title: "Cancel your subscription?",
      body: until
        ? `You keep full access until ${until}. After that your workspace becomes read-only and you cannot send messages until you subscribe again.`
        : "You keep access until the end of the current billing period. After that your workspace becomes read-only until you subscribe again.",
      confirmLabel: "Cancel subscription",
      cancelLabel: "Keep my plan",
      tone: "danger",
    });
    if (!ok) return;
    setBusy("cancel");
    try {
      await apiFetch("/api/billing/cancel", { method: "POST", body: {} });
      // Ended to move to another plan: the plan cards now offer to start that plan on the day this one ends.
      const next = needsNew?.planName;
      toast.success(
        next
          ? `Your plan ends on ${until || "the end of this period"}. Now press Start ${next} under Plans to set it up from that day.`
          : until ? `Your subscription will end on ${until}.` : "Your subscription will end at the close of the current period.",
      );
      setNeedsNew(null);
      setFocusStatus(true);
      reload();
    } catch (e) {
      toast.error(`We could not cancel your subscription. ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  const trial = overview.status.state === "trialing" ? trialProgress(overview.status.daysLeftInTrial, overview.trialDays) : null;
  const renewal = renewalText(sub);
  const scheduled = overview.scheduledChange ?? null;
  // An approved new plan that is starting is the plan to continue with: no "Choose a plan" next to it.
  const nextApproved = scheduled?.kind === "next_subscription" && scheduled.authorized;
  const needsPlan = ["trialing", "locked", "past_due_grace"].includes(overview.status.state) && !nextApproved;
  const showCancel = isOwner && canCancelOnline(sub);
  // A plan our team assigned by hand has no online subscription behind it: point to support instead of a Cancel that always fails.
  const manual = isManualPlan(sub);
  const scheduledText = scheduledChangeText(scheduled);
  // A downgrade is kept from the current plan's card; a new plan that has not started yet can be called off here.
  const canDropNext = isOwner && scheduled?.kind === "next_subscription";

  return (
    <div className="space-y-8">
      <PageHeader title="Billing" description="Your plan, billing details and invoices." />

      <Card
        title="Your plan"
        actions={<Badge tone={summary.tone} dot>{summary.label}</Badge>}
        description={overview.status.planName ?? "No paid plan yet"}
      >
        <p ref={renewal ? undefined : statusRef} tabIndex={-1} className="rounded-control text-sm text-muted">{summary.hint}</p>
        {trial && overview.status.daysLeftInTrial !== null && (
          <div className="mt-4 max-w-md">
            <ProgressBar label="Free trial days used" value={trial.used} max={trial.total} tone={overview.status.daysLeftInTrial <= 3 ? "warn" : "info"} showLabel showValue valueText={daysLeftText(overview.status.daysLeftInTrial)} />
          </div>
        )}
        {renewal && (
          <p ref={statusRef} tabIndex={-1} className="mt-3 rounded-control text-sm">
            {renewal}
          </p>
        )}
        {scheduledText && (
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
            <p className="text-sm font-medium" aria-live="polite">
              {scheduledText}
            </p>
            {canDropNext && (
              <Button size="sm" variant="secondary" loading={busy === "keep"} disabled={busy !== null && busy !== "keep"} onClick={() => void keepPlan()}>
                Do not start {scheduled?.planName}
              </Button>
            )}
          </div>
        )}
        {needsNew && (
          <Alert
            tone="warn"
            className="mt-4"
            title={`${needsNew.planName} cannot start partway through this plan`}
            action={
              isOwner && canCancelOnline(sub) ? (
                <Button size="sm" variant="secondary" loading={busy === "cancel"} onClick={cancel}>
                  End my plan on {formatDate(needsNew.endsOn) || "the period's end"}
                </Button>
              ) : undefined
            }
          >
            {needsNew.error}
          </Alert>
        )}
        {manual && (
          <p className="mt-3 text-sm">
            Your plan was set up by our team. To change, renew or cancel it, contact{" "}
            <a href={`mailto:${COMPANY.email}?subject=${encodeURIComponent("Change my Edwyz WA plan")}`} className="font-medium text-accent-ink underline underline-offset-2">
              {COMPANY.email}
            </a>
            .
          </p>
        )}
        {(needsPlan || showCancel) && (
          <div className="mt-4 flex flex-wrap gap-2">
            {needsPlan && overview.plans.length > 0 && (
              <a href="#plans" className={linkButton("primary")}>
                {overview.status.state === "trialing" ? "Choose a plan" : "Choose a plan to continue"}
              </a>
            )}
            {showCancel && (
              <Button variant="secondary" loading={busy === "cancel"} onClick={cancel}>
                Cancel subscription
              </Button>
            )}
          </div>
        )}
      </Card>

      <section aria-labelledby="plans-heading" id="plans" className="scroll-mt-24">
        <h2 id="plans-heading" className="text-base font-semibold tracking-tight">
          Plans
        </h2>
        <p className="mb-3 mt-0.5 text-sm text-muted">
          Prices include GST. Every plan has every feature; plans differ in limits. An upgrade starts now and you pay only the difference; a cheaper plan, or a move between monthly and yearly billing, starts at your next renewal. You can cancel any time and keep access until the end of the period you paid for.
        </p>
        {overview.plans.length === 0 ? (
          <EmptyState
            title={NO_PLANS_TEXT}
            body="We have not published any plans yet. Email us and we will set you up."
            action={
              <a href={`mailto:${COMPANY.email}?subject=${encodeURIComponent("Edwyz WA plan")}`} className={linkButton("primary")}>
                Email {COMPANY.email}
              </a>
            }
          />
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {overview.plans.map((plan) => {
              const choice = planChoice(plan, sub, overview.paymentsConfigured, { isOwner, scheduled });
              const price = priceParts(plan);
              const reasonId = `plan-${plan.id}-reason`;
              return (
                <li key={plan.id} className={cn("flex flex-col rounded-card border bg-raised p-5 shadow-raised", choice.current ? "border-accent ring-2 ring-accent" : "border-border")}>
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="text-base font-semibold">{plan.name}</h3>
                    {choice.current && <Badge tone="good" dot>Your plan</Badge>}
                  </div>
                  {plan.description && <p className="mt-1 text-sm text-muted">{plan.description}</p>}
                  <p className="mt-3">
                    <span className="text-2xl font-semibold tabular-nums tracking-tight">{price.amount}</span> <span className="text-sm text-muted">{price.per}</span>
                  </p>
                  <dl className="mt-4 flex-1 divide-y divide-border border-t border-border text-sm">
                    {planFacts(plan).map((f) => (
                      <div key={f.label} className="flex flex-wrap items-baseline justify-between gap-x-3 py-2">
                        <dt className="text-muted">{f.label}</dt>
                        <dd className="font-medium tabular-nums">{f.value}</dd>
                      </div>
                    ))}
                  </dl>
                  <Button
                    className="mt-4 w-full whitespace-normal"
                    variant={choice.current || choice.action === "downgrade" ? "secondary" : "primary"}
                    disabled={choice.disabled || (busy !== null && busy !== plan.id && !(choice.action === "keep" && busy === "keep"))}
                    loading={busy === plan.id || (choice.action === "keep" && busy === "keep")}
                    aria-describedby={choice.reason ? reasonId : undefined}
                    onClick={() => choose(plan, choice.action)}
                  >
                    {choice.label}
                  </Button>
                  {choice.reason && (
                    <p id={reasonId} className="mt-2 text-xs text-muted">
                      {choice.reason}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <div id="usage" className="scroll-mt-24">
        <PlanUsage />
      </div>

      <ProfileForm profile={overview.billingProfile} onSaved={reload} />

      <Card title="Invoices" description="Download or print any invoice for your records." padded={false}>
        <DataTable<InvoiceRow>
          className="max-sm:p-3"
          caption="Invoices"
          columns={invoiceColumns}
          rows={overview.invoices}
          rowKey={(i) => i.id}
          defaultSort={{ key: "date", dir: "desc" }}
          empty={
            <div className="px-5 pb-5">
              <EmptyState compact title="No invoices yet" body="When you pay for a plan, your invoice appears here and you can print or save it as a PDF." />
            </div>
          }
        />
      </Card>

      <CloseWorkspace />
    </div>
  );
}

const invoiceColumns: Column<InvoiceRow>[] = [
  { key: "number", header: "Invoice", primary: true, accessor: (i) => i.number, sortable: true, cell: (i) => <span className="font-mono">{i.number}</span> },
  { key: "date", header: "Date", accessor: (i) => new Date(i.issuedAt).getTime(), sortable: true, cell: (i) => formatDate(i.issuedAt) },
  { key: "plan", header: "Plan", accessor: (i) => i.planName, sortable: true },
  {
    key: "status",
    header: "Status",
    cell: (i) => {
      const s = invoiceStatus(i.status);
      return <StatusPill status={i.status} label={s.label} tone={s.tone} />;
    },
  },
  { key: "total", header: "Total", align: "right", accessor: (i) => i.totalPaise, sortable: true, cell: (i) => <span className="tabular-nums">{formatMoney(i.totalPaise, i.currency)}</span> },
  {
    key: "open",
    header: "View invoice",
    srOnlyHeader: true,
    align: "right",
    cell: (i) => (
      <>
      <Link href={`/app/billing/invoices/${i.id}`} className="inline-flex min-h-10 items-center text-sm font-medium text-accent-ink underline underline-offset-2" aria-label={`View and print invoice ${i.number}`}>
        View and print
      </Link>
      <a href={`/api/billing/invoices/${i.id}/download`} download className="ml-4 inline-flex min-h-10 items-center text-sm font-medium text-accent-ink underline underline-offset-2" aria-label={`Download invoice ${i.number} as a file`}>
        Download
      </a>
      </>
    ),
  },
];

type FormState = { legalName: string; gstin: string; addressLine: string; state: string; pincode: string; billingEmail: string };

function ProfileForm({ profile, onSaved }: { profile: Overview["billingProfile"]; onSaved: () => void }) {
  const [form, setForm] = useState<FormState>({
    legalName: profile?.legalName ?? "",
    gstin: profile?.gstin ?? "",
    addressLine: profile?.addressLine ?? "",
    state: profile?.state ?? "",
    pincode: profile?.pincode ?? "",
    billingEmail: profile?.billingEmail ?? "",
  });
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const set = (key: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [key]: e.target.value });

  const errors = {
    legalName: form.legalName.trim() ? null : "Enter the name your invoices should be addressed to.",
    gstin: validateGstin(form.gstin),
    addressLine: form.addressLine.trim() ? null : "Enter your business address.",
    state: form.state.trim() ? null : "Enter your state, like Karnataka.",
    pincode: validatePincode(form.pincode),
    billingEmail: validateEmail(form.billingEmail),
  };
  const show = (k: keyof typeof errors) => (touched ? errors[k] : null);
  const hasErrors = Object.values(errors).some(Boolean);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (hasErrors) {
      toast.error("Some details need fixing. Check the highlighted fields.");
      return;
    }
    setSaving(true);
    try {
      await apiFetch("/api/billing/profile", { method: "PUT", body: form });
      toast.success("Billing details saved. They apply to invoices issued from now on.");
      onSaved();
    } catch (err) {
      toast.error(`We could not save your billing details. ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card title="Billing details" description="These appear on your invoices. Changes apply to invoices issued from now on.">
      <form onSubmit={save} noValidate className="grid gap-4 sm:grid-cols-2">
        <FormField label="Business name" required error={show("legalName")} hint="The legal name to show on invoices.">
          <Input required maxLength={200} autoComplete="organization" value={form.legalName} onChange={set("legalName")} />
        </FormField>
        <FormField label="Billing email" required error={show("billingEmail")} hint="We send invoices and payment reminders here.">
          <Input type="email" required maxLength={320} autoComplete="email" value={form.billingEmail} onChange={set("billingEmail")} />
        </FormField>
        <FormField label="Address" required error={show("addressLine")} className="sm:col-span-2">
          <Input required maxLength={300} autoComplete="street-address" value={form.addressLine} onChange={set("addressLine")} />
        </FormField>
        <FormField label="State" required error={show("state")}>
          <Input required maxLength={60} autoComplete="address-level1" value={form.state} onChange={set("state")} />
        </FormField>
        <FormField label="Pincode" optional error={show("pincode")}>
          <Input inputMode="numeric" maxLength={6} autoComplete="postal-code" value={form.pincode} onChange={set("pincode")} />
        </FormField>
        <FormField label="GST number (GSTIN)" optional error={show("gstin")} hint="Add this if your business is GST registered, so you can claim input tax credit." className="sm:col-span-2">
          <Input maxLength={15} autoCapitalize="characters" value={form.gstin} onChange={set("gstin")} />
        </FormField>
        <div className="sm:col-span-2">
          <Button type="submit" loading={saving}>
            Save billing details
          </Button>
        </div>
      </form>
    </Card>
  );
}
