"use client";
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { apiFetch, Button, cn, EmptyState, Select } from "@/components/ui";
import { avatarHint, displayName, displaySubtitle } from "@/lib/contacts/identity";
import { deriveStatus } from "@/lib/inbox/status-rules";
import { Avatar, Icon, WhatsAppGlyph } from "./Avatar";
import { ConversationBot } from "@/components/chatbots/ConversationBot";
import { ChatMenu } from "./ChatMenu";
import { Composer } from "./Composer";
import { mergeById, statusDisplay, windowRemainingMs, type InboxMessage } from "./helpers";
import { applyLatestPage, applyOlderPage, EMPTY_HISTORY, restoredScrollTop, type History } from "./history";
import { Bubble, Lightbox, NoteBubble, UnreadLine, type LightboxItem } from "./MessageBubble";
import { fetchNotes } from "./notes-cache";
import type { ConversationDetail, Me, Member, TemplateOption } from "./types";
import { usePolling } from "./usePolling";
import { useStreamRefresh, type StreamState } from "./useInboxStream";
import { buildTimeline, mediaPreview, newInbound, notifyUnreadRefresh, type ChatMessage, type NoteItem, type SentAttachment } from "./ux";

const NOTE_UNDO_MS = 5000;

function ChatSkeleton() {
  return (
    <div role="status" aria-label="Loading messages" className="animate-pulse space-y-3 p-4">
      {[["w-2/5", "justify-start"], ["w-1/2", "justify-end"], ["w-1/3", "justify-start"], ["w-2/5", "justify-end"]].map(([w, side], i) => (
        <div key={i} className={cn("flex", side)}>
          <div className={cn("h-10 rounded-2xl bg-surface", w)} />
        </div>
      ))}
    </div>
  );
}

