"use client";

import { displayName } from "@/lib/contacts/identity";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, DataTable, EmptyState, ErrorState, FormField, Select, StatusPill, apiFetch, type Column, type Tone } from "@/components/ui";

export type BotSession = {
  id: string;
  conversationId: string;
  status: string;
  startedAt: string;
  updatedAt: string;
  endedAt: string | null;
  wakeAt: string | null;
  contact: { name: string | null; phone: string | null; bsuid?: string | null; username?: string | null } | null;
};

type Stats = { days: number; total: number; counts: Record<string, number>; completionPercent: number; handoffPercent: number; expiredPercent: number };
type Page = { items: BotSession[]; nextCursor: string | null };

export const SESSION_LABEL: Record<string, { label: string; tone: Tone }> = {
  active: { label: "Running", tone: "info" },
  waiting: { label: "Waiting for the customer", tone: "info" },
  completed: { label: "Finished", tone: "good" },
  handed_off: { label: "Handed to your team", tone: "warn" },
  expired: { label: "Timed out", tone: "bad" },
};

const FILTERS = [
  { value: "", label: "All sessions" },
  ...Object.entries(SESSION_LABEL).map(([value, v]) => ({ value, label: v.label })),
];

const WHEN = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** How long the session ran, in the largest sensible unit. Open sessions show how long they have been open. */
export function sessionLength(startedAt: string, endedAt: string | null, now: number = Date.now()): string {
  const ms = Math.max(0, (endedAt ? new Date(endedAt).getTime() : now) - new Date(startedAt).getTime());
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "Under a minute";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} h ${minutes % 60} min` : `${Math.floor(hours / 24)} d ${hours % 24} h`;
}

/** The inbox opens the chat named in the address. */
export const chatHref = (conversationId: string) => `/app/inbox?c=${encodeURIComponent(conversationId)}`;

function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-card border border-border bg-raised p-3">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-0.5 text-xl font-semibold">{value}</p>
      {hint && <p className="text-xs text-muted">{hint}</p>}
    </div>
  );
}

export function SessionsPanel({ chatbotId }: { chatbotId: string }) {
  const [status, setStatus] = useState("");
  const [rows, setRows] = useState<BotSession[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statsFailed, setStatsFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const seq = useRef(0);

  const load = useCallback(
    async (from: string | null) => {
      const mine = ++seq.current;
      from ? setMore(true) : setLoading(true);
      try {
        const q = new URLSearchParams({ limit: "30" });
        if (status) q.set("status", status);
        if (from) q.set("cursor", from);
        const page = await apiFetch<Page>(`/api/chatbots/${chatbotId}/sessions?${q}`);
        if (mine !== seq.current) return;
        setRows((prev) => (from ? [...prev, ...page.items] : page.items));
        setCursor(page.nextCursor);
        setError(null);
      } catch (e) {
        if (mine !== seq.current) return;
        if (!from) {
          setRows([]);
          setCursor(null);
        }
        setError(e instanceof Error ? e.message : "Could not load sessions.");
      } finally {
        if (mine === seq.current) {
          setLoading(false);
          setMore(false);
        }
      }
    },
    [chatbotId, status],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  const loadStats = useCallback(() => {
    setStatsFailed(false);
    apiFetch<Stats>(`/api/chatbots/${chatbotId}/stats`).then(setStats, () => {
      setStats(null);
      setStatsFailed(true);
    });
  }, [chatbotId]);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  const columns: Column<BotSession>[] = [
    {
      key: "customer",
      header: "Customer",
      primary: true,
      cell: (r) => <span className="font-medium">{r.contact ? displayName(r.contact) : "Unknown contact"}</span>,
    },
    {
      key: "status",
      header: "Outcome",
      cell: (r) => {
        const v = SESSION_LABEL[r.status];
        return <StatusPill status={r.status} label={v?.label} tone={v?.tone} />;
      },
    },
    { key: "started", header: "Started", cell: (r) => <span className="text-muted">{WHEN.format(new Date(r.startedAt))}</span> },
    { key: "length", header: "Time", cell: (r) => <span className="text-muted">{sessionLength(r.startedAt, r.endedAt)}</span> },
    {
      key: "chat",
      header: "Chat",
      cell: (r) => (
        <Link href={chatHref(r.conversationId)} className="inline-flex min-h-10 items-center font-medium text-accent underline underline-offset-2">
          Open chat
        </Link>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      {statsFailed && (
        <Alert tone="warn" action={<Button size="sm" variant="secondary" onClick={loadStats}>Try again</Button>}>
          The summary numbers could not be loaded.
        </Alert>
      )}
      {stats && (
        <div>
          <p className="mb-2 text-sm font-medium">Last {stats.days} days</p>
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            <StatTile label="Conversations" value={String(stats.total)} />
            <StatTile label="Finished" value={`${stats.completionPercent}%`} hint={`${stats.counts.completed ?? 0} chats`} />
            <StatTile label="Handed to your team" value={`${stats.handoffPercent}%`} hint={`${stats.counts.handed_off ?? 0} chats`} />
            <StatTile label="Timed out" value={`${stats.expiredPercent}%`} hint={`${stats.counts.expired ?? 0} chats`} />
          </div>
        </div>
      )}

      <div className="max-w-xs">
        <FormField label="Show">
          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            {FILTERS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </Select>
        </FormField>
      </div>

      {error && rows.length === 0 ? (
        <ErrorState title="We could not load the sessions" message="Check your connection and try again." action={<Button onClick={() => void load(null)}>Try again</Button>} />
      ) : (
        <DataTable
          caption="Chatbot sessions"
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          loading={loading}
          skeletonRows={4}
          empty={<EmptyState title="No sessions yet" body="When a customer talks to this chatbot, each conversation is listed here with how it ended." />}
        />
      )}
      {error && rows.length > 0 && (
        <Alert tone="bad" action={<Button size="sm" variant="secondary" onClick={() => void load(cursor)}>Try again</Button>}>
          We could not load more sessions. {error}
        </Alert>
      )}
      {cursor && (
        <div className="text-center">
          <Button variant="secondary" loading={more} onClick={() => void load(cursor)}>
            Show more
          </Button>
        </div>
      )}
    </div>
  );
}
