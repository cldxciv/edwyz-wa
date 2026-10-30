"use client";

/**
 * Eddy's availability, as the shell and the panel see it (docs/EDDY-SPEC.md 5.11, 6.1, 6.3, 6.13).
 *
 * `GET /api/eddy/status` makes no model call. It is loaded on shell mount, every 5 minutes, and whenever the panel opens
 * (useEddyStatusPoller, called once by EddyRoot). The result lives in one small per-tab store, so the top-bar launcher (its
 * needs-you dot and count), the panel header (its status pill) and the off states all read the same snapshot without
 * fetching again. The store also carries `working`, so the launcher can show that Eddy is still answering after the panel
 * was closed (6.2).
 *
 * The per-tab memory of whether the desktop panel was open (`sessionStorage eddy:open`, 6.2) is here too, because the shell
 * reads it before the lazily loaded panel exists. Every storage access is inside try/catch (private windows throw).
 */
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { EDDY_AVAILABILITY_ORDER, type EddyAvailability, type EddyLangPref, type EddyStatusDTO, type EddyWhatsAppState } from "@/lib/eddy/contract";

/** Reload the status this often while the app is open (6.13). */
export const STATUS_POLL_MS = 5 * 60_000;

export type StatusError = "offline" | "signed_out" | "failed";

export type EddyStatusSnapshot = {
  status: EddyStatusDTO | null;
  /** Why the last load failed. The last good status stays on screen. */
  error: StatusError | null;
  loading: boolean;
  /** A turn is running: the launcher shows Eddy working while the panel is closed. */
  working: boolean;
  loadedAt: number | null;
};

const EMPTY: EddyStatusSnapshot = { status: null, error: null, loading: false, working: false, loadedAt: null };
let snapshot: EddyStatusSnapshot = EMPTY;
const listeners = new Set<() => void>();