export function ChatView({
  conversationId,
  refreshKey,
  focusComposer,
  onBack,
  onTogglePanel,
  panelOpen,
  onChanged,
  detailRef,
  stream,
  members,
  me,
}: {
  conversationId: string;
  refreshKey: number;
  focusComposer: boolean;
  onBack: () => void;
  onTogglePanel: () => void;
  panelOpen: boolean;
  onChanged: () => void;
  detailRef: (d: ConversationDetail["conversation"] | null) => void;
  stream: StreamState;
  members: Member[];
  me: Me | null;
}) {
  const [history, setHistory] = useState<History>(EMPTY_HISTORY);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const { latest, older, cursor: olderCursor } = history;
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [notes, setNotes] = useState<NoteItem[]>([]);
  const [pendingNotes, setPendingNotes] = useState<NoteItem[]>([]);
  const [locals, setLocals] = useState<ChatMessage[]>([]);
  const [templates, setTemplates] = useState<TemplateOption[] | null>(null);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [lightbox, setLightbox] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const [announcement, setAnnouncement] = useState("");
  const [unseen, setUnseen] = useState(0);
  const [restore, setRestore] = useState<{ text: string; nonce: number } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const atBottom = useRef(true);
  const lastCount = useRef(0);
  const seenIds = useRef<Set<string> | null>(null);
  const localSeq = useRef(0);
  const noteTimers = useRef(new Map<string, { timer: ReturnType<typeof setTimeout>; body: string }>());
  const opened = useRef(false);
  // Set while older messages are being merged in above the reader, so the merge is not counted as new unseen messages.
  const pagingBack = useRef(false);
  // Set when this view made the change it reports. The parent answers every change by bumping refreshKey; a bump this view caused
  // is skipped because it has already reloaded, otherwise every send, read mark and status change fetched the chat twice.
  const selfChange = useRef(false);
  const [unreadAtOpen, setUnreadAtOpen] = useState(0);

  const changed = useCallback(() => {
    selfChange.current = true;
    onChanged();
  }, [onChanged]);

  const load = useCallback(async () => {
    try {
      const d = await apiFetch<ConversationDetail>(`/api/inbox/conversations/${conversationId}`);
      setDetail(d);
      detailRef(d.conversation);
      // A functional update reads the current paging state, never a stale one captured when this refresh started.
      setHistory((h) => applyLatestPage(h, d));
      setError(null);
      if (!opened.current) {
        // The unread line is placed from the count at the moment the chat is opened, before reading clears it.
        opened.current = true;
        setUnreadAtOpen(Math.max(d.conversation.unreadCount, d.conversation.flags?.unread ? 1 : 0));
        void apiFetch(`/api/inbox/conversations/${conversationId}/read`, { method: "POST", body: {} }).then(changed, () => undefined);
      } else if (d.conversation.unreadCount > 0 && document.visibilityState === "visible") {
        void apiFetch(`/api/inbox/conversations/${conversationId}/read`, { method: "POST", body: {} }).then(() => notifyUnreadRefresh(), () => undefined);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load this conversation.");
    }
  }, [conversationId, detailRef, changed]);

  const loadNotes = useCallback(
    async (fresh = false) => {
      setNotes(await fetchNotes(conversationId, { fresh }));
    },
    [conversationId],
  );

  const loadTemplates = useCallback(() => {
    setTemplatesError(null);
    apiFetch<{ templates: TemplateOption[] }>("/api/templates").then(
      (r) => setTemplates(r.templates),
      (e: unknown) => setTemplatesError(e instanceof Error ? e.message : "Could not load templates."),
    );
  }, []);

  useStreamRefresh(load, stream, conversationId);
  usePolling(loadNotes, 10_000);
  useEffect(() => {
    loadTemplates();
  }, [loadTemplates]);
  useEffect(() => {
    if (refreshKey === 0) return;
    if (selfChange.current) {
      selfChange.current = false;
      return;
    }
    void load();
    void loadNotes().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const timers = noteTimers.current;
    return () => {
      for (const [, entry] of timers) {
        clearTimeout(entry.timer);
        void apiFetch(`/api/inbox/conversations/${conversationId}/notes`, { method: "POST", body: { body: entry.body } }).catch(() => undefined);
      }
      timers.clear();
    };
  }, [conversationId]);

  const messages = useMemo(() => mergeById(older, latest) as ChatMessage[], [older, latest]);
  const allMessages = useMemo(() => [...messages, ...locals], [messages, locals]);
  const days = useMemo(() => buildTimeline(allMessages, [...notes, ...pendingNotes], now), [allMessages, notes, pendingNotes, now]);
  const total = allMessages.length + notes.length + pendingNotes.length;
  const unreadFromId = useMemo(() => {
    if (unreadAtOpen <= 0) return null;
    const inbound = messages.filter((m) => m.direction === "inbound").sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    return inbound.length ? inbound[Math.max(inbound.length - unreadAtOpen, 0)].id : null;
  }, [messages, unreadAtOpen]);

  const media = useMemo<LightboxItem[]>(
    () =>
      allMessages.flatMap((m) => {
        const p = mediaPreview(m);
        return p && p.src && (p.kind === "image" || p.kind === "video") ? [{ src: p.src, kind: p.kind }] : [];
      }),
    [allMessages],
  );

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && atBottom.current && total !== lastCount.current) el.scrollTop = el.scrollHeight;
    else if (!pagingBack.current && total > lastCount.current && lastCount.current > 0) setUnseen((n) => n + (total - lastCount.current));
    lastCount.current = total;
  }, [total]);

  useEffect(() => {
    if (!detail) return;
    if (seenIds.current === null) {
      seenIds.current = new Set(messages.map((m) => m.id));
      return;
    }
    const fresh = newInbound(seenIds.current, messages);
    for (const m of messages) seenIds.current.add(m.id);
    if (fresh) setAnnouncement(`New message from ${displayName(detail.conversation.contact)}: ${fresh.text}`);
  }, [messages, detail]);

  useEffect(() => {
    if (!detail || !focusComposer) return;
    const wide = typeof window !== "undefined" && window.matchMedia("(min-width: 1024px)").matches;
    (wide ? document.getElementById("inbox-composer") : heading.current)?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail !== null]);

  async function change(path: "status" | "assign", body: unknown) {
    setActionError(null);
    try {
      await apiFetch(`/api/inbox/conversations/${conversationId}/${path}`, { method: path === "status" ? "PATCH" : "PUT", body });
      await load();
      changed();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "That did not work.");
    }
  }

  async function loadOlder() {
    if (!olderCursor || loadingOlder) return;
    const el = scroller.current;
    const before = { top: el?.scrollTop ?? 0, height: el?.scrollHeight ?? 0 };
    setLoadingOlder(true);
    try {
      const d = await apiFetch<ConversationDetail>(`/api/inbox/conversations/${conversationId}?cursor=${encodeURIComponent(olderCursor)}`);
      pagingBack.current = true;
      setHistory((h) => applyOlderPage(h, d));
      requestAnimationFrame(() => {
        pagingBack.current = false;
        // Keeps the message the reader was on in place; when the page added nothing the height is unchanged and nothing moves.
        if (el) el.scrollTop = restoredScrollTop(before.top, before.height, el.scrollHeight);
      });
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Could not load older messages.");
    } finally {
      setLoadingOlder(false);
    }
  }

  const post = useCallback(
    async (payload: Record<string, unknown>) => {
      const r = await apiFetch<{ message: InboxMessage }>(`/api/inbox/conversations/${conversationId}/messages`, { method: "POST", body: payload });
      setHistory((h) => ({ ...h, latest: mergeById(h.latest, [r.message]) }));
      atBottom.current = true;
      changed();
      void load();
      return r.message;
    },
    [conversationId, load, changed],
  );

  const sendText = useCallback(
    (body: string, retryId?: string) => {
      const id = retryId ?? `local-${Date.now()}-${localSeq.current++}`;
      const optimistic: ChatMessage = { id, direction: "outbound", type: "text", body, mediaUrl: null, mediaMime: null, templateName: null, status: "queued", errorCode: null, createdAt: new Date().toISOString(), local: true };
      setLocals((cur) => (retryId ? cur.map((m) => (m.id === id ? { ...optimistic, createdAt: m.createdAt } : m)) : [...cur, optimistic]));
      atBottom.current = true;
      post({ type: "text", body }).then(
        () => setLocals((cur) => cur.filter((m) => m.id !== id)),
        (e: unknown) => setLocals((cur) => cur.map((m) => (m.id === id ? { ...m, status: "failed", localError: e instanceof Error ? e.message : "Could not send the message." } : m))),
      );
    },
    [post],
  );

  const addNote = useCallback(
    (body: string) => {
      const id = `pending-${Date.now()}-${localSeq.current++}`;
      const note: NoteItem = { id, authorId: me?.user.id ?? "", body, createdAt: new Date().toISOString(), pending: true };
      setPendingNotes((cur) => [...cur, note]);
      atBottom.current = true;
      const timer = setTimeout(() => {
        noteTimers.current.delete(id);
        apiFetch(`/api/inbox/conversations/${conversationId}/notes`, { method: "POST", body: { body } }).then(
          async () => {
            await loadNotes(true).catch(() => undefined);
            setPendingNotes((cur) => cur.filter((n) => n.id !== id));
          },
          (e: unknown) => {
            setPendingNotes((cur) => cur.filter((n) => n.id !== id));
            setActionError(e instanceof Error ? `The note was not saved: ${e.message}` : "The note was not saved.");
            setRestore({ text: body, nonce: Date.now() });
          },
        );
      }, NOTE_UNDO_MS);
      noteTimers.current.set(id, { timer, body });
    },
    [conversationId, loadNotes, me],
  );

  function undoNote(note: NoteItem) {
    const entry = noteTimers.current.get(note.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    noteTimers.current.delete(note.id);
    setPendingNotes((cur) => cur.filter((n) => n.id !== note.id));
    setRestore({ text: note.body, nonce: Date.now() });
  }

  async function sendMedia(file: SentAttachment, caption: string) {
    const ref = file.key ? { mediaKey: file.key } : { mediaId: file.mediaId, ...(file.filename ? { filename: file.filename } : {}), ...(file.mime ? { mime: file.mime } : {}) };
    await post({ type: file.kind, ...ref, ...(caption && file.kind !== "audio" && file.kind !== "sticker" ? { caption } : {}) });
  }

  async function setMark(body: { favorite?: boolean; unread?: boolean }) {
    setActionError(null);
    try {
      await apiFetch(`/api/inbox/conversations/${conversationId}/marks`, { method: "PUT", body });
      await load();
      changed();
      return true;
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "That did not work.");
      return false;
    }
  }

  async function markUnreadAndLeave() {
    if (await setMark({ unread: true })) onBack();
  }

  async function sendTemplate(templateId: string, variables: string[]) {
    await post({ type: "template", templateId, variables });
  }

  const remaining = windowRemainingMs(detail?.conversation.lastInboundAt, now);
  const windowOpen = detail ? detail.windowOpen && remaining > 0 : false;
  const contact = detail?.conversation.contact;
  const authorName = (id: string) => (id === me?.user.id ? "You" : (members.find((m) => m.userId === id)?.name ?? "Teammate"));
  const derived = detail ? deriveStatus({ status: detail.conversation.status, lastInboundAt: detail.conversation.lastInboundAt, lastMessageAt: detail.conversation.lastMessageAt }) : null;
  const gone = error !== null && /not found/i.test(error);
  const favorite = detail?.conversation.flags?.favorite ?? false;
  const assignedToOther = me?.role === "agent" && !!detail?.conversation.assignedToId && detail.conversation.assignedToId !== me.user.id;

  function openMedia(src: string) {
    const index = media.findIndex((m) => m.src === src);
    setLightboxIndex(Math.max(index, 0));
    setLightbox(true);
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2.5">
        <Button variant="ghost" size="sm" className="lg:hidden" onClick={onBack} aria-label="Back to conversations">
          <Icon name="back" /> Back
        </Button>
        {contact && <Avatar id={contact.id} name={contact.name} phone={avatarHint(contact)} />}
        <div className="min-w-[8rem] flex-1">
          <h2 ref={heading} tabIndex={-1} className="flex items-center gap-1.5 truncate text-sm font-semibold focus:outline-none">
            <span className="truncate">{contact ? displayName(contact) : "Loading"}</span>
            {contact && <WhatsAppGlyph />}
          </h2>
          {contact && (
            <p className="truncate text-xs text-muted">
              {displaySubtitle(contact)}
              {detail?.conversation.phoneNumber?.displayPhone ? `${displaySubtitle(contact) ? " · " : ""}via ${detail.conversation.phoneNumber.displayPhone}` : ""}
            </p>
          )}
        </div>
        {detail && derived && (
          <>
            <ConversationBot conversationId={conversationId} onChanged={onChanged} />
            {derived !== "solved" && (
              <Button variant="secondary" size="sm" onClick={() => void change("status", { status: "solved" })} title="Mark solved (e)" aria-label="Solve">
                <Icon name="check" /> <span className="hidden sm:inline">Solve</span>
              </Button>
            )}
            <Select
              aria-label="Conversation status"
              className="hidden w-auto py-1 text-xs md:block"
              value={derived === "expired" ? "expired" : detail.conversation.status === "resolved" ? "solved" : detail.conversation.status}
              onChange={(e) => void change("status", { status: e.target.value })}
            >
              <option value="open">Open</option>
              <option value="pending">Pending</option>
              <option value="solved">Solved</option>
              {(me?.role !== "agent" || detail.conversation.status === "blocked") && <option value="blocked">Blocked</option>}
              <option value="expired" disabled>{statusDisplay("expired")}</option>
            </Select>
            <Select aria-label="Assignee" className="hidden w-auto py-1 text-xs md:block" value={detail.conversation.assignedToId ?? ""} onChange={(e) => void change("assign", { userId: e.target.value || null })}>
              <option value="">Unassigned</option>
              {members.map((m) => (
                <option key={m.userId} value={m.userId}>{m.name}</option>
              ))}
            </Select>
          </>
        )}
        {detail && (
          <>
            <Button variant="ghost" size="sm" aria-pressed={favorite} aria-label={favorite ? "Remove from favorites" : "Add to favorites"} title={favorite ? "Remove from favorites" : "Add to favorites"} onClick={() => void setMark({ favorite: !favorite })}>
              <Icon name="star" className={favorite ? "fill-current text-warn-fg" : undefined} />
            </Button>
            <ChatMenu conversationId={conversationId} onMarkUnread={() => void markUnreadAndLeave()} />
          </>
        )}
        <Button variant={panelOpen ? "primary" : "secondary"} size="sm" onClick={onTogglePanel} aria-pressed={panelOpen} aria-label="Contact details">
          <Icon name="panel" /> <span className="hidden sm:inline">Details</span>
        </Button>
      </header>

      <div className="relative min-h-0 flex-1">
        <div
          ref={scroller}
          role="log"
          tabIndex={0}
          aria-label="Messages"
          aria-live="off"
          className="h-full overflow-y-auto px-3 py-3 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
          onScroll={(e) => {
            const el = e.currentTarget;
            atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            if (atBottom.current) setUnseen(0);
          }}
        >
          {!detail && !error && <ChatSkeleton />}
          {error && !detail && (
            <div className="p-4">
              <EmptyState
                title={gone ? "This conversation is no longer available" : "Could not load this conversation"}
                body={gone ? "It may have been removed. Go back to the list and pick another." : `${error} Check your internet connection and try again.`}
                action={gone ? <Button size="sm" onClick={onBack}>Back to the list</Button> : <Button size="sm" onClick={() => void load()}>Try again</Button>}
              />
            </div>
          )}
          {detail && total === 0 && <EmptyState title="No messages yet" body="Send an approved template to start the conversation. Customers can reply once they have received it." />}
          {olderCursor && (
            <div className="py-2 text-center">
              <Button variant="secondary" size="sm" disabled={loadingOlder} onClick={() => void loadOlder()}>{loadingOlder ? "Loading…" : "Load older messages"}</Button>
            </div>
          )}
          {days.map((day) => (
            <section key={day.key} aria-label={day.label}>
              <div className="sticky top-0 z-[1] my-2 text-center">
                <span className="rounded-full bg-surface px-3 py-1 text-xs text-muted shadow-sm">{day.label}</span>
              </div>
              {day.entries.map((entry) => (
                <Fragment key={entry.id}>
                  {entry.kind === "message" && entry.id === unreadFromId && <UnreadLine />}
                  {entry.kind === "message" ? (
                    <Bubble
                      m={entry.message}
                      first={entry.first}
                      last={entry.last}
                      templates={templates ?? []}
                      onOpenMedia={openMedia}
                      onRetry={(m) => (m.body ? sendText(m.body, m.local ? m.id : undefined) : undefined)}
                      onDiscard={(m) => setLocals((cur) => cur.filter((x) => x.id !== m.id))}
                    />
                  ) : (
                    <NoteBubble note={entry.note} author={authorName(entry.note.authorId)} first={entry.first} last={entry.last} onUndo={undoNote} members={members} />
                  )}
                </Fragment>
              ))}
            </section>
          ))}
        </div>
        {unseen > 0 && (
          <button
            type="button"
            onClick={() => {
              const el = scroller.current;
              if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
              setUnseen(0);
            }}
            className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-accent px-4 py-1.5 text-xs font-semibold text-white shadow-lg"
          >
            {unseen} new {unseen === 1 ? "message" : "messages"}
          </button>
        )}
      </div>

      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</div>

      {(actionError || (error && detail)) && (
        <p role="alert" className="flex items-center justify-between gap-2 border-t border-border bg-red-50 px-3 py-1.5 text-xs text-red-800">
          <span>{actionError ?? `Connection problem: ${(error ?? "").replace(/\.+$/, "")}. Messages will refresh when it is back.`}</span>
          {actionError && <button type="button" className="font-semibold underline" onClick={() => setActionError(null)}>Dismiss</button>}
        </p>
      )}

      {assignedToOther && <p role="status" className="border-t border-border bg-surface px-3 py-1.5 text-xs text-muted">This conversation is assigned to {authorName(detail?.conversation.assignedToId ?? "")}. Only they or an admin can reply.</p>}

      <Composer
        conversationId={conversationId}
        windowOpen={windowOpen}
        remainingMs={remaining}
        lastInboundAt={detail?.conversation.lastInboundAt ?? null}
        now={now}
        disabled={!detail || assignedToOther}
        contactName={contact?.name ?? null}
        contactPhone={contact?.phone ?? ""}
        agentName={me?.user.name ?? ""}
        members={members}
        templates={templates}
        templatesError={templatesError}
        onReloadTemplates={loadTemplates}
        onSendText={sendText}
        onSendMedia={sendMedia}
        onSendTemplate={sendTemplate}
        onAddNote={addNote}
        restore={restore}
      />

      {lightbox && media.length > 0 && <Lightbox items={media} index={Math.min(lightboxIndex, media.length - 1)} onIndex={setLightboxIndex} onClose={() => setLightbox(false)} />}
    </div>
  );
}
