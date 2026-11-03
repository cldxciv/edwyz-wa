/**
 * Facebook Login for Business in a popup (docs/EDDY-SPEC.md 6.15, 12.1a decision 11; docs/IG-PAGE-ADS-SPEC.md 3.2, D20), so
 * people stay in the app; the full-page redirect stays as the fallback when the browser blocks popups or META_LOGIN_POPUP=off.
 *
 * Browsers only let a page open a window synchronously from the click that asked for it: after an awaited fetch the click's
 * user activation can be gone and the window is silently blocked (the same reason components/connect/login.ts preloads
 * Embedded Signup). So `launchFacebookLogin` opens an empty window FIRST, inside the click handler and before anything is
 * awaited, then asks POST /api/meta-connect/start?popup=1 for Facebook's consent URL and sends the window there.
 * When the window could not open, or the server answers `popup: false` (META_LOGIN_POPUP=off), it closes the window and moves
 * the whole page there instead.
 *
 * The attempt ends on the callback's small page (src/app/api/meta-connect/callback/route.ts). The outcome reaches this page
 * by whichever of these works first; completion never depends on window.opener:
 * - postMessage (checked against this site's origin and the message source) and a BroadcastChannel;
 * - the storage event on localStorage['wa-meta-connect'], which the closing page writes (read inside try/catch);
 * - the closing page's meta tag, read as soon as the window is back on this origin (when a strict policy stops its script);
 * - GET /api/meta-connect/connections, polled every 2 s for up to 3 minutes while the window is open: a connection that is
 *   live and has a `lastCheckedAt` other than the one it had when the attempt began means it connected (completeConnect writes
 *   it only after discovery, so a reconnected expired or revoked connection does not count while its assets are still being
 *   read). The callback's page may still be loading then, so the window is closed a moment later, once it shows that page.
 * A window the person closes early ends as "closed"; if the browser only cut the link to the window (its policy can make an
 * open window look closed), the storage event and the polling still report a later success through `onLate`.
 *
 * Only an outcome word ever crosses between the windows; never a code, a token or Meta's error text.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/components/ui";

/** The same values as CONNECT_POPUP in src/lib/meta-connect/service.ts (browser code cannot import that file). */
export const FB_POPUP = { source: "edwyz-meta-connect", channel: "edwyz-meta-connect", meta: "edwyz-meta-connect", storage: "wa-meta-connect" } as const;
export const FB_POPUP_NAME = "edwyz-facebook-login";
export const FB_POPUP_FEATURES = "popup=yes,width=600,height=720";
export const FB_START_PATH = "/api/meta-connect/start";
export const FB_CONNECTIONS_PATH = "/api/meta-connect/connections";
/** The signed state is valid for 10 minutes on the server; after that the attempt cannot finish anyway. */
export const FB_POPUP_TIMEOUT_MS = 10 * 60_000;
export const FB_POLL_MS = 500;
/** The connections list is polled this often while the window is open... */
export const FB_CONNECTIONS_POLL_MS = 2_000;
/** ...for at most this long. */
export const FB_CONNECTIONS_POLL_FOR_MS = 3 * 60_000;
/** After the polling saw the connection finish, the window is closed once it shows the callback's page, or after this long. */
export const FB_POPUP_CLOSE_AFTER_MS = 5_000;

export type FbOutcome = "connected" | "cancelled" | "failed";
export const FB_OUTCOMES: readonly FbOutcome[] = ["connected", "cancelled", "failed"];
export const isFbOutcome = (v: unknown): v is FbOutcome => typeof v === "string" && (FB_OUTCOMES as readonly string[]).includes(v);

/** The part of a Window the launcher and the watcher use, so tests can pass a fake. */
export type PopupLike = {
  closed: boolean;
  close(): void;
  location: { replace(url: string): void };
  /** Readable only while the window shows a page of this origin; reading it otherwise throws. */
  readonly document?: { querySelector(selector: string): { getAttribute(name: string): string | null } | null } | null;
};

