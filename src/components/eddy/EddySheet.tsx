"use client";

/**
 * Eddy on phones (below md): the design-system Dialog in its bottom-sheet form (items-end, rounded-t-card, max-h 92dvh),
 * which brings the focus trap, the dialog stack and the ref-counted scroll lock (docs/EDDY-SPEC.md 6.2, 6.13, 9.4).
 *
 * - Header: the avatar, "Eddy", the status pill, the menu and a 44 px Close button.
 * - Back closes the sheet: opening it pushes one history entry (`history.pushState({eddy: true})`, keeping the router's own
 *   state keys), and `popstate` closes it, so Android Back or the iOS swipe closes Eddy instead of leaving the page. The
 *   unsent draft lives in EddyRoot, so it is still there next time. Closing the sheet another way pops that entry first.
 * - The composer is pinned to the bottom with `env(safe-area-inset-bottom)` and kept above the on-screen keyboard with
 *   `visualViewport`. The input is 16 px and Send is 44 x 44 px.
 * - While the sheet is open, Eddy's own result rows stand in for toasts (EddyRoot only toasts while Eddy is closed).
 * - Everything works at 320 CSS px wide (WCAG 1.4.10): no fixed widths, long words wrap.
 * - The keyguard covers the whole sheet (`data-eddy-root` is set on the dialog element), so the inbox's single-key
 *   shortcuts never fire from inside it.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Dialog } from "@/components/ui";
import { tp } from "@/lib/eddy/copy/panel";
import { t } from "@/lib/eddy/i18n";
import { EddyAvatar } from "./EddyAvatar";
import { EDDY_PANEL_ID } from "./EddyLauncher";
import { EddyFooter, EddyMain, HeaderControls, type EddyController, type MenuView } from "./EddyPanel";
import { offKindOf } from "./OffState";
import { attachKeyguard, EDDY_ROOT_ATTR } from "./keyguard";
import { EDDY_FONT_STACK } from "./SafeMarkdown";

/** How much of the layout viewport the on-screen keyboard covers (0 when none). */
export function keyboardInset(innerHeight: number, viewport: { height: number; offsetTop: number } | null | undefined): number {
  if (!viewport || !Number.isFinite(innerHeight)) return 0;
  const inset = Math.round(innerHeight - viewport.height - viewport.offsetTop);
  return inset > 0 ? inset : 0;
}

type HistoryLike = Pick<History, "pushState" | "back" | "state">;

/** The state object pushed for the sheet: the current entry's state (the router's keys) plus `eddy: true`. */
export function sheetHistoryState(current: unknown): Record<string, unknown> {
  return { ...(current && typeof current === "object" ? (current as Record<string, unknown>) : {}), eddy: true };
}

export const isSheetEntry = (state: unknown): boolean => !!state && typeof state === "object" && (state as { eddy?: unknown }).eddy === true;

/** Sheets mounted right now (React may mount, unmount and remount in development; the entry must survive that). */
let liveSheets = 0;

type WindowLike = Pick<Window, "addEventListener" | "removeEventListener" | "setTimeout">;

/**
 * The Back-button contract of the sheet, without React (EddySheet wraps it in useBackCloses):
 * - `mount()` pushes one history entry (`{...current state, eddy: true}`) unless one is already there, and listens for
 *   `popstate`: when the sheet's entry is gone (Android Back, the iOS swipe), it calls `onClose`.
 * - `requestClose(after?)` pops the entry and, once `popstate` arrives, calls `onClose` and then `after` (a navigation), so
 *   a route change never races the pop. With no entry it closes at once.
 * - `unmount()` stops listening and, if the sheet closed some other way, pops the entry once nobody holds it.
 */
