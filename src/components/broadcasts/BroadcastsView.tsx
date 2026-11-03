"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Alert, Button, EmptyState, ErrorState, Input, ProgressBar, Select, StatusPill, Tabs, DataTable, type Column } from "@/components/ui";
import { PageHeader } from "@/components/app/PageHeader";
import { canManage, useApi, useRole } from "@/components/contacts/hooks";
import { CampaignCalendar, monthOfDateParam } from "./CampaignCalendar";
import { LinkButton } from "./LinkButton";
import { OverviewPanels } from "./OverviewPanels";
import { type Counts, STATUS_FILTERS, broadcastStatusView, filterBroadcasts, formatWhen, friendlyError, progressPercent, progressText, totalOf } from "./helpers";

export type BroadcastItem = {
  id: string;
  name: string;
  status: string;
  segmentTags: string[];
  scheduledAt: string | null;
  createdAt: string;
  counts: Counts;
};

function whenText(b: BroadcastItem): string {
  if (b.scheduledAt && b.status === "scheduled") return `Scheduled for ${formatWhen(b.scheduledAt)}`;
  return `Created ${new Date(b.createdAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`;
}

const COLUMNS: Column<BroadcastItem>[] = [
  {
    key: "name",
    header: "Broadcast",
    primary: true,
    cell: (b) => (
      <div className="min-w-0">
        <Link href={`/app/broadcasts/${b.id}`} className="font-medium underline-offset-2 hover:underline">
          {b.name}
          <span className="sr-only">, view broadcast</span>
        </Link>
        <p className="text-xs text-muted">{whenText(b)}</p>
      </div>
    ),
  },
  { key: "status", header: "Status", cell: (b) => <StatusPill status={b.status} label={broadcastStatusView(b.status).label} /> },
  {
    key: "progress",
    header: "Progress",
    className: "sm:w-56",
    cell: (b) => (
      <div className="w-full min-w-0">
        <ProgressBar value={progressPercent(b.counts)} label={`${b.name} progress`} size="sm" />
        <p className="mt-1 text-xs text-muted">{progressText(b.counts)}</p>
      </div>
    ),
  },
  { key: "recipients", header: "People", align: "right", cell: (b) => (totalOf(b.counts) ? totalOf(b.counts).toLocaleString() : <span className="text-muted">Not started</span>) },
];

function BroadcastList({ admin }: { admin: boolean }) {
  const { data, error, loading, reload } = useApi<{ items: BroadcastItem[] }>("/api/broadcasts", 5000);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const items = data?.items;
  const shown = useMemo(() => (items ? filterBroadcasts(items, query, status) : []), [items, query, status]);

  if (error && !data) {
    return (
      <ErrorState
        title="We could not load your broadcasts"
        message={`${friendlyError(error, "Something went wrong on our side.")} Check your connection and try again.`}
        action={<Button variant="secondary" onClick={reload}>Try again</Button>}
      />
    );
  }

  const filtering = query.trim() !== "" || status !== "all";
  const clear = () => {
    setQuery("");
    setStatus("all");
  };

  const empty = filtering ? (
    <EmptyState
      compact
      title={query.trim() ? `No broadcasts match "${query.trim()}"` : "No broadcasts with this status"}
      body="Try a different search or show all broadcasts."
      action={<Button variant="secondary" onClick={clear}>Clear filters</Button>}
    />
  ) : (
    <EmptyState
      title="No broadcasts yet"
      body={
        admin
          ? "A broadcast sends one approved message to many contacts at once, for example an offer or an update. You need a connected number, an approved template and contacts who opted in."
          : "A broadcast sends one approved message to many contacts at once. Ask an owner or admin to create the first one."
      }
      action={
        admin ? (
          <>
            <LinkButton href="/app/broadcasts/new">Create your first broadcast</LinkButton>
            <LinkButton href="/app/templates" variant="secondary">Check your templates</LinkButton>
            <LinkButton href="/app/contacts" variant="secondary">Add contacts</LinkButton>
          </>
        ) : undefined
      }
    />
  );

  return (
    <div>
      {error && data && <Alert tone="warn" className="mb-3">We could not refresh just now. You are seeing the last list we loaded.</Alert>}
      {(items?.length ?? 0) > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Input type="search" aria-label="Search broadcasts by name" placeholder="Search by name" value={query} onChange={(e) => setQuery(e.target.value)} className="w-full sm:w-64" />
          <Select aria-label="Show broadcasts with status" value={status} onChange={(e) => setStatus(e.target.value)} className="w-full sm:w-48">
            {STATUS_FILTERS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </Select>
          <p role="status" className="text-sm text-muted">
            {shown.length === items!.length ? `${items!.length} broadcast${items!.length === 1 ? "" : "s"}` : `${shown.length} of ${items!.length} shown`}
          </p>
        </div>
      )}
      {!loading && items?.length === 0 ? (
        empty
      ) : (
        <DataTable caption="Broadcasts" columns={COLUMNS} rows={shown} rowKey={(b) => b.id} loading={loading} empty={empty} />
      )}
    </div>
  );
}

export function BroadcastsView() {
  const role = useRole();
  const admin = canManage(role);
  const [mode, setMode] = useState("list");
  // Back from planning a broadcast on a calendar day (?date=): show the calendar, which opens on that month.
  useEffect(() => {
    if (monthOfDateParam(new URLSearchParams(window.location.search).get("date"))) setMode("calendar");
  }, []);

  return (
    <div>
      <PageHeader
        title="Broadcasts"
        description="Send an approved message to contacts who opted in. We pace sending to your number's daily limit for you."
        actions={admin && <LinkButton href="/app/broadcasts/new">New broadcast</LinkButton>}
      />
      <OverviewPanels />
      <Tabs
        label="Broadcast views"
        variant="pill"
        value={mode}
        onChange={setMode}
        tabs={[
          { id: "list", label: "List", content: <BroadcastList admin={admin} /> },
          { id: "calendar", label: "Calendar", content: <CampaignCalendar /> },
        ]}
      />
    </div>
  );
}
