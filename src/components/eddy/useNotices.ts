"use client";

/**
 * The member's notices on the client (docs/EDDY-SPEC.md 6.7): one small per-tab store, like useEddyStatus.
 *
 * - Delivery: `GET /api/notices` every 60 s while the tab is visible, and whenever Eddy opens (useNoticesPoller). There is
 *   no SSE stream (the inbox keeps its 20 streams per workspace). Concurrent loads share one request; a failed load keeps
 *   the last good list.
 * - The launcher's needs-you dot follows each load (patchEddyStatus), so it is never more than a minute behind.
 * - Toasts: the server hands out each action-needed notice once per member (`toasts`); each becomes one sticky toast,
 *   keyed by the notice id, whose only button opens Eddy (where the strip shows the notice). It never carries text into a
 *   message.
 * - Seen, dismissed and "Don't show these" are PATCH /api/notices/[id]; a dismissed or muted notice leaves the list at once.
 */
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { toast } from "@/components/ui";
import { safeAppPath, type EddyLang, type NoticeAction, type NoticeDTO, type NoticeSeverity } from "@/lib/eddy/contract";
import "@/lib/eddy/copy/notices";
import { asEddyLang, t, translateKey } from "@/lib/eddy/i18n";
import { openEddy } from "./events";
import { patchEddyStatus, readEddyStatusSnapshot } from "./useEddyStatus";

export const NOTICES_POLL_MS = 60_000;
export const NOTICES_ENDPOINT = "/api/notices";

export type NoticesSnapshot = { notices: NoticeDTO[]; needsYou: number; loading: boolean; error: boolean; loadedAt: number | null };

const EMPTY: NoticesSnapshot = { notices: [], needsYou: 0, loading: false, error: false, loadedAt: null };
let snapshot: NoticesSnapshot = EMPTY;
const listeners = new Set<() => void>();

function publish(patch: Partial<NoticesSnapshot>): void {
  snapshot = { ...snapshot, ...patch };
  for (const l of listeners) l();
}
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
const getSnapshot = () => snapshot;
const getServerSnapshot = () => EMPTY;

// ===== Parsing (every field checked; anything unexpected is dropped) =====

const SEVERITIES: readonly NoticeSeverity[] = ["action_needed", "heads_up", "fyi"];
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const KEY = /^[a-z][a-z0-9_.]{1,80}$/;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const iso = (v: unknown) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : null);

/** One action, kept only in a shape the server may send (6.7 critic: navigate to /app, open Eddy by id, a fresh card). */
export function parseAction(v: unknown): NoticeAction | null {
  if (!isObj(v) || typeof v.labelKey !== "string" || !KEY.test(v.labelKey)) return null;
  if (v.kind === "navigate") {
    const path = safeAppPath(v.path);
    return path ? { kind: "navigate", path, labelKey: v.labelKey } : null;
  }
  if (v.kind === "open_eddy" && isObj(v.ref)) {
    if (v.ref.kind === "notice" && typeof v.ref.noticeId === "string" && ID.test(v.ref.noticeId)) return { kind: "open_eddy", ref: { kind: "notice", noticeId: v.ref.noticeId }, labelKey: v.labelKey };
    if (v.ref.kind === "message" && typeof v.ref.messageId === "string" && ID.test(v.ref.messageId)) return { kind: "open_eddy", ref: { kind: "message", messageId: v.ref.messageId }, labelKey: v.labelKey };
    return null;
  }
  if (v.kind === "card" && typeof v.action === "string" && /^[a-z][a-z0-9_]{1,63}$/.test(v.action)) return { kind: "card", action: v.action, labelKey: v.labelKey };
  return null;
}

