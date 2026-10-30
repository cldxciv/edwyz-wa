import { describe, expect, it } from "vitest";
import {
  attachmentLabel,
  dayLabel,
  filterToQuery,
  formatWindowRemaining,
  groupMessagesByDay,
  mergeById,
  relativeTime,
  statusLabel,
  truncatePreview,
  WINDOW_MS,
  windowRemainingMs,
} from "@/components/inbox/helpers";

const NOW = new Date(2026, 9, 26, 12, 0, 0);

describe("window countdown", () => {
  it("computes remaining time and clamps at 0 and 24h", () => {
    expect(windowRemainingMs(null, NOW)).toBe(0);
    expect(windowRemainingMs(new Date(NOW.getTime() - WINDOW_MS), NOW)).toBe(0);
    expect(windowRemainingMs(new Date(NOW.getTime() - WINDOW_MS - 1000), NOW)).toBe(0);
    expect(windowRemainingMs(new Date(NOW.getTime() - 60_000), NOW)).toBe(WINDOW_MS - 60_000);
    expect(windowRemainingMs(new Date(NOW.getTime() + 60_000), NOW)).toBe(WINDOW_MS);
  });
  it("formats it", () => {
    expect(formatWindowRemaining(0)).toBe("Window closed");
    expect(formatWindowRemaining(5 * 3600_000 + 12 * 60_000)).toBe("5h 12m left");
    expect(formatWindowRemaining(90_000)).toBe("2m left");
    expect(formatWindowRemaining(3600_000)).toBe("1h 0m left");
  });
});

describe("groupMessagesByDay", () => {
  it("groups by local day, oldest first, regardless of input order", () => {
    const m = (id: string, d: Date) => ({ id, createdAt: d.toISOString() });
    const groups = groupMessagesByDay(
      [m("c", new Date(2026, 9, 26, 9)), m("a", new Date(2026, 9, 24, 23, 59)), m("b", new Date(2026, 9, 25, 0, 1)), m("d", new Date(2026, 9, 26, 10))],
      NOW,
    );
    expect(groups.map((g) => g.messages.map((x) => x.id))).toEqual([["a"], ["b"], ["c", "d"]]);
    expect(groups.map((g) => g.label.slice(0, 5))).toEqual([expect.any(String), "Yeste", "Today"]);
  });
  it("labels today and yesterday", () => {
    expect(dayLabel(NOW, NOW)).toBe("Today");
    expect(dayLabel(new Date(2026, 9, 25, 23), NOW)).toBe("Yesterday");
  });
  it("returns no groups for no messages", () => {
    expect(groupMessagesByDay([], NOW)).toEqual([]);
  });
});

describe("text helpers", () => {
  it("truncates previews and collapses whitespace", () => {
    expect(truncatePreview("short")).toBe("short");
    expect(truncatePreview("a\n\nb   c")).toBe("a b c");
    const out = truncatePreview("x".repeat(100), 10);
    expect(out).toHaveLength(10);
    expect(out.endsWith("…")).toBe(true);
    expect(truncatePreview(null)).toBe("");
  });
  it("formats relative time", () => {
    expect(relativeTime(new Date(NOW.getTime() - 5000), NOW)).toBe("now");
    expect(relativeTime(new Date(NOW.getTime() - 5 * 60_000), NOW)).toBe("5m");
    expect(relativeTime(new Date(NOW.getTime() - 3 * 3600_000), NOW)).toBe("3h");
    expect(relativeTime(new Date(NOW.getTime() - 2 * 86_400_000), NOW)).toBe("2d");
  });
  it("labels statuses and attachments", () => {
    expect(statusLabel("failed")).toBe("Failed");
    expect(statusLabel("read")).toBe("Read");
    expect(attachmentLabel({ type: "image", mediaMime: "image/png", templateName: null })).toBe("Media message (image, image/png)");
    expect(attachmentLabel({ type: "template", mediaMime: null, templateName: "promo" })).toBe("Template: promo");
    expect(attachmentLabel({ type: "text", mediaMime: null, templateName: null })).toBeNull();
  });
});

describe("list helpers", () => {
  it("maps filters to query params", () => {
    expect(filterToQuery("mine")).toEqual({ assigned: "me" });
    expect(filterToQuery("unassigned")).toEqual({ assigned: "unassigned" });
    expect(filterToQuery("pending")).toEqual({ status: "pending" });
    expect(filterToQuery("all")).toEqual({});
  });
  it("merges by id keeping the latest copy", () => {
    expect(mergeById([{ id: "1", v: 1 }], [{ id: "1", v: 2 }, { id: "2", v: 3 }])).toEqual([{ id: "1", v: 2 }, { id: "2", v: 3 }]);
  });
});
