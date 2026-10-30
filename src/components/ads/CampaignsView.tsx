"use client";

import Link from "next/link";
import { useState } from "react";
import { Alert, Button, Card, DataTable, EmptyState, ErrorState, FormField, Input, Select, Skeleton, StatusPill, apiFetch, confirm, toast, type Column } from "@/components/ui";
import { PageHeader } from "@/components/app/PageHeader";
import { canManage, useApi, useRole } from "@/components/contacts/hooks";
import { LinkButton } from "./LinkButton";
import { TEMPLATE_LABELS, campaignStatusView, categoryName, formatMinor, friendlyAdsError, toMinor } from "./helpers";
import { formatMinor as formatSpendMinor, type MoneyDTO } from "@/lib/spend/money";
import { ceil175 } from "@/lib/spend/worstcase";
import type { PotView, SpendSummaryView } from "@/lib/spend/summary";

type Item = { id: string; name: string; template: string; status: string; currency: string; totalDailyBudgetMinor: number; adCount: number; lastError: string | null; specialAdCategory: string };
type Caps = { maxDailyBudgetMinor: number | null; currency: string | null };

const CURRENCIES = ["INR", "USD", "EUR", "GBP", "AED"];

/** The ads pot as the CapPanel reads it from GET /api/spend/summary (docs/SPEND-CONTROLS-SPEC.md 8.2). */
type AdsPotLite = Pick<PotView, "today" | "month" | "limits">;

/**
 * The 8.2 lines under the daily limit: "Ads limit: ₹1,150 of ₹2,000 left today · ₹6,800 of ₹20,000 left this month" and
 * "Set aside for running ads: ₹7,000". A period with no limit says "Not set" instead of a number. Pure.
 */
export function capSummaryLines(ads: AdsPotLite): string[] {
  const part = (left: MoneyDTO | null, limit: MoneyDTO | null, when: string) => (limit ? `${left?.formatted ?? limit.formatted} of ${limit.formatted} left ${when}` : `Not set ${when}`);
  const today = part(ads.today.left, ads.limits.effectiveDaily, "today");
  const month = part(ads.month.left, ads.limits.effectiveMonthly, "this month");
  return [`Ads limit: ${today} · ${month}`, `Set aside for running ads: ${ads.month.committed.formatted}`];
}

/** The CapPanel's number keeps its old meaning (4.8): the most daily budgets may add up to, stored as a 1.75x daily limit. */
export function capHelpText(capMinor: number | null, currency: string): string {
  if (!capMinor || capMinor <= 0) return "Because Meta can spend up to 75% more than a daily budget on a busy day, your daily ads limit is set to 1.75 times the amount you enter.";
  return `Up to ${formatSpendMinor(capMinor, currency)} a day in ad budgets. Because Meta can spend 75% more on a busy day, this sets your daily ads limit to ${formatSpendMinor(ceil175(BigInt(capMinor)), currency)}.`;
}

/** The lines and the link to Settings > Spending limits (rendered by tests). */
export function CapSummary({ ads }: { ads: AdsPotLite | null }) {
  return (
    <div className="mt-3 space-y-1 text-sm" data-testid="cap-summary">
      {ads && capSummaryLines(ads).map((line) => <p key={line} className="tabular-nums">{line}</p>)}
      <Link href="/app/settings/spending" className="inline-flex min-h-10 items-center font-medium underline underline-offset-2">
        All spending limits
      </Link>
    </div>
  );
}

function SpendLines() {
  const { data } = useApi<{ summary: SpendSummaryView }>("/api/spend/summary");
  return <CapSummary ads={data?.summary?.pots.ads ?? null} />;
}

