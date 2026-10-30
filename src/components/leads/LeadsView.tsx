"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Card, DataTable, EmptyState, ErrorState, FormField, PageHeader, Select, Skeleton, Stat, StatusPill, Tabs, apiFetch, buttonSizes, buttonVariants, cn, tabIds, toast, type Column } from "@/components/ui";
import { canManage, useRole } from "@/components/contacts/hooks";
import { dispatchEddyEvent } from "@/components/eddy/events";
import { LeadDrawer } from "./LeadDrawer";
import { LeadsNav } from "./LeadsNav";
import { ConsentBadge, ResponseBadge } from "./LeadParts";
import { PipelineBoard } from "./PipelineBoard";
import { STATUSES, formatResponse, friendlyError, leadDisplayName, leadStatusLabel, summarizeLeads } from "./helpers";
import { useNow } from "./useNow";
import type { Agent, LeadDetail, LeadItem } from "./types";

type Page = { items: LeadItem[]; nextCursor: string | null };
type View = "pipeline" | "table";

const VIEW_KEY = "wa-leads-view";
const VIEW_ID = "leads-view";
const VIEW_TABS = [
  { id: "pipeline", label: "Pipeline" },
  { id: "table", label: "Table" },
];

function readView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === "table" ? "table" : "pipeline";
  } catch {
    return "pipeline";
  }
}

function stripDetail(lead: LeadDetail): LeadItem {
  const { fields: _fields, sequences: _sequences, ...item } = lead;
  return item;
}

