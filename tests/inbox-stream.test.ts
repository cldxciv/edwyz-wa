import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ conversation: { findMany: vi.fn(), count: vi.fn() }, message: { findMany: vi.fn() } }));
vi.mock("@/lib/db", () => ({ prisma: db }));

import {
  acquireConnection,
  advanceCursor,
  connectionCount,
  countUnreadConversations,
  createInboxStream,
  formatUpdate,
  MAX_CONNECTIONS_PER_TENANT,
  pollDatabase,
  STATUS_WATCH_MS,
  statusChanges,
  uniqueIds,
} from "@/lib/inbox/stream";

const T0 = new Date("2026-10-27T12:00:00Z");

describe("stream helpers", () => {
  it("advances the cursor to the newest change and dedupes ids", () => {
    const changes = [
      { conversationId: "a", at: new Date(T0.getTime() + 1000) },
      { conversationId: "a", at: new Date(T0.getTime() + 3000) },
      { conversationId: "b", at: new Date(T0.getTime() + 2000) },
    ];
    expect(advanceCursor(T0, changes).getTime()).toBe(T0.getTime() + 3000);
    expect(advanceCursor(T0, []).getTime()).toBe(T0.getTime());
    expect(uniqueIds(changes)).toEqual(["a", "b"]);
  });
  it("finds chats whose message is new or changed status since the last poll, and records only on the first", () => {
    const now = [
      { id: "m1", conversationId: "a", status: "delivered" },
      { id: "m2", conversationId: "a", status: "failed" },
      { id: "m3", conversationId: "b", status: "sent" },
      { id: "m4", conversationId: "c", status: "queued" },
    ];
    expect(statusChanges(null, now)).toEqual([]);
    const before = new Map([
      ["m1", "sent"],
      ["m2", "queued"],
      ["m3", "sent"],
    ]);
    expect(statusChanges(before, now)).toEqual(["a", "c"]);
    expect(statusChanges(new Map(now.map((m) => [m.id, m.status])), now)).toEqual([]);
  });
  it("formats an id-only update event", () => {
    expect(formatUpdate(["a"])).toBe("event: update\ndata: {\"conversationIds\":[\"a\"]}\n\n");
  });
  it("caps connections per tenant and releases once", () => {
    const releases = Array.from({ length: MAX_CONNECTIONS_PER_TENANT }, () => acquireConnection("cap"));
    expect(() => acquireConnection("cap")).toThrow(expect.objectContaining({ status: 429 }));
    expect(() => acquireConnection("other")()).not.toThrow();
    releases[0]();
    releases[0]();
    expect(connectionCount("cap")).toBe(MAX_CONNECTIONS_PER_TENANT - 1);
    releases.slice(1).forEach((r) => r());
    expect(connectionCount("cap")).toBe(0);
  });
});

function collect(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const dec = new TextDecoder();
  const state = { text: "", done: false };
  const pump = (async () => {
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      state.text += dec.decode(r.value);
    }
    state.done = true;
  })();
  return { state, pump };
}

