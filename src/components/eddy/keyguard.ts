/**
 * Eddy's keyboard leak guard (docs/EDDY-SPEC.md 6.2, EDDY-13 acceptance 5).
 *
 * A native `keydown` listener on `[data-eddy-root]` stops the propagation of every key except Ctrl/Cmd+K, so the inbox
 * list's single-key shortcuts (j k e a p o x / f), the shell's `?` and its g-chords never fire while focus is inside Eddy.
 * Ctrl/Cmd+K still reaches the shell, because the command palette is the keyboard path to everything (6.1).
 *
 * What this means for code inside Eddy: React 19 delegates events at the root container, which is `document` under the App
 * Router, so a bubbling React `onKeyDown` inside `[data-eddy-root]` never runs once the guard has stopped the event. Key
 * handling inside the panel therefore uses the capture phase (`onKeyDownCapture`), which React dispatches before the event
 * reaches the target. Browser default actions (typing, Enter on a button, Tab) are not affected: the guard never calls
 * preventDefault. The Dialog's own Escape and Tab handling listens on `document` in the capture phase, so it keeps working.
 */
import { useEffect, type RefObject } from "react";

/** The attribute that marks Eddy's surfaces (the desktop aside and the phone sheet's content). */
export const EDDY_ROOT_ATTR = "data-eddy-root";
export const EDDY_ROOT_SELECTOR = "[data-eddy-root]";

type KeyLike = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey">;

/** Ctrl+K or Cmd+K (no Alt): the one key the guard lets through, so the palette opens from inside Eddy. */
export function isPaletteKey(e: KeyLike): boolean {
  return (e.ctrlKey || e.metaKey) && !e.altKey && typeof e.key === "string" && e.key.toLowerCase() === "k";
}

/** The guard itself: stops propagation of every keydown except Ctrl/Cmd+K. Never prevents the default action. */
export function keyguardListener(e: KeyLike & Pick<Event, "stopPropagation">): void {
  if (!isPaletteKey(e)) e.stopPropagation();
}

type Listenable = Pick<EventTarget, "addEventListener" | "removeEventListener">;

/** Attaches the guard to an element in the bubble phase; returns the detach function. */
export function attachKeyguard(el: Listenable | null | undefined): () => void {
  if (!el) return () => undefined;
  const listener = keyguardListener as unknown as EventListener;
  el.addEventListener("keydown", listener);
  return () => el.removeEventListener("keydown", listener);
}

/** React hook: guards the referenced element while `active`. */
export function useKeyguard(ref: RefObject<HTMLElement | null>, active = true): void {
  useEffect(() => {
    if (!active) return;
    return attachKeyguard(ref.current);
  }, [ref, active]);
}

type NodeLike = { closest?: (selector: string) => unknown } | null | undefined;

/** True when an event target sits inside an Eddy surface (the second layer other key handlers can use, 6.2). */
export function isInsideEddy(target: EventTarget | NodeLike | null | undefined): boolean {
  const node = target as NodeLike;
  return !!node && typeof node.closest === "function" && node.closest(EDDY_ROOT_SELECTOR) !== null;
}
