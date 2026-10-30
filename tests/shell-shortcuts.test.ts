import { describe, expect, it } from "vitest";
import { resolveTheme } from "@/components/app/theme-core";
import { CHORD_WINDOW_MS, IDLE, goShortcutsFor, isPaletteHotkey, isTypingTarget, resolveShortcut, type KeyInfo } from "@/components/app/shortcuts";

const key = (k: string, extra: Partial<KeyInfo> = {}): KeyInfo => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, typing: false, ...extra });

describe("palette hotkey", () => {
  it("accepts Ctrl+K and Cmd+K in any case", () => {
    expect(isPaletteHotkey(key("k", { ctrlKey: true }))).toBe(true);
    expect(isPaletteHotkey(key("K", { metaKey: true }))).toBe(true);
    expect(isPaletteHotkey(key("k"))).toBe(false);
    expect(isPaletteHotkey(key("k", { ctrlKey: true, altKey: true }))).toBe(false);
  });

  it("opens even while typing and prevents the browser default", () => {
    const r = resolveShortcut(IDLE, key("k", { ctrlKey: true, typing: true }), "agent", 0);
    expect(r.action).toEqual({ type: "palette" });
    expect(r.preventDefault).toBe(true);
  });
});

describe("single and chord shortcuts", () => {
  it("opens help on ? but not while typing or with a dialog open", () => {
    expect(resolveShortcut(IDLE, key("?", { shiftKey: true }), "agent", 0).action).toEqual({ type: "help" });
    expect(resolveShortcut(IDLE, key("?", { typing: true }), "agent", 0).action).toBeNull();
    expect(resolveShortcut(IDLE, key("?"), "agent", 0, true).action).toBeNull();
  });

  it("navigates on g then a key", () => {
    const first = resolveShortcut(IDLE, key("g"), "owner", 1000);
    expect(first.action).toBeNull();
    expect(first.state.pendingG).toBe(true);
    const second = resolveShortcut(first.state, key("i"), "owner", 1200);
    expect(second.action).toEqual({ type: "go", href: "/app/inbox" });
    expect(second.state).toEqual(IDLE);
  });

  it("maps the documented keys", () => {
    const go = (k: string) => {
      const s = resolveShortcut(IDLE, key("g"), "owner", 0).state;
      return resolveShortcut(s, key(k), "owner", 10).action;
    };
    expect(go("c")).toEqual({ type: "go", href: "/app/contacts" });
    expect(go("b")).toEqual({ type: "go", href: "/app/broadcasts" });
    expect(go("a")).toEqual({ type: "go", href: "/app/automation" });
    expect(go("r")).toEqual({ type: "go", href: "/app/reports" });
  });

  it("ignores the chord after the window expires or on an unknown key", () => {
    const s = resolveShortcut(IDLE, key("g"), "owner", 0).state;
    expect(resolveShortcut(s, key("i"), "owner", CHORD_WINDOW_MS + 1).action).toBeNull();
    const unknown = resolveShortcut(s, key("z"), "owner", 10);
    expect(unknown.action).toBeNull();
    expect(unknown.state).toEqual(IDLE);
  });

  it("does not start a chord while typing or with modifiers", () => {
    expect(resolveShortcut(IDLE, key("g", { typing: true }), "owner", 0).state.pendingG).toBe(false);
    expect(resolveShortcut(IDLE, key("g", { ctrlKey: true }), "owner", 0).state.pendingG).toBe(false);
  });

  it("respects roles: agents cannot jump to broadcasts", () => {
    const s = resolveShortcut(IDLE, key("g"), "agent", 0).state;
    expect(resolveShortcut(s, key("b"), "agent", 10).action).toBeNull();
    expect(goShortcutsFor("agent").map((g) => g.key)).not.toContain("b");
    expect(goShortcutsFor("admin").map((g) => g.key)).toContain("b");
  });

  it("keeps a pending g when only Shift is pressed", () => {
    const s = resolveShortcut(IDLE, key("g"), "owner", 0).state;
    expect(resolveShortcut(s, key("Shift", { shiftKey: true }), "owner", 5).state.pendingG).toBe(true);
  });
});

describe("typing targets", () => {
  it("recognises text fields and editable regions", () => {
    expect(isTypingTarget({ tagName: "INPUT" })).toBe(true);
    expect(isTypingTarget({ tagName: "textarea" })).toBe(true);
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(isTypingTarget({ tagName: "DIV", getAttribute: (n) => (n === "role" ? "textbox" : null) })).toBe(true);
    expect(isTypingTarget({ tagName: "BUTTON" })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe("theme resolution", () => {
  it("prefers a stored choice, otherwise follows the system", () => {
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme(null, true)).toBe("dark");
    expect(resolveTheme("weird", false)).toBe("light");
  });
});