describe("createInboxStream", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("polls with a moving cursor, sends keepalives and closes at max lifetime", async () => {
    const poll = vi
      .fn()
      .mockResolvedValueOnce({ changes: [{ conversationId: "c1", at: new Date(T0.getTime() + 500) }] })
      .mockResolvedValue({ changes: [] });
    const release = vi.fn();
    const stream = createInboxStream({ tenantId: "t1", signal: new AbortController().signal, release, poll, now: () => T0, maxLifetimeMs: 60_000 });
    const { state, pump } = collect(stream.getReader());
    await vi.advanceTimersByTimeAsync(2100);
    await vi.advanceTimersByTimeAsync(2000);
    expect(poll).toHaveBeenNthCalledWith(1, "t1", T0);
    expect(poll.mock.calls[1][1].getTime()).toBe(T0.getTime() + 500);
    expect(state.text).toContain("event: update\ndata: {\"conversationIds\":[\"c1\"]}");
    expect(state.text).not.toContain("keepalive");
    await vi.advanceTimersByTimeAsync(22_000);
    expect(state.text).toContain(": keepalive");
    await vi.advanceTimersByTimeAsync(40_000);
    await pump;
    expect(state.done).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("cleans up on abort and stops polling", async () => {
    const poll = vi.fn().mockResolvedValue({ changes: [] });
    const release = vi.fn();
    const ctrl = new AbortController();
    const stream = createInboxStream({ tenantId: "t1", signal: ctrl.signal, release, poll, now: () => T0 });
    const { pump } = collect(stream.getReader());
    await vi.advanceTimersByTimeAsync(2100);
    ctrl.abort();
    await pump;
    const calls = poll.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(poll.mock.calls.length).toBe(calls);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("announces a late-stamped write once and ignores what happened before connecting", async () => {
    const before = { conversationId: "old", at: new Date(T0.getTime() - 60_000), key: "m:old" };
    const late = { conversationId: "c2", at: new Date(T0.getTime() - 20_000), key: "m:late" };
    const poll = vi
      .fn()
      .mockResolvedValueOnce({ changes: [before] })
      .mockResolvedValueOnce({ changes: [before, late] })
      .mockResolvedValue({ changes: [before, late] });
    const stream = createInboxStream({ tenantId: "t1", signal: new AbortController().signal, release: vi.fn(), poll, now: () => T0, maxLifetimeMs: 60_000 });
    const { state } = collect(stream.getReader());
    await vi.advanceTimersByTimeAsync(2100);
    expect(state.text).not.toContain("event: update");
    await vi.advanceTimersByTimeAsync(2000);
    expect(state.text).toContain("{\"conversationIds\":[\"c2\"]}");
    await vi.advanceTimersByTimeAsync(4000);
    expect(state.text.match(/event: update/g)).toHaveLength(1);
  });

  it("announces a delivery tick or a failed send at once, but not the statuses it found when connecting", async () => {
    const sent = { id: "m1", conversationId: "c1", status: "sent" };
    const poll = vi
      .fn()
      .mockResolvedValueOnce({ changes: [], statuses: [sent, { id: "m2", conversationId: "c2", status: "queued" }] })
      .mockResolvedValueOnce({ changes: [], statuses: [sent, { id: "m2", conversationId: "c2", status: "queued" }] })
      .mockResolvedValueOnce({ changes: [], statuses: [{ ...sent, status: "delivered" }, { id: "m2", conversationId: "c2", status: "failed" }] })
      .mockResolvedValue({ changes: [], statuses: [{ ...sent, status: "delivered" }, { id: "m2", conversationId: "c2", status: "failed" }] });
    const stream = createInboxStream({ tenantId: "t1", signal: new AbortController().signal, release: vi.fn(), poll, now: () => T0, maxLifetimeMs: 60_000 });
    const { state } = collect(stream.getReader());
    await vi.advanceTimersByTimeAsync(4100);
    expect(state.text).not.toContain("event: update");
    await vi.advanceTimersByTimeAsync(2000);
    expect(state.text).toContain("{\"conversationIds\":[\"c1\",\"c2\"]}");
    await vi.advanceTimersByTimeAsync(4000);
    expect(state.text.match(/event: update/g)).toHaveLength(1);
  });

  it("merges status and message changes into one event and lets the visibility filter drop hidden chats", async () => {
    const poll = vi
      .fn()
      .mockResolvedValueOnce({ changes: [], statuses: [{ id: "m1", conversationId: "hidden", status: "sent" }] })
      .mockResolvedValue({ changes: [{ conversationId: "c1", at: new Date(T0.getTime() + 500), key: "m:new" }], statuses: [{ id: "m1", conversationId: "hidden", status: "read" }] });
    const filter = vi.fn(async (ids: string[]) => ids.filter((id) => id !== "hidden"));
    const stream = createInboxStream({ tenantId: "t1", signal: new AbortController().signal, release: vi.fn(), poll, filter, now: () => T0, maxLifetimeMs: 60_000 });
    const { state } = collect(stream.getReader());
    await vi.advanceTimersByTimeAsync(4100);
    expect(filter).toHaveBeenCalledWith(["c1", "hidden"]);
    expect(state.text).toContain("{\"conversationIds\":[\"c1\"]}");
    expect(state.text).not.toContain("hidden");
  });

  it("closes after repeated poll failures without leaking details", async () => {
    const poll = vi.fn().mockRejectedValue(new Error("secret db detail"));
    const release = vi.fn();
    const stream = createInboxStream({ tenantId: "t1", signal: new AbortController().signal, release, poll, now: () => T0 });
    const { state, pump } = collect(stream.getReader());
    await vi.advanceTimersByTimeAsync(12_000);
    await pump;
    expect(state.done).toBe(true);
    expect(state.text).not.toContain("secret");
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe("database poller and unread badge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.conversation.findMany.mockResolvedValue([]);
    db.message.findMany.mockResolvedValue([]);
    db.conversation.count.mockResolvedValue(3);
  });

  /** The chat look-up of the status watch is the conversation read that selects ids only. */
  const isWatchedChats = (args: { select: Record<string, boolean> }) => Object.keys(args.select).join() === "id";
  const watchArgs = () => ({
    chats: db.conversation.findMany.mock.calls.map((c) => c[0]).find(isWatchedChats),
    messages: db.message.findMany.mock.calls.map((c) => c[0]).find((a) => a.where.direction === "outbound"),
  });

  it("watches the outbound messages of chats where someone is talking, reading ids and statuses only", async () => {
    db.conversation.findMany.mockImplementation(async (args: { select: Record<string, boolean> }) => (isWatchedChats(args) ? [{ id: "c1" }, { id: "c2" }] : []));
    db.message.findMany.mockImplementation(async (args: { where: { direction?: string } }) =>
      args.where.direction === "outbound" ? [{ id: "m1", conversationId: "c1", status: "failed" }] : [],
    );
    const before = Date.now();
    const result = await pollDatabase("t1", T0);
    expect(result.statuses).toEqual([{ id: "m1", conversationId: "c1", status: "failed" }]);
    const { chats, messages } = watchArgs();
    // Chats first, through the (tenantId, lastMessageAt) index: the customer wrote or a teammate replied in the watch window.
    const since = chats.where.lastMessageAt.gt;
    expect(since.getTime()).toBeGreaterThanOrEqual(before - STATUS_WATCH_MS);
    expect(since.getTime()).toBeLessThanOrEqual(Date.now() - STATUS_WATCH_MS);
    expect(chats).toEqual({
      where: { tenantId: "t1", lastMessageAt: { gt: since }, OR: [{ lastInboundAt: { gt: since } }, { lastAgentReplyAt: { gt: since } }] },
      select: { id: true },
      orderBy: { lastMessageAt: "desc" },
      take: 200,
    });
    // Then their messages, through the (tenantId, conversationId, createdAt) index.
    expect(messages).toEqual({
      where: { tenantId: "t1", conversationId: { in: ["c1", "c2"] }, direction: "outbound", createdAt: { gt: since }, OR: [{ origin: null }, { origin: { not: "broadcast" } }] },
      select: { id: true, conversationId: true, status: true },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
  });

  it("leaves broadcast sends out of the watch, but keeps sends with no origin", async () => {
    const rows = [
      { id: "b1", conversationId: "c1", status: "sent", origin: "broadcast" },
      { id: "m1", conversationId: "c1", status: "delivered", origin: "human" },
      { id: "m0", conversationId: "c1", status: "read", origin: null },
    ];
    type OriginClause = { origin: null | { not: string } };
    db.conversation.findMany.mockImplementation(async (args: { select: Record<string, boolean> }) => (isWatchedChats(args) ? [{ id: "c1" }] : []));
    // Applies the origin clause with SQL's rules: `origin <> 'broadcast'` is not true for a null origin.
    db.message.findMany.mockImplementation(async (args: { where: { direction?: string; OR?: OriginClause[] } }) =>
      args.where.direction === "outbound"
        ? rows
            .filter((r) => (args.where.OR ?? []).some((c) => (c.origin === null ? r.origin === null : r.origin !== null && r.origin !== c.origin.not)))
            .map(({ id, conversationId, status }) => ({ id, conversationId, status }))
        : [],
    );
    const result = await pollDatabase("t1", T0);
    expect(result.statuses?.map((s) => s.id)).toEqual(["m1", "m0"]);
  });

  it("skips the message read when no chat is active", async () => {
    const result = await pollDatabase("t1", T0);
    expect(result.statuses).toEqual([]);
    expect(watchArgs().chats).toBeDefined();
    expect(watchArgs().messages).toBeUndefined();
  });

  it("never counts blocked chats in the unread badge, and keeps the viewer's scope", async () => {
    expect(await countUnreadConversations("t1")).toBe(3);
    expect(db.conversation.count).toHaveBeenLastCalledWith({ where: { tenantId: "t1", unreadCount: { gt: 0 }, status: { not: "blocked" } } });
    await countUnreadConversations("t1", { OR: [{ assignedToId: "u1" }] });
    expect(db.conversation.count).toHaveBeenLastCalledWith({ where: { tenantId: "t1", unreadCount: { gt: 0 }, status: { not: "blocked" }, OR: [{ assignedToId: "u1" }] } });
  });
});
