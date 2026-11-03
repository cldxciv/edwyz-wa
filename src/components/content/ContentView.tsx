"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { PageHeader } from "@/components/app/PageHeader";
import { canManage, useApi, useRole } from "@/components/contacts/hooks";
import { Alert, Button, Card, DataTable, Dialog, EmptyState, ErrorState, Skeleton, StatusPill, Tabs, apiFetch, cn, confirm, tabIds, toast, type Column } from "@/components/ui";
import { friendlyMessage } from "@/components/creative/messages";
import { canPlanDay, dayKey, gridRange, monthGrid } from "@/lib/broadcasts/calendar";
import { MAX_DAYS_AHEAD } from "@/lib/content/schedule";
import { groupByDay, periodTitle, shiftAnchor, weekDays, weekRange, type CalendarView } from "./calendar-helpers";
import { Composer } from "./Composer";
import { channelName, CHANNEL_NAME, formatWhen, mediaUrl, postStatus, type AssetOption, type CalendarEntry, type Post } from "./helpers";

const WEEKDAYS = [
  ["Sun", "Sunday"],
  ["Mon", "Monday"],
  ["Tue", "Tuesday"],
  ["Wed", "Wednesday"],
  ["Thu", "Thursday"],
  ["Fri", "Friday"],
  ["Sat", "Saturday"],
] as const;
const MAX_CHIPS = 3;
const PREFIX = "content-view";

const noopSubscribe = () => () => {};
const timeOf = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const longDay = (d: Date) => d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
const where = (channels: string[]) => channels.map(channelName).join(", ");

const CHIP_TONE = {
  good: "border-good-line bg-good-soft text-good-fg",
  warn: "border-warn-line bg-warn-soft text-warn-fg",
  bad: "border-bad-line bg-bad-soft text-bad-fg",
  info: "border-info-line bg-info-soft text-info-fg",
  neutral: "border-border bg-surface text-muted",
} as const;
const GLYPH = { good: "✓", warn: "!", bad: "!", info: "●", neutral: "○" } as const;

/**
 * Where the calendar opens after a post is saved with a time: the anchor puts its month (month view) or its week (week view) on
 * screen, and the picked day is the post's day, so the day list under the month grid shows it. Null without a usable time.
 */
export function calendarFocus(scheduledAt: string | undefined): { anchor: Date; selectedKey: string } | null {
  if (!scheduledAt) return null;
  const at = new Date(scheduledAt);
  if (Number.isNaN(at.getTime())) return null;
  return { anchor: at, selectedKey: dayKey(at) };
}

/** A post in a calendar cell. Exported for tests. */
export function Chip({ item, onPick }: { item: CalendarEntry; onPick: (id: string) => void }) {
  const s = postStatus(item.status);
  return (
    // `relative` makes the chip the containing block for its screen-reader-only status text, which is absolutely positioned;
    // without it that text sits outside the clipped chip and the page scrolls sideways.
    <button
      type="button"
      onClick={() => onPick(item.id)}
      title={`${item.name}. ${s.label}.`}
      className={cn("relative block min-h-7 w-full truncate rounded-control border px-1.5 py-1 text-left text-xs", CHIP_TONE[s.tone])}
    >
      <span aria-hidden>{GLYPH[s.tone]} </span>
      {timeOf(item.at)} {item.name}
      <span className="sr-only">. {s.label}.</span>
    </button>
  );
}

function EntryRow({ item, onPick }: { item: CalendarEntry; onPick: (id: string) => void }) {
  const s = postStatus(item.status);
  return (
    <button type="button" onClick={() => onPick(item.id)} className="flex min-h-12 w-full flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-control border border-border bg-raised p-3 text-left hover:bg-surface">
      <span className="min-w-0 flex-1">
        <span className="block text-xs text-muted">
          {timeOf(item.at)}
          {item.channels.length > 0 && ` on ${where(item.channels)}`}
        </span>
        <span className="line-clamp-2 break-words text-sm font-medium">{item.name}</span>
      </span>
      <StatusPill status={item.status} label={s.label} tone={s.tone} />
    </button>
  );
}

