"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Card, EmptyState, Skeleton, cn } from "@/components/ui";
import { canManage, useRole } from "@/components/contacts/hooks";
import { type CalendarItem, type StatusColour, bucketByDay, canPlanDay, dayKey, gridRange, longDate, monthGrid, statusColour } from "@/lib/broadcasts/calendar";
import { LinkButton } from "./LinkButton";
import { useKeyedApi } from "./useKeyedApi";
import { MAX_SCHEDULE_DAYS, broadcastStatusView, friendlyError } from "./helpers";

const COLOURS: Record<StatusColour, string> = {
  scheduled: "bg-info-soft text-info-fg border-info-line",
  sent: "bg-good-soft text-good-fg border-good-line",
  sending: "bg-accent-soft text-accent-ink border-accent",
  attention: "bg-bad-soft text-bad-fg border-bad-line",
  inactive: "bg-surface text-muted border-border",
};

const LEGEND: { colour: StatusColour; label: string }[] = [
  { colour: "scheduled", label: "Scheduled or draft" },
  { colour: "sending", label: "Sending" },
  { colour: "sent", label: "Completed" },
  { colour: "attention", label: "Paused or failed" },
  { colour: "inactive", label: "Canceled" },
];

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MAX_PER_DAY = 3;

const timeOf = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

function Chip({ item, className }: { item: CalendarItem; className?: string }) {
  const label = broadcastStatusView(item.status).label;
  return (
    <Link href={`/app/broadcasts/${item.id}`} className={cn("block rounded border px-1.5 py-0.5 text-xs", COLOURS[statusColour(item.status)], className)} title={`${item.name}, ${label}`}>
      <span className="tabular-nums">{timeOf(item.at)}</span> {item.name}
      <span className="sr-only">, {label}</span>
    </Link>
  );
}

/** The month a ?date=YYYY-MM-DD names (a day a broadcast was planned on), or null when it is missing or not a real date. */
export function monthOfDateParam(value: string | null | undefined): { year: number; month: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? "");
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  const d = new Date(year, month, day);
  if (d.getFullYear() !== year || d.getMonth() !== month || d.getDate() !== day) return null;
  return { year, month };
}

/**
 * The calendar opened on the local day a broadcast goes out (/app/broadcasts?date=YYYY-MM-DD), or null when the time is not a date.
 * The wizard goes here after scheduling a broadcast planned from a calendar day, so it is in view at once even in another month.
 */
export function calendarHrefFor(at: string | Date): string | null {
  const d = at instanceof Date ? at : new Date(at);
  return Number.isNaN(d.getTime()) ? null : `/app/broadcasts?date=${dayKey(d)}`;
}

