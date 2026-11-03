"use client";

import { memo, useEffect, useId, useMemo, useState } from "react";
import { Button, Select, StatusPill, cn } from "@/components/ui";
import { leadOrigin } from "./LeadDrawer";
import { ConsentBadge, ResponseBadge } from "./LeadParts";
import { STATUSES, groupByStatus, isLeadStatus, leadDisplayName, leadStatusLabel, leadStatusMeaning, responseHighlight, type LeadStatus } from "./helpers";
import type { LeadItem } from "./types";

const PREVIEW = 6;

type CardProps = { lead: LeadItem; now: number; assignee: string; busy: boolean; onOpen: (id: string) => void; onMove: (lead: LeadItem, status: string) => void };

const LeadCard = memo(function LeadCard({ lead, now, assignee, busy, onOpen, onMove }: CardProps) {
  const name = leadDisplayName(lead);
  const h = responseHighlight(lead, now);
  const urgent = h.attention && h.tone === "bad";
  const selectId = useId();
  const [pick, setPick] = useState(lead.status);
  const [seen, setSeen] = useState(lead.status);
  if (seen !== lead.status) {
    setSeen(lead.status);
    setPick(lead.status);
  }
  const changed = pick !== lead.status;

  return (
    <li className={cn("rounded-card border bg-raised p-3 shadow-raised", urgent ? "border-bad-line" : "border-border")}>
      <button type="button" data-lead-open={lead.id} onClick={() => onOpen(lead.id)} className="-m-1 block min-h-10 w-[calc(100%+0.5rem)] rounded-control p-1 text-left hover:bg-surface-2">
        <span className="block truncate font-medium">{name}</span>
        <span className="block truncate text-xs text-muted">
          {leadOrigin(lead)} · {new Date(lead.createdAt).toLocaleDateString()}
        </span>
      </button>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <ResponseBadge lead={lead} now={now} />
        {lead.needsOptIn && <ConsentBadge needsOptIn />}
      </div>
      <p className="mt-3 truncate text-xs text-muted">Assigned to {assignee}</p>
      <div className="mt-2 flex items-center gap-2">
        <label htmlFor={selectId} className="sr-only">
          Stage for {name}
        </label>
        <Select id={selectId} className="min-w-0 flex-1" value={pick} disabled={busy} onChange={(e) => setPick(e.target.value)}>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {leadStatusLabel(s)}
            </option>
          ))}
        </Select>
        <Button variant="secondary" className="shrink-0" loading={busy} disabled={!changed} aria-label={`Move ${name} to ${leadStatusLabel(pick).toLowerCase()}`} onClick={() => onMove(lead, pick)}>
          Move
        </Button>
      </div>
    </li>
  );
});

type BoardProps = {
  items: LeadItem[];
  more: boolean;
  now: number;
  assigneeName: (id: string | null) => string;
  busyId: string | null;
  onOpen: (id: string) => void;
  onMove: (lead: LeadItem, status: string) => void;
  /** A lead whose open button should receive focus once it is on screen, for example after it moved to another column. */
  focusId: string | null;
  onFocusDone: () => void;
};

export function PipelineBoard({ items, more, now, assigneeName, busyId, onOpen, onMove, focusId, onFocusDone }: BoardProps) {
  const groups = useMemo(() => groupByStatus(items), [items]);
  const [expanded, setExpanded] = useState<Partial<Record<LeadStatus, boolean>>>({});

  useEffect(() => {
    if (!focusId || busyId) return;
    const el = document.querySelector<HTMLElement>(`[data-lead-open="${CSS.escape(focusId)}"]`);
    if (el) {
      el.focus();
      onFocusDone();
      return;
    }
    const lead = items.find((l) => l.id === focusId);
    if (lead && isLeadStatus(lead.status) && !expanded[lead.status]) setExpanded((e) => ({ ...e, [lead.status as LeadStatus]: true }));
    else onFocusDone();
  }, [focusId, busyId, items, expanded, onFocusDone]);

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:flex lg:items-start lg:overflow-x-auto lg:pb-2">
      {STATUSES.map((status) => {
        const list = groups[status];
        const open = expanded[status];
        const shown = open ? list : list.slice(0, PREVIEW);
        const headingId = `pipeline-${status}`;
        return (
          <section key={status} aria-labelledby={headingId} className="min-w-0 rounded-card bg-surface p-3 lg:w-72 lg:shrink-0">
            <div className="mb-3">
              <div className="flex items-center justify-between gap-2">
                <h2 id={headingId} className="m-0 text-sm font-semibold">
                  <StatusPill status={status} label={leadStatusLabel(status)} />
                </h2>
                <span className="text-sm font-semibold tabular-nums" aria-label={`${list.length}${more ? " or more" : ""} leads`}>
                  {list.length}
                  {more ? "+" : ""}
                </span>
              </div>
              <p className="mt-1 text-xs text-muted">{leadStatusMeaning(status)}</p>
            </div>
            {list.length === 0 ? (
              <p className="rounded-control border border-dashed border-border-strong p-3 text-center text-xs text-muted">No leads here</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {shown.map((lead) => (
                  <LeadCard key={lead.id} lead={lead} now={now} assignee={assigneeName(lead.assignedToId)} busy={busyId === lead.id} onOpen={onOpen} onMove={onMove} />
                ))}
              </ul>
            )}
            {list.length > PREVIEW && (
              <Button className="mt-2 w-full" size="sm" variant="ghost" aria-expanded={!!open} onClick={() => setExpanded((e) => ({ ...e, [status]: !open }))}>
                {open ? "Show fewer" : `Show ${list.length - PREVIEW} more`}
              </Button>
            )}
          </section>
        );
      })}
    </div>
  );
}
