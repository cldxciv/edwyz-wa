"use client";

/**
 * Where Eddy lives in the app (docs/EDDY-SPEC.md 6.1, 6.2, 6.4, 6.13, EDDY-13 acceptance 8, EDDY-14).
 *
 * AppShell mounts this once, after the content column. It stays mounted and small: it polls the status (on mount, every
 * 5 minutes, on open), holds the conversation (useEddyStream) and the unsent draft, follows the page context, and loads the
 * panel lazily with next/dynamic the first time Eddy opens: the desktop aside (EddyPanel, `data-eddy-root`) from md up,
 * the bottom sheet (EddySheet) below. Both render in the Devanagari-safe system font stack (EDDY_FONT_STACK).
 *
 * Because the conversation lives here, a turn keeps streaming when the panel is closed; the launcher shows Eddy working,
 * and a done action then raises a toast with [Undo] (while Eddy is open, its own result rows stand in for toasts).
 * Pages are told what changed through `wa:eddy-did` (6.4); the intents that only touch the current page (put a draft in the
 * inbox composer, open the template picker) are carried out here. Opening a page or connecting WhatsApp or Facebook shows
 * a chip in the transcript instead, and only the member's tap moves them (4.6, 6.15).
 */
import dynamic from "next/dynamic";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "@/components/ui";
import { safeAppPath, type EddyEvent, type EddyLang } from "@/lib/eddy/contract";
// Registers the action definitions' catalogue (card titles of small changes, fact labels, role options) with
// translateKey(), so cards, done rows and toasts render those keys instead of falling back (src/lib/eddy/copy/defs.ts).
import "@/lib/eddy/copy/defs";
import { tp } from "@/lib/eddy/copy/panel";
import { isMostlyDevanagari, t, translateKey } from "@/lib/eddy/i18n";
import { chromeLang } from "./EddyLauncher";
import type { EddyController } from "./EddyPanel";
import { announceEddyDid, dispatchEddyEvent, EDDY_EVENTS, EDDY_ID, type EddyOpenRef } from "./events";
import { pageContextFromLocation, useEddySelection, withoutIds } from "./page-context";
import { loadEddyStatus, rememberedPanelOpen, rememberPanelOpen, setEddyWorking, useEddyStatus, useEddyStatusPoller } from "./useEddyStatus";
import { useNoticesPoller } from "./useNotices";
import { CONNECT_FACEBOOK_PATH, CONNECT_WHATSAPP_PATH, entityForAction, takeDraft, useEddyStream } from "./useEddyStream";

const EddyPanel = dynamic(() => import("./EddyPanel").then((m) => m.EddyPanel), { ssr: false, loading: () => null });
const EddySheet = dynamic(() => import("./EddySheet").then((m) => m.EddySheet), { ssr: false, loading: () => null });

/** Tailwind's md: from here Eddy is the desktop panel; below, the phone sheet. */
export const DESKTOP_MEDIA = "(min-width: 48rem)";
/** The connect cards' targets; the chips that lead there are built with the transcript (useEddyStream applyIntent). */
export { CONNECT_FACEBOOK_PATH, CONNECT_WHATSAPP_PATH };

/** A request to open Eddy with the member's own query or an id-only reference (palette, notices, failed bubbles). */
export type EddyRequest = { seq: number; query?: string; ref?: EddyOpenRef };

/** The language of the member's own bubble: Devanagari is hi; otherwise the conversation's Latin language. */
export function memberLang(text: string, turnLang: EddyLang | null): EddyLang {
  if (isMostlyDevanagari(text)) return "hi";
  return turnLang === "hinglish" ? "hinglish" : "en";
}

/** The visible top-bar launcher (one is hidden per breakpoint). */
export function focusLauncher(doc: Document | null = typeof document === "undefined" ? null : document): void {
  const all = Array.from(doc?.querySelectorAll<HTMLElement>("[data-eddy-launcher]") ?? []);
  const visible = all.find((el) => el.getClientRects().length > 0) ?? all[0];
  visible?.focus();
}

function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (cb: () => void) => {
      const mq = window.matchMedia?.(query);
      mq?.addEventListener?.("change", cb);
      return () => mq?.removeEventListener?.("change", cb);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia?.(query).matches ?? true,
    () => true,
  );
}

