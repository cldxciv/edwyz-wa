"use client";

import { useCallback, useMemo, useState } from "react";
import { Alert, Button, Card, DataTable, EmptyState, ErrorState, FormField, Input, ProgressBar, Skeleton, Stat, StatusPill, apiFetch, toast, type Column } from "@/components/ui";
import { PageHeader } from "@/components/app/PageHeader";
import { canManage, useApi, useRole } from "@/components/contacts/hooks";
import { PRESETS, presetRange, rangeProblem, rangeText } from "@/components/reports/helpers";
import { currencyExponent, formatMinor } from "@/lib/ads/insights-money";
import type { DayPoint, EntityRow, FatigueCandidate, PacingRow, Totals } from "@/lib/ads/insights-queries";
import { LinkButton } from "../LinkButton";
import { friendlyAdsError } from "../helpers";
import { DailyChart } from "./DailyChart";
import { compactNumber, deltaView, fatigueReasons, pacingView } from "./insight-helpers";

type Summary = {
  connected: boolean;
  adAccounts: number;
  currency: string | null;
  mixed: boolean;
  current: Totals;
  previous: Totals;
  fatigue: FatigueCandidate[];
  pacing: PacingRow[];
  lastSyncAt: string | null;
  lastError: string | null;
  nextManualSyncAt: string | null;
};
type Series = { days: DayPoint[] };
type Breakdown = { top: EntityRow[]; bottom: EntityRow[] };
type Metric = "spendMinor" | "results" | "clicks";

const METRICS: { key: Metric; label: string }[] = [
  { key: "spendMinor", label: "Spend" },
  { key: "results", label: "Results" },
  { key: "clicks", label: "Clicks" },
];

export function InsightsView() {
  const role = useRole();
  const admin = canManage(role);
  const [preset, setPreset] = useState<number | "custom">(30);
  const [custom, setCustom] = useState(() => presetRange(30, "UTC"));
  const [metric, setMetric] = useState<Metric>("spendMinor");
  const range = useMemo(() => (preset === "custom" ? custom : presetRange(preset, "UTC")), [preset, custom]);
  const rangeError = rangeProblem(range.from, range.to);
  const qs = rangeError ? null : `from=${range.from}&to=${range.to}`;

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
            Last {d} days
          </Button>
        ))}
        <Button variant={preset === "custom" ? "primary" : "secondary"} aria-pressed={preset === "custom"} onClick={() => setPreset("custom")}>
          Pick dates
        </Button>
        {preset === "custom" && (
          <div className="flex w-full flex-wrap gap-3 sm:w-auto">
            <FormField label="From" error={rangeError}>
              <Input type="date" value={custom.from} max={custom.to} onChange={(e) => setCustom({ ...custom, from: e.target.value })} />
            </FormField>
            <FormField label="To">
              <Input type="date" value={custom.to} min={custom.from} onChange={(e) => setCustom({ ...custom, to: e.target.value })} />
            </FormField>
          </div>
        )}
      </fieldset>

      {rangeError || !qs ? <EmptyState compact title="Choose a valid date range" body={rangeError ?? undefined} /> : <RangeData key={qs} qs={qs} range={range} admin={admin} metric={metric} setMetric={setMetric} />}
    </div>
  );
}