export type LaunchDeps = {
  open(url: string, target: string, features: string): PopupLike | null;
  /** POST /api/meta-connect/start, with `popup` when the window opened. `popup: false` in the answer means "use the redirect". */
  fetchStart(popup: boolean): Promise<{ url: string; popup?: boolean }>;
  /** The full-page fallback. */
  redirect(url: string): void;
};

export type LaunchStart = { kind: "opened" } | { kind: "redirected" } | { kind: "error"; message: string };

/** Facebook's consent pages only: the start route returns these, and nothing else is ever opened. */
export function isFacebookDialogUrl(url: unknown): url is string {
  if (typeof url !== "string") return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && /^(www|m|web)\.facebook\.com$/.test(u.hostname) && /\/dialog\/oauth$/.test(u.pathname);
  } catch {
    return false;
  }
}

const closeQuietly = (popup: PopupLike | null) => {
  try {
    popup?.close();
  } catch {
    // Already gone.
  }
};

/**
 * Starts an attempt. Call it synchronously from the click handler: the window is opened by the first statement, before any
 * await. `started` settles once the window was sent to Facebook (or the page is on its way there, or the start failed).
 */
export function launchFacebookLogin(deps: LaunchDeps): { popup: PopupLike | null; started: Promise<LaunchStart> } {
  let popup: PopupLike | null = null;
  try {
    popup = deps.open("", FB_POPUP_NAME, FB_POPUP_FEATURES);
  } catch {
    popup = null;
  }
  const opened = popup;
  const started = (async (): Promise<LaunchStart> => {
    try {
      const answer = await deps.fetchStart(opened !== null);
      const url = answer?.url;
      if (!isFacebookDialogUrl(url)) throw new Error("Connecting is not available yet.");
      if (!opened || answer.popup === false) {
        // Blocked, or the server keeps the full-page redirect (META_LOGIN_POPUP=off): the attempt carries no popup marker.
        closeQuietly(opened);
        deps.redirect(url);
        return { kind: "redirected" };
      }
      if (opened.closed) return { kind: "error", message: "closed" };
      opened.location.replace(url);
      return { kind: "opened" };
    } catch (e) {
      closeQuietly(opened);
      return { kind: "error", message: e instanceof Error ? e.message : "Something went wrong." };
    }
  })();
  return { popup: opened, started };
}

export type WatchResult = { kind: "outcome"; outcome: FbOutcome } | { kind: "closed" } | { kind: "timeout" };

type MessageLike = { origin: string; data: unknown };
type ChannelLike = { onmessage: ((e: { data: unknown }) => void) | null; close(): void };
export type StorageEventLike = { key: string | null; newValue: string | null };

