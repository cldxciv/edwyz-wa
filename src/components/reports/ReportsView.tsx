"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Card, DataTable, EmptyState, ErrorState, FormField, Input, Skeleton, Stat, StatusPill, apiFetch, buttonSizes, buttonVariants, cn, type Column } from "@/components/ui";
import { PageHeader } from "@/components/app/PageHeader";
import { Dropdown } from "@/components/app/Dropdown";
import { canManage, useRole } from "@/components/contacts/hooks";
import { formatDuration } from "@/lib/reports/stats";
import type { Overview } from "@/lib/reports/metrics";
import { BarChart, LineChart } from "./Charts";
import { ReplyTimes } from "./ReplyTimes";
import { PRESETS, failureTitle, formatPercent, presetLabel, presetRange, rangeProblem, rangeText, shareText, sum } from "./helpers";
import { useBrowserTimeZone } from "./useBrowserTimeZone";

type Loaded = { key: string; data: Overview } | { key: string; error: string };

/** Fetches the report. Old numbers stay on screen while a new range loads, so the page never jumps to a spinner. */
function useOverview(path: string | null) {
  const [tick, setTick] = useState(0);
  const [result, setResult] = useState<Loaded | null>(null);
  const key = path === null ? "" : `${path}#${tick}`;
  const [lastData, setLastData] = useState<Overview | null>(null);

  useEffect(() => {
    if (path === null) return;
    let live = true;
    apiFetch<Overview>(path)
      .then((data) => {
        if (!live) return;
        setLastData(data);
        setResult({ key, data });
      })
      .catch((e: Error) => live && setResult({ key, error: e.message }));
    return () => {
      live = false;
    };
  }, [path, key]);

  const settled = result?.key === key;
  const error = settled && result && "error" in result ? result.error : null;
  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { data: lastData, error, refreshing: path !== null && !settled, loading: path !== null && !settled && lastData === null, reload };
}

export function ReportsView() {
  const role = useRole();
  const manager = canManage(role);
  // Known only after mount; until then the page shows the loading state so server and client render the same HTML.
  const browserTz = useBrowserTimeZone();
  const tz = browserTz ?? "UTC";
  const [preset, setPreset] = useState<number | "custom">(30);
  const [custom, setCustom] = useState(() => presetRange(30, "UTC"));
  useEffect(() => {
    if (browserTz) setCustom(presetRange(30, browserTz));
  }, [browserTz]);
  const range = preset === "custom" ? custom : presetRange(preset, tz);

  const problem = rangeProblem(range.from, range.to);
  const path = problem || !browserTz ? null : `/api/reports/overview?from=${range.from}&to=${range.to}&tz=${encodeURIComponent(tz)}`;
  const { data, error, loading, refreshing, reload } = useOverview(path);

  const msgQuery = `from=${range.from}&to=${range.to}&tz=${encodeURIComponent(tz)}`;
  const exportItems = [
    { label: "Contacts", description: "Spreadsheet (CSV)", onSelect: () => download("/api/export/contacts.csv") },
    { label: "Contacts (JSON)", description: "For other software", onSelect: () => download("/api/export/contacts.csv?format=json") },
    { label: "Leads", description: "Spreadsheet (CSV)", onSelect: () => download("/api/export/leads.csv") },
    { label: "Leads (JSON)", description: "For other software", onSelect: () => download("/api/export/leads.csv?format=json") },
    { label: "Broadcasts", description: "Spreadsheet (CSV)", onSelect: () => download("/api/export/broadcasts.csv") },
    { label: "Broadcasts (JSON)", description: "For other software", onSelect: () => download("/api/export/broadcasts.csv?format=json") },
    { label: "Messages in this date range", description: "Spreadsheet (CSV)", onSelect: () => download(`/api/export/messages.csv?${msgQuery}`) },
    { label: "Messages in this date range (JSON)", description: "For other software", onSelect: () => download(`/api/export/messages.csv?${msgQuery}&format=json`) },
    { separator: true as const },
    { label: "Everything in your workspace", description: "Full backup (JSON)", onSelect: () => download("/api/export/workspace.json") },
  ];

  return (
    <div>
      <PageHeader
        title="Reports"
        description="See how your WhatsApp conversations are going: messages, reply times and broadcast results."
        actions={
          manager && (
            <Dropdown
              label="Download data"
              trigger={<>Download data</>}
              items={exportItems}
              triggerClassName={cn("min-h-10 px-5 text-sm font-semibold", buttonVariants.secondary)}
            />
          )
        }
      />

      <div className="mb-4 flex flex-wrap items-end gap-2" role="group" aria-label="Date range">
        {PRESETS.map((d) => (
          <Button key={d} variant={preset === d ? "primary" : "secondary"} aria-pressed={preset === d} onClick={() => setPreset(d)}>
            {presetLabel(d)}
          </Button>
        ))}
        <Button variant={preset === "custom" ? "primary" : "secondary"} aria-pressed={preset === "custom"} onClick={() => setPreset("custom")}>
          Custom dates
        </Button>
      </div>
      {preset === "custom" && (
        <div className="mb-4 grid max-w-md grid-cols-1 gap-3 min-[420px]:grid-cols-2">
          <FormField label="From">
            <Input type="date" value={custom.from} max={custom.to} onChange={(e) => setCustom({ ...custom, from: e.target.value })} />
          </FormField>
          <FormField label="To">
            <Input type="date" value={custom.to} min={custom.from} onChange={(e) => setCustom({ ...custom, to: e.target.value })} />
          </FormField>
        </div>
      )}
      {problem && (
        <Alert tone="bad" className="mb-4">
          {problem}
        </Alert>
      )}

      <div aria-busy={refreshing || undefined}>
        {error ? (
          <ErrorState title="We could not load your reports" message="Check your connection and try again. If it keeps happening, contact support." action={<Button variant="secondary" onClick={reload}>Try again</Button>} />
        ) : loading || (!browserTz && !problem) ? (
          <ReportSkeleton />
        ) : data ? (
          <div className={cn("transition-opacity duration-(--dur-base)", refreshing && "opacity-60")}>
            <Body data={data} />
          </div>
        ) : null}
      </div>
      <p className="mt-6 text-xs text-muted" aria-live="polite">
        {refreshing && data ? "Updating... " : ""}
        Showing {rangeText(range.from, range.to)}, both days included. Days follow your time zone ({tz}).
      </p>
    </div>
  );
}

