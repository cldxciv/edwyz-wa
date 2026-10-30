import { describe, expect, it } from "vitest";
import { BULK_LIMIT, filterToQuery, reconnectDelayMs, selectAllVisible, shortcutFor, statusDisplay, stepIndex, titleWithUnread, toggleId, updateMatches } from "@/components/inbox/helpers";

describe("filters", () => {
  it("maps every tab to a query", () => {
    expect(filterToQuery("solved")).toEqual({ status: "solved" });
    expect(filterToQuery("expired")).toEqual({ expired: "1" });
    expect(filterToQuery("unread")).toEqual({ unread: "1" });
    expect(filterToQuery("mine")).toEqual({ assigned: "me" });
  });
});

describe("title and reconnect", () => {
  it("shows the unread count in the title", () => {
    expect(titleWithUnread("Inbox", 0)).toBe("Inbox");
    expect(titleWithUnread("Inbox", 3)).toBe("(3) Inbox");
    expect(titleWithUnread("Inbox", 250)).toBe("(99+) Inbox");
  });
  it("backs off exponentially up to a minute", () => {
    expect([0, 1, 2, 3].map(reconnectDelayMs)).toEqual([2000, 4000, 8000, 16000]);
    expect(reconnectDelayMs(20)).toBe(60_000);
  });
  it("treats an empty update as a resync", () => {
    expect(updateMatches([], "a")).toBe(true);
    expect(updateMatches(["b"], "a")).toBe(false);
    expect(updateMatches(["a"], "a")).toBe(true);
    expect(updateMatches(["b"])).toBe(true);
  });
});

describe("selection and shortcuts", () => {
  it("toggles and caps selection", () => {
    expect(toggleId(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleId(["a", "b"], "a")).toEqual(["b"]);
    expect(selectAllVisible(Array.from({ length: 150 }, (_, i) => String(i)))).toHaveLength(BULK_LIMIT);
  });
  it("ignores shortcuts while typing or with modifiers", () => {
    expect(shortcutFor({ key: "e" })).toBe("solve");
    expect(shortcutFor({ key: "e", targetTag: "TEXTAREA" })).toBeNull();
    expect(shortcutFor({ key: "e", ctrlKey: true })).toBeNull();
    expect(shortcutFor({ key: "Escape", targetTag: "INPUT" })).toBe("escape");
    expect(shortcutFor({ key: "?" })).toBe("help");
  });
  it("steps within bounds", () => {
    expect(stepIndex(-1, 1, 3)).toBe(0);
    expect(stepIndex(2, 1, 3)).toBe(2);
    expect(stepIndex(0, -1, 3)).toBe(0);
    expect(stepIndex(0, 1, 0)).toBe(-1);
  });
  it("labels legacy resolved as Solved", () => {
    expect(statusDisplay("resolved")).toBe("Solved");
  });
});