function CapPanel({ role }: { role: ReturnType<typeof useRole> }) {
  const { data, error, loading, reload, retry } = useApi<{ caps: Caps }>("/api/ads/caps");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("INR");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(0);
  const caps = data?.caps;
  const hasCap = !!caps?.maxDailyBudgetMinor;
  const activeCurrency = caps?.currency ?? currency;

  async function save() {
    const minor = toMinor(amount, currency);
    if (minor === null) return setFieldError("Enter an amount above zero, like 5000.");
    setFieldError(null);
    const raising = hasCap && caps?.currency === currency && minor > (caps?.maxDailyBudgetMinor ?? 0);
    const ok = await confirm({
      title: raising ? "Raise your daily spending limit?" : "Set your daily spending limit?",
      body: `All your active campaigns together will be allowed to spend up to ${formatMinor(minor, currency)} a day.`,
      confirmLabel: "Save limit",
    });
    if (!ok) return;
    setSaving(true);
    try {
      await apiFetch("/api/ads/caps", { method: "PUT", body: { maxDailyBudgetMinor: minor, currency } });
      setAmount("");
      toast.success(`Daily limit saved: ${formatMinor(minor, currency)}`);
      reload();
      setSaved((n) => n + 1);
    } catch (e) {
      toast.error(friendlyAdsError((e as Error).message));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card title="Daily spending limit" description="The most all your active campaigns can spend together in one day. Nothing can start until a limit is set." className="mb-6">
      <div aria-live="polite" data-testid="cap-status">
        {loading ? (
          <Skeleton className="h-6 w-56" />
        ) : error ? (
          <Alert tone="bad" action={<Button size="sm" variant="secondary" onClick={retry}>Try again</Button>}>
            We could not load your limit.
          </Alert>
        ) : hasCap ? (
          <p className="text-sm">
            Current limit: <strong className="text-lg tabular-nums">{formatMinor(caps!.maxDailyBudgetMinor!, activeCurrency)}</strong> a day
          </p>
        ) : (
          <Alert tone="warn" title="No limit set yet">
            {role === "owner" ? "Set a limit below. You stay in control of how much can be spent." : "Ask an owner to set a limit so campaigns can start."}
          </Alert>
        )}
      </div>
      {!loading && !error && <p className="mt-2 text-xs text-muted">{capHelpText(caps?.maxDailyBudgetMinor ?? null, activeCurrency)}</p>}
      <SpendLines key={saved} />
      {role === "owner" ? (
        <form
          className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,14rem)_8rem_auto] sm:items-start"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <FormField label={hasCap ? "New daily limit" : "Daily limit"} hint="For example 5000." error={fieldError}>
            <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} autoComplete="off" />
          </FormField>
          <FormField label="Currency">
            <Select value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {CURRENCIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </Select>
          </FormField>
          <div className="sm:pt-[1.625rem]">
            <Button type="submit" loading={saving} variant={hasCap ? "secondary" : "primary"} className="w-full sm:w-auto">
              Save limit
            </Button>
          </div>
        </form>
      ) : (
        <p className="mt-3 text-xs text-muted">Only an owner can change the limit.</p>
      )}
    </Card>
  );
}

const COLUMNS: Column<Item>[] = [
    {
      key: "name",
      header: "Campaign",
      primary: true,
      accessor: (c) => c.name.toLowerCase(),
      sortable: true,
      cell: (c) => (
        <div className="min-w-0">
          <Link href={`/app/ads/${c.id}`} className="font-medium underline-offset-2 hover:underline">
            {c.name}
          </Link>
          {c.lastError && <p className="mt-0.5 text-xs text-bad-fg">{friendlyAdsError(c.lastError)}</p>}
        </div>
      ),
    },
    { key: "status", header: "Status", accessor: (c) => campaignStatusView(c.status).label, sortable: true, cell: (c) => <StatusPill status={c.status} label={campaignStatusView(c.status).label} tone={campaignStatusView(c.status).tone} /> },
    { key: "goal", header: "Goal", accessor: (c) => TEMPLATE_LABELS[c.template]?.title ?? "Campaign" },
    { key: "budget", header: "Daily budget", align: "right", accessor: (c) => c.totalDailyBudgetMinor, sortable: true, cell: (c) => <span className="tabular-nums">{formatMinor(c.totalDailyBudgetMinor, c.currency)}</span> },
    { key: "ads", header: "Ads", align: "right", accessor: (c) => c.adCount },
    { key: "category", header: "Special category", accessor: (c) => (c.specialAdCategory === "none" ? "None" : categoryName(c.specialAdCategory)) },
];

export function CampaignsView() {
  const role = useRole();
  const { data, error, loading, retry } = useApi<{ campaigns: Item[] }>("/api/ads/campaigns", 10000);
  const blocked = role !== null && !canManage(role);

  if (blocked) {
    return (
      <div>
        <PageHeader title="Ad campaigns" />
        <EmptyState title="Ad campaigns are for owners and admins" body="Ask an owner or admin of your workspace to manage ads, or to give you access." />
      </div>
    );
  }

  const campaigns = data?.campaigns ?? [];

  return (
    <div>
      <PageHeader
        title="Ad campaigns"
        description="Run Facebook and Instagram ads from here. New campaigns start paused, so nothing is spent until you activate one."
        actions={<LinkButton href="/app/ads/new">New campaign</LinkButton>}
      />
      <CapPanel role={role} />
      {error && !data ? (
        <ErrorState title="We could not load your campaigns" message="Check your connection and try again." action={<Button variant="secondary" onClick={retry}>Try again</Button>} />
      ) : (
        <>
          {error && (
            <Alert tone="warn" className="mb-3" action={<Button size="sm" variant="secondary" onClick={retry}>Try again</Button>}>
              We could not refresh the list. You are seeing the last version we loaded.
            </Alert>
          )}
          <DataTable
            caption="Ad campaigns"
            columns={COLUMNS}
            rows={campaigns}
            rowKey={(c) => c.id}
            loading={loading}
            empty={
              <EmptyState
                compact
                title="No campaigns yet"
                body="A campaign shows your ad to the right people on Facebook and Instagram. Pick a goal, set a daily budget and review it before anything is spent."
                action={<LinkButton href="/app/ads/new">Create a campaign</LinkButton>}
              />
            }
          />
        </>
      )}
    </div>
  );
}