export function CampaignCalendar() {
  const role = useRole();
  const admin = canManage(role);
  const [today] = useState(() => new Date());
  const [cursor, setCursor] = useState({ year: today.getFullYear(), month: today.getMonth() });
  // Back from planning a broadcast (/app/broadcasts?date=...): open on that day's month, so the new broadcast is in view at once.
  useEffect(() => {
    const month = monthOfDateParam(new URLSearchParams(window.location.search).get("date"));
    if (month) setCursor(month);
  }, []);
  const weeks = useMemo(() => monthGrid(cursor.year, cursor.month), [cursor]);
  const { from, to } = gridRange(weeks);
  const { freshData: data, error, stale: loading, retry } = useKeyedApi<{ items: CalendarItem[] }>(`/api/broadcasts/calendar?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const toggleDay = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const byDay = useMemo(() => bucketByDay(data?.items ?? []), [data]);
  const agenda = useMemo(() => weeks.flat().filter((cell) => cell.inMonth && byDay.has(cell.key)), [weeks, byDay]);
  const title = new Date(cursor.year, cursor.month, 1).toLocaleString(undefined, { month: "long", year: "numeric" });
  const shift = (delta: number) => setCursor((c) => ({ year: new Date(c.year, c.month + delta, 1).getFullYear(), month: new Date(c.year, c.month + delta, 1).getMonth() }));
  const todayKey = dayKey(today);
  const isCurrent = cursor.year === today.getFullYear() && cursor.month === today.getMonth();

  return (
    <Card>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold" aria-live="polite">
          {title}
        </h2>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => shift(-1)} aria-label="Previous month">
            Previous
          </Button>
          <Button variant="secondary" size="sm" disabled={isCurrent} onClick={() => setCursor({ year: today.getFullYear(), month: today.getMonth() })}>
            This month
          </Button>
          <Button variant="secondary" size="sm" onClick={() => shift(1)} aria-label="Next month">
            Next
          </Button>
        </div>
      </div>
      {error && (
        <Alert
          tone="bad"
          className="mb-3"
          title="We could not load the calendar"
          action={
            <Button size="sm" variant="secondary" onClick={retry}>
              Try again
            </Button>
          }
        >
          {friendlyError(error, "Check your connection and try again.")}
        </Alert>
      )}
      <ul className="mb-3 flex flex-wrap gap-2 text-xs" aria-label="Colour key">
        {LEGEND.map((l) => (
          <li key={l.colour} className={cn("rounded-full border px-2.5 py-0.5", COLOURS[l.colour])}>
            {l.label}
          </li>
        ))}
      </ul>

      <p role="status" className="sr-only">
        {loading ? `Loading ${title}` : ""}
      </p>
      <div aria-busy={loading} className={cn("hidden sm:block", loading && "opacity-60")}>
        <table className="w-full table-fixed border-collapse text-sm">
          <caption className="sr-only">Broadcasts planned for {title}</caption>
          <thead>
            <tr>
              {WEEKDAYS.map((d) => (
                <th key={d} scope="col" className="border border-border bg-surface px-2 py-1 text-xs font-medium text-muted">
                  {d}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {weeks.map((week) => (
              <tr key={week[0].key}>
                {week.map((cell) => {
                  const items = byDay.get(cell.key) ?? [];
                  const open = expanded.has(cell.key);
                  const shownItems = open ? items : items.slice(0, MAX_PER_DAY);
                  // No "+" outside the scheduling window: past days, and days more than 90 days ahead.
                  const plannable = canPlanDay(cell.date, MAX_SCHEDULE_DAYS, today);
                  const isToday = cell.key === todayKey;
                  return (
                    <td key={cell.key} className={cn("h-28 border border-border p-1 align-top", !cell.inMonth && "bg-surface text-muted")}>
                      <div className="mb-1 flex items-center justify-between">
                        <span className={cn("text-xs font-medium", isToday && "rounded-full bg-accent px-1.5 py-0.5 text-on-accent")}>
                          {cell.date.getDate()}
                          {isToday && <span className="sr-only"> (today)</span>}
                        </span>
                        {admin && plannable && (
                          <Link
                            href={`/app/broadcasts/new?date=${cell.key}`}
                            className="-m-1 inline-flex h-8 w-8 items-center justify-center rounded text-sm font-semibold text-accent-ink hover:bg-surface-2"
                            aria-label={`Plan a broadcast on ${longDate(cell.date)}`}
                          >
                            +
                          </Link>
                        )}
                      </div>
                      <ul className="space-y-1">
                        {shownItems.map((item) => (
                          <li key={item.id}>
                            <Chip item={item} className="truncate" />
                          </li>
                        ))}
                        {items.length > MAX_PER_DAY && (
                          <li>
                            <button
                              type="button"
                              aria-expanded={open}
                              onClick={() => toggleDay(cell.key)}
                              className="min-h-6 rounded px-1 text-xs font-medium text-accent-ink underline-offset-2 hover:underline"
                            >
                              {open ? "Show fewer" : `+${items.length - MAX_PER_DAY} more`}
                              <span className="sr-only"> on {longDate(cell.date)}</span>
                            </button>
                          </li>
                        )}
                      </ul>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="sm:hidden" aria-busy={loading}>
        {loading ? (
          <div className="space-y-2" aria-hidden>
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : error ? null : agenda.length === 0 ? (
          <EmptyState
            compact
            title={`Nothing planned in ${title}`}
            body="Scheduled and sent broadcasts show up here so you can spread them out."
            action={admin ? <LinkButton href="/app/broadcasts/new">Plan a broadcast</LinkButton> : undefined}
          />
        ) : (
          <>
            <ol className="space-y-3" aria-label={`Broadcasts in ${title}`}>
              {agenda.map((cell) => (
                <li key={cell.key}>
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <p className="text-sm font-medium">{cell.date.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}</p>
                    {admin && canPlanDay(cell.date, MAX_SCHEDULE_DAYS, today) && (
                      <Link href={`/app/broadcasts/new?date=${cell.key}`} className="inline-flex min-h-10 items-center rounded px-2 text-sm font-medium text-accent-ink underline-offset-2 hover:underline">
                        Plan another
                        <span className="sr-only"> on {longDate(cell.date)}</span>
                      </Link>
                    )}
                  </div>
                  <ul className="space-y-1">
                    {(byDay.get(cell.key) ?? []).map((item) => (
                      <li key={item.id}>
                        <Chip item={item} className="py-2 text-sm" />
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ol>
            {admin && (
              <div className="mt-4">
                <LinkButton href="/app/broadcasts/new" variant="secondary" className="w-full min-h-11">
                  Plan a broadcast
                </LinkButton>
              </div>
            )}
          </>
        )}
      </div>
      <p className="mt-3 text-xs text-muted">Times are in your local time zone. You can schedule up to {MAX_SCHEDULE_DAYS} days ahead.</p>
    </Card>
  );
}
