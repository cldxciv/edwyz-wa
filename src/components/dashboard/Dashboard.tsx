"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useApi } from "@/components/contacts/hooks";
import { UsageMeter } from "@/components/reports/UsageMeter";
import { useBrowserTimeZone } from "@/components/reports/useBrowserTimeZone";
import { actionLinkClass, EmptyState } from "@/components/setup/EmptyState";
import { SetupCard } from "@/components/setup/SetupCard";
import { WelcomeDialog } from "@/components/setup/WelcomeDialog";
import { Button } from "@/components/ui";
import type { DashboardData } from "@/lib/setup/dashboard";
import { AttentionList, WaitingList } from "./AttentionList";
import { DashboardSkeleton } from "./DashboardSkeleton";
import { greetingFor, quickActionsFor } from "./helpers";
import { KpiTile } from "./KpiTile";
import { QuickActions } from "./QuickActions";
import { DataTable, WeekChart } from "./WeekChart";

const REFRESH_MS = 60_000;

function Panel({ title, id, children, className }: { title: string; id: string; children: ReactNode; className?: string }) {
  return (
    <section aria-labelledby={id} className={`rounded-2xl border border-border bg-background p-5 ${className ?? ""}`}>
      <h2 id={id} className="mb-3 text-base font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

function ActivityPanel({ data }: { data: DashboardData }) {
  if (data.days.length === 0) {
    return <EmptyState compact illustration="offline" title="The chart is not available right now" body="Reload the page in a minute. Your messages are safe." />;
  }
  if (data.quiet) {
    return (
      <EmptyState
        illustration="chart"
        title="No messages yet"
        body={data.connected ? "When customers write to you, or you send your first broadcast, your week shows up here." : "Once your WhatsApp number is connected, your messages and replies will be charted here."}
        action={
          data.role === "agent" ? undefined : (
            <Link href={data.connected ? "/app/broadcasts/new" : "/app/settings/connect"} className={actionLinkClass(true)}>
              {data.connected ? "Send a broadcast" : "Connect WhatsApp"}
            </Link>
          )
        }
      />
    );
  }
  return (
    <>
      <WeekChart days={data.days} />
      <DataTable days={data.days} />
    </>
  );
}

function AgentView({ data }: { data: DashboardData }) {
  const { queue } = data;
  return (
    <div className="grid gap-6 lg:grid-cols-5">
      <Panel id="my-queue" title="Your chats waiting for a reply" className="lg:col-span-3">
        <WaitingList items={queue.items} total={queue.total} emptyText="Chats assigned to you that need a reply will show here, longest wait first." />
        {queue.unassigned > 0 && (
          <p className="mt-4 rounded-xl bg-surface p-3 text-sm">
            {queue.unassigned} {queue.unassigned === 1 ? "chat has" : "chats have"} nobody assigned.{" "}
            <Link href="/app/inbox" className="font-medium text-accent underline underline-offset-2">
              Pick one up in the inbox
            </Link>
          </p>
        )}
      </Panel>
      <Panel id="shortcuts" title="Shortcuts" className="lg:col-span-2">
        <QuickActions actions={quickActionsFor(data.role, data.connected)} />
      </Panel>
    </div>
  );
}

function AdminView({ data }: { data: DashboardData }) {
  const { queue } = data;
  return (
    <>
      <div className="grid gap-6 lg:grid-cols-5">
        <Panel id="attention" title="Needs your attention" className="lg:col-span-3">
          <AttentionList items={data.attention} />
        </Panel>
        <Panel id="shortcuts" title="Quick actions" className="lg:col-span-2">
          <QuickActions actions={quickActionsFor(data.role, data.connected)} />
        </Panel>
      </div>
      <div className="grid gap-6 lg:grid-cols-5">
        <Panel id="week" title="Messages this week" className="lg:col-span-3">
          <ActivityPanel data={data} />
        </Panel>
        <Panel id="waiting" title="Chats waiting longest" className="lg:col-span-2">
          <WaitingList items={queue.items} total={queue.total} emptyText="Every customer who wrote to you has had a reply." />
        </Panel>
      </div>
      <UsageMeter />
    </>
  );
}

/** The home screen: a greeting, setup progress, the week in numbers, and what needs a person. Admins see the workspace; agents see their own queue. */
export function Dashboard() {
  const tz = useBrowserTimeZone();
  const { data, error, loading, reload } = useApi<DashboardData>(tz ? `/api/setup/dashboard?tz=${encodeURIComponent(tz)}` : null, REFRESH_MS);

  if (!data) {
    if (!tz || loading) return <DashboardSkeleton />;
    return (
      <EmptyState
        tone="error"
        title="We could not load your dashboard"
        body={error ?? "Please check your connection and try again."}
        action={<Button onClick={reload}>Try again</Button>}
        secondary={
          <Link href="/app/inbox" className={actionLinkClass(false)}>
            Go to inbox
          </Link>
        }
      />
    );
  }

  const isAdmin = data.role !== "agent";
  const greeting = greetingFor(new Date().getHours(), data.firstName);

  return (
    <div className="space-y-8">
      <WelcomeDialog userId={data.userId} firstName={data.firstName} canSetUp={isAdmin} />
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{greeting}</h1>
        <p className="mt-1 text-sm text-muted">
          {isAdmin ? `Here is how ${data.workspaceName || "your workspace"} is doing this week.` : "Here is your day at a glance."}
        </p>
      </header>

      {error && (
        <p role="status" className="rounded-xl bg-amber-50 px-4 py-2 text-sm text-amber-900">
          We could not refresh just now, so these numbers may be a little old.{" "}
          <button type="button" className="underline" onClick={reload}>
            Refresh
          </button>
        </p>
      )}

      {isAdmin && <SetupCard />}

      {!isAdmin && !data.connected && (
        <EmptyState compact illustration="connect" title="WhatsApp is not connected yet" body="Ask a workspace admin to connect the business number. Your chats will appear here as soon as they do." />
      )}

      <section aria-labelledby="week-numbers">
        <h2 id="week-numbers" className="sr-only">
          Your week in numbers
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {data.kpis.map((k) => (
            <KpiTile key={k.id} kpi={k} />
          ))}
        </div>
        {!isAdmin && !data.quiet && data.days.length > 0 && <DataTable days={data.days} />}
      </section>

      {isAdmin ? <AdminView data={data} /> : <AgentView data={data} />}
    </div>
  );
}