/** location.search, re-read on history moves and, while Eddy is open, every second (the inbox sets ?c= by replaceState). */
function useLocationSearch(active: boolean): string {
  const subscribe = useCallback(
    (cb: () => void) => {
      window.addEventListener("popstate", cb);
      const timer = active ? window.setInterval(cb, 1000) : 0;
      return () => {
        window.removeEventListener("popstate", cb);
        if (timer) window.clearInterval(timer);
      };
    },
    [active],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.location.search,
    () => "",
  );
}

/**
 * Carries out an intent from the stream (5.12): ids checked, text only into the open chat's composer. `navigate`,
 * `connect_whatsapp` and `connect_facebook` are NOT carried out here: they become chips in the transcript and move the
 * member only when tapped (4.6 open_page "Eddy navigates only when the member taps it"; 6.15 Meta's consent screens start
 * "from a member's tap on an intent card, never from the model"). See applyIntent in useEddyStream.ts.
 */
export function runIntent(event: Extract<EddyEvent, { type: "intent" }>, navigate: (path: string) => void, currentConversationId: string | undefined): void {
  const p = (event.payload && typeof event.payload === "object" ? event.payload : {}) as Record<string, unknown>;
  switch (event.kind) {
    case "composer_draft": {
      const conversationId = typeof p.conversationId === "string" && EDDY_ID.test(p.conversationId) ? p.conversationId : null;
      if (!conversationId || typeof p.text !== "string") return;
      const detail = { conversationId, text: p.text };
      if (currentConversationId === conversationId) dispatchEddyEvent(EDDY_EVENTS.draft, detail);
      else {
        navigate(`/app/inbox?c=${encodeURIComponent(conversationId)}`);
        // The inbox composer mounts after the route change; it only accepts the draft for the chat that is open.
        window.setTimeout(() => dispatchEddyEvent(EDDY_EVENTS.draft, detail), 1200);
      }
      return;
    }
    case "open_templates": {
      const conversationId = typeof p.conversationId === "string" && EDDY_ID.test(p.conversationId) ? p.conversationId : null;
      if (conversationId) dispatchEddyEvent(EDDY_EVENTS.openTemplates, { conversationId });
      return;
    }
    default:
      return;
  }
}