export function parseNotice(v: unknown): NoticeDTO | null {
  if (!isObj(v) || typeof v.id !== "string" || !ID.test(v.id) || typeof v.kind !== "string" || typeof v.textKey !== "string" || !KEY.test(v.textKey)) return null;
  const severity = SEVERITIES.includes(v.severity as NoticeSeverity) ? (v.severity as NoticeSeverity) : "fyi";
  const payload: NoticeDTO["payload"] = {};
  if (isObj(v.payload)) for (const [k, val] of Object.entries(v.payload)) if (val === null || ["string", "number", "boolean"].includes(typeof val)) payload[k] = typeof val === "string" ? val.slice(0, 600) : (val as number | boolean | null);
  const createdAt = iso(v.createdAt);
  const updatedAt = iso(v.updatedAt);
  const expiresAt = iso(v.expiresAt);
  if (!createdAt || !updatedAt || !expiresAt) return null;
  return {
    id: v.id,
    kind: v.kind.slice(0, 40),
    severity,
    source: v.source === "spend" || v.source === "system" ? v.source : "eddy",
    textKey: v.textKey,
    payload,
    actions: (Array.isArray(v.actions) ? v.actions : []).map(parseAction).filter((a): a is NoticeAction => a !== null).slice(0, 3),
    subjectType: typeof v.subjectType === "string" ? v.subjectType : null,
    subjectId: typeof v.subjectId === "string" ? v.subjectId : null,
    count: typeof v.count === "number" && Number.isFinite(v.count) ? v.count : 1,
    createdAt,
    updatedAt,
    expiresAt,
    resolvedAt: iso(v.resolvedAt),
    seenAt: iso(v.seenAt),
    dismissedAt: iso(v.dismissedAt),
    toastedAt: iso(v.toastedAt),
  };
}

export type NoticesResponse = { notices: NoticeDTO[]; needsYou: number; toasts: string[] };

export function parseNoticesResponse(json: unknown): NoticesResponse | null {
  if (!isObj(json) || !Array.isArray(json.notices)) return null;
  const notices = json.notices.map(parseNotice).filter((n): n is NoticeDTO => n !== null);
  const needsYou = typeof json.needsYou === "number" && Number.isFinite(json.needsYou) ? Math.max(0, Math.min(99, Math.floor(json.needsYou))) : notices.filter((n) => n.severity !== "fyi").length;
  const toasts = Array.isArray(json.toasts) ? json.toasts.filter((id): id is string => typeof id === "string" && ID.test(id)) : [];
  return { notices, needsYou, toasts };
}

// ===== Text =====

/** A notice's text in the member's language. Phase 0's own rows show Phase 0's sentence (English) when they carry one. */
export function noticeText(lang: EddyLang, n: Pick<NoticeDTO, "textKey" | "payload" | "source" | "count">): string {
  if (n.source === "spend" && typeof n.payload.title === "string") return typeof n.payload.body === "string" ? `${n.payload.title}. ${n.payload.body}` : n.payload.title;
  const vars: Record<string, string | number | null> = {};
  for (const [k, v] of Object.entries(n.payload)) vars[k] = typeof v === "boolean" ? String(v) : v;
  if (vars.count === undefined) vars.count = n.count;
  return translateKey(lang, n.textKey, vars, translateKey(lang, "notices.generic"));
}

/** The language for toasts: the member's saved preference, else English. */
function toastLang(): EddyLang {
  const pref = readEddyStatusSnapshot().status?.langPref;
  return pref && pref !== "auto" ? asEddyLang(pref) : "en";
}

/** One sticky toast per claimed action-needed notice; its button opens Eddy, where the strip shows it. */
export function showNoticeToasts(notices: readonly NoticeDTO[], ids: readonly string[], lang: EddyLang = toastLang()): number {
  let shown = 0;
  for (const id of ids) {
    const n = notices.find((x) => x.id === id && x.severity === "action_needed");
    if (!n) continue;
    toast.warning(noticeText(lang, n), { key: `notice-${n.id}`, duration: 0, action: { label: t(lang, "btn.open"), onAction: () => void openEddy({}) } });
    shown++;
  }
  return shown;
}