function download(url: string) {
  window.location.assign(url);
}

function ReportSkeleton() {
  return (
    <div className="space-y-6" role="status">
      <span className="sr-only">Loading reports</span>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Stat key={i} label="Loading" value="" loading />
        ))}
      </div>
      <Skeleton className="h-72 w-full" />
      <Skeleton className="h-72 w-full" />
    </div>
  );
}

function replyTime(seconds: number | null): string {
  return seconds === null ? "No replies yet" : formatDuration(seconds);
}

function Body({ data }: { data: Overview }) {
  const days = data.messagesPerDay.map((d) => d.day);
  const col = (k: "inbound" | "outbound" | "sent" | "delivered" | "read" | "failed") => data.messagesPerDay.map((d) => d[k]);
  const received = sum(col("inbound"));
  const sent = sum(col("outbound"));
  const failed = sum(col("failed"));
  const fr = data.firstResponse;

  if (received + sent === 0 && sum(data.conversationsOpenedPerDay.map((d) => d.count)) === 0) {
    return (
      <EmptyState
        title="No activity in this period"
        body="When you send or receive WhatsApp messages, charts and reply times appear here. Try a longer date range, or start a conversation."
        action={
          <Link href="/app/inbox" className={cn("inline-flex items-center justify-center rounded-full font-semibold", buttonVariants.primary, buttonSizes.md)}>
            Open inbox
          </Link>
        }
      />
    );
  }

  return (
    <div className="space-y-6">
      <section aria-label="Summary" className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Messages received" value={received.toLocaleString()} />
        <Stat label="Messages sent" value={sent.toLocaleString()} />
        <Stat label="Messages that failed" value={failed.toLocaleString()} hint={sent > 0 ? `${shareText(failed, sent)} of sent` : "None sent yet"} />
        <Stat
          label="Typical first reply time"
          value={replyTime(fr.medianSeconds)}
          hint={fr.conversations ? `9 in 10 replies within ${replyTime(fr.p90Seconds)}, across ${fr.conversations.toLocaleString()} conversations${fr.capped ? " (most recent)" : ""}` : "Appears after your first reply"}
        />
      </section>
      {data.messagesSource !== "live" && <p className="text-xs text-muted">Older days come from stored daily summaries.</p>}
      <ReplyTimes data={data.responseTimes} />

      <LineChart
        title="Messages per day"
        description="Received and sent messages, and how many were delivered, read or failed."
        days={days}
        series={[
          { name: "Received", values: col("inbound"), tone: "info" },
          { name: "Sent", values: col("sent"), tone: "accent" },
          { name: "Delivered", values: col("delivered"), tone: "warn" },
          { name: "Read", values: col("read"), tone: "muted" },
          { name: "Failed", values: col("failed"), tone: "bad" },
        ]}
      />
      <BarChart title="New conversations per day" description="Customers who started a new conversation with you." days={days} values={data.conversationsOpenedPerDay.map((d) => d.count)} name="New conversations" />
      <p className="text-xs text-muted">We do not track how long it takes to resolve a conversation yet.</p>

      {data.admin && <TeamBody data={data} days={days} />}
    </div>
  );
}

