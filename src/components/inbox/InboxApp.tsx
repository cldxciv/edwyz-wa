"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch, Button, cn } from "@/components/ui";
import { EDDY_EVENTS, onEddyEvent, type EddyDidDetail, type EddyEntity } from "@/components/eddy/events";
import { Icon } from "./Avatar";
import { ChatView } from "./ChatView";
import { ConversationList } from "./ConversationList";
import { COMPOSER_SHORTCUTS, SHORTCUTS, streamBadge, titleWithUnread } from "./helpers";
import { InboxSettingsDialog } from "./InboxSettingsDialog";
import { MentionsMenu } from "./MentionsMenu";
import { NewChatDialog } from "./NewChatDialog";
import { QuickRepliesDialog } from "./QuickRepliesDialog";
import { SidePanel } from "./SidePanel";
import type { ConversationDetail, Me, Member } from "./types";
import { useInboxStream } from "./useInboxStream";
import { clampListWidth, notifyUnreadRefresh, LIST_DEFAULT, LIST_WIDTH_KEY, PANEL_KEY, parseStoredWidth, readStore, writeStore } from "./ux";

type Detail = ConversationDetail["conversation"];

function useMedia(query: string) {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(query);
    setMatches(mq.matches);
    const on = () => setMatches(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return matches;
}

const CONVERSATION_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Keeps /app/inbox?c=<id> in the address bar so a chat can be shared and survives a reload. */
function writeChatUrl(id: string | null) {
  try {
    window.history.replaceState(null, "", id ? `${window.location.pathname}?c=${encodeURIComponent(id)}` : window.location.pathname);
  } catch {
    // history unavailable: the link simply is not updated
  }
}

function HelpDialog({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const list = (title: string, rows: { keys: string; action: string }[]) => (
    <section>
      <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">{title}</h3>
      <dl className="space-y-1.5 text-sm">
        {rows.map((k) => (
          <div key={k.keys} className="flex justify-between gap-4">
            <dt><kbd className="rounded border border-border bg-surface px-1.5 py-0.5 font-mono text-xs font-semibold">{k.keys}</kbd></dt>
            <dd className="text-right text-muted">{k.action}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
  return (
    <dialog ref={dialog} onClose={onClose} aria-labelledby="inbox-help-title" className="m-auto w-[min(30rem,calc(100vw-2rem))] rounded-2xl border border-border bg-background p-0 text-foreground backdrop:bg-black/40">
      <div className="max-h-[85dvh] space-y-4 overflow-y-auto p-5">
        <div className="flex items-center justify-between">
          <h2 id="inbox-help-title" className="text-lg font-semibold">Keyboard shortcuts</h2>
          <Button variant="ghost" size="sm" autoFocus onClick={() => dialog.current?.close()}>Close</Button>
        </div>
        {list("In the conversation list", SHORTCUTS)}
        {list("In the message box", COMPOSER_SHORTCUTS)}
        <p className="text-xs text-muted">List shortcuts are off while you type in a field. Press Esc to close this window.</p>
      </div>
    </dialog>
  );
}

const sameDetail = (a: Detail | null, b: Detail) => a !== null && JSON.stringify(a) === JSON.stringify(b);

/** What Eddy changed that the inbox shows: chats, contacts, quick replies, teams, bots and automations (6.4). */
export const INBOX_EDDY_ENTITIES: readonly EddyEntity[] = ["conversation", "contact", "quick_reply", "team", "chatbot", "automation", "template"];

/** True when a `wa:eddy-did` should refetch the list and the open chat (EDDY-15 acceptance 3). */
export function eddyDidRefreshesInbox(detail: EddyDidDetail): boolean {
  return INBOX_EDDY_ENTITIES.includes(detail.entity);
}

export function InboxApp() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState(false);
  const [panelPref, setPanelPref] = useState(false);
  const [mobilePanel, setMobilePanel] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [members, setMembers] = useState<Member[]>([]);
  const [me, setMe] = useState<Me | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);
  const [listWidth, setListWidth] = useState(LIST_DEFAULT);
  const stream = useInboxStream();
  const wide = useMedia("(min-width: 1024px)");
  const veryWide = useMedia("(min-width: 1280px)");
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    const base = document.title.replace(/^\(\d+\+?\)\s/, "");
    document.title = titleWithUnread(base, unread);
    return () => {
      document.title = base;
    };
  }, [unread]);

  useEffect(() => {
    apiFetch<{ members: Member[] }>("/api/workspace/members").then((r) => setMembers(r.members), () => undefined);
    apiFetch<Me>("/api/auth/me").then(setMe, () => undefined);
    setListWidth(parseStoredWidth(readStore(LIST_WIDTH_KEY)));
    const linked = new URLSearchParams(window.location.search).get("c");
    if (linked && CONVERSATION_ID.test(linked)) {
      setSelectedId(linked);
      setFocusRequest(true);
    }
  }, []);

  useEffect(() => {
    const stored = readStore(PANEL_KEY);
    setPanelPref(stored === null ? veryWide : stored === "1");
  }, [veryWide]);

  const select = useCallback((id: string) => {
    writeChatUrl(id);
    setSelectedId(id);
    // Picking the chat that is already open (say after a reload restored ?c=) keeps its details: ChatView is keyed by the id, so it
    // does not reload and send them again, and the contact panel sat on "Loading contact" until the next poll.
    setDetail((d) => (d?.id === id ? d : null));
    setMobilePanel(false);
    setFocusRequest(true);
  }, []);

  const onDetail = useCallback((d: Detail | null) => setDetail((prev) => (d === null || !sameDetail(prev, d) ? d : prev)), []);
  const lastUnread = useRef<number | null>(null);
  const onUnread = useCallback((n: number) => {
    setUnread(n);
    // The list just received the count, so the shell badge is told the number instead of fetching it again.
    if (lastUnread.current !== n) notifyUnreadRefresh(n);
    lastUnread.current = n;
  }, []);
  // Every change refreshes the list, and the list passes the unread count on, so the shell is not asked to fetch it separately.
  const onChanged = useCallback(() => setRefreshKey((n) => n + 1), []);
  // Eddy tagged, assigned or changed something (6.4): refetch the list and the open chat, as after the inbox's own changes.
  useEffect(() => onEddyEvent(EDDY_EVENTS.did, (d) => {
    if (eddyDidRefreshesInbox(d)) onChanged();
  }), [onChanged]);
  const canDelete = me?.role === "owner" || me?.role === "admin";
  const back = () => {
    writeChatUrl(null);
    setSelectedId(null);
    setMobilePanel(false);
    setDetail(null);
  };

  const panelOpen = wide ? panelPref : mobilePanel;
  function setPref(open: boolean) {
    setPanelPref(open);
    writeStore(PANEL_KEY, open ? "1" : "0");
  }
  const togglePanel = () => (wide ? setPref(!panelPref) : setMobilePanel((v) => !v));
  const closePanel = () => (wide ? setPref(false) : setMobilePanel(false));

  function startDrag(e: React.PointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { startX: e.clientX, startWidth: listWidth };
  }
  function moveDrag(e: React.PointerEvent<HTMLDivElement>) {
    if (drag.current) setListWidth(clampListWidth(drag.current.startWidth + e.clientX - drag.current.startX));
  }
  function endDrag() {
    if (!drag.current) return;
    drag.current = null;
    writeStore(LIST_WIDTH_KEY, String(listWidth));
  }
  function resizeKey(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const next = clampListWidth(listWidth + (e.key === "ArrowRight" ? 16 : -16));
    setListWidth(next);
    writeStore(LIST_WIDTH_KEY, String(next));
  }

  return (
    // The shell gives the inbox page a column exactly one screen tall (AppShell), so the inbox takes whatever is left below the
    // banners and the top bar instead of guessing their height; the page itself does not scroll, only the panes do.
    <div className="flex min-h-72 flex-1 flex-col overflow-hidden rounded-2xl border border-border bg-background">
      {/* With a chat open on a phone or tablet, the chat gets the room; the inbox tools are one Back away. */}
      {selectedId && <h1 className="sr-only lg:hidden">Inbox</h1>}
      <div className={cn("flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2", selectedId && "max-lg:hidden")}>
        <h1 className="text-base font-semibold">Inbox</h1>
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 text-xs text-muted" title={streamBadge(stream.mode).title}>
            <span aria-hidden className={cn("h-2 w-2 rounded-full", streamBadge(stream.mode).dot)} />
            {streamBadge(stream.mode).label}
          </span>
          {/* The text is hidden on phones, so the button carries its own name. */}
          <Button variant="ghost" size="sm" onClick={() => setHelpOpen(true)} aria-haspopup="dialog" aria-label="Keyboard shortcuts"><Icon name="keyboard" /> <span className="hidden sm:inline">Shortcuts</span></Button>
          <MentionsMenu onOpen={select} refreshKey={refreshKey} />
          <Button variant="secondary" size="sm" onClick={() => setQuickOpen(true)}>Quick replies</Button>
          {canDelete && <Button variant="ghost" size="sm" onClick={() => setSettingsOpen(true)} aria-haspopup="dialog">Inbox settings</Button>}
          <Button size="sm" onClick={() => setNewChatOpen(true)} aria-haspopup="dialog"><Icon name="plus" /> New chat</Button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        <div
          style={{ "--list-w": `${listWidth}px` } as React.CSSProperties}
          className={cn("min-h-0 w-full border-border lg:block lg:w-[var(--list-w)] lg:shrink-0 lg:border-r", selectedId ? "hidden" : "block")}
        >
          <ConversationList selectedId={selectedId} onSelect={select} members={members} me={me} stream={stream} onUnread={onUnread} onHelp={() => setHelpOpen((v) => !v)} refreshKey={refreshKey} />
        </div>

        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize conversation list"
          aria-valuemin={260}
          aria-valuemax={520}
          aria-valuenow={listWidth}
          tabIndex={0}
          onPointerDown={startDrag}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onKeyDown={resizeKey}
          className="-mx-1 hidden w-2 shrink-0 cursor-col-resize touch-none self-stretch transition-colors hover:bg-accent/20 focus-visible:bg-accent/30 focus-visible:outline-none lg:block"
        />

        <div className={cn("min-h-0 min-w-0 flex-1", selectedId ? "block" : "hidden lg:block")}>
          {selectedId ? (
            <ChatView
              key={selectedId}
              conversationId={selectedId}
              refreshKey={refreshKey}
              focusComposer={focusRequest}
              onBack={back}
              onTogglePanel={togglePanel}
              panelOpen={panelOpen}
              onChanged={onChanged}
              detailRef={onDetail}
              stream={stream}
              members={members}
              me={me}
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
              <p className="text-sm font-semibold">Pick a conversation</p>
              <p className="max-w-xs text-sm text-muted">
                Choose a chat on the left, or press <kbd className="rounded border border-border bg-surface px-1 font-mono text-xs">j</kbd> and <kbd className="rounded border border-border bg-surface px-1 font-mono text-xs">k</kbd> to move and <kbd className="rounded border border-border bg-surface px-1 font-mono text-xs">Enter</kbd> to open. Press <kbd className="rounded border border-border bg-surface px-1 font-mono text-xs">?</kbd>{" "}for all shortcuts.
              </p>
            </div>
          )}
        </div>

        {selectedId && panelOpen && (
          <div className="fixed inset-0 z-40 bg-background lg:static lg:inset-auto lg:z-auto lg:w-80 lg:shrink-0 lg:border-l lg:border-border">
            {detail && detail.id === selectedId ? (
              <SidePanel key={detail.id} conversation={detail} members={members} canBlock={canDelete} onClose={closePanel} onChanged={onChanged} />
            ) : (
              <div role="status" aria-label="Loading contact" className="animate-pulse space-y-3 p-4">
                <div className="h-12 w-12 rounded-full bg-surface" />
                <div className="h-3 w-2/3 rounded bg-surface" />
                <div className="h-3 w-1/2 rounded bg-surface" />
              </div>
            )}
          </div>
        )}
      </div>
      {quickOpen && <QuickRepliesDialog canDelete={canDelete} onClose={() => setQuickOpen(false)} />}
      {newChatOpen && (
        <NewChatDialog
          isAdmin={canDelete}
          onClose={() => setNewChatOpen(false)}
          onStarted={(id) => {
            onChanged();
            select(id);
          }}
        />
      )}
      {settingsOpen && <InboxSettingsDialog onClose={() => setSettingsOpen(false)} />}
      {helpOpen && <HelpDialog onClose={() => setHelpOpen(false)} />}
    </div>
  );
}