// ===== Loading =====

let inflight: Promise<NoticesSnapshot> | null = null;

/** Loads the notices once (concurrent callers share the request), publishes them and shows any claimed toasts. */
export function loadNotices(): Promise<NoticesSnapshot> {
  if (inflight) return inflight;
  publish({ loading: true });
  inflight = (async () => {
    try {
      const res = await fetch("/api/notices", { credentials: "same-origin", cache: "no-store", headers: { accept: "application/json" } });
      const parsed = res.ok ? parseNoticesResponse(await res.json().catch(() => null)) : null;
      if (!parsed) {
        publish({ loading: false, error: true });
        return snapshot;
      }
      publish({ notices: parsed.notices, needsYou: parsed.needsYou, loading: false, error: false, loadedAt: Date.now() });
      patchEddyStatus({ needsYou: parsed.needsYou });
      if (parsed.toasts.length) showNoticeToasts(parsed.notices, parsed.toasts);
      return snapshot;
    } catch {
      publish({ loading: false, error: true });
      return snapshot;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export type NoticePatch = { seen?: true; dismissed?: true; mute?: true };

/** PATCH /api/notices/[id]. A dismissed or muted notice leaves the list at once; it comes back if the server refuses. */
export async function patchNotice(id: string, body: NoticePatch): Promise<boolean> {
  if (!ID.test(id)) return false;
  const before = snapshot.notices;
  const target = before.find((n) => n.id === id);
  if (body.dismissed || body.mute) {
    const gone = (n: NoticeDTO) => n.id === id || (!!body.mute && !!target && n.kind === target.kind);
    const notices = before.filter((n) => !gone(n));
    const needsYou = notices.filter((n) => n.severity !== "fyi").length;
    publish({ notices, needsYou });
    patchEddyStatus({ needsYou });
  }
  try {
    const res = await fetch(`/api/notices/${encodeURIComponent(id)}`, { method: "PATCH", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (res.ok) return true;
  } catch {
    // fall through: put the notice back
  }
  if (body.dismissed || body.mute) publish({ notices: before, needsYou: before.filter((n) => n.severity !== "fyi").length });
  return false;
}

/** Test seam: puts the store back to empty, or to a given snapshot. */
export function resetNoticesStore(next: Partial<NoticesSnapshot> = {}): void {
  inflight = null;
  snapshot = { ...EMPTY, ...next };
  for (const l of listeners) l();
}

export function readNoticesSnapshot(): NoticesSnapshot {
  return snapshot;
}

/** The shared notices snapshot, plus refresh, dismiss and mute. */
export function useNotices(): NoticesSnapshot & { refresh: () => Promise<NoticesSnapshot>; dismiss: (id: string) => Promise<boolean>; mute: (id: string) => Promise<boolean>; markSeen: (id: string) => Promise<boolean> } {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const refresh = useCallback(() => loadNotices(), []);
  const dismiss = useCallback((id: string) => patchNotice(id, { dismissed: true }), []);
  const mute = useCallback((id: string) => patchNotice(id, { mute: true }), []);
  const markSeen = useCallback((id: string) => patchNotice(id, { seen: true }), []);
  return { ...snap, refresh, dismiss, mute, markSeen };
}

/**
 * Keeps the notices fresh: on mount, every 60 s while the tab is visible, when the tab becomes visible again, and when
 * Eddy opens. Call it once, where Eddy is mounted (EddyRoot).
 */
export function useNoticesPoller(open: boolean): void {
  const wasOpen = useRef(open);
  useEffect(() => {
    void loadNotices();
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void loadNotices();
    }, NOTICES_POLL_MS);
    const visible = () => {
      if (document.visibilityState !== "hidden") void loadNotices();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, []);
  useEffect(() => {
    if (open && !wasOpen.current) void loadNotices();
    wasOpen.current = open;
  }, [open]);
}
