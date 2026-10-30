import { describe, expect, it } from "vitest";
import { clampPercent, meterTone, nextTabIndex, trapTarget } from "@/components/ui/a11y";
import { STATUS_TONE, isKnownStatus, normalizeStatus, statusLabel, statusTone } from "@/components/ui/status";
import { ariaSort, compareValues, nextSort, sortRows } from "@/components/ui/table-sort";
import { DEFAULT_DURATION, MAX_TOASTS, initialToastState, isAssertive, toastReducer, type ToastInput, type ToastState } from "@/components/ui/toast-state";

describe("status map", () => {
  it("covers every status named in the product", () => {
    const wanted = ["open", "pending", "solved", "expired", "blocked", "draft", "scheduled", "sending", "completed", "failed", "active", "paused", "proposed", "applied"];
    for (const s of wanted) expect(isKnownStatus(s), s).toBe(true);
  });

  it("assigns consistent tones", () => {
    expect(statusTone("completed")).toBe("good");
    expect(statusTone("applied")).toBe("good");
    expect(statusTone("solved")).toBe("good");
    expect(statusTone("failed")).toBe("bad");
    expect(statusTone("expired")).toBe("bad");
    expect(statusTone("blocked")).toBe("bad");
    expect(statusTone("pending")).toBe("warn");
    expect(statusTone("paused")).toBe("warn");
    expect(statusTone("proposed")).toBe("warn");
    expect(statusTone("open")).toBe("info");
    expect(statusTone("sending")).toBe("info");
    expect(statusTone("scheduled")).toBe("info");
    expect(statusTone("draft")).toBe("neutral");
  });

  it("normalises case, spaces, hyphens and the British spelling", () => {
    expect(normalizeStatus("  In-Progress ")).toBe("in_progress");
    expect(statusTone("In Progress")).toBe("info");
    expect(statusTone("Cancelled")).toBe("neutral");
    expect(statusTone("CANCELED")).toBe("neutral");
  });

  it("falls back to neutral for unknown and empty values", () => {
    expect(statusTone("totally_new")).toBe("neutral");
    expect(statusTone(null)).toBe("neutral");
    expect(statusTone(undefined)).toBe("neutral");
    expect(isKnownStatus("totally_new")).toBe(false);
  });

  it("produces sentence-case labels", () => {
    expect(statusLabel("in_progress")).toBe("In progress");
    expect(statusLabel("PAST_DUE")).toBe("Past due");
    expect(statusLabel("")).toBe("Unknown");
    expect(statusLabel(null)).toBe("Unknown");
  });

  it("only maps keys that are already normalised", () => {
    for (const key of Object.keys(STATUS_TONE)) expect(normalizeStatus(key), key).toBe(key);
  });
});