function Toolbar({ view, anchor, onShift, onToday }: { view: "month" | "week"; anchor: Date; onShift: (n: number) => void; onToday: () => void }) {
  const unit = view === "month" ? "month" : "week";
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="text-lg font-semibold tracking-tight" aria-live="polite">
        {periodTitle(view, anchor)}
      </h2>
      <div className="flex gap-2">
        <Button variant="secondary" onClick={() => onShift(-1)} aria-label={`Previous ${unit}`}>
          Previous
        </Button>
        <Button variant="secondary" onClick={onToday}>
          Today
        </Button>
        <Button variant="secondary" onClick={() => onShift(1)} aria-label={`Next ${unit}`}>
          Next
        </Button>
      </div>
    </div>
  );
}

function MonthGrid({ anchor, today, byDay, selected, onSelect, onPick, onNew, admin, busy }: { anchor: Date; today: Date; byDay: Map<string, CalendarEntry[]>; selected: string; onSelect: (key: string) => void; onPick: (id: string) => void; onNew: (key: string) => void; admin: boolean; busy: boolean }) {
  const weeks = useMemo(() => monthGrid(anchor.getFullYear(), anchor.getMonth()), [anchor]);
  const todayKey = dayKey(today);
  return (
    <div aria-busy={busy}>
      <table className="w-full table-fixed border-collapse text-sm">
        <caption className="sr-only">Content calendar for {periodTitle("month", anchor)}. Select a day to see its posts.</caption>
        <thead>
          <tr>
            {WEEKDAYS.map(([short, full]) => (
              <th key={full} scope="col" className="border border-border bg-surface px-1 py-1.5 text-xs font-medium text-muted">
                <span aria-hidden>{short}</span>
                <span className="sr-only">{full}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week) => (
            <tr key={week[0].key}>
              {week.map((cell) => {
                const items = byDay.get(cell.key) ?? [];
                const isToday = cell.key === todayKey;
                const isSelected = cell.key === selected;
                const canAdd = admin && canPlanDay(cell.date, MAX_DAYS_AHEAD, today);
                return (
                  <td key={cell.key} className={cn("h-14 border border-border p-0.5 align-top sm:h-28 sm:p-1", !cell.inMonth && "bg-surface text-muted")}>
                    <div className="flex h-full flex-col">
                      <div className="flex items-start justify-between gap-1">
                        <button
                          type="button"
                          onClick={() => onSelect(cell.key)}
                          aria-pressed={isSelected}
                          aria-current={isToday ? "date" : undefined}
                          aria-label={`${longDay(cell.date)}${isToday ? ", today" : ""}. ${items.length === 0 ? "No posts" : items.length === 1 ? "1 post" : `${items.length} posts`}.`}
                          className={cn(
                            "flex h-12 w-full flex-col items-center justify-center rounded-control text-xs font-medium sm:h-7 sm:w-auto sm:min-w-7 sm:flex-row sm:px-1.5",
                            isToday ? "bg-accent text-on-accent" : isSelected ? "bg-accent-soft text-accent-ink ring-1 ring-accent" : "hover:bg-surface-2",
                          )}
                        >
                          <span>{cell.date.getDate()}</span>
                          {items.length > 0 && (
                            <span aria-hidden className={cn("mt-0.5 rounded-full px-1.5 text-[10px] tabular-nums sm:hidden", isToday ? "bg-on-accent text-accent" : "bg-surface-2 text-foreground")}>
                              {items.length}
                            </span>
                          )}
                        </button>
                        {canAdd && (
                          <button type="button" onClick={() => onNew(cell.key)} aria-label={`New post on ${longDay(cell.date)}`} className="hidden h-7 w-7 items-center justify-center rounded-full text-base text-muted hover:bg-surface-2 hover:text-foreground sm:flex">
                            +
                          </button>
                        )}
                      </div>
                      <ul className="mt-1 hidden space-y-1 sm:block">
                        {items.slice(0, MAX_CHIPS).map((item) => (
                          <li key={item.id}>
                            <Chip item={item} onPick={onPick} />
                          </li>
                        ))}
                        {items.length > MAX_CHIPS && (
                          <li>
                            <button type="button" onClick={() => onSelect(cell.key)} className="rounded px-1 text-xs text-muted underline">
                              {items.length - MAX_CHIPS}{" "}more
                            </button>
                          </li>
                        )}
                      </ul>
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DayAgenda({ date, items, admin, today, onPick, onNew }: { date: Date; items: CalendarEntry[]; admin: boolean; today: Date; onPick: (id: string) => void; onNew: (key: string) => void }) {
  const canAdd = admin && canPlanDay(date, MAX_DAYS_AHEAD, today);
  return (
    <section aria-label={`Posts on ${longDay(date)}`} className="mt-5">
      {/* Tells screen reader users that the list below changed when they pick another day. */}
      <p role="status" className="sr-only">
        {longDay(date)}: {items.length === 0 ? "no posts" : items.length === 1 ? "1 post" : `${items.length} posts`}
      </p>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-base font-semibold">{longDay(date)}</h3>
        {canAdd && (
          <Button variant="secondary" onClick={() => onNew(dayKey(date))}>
            New post on this day
          </Button>
        )}
      </div>
      {items.length === 0 ? (
        <p className="rounded-control border border-dashed border-border-strong p-4 text-sm text-muted">Nothing is scheduled for this day.{canAdd ? " Use New post on this day to add one." : ""}</p>
      ) : (
        <ul className="space-y-2">
          {items.map((item) => (
            <li key={item.id}>
              <EntryRow item={item} onPick={onPick} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function WeekView({ anchor, today, byDay, onPick, onNew, admin, busy }: { anchor: Date; today: Date; byDay: Map<string, CalendarEntry[]>; onPick: (id: string) => void; onNew: (key: string) => void; admin: boolean; busy: boolean }) {
  const days = weekDays(anchor);
  const todayKey = dayKey(today);
  return (
    <div aria-busy={busy} className="grid gap-3 sm:grid-cols-2 xl:grid-cols-7">
      {days.map((d) => {
        const key = dayKey(d);
        const items = byDay.get(key) ?? [];
        const canAdd = admin && canPlanDay(d, MAX_DAYS_AHEAD, today);
        return (
          <section key={key} aria-label={`Posts on ${longDay(d)}`} className={cn("flex min-w-0 flex-col rounded-card border bg-raised p-3", key === todayKey ? "border-accent" : "border-border")}>
            <h3 className="text-sm font-semibold">
              <span className="whitespace-nowrap">{d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}</span>
              {/* Its own line: seven narrow day cards cannot fit the date and the marker side by side. */}
              {key === todayKey && <span className="block text-xs font-medium text-accent-ink">Today</span>}
            </h3>
            <ul className="mt-2 flex-1 space-y-2">
              {items.map((item) => (
                <li key={item.id}>
                  <EntryRow item={item} onPick={onPick} />
                </li>
              ))}
              {items.length === 0 && <li className="text-xs text-muted">Nothing scheduled</li>}
            </ul>
            {canAdd && (
              <Button variant="ghost" size="md" className="mt-2 self-start" onClick={() => onNew(key)} aria-label={`New post on ${longDay(d)}`}>
                Add post
              </Button>
            )}
          </section>
        );
      })}
    </div>
  );
}

function PostList({ onPick, onNew, admin, version }: { onPick: (id: string) => void; onNew: () => void; admin: boolean; version: number }) {
  const { data, error, loading, reload } = useApi<{ posts: Post[] }>(`/api/content/posts?limit=100&v=${version}`);
  const columns = useMemo<Column<Post>[]>(
    () => [
      {
        key: "post",
        header: "Post",
        primary: true,
        cell: (p) => (
          <button type="button" onClick={() => onPick(p.id)} className="line-clamp-2 max-w-md text-left font-medium underline-offset-2 hover:underline">
            {p.body || "Post with a picture or video"}
          </button>
        ),
      },
      { key: "where", header: "Where", cell: (p) => where([...new Set(p.targets.map((t) => t.channel))]) || "-" },
      { key: "when", header: "When", accessor: (p) => p.scheduledAt, sortable: true, cell: (p) => formatWhen(p.scheduledAt) },
      {
        key: "status",
        header: "Status",
        accessor: (p) => postStatus(p.status).label,
        sortable: true,
        cell: (p) => {
          const s = postStatus(p.status);
          return <StatusPill status={p.status} label={s.label} tone={s.tone} />;
        },
      },
    ],
    [onPick],
  );
  if (error && !data) return <ErrorState title="We could not load your posts" message="Check your connection and try again." action={<Button variant="secondary" onClick={reload}>Try again</Button>} />;
  return (
    <DataTable
      caption="All posts"
      columns={columns}
      rows={data?.posts ?? []}
      rowKey={(p) => p.id}
      loading={loading}
      empty={
        <EmptyState
          title="No posts yet"
          body="Write a post once and schedule it to your Facebook Pages and Instagram accounts. It publishes at the time you choose."
          action={admin ? <Button onClick={onNew}>New post</Button> : undefined}
        />
      }
    />
  );
}

function Detail({ id, admin, onClose, onChanged, onEdit }: { id: string; admin: boolean; onClose: () => void; onChanged: () => void; onEdit: (p: Post) => void }) {
  const { data, error, reload } = useApi<{ post: Post }>(`/api/content/posts/${id}`);
  const targets = useApi<{ targets: AssetOption[] }>("/api/content/targets");
  const [busy, setBusy] = useState(false);
  const post = data?.post;
  const names = new Map((targets.data?.targets ?? []).map((t) => [t.id, t.name ?? "Account"]));
  const editable = !!post && (post.status === "draft" || post.status === "scheduled");
  const deletable = !!post && ["draft", "canceled", "failed", "published", "partial"].includes(post.status);

  async function act(path: string, method: "POST" | "DELETE", ask: { title: string; body: string; confirmLabel: string; tone?: "danger" }, done: string) {
    if (!(await confirm(ask))) return;
    setBusy(true);
    try {
      await apiFetch(`/api/content/posts/${id}${path}`, { method, body: method === "POST" ? {} : undefined });
      toast.success(done);
      onChanged();
      if (method === "DELETE") onClose();
      else reload();
    } catch (e) {
      toast.error(friendlyMessage(e, "That did not work. Check your connection and try again."));
    } finally {
      setBusy(false);
    }
  }

  const s = post ? postStatus(post.status) : null;
  const count = post?.targets.length ?? 0;
  return (
    <Dialog
      title="Post details"
      size="lg"
      onClose={onClose}
      dismissible={!busy}
      footer={
        <>
          {admin && editable && post && (
            <Button variant="secondary" disabled={busy} onClick={() => onEdit(post)}>
              Edit or reschedule
            </Button>
          )}
          {admin && editable && (
            <Button
              disabled={busy}
              onClick={() => void act("/publish-now", "POST", { title: "Publish now?", body: `This sends the post to ${count === 1 ? "1 account" : `${count} accounts`} straight away instead of at the scheduled time.`, confirmLabel: "Publish now" }, "Publishing started")}
            >
              Publish now
            </Button>
          )}
          {admin && editable && (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => void act("/cancel", "POST", { title: "Cancel this post?", body: "It will not be published. You can delete it afterwards.", confirmLabel: "Cancel post", tone: "danger" }, "Post canceled")}
            >
              Cancel post
            </Button>
          )}
          {admin && deletable && (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => void act("", "DELETE", { title: "Delete this post?", body: "It is removed from your calendar. If it was already published, it stays on Facebook or Instagram.", confirmLabel: "Delete post", tone: "danger" }, "Post deleted")}
            >
              Delete post
            </Button>
          )}
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Close
          </Button>
        </>
      }
    >
      {error && <ErrorState title="We could not load this post" message="Check your connection and try again." action={<Button variant="secondary" onClick={reload}>Try again</Button>} />}
      {!post && !error && (
        <div aria-busy="true">
          <p role="status" className="sr-only">
            Loading post
          </p>
          <div aria-hidden className="space-y-3">
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-20 w-full" />
          </div>
        </div>
      )}
      {post && s && (
        <div className="space-y-4 text-sm">
          <p className="flex flex-wrap items-center gap-2">
            <StatusPill status={post.status} label={s.label} tone={s.tone} />
            <span className="text-muted">{post.status === "published" ? "Scheduled for" : "Goes out"} {formatWhen(post.scheduledAt)}</span>
          </p>
          {post.mediaKeys[0] && (
            /\.(mp4|mov)$/.test(post.mediaKeys[0]) ? (
              <video src={mediaUrl(post.mediaKeys[0])} controls preload="metadata" aria-label="Attached video" className="max-h-64 w-full rounded-control bg-surface" />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={mediaUrl(post.mediaKeys[0])} alt="Attached picture" className="max-h-64 w-full rounded-control bg-surface object-contain" />
            )
          )}
          <p className="whitespace-pre-wrap break-words">{post.body || <span className="text-muted">No text, only a picture or video.</span>}</p>
          <div>
            <h3 className="mb-2 font-semibold">Where it goes</h3>
            <ul className="space-y-2">
              {post.targets.map((t) => {
                const ts = postStatus(t.status);
                return (
                  <li key={t.id} className="rounded-control border border-border p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium">
                        {CHANNEL_NAME[t.channel]}: {names.get(t.assetId) ?? "Account"}
                      </span>
                      <StatusPill status={t.status} label={ts.label} tone={ts.tone} />
                    </div>
                    {t.error && (
                      <div className="mt-2">
                        <p className="text-bad-fg">This account did not receive the post.{t.status === "retry" ? " We will try again." : ""}</p>
                        <details className="mt-1 text-xs text-muted">
                          <summary className="cursor-pointer rounded py-1">Details</summary>
                          <p className="break-words">{t.error}</p>
                        </details>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
          {!admin && <Alert tone="info">Only owners and admins can change posts.</Alert>}
        </div>
      )}
    </Dialog>
  );
}

export function ContentView() {
  const role = useRole();
  const admin = canManage(role);
  const hydrated = useSyncExternalStore(noopSubscribe, () => true, () => false);
  const [view, setView] = useState<CalendarView>("month");
  const [anchor, setAnchor] = useState(() => new Date());
  const [selectedKey, setSelectedKey] = useState(() => dayKey(new Date()));
  const [composer, setComposer] = useState<{ post?: Post; date?: string } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  const root = useRef<HTMLDivElement>(null);
  const dirty = useRef(false);
  const onDirtyChange = useCallback((d: boolean) => {
    dirty.current = d;
  }, []);
  const inComposer = composer !== null;
  const swapped = useRef(false);

  // The calendar and the composer replace each other, which drops focus on the page body. Start at the new page title.
  useEffect(() => {
    if (!swapped.current) {
      swapped.current = true;
      return;
    }
    const frame = requestAnimationFrame(() => {
      const h = root.current?.querySelector<HTMLElement>("h1");
      if (!h) return;
      h.tabIndex = -1;
      h.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [inComposer]);
  const pick = useCallback((id: string) => setSelected(id), []);
  const today = new Date();

  const range = useMemo(() => {
    if (view === "list") return null;
    if (view === "week") return weekRange(anchor);
    return gridRange(monthGrid(anchor.getFullYear(), anchor.getMonth()));
  }, [view, anchor]);
  const calendar = useApi<{ items: CalendarEntry[] }>(range ? `/api/content/calendar?from=${encodeURIComponent(range.from.toISOString())}&to=${encodeURIComponent(range.to.toISOString())}&v=${version}` : null);
  const byDay = useMemo(() => groupByDay(calendar.data?.items ?? []), [calendar.data]);
  const total = calendar.data?.items.length ?? 0;

  const openNew = (date?: string) => {
    setSelected(null);
    setComposer({ date });
  };

  function shift(delta: number) {
    if (view === "list") return;
    const next = shiftAnchor(anchor, view, delta);
    setAnchor(next);
    // The day list under the month grid must always belong to the period on screen.
    setSelectedKey(view === "month" ? dayKey(new Date(next.getFullYear(), next.getMonth(), 1)) : dayKey(next));
  }

  async function leaveComposer() {
    if (dirty.current && !(await confirm({ title: "Discard this post?", body: "The text, accounts and time you chose will be lost.", confirmLabel: "Discard post", tone: "danger" }))) return;
    setComposer(null);
  }

  function goToday() {
    const now = new Date();
    setAnchor(now);
    setSelectedKey(dayKey(now));
  }

  const [sy, sm, sd] = selectedKey.split("-").map(Number);
  const selectedDate = new Date(sy, sm - 1, sd);

  if (composer) {
    return (
      <div ref={root}>
        <PageHeader
          title={composer.post ? "Edit post" : "New post"}
          description="Choose where it goes, write it, then pick a time. You see how it looks on each account."
          actions={
            <Button variant="secondary" onClick={() => void leaveComposer()}>
              Back to calendar
            </Button>
          }
        />
        <Composer
          post={composer.post}
          defaultDate={composer.date}
          onCancel={() => void leaveComposer()}
          onDirtyChange={onDirtyChange}
          onDone={(scheduledAt) => {
            setComposer(null);
            setSelected(null);
            // Open on the post's day: its month (with the day picked) or its week, so a post for next month is in view at once.
            const focus = calendarFocus(scheduledAt);
            if (focus) {
              setAnchor(focus.anchor);
              setSelectedKey(focus.selectedKey);
            }
            refresh();
          }}
        />
      </div>
    );
  }

  const tabs = [
    { id: "month", label: "Month" },
    { id: "week", label: "Week" },
    { id: "list", label: "All posts" },
  ];
  const ids = tabIds(PREFIX, view);

  return (
    <div ref={root}>
      <PageHeader
        title="Content calendar"
        description="Plan and schedule posts to your Facebook Pages and Instagram accounts."
        actions={admin ? <Button onClick={() => openNew()}>New post</Button> : undefined}
      />
      <div className="space-y-4">
        <Tabs label="Calendar view" variant="pill" idPrefix={PREFIX} tabs={tabs} value={view} onChange={(id) => {
            if (id === "week") setAnchor(selectedDate);
            // Back to the month grid: make sure the picked day is one the grid shows.
            if (id === "month" && (selectedDate.getFullYear() !== anchor.getFullYear() || selectedDate.getMonth() !== anchor.getMonth())) setSelectedKey(dayKey(anchor));
            setView(id as CalendarView);
          }} className="w-fit max-w-full" />
        <div role="tabpanel" id={ids.panel} aria-labelledby={ids.tab} className="space-y-4">
          {view === "list" ? (
            <PostList onPick={pick} onNew={() => openNew()} admin={admin} version={version} />
          ) : !hydrated ? (
            <div aria-hidden>
              <Skeleton className="h-96 w-full" />
            </div>
          ) : (
            <Card>
              <Toolbar view={view} anchor={anchor} onShift={shift} onToday={goToday} />
              {calendar.error && !calendar.data && (
                <div className="mt-4">
                  <ErrorState title="We could not load the calendar" message="Check your connection and try again." action={<Button variant="secondary" onClick={calendar.reload}>Try again</Button>} />
                </div>
              )}
              <div className="mt-4">
                {view === "month" ? (
                  <>
                    <MonthGrid anchor={anchor} today={today} byDay={byDay} selected={selectedKey} onSelect={setSelectedKey} onPick={pick} onNew={openNew} admin={admin} busy={calendar.loading} />
                    <DayAgenda date={selectedDate} items={byDay.get(selectedKey) ?? []} admin={admin} today={today} onPick={pick} onNew={openNew} />
                  </>
                ) : (
                  <WeekView anchor={anchor} today={today} byDay={byDay} onPick={pick} onNew={openNew} admin={admin} busy={calendar.loading} />
                )}
              </div>
              {!calendar.loading && !calendar.error && total === 0 && (
                <p className="mt-4 text-sm text-muted">Nothing is scheduled in {view === "month" ? "this month" : "this week"}.{admin ? " Select New post to plan something." : ""}</p>
              )}
              <p className="mt-4 text-xs text-muted">Times are in your local time zone. You can schedule up to 90 days ahead.</p>
            </Card>
          )}
        </div>
        {role !== null && !admin && (
          <Alert tone="info">You can look at the calendar. Ask an owner or admin if you need to schedule or change a post.</Alert>
        )}
      </div>
      {selected && (
        <Detail
          key={selected}
          id={selected}
          admin={admin}
          onClose={() => setSelected(null)}
          onChanged={refresh}
          onEdit={(post) => {
            setSelected(null);
            setComposer({ post });
          }}
        />
      )}
    </div>
  );
}