type Broadcast = NonNullable<Overview["admin"]>["broadcasts"][number];
type Agent = NonNullable<Overview["admin"]>["agents"][number];
type Failure = NonNullable<Overview["admin"]>["failureCodes"][number];

const broadcastColumns: Column<Broadcast>[] = [
  { key: "name", header: "Broadcast", primary: true, accessor: (b) => b.name, sortable: true, cell: (b) => <span className="font-medium">{b.name}</span> },
  { key: "status", header: "Status", cell: (b) => <StatusPill status={b.status} /> },
  { key: "sent", header: "Sent", align: "right", accessor: (b) => b.sent, sortable: true, cell: (b) => b.sent.toLocaleString() },
  { key: "delivered", header: "Delivered", align: "right", accessor: (b) => b.delivered, sortable: true, cell: (b) => b.delivered.toLocaleString() },
  { key: "read", header: "Read", align: "right", accessor: (b) => b.read, sortable: true, cell: (b) => b.read.toLocaleString() },
  { key: "failed", header: "Failed", align: "right", accessor: (b) => b.failed, sortable: true, cell: (b) => b.failed.toLocaleString() },
  { key: "deliveryRate", header: "Delivery rate", align: "right", accessor: (b) => b.deliveryRate, sortable: true, cell: (b) => formatPercent(b.deliveryRate) },
  { key: "readRate", header: "Read rate", align: "right", accessor: (b) => b.readRate, sortable: true, cell: (b) => formatPercent(b.readRate) },
];

const agentColumns: Column<Agent>[] = [
  { key: "name", header: "Team member", primary: true, accessor: (a) => a.name, sortable: true },
  { key: "messages", header: "Messages sent", align: "right", accessor: (a) => a.messages, sortable: true, cell: (a) => a.messages.toLocaleString() },
];

const failureColumns: Column<Failure>[] = [
  { key: "problem", header: "What went wrong", primary: true, cell: (f) => failureTitle(f.hint, f.code) },
  { key: "count", header: "Messages", align: "right", accessor: (f) => f.count, sortable: true, cell: (f) => f.count.toLocaleString() },
  {
    key: "code",
    header: "More detail",
    cell: (f) => (
      <details>
        <summary className="inline-flex min-h-8 cursor-pointer items-center text-xs text-accent-ink underline underline-offset-2">Details</summary>
        <p className="text-xs text-muted">
          WhatsApp error code <span className="font-mono">{f.code}</span>. Look it up in Meta&apos;s error code list for the exact cause.
        </p>
      </details>
    ),
  },
];

function TeamBody({ data, days }: { data: Overview; days: string[] }) {
  const a = data.admin!;
  return (
    <>
      <LineChart
        title="Opt-ins and opt-outs per day"
        description="People who agreed to receive your marketing messages, and people who asked you to stop."
        days={days}
        series={[
          { name: "Opted in", values: a.optInsPerDay.map((d) => d.optIns), tone: "accent" },
          { name: "Opted out", values: a.optInsPerDay.map((d) => d.optOuts), tone: "bad" },
        ]}
      />

      <Card title="Broadcast results" description="How each broadcast sent in this period performed." padded={false}>
        <DataTable
          className="max-sm:p-3"
          caption="Broadcast results"
          columns={broadcastColumns}
          rows={a.broadcasts}
          rowKey={(b) => b.id}
          empty={
            <div className="px-5 pb-5">
              <EmptyState compact title="No broadcasts in this period" body="Send a broadcast to reach many customers at once. Results show up here." action={<Link href="/app/broadcasts" className={cn("inline-flex items-center justify-center rounded-full font-semibold", buttonVariants.secondary, buttonSizes.md)}>Go to broadcasts</Link>} />
            </div>
          }
        />
      </Card>

      <div className="grid gap-6 md:grid-cols-2">
        <Card title="Replies by team member" padded={false}>
          <DataTable
            className="max-sm:p-3"
            caption="Messages sent by each team member"
            columns={agentColumns}
            rows={a.agents}
            rowKey={(m) => m.userId}
            empty={
              <div className="px-5 pb-5">
                <EmptyState compact title="No replies from your team yet" body="Messages your team members send from the inbox are counted here." />
              </div>
            }
          />
        </Card>
        <Card title="Why messages failed" padded={false}>
          <DataTable
            className="max-sm:p-3"
            caption="Reasons messages failed"
            columns={failureColumns}
            rows={a.failureCodes}
            rowKey={(f) => f.code}
            empty={
              <div className="px-5 pb-5">
                <EmptyState compact title="No failed messages" body="Good news: every message in this period was accepted." />
              </div>
            }
          />
        </Card>
      </div>
    </>
  );
}