describe("toast reducer", () => {
  const add = (state: ToastState, id: string, input: ToastInput, now = 0) =>
    toastReducer(state, { type: "add", id, input, now });

  it("adds a toast with the tone default duration", () => {
    const s = add(initialToastState, "a", { title: "Saved", tone: "success" }, 100);
    expect(s.toasts).toHaveLength(1);
    expect(s.toasts[0]).toMatchObject({ id: "a", tone: "success", duration: DEFAULT_DURATION.success, remaining: DEFAULT_DURATION.success, paused: false });
    expect(s.lastTick).toBe(100);
  });

  it("keeps toasts with an action until dismissed, and loading toasts until updated", () => {
    const withAction = add(initialToastState, "a", { title: "Deleted", action: { label: "Undo", onAction: () => {} } });
    expect(withAction.toasts[0].duration).toBe(0);
    const loading = add(initialToastState, "b", { title: "Sending", loading: true });
    expect(loading.toasts[0].duration).toBe(0);
    expect(loading.toasts[0].loading).toBe(true);
  });

  it("caps the visible stack and drops the oldest", () => {
    let s = initialToastState;
    for (let i = 0; i < MAX_TOASTS + 2; i++) s = add(s, `t${i}`, { title: `n${i}` });
    expect(s.toasts).toHaveLength(MAX_TOASTS);
    expect(s.toasts[0].id).toBe("t2");
  });

  it("replaces a toast that shares a key instead of stacking", () => {
    let s = add(initialToastState, "a", { title: "Offline", key: "net", tone: "warning" });
    s = toastReducer(s, { type: "tick", now: 3000 });
    s = add(s, "b", { title: "Offline again", key: "net", tone: "warning" }, 3000);
    expect(s.toasts).toHaveLength(1);
    expect(s.toasts[0]).toMatchObject({ id: "a", title: "Offline again", remaining: DEFAULT_DURATION.warning });
  });

  it("counts down on tick and removes expired toasts", () => {
    let s = add(initialToastState, "a", { title: "Hi", duration: 1000 }, 0);
    s = toastReducer(s, { type: "tick", now: 400 });
    expect(s.toasts[0].remaining).toBe(600);
    s = toastReducer(s, { type: "tick", now: 1000 });
    expect(s.toasts).toHaveLength(0);
    expect(s.lastTick).toBeNull();
  });

  it("does not count down while paused, and resumes where it left off", () => {
    let s = add(initialToastState, "a", { title: "Hi", duration: 1000 }, 0);
    s = toastReducer(s, { type: "tick", now: 200 });
    s = toastReducer(s, { type: "pause", id: "a" });
    s = toastReducer(s, { type: "tick", now: 5000 });
    expect(s.toasts[0].remaining).toBe(800);
    s = toastReducer(s, { type: "resume", id: "a" });
    s = toastReducer(s, { type: "tick", now: 5300 });
    expect(s.toasts[0].remaining).toBe(500);
  });

  it("never expires sticky toasts", () => {
    let s = add(initialToastState, "a", { title: "Sticky", duration: 0 }, 0);
    s = toastReducer(s, { type: "tick", now: 10 ** 7 });
    expect(s.toasts).toHaveLength(1);
  });

  it("updates a loading toast into a result and restarts its timer", () => {
    let s = add(initialToastState, "a", { title: "Sending", loading: true }, 0);
    s = toastReducer(s, { type: "update", id: "a", patch: { title: "Sent", tone: "success", loading: false }, now: 50 });
    expect(s.toasts[0]).toMatchObject({ title: "Sent", tone: "success", loading: false, duration: DEFAULT_DURATION.success, remaining: DEFAULT_DURATION.success });
  });

  it("dismisses one toast, then clears", () => {
    let s = add(initialToastState, "a", { title: "A" });
    s = add(s, "b", { title: "B" });
    s = toastReducer(s, { type: "dismiss", id: "a" });
    expect(s.toasts.map((t) => t.id)).toEqual(["b"]);
    s = toastReducer(s, { type: "dismiss", id: "b" });
    expect(s).toEqual(initialToastState);
    expect(toastReducer(add(s, "c", { title: "C" }), { type: "clear" })).toEqual(initialToastState);
  });

  it("treats only errors as assertive", () => {
    expect(isAssertive({ tone: "error" })).toBe(true);
    expect(isAssertive({ tone: "warning" })).toBe(false);
    expect(isAssertive({ tone: "success" })).toBe(false);
  });
});