/** Everything that depends on the chosen dates. It is keyed by the date range, so changing the range starts from a clean loading state instead of showing the previous period's numbers. */
function RangeData({ qs, range, admin, metric, setMetric }: { qs: string; range: { from: string; to: string }; admin: boolean; metric: Metric; setMetric: (m: Metric) => void }) {
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
      {admin && (
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="secondary" onClick={sync} loading={syncing} disabled={!!waitUntil}>
            Update numbers now
          </Button>
          {waitUntil && <span className="text-xs text-muted">You can update again at {waitUntil.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.</span>}
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
  const money = useCallback((n: number) => formatMinor(n, s.currency), [s.currency]);
  const pacingCols = useMemo(() => pacingColumns(money), [money]);
  const c = s.current;
  const p = s.previous;
  const empty = c.spendMinor === 0 && c.impressions === 0 && c.results === 0;
  const count = (n: number) => Math.round(n).toLocaleString();
  const fmt = metric === "spendMinor" ? money : count;
  const label = METRICS.find((m) => m.key === metric)!.label;
  const days = series.data?.days ?? null;
  const axis = metric === "spendMinor" ? (n: number) => compactNumber(n / 10 ** currencyExponent(s.currency)) : compactNumber;

  return (
    <div className="space-y-6">
      {s.mixed && <Alert tone="info">Your ad accounts use different currencies, so money amounts are shown as plain numbers and may not be comparable.</Alert>}
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
            <Stat className="min-w-0" label="Spend" value={wrapValue(money(c.spendMinor))} delta={deltaView(c.spendMinor, p.spendMinor, { neutral: true }) ?? undefined} />
            <Stat className="min-w-0" label="Results" value={wrapValue(c.results.toLocaleString())} hint="Leads, chats or visits" delta={deltaView(c.results, p.results) ?? undefined} />
            <Stat className="min-w-0" label="Cost per result" value={wrapValue(c.costPerResultMinor === null ? "Not available" : money(c.costPerResultMinor))} hint={c.costPerResultMinor === null ? "No results yet" : undefined} delta={deltaView(c.costPerResultMinor, p.costPerResultMinor, { lowerIsBetter: true }) ?? undefined} />
            <Stat className="min-w-0" label="Click rate" value={wrapValue(c.ctr === null ? "Not available" : `${c.ctr}%`)} hint="People who clicked after seeing the ad" delta={deltaView(c.ctr, p.ctr) ?? undefined} />
          </section>

          <section aria-labelledby="trend-heading" className="space-y-2">
            <h2 id="trend-heading" className="text-base font-semibold">
              Day by day
            </h2>
            <div role="group" aria-label="Choose what the chart shows" className="flex flex-wrap gap-2">
              {METRICS.map((m) => (
                <Button key={m.key} size="sm" variant={metric === m.key ? "primary" : "secondary"} aria-pressed={metric === m.key} onClick={() => setMetric(m.key)}>
                  {m.label}
                </Button>
              ))}
            </div>
            {series.error && !days ? (
              <ErrorState title="We could not load the chart" action={<Button variant="secondary" onClick={series.retry}>Try again</Button>} />
            ) : days ? (
              <DailyChart title={`${label} per day`} name={label} days={days.map((d) => d.day)} values={days.map((d) => d[metric])} format={fmt} axisFormat={axis} />
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

function pacingColumns(money: (n: number) => string): Column<PacingRow>[] {
  return [
    { key: "name", header: "Campaign", primary: true, accessor: (r) => r.name },
    { key: "budget", header: "Daily budget", align: "right", accessor: (r) => r.dailyBudgetMinor, cell: (r) => <span className="tabular-nums">{money(r.dailyBudgetMinor)}</span> },
    { key: "spend", header: "Average spend a day", align: "right", accessor: (r) => r.avgDailySpendMinor, cell: (r) => <span className="tabular-nums">{money(r.avgDailySpendMinor)}</span> },
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

function adColumns(money: (n: number) => string): Column<EntityRow>[] {
  return [
    { key: "name", header: "Ad", primary: true, accessor: (r) => r.name },
    { key: "spend", header: "Spend", align: "right", accessor: (r) => r.spendMinor, cell: (r) => <span className="tabular-nums">{money(r.spendMinor)}</span> },
    { key: "results", header: "Results", align: "right", accessor: (r) => r.results, cell: (r) => <span className="tabular-nums">{r.results.toLocaleString()}</span> },
    { key: "cpr", header: "Cost per result", align: "right", accessor: (r) => r.costPerResultMinor, cell: (r) => <span className="tabular-nums">{r.costPerResultMinor === null ? "No results" : money(r.costPerResultMinor)}</span> },
  ];
}

function AdsTable({ title, description, rows, money, empty }: { title: string; description: string; rows: EntityRow[] | null; money: (n: number) => string; empty: string }) {
  const columns = useMemo(() => adColumns(money), [money]);
  return (
    <Card title={title} description={description} headingLevel="h3" padded={false}>
      <DataTable caption={title} columns={columns} rows={rows ?? []} rowKey={(r) => r.entityMetaId} loading={rows === null} skeletonRows={3} className="px-5 pb-5" empty={<EmptyState compact title={empty} />} />
    </Card>
  );
}
