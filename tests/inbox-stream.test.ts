import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} }));

import {
  acquireConnection,
  advanceCursor,
  connectionCount,
  createInboxStream,
  formatUpdate,
  MAX_CONNECTIONS_PER_TENANT,
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
