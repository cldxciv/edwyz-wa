import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FALLBACK_POLL_MS, pollIntervalFor, SAFETY_POLL_MS, streamBadge } from "@/components/inbox/helpers";
import { fetchNotes, forgetNotes, NOTES_FRESH_MS } from "@/components/inbox/notes-cache";
import { useInboxStream } from "@/components/inbox/useInboxStream";
import { nextPollDelay } from "@/components/inbox/usePolling";
import { notifyUnreadRefresh, UNREAD_REFRESH_EVENT, unreadCountFrom } from "@/components/inbox/ux";

describe("the live-updates badge", () => {
  it("starts as a neutral 'Connecting…' and only turns amber after the stream really failed", () => {
    const Probe = () => createElement("span", null, useInboxStream().mode);
    expect(renderToStaticMarkup(createElement(Probe))).toBe("<span>connecting</span>");
    expect(streamBadge("connecting")).toMatchObject({ label: "Connecting…" });
    expect(streamBadge("connecting").dot).not.toContain("amber");
    expect(streamBadge("sse")).toMatchObject({ label: "Live", dot: "bg-emerald-500" });
    expect(streamBadge("polling")).toMatchObject({ label: "Polling", dot: "bg-amber-500" });
    expect(streamBadge("polling").title).toContain("unavailable");
  });

  it("polls fast until the stream is open and slowly while it is", () => {
    expect(pollIntervalFor("connecting")).toBe(FALLBACK_POLL_MS);
    expect(pollIntervalFor("polling")).toBe(FALLBACK_POLL_MS);
    expect(pollIntervalFor("sse")).toBe(SAFETY_POLL_MS);
  });
});

describe("usePolling rescheduling", () => {
  it("fetches at once on the first start", () => {
    expect(nextPollDelay(null, 2000, 10_000)).toBe(0);
  });
  it("does not fetch again when only the interval changed (the stream just opened)", () => {
    // Polled 1 s ago at the 2 s fallback cadence; the stream opens and the cadence becomes 30 s: wait the remaining 29 s.
    expect(nextPollDelay(9_000, 30_000, 10_000)).toBe(29_000);
  });
  it("catches up promptly when the stream drops", () => {
    // Last poll 10 s ago on the 30 s safety cadence; the stream fails and the cadence becomes 2 s: fetch now.
    expect(nextPollDelay(0, 2000, 10_000)).toBe(0);
    // Polled 500 ms ago: wait the rest of the 2 s, not 0 and not more than the interval.
    expect(nextPollDelay(9_500, 2000, 10_000)).toBe(1500);
    expect(nextPollDelay(20_000, 2000, 10_000)).toBe(2000);
  });
});

describe("shared notes requests", () => {
  beforeEach(() => forgetNotes());
  afterEach(() => forgetNotes());

  const note = (id: string) => ({ id, authorId: "u1", body: id, createdAt: "2026-10-27T10:00:00Z" });

  it("makes one request when the chat and the details panel both ask while opening a conversation", async () => {
    const fetcher = vi.fn(async () => ({ notes: [note("n1")] }));
    let clock = 1000;
    const now = () => clock;
    const [a, b] = await Promise.all([fetchNotes("c1", { fetcher, now }), fetchNotes("c1", { fetcher, now })]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
    // The panel mounts a moment later, once the conversation details arrived: still no second request.
    clock += 400;
    expect(await fetchNotes("c1", { fetcher, now })).toEqual([note("n1")]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    // A later poll asks the server again.
    clock += NOTES_FRESH_MS;
    await fetchNotes("c1", { fetcher, now });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("asks again after a note was written, and later readers get the new list", async () => {
    let notes = [note("n1")];
    const fetcher = vi.fn(async () => ({ notes }));
    const now = () => 5000;
    await fetchNotes("c1", { fetcher, now });
    notes = [note("n1"), note("n2")];
    expect(await fetchNotes("c1", { fetcher, now, fresh: true })).toHaveLength(2);
    expect(await fetchNotes("c1", { fetcher, now })).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keeps conversations apart and forgets a failed request", async () => {
    const ok = vi.fn(async () => ({ notes: [note("x")] }));
    const bad = vi.fn(async () => {
      throw new Error("nope");
    });
    await expect(fetchNotes("c2", { fetcher: bad })).rejects.toThrow("nope");
    expect(await fetchNotes("c2", { fetcher: ok })).toEqual([note("x")]);
    expect(await fetchNotes("c3", { fetcher: ok })).toEqual([note("x")]);
    expect(ok).toHaveBeenCalledTimes(2);
  });
});

describe("the sidebar unread badge", () => {
  const target = new EventTarget();
  beforeEach(() => vi.stubGlobal("window", target));
  afterEach(() => vi.unstubAllGlobals());

  it("is told the count by the inbox list instead of fetching it again", () => {
    const seen: (number | null)[] = [];
    const on = (e: Event) => seen.push(unreadCountFrom(e));
    target.addEventListener(UNREAD_REFRESH_EVENT, on);
    notifyUnreadRefresh(3);
    notifyUnreadRefresh(0);
    notifyUnreadRefresh();
    target.removeEventListener(UNREAD_REFRESH_EVENT, on);
    expect(seen).toEqual([3, 0, null]);
  });

  it("treats anything but a real count as 'fetch it'", () => {
    expect(unreadCountFrom(new Event(UNREAD_REFRESH_EVENT))).toBeNull();
    expect(unreadCountFrom(new CustomEvent(UNREAD_REFRESH_EVENT, { detail: { count: "7" } }))).toBeNull();
    expect(unreadCountFrom(new CustomEvent(UNREAD_REFRESH_EVENT, { detail: { count: -1 } }))).toBeNull();
    expect(unreadCountFrom(new CustomEvent(UNREAD_REFRESH_EVENT, { detail: { count: 12 } }))).toBe(12);
  });
});