describe("table sorting", () => {
  type Row = { name: string | null; n: number | null; at?: Date | null; ok?: boolean };
  const rows: Row[] = [
    { name: "item 10", n: 3 },
    { name: "Item 2", n: null },
    { name: null, n: 1 },
    { name: "item 1", n: 2 },
  ];

  it("cycles ascending, descending, none, and resets on a new column", () => {
    let s = nextSort(null, "name");
    expect(s).toEqual({ key: "name", dir: "asc" });
    s = nextSort(s, "name");
    expect(s).toEqual({ key: "name", dir: "desc" });
    expect(nextSort(s, "name")).toBeNull();
    expect(nextSort({ key: "name", dir: "desc" }, "n")).toEqual({ key: "n", dir: "asc" });
  });

  it("reports aria-sort", () => {
    expect(ariaSort({ key: "a", dir: "asc" }, "a")).toBe("ascending");
    expect(ariaSort({ key: "a", dir: "desc" }, "a")).toBe("descending");
    expect(ariaSort({ key: "a", dir: "asc" }, "b")).toBe("none");
    expect(ariaSort(null, "a")).toBe("none");
  });

  it("sorts text naturally and case-insensitively, with empty values last in both directions", () => {
    expect(sortRows(rows, (r) => r.name, "asc").map((r) => r.name)).toEqual(["item 1", "Item 2", "item 10", null]);
    expect(sortRows(rows, (r) => r.name, "desc").map((r) => r.name)).toEqual(["item 10", "Item 2", "item 1", null]);
  });

  it("sorts numbers numerically and keeps null last", () => {
    expect(sortRows(rows, (r) => r.n, "asc").map((r) => r.n)).toEqual([1, 2, 3, null]);
    expect(sortRows(rows, (r) => r.n, "desc").map((r) => r.n)).toEqual([3, 2, 1, null]);
  });

  it("is stable for equal values and does not mutate the input", () => {
    const same = [{ k: 1, id: "a" }, { k: 1, id: "b" }, { k: 0, id: "c" }, { k: 1, id: "d" }];
    const copy = [...same];
    expect(sortRows(same, (r) => r.k, "asc").map((r) => r.id)).toEqual(["c", "a", "b", "d"]);
    expect(sortRows(same, (r) => r.k, "desc").map((r) => r.id)).toEqual(["a", "b", "d", "c"]);
    expect(same).toEqual(copy);
  });

  it("handles dates, invalid dates and booleans", () => {
    const d = [{ at: new Date("2026-03-01") }, { at: new Date("nope") }, { at: new Date("2026-01-01") }];
    expect(sortRows(d, (r) => r.at, "asc").map((r) => r.at.getTime())).toEqual([new Date("2026-01-01").getTime(), new Date("2026-03-01").getTime(), NaN]);
    expect(compareValues(false, true)).toBeLessThan(0);
    expect(compareValues(new Date("2026-02-01"), new Date("2026-01-01"))).toBeGreaterThan(0);
  });
});

describe("keyboard helpers", () => {
  it("moves between tabs, wrapping and skipping disabled ones", () => {
    expect(nextTabIndex(3, 0, "ArrowRight")).toBe(1);
    expect(nextTabIndex(3, 2, "ArrowRight")).toBe(0);
    expect(nextTabIndex(3, 0, "ArrowLeft")).toBe(2);
    expect(nextTabIndex(4, 0, "ArrowRight", [false, true, true, false])).toBe(3);
    expect(nextTabIndex(4, 3, "Home", [true, false, false, false])).toBe(1);
    expect(nextTabIndex(4, 0, "End", [false, false, false, true])).toBe(2);
  });

  it("ignores unrelated keys and fully disabled lists", () => {
    expect(nextTabIndex(3, 0, "a")).toBeNull();
    expect(nextTabIndex(3, 0, "ArrowDown")).toBeNull();
    expect(nextTabIndex(2, 0, "ArrowRight", [true, true])).toBeNull();
    expect(nextTabIndex(0, 0, "ArrowRight")).toBeNull();
  });

  it("supports vertical tab lists", () => {
    expect(nextTabIndex(3, 0, "ArrowDown", [], true)).toBe(1);
    expect(nextTabIndex(3, 0, "ArrowRight", [], true)).toBeNull();
  });

  it("wraps focus inside a trapped dialog", () => {
    expect(trapTarget(3, 2, false)).toBe(0);
    expect(trapTarget(3, 0, true)).toBe(2);
    expect(trapTarget(3, -1, true)).toBe(2);
    expect(trapTarget(3, 1, false)).toBeNull();
    expect(trapTarget(3, 1, true)).toBeNull();
    expect(trapTarget(0, -1, false)).toBe(-1);
  });
});

describe("progress helpers", () => {
  it("clamps percentages and survives bad input", () => {
    expect(clampPercent(50)).toBe(50);
    expect(clampPercent(5, 20)).toBe(25);
    expect(clampPercent(-4)).toBe(0);
    expect(clampPercent(250)).toBe(100);
    expect(clampPercent(Number.NaN)).toBe(0);
    expect(clampPercent(1, 0)).toBe(0);
  });

  it("turns amber then red as capacity fills", () => {
    expect(meterTone(10)).toBe("good");
    expect(meterTone(70)).toBe("warn");
    expect(meterTone(89.9)).toBe("warn");
    expect(meterTone(90)).toBe("bad");
    expect(meterTone(60, 50, 80)).toBe("warn");
  });
});
