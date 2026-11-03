"use client";

import { useCallback, useMemo, useState } from "react";
import { Alert, Button, Card, DataTable, EmptyState, ErrorState, FormField, Input, ProgressBar, Select, Skeleton, Stat, StatusPill, apiFetch, toast, type Column } from "@/components/ui";
import { PageHeader } from "@/components/app/PageHeader";
import { canManage, useApi, useRole } from "@/components/contacts/hooks";
import { PRESETS, presetRange, rangeProblem, rangeText } from "@/components/reports/helpers";
import { currencyExponent, formatMinor } from "@/lib/ads/insights-money";
import type { CurrencyTotals, DayPoint, EntityRow, FatigueCandidate, PacingRow, Totals } from "@/lib/ads/insights-queries";
import { LinkButton } from "../LinkButton";
import { friendlyAdsError } from "../helpers";
import { DailyChart } from "./DailyChart";
import { compactNumber, deltaView, fatigueReasons, futureRangeProblem, latestDay, pacingView } from "./insight-helpers";
import { accountLabel, chartMetrics, insightsQuery, splitByCurrency, type Metric } from "./account-filter";

type Account = { id: string; name: string | null; currency: string | null };
type Summary = {
  connected: boolean;
  adAccounts: number;
  currency: string | null;
  mixed: boolean;
  current: Totals;
  previous: Totals;
  /** The ad account the numbers are for, or null for all of them. */
  adAccount?: string | null;
  accounts?: Account[];
  /** Mixed currencies across all ad accounts: one set of totals per currency. */
  byCurrency?: CurrencyTotals[] | null;
  fatigue: FatigueCandidate[];
  pacing: PacingRow[];
  lastSyncAt: string | null;
  lastError: string | null;
  nextManualSyncAt: string | null;
};
type Series = { days: DayPoint[] };
type Breakdown = { top: EntityRow[]; bottom: EntityRow[] };
/** Money in the row's own currency, or the page's when the row does not say. */
type Money = (minor: number, currency?: string | null) => string;

/** This browser's time zone, or UTC when it does not say. */
function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function InsightsView() {
  const role = useRole();
  const admin = canManage(role);
  const [preset, setPreset] = useState<number | "custom">(30);
  const [custom, setCustom] = useState(() => presetRange(30, "UTC"));
  const [metric, setMetric] = useState<Metric>("spendMinor");
  const [account, setAccount] = useState("");
  const range = useMemo(() => (preset === "custom" ? custom : presetRange(preset, "UTC")), [preset, custom]);
  const today = useMemo(() => latestDay(presetRange(1, "UTC").to, presetRange(1, browserZone()).to), []);
  const orderError = rangeProblem(range.from, range.to);
  const futureError = !orderError && preset === "custom" ? futureRangeProblem(range.to, today) : null;
  const rangeError = orderError ?? futureError;
  const qs = rangeError ? null : insightsQuery(range, account);

  return (
    <div>
      <PageHeader
        title="Ad insights"
        breadcrumbs={[{ label: "Ad campaigns", href: "/app/ads" }, { label: "Ad insights" }]}
        description="How much you spent, what you got for it, and which ads work best. Days follow your ad account's own time zone."
      />

      <fieldset className="mb-6 flex flex-wrap items-end gap-2">
        <legend className="sr-only">Date range</legend>
        {PRESETS.map((d) => (
          <Button key={d} variant={preset === d ? "primary" : "secondary"} size="md" aria-pressed={preset === d} onClick={() => setPreset(d)}>
            Last {d}{" "}days
          </Button>
        ))}
        <Button variant={preset === "custom" ? "primary" : "secondary"} aria-pressed={preset === "custom"} onClick={() => setPreset("custom")}>
          Pick dates
        </Button>
        {preset === "custom" && (
          <div className="flex w-full flex-wrap gap-3 sm:w-auto">
            <FormField label="From" error={orderError}>
              <Input type="date" value={custom.from} max={custom.to && custom.to < today ? custom.to : today} onChange={(e) => setCustom({ ...custom, from: e.target.value })} />
            </FormField>
            <FormField label="To" error={futureError}>
              <Input type="date" value={custom.to} min={custom.from} max={today} onChange={(e) => setCustom({ ...custom, to: e.target.value })} />
            </FormField>
          </div>
        )}
      </fieldset>

      {rangeError || !qs ? <EmptyState compact title="Choose a valid date range" body={rangeError ?? undefined} /> : <RangeData key={qs} qs={qs} range={range} admin={admin} metric={metric} setMetric={setMetric} account={account} setAccount={setAccount} />}
    </div>
  );
}