export function createSheetHistory(history: HistoryLike, win: WindowLike, onClose: () => void) {
  let after: (() => void) | null = null;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    const next = after;
    after = null;
    onClose();
    next?.();
  };
  const onPop = () => {
    if (!isSheetEntry(history.state)) finish();
  };
  return {
    mount() {
      liveSheets++;
      done = false;
      try {
        if (!isSheetEntry(history.state)) history.pushState(sheetHistoryState(history.state), "");
      } catch {
        // history unavailable (a sandboxed frame): Back simply leaves the page, as without this feature
      }
      win.addEventListener("popstate", onPop);
    },
    unmount() {
      liveSheets--;
      win.removeEventListener("popstate", onPop);
      win.setTimeout(() => {
        try {
          if (liveSheets <= 0 && isSheetEntry(history.state)) history.back();
        } catch {
          // ignore
        }
      }, 0);
    },
    requestClose(next?: () => void) {
      after = next ?? null;
      if (isSheetEntry(history.state)) {
        history.back();
        // If popstate never comes (an unusual browser), close anyway.
        win.setTimeout(finish, 400);
        return;
      }
      finish();
    },
  };
}

/** React wrapper of createSheetHistory: returns `requestClose(after?)`. */
export function useBackCloses(onClose: () => void): (after?: () => void) => void {
  const latest = useRef(onClose);
  latest.current = onClose;
  const controller = useRef<ReturnType<typeof createSheetHistory> | null>(null);

  useEffect(() => {
    const c = createSheetHistory(window.history, window, () => latest.current());
    controller.current = c;
    c.mount();
    return () => {
      c.unmount();
      if (controller.current === c) controller.current = null;
    };
  }, []);

  return useCallback((after?: () => void) => {
    if (controller.current) controller.current.requestClose(after);
    else {
      latest.current();
      after?.();
    }
  }, []);
}

/** Keeps the composer above the on-screen keyboard (visualViewport), returning the inset in px. */
function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => setInset(keyboardInset(window.innerHeight, vv));
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);
  return inset;
}

export function EddySheet({ c }: { c: EddyController }) {
  const content = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement | null>(null);
  const [menu, setMenu] = useState<MenuView>(null);
  const menuId = useId();
  const inset = useKeyboardInset();
  const requestClose = useBackCloses(() => c.close({ restoreFocus: true }));

  // The whole dialog is Eddy's: mark it and guard its keys (the Dialog's own Escape and Tab listen on document, capture).
  useEffect(() => {
    const dialog = content.current?.closest<HTMLElement>('[role="dialog"]');
    if (!dialog) return;
    dialog.setAttribute(EDDY_ROOT_ATTR, "");
    dialog.id = dialog.id || EDDY_PANEL_ID;
    dialog.style.fontFamily = EDDY_FONT_STACK;
    return attachKeyguard(dialog);
  }, []);

  // Navigation from inside the sheet closes it first (popping its history entry), then moves.
  const sheetController: EddyController = { ...c, navigate: (path) => requestClose(() => c.navigate(path)), close: () => requestClose() };

  // Escape closes the menu first. The Dialog hears Escape on document (capture), before React's handlers inside the portal
  // run, so this listens one step earlier, on window, and only while the menu is open.
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setMenu(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [menu]);

  const canChat = !!c.status && offKindOf(c.status, c.statusError) === null;
  return (
    <Dialog
      title={t(c.lang, "name")}
      onClose={() => requestClose()}
      icon={<EddyAvatar size="gutter" state={c.session.state.working ? "working" : "idle"} />}
      headerAside={<HeaderControls c={c} menu={menu} setMenu={setMenu} menuId={menuId} />}
      closeClassName="inline-flex h-11 w-11 shrink-0 items-center justify-center"
      closeLabel={tp(c.lang, "panel.close")}
      initialFocus={content}
      footer={
        canChat ? (
          <div className="w-full min-w-0 pb-[env(safe-area-inset-bottom)]" style={inset ? { paddingBottom: inset } : undefined} data-eddy-sheet-footer>
            <EddyFooter c={sheetController} inputRef={input} />
          </div>
        ) : undefined
      }
    >
      <div ref={content} tabIndex={-1} className="min-h-[40dvh] min-w-0 outline-none" data-eddy-sheet>
        <EddyMain c={sheetController} menu={menu} setMenu={setMenu} menuId={menuId} focusInput={() => (input.current ?? content.current)?.focus()} />
      </div>
    </Dialog>
  );
}