async function undoFromToast(actionId: string, lang: EddyLang): Promise<void> {
  try {
    const res = await fetch(`/api/actions/${encodeURIComponent(actionId)}/undo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lang }),
      credentials: "same-origin",
    });
    const json = (await res.json().catch(() => ({}))) as { state?: string; code?: string; card?: unknown };
    if (json.state === "undone") toast.success(t(lang, "undo.done"));
    else if (json.card) toast.info(t(lang, "undo.needs_card"));
    else if (json.code === "undo_changed") toast.warning(t(lang, "undo.conflict"));
    else if (json.code === "undo_expired") toast.warning(t(lang, "undo.expired"));
    else toast.error(t(lang, "undo.failed"));
  } catch {
    toast.error(t(lang, "undo.failed"));
  }
}

export type EddyRootProps = {
  role: string;
  userName: string;
  workspaceName: string;
  open: boolean;
  /** The latest open request with a query or a reference; a new `seq` is a new request. */
  request: EddyRequest | null;
  onOpen: () => void;
  onClose: () => void;
};

export function EddyRoot({ role, userName, workspaceName, open, request, onOpen, onClose }: EddyRootProps) {
  const router = useRouter();
  const pathname = usePathname();
  const desktop = useMediaQuery(DESKTOP_MEDIA);
  const search = useLocationSearch(open);
  const selection = useEddySelection(pathname);
  const { status, error: statusError, refresh } = useEddyStatus();
  useEddyStatusPoller(open);
  // Notices every 60 s while the tab is visible and when Eddy opens, so action-needed toasts reach a closed Eddy too (6.7).
  useNoticesPoller(open);

  const [draft, setDraft] = useState("");
  const [draftRestored, setDraftRestored] = useState(false);
  const [openRef, setOpenRef] = useState<EddyOpenRef | null>(null);
  const [contextDropped, setContextDropped] = useState(false);
  const openRefState = useRef(open);
  openRefState.current = open;

  const page = useMemo(() => pageContextFromLocation(pathname, search, selection), [pathname, search, selection]);
  const pageRef = useRef(page);
  pageRef.current = page;

  const navigate = useCallback(
    (path: string) => {
      const safe = safeAppPath(path);
      if (safe) router.push(safe);
    },
    [router],
  );

  const langRef = useRef<EddyLang>("en");
  const onEvent = useCallback(
    (event: EddyEvent) => {
      if (event.type === "intent") runIntent(event, navigate, pageRef.current.conversationId);
      else if (event.type === "done_action") {
        const entity = entityForAction(event.summaryKey);
        if (entity) announceEddyDid(entity, []);
        if (!openRefState.current) {
          const lang = langRef.current;
          const summary = translateKey(lang, event.summaryKey, event.vars);
          const undoable = !!event.undoUntil && Date.parse(event.undoUntil) > Date.now();
          toast.success(summary, { key: `eddy-done-${event.actionId}`, ...(undoable ? { action: { label: t(lang, "btn.undo"), onAction: () => void undoFromToast(event.actionId, lang) } } : {}) });
        }
      } else if (event.type === "error" && ["platform_off", "locked", "workspace_off", "paused", "allowance_used", "user_capped"].includes(event.state)) void loadEddyStatus();
      else if (event.type === "end") void loadEddyStatus();
    },
    [navigate],
  );

  const session = useEddyStream({ onEvent });
  const { state } = session;
  const lang = chromeLang(status?.langPref, state.lang);
  langRef.current = lang;

  useEffect(() => setEddyWorking(state.working), [state.working]);

  // After a sign-in redirect: take the saved draft back and reopen Eddy. On desktop, reopen a panel this tab had open.
  const openOnMount = useRef(onOpen);
  useEffect(() => {
    const restoredDraft = takeDraft();
    if (restoredDraft) {
      setDraft(restoredDraft);
      setDraftRestored(true);
      openOnMount.current();
    } else if (rememberedPanelOpen() && window.matchMedia?.(DESKTOP_MEDIA).matches) openOnMount.current();
  }, []);

  // The first open loads the member's latest conversation (a reload or a new sign-in shows it again).
  const { restore, send: sendTurn } = session;
  useEffect(() => {
    if (open) void restore();
  }, [open, restore]);

  const send = useCallback(
    (text: string) => {
      const ref = openRef ?? undefined;
      const pageNow = pageRef.current;
      const trimmed = text.trim();
      if (!trimmed && !ref) return;
      void sendTurn({ text: trimmed, lang: memberLang(trimmed, state.lang), page: contextDropped ? withoutIds(pageNow) : pageNow, ref: contextDropped ? undefined : ref });
      setDraft("");
      setDraftRestored(false);
      setOpenRef(null);
      setContextDropped(false);
    },
    [openRef, contextDropped, sendTurn, state.lang],
  );

  // A request from the palette, a notice or a failed bubble: send the query (or "Explain this" with the reference) once
  // Eddy can chat; while it can't, the query waits in the composer so nothing is lost.
  const handled = useRef(0);
  useEffect(() => {
    if (!open || !request || request.seq === handled.current) return;
    if (!status) return; // wait for the first status
    handled.current = request.seq;
    if (request.ref) setOpenRef(request.ref);
    const query = request.query ?? (request.ref ? tp(lang, "panel.ref.explain") : "");
    if (!query) return;
    if (status.state !== "ready" || state.working) {
      setDraft(query);
      return;
    }
    void sendTurn({ text: query, lang: memberLang(query, state.lang), page: pageRef.current, ref: request.ref });
    setOpenRef(null);
  }, [open, request, status, lang, sendTurn, state.working, state.lang]);

  // A new route brings its page context back.
  useEffect(() => setContextDropped(false), [pathname]);

  // However Eddy was closed (the launcher, the panel, Back), this tab no longer remembers it as open.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !open) rememberPanelOpen(false);
    wasOpen.current = open;
  }, [open]);

  const close = useCallback(
    (opts: { restoreFocus?: boolean } = {}) => {
      rememberPanelOpen(false);
      onClose();
      if (opts.restoreFocus) window.setTimeout(() => focusLauncher(), 0);
    },
    [onClose],
  );

  if (!open) return null;

  const controller: EddyController = {
    session,
    status,
    statusError,
    refreshStatus: () => void refresh(),
    lang,
    role,
    userName,
    workspaceName,
    page,
    openRef,
    contextDropped,
    dropContext: () => {
      setContextDropped(true);
      setOpenRef(null);
    },
    draft,
    setDraft,
    draftRestored,
    send,
    close,
    navigate,
  };

  return desktop ? <EddyPanel c={controller} /> : <EddySheet c={controller} />;
}