function publish(patch: Partial<EddyStatusSnapshot>): void {
  snapshot = { ...snapshot, ...patch };
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
const getSnapshot = () => snapshot;
const getServerSnapshot = () => EMPTY;

const num = (v: unknown, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback);
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
const names = (v: unknown): string[] => (Array.isArray(v) ? v.filter((n): n is string => typeof n === "string" && n.trim().length > 0).map((n) => n.slice(0, 80)).slice(0, 5) : []);
const LANG_PREFS: readonly EddyLangPref[] = ["auto", "en", "hi", "hinglish"];
const WA_STATES: readonly EddyWhatsAppState[] = ["connected", "none", "reconnect"];

/**
 * A status response, checked field by field. An unknown state gives null (the panel then shows "couldn't be loaded" with
 * Retry, never a guessed state). Missing optional fields fall back to the safe value: not owner, nothing waiting, not demo.
 */
export function parseStatus(json: unknown): EddyStatusDTO | null {
  if (!json || typeof json !== "object") return null;
  const o = json as Record<string, unknown>;
  const state = o.state as EddyAvailability;
  if (!EDDY_AVAILABILITY_ORDER.includes(state)) return null;
  const a = (o.allowance && typeof o.allowance === "object" ? o.allowance : {}) as Record<string, unknown>;
  const out: EddyStatusDTO = {
    state,
    readOnly: o.readOnly === true,
    canEnable: o.canEnable === true,
    ownerNames: names(o.ownerNames ?? o.adminNames),
    allowance: {
      usedToday: num(a.usedToday),
      limitToday: numOrNull(a.limitToday),
      usedMonth: num(a.usedMonth),
      limitMonth: numOrNull(a.limitMonth),
      resetsOn: typeof a.resetsOn === "string" ? a.resetsOn : null,
      memberUsedToday: num(a.memberUsedToday),
      memberLimitToday: num(a.memberLimitToday),
    },
    langPref: LANG_PREFS.includes(o.langPref as EddyLangPref) ? (o.langPref as EddyLangPref) : "auto",
    needsYou: Math.min(99, Math.floor(num(o.needsYou))),
    demo: o.demo === true,
    whatsapp: WA_STATES.includes(o.whatsapp as EddyWhatsAppState) ? (o.whatsapp as EddyWhatsAppState) : "none",
    phase: o.phase === 2 ? 2 : 1,
    firstUse: o.firstUse === true,
    spendingStopped: o.spendingStopped === true,
  };
  if (state === "platform_off") out.reason = o.reason === "paused" ? "paused" : "not_configured";
  // How long chats are kept, from the platform's retention setting (GET /api/eddy/status sends it); historyDaysOf reads it.
  if (validHistoryDays(o.historyDays)) (out as EddyStatusDTO & { historyDays?: number }).historyDays = o.historyDays;
  return out;
}

const validHistoryDays = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 30 && v <= 365;

/** How long chats are kept ({days} in notice.first_use and the delete line): the server's figure when it sends one, else 90. */
export function historyDaysOf(status: EddyStatusDTO | null | undefined): number {
  const v = (status as unknown as { historyDays?: unknown } | null | undefined)?.historyDays;
  return validHistoryDays(v) ? v : 90;
}

const isOffline = () => typeof navigator !== "undefined" && (navigator as { onLine?: boolean }).onLine === false;

let inflight: Promise<EddyStatusDTO | null> | null = null;

/** Loads the status once (concurrent callers share the request) and publishes it. Never throws. */
export function loadEddyStatus(): Promise<EddyStatusDTO | null> {
  if (inflight) return inflight;
  if (isOffline()) {
    publish({ error: "offline", loading: false });
    return Promise.resolve(snapshot.status);
  }
  publish({ loading: true });
  inflight = (async () => {
    try {
      const res = await fetch("/api/eddy/status", { credentials: "same-origin", cache: "no-store", headers: { accept: "application/json" } });
      if (res.status === 401) {
        publish({ loading: false, error: "signed_out" });
        return null;
      }
      const status = res.ok ? parseStatus(await res.json().catch(() => null)) : null;
      if (!status) {
        publish({ loading: false, error: "failed" });
        return snapshot.status;
      }
      publish({ status, error: null, loading: false, loadedAt: Date.now() });
      return status;
    } catch {
      publish({ loading: false, error: isOffline() ? "offline" : "failed" });
      return snapshot.status;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Marks a turn as running or finished (the launcher reads it). */
export function setEddyWorking(working: boolean): void {
  if (snapshot.working !== working) publish({ working });
}

/** Applies a change the member just made (language, first-use acknowledgement) before the next load confirms it. */
export function patchEddyStatus(patch: Partial<EddyStatusDTO>): void {
  if (snapshot.status) publish({ status: { ...snapshot.status, ...patch } });
}

/** Test seam: puts the store back to empty, or to a given snapshot. */
export function resetEddyStatusStore(next: Partial<EddyStatusSnapshot> = {}): void {
  inflight = null;
  snapshot = { ...EMPTY, ...next };
  for (const l of listeners) l();
}

export function readEddyStatusSnapshot(): EddyStatusSnapshot {
  return snapshot;
}

/** The shared status snapshot, plus a refresh function. */
export function useEddyStatus(): EddyStatusSnapshot & { refresh: () => Promise<EddyStatusDTO | null> } {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const refresh = useCallback(() => loadEddyStatus(), []);
  return { ...snap, refresh };
}

/**
 * Keeps the status fresh: on mount, every 5 minutes while the tab is visible, when the panel opens, and when the browser
 * comes back online. Call it once (EddyRoot does).
 */
export function useEddyStatusPoller(open: boolean): void {
  const wasOpen = useRef(open);
  useEffect(() => {
    void loadEddyStatus();
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void loadEddyStatus();
    }, STATUS_POLL_MS);
    const online = () => void loadEddyStatus();
    const offline = () => publish({ error: "offline" });
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
    };
  }, []);
  useEffect(() => {
    if (open && !wasOpen.current) void loadEddyStatus();
    wasOpen.current = open;
  }, [open]);
}

// ===== Per-tab memory of the desktop panel (6.2) =====

export const EDDY_OPEN_KEY = "eddy:open";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function sessionStore(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** Remembers whether the panel is open in this tab. Storage errors are ignored: the panel simply starts closed. */
export function rememberPanelOpen(open: boolean, storage: StorageLike | null = sessionStore()): void {
  try {
    if (!storage) return;
    if (open) storage.setItem(EDDY_OPEN_KEY, "1");
    else storage.removeItem(EDDY_OPEN_KEY);
  } catch {
    // storage unavailable (private window, quota): nothing is remembered
  }
}

/** True when this tab last had the panel open. */
export function rememberedPanelOpen(storage: StorageLike | null = sessionStore()): boolean {
  try {
    return storage?.getItem(EDDY_OPEN_KEY) === "1";
  } catch {
    return false;
  }
}
