import { describe, expect, it } from "vitest";
import { applyLatestPage, applyOlderPage, EMPTY_HISTORY, restoredScrollTop, type History } from "@/components/inbox/history";
import type { InboxMessage } from "@/components/inbox/helpers";

const msg = (n: number): InboxMessage => ({
  id: `m${n}`,
  direction: n % 2 ? "inbound" : "outbound",
  type: "text",
  body: `message ${n}`,
  mediaUrl: null,
  mediaMime: null,
  templateName: null,
  status: "delivered",
  errorCode: null,
  createdAt: new Date(Date.UTC(2026, 9, 27, 10, 0, n)).toISOString(),
});
const range = (from: number, to: number) => Array.from({ length: from - to + 1 }, (_, i) => msg(from - i));
const ids = (list: InboxMessage[]) => list.map((m) => m.id);

describe("chat history paging", () => {
  it("follows the first page's cursor until the reader pages back", () => {
    const first = applyLatestPage(EMPTY_HISTORY, { messages: range(136, 87), nextCursor: "c_86" });
    expect(first.cursor).toBe("c_86");
    expect(first.usedOlder).toBe(false);
    const refreshed = applyLatestPage(first, { messages: range(137, 88), nextCursor: "c_87" });
    expect(refreshed.cursor).toBe("c_87");
  });

  it("keeps the cursor pointing past the loaded pages when a refresh lands after 'Load older messages'", () => {
    // Open the chat, load one older page, then a background refresh (read mark, stream update or safety poll) arrives.
    let h: History = applyLatestPage(EMPTY_HISTORY, { messages: range(136, 87), nextCursor: "c_86" });
    h = applyOlderPage(h, { messages: range(86, 37), nextCursor: "c_36" });
    expect(h.cursor).toBe("c_36");
    h = applyLatestPage(h, { messages: range(136, 87), nextCursor: "c_86" });
    // The bug: the refresh put c_86 back, so the next click fetched the page that was already on screen.
    expect(h.cursor).toBe("c_36");
    expect(h.usedOlder).toBe(true);
    expect(h.older).toHaveLength(50);
    expect(h.latest).toHaveLength(50);
  });

  it("merges an older page without duplicates and advances the cursor from the response", () => {
    let h: History = applyLatestPage(EMPTY_HISTORY, { messages: range(136, 87), nextCursor: "c_86" });
    h = applyOlderPage(h, { messages: range(86, 37), nextCursor: "c_36" });
    h = applyOlderPage(h, { messages: range(36, 1), nextCursor: null });
    expect(h.older).toHaveLength(86);
    expect(h.cursor).toBeNull();
    // Fetching the same page twice adds nothing.
    const again = applyOlderPage(h, { messages: range(86, 37), nextCursor: "c_36" });
    expect(again.older).toHaveLength(86);
    expect(new Set(ids(again.older))).toEqual(new Set(ids(h.older)));
  });

  it("keeps the reader's place after older messages are added above, and does not move when nothing was added", () => {
    // 50 older messages added 3,800 px above: the viewport stays on the same message.
    expect(restoredScrollTop(0, 3435, 7235)).toBe(3800);
    expect(restoredScrollTop(120, 3435, 7235)).toBe(3920);
    // The page was already loaded, the height did not change: the old code computed scrollHeight - before = 0 and jumped to the top.
    expect(restoredScrollTop(3435, 7238, 7238)).toBe(3435);
    // A shrinking scroller (a message removed) never throws the reader upwards either.
    expect(restoredScrollTop(500, 7238, 7000)).toBe(500);
  });
});
