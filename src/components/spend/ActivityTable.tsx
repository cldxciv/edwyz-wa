"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, DataTable, EmptyState, ErrorState, apiFetch, cn, confirm, toast, type Column, type Tone } from "@/components/ui";
import type { LedgerRowDTO, SpendCapabilities } from "@/lib/spend/types";

/*
 * The spending activity (docs/SPEND-CONTROLS-SPEC.md 8.1 ActivityTable, 9.1, 9.2): who changed what, what it could add at
 * worst, and why, newest first, one row per decision. Filters (Ads, WhatsApp, AI, Assistants, Safety stops), a CSV export,
 * the stored "Yesterday" summary, and Undo where the role allows it: undoing a raise (a lowering) for admins and the owner,
 * undoing a lowering (a raise, checked against the limits) for the owner only. Owners and admins only; team members get
 * the totals on the page instead. Reads GET /api/spend/ledger; Undo posts to it.
 */

export const ACTIVITY_TITLE = "Activity";
export const ACTIVITY_FILTERS = [
  { value: "all", label: "All" },
  { value: "ads", label: "Ads" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "ai", label: "AI" },
  { value: "assistants", label: "Assistants" },
  { value: "safety", label: "Safety stops" },
] as const;
export type ActivityFilterValue = (typeof ACTIVITY_FILTERS)[number]["value"];

/** "28 Oct, 14:05" in the workspace's zone. */
export function whenText(iso: string, timezone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const tz = (() => {
    try {
      new Intl.DateTimeFormat("en-IN", { timeZone: timezone });
      return timezone;
    } catch {
      return "Asia/Kolkata";
    }
  })();
  const day = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: tz }).format(d);
  const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz }).format(d);
  return `${day}, ${time}`;
}

/** "Could add (worst case)": the month figure first, else today's. */
export function couldAddText(r: Pick<LedgerRowDTO, "forecastMonth" | "forecastToday">): string {
  if (r.forecastMonth) return `${r.forecastMonth.formatted} this month`;
  if (r.forecastToday) return `${r.forecastToday.formatted} today`;
  return "";
}

/** The small result label next to "What". Null for a plain applied change. */
export function resultBadge(r: Pick<LedgerRowDTO, "phase" | "observe" | "sandbox">): { label: string; tone: Tone } | null {
  if (r.observe && r.phase === "refused") return { label: "Would have been refused", tone: "warn" };
  switch (r.phase) {
    case "refused":
      return { label: "Refused", tone: "bad" };
    case "failed":
      return { label: "Failed", tone: "bad" };
    case "unconfirmed":
      return { label: "Not confirmed yet", tone: "warn" };
    case "requested":
      return { label: "In progress", tone: "info" };
    case "shadow":
      return { label: "Suggestion only", tone: "info" };
    case "reconciled":
      return { label: "Checked with Meta", tone: "neutral" };
    default:
      return r.sandbox ? { label: "Test account", tone: "neutral" } : null;
  }
}

export function activityColumns(timezone: string, onUndo: (r: LedgerRowDTO) => void, busyId: string | null): Column<LedgerRowDTO>[] {
  return [
    { key: "when", header: "When", accessor: (r) => r.createdAt, cell: (r) => <span className="whitespace-nowrap tabular-nums">{whenText(r.createdAt, timezone)}</span> },
    { key: "who", header: "Who", accessor: (r) => r.actor.label },
    {
      key: "what",
      header: "What",
      primary: true,
      accessor: (r) => r.summary,
      cell: (r) => {
        const badge = resultBadge(r);
        return (
          <span className="flex flex-wrap items-center gap-1.5">
            <span>{r.summary}</span>
            {badge && <Badge tone={badge.tone}>{badge.label}</Badge>}
          </span>
        );
      },
    },
    { key: "could", header: "Could add (worst case)", accessor: (r) => couldAddText(r), cell: (r) => <span className="tabular-nums">{couldAddText(r) || <span className="text-muted">-</span>}</span> },
    { key: "why", header: "Why", accessor: (r) => r.reason, cell: (r) => <span className="text-muted">{r.reason}</span> },
    {
      key: "undo",
      header: "Undo",
      srOnlyHeader: true,
      cell: (r) =>
        r.undo.available ? (
          <Button size="sm" variant="secondary" loading={busyId === r.id} onClick={() => onUndo(r)} aria-label={`Undo: ${r.summary}`}>
            Undo
          </Button>
        ) : null,
    },
  ];
}

export function csvHref(filter: ActivityFilterValue): string {
  return `/api/spend/ledger?format=csv${filter === "all" ? "" : `&filter=${filter}`}`;
}

