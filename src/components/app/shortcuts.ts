import type { Role } from "@/generated/prisma/client";
import { hasRole } from "./nav";

export type KeyInfo = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  /** True when focus is in a text field, select, or editable region. */
  typing: boolean;
};

export type ShortcutState = { pendingG: boolean; at: number };
export type ShortcutAction = { type: "palette" } | { type: "help" } | { type: "go"; href: string };
export type ShortcutResult = { state: ShortcutState; action: ShortcutAction | null; preventDefault: boolean };

export const IDLE: ShortcutState = { pendingG: false, at: 0 };
export const CHORD_WINDOW_MS = 1500;

export type GoShortcut = { key: string; href: string; label: string; minRole: Role };

export const GO_SHORTCUTS: GoShortcut[] = [
  { key: "i", href: "/app/inbox", label: "Go to inbox", minRole: "agent" },
  { key: "c", href: "/app/contacts", label: "Go to contacts", minRole: "agent" },
  { key: "b", href: "/app/broadcasts", label: "Go to broadcasts", minRole: "admin" },
  { key: "a", href: "/app/automation", label: "Go to automation", minRole: "agent" },
  { key: "r", href: "/app/reports", label: "Go to reports", minRole: "agent" },
  { key: "t", href: "/app/templates", label: "Go to templates", minRole: "agent" },
  { key: "h", href: "/app", label: "Go to home", minRole: "agent" },
];

export const goShortcutsFor = (role: Role) => GO_SHORTCUTS.filter((s) => hasRole(role, s.minRole));

export const goShortcutForHref = (href: string) => GO_SHORTCUTS.find((s) => s.href === href);

const TYPING_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

export function isTypingTarget(target: { tagName?: string; isContentEditable?: boolean; getAttribute?: (n: string) => string | null } | null): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  if (target.tagName && TYPING_TAGS.has(target.tagName.toUpperCase())) return true;
  const role = target.getAttribute?.("role");
  return role === "textbox" || role === "combobox" || role === "searchbox";
}

export const isPaletteHotkey = (e: Pick<KeyInfo, "key" | "ctrlKey" | "metaKey" | "altKey">) =>
  (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "k";

/**
 * Pure state machine for app-wide keys. Ctrl/Cmd+K always opens the palette. "?" opens help and "g" then a letter navigates,
 * but only when the user is not typing and no dialog is open. Unknown keys cancel a pending "g".
 */
export function resolveShortcut(state: ShortcutState, e: KeyInfo, role: Role, now: number, blocked = false): ShortcutResult {
  const idle = { state: IDLE, action: null, preventDefault: false };
  if (isPaletteHotkey(e)) return { state: IDLE, action: { type: "palette" }, preventDefault: true };
  if (blocked || e.typing || e.ctrlKey || e.metaKey || e.altKey) return idle;
  if (e.key === "Shift") return { state, action: null, preventDefault: false };

  if (e.key === "?") return { state: IDLE, action: { type: "help" }, preventDefault: true };

  const pending = state.pendingG && now - state.at <= CHORD_WINDOW_MS;
  const key = e.key.toLowerCase();
  if (pending) {
    const target = e.shiftKey ? undefined : goShortcutsFor(role).find((s) => s.key === key);
    if (target) return { state: IDLE, action: { type: "go", href: target.href }, preventDefault: true };
    return idle;
  }
  if (key === "g" && !e.shiftKey) return { state: { pendingG: true, at: now }, action: null, preventDefault: false };
  return idle;
}
