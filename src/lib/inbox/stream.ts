import { prisma } from "@/lib/db";
import { HttpError } from "@/lib/tenancy";

export const POLL_MS = 2000;
export const KEEPALIVE_MS = 25_000;
export const MAX_LIFETIME_MS = 5 * 60_000;
export const MAX_CONNECTIONS_PER_TENANT = 20;
const BATCH = 200;
const MAX_CONSECUTIVE_FAILURES = 5;
/**
 * Messages and conversations are stamped with WhatsApp's event time, which trails the moment we store them by the delivery
 * latency. Looking back this far catches those late-stamped writes; seen changes are remembered so they are announced once.
 */
export const LOOKBACK_MS = 2 * 60_000;

const connections = new Map<string, number>();

export function acquireConnection(tenantId: string): () => void {
  const current = connections.get(tenantId) ?? 0;
  if (current >= MAX_CONNECTIONS_PER_TENANT) throw new HttpError(429, "Too many live connections for this workspace.");
  connections.set(tenantId, current + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (connections.get(tenantId) ?? 1) - 1;
    if (left <= 0) connections.delete(tenantId);
    else connections.set(tenantId, left);
  };
}

export const connectionCount = (tenantId: string) => connections.get(tenantId) ?? 0;

/** key identifies one write so a change seen again inside the look-back window is not announced twice. */
export type Change = { conversationId: string; at: Date; key?: string };

export const changeKey = (c: Change) => c.key ?? `${c.conversationId}:${c.at.getTime()}`;

/** The newest timestamp among changes, or the previous cursor when nothing changed. */
export function advanceCursor(cursor: Date, changes: Change[]): Date {
  let max = cursor.getTime();
  for (const c of changes) max = Math.max(max, c.at.getTime());
  return new Date(max);
}

export function uniqueIds(changes: Change[]): string[] {
  return [...new Set(changes.map((c) => c.conversationId))];
}

export function formatUpdate(conversationIds: string[]): string {
  return `event: update\ndata: ${JSON.stringify({ conversationIds })}\n\n`;
}

/**
 * Delivery ticks and send failures change a message's status, not a timestamp, so they are watched on their own: the outbound
 * messages of the last STATUS_WATCH_MS in the chats where someone is talking (the customer wrote or a teammate replied in that
 * time), with their current status. A status that differs from the previous poll is announced, so an open chat shows sent,
 * delivered, read or failed at once. Broadcast sends are left out: a broadcast writes thousands of outbound rows in minutes and
 * would push an agent's reply out of the watch. Anything not watched (a broadcast, an older message, a chat with only automatic
 * messages) reaches the chat with the client's slow safety poll.
 */
export const STATUS_WATCH_MS = 30 * 60_000;

export type MessageStatusMark = { id: string; conversationId: string; status: string };
export type PollResult = { changes: Change[]; statuses?: MessageStatusMark[] };
export type Poller = (tenantId: string, cursor: Date) => Promise<PollResult>;

/** Conversations with a watched message that is new or has a different status than at the previous poll. The first poll only records. */
export function statusChanges(previous: ReadonlyMap<string, string> | null, current: MessageStatusMark[]): string[] {
  if (!previous) return [];
  const ids = new Set<string>();
  for (const m of current) if (previous.get(m.id) !== m.status) ids.add(m.conversationId);
  return [...ids];
}

/**
 * The watched statuses (see STATUS_WATCH_MS). The chats come first, through the conversation's (tenantId, lastMessageAt) index
 * (every send moves lastMessageAt); their messages are then read through the message's (tenantId, conversationId, createdAt)
 * index, so neither read scans the workspace's whole message history.
 */
async function watchedStatuses(tenantId: string, now: number): Promise<MessageStatusMark[]> {
  const since = new Date(now - STATUS_WATCH_MS);
  const chats = await prisma.conversation.findMany({
    where: { tenantId, lastMessageAt: { gt: since }, OR: [{ lastInboundAt: { gt: since } }, { lastAgentReplyAt: { gt: since } }] },
    select: { id: true },
    orderBy: { lastMessageAt: "desc" },
    take: BATCH,
  });
  if (chats.length === 0) return [];
  const rows = await prisma.message.findMany({
    // origin is null on rows older than the spend controls; a plain `not` would drop those too.
    where: { tenantId, conversationId: { in: chats.map((c) => c.id) }, direction: "outbound", createdAt: { gt: since }, OR: [{ origin: null }, { origin: { not: "broadcast" } }] },
    select: { id: true, conversationId: true, status: true },
    orderBy: { createdAt: "desc" },
    take: BATCH,
  });
  return rows.map((m) => ({ id: m.id, conversationId: m.conversationId, status: String(m.status) }));
}

