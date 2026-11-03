"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch, Button, cn, EmptyState, Input, Select } from "@/components/ui";
import { isInsideEddy } from "@/components/eddy/keyguard";
import { TeamFilter } from "@/components/teams/InboxTeamControls";
import { avatarHint, displayName } from "@/lib/contacts/identity";
import { MIN_TEXT_SEARCH, shortSearchHint } from "@/lib/inbox/search";
import { deriveStatus } from "@/lib/inbox/status-rules";
import { Avatar, Icon, WhatsAppGlyph } from "./Avatar";
import { SavedViews } from "./SavedViews";
import {
  BULK_LIMIT,
  FILTER_TABS,
  filterToQuery,
  relativeTime,
  selectAllVisible,
  shortcutFor,
  statusDisplay,
  stepIndex,
  toggleId,
  type FilterKey,
} from "./helpers";
import type { ConversationSummary, Me, Member } from "./types";
import { useStreamRefresh, type StreamState } from "./useInboxStream";
import { draftKey, highlightParts, notifyUnreadRefresh, previewText, readStore, ROW_HEIGHT, scrollTopFor, visibleRange } from "./ux";

type Page = { items: ConversationSummary[]; nextCursor: string | null; unreadConversations?: number };

const PILL: Record<string, string> = {
  open: "border-emerald-200 bg-emerald-50 text-emerald-800",
  pending: "border-amber-200 bg-amber-50 text-amber-900",
  solved: "border-border bg-surface text-muted",
  expired: "border-red-200 bg-red-50 text-red-800",
  blocked: "border-red-200 bg-red-50 text-red-800",
};

/**
 * The list's single-key shortcuts (j k e a p o x / f) stay quiet when the key comes from inside Eddy, and while any modal is
 * open (docs/EDDY-SPEC.md 6.2, EDDY-15 acceptance 2). Eddy's keyguard already stops keys at its root; this is the second
 * layer, so a key typed in Eddy's composer or on one of its buttons can never move or change the highlighted chat.
 */
export function listShortcutsPaused(target: EventTarget | null, doc: Pick<Document, "querySelector"> | null): boolean {
  if (isInsideEddy(target)) return true;
  return !!doc?.querySelector('[aria-modal="true"], dialog[open]');
}

function Highlight({ text, query }: { text: string; query: string }) {
  return (
    <>
      {highlightParts(text, query).map((p, i) => (p.match ? <mark key={i} className="rounded bg-yellow-200 px-0.5 text-inherit">{p.text}</mark> : <span key={i}>{p.text}</span>))}
    </>
  );
}