export type WatchDeps = {
  /** This page's origin: messages from anywhere else are ignored. */
  origin: string;
  onMessage(fn: (e: MessageLike) => void): () => void;
  /** A BroadcastChannel, when the browser has one. */
  channel?: (name: string) => ChannelLike | null;
  /** The window's storage event (another window of this origin wrote localStorage). */
  onStorage?: (fn: (e: StorageEventLike) => void) => () => void;
  /** Removes the closing page's localStorage key once the outcome is read. */
  clearStorage?: () => void;
  /** GET /api/meta-connect/connections. */
  connections?: () => Promise<unknown>;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

/** The outcome in a message from the closing page, or null when the message is anything else. */
export function outcomeOf(data: unknown): FbOutcome | null {
  if (!data || typeof data !== "object") return null;
  const d = data as { source?: unknown; outcome?: unknown };
  return d.source === FB_POPUP.source && isFbOutcome(d.outcome) ? d.outcome : null;
}

/** The outcome in a storage event for the closing page's key, or null for any other key or value. */
export function outcomeFromStorage(e: StorageEventLike | null | undefined): FbOutcome | null {
  if (!e || e.key !== FB_POPUP.storage || typeof e.newValue !== "string" || e.newValue.length > 512) return null;
  try {
    return outcomeOf(JSON.parse(e.newValue));
  } catch {
    return null;
  }
}

/** The outcome the closing page shows in its meta tag, or null while the window is elsewhere (or on any other page). */
export function readPopupOutcome(popup: PopupLike): FbOutcome | null {
  try {
    const value = popup.document?.querySelector(`meta[name="${FB_POPUP.meta}"]`)?.getAttribute("content") ?? null;
    return isFbOutcome(value) ? value : null;
  } catch {
    return null; // Facebook's page: another origin, not readable.
  }
}

/** One connection in the polled list: whether it is live (active or expiring) and its `lastCheckedAt`. */
export type ConnectionMark = { live: boolean; checkedAt: string | null };

/**
 * Every connection in the list, whatever its status, by id, with its `lastCheckedAt` (completeConnect writes it only after
 * discovery). Null when the answer is not the connections list.
 */
export function connectionsMark(payload: unknown): Map<string, ConnectionMark> | null {
  const list = (payload as { connections?: unknown } | null)?.connections;
  if (!Array.isArray(list)) return null;
  const out = new Map<string, ConnectionMark>();
  for (const c of list as { id?: unknown; status?: unknown; lastCheckedAt?: unknown }[]) {
    if (!c || typeof c.id !== "string") continue;
    out.set(c.id, { live: c.status === "active" || c.status === "expiring", checkedAt: typeof c.lastCheckedAt === "string" ? c.lastCheckedAt : null });
  }
  return out;
}

/**
 * True when a connection finished connecting since `before`: it is live now and has a `lastCheckedAt` other than the one it had
 * then (a new connection needs one at all). A reconnected expired or revoked connection turns active before its discovery runs
 * but keeps its old `lastCheckedAt`, so it counts only once discovery has finished.
 */
export function connectionsChanged(before: Map<string, ConnectionMark>, after: Map<string, ConnectionMark>): boolean {
  for (const [id, now] of after) {
    if (!now.live || now.checkedAt === null) continue;
    if (before.get(id)?.checkedAt !== now.checkedAt) return true;
  }
  return false;
}

/**
 * Waits for the attempt in `popup` to end: the closing page's message, BroadcastChannel post, storage write or meta tag; a
 * finished connection in the polled list; the window closing; or the time limit. After "closed", the storage event and the
 * polling keep listening until the polling window ends, and a success they see then goes to `onLate`.
 */
export function watchPopup(popup: PopupLike, deps: WatchDeps, timeoutMs = FB_POPUP_TIMEOUT_MS, onLate?: (outcome: FbOutcome) => void): Promise<WatchResult> {
  return new Promise((resolve) => {
    let finished = false;
    let stopped = false;
    let channel: ChannelLike | null = null;
    let stopMessages: () => void = () => undefined;
    let stopStorage: () => void = () => undefined;
    let windowTimer: unknown = null;
    let connectionsTimer: unknown = null;
    let timer: unknown = null;
    let closeTimer: unknown = null;
    let pollingOver = !deps.connections;

    const stopPrimary = () => {
      stopMessages();
      if (windowTimer !== null) deps.clearInterval(windowTimer);
      if (timer !== null) deps.clearTimeout(timer);
      try {
        channel?.close();
      } catch {
        // Nothing to close.
      }
    };
    const stopAll = () => {
      if (stopped) return;
      stopped = true;
      stopPrimary();
      stopStorage();
      if (connectionsTimer !== null) deps.clearInterval(connectionsTimer);
    };
    const closePopup = () => {
      try {
        if (!popup.closed) popup.close();
      } catch {
        // Already gone.
      }
    };
    const clearStorage = () => {
      try {
        deps.clearStorage?.();
      } catch {
        // Storage blocked: nothing to clean.
      }
    };
    /**
     * The polling saw the connection finish while the callback's page may still be loading: close the window once it shows that
     * page (its meta tag is readable), or after FB_POPUP_CLOSE_AFTER_MS, whether or not the page's own script ran.
     */
    const closeSoon = () => {
      let waited = 0;
      closeTimer = deps.setInterval(() => {
        waited += FB_POLL_MS;
        let gone = true;
        try {
          gone = popup.closed;
        } catch {
          // Treated as gone.
        }
        if (gone || waited >= FB_POPUP_CLOSE_AFTER_MS || readPopupOutcome(popup) !== null) {
          deps.clearInterval(closeTimer);
          closeTimer = null;
          if (!gone) closePopup();
        }
      }, FB_POLL_MS);
    };
    /** The primary result once; after "closed", a late outcome goes to onLate. `closeSoon` closes the window a moment later. */
    const end = (r: WatchResult, opts: { closeSoon?: boolean } = {}) => {
      if (stopped) return;
      if (!finished) {
        finished = true;
        const lateWatch = r.kind === "closed" && onLate !== undefined && !pollingOver && (deps.onStorage !== undefined || deps.connections !== undefined);
        if (lateWatch) stopPrimary();
        else stopAll();
        if (r.kind === "outcome") clearStorage();
        if (r.kind !== "closed") {
          if (opts.closeSoon) closeSoon();
          else closePopup();
        }
        resolve(r);
        return;
      }
      if (r.kind === "outcome") {
        stopAll();
        clearStorage();
        onLate?.(r.outcome);
      }
    };

    stopMessages = deps.onMessage((e) => {
      if (e.origin !== deps.origin) return;
      const outcome = outcomeOf(e.data);
      if (outcome) end({ kind: "outcome", outcome });
    });
    try {
      channel = deps.channel?.(FB_POPUP.channel) ?? null;
      if (channel) {
        channel.onmessage = (e) => {
          const outcome = outcomeOf(e.data);
          if (outcome) end({ kind: "outcome", outcome });
        };
      }
    } catch {
      channel = null;
    }
    try {
      stopStorage =
        deps.onStorage?.((e) => {
          const outcome = outcomeFromStorage(e);
          if (outcome) end({ kind: "outcome", outcome });
        }) ?? (() => undefined);
    } catch {
      stopStorage = () => undefined;
    }

    // Connections polling: the first answer is the baseline; a finished connection after it means "connected".
    let baseline: Map<string, ConnectionMark> | null = null;
    let inflight: Promise<boolean> | null = null;
    const checkConnections = (): Promise<boolean> => {
      if (!deps.connections) return Promise.resolve(false);
      if (inflight) return inflight;
      inflight = (async () => {
        try {
          const mark = connectionsMark(await deps.connections!());
          if (mark === null) return false;
          if (baseline === null) {
            baseline = mark;
            return false;
          }
          return connectionsChanged(baseline, mark);
        } catch {
          return false;
        } finally {
          inflight = null;
        }
      })();
      return inflight;
    };
    if (deps.connections) {
      const maxPolls = Math.floor(FB_CONNECTIONS_POLL_FOR_MS / FB_CONNECTIONS_POLL_MS);
      let polls = 0;
      void checkConnections();
      connectionsTimer = deps.setInterval(() => {
        if (stopped) return;
        if (++polls > maxPolls) {
          pollingOver = true;
          deps.clearInterval(connectionsTimer);
          connectionsTimer = null;
          // A window that closed early has nothing left to wait for.
          if (finished) stopAll();
          return;
        }
        void checkConnections().then((done) => {
          if (done) end({ kind: "outcome", outcome: "connected" }, { closeSoon: true });
        });
      }, FB_CONNECTIONS_POLL_MS);
    }

    let closing = false;
    windowTimer = deps.setInterval(() => {
      if (finished || closing) return;
      const outcome = readPopupOutcome(popup);
      if (outcome) end({ kind: "outcome", outcome });
      else if (popup.closed) {
        if (!deps.connections || baseline === null) return end({ kind: "closed" });
        // One last look: the window may have closed itself right after connecting.
        closing = true;
        void checkConnections().then((done) => end(done ? { kind: "outcome", outcome: "connected" } : { kind: "closed" }));
      }
    }, FB_POLL_MS);
    timer = deps.setTimeout(() => end({ kind: "timeout" }), timeoutMs);
  });
}

function browserLaunchDeps(): LaunchDeps {
  return {
    open: (url, target, features) => window.open(url, target, features) as unknown as PopupLike | null,
    fetchStart: (popup) => apiFetch<{ url: string; popup?: boolean }>(popup ? `${FB_START_PATH}?popup=1` : FB_START_PATH, { method: "POST", body: popup ? { popup: 1 } : {} }),
    redirect: (url) => window.location.assign(url),
  };
}

function browserWatchDeps(): WatchDeps {
  return {
    origin: window.location.origin,
    onMessage(fn) {
      const listener = (e: MessageEvent) => fn({ origin: e.origin, data: e.data });
      window.addEventListener("message", listener);
      return () => window.removeEventListener("message", listener);
    },
    channel: (name) => (typeof BroadcastChannel === "function" ? (new BroadcastChannel(name) as unknown as ChannelLike) : null),
    onStorage(fn) {
      const listener = (e: StorageEvent) => {
        try {
          fn({ key: e.key, newValue: e.newValue });
        } catch {
          // A value we can't read is ignored.
        }
      };
      window.addEventListener("storage", listener);
      return () => window.removeEventListener("storage", listener);
    },
    clearStorage: () => {
      try {
        window.localStorage.removeItem(FB_POPUP.storage);
      } catch {
        // Storage blocked (private mode or a policy): nothing to clean.
      }
    },
    connections: () => apiFetch<unknown>(FB_CONNECTIONS_PATH),
    setInterval: (fn, ms) => window.setInterval(fn, ms),
    clearInterval: (h) => window.clearInterval(h as number),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (h) => window.clearTimeout(h as number),
  };
}

export type FbPopupPhase = "idle" | "opening" | "waiting" | "redirecting" | "done";
/** What the attempt ended with: Facebook's outcome, the window closed early, the time ran out, or the start failed. */
export type FbPopupResult = { kind: "outcome"; outcome: FbOutcome } | { kind: "closed" } | { kind: "timeout" } | { kind: "error"; message: string };

/**
 * React hook around launchFacebookLogin and watchPopup. `start` must be the click handler itself (or called synchronously
 * from it). `onResult` runs once per attempt, and once more when an attempt that ended "closed" turns out to have connected;
 * a new attempt while one is open focuses nothing and starts again.
 */
export function useFacebookLoginPopup(o: { onResult?: (r: FbPopupResult) => void; launchDeps?: () => LaunchDeps; watchDeps?: () => WatchDeps } = {}) {
  const [phase, setPhase] = useState<FbPopupPhase>("idle");
  const [result, setResult] = useState<FbPopupResult | null>(null);
  const attempt = useRef(0);
  const onResult = useRef(o.onResult);
  useEffect(() => {
    onResult.current = o.onResult;
  });
  const makeLaunch = o.launchDeps ?? browserLaunchDeps;
  const makeWatch = o.watchDeps ?? browserWatchDeps;

  const finish = useCallback((id: number, r: FbPopupResult) => {
    if (id !== attempt.current) return;
    setResult(r);
    setPhase("done");
    onResult.current?.(r);
  }, []);

  const start = useCallback(() => {
    const id = ++attempt.current;
    // Synchronous: the window opens here, inside the click.
    const { popup, started } = launchFacebookLogin(makeLaunch());
    setResult(null);
    setPhase(popup ? "opening" : "redirecting");
    void started.then((s) => {
      if (s.kind === "error") return finish(id, { kind: "error", message: s.message });
      if (s.kind === "redirected") {
        if (id === attempt.current) setPhase("redirecting");
        return;
      }
      if (!popup) return;
      if (id === attempt.current) setPhase("waiting");
      void watchPopup(popup, makeWatch(), FB_POPUP_TIMEOUT_MS, (outcome) => finish(id, { kind: "outcome", outcome })).then((w) => finish(id, w));
    });
  }, [finish, makeLaunch, makeWatch]);

  const reset = useCallback(() => {
    attempt.current++;
    setPhase("idle");
    setResult(null);
  }, []);

  return { start, reset, phase, result };
}