/** Tenant-scoped change detection. Reads ids, timestamps and delivery statuses only, never message content. */
export const pollDatabase: Poller = async (tenantId, cursorAt) => {
  const cursor = new Date(cursorAt.getTime() - LOOKBACK_MS);
  const [conversations, messages, statuses] = await Promise.all([
    prisma.conversation.findMany({
      where: { tenantId, OR: [{ lastMessageAt: { gt: cursor } }, { statusChangedAt: { gt: cursor } }, { assignedAt: { gt: cursor } }] },
      select: { id: true, lastMessageAt: true, statusChangedAt: true, assignedAt: true },
      orderBy: { lastMessageAt: "desc" },
      take: BATCH,
    }),
    prisma.message.findMany({
      where: { tenantId, createdAt: { gt: cursor } },
      select: { id: true, conversationId: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: BATCH,
    }),
    watchedStatuses(tenantId, Date.now()),
  ]);
  const changes: Change[] = messages.map((m) => ({ conversationId: m.conversationId, at: m.createdAt, key: `m:${m.id}` }));
  for (const c of conversations) {
    for (const [field, at] of [["last", c.lastMessageAt], ["status", c.statusChangedAt], ["assign", c.assignedAt]] as const) {
      if (at && at > cursor) changes.push({ conversationId: c.id, at, key: `c:${c.id}:${field}:${at.getTime()}` });
    }
  }
  return { changes, statuses };
};

/** The unread badge. Blocked chats never count, as in the inbox lists. scope limits the count to the chats a restricted agent may see. */
export async function countUnreadConversations(tenantId: string, scope?: Record<string, unknown> | null): Promise<number> {
  return prisma.conversation.count({ where: { tenantId, unreadCount: { gt: 0 }, status: { not: "blocked" }, ...(scope ?? {}) } });
}

export type StreamOptions = {
  tenantId: string;
  signal: AbortSignal;
  release: () => void;
  poll?: Poller;
  /** Keeps only the conversation ids the listener may see. A restricted agent must not learn that hidden chats are active. */
  filter?: (conversationIds: string[]) => Promise<string[]>;
  now?: () => Date;
  pollMs?: number;
  keepaliveMs?: number;
  maxLifetimeMs?: number;
};

export function createInboxStream(opts: StreamOptions): ReadableStream<Uint8Array> {
  const { tenantId, signal, release } = opts;
  const poll = opts.poll ?? pollDatabase;
  const now = opts.now ?? (() => new Date());
  const enc = new TextEncoder();
  let cursor = now();
  const connectedAt = cursor;
  const seen = new Map<string, number>();
  let lastStatuses: Map<string, string> | null = null;
  let primed = false;
  let closed = false;
  let failures = 0;
  const timers: ReturnType<typeof setTimeout>[] = [];
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let keepTimer: ReturnType<typeof setInterval> | undefined;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;

  function close() {
    if (closed) return;
    closed = true;
    clearTimeout(pollTimer);
    clearInterval(keepTimer);
    timers.forEach(clearTimeout);
    signal.removeEventListener("abort", close);
    release();
    try {
      controllerRef?.close();
    } catch {
      // already closed by the consumer
    }
  }

  const send = (text: string) => {
    if (!closed) controllerRef?.enqueue(enc.encode(text));
  };

  async function tick() {
    if (closed) return;
    try {
      const { changes: polled, statuses } = await poll(tenantId, cursor);
      failures = 0;
      // The look-back returns writes already announced. The first poll also returns what happened just before connecting; the client loads that itself.
      const changes = polled.filter((c) => {
        const key = changeKey(c);
        if (seen.has(key)) return false;
        seen.set(key, c.at.getTime());
        return primed || c.at > connectedAt;
      });
      // Only the latest statuses are kept, so memory stays at one poll's worth however long the connection lives.
      const moved = statuses ? statusChanges(lastStatuses, statuses) : [];
      if (statuses) lastStatuses = new Map(statuses.map((m) => [m.id, m.status]));
      primed = true;
      for (const [key, at] of seen) if (at < cursor.getTime() - LOOKBACK_MS) seen.delete(key);
      if (changes.length > 0) cursor = advanceCursor(cursor, changes);
      const changed = [...new Set([...uniqueIds(changes), ...moved])];
      if (changed.length > 0) {
        const ids = opts.filter ? await opts.filter(changed) : changed;
        if (ids.length > 0) send(formatUpdate(ids));
      }
    } catch {
      failures += 1;
      if (failures >= MAX_CONSECUTIVE_FAILURES) return close();
    }
    if (!closed) pollTimer = setTimeout(tick, opts.pollMs ?? POLL_MS);
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      if (signal.aborted) return close();
      signal.addEventListener("abort", close);
      send("retry: 3000\n\n: connected\n\n");
      keepTimer = setInterval(() => send(": keepalive\n\n"), opts.keepaliveMs ?? KEEPALIVE_MS);
      timers.push(setTimeout(close, opts.maxLifetimeMs ?? MAX_LIFETIME_MS));
      pollTimer = setTimeout(tick, opts.pollMs ?? POLL_MS);
    },
    cancel() {
      close();
    },
  });
}