export function LeadsView() {
  const role = useRole();
  const admin = canManage(role);
  const now = useNow();
  const [view, setViewState] = useState<View>("pipeline");
  const [status, setStatus] = useState("");
  const [rows, setRows] = useState<LeadItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loadedStatus, setLoadedStatus] = useState("");
  const [focusId, setFocusId] = useState<string | null>(null);
  const request = useRef(0);
  const loadedRef = useRef("");

  const effectiveStatus = view === "table" ? status : "";

  useEffect(() => setViewState(readView()), []);

  const setView = (next: string) => {
    const v: View = next === "table" ? "table" : "pipeline";
    setViewState(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      // the choice just does not persist
    }
  };

  const load = useCallback(async (after: string | null, st: string) => {
    const mine = ++request.current;
    if (after) setLoadingMore(true);
    else setLoading(true);
    const params = new URLSearchParams();
    if (st) params.set("status", st);
    if (after) params.set("cursor", after);
    try {
      const page = await apiFetch<Page>(`/api/leads?${params}`);
      if (mine !== request.current) return;
      setRows((prev) => (after ? [...prev, ...page.items] : page.items));
      setCursor(page.nextCursor);
      setError("");
      loadedRef.current = st;
      setLoadedStatus(st);
    } catch (e) {
      if (mine !== request.current) return;
      if (after) toast.error("We could not load more leads", { description: friendlyError(e) });
      else {
        if (loadedRef.current !== st) {
          setRows([]);
          setCursor(null);
        }
        setError(friendlyError(e));
      }
    } finally {
      if (mine === request.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, []);

  useEffect(() => {
    void load(null, effectiveStatus);
  }, [effectiveStatus, load]);

  useEffect(() => {
    apiFetch<{ agents: Agent[] }>("/api/routing/agents")
      .then((r) => setAgents(r.agents))
      .catch(() => setAgents([]));
  }, []);

  const assigneeName = useCallback(
    (id: string | null) => {
      if (!id) return "Unassigned";
      const a = agents.find((x) => x.userId === id);
      return a ? (a.name ?? a.email) : "A teammate";
    },
    [agents],
  );

  const merge = useCallback((lead: LeadDetail) => {
    const item = stripDetail(lead);
    setRows((all) => all.map((r) => (r.id === item.id ? item : r)));
  }, []);

  const setLeadStatus = useCallback(
    async (lead: LeadItem, next: string, allowUndo: boolean) => {
      if (next === lead.status) return;
      setBusyId(lead.id);
      try {
        const r = await apiFetch<{ lead: LeadDetail }>(`/api/leads/${lead.id}`, { method: "PATCH", body: { status: next } });
        merge(r.lead);
        const message = `${leadDisplayName(lead)} is now ${leadStatusLabel(next).toLowerCase()}`;
        if (allowUndo) toast.success(message, { action: { label: "Undo", onAction: () => void setLeadStatus({ ...lead, status: next }, lead.status, false) } });
        else toast.success(message);
      } catch (e) {
        toast.error("We could not change that lead", { description: friendlyError(e) });
      } finally {
        setBusyId(null);
      }
    },
    [merge],
  );

  const move = useCallback(
    (lead: LeadItem, next: string) => {
      setFocusId(lead.id);
      void setLeadStatus(lead, next, true);
    },
    [setLeadStatus],
  );

  const openLead = useCallback((id: string) => setOpen(id), []);
  useEffect(() => void (open && dispatchEddyEvent("wa:eddy-selection", { type: "lead", id: open })), [open]); // tells Eddy which lead is open
  const closeLead = useCallback(() => {
    setFocusId(open);
    setOpen(null);
  }, [open]);
  const focusDone = useCallback(() => setFocusId(null), []);

  useEffect(() => {
    if (!focusId || view !== "table" || open || loading) return;
    document.querySelector<HTMLElement>(`[data-lead-open="${CSS.escape(focusId)}"]`)?.focus();
    setFocusId(null);
  }, [focusId, view, open, loading, rows]);

  const summary = useMemo(() => summarizeLeads(rows), [rows]);

  const columns: Column<LeadItem>[] = useMemo(
    () => [
      {
        key: "lead",
        header: "Lead",
        primary: true,
        cell: (r) => (
          <div className="min-w-0">
            <button type="button" data-lead-open={r.id} className="min-h-10 text-left font-medium underline-offset-2 hover:underline" onClick={() => setOpen(r.id)}>
              {leadDisplayName(r)}
            </button>
            <div className="text-xs font-normal text-muted">{new Date(r.createdAt).toLocaleString()}</div>
            {r.needsOptIn && (
              <div className="mt-1">
                <ConsentBadge needsOptIn />
              </div>
            )}
          </div>
        ),
      },
      { key: "status", header: "Stage", cell: (r) => <StatusPill status={r.status} label={leadStatusLabel(r.status)} /> },
      { key: "reply", header: "First reply", cell: (r) => <ResponseBadge lead={r} now={now} /> },
      { key: "form", header: "Form", accessor: (r) => r.form?.name ?? "Lead form" },
      { key: "assigned", header: "Assigned to", accessor: (r) => assigneeName(r.assignedToId) },
    ],
    [now, assigneeName],
  );

  const exportHref = `/api/leads/export${effectiveStatus ? `?status=${encodeURIComponent(effectiveStatus)}` : ""}`;
  const firstLoad = loading && rows.length === 0;
  const empty = !loading && !error && rows.length === 0;
  const filtered = loadedStatus !== "";
  const showStats = !filtered && (rows.length > 0 || firstLoad);
  const panel = tabIds(VIEW_ID, view);
  const linkButton = (variant: "primary" | "secondary") => cn("inline-flex items-center justify-center gap-2 rounded-full font-semibold whitespace-nowrap", buttonVariants[variant], buttonSizes.md);

  return (
    <div>
      <PageHeader
        title="Leads"
        description="People who filled in your Facebook and Instagram lead forms. Reply quickly while they are still interested. Marketing messages go only to leads who agreed to receive them."
        actions={
          admin && (
            <a className={linkButton("secondary")} href={exportHref}>
              Download as CSV
            </a>
          )
        }
      />
      <LeadsNav current="/app/leads" />

      {filtered && rows.length > 0 && <p className="mb-4 text-xs text-muted">Reply speed covers every stage, so it is hidden while you look at one stage. Choose All stages to see it.</p>}

      {showStats && (
        <section aria-label="Reply speed" className="mb-6">
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat label="Waiting for a first reply" value={summary.waiting} hint={summary.waiting === 0 ? "Everyone has been answered" : "New leads nobody has answered yet"} loading={firstLoad} />
            <Stat label="Typical first reply" value={summary.medianSeconds === null ? "Not yet" : formatResponse(summary.medianSeconds)} hint={`${summary.replied} answered lead${summary.replied === 1 ? "" : "s"}`} loading={firstLoad} />
            <Stat label="Answered within 5 minutes" value={summary.fastPercent === null ? "Not yet" : `${summary.fastPercent}%`} hint="Fast replies win more leads" loading={firstLoad} />
          </div>
          {!firstLoad && (
            <p className="mt-2 text-xs text-muted">
              Based on the {rows.length} most recent leads loaded, across every stage{cursor ? ". Load more to include older ones." : "."}
            </p>
          )}
        </section>
      )}

      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <Tabs tabs={VIEW_TABS} label="How to show leads" variant="pill" value={view} onChange={setView} idPrefix={VIEW_ID} />
        {view === "table" && (
          <div className="w-full sm:w-56">
            <FormField label="Show stage">
              <Select value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="">All stages</option>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {leadStatusLabel(s)}
                  </option>
                ))}
              </Select>
            </FormField>
          </div>
        )}
      </div>

      <div role="tabpanel" id={panel.panel} aria-labelledby={panel.tab} aria-busy={loading || undefined}>
        {error && rows.length > 0 && (
          <Alert
            className="mb-4"
            tone="bad"
            title="We could not refresh your leads"
            action={
              <Button size="sm" variant="secondary" onClick={() => void load(null, effectiveStatus)}>
                Try again
              </Button>
            }
          >
            {error} You are still seeing the earlier results.
          </Alert>
        )}
        {error && rows.length === 0 ? (
          <ErrorState
            title="We could not load your leads"
            message={error}
            action={
              <Button variant="secondary" onClick={() => void load(null, effectiveStatus)}>
                Try again
              </Button>
            }
          />
        ) : empty ? (
          status && view === "table" ? (
            <EmptyState
              title={`No ${leadStatusLabel(status).toLowerCase()} leads`}
              body="No leads are at this stage right now."
              action={
                <Button variant="secondary" onClick={() => setStatus("")}>
                  Show all stages
                </Button>
              }
            />
          ) : (
            <EmptyState
              title="No leads yet"
              body="When someone submits one of your Facebook or Instagram lead forms, they show up here within seconds, ready for a quick reply."
              action={
                <a className={linkButton("primary")} href="/app/settings/connections">
                  Connect your Facebook page
                </a>
              }
            />
          )
        ) : view === "pipeline" ? (
          firstLoad ? (
            <PipelineSkeleton />
          ) : (
            <PipelineBoard items={rows} more={!!cursor} now={now} assigneeName={assigneeName} busyId={busyId} onOpen={openLead} onMove={move} focusId={open ? null : focusId} onFocusDone={focusDone} />
          )
        ) : (
          <DataTable caption="Leads" columns={columns} rows={rows} rowKey={(r) => r.id} loading={firstLoad} />
        )}

        {cursor && !firstLoad && (
          <div className="mt-4 text-center">
            <Button variant="secondary" loading={loadingMore} onClick={() => void load(cursor, effectiveStatus)}>
              Load more leads
            </Button>
          </div>
        )}
      </div>

      {open && <LeadDrawer id={open} admin={admin} agents={agents} onClose={closeLead} onChanged={merge} />}
    </div>
  );
}

function PipelineSkeleton() {
  return (
    <div aria-hidden className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 3 }, (_, i) => (
        <Card key={i} className="h-40">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="mt-4 h-16 w-full" />
        </Card>
      ))}
    </div>
  );
}