type ViewProps = {
  rows: LedgerRowDTO[];
  timezone: string;
  filter: ActivityFilterValue;
  onFilter: (f: ActivityFilterValue) => void;
  yesterday: string | null;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  hasMore?: boolean;
  onMore?: () => void;
  onUndo: (r: LedgerRowDTO) => void;
  busyId?: string | null;
  canExport: boolean;
};

/** The table without its data loading (rendered by tests). */
export function ActivityTableView({ rows, timezone, filter, onFilter, yesterday, loading, error, onRetry, hasMore, onMore, onUndo, busyId = null, canExport }: ViewProps) {
  return (
    <Card id="activity" title={ACTIVITY_TITLE} description="Every spending change, who made it and why." padded={false}>
      <div className="px-5">
        {yesterday && (
          <div className="mb-4 rounded-control border border-border bg-surface p-3 text-sm" data-testid="yesterday">
            <p className="font-medium">Yesterday</p>
            <p className="mt-0.5 text-muted">{yesterday}</p>
          </div>
        )}
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div role="group" aria-label="Show activity for" className="flex flex-wrap gap-1.5">
            {ACTIVITY_FILTERS.map((f) => (
              <button
                key={f.value}
                type="button"
                aria-pressed={filter === f.value}
                onClick={() => onFilter(f.value)}
                className={cn(
                  "min-h-10 rounded-full border px-3 text-sm font-medium transition-colors duration-(--dur-fast)",
                  filter === f.value ? "border-accent bg-accent-soft text-accent-ink" : "border-border-strong bg-raised text-foreground hover:bg-surface-2",
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
          {canExport && (
            <a href={csvHref(filter)} download className="inline-flex min-h-10 items-center rounded-full border border-border-strong px-4 text-sm font-medium hover:bg-surface-2">
              Export CSV
            </a>
          )}
        </div>
      </div>
      {error ? (
        <div className="px-5 pb-5">
          <ErrorState message={error} action={onRetry ? <Button size="sm" variant="secondary" onClick={onRetry}>Try again</Button> : undefined} />
        </div>
      ) : (
        <DataTable
          columns={activityColumns(timezone, onUndo, busyId)}
          rows={rows}
          rowKey={(r) => r.id}
          caption="Spending activity"
          loading={loading}
          empty={<EmptyState compact title="No spending changes yet" body="Changes to limits, ads, broadcasts and AI will show here." />}
          footer={
            hasMore && onMore ? (
              <Button size="sm" variant="secondary" onClick={onMore}>
                Show older
              </Button>
            ) : undefined
          }
        />
      )}
    </Card>
  );
}

type Page = { rows: LedgerRowDTO[]; nextCursor: string | null; timezone: string };

export function ActivityTable({ capabilities, yesterday, onChanged, refreshKey }: { capabilities: SpendCapabilities; yesterday: string | null; onChanged?: () => void; refreshKey?: string }) {
  const [filter, setFilter] = useState<ActivityFilterValue>("all");
  const [rows, setRows] = useState<LedgerRowDTO[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [timezone, setTimezone] = useState("Asia/Kolkata");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const load = useCallback(
    async (more: string | null) => {
      const q = new URLSearchParams();
      if (filter !== "all") q.set("filter", filter);
      if (more) q.set("cursor", more);
      const qs = q.toString();
      const page = await apiFetch<Page>(`/api/spend/ledger${qs ? `?${qs}` : ""}`);
      setTimezone(page.timezone);
      setCursor(page.nextCursor);
      setRows((prev) => (more ? [...prev, ...page.rows] : page.rows));
    },
    [filter],
  );

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    load(null)
      .catch((e: Error) => live && setError(e.message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [load, tick, refreshKey]);

  async function undo(r: LedgerRowDTO) {
    const ok = await confirm({
      title: "Undo this change?",
      body: r.undo.isRaise ? `${r.summary}. Undoing it raises spending, so it's checked against your limits first.` : `${r.summary}. Undoing it lowers spending.`,
      confirmLabel: "Undo",
    });
    if (!ok) return;
    setBusyId(r.id);
    try {
      const res = await apiFetch<{ text: string; wouldRefuse?: boolean }>("/api/spend/ledger", { method: "POST", body: { undo: r.id } });
      toast.success(res.text);
      setTick((n) => n + 1);
      onChanged?.();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  if (!capabilities.canSeeActivity) return null;
  return (
    <ActivityTableView
      rows={rows}
      timezone={timezone}
      filter={filter}
      onFilter={(f) => {
        setFilter(f);
        setRows([]);
      }}
      yesterday={yesterday}
      loading={loading}
      error={error}
      onRetry={() => setTick((n) => n + 1)}
      hasMore={!!cursor}
      onMore={() => void load(cursor).catch((e: Error) => toast.error(e.message))}
      onUndo={(r) => void undo(r)}
      busyId={busyId}
      canExport={capabilities.canExportActivity}
    />
  );
}