function ListSkeleton() {
  return (
    <div role="status" aria-label="Loading conversations" className="divide-y divide-border">
      {Array.from({ length: 7 }, (_, i) => (
        <div key={i} className="flex animate-pulse items-center gap-3 px-4" style={{ height: ROW_HEIGHT }}>
          <div className="h-10 w-10 rounded-full bg-surface" />
          <div className="flex-1 space-y-2">
            <div className="h-3 w-1/2 rounded bg-surface" />
            <div className="h-3 w-5/6 rounded bg-surface" />
            <div className="h-3 w-1/4 rounded bg-surface" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function ConversationList({
  selectedId,
  onSelect,
  members,
  me,
  stream,
  onUnread,
  onHelp,
  refreshKey = 0,
}: {
  selectedId: string | null;
  onSelect: (id: string, via: "pointer" | "keyboard") => void;
  members: Member[];
  me: Me | null;
  stream: StreamState;
  onUnread: (count: number) => void;
  onHelp: () => void;
  /** Bumped by the parent after a change that the live stream does not announce (favourite, mark as unread). */
  refreshKey?: number;
}) {
  const [filter, setFilter] = useState<FilterKey>("all");
  const [tag, setTag] = useState("");
  const [team, setTeam] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [first, setFirst] = useState<ConversationSummary[]>([]);
  const [extra, setExtra] = useState<ConversationSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [bulkTag, setBulkTag] = useState("");
  const [unreadTotal, setUnreadTotal] = useState(0);
  const [cursorId, setCursorId] = useState<string | null>(selectedId);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(600);
  const generation = useRef(0);
  const extraLoadedRef = useRef(false);
  const scroller = useRef<HTMLDivElement>(null);
  const searchBox = useRef<HTMLInputElement>(null);
  const lastOpened = useRef<string | null>(null);

  useEffect(() => {
    extraLoadedRef.current = extra.length > 0;
  }, [extra]);

  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    if (selectedId) {
      setCursorId(selectedId);
      lastOpened.current = selectedId;
    }
  }, [selectedId]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setViewport(el.clientHeight || 600);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const queryString = useCallback(
    (cursor?: string) => {
      const p = new URLSearchParams(filterToQuery(filter));
      if (tag.trim()) p.set("tag", tag.trim());
      if (team) p.set("team", team);
      if (search) p.set("q", search);
      if (cursor) p.set("cursor", cursor);
      return p.toString();
    },
    [filter, tag, team, search],
  );

  useEffect(() => {
    generation.current += 1;
    setFirst([]);
    setExtra([]);
    setLoaded(false);
    scroller.current?.scrollTo({ top: 0 });
  }, [filter, tag, team, search]);

  const refresh = useCallback(async () => {
    const gen = generation.current;
    try {
      const page = await apiFetch<Page>(`/api/inbox/conversations?${queryString()}`);
      if (gen !== generation.current) return;
      setFirst(page.items);
      setNextCursor((prev) => (extraLoadedRef.current ? prev : page.nextCursor));
      setError(null);
      setLoaded(true);
      if (typeof page.unreadConversations === "number") {
        setUnreadTotal(page.unreadConversations);
        onUnread(page.unreadConversations);
      }
    } catch (e) {
      if (gen === generation.current) {
        setError(e instanceof Error ? e.message : "Could not load conversations.");
        setLoaded(true);
      }
    }
  }, [queryString, onUnread]);

  // The query changed: fetch now instead of waiting for the next poll.
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryString]);

  useStreamRefresh(refresh, stream);
  useEffect(() => {
    if (refreshKey > 0) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await apiFetch<Page>(`/api/inbox/conversations?${queryString(nextCursor)}`);
      setExtra((prev) => [...prev, ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load more.");
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, loadingMore, queryString]);

  const firstIds = new Set(first.map((c) => c.id));
  const items = [...first, ...extra.filter((c) => !firstIds.has(c.id))];
  const itemIds = items.map((c) => c.id);
  const memberName = (id: string | null) => (id ? (id === me?.user.id ? "You" : (members.find((m) => m.userId === id)?.name ?? "Teammate")) : null);
  const filtered = filter !== "all" || tag || team || search;
  // Under three characters only names and numbers are searched (message text needs three): the box says so, rather than an
  // unexplained "No conversations match".
  const searchHint = shortSearchHint(search);

  const range = visibleRange(scrollTop, viewport, ROW_HEIGHT, items.length);
  useEffect(() => {
    if (nextCursor && !loadingMore && items.length > 0 && range.end >= items.length - 4) void loadMore();
  }, [range.end, items.length, nextCursor, loadingMore, loadMore]);

  useEffect(() => {
    setSelected((prev) => prev.filter((id) => itemIds.includes(id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length, filter]);

  useEffect(() => {
    if (selectedId === null && lastOpened.current) {
      const id = lastOpened.current;
      lastOpened.current = null;
      requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-conversation="${id}"]`)?.focus());
    }
  }, [selectedId]);

  function moveCursor(id: string) {
    setCursorId(id);
    const el = scroller.current;
    const index = itemIds.indexOf(id);
    if (el && index >= 0) {
      const next = scrollTopFor(index, el.scrollTop, el.clientHeight, ROW_HEIGHT);
      if (next !== el.scrollTop) el.scrollTop = next;
    }
  }

  async function bulk(body: Record<string, unknown>) {
    setNotice(null);
    try {
      const r = await apiFetch<{ updated: number; skipped: { id: string }[] }>("/api/inbox/conversations/bulk", { method: "POST", body: { ids: selected, ...body } });
      setNotice(`${r.updated} updated${r.skipped.length ? `, ${r.skipped.length} skipped` : ""}.`);
      notifyUnreadRefresh();
      setSelected([]);
      setBulkTag("");
      await refresh();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Bulk action failed.");
    }
  }

  async function quickStatus(id: string, status: string) {
    try {
      await apiFetch(`/api/inbox/conversations/${id}/status`, { method: "PATCH", body: { status } });
      setNotice(`Marked ${statusDisplay(status).toLowerCase()}.`);
      notifyUnreadRefresh();
      await refresh();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Could not change the status.");
    }
  }

  async function assignToMe(id: string) {
    if (!me) return;
    try {
      await apiFetch(`/api/inbox/conversations/${id}/assign`, { method: "PUT", body: { userId: me.user.id } });
      setNotice("Assigned to you.");
      await refresh();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Could not assign it.");
    }
  }

  const keyHandler = useRef<(e: KeyboardEvent) => void>(() => undefined);
  useEffect(() => {
    keyHandler.current = (e) => {
      if (listShortcutsPaused(e.target, document)) return;
      const t = e.target as HTMLElement | null;
      const action = shortcutFor({ key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, targetTag: t?.tagName, editable: t?.isContentEditable });
      if (!action) return;
      const current = cursorId ?? selectedId;
      const index = current ? itemIds.indexOf(current) : -1;
      if (action === "next" || action === "prev") {
        const next = itemIds[stepIndex(index, action === "next" ? 1 : -1, itemIds.length)];
        if (next) moveCursor(next);
      } else if (action === "enter" && current) {
        e.preventDefault();
        onSelect(current, "keyboard");
      } else if (action === "solve" && current) void quickStatus(current, "solved");
      else if (action === "assign" && current) void assignToMe(current);
      else if (action === "pending" && current) void quickStatus(current, "pending");
      else if (action === "open" && current) void quickStatus(current, "open");
      else if (action === "select" && current) setSelected((p) => (p.length >= BULK_LIMIT && !p.includes(current) ? p : toggleId(p, current)));
      else if (action === "composer") {
        const box = document.getElementById("inbox-composer");
        if (box) {
          e.preventDefault();
          box.focus();
        }
      } else if (action === "search") {
        e.preventDefault();
        searchBox.current?.focus();
      } else if (action === "help") onHelp();
      else if (action === "escape") setSelected([]);
    };
  });
  useEffect(() => {
    const h = (e: KeyboardEvent) => keyHandler.current(e);
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  const slice = items.slice(range.start, range.end);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="space-y-2 border-b border-border p-3">
        <div className="relative">
          <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <Input ref={searchBox} type="search" aria-label="Search conversations" aria-describedby={searchHint ? "inbox-search-hint" : undefined} placeholder="Search name, number or message (f)" className="pl-9" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} />
        </div>
        <p id="inbox-search-hint" aria-live="polite" className={searchHint ? "text-[11px] text-muted" : "sr-only"}>{searchHint}</p>
        <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-0.5" role="group" aria-label="Filter conversations">
          {FILTER_TABS.map((f) => (
            <button
              key={f.key}
              type="button"
              aria-pressed={filter === f.key}
              title={f.hint}
              onClick={() => setFilter(f.key)}
              className={cn(
                "shrink-0 rounded-full border px-3 py-1 text-xs font-medium focus-visible:outline-2 focus-visible:outline-accent",
                filter === f.key ? "border-accent bg-accent text-white" : "border-border hover:bg-surface",
              )}
            >
              {f.label}
              {f.key === "unread" && unreadTotal > 0 && <span className="ml-1 rounded-full bg-accent px-1.5 text-[10px] text-white">{unreadTotal}</span>}
            </button>
          ))}
        </div>
        <Input aria-label="Filter by tag" placeholder="Filter by tag" value={tag} onChange={(e) => setTag(e.target.value)} />
        <TeamFilter value={team} onChange={setTeam} />
        <SavedViews
          current={{ tab: filter, ...(tag.trim() ? { tag: tag.trim() } : {}), ...(search ? { q: search } : {}) }}
          canShare={!!me && me.role !== "agent"}
          onApply={(q) => {
            setFilter((FILTER_TABS.some((t) => t.key === q.tab) ? q.tab : "all") as FilterKey);
            setTag(q.tag ?? "");
            setSearchInput(q.q ?? "");
          }}
        />
      </div>

      {selected.length > 0 && (
        <div role="toolbar" aria-label="Bulk actions" className="space-y-2 border-b border-border bg-surface p-3 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{selected.length} selected</span>
            <Button variant="ghost" size="sm" onClick={() => setSelected(selectAllVisible(itemIds))}>Select all loaded</Button>
            <Button variant="ghost" size="sm" onClick={() => setSelected([])}>Clear</Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select aria-label="Set status for selected" className="w-auto" value="" onChange={(e) => e.target.value && void bulk({ action: "status", status: e.target.value })}>
              <option value="">Set status</option>
              <option value="open">Open</option>
              <option value="pending">Pending</option>
              <option value="solved">Solved</option>
            </Select>
            <Select aria-label="Assign selected" className="w-auto" value="" onChange={(e) => e.target.value && void bulk({ action: "assign", userId: e.target.value === "__none" ? null : e.target.value })}>
              <option value="">Assign to</option>
              <option value="__none">Unassigned</option>
              {members.map((m) => (
                <option key={m.userId} value={m.userId}>{m.name}</option>
              ))}
            </Select>
            <form
              className="flex gap-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                if (bulkTag.trim()) void bulk({ action: "tag", add: [bulkTag.trim()] });
              }}
            >
              <Input aria-label="Tag to add to selected" placeholder="Add tag" maxLength={40} value={bulkTag} onChange={(e) => setBulkTag(e.target.value)} />
              <Button type="submit" variant="secondary" size="sm" disabled={!bulkTag.trim()}>Tag</Button>
            </form>
          </div>
        </div>
      )}
      <p role="status" aria-live="polite" className={cn("border-b border-border px-3 py-1.5 text-xs text-muted", !notice && "sr-only")}>{notice ?? ""}</p>

      <div ref={scroller} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)} className="min-h-0 flex-1 overflow-y-auto" aria-busy={!loaded}>
        {!loaded && <ListSkeleton />}
        {loaded && error && items.length === 0 && (
          <div className="p-4">
            <EmptyState
              title="Could not load conversations"
              body={`${error} Check your internet connection, then try again. If it keeps happening, sign out and back in.`}
              action={<Button size="sm" onClick={() => void refresh()}>Try again</Button>}
            />
          </div>
        )}
        {loaded && !error && items.length === 0 && (
          <div className="p-4">
            <EmptyState
              title={filtered ? "No conversations match" : "No conversations yet"}
              body={searchHint ? `No name or number matches "${search}". Messages are searched from ${MIN_TEXT_SEARCH} characters, so type a little more.` : filtered ? "Try a different filter or search, or clear them to see everything." : "Messages appear here when customers write to your number. To message someone first, press New chat and send an approved template. Not connected yet? Finish setup first."}
              action={
                filtered ? (
                  <Button size="sm" variant="secondary" onClick={() => { setFilter("all"); setTag(""); setSearchInput(""); }}>Clear filters</Button>
                ) : (
                  <a className="text-sm font-semibold text-accent underline" href="/app/settings/connect">Connect a number</a>
                )
              }
            />
          </div>
        )}
        {loaded && error && items.length > 0 && <p role="alert" className="border-b border-border bg-red-50 px-3 py-1.5 text-xs text-red-800">{error} <button type="button" className="font-semibold underline" onClick={() => void refresh()}>Try again</button></p>}
        {items.length > 0 && (
          <ul role="list" aria-label="Conversations" className="relative" style={{ height: items.length * ROW_HEIGHT }}>
            {slice.map((c, i) => {
              const index = range.start + i;
              const assignee = memberName(c.assignedToId);
              const last = c.messages[0];
              const derived = deriveStatus({ status: c.status, lastInboundAt: c.lastInboundAt, lastMessageAt: c.lastMessageAt });
              const name = displayName(c.contact);
              const draft = selectedId !== c.id ? readStore(draftKey(c.id)) : null;
              const isCursor = cursorId === c.id;
              const unread = c.unreadCount > 0 || !!c.flags?.unread;
              const mine = c.assignedToId !== null && c.assignedToId === me?.user.id;
              const canAssign = !!me && !mine && (c.assignedToId === null || me.role !== "agent");
              return (
                <li
                  key={c.id}
                  aria-posinset={index + 1}
                  aria-setsize={items.length}
                  style={{ position: "absolute", top: index * ROW_HEIGHT, height: ROW_HEIGHT, left: 0, right: 0 }}
                  className={cn("group flex items-stretch border-b border-border", selectedId === c.id && "bg-surface", isCursor && "ring-2 ring-inset ring-accent/40")}
                >
                  <input
                    type="checkbox"
                    aria-label={`Select conversation with ${name}`}
                    className="mx-2 shrink-0 self-center"
                    checked={selected.includes(c.id)}
                    onChange={() => setSelected((p) => (p.length >= BULK_LIMIT && !p.includes(c.id) ? p : toggleId(p, c.id)))}
                  />
                  <button
                    type="button"
                    data-conversation={c.id}
                    onClick={() => onSelect(c.id, "pointer")}
                    onFocus={() => setCursorId(c.id)}
                    aria-current={selectedId === c.id ? "true" : undefined}
                    className="flex min-w-0 flex-1 items-center gap-3 pr-3 text-left hover:bg-surface focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
                  >
                    <Avatar id={c.contact.id} name={c.contact.name} phone={avatarHint(c.contact)} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center justify-between gap-2">
                        <span className={cn("truncate text-sm", unread ? "font-semibold" : "font-medium")}><Highlight text={name} query={search} /></span>
                        <span className={cn("shrink-0 text-xs", unread ? "font-semibold text-accent" : "text-muted")}>{relativeTime(last?.createdAt ?? c.lastMessageAt)}</span>
                      </span>
                      <span className="mt-0.5 flex items-center justify-between gap-2">
                        <span className={cn("truncate text-xs", unread ? "text-foreground" : "text-muted")}>
                          {draft ? <><span className="font-semibold text-red-700">Draft: </span>{draft.slice(0, 60)}</> : c.matchSnippet ? <><span className="font-semibold">Message: </span><Highlight text={c.matchSnippet} query={search} /></> : previewText(last)}
                        </span>
                        {unread && (
                          <span className="shrink-0 rounded-full bg-accent px-2 py-0.5 text-xs font-semibold text-white" aria-label={c.unreadCount > 0 ? `${c.unreadCount} unread` : "Marked as unread"}>
                            {c.unreadCount > 99 ? "99+" : c.unreadCount > 0 ? c.unreadCount : "\u2022"}
                          </span>
                        )}
                      </span>
                      <span className="mt-1.5 flex items-center gap-1.5 overflow-hidden">
                        <span className={cn("shrink-0 rounded-full border px-2 text-[10px] font-medium leading-4", PILL[derived] ?? PILL.open)}>{statusDisplay(derived)}</span>
                        <WhatsAppGlyph />
                        {c.flags?.favorite && <Icon name="star" className="h-3 w-3 fill-current text-warn-fg" />}
                        {c.flags?.mention && <span className="shrink-0 rounded-full border border-info-line bg-info-soft px-1.5 text-[10px] font-medium leading-4 text-info-fg">Mentioned you</span>}
                        {c.labels?.includes("new") && <span className="shrink-0 rounded-full border border-info-line bg-info-soft px-1.5 text-[10px] font-medium leading-4 text-info-fg">New</span>}
                        {c.labels?.includes("campaign") && <span className="shrink-0 rounded-full border border-warn-line bg-warn-soft px-1.5 text-[10px] font-medium leading-4 text-warn-fg">Campaign</span>}
                        {search && c.contact.name && c.contact.phone?.includes(search) && <span className="truncate text-[11px] text-muted"><Highlight text={c.contact.phone} query={search} /></span>}
                        {c.tags.slice(0, 2).map((t) => (
                          <span key={t} className="max-w-20 truncate rounded-full bg-emerald-50 px-1.5 text-[10px] leading-4 text-emerald-800">{t}</span>
                        ))}
                        {assignee && (
                          <span className="ml-auto shrink-0">
                            <Avatar id={c.assignedToId ?? "x"} name={assignee === "You" ? me?.user.name ?? "You" : assignee} size="sm" title={`Assigned to ${assignee}`} />
                          </span>
                        )}
                      </span>
                    </span>
                  </button>
                  <div className="pointer-events-none absolute right-2 top-1.5 flex gap-1 rounded-full border border-border bg-background/95 p-0.5 opacity-0 shadow-sm transition-opacity focus-within:pointer-events-auto focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100">
                    {derived !== "solved" && (
                      <button type="button" title="Mark solved (e)" aria-label={`Mark conversation with ${name} solved`} onClick={() => void quickStatus(c.id, "solved")} className="rounded-full p-1.5 hover:bg-surface">
                        <Icon name="check" />
                      </button>
                    )}
                    {canAssign && (
                      <button type="button" title="Assign to me (a)" aria-label={`Assign conversation with ${name} to me`} onClick={() => void assignToMe(c.id)} className="rounded-full p-1.5 hover:bg-surface">
                        <Icon name="userPlus" />
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {nextCursor && (
          <div className="p-3 text-center">
            <Button variant="secondary" size="sm" onClick={() => void loadMore()} disabled={loadingMore}>
              {loadingMore ? "Loading" : "Load more"}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