/** Everything that depends on the chosen dates. It is keyed by the date range, so changing the range starts from a clean loading state instead of showing the previous period's numbers. */
function RangeData({
  qs,
  range,
  admin,
  metric,
  setMetric,
  account,
  setAccount,
}: {
  qs: string;
  range: { from: string; to: string };
  admin: boolean;
  metric: Metric;
  setMetric: (m: Metric) => void;
  account: string;
  setAccount: (id: string) => void;
}) {
  const summary = useApi<Summary>(`/api/ads/insights/summary?${qs}`);
  const series = useApi<Series>(`/api/ads/insights/series?${qs}`);
  const ads = useApi<Breakdown>(`/api/ads/insights/breakdown?level=ad&${qs}`);
  const [syncing, setSyncing] = useState(false);

  async function sync() {
    setSyncing(true);
    try {
      await apiFetch("/api/ads/insights/sync", { method: "POST", body: {} });
      toast.success("Update requested. New numbers appear in a few minutes.");
      summary.reload();
    } catch (e) {
      toast.error(friendlyAdsError((e as Error).message));
    } finally {
      setSyncing(false);
    }
  }

  const s = summary.data;
  const waitUntil = s?.nextManualSyncAt && new Date(s.nextManualSyncAt).getTime() > Date.now() ? new Date(s.nextManualSyncAt) : null;

  if (summary.error && !s) {
    return <ErrorState title="We could not load your ad numbers" message="Check your connection and try again." action={<Button variant="secondary" onClick={summary.retry}>Try again</Button>} />;
  }
  if (!s) return <Loading range={range} />;
  if (!s.connected || s.adAccounts === 0) {
    return (
      <EmptyState
        title={s.connected ? "No ad account connected yet" : "Connect your Meta account"}
        body="Once your Facebook login with access to an ad account is connected, your spend and results show up here."
        action={<LinkButton href="/app/settings/connections">Connect ad account</LinkButton>}
      />
    );
  }
  return (
    <div className="space-y-6">
      {summary.error && (
        <Alert tone="warn" action={<Button size="sm" variant="secondary" onClick={summary.retry}>Try again</Button>}>
          We could not refresh these numbers. You are seeing the last version we loaded for {rangeText(range.from, range.to)}.
        </Alert>
      )}
      {(admin || (s.accounts?.length ?? 0) > 1) && (
        <div className="flex flex-wrap items-end gap-3">
          {(s.accounts?.length ?? 0) > 1 && (
            <div className="w-full sm:w-72">
              <FormField label="Ad account" hint="See one ad account, or all of them together.">
                <Select value={account} onChange={(e) => setAccount(e.target.value)}>
                  <option value="">All ad accounts</option>
                  {s.accounts!.map((a) => (
                    <option key={a.id} value={a.id}>
                      {accountLabel(a)}
                    </option>
                  ))}
                </Select>
              </FormField>
            </div>
          )}
          {admin && (
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="secondary" onClick={sync} loading={syncing} disabled={!!waitUntil}>
                Update numbers now
              </Button>
              {waitUntil && <span className="text-xs text-muted">You can update again at {waitUntil.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.</span>}
            </div>
          )}
        </div>
      )}
      <Body s={s} series={series} ads={ads} metric={metric} setMetric={setMetric} range={range} />
    </div>
  );
}

function Loading({ range }: { range: { from: string; to: string } }) {
  return (
    <div aria-busy="true" className="space-y-6">
      <span className="sr-only" role="status">Loading your ad numbers for {rangeText(range.from, range.to)}</span>
      <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 lg:grid-cols-4">
        {["Spend", "Results", "Cost per result", "Click rate"].map((l) => (
          <Stat key={l} label={l} value="" loading />
        ))}
      </div>
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

const wrapValue = (v: string) => <span className="block [overflow-wrap:anywhere]">{v}</span>;

function Body({
  s,
  series,
  ads,
  metric,
  setMetric,
  range,
}: {
  s: Summary;
  series: { data: Series | null; error: string | null; retry: () => void };
  ads: { data: Breakdown | null; error: string | null; retry: () => void };
  metric: Metric;
  setMetric: (m: Metric) => void;
  range: { from: string; to: string };
}) {
  // With mixed accounts but spend in one currency only, that currency is the page's.
  const pageCurrency = s.currency ?? (s.byCurrency?.length === 1 ? s.byCurrency[0].currency : null);
  const money = useCallback<Money>((n, currency) => formatMinor(n, currency ?? pageCurrency), [pageCurrency]);
  const pacingCols = useMemo(() => pacingColumns(money), [money]);
  const c = s.current;
  const p = s.previous;
  const empty = c.spendMinor === 0 && c.impressions === 0 && c.results === 0;
  const count = (n: number) => Math.round(n).toLocaleString();
  // Different currencies are never added up: their money is shown per currency, and the chart offers results and clicks.
  const split = splitByCurrency(s.byCurrency);
  const metrics = chartMetrics(!!split);
  const shown = metrics.some((m) => m.key === metric) ? metric : metrics[0].key;
  const fmt = shown === "spendMinor" ? (n: number) => money(n) : count;
  const label = metrics.find((m) => m.key === shown)!.label;
  const days = series.data?.days ?? null;
  const axis = shown === "spendMinor" ? (n: number) => compactNumber(n / 10 ** currencyExponent(pageCurrency)) : compactNumber;

  return (
    <div className="space-y-6">
      {split ? (
        <Alert tone="info">Your ad accounts use different currencies, so money is totalled for each currency on its own. Choose one ad account above to see its spend day by day.</Alert>
      ) : (
        s.mixed && !pageCurrency && <Alert tone="info">Your ad accounts use different currencies. Choose one ad account above to see its money amounts.</Alert>
      )}
      {s.lastError && (
        <Alert tone="warn" title="The last update from Meta had a problem">
          You are seeing the most recent numbers we could load.
          <details className="mt-2">
            <summary className="cursor-pointer text-xs font-medium underline">Details</summary>
            <p className="mt-1 break-words text-xs">{s.lastError}</p>
          </details>
        </Alert>
      )}
      <p className="text-xs text-muted" aria-live="polite">
        {s.lastSyncAt ? `Numbers last updated ${new Date(s.lastSyncAt).toLocaleString()}.` : "Your first update has not run yet. It loads the last 30 days."} Showing {rangeText(range.from, range.to)}.
      </p>

      {empty ? (
        <EmptyState title="No ad activity in this period" body="Try a longer range. If your campaigns only just started, wait a few minutes and update the numbers." />
      ) : (
        <>
          <section aria-label="Summary" className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 lg:grid-cols-4">
            {!split && <Stat className="min-w-0" label="Spend" value={wrapValue(money(c.spendMinor))} delta={deltaView(c.spendMinor, p.spendMinor, { neutral: true }) ?? undefined} />}
            <Stat className="min-w-0" label="Results" value={wrapValue(c.results.toLocaleString())} hint="Leads, chats or visits" delta={deltaView(c.results, p.results) ?? undefined} />
            {!split && (
              <Stat className="min-w-0" label="Cost per result" value={wrapValue(c.costPerResultMinor === null ? "Not available" : money(c.costPerResultMinor))} hint={c.costPerResultMinor === null ? "No results yet" : undefined} delta={deltaView(c.costPerResultMinor, p.costPerResultMinor, { lowerIsBetter: true }) ?? undefined} />
            )}
            <Stat className="min-w-0" label="Click rate" value={wrapValue(c.ctr === null ? "Not available" : `${c.ctr}%`)} hint="People who clicked after seeing the ad" delta={deltaView(c.ctr, p.ctr) ?? undefined} />
          </section>

          {split && <CurrencyTable rows={split} money={money} />}

          <section aria-labelledby="trend-heading" className="space-y-2">
            <h2 id="trend-heading" className="text-base font-semibold">
              Day by day
            </h2>
            <div role="group" aria-label="Choose what the chart shows" className="flex flex-wrap gap-2">
              {metrics.map((m) => (
                <Button key={m.key} size="sm" variant={shown === m.key ? "primary" : "secondary"} aria-pressed={shown === m.key} onClick={() => setMetric(m.key)}>
                  {m.label}
                </Button>
              ))}
            </div>
            {series.error && !days ? (
              <ErrorState title="We could not load the chart" action={<Button variant="secondary" onClick={series.retry}>Try again</Button>} />
            ) : days ? (
              <DailyChart title={`${label} per day`} name={label} days={days.map((d) => d.day)} values={days.map((d) => d[shown])} format={fmt} axisFormat={axis} />
            ) : (
              <Skeleton className="h-64 w-full" />
            )}
          </section>

          <section aria-labelledby="ads-heading" className="space-y-3">
            <h2 id="ads-heading" className="text-base font-semibold">
              Your ads
            </h2>
            {ads.error && !ads.data ? (
              <ErrorState title="We could not load your ads" action={<Button variant="secondary" onClick={ads.retry}>Try again</Button>} />
            ) : (
              <div className="grid gap-6 xl:grid-cols-2">
                <AdsTable title="Best ads" description="Lowest cost for each result." rows={ads.data?.top ?? null} money={money} empty="No ads have results yet." />
                <AdsTable title="Ads to review" description="Highest cost for each result, or no results." rows={ads.data?.bottom ?? null} money={money} empty="Nothing to flag. All your ads look fine." />
              </div>
            )}
          </section>

          <Card title="Ads that may be getting stale" description="People see the same ad too often, or Meta rates its quality low. A fresh picture or new wording usually helps." headingLevel="h2">
            {s.fatigue.length === 0 ? (
              <p className="text-sm text-muted">None of your ads need a refresh between {rangeText(range.from, range.to)}.</p>
            ) : (
              <ul className="divide-y divide-border text-sm">
                {s.fatigue.map((f) => (
                  <li key={f.entityMetaId} className="py-2.5">
                    <p className="font-medium">{f.name}</p>
                    <p className="text-muted">{fatigueReasons(f).join(". ")}.</p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}

      <Card title="Spending against budget" description="Average daily spend over the last 3 days for each active campaign." headingLevel="h2" padded={false}>
        <DataTable
          caption="Spending against daily budget"
          columns={pacingCols}
          rows={s.pacing}
          rowKey={(r) => r.campaignId}
          className="px-5 pb-5"
          empty={<EmptyState compact title="No active campaigns" body="When a campaign with a daily budget is running, you can see here whether it spends as planned." action={<LinkButton href="/app/ads" variant="secondary">View campaigns</LinkButton>} />}
        />
      </Card>
    </div>
  );
}

/** Spend, results and cost per result for each currency, when the ad accounts use different ones. */
function CurrencyTable({ rows, money }: { rows: CurrencyTotals[]; money: Money }) {
  const columns = useMemo<Column<CurrencyTotals>[]>(
    () => [
      { key: "currency", header: "Currency", primary: true, accessor: (r) => r.currency ?? "Unknown" },
      { key: "spend", header: "Spend", align: "right", accessor: (r) => r.current.spendMinor, cell: (r) => <span className="tabular-nums">{money(r.current.spendMinor, r.currency)}</span> },
      { key: "results", header: "Results", align: "right", accessor: (r) => r.current.results, cell: (r) => <span className="tabular-nums">{r.current.results.toLocaleString()}</span> },
      {
        key: "cpr",
        header: "Cost per result",
        align: "right",
        accessor: (r) => r.current.costPerResultMinor,
        cell: (r) => <span className="tabular-nums">{r.current.costPerResultMinor === null ? "No results" : money(r.current.costPerResultMinor, r.currency)}</span>,
      },
    ],
    [money],
  );
  return (
    <Card title="Money by currency" description="Each currency is totalled on its own, so amounts are never mixed." headingLevel="h2" padded={false}>
      <DataTable caption="Spend by currency" columns={columns} rows={rows} rowKey={(r) => r.currency ?? "unknown"} className="px-5 pb-5" />
    </Card>
  );
}

function pacingColumns(money: Money): Column<PacingRow>[] {
  return [
    { key: "name", header: "Campaign", primary: true, accessor: (r) => r.name },
    { key: "budget", header: "Daily budget", align: "right", accessor: (r) => r.dailyBudgetMinor, cell: (r) => <span className="tabular-nums">{money(r.dailyBudgetMinor, r.currency)}</span> },
    { key: "spend", header: "Average spend a day", align: "right", accessor: (r) => r.avgDailySpendMinor, cell: (r) => <span className="tabular-nums">{money(r.avgDailySpendMinor, r.currency)}</span> },
    {
      key: "pace",
      header: "Pace",
      cell: (r) => {
        const v = pacingView(r.state, r.pacingPct);
        return (
          <div className="min-w-32 space-y-1">
            <StatusPill status={r.state} label={v.label} tone={v.tone} />
            <ProgressBar label={v.detail} value={v.fill} tone={v.tone} size="sm" />
            <p className="text-xs text-muted">{v.detail}</p>
          </div>
        );
      },
    },
  ];
}

function adColumns(money: Money): Column<EntityRow>[] {
  return [
    { key: "name", header: "Ad", primary: true, accessor: (r) => r.name },
    { key: "spend", header: "Spend", align: "right", accessor: (r) => r.spendMinor, cell: (r) => <span className="tabular-nums">{money(r.spendMinor, r.currency)}</span> },
    { key: "results", header: "Results", align: "right", accessor: (r) => r.results, cell: (r) => <span className="tabular-nums">{r.results.toLocaleString()}</span> },
    { key: "cpr", header: "Cost per result", align: "right", accessor: (r) => r.costPerResultMinor, cell: (r) => <span className="tabular-nums">{r.costPerResultMinor === null ? "No results" : money(r.costPerResultMinor, r.currency)}</span> },
  ];
}

function AdsTable({ title, description, rows, money, empty }: { title: string; description: string; rows: EntityRow[] | null; money: Money; empty: string }) {
  const columns = useMemo(() => adColumns(money), [money]);
  return (
    <Card title={title} description={description} headingLevel="h3" padded={false}>
      <DataTable caption={title} columns={columns} rows={rows ?? []} rowKey={(r) => r.entityMetaId} loading={rows === null} skeletonRows={3} className="px-5 pb-5" empty={<EmptyState compact title={empty} />} />
    </Card>
  );
}
