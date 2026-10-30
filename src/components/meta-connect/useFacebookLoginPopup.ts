/**
 * Facebook Login for Business in a popup (docs/EDDY-SPEC.md 6.15, 12.1a decision 11), so people stay in the app; the
 * full-page redirect stays as the fallback when the browser blocks popups.
 *
 * Browsers only let a page open a window synchronously from the click that asked for it: after an awaited fetch the click's
 * user activation can be gone and the window is silently blocked (the same reason components/connect/login.ts preloads
 * Embedded Signup). So `launchFacebookLogin` opens an empty window FIRST, inside the click handler and before anything is
 * awaited, then asks POST /api/meta-connect/start?popup=1 for Facebook's consent URL and sends the window there.
 * When the window could not open, it asks for a normal (non-popup) URL and moves the whole page there instead.
 *
 * The attempt ends on the callback's small page (src/app/api/meta-connect/callback/route.ts), which tells this page the
 * outcome by postMessage (checked against this site's origin and the message source) and on a BroadcastChannel, then
 * closes. Because a strict policy can stop that page's own script, the opener also reads the outcome from the page's meta tag
 * as soon as the window is back on this origin, and closes it itself. A window the person closes early ends as "closed".
 *
 * Only an outcome word ever crosses between the windows; never a code, a token or Meta's error text.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/components/ui";

/** The same values as CONNECT_POPUP in src/lib/meta-connect/service.ts (browser code cannot import that file). */
export const FB_POPUP = { source: "edwyz-meta-connect", channel: "edwyz-meta-connect", meta: "edwyz-meta-connect" } as const;
export const FB_POPUP_NAME = "edwyz-facebook-login";
export const FB_POPUP_FEATURES = "popup=yes,width=600,height=720";
export const FB_START_PATH = "/api/meta-connect/start";
/** The signed state is valid for 10 minutes on the server; after that the attempt cannot finish anyway. */
export const FB_POPUP_TIMEOUT_MS = 10 * 60_000;
export const FB_POLL_MS = 500;

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
  /** POST /api/meta-connect/start, with `popup` when the window opened. */
  fetchStart(popup: boolean): Promise<{ url: string }>;
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
      const { url } = await deps.fetchStart(opened !== null);
      if (!isFacebookDialogUrl(url)) throw new Error("Connecting is not available yet.");
      if (!opened) {
        deps.redirect(url);
        return { kind: "redirected" };
      }
      if (opened.closed) return { kind: "error", message: "closed" };
      opened.location.replace(url);
      return { kind: "opened" };
    } catch (e) {
      try {
        opened?.close();
      } catch {
        // Already gone.
      }
      return { kind: "error", message: e instanceof Error ? e.message : "Something went wrong." };
    }
  })();
  return { popup: opened, started };
}

export type WatchResult = { kind: "outcome"; outcome: FbOutcome } | { kind: "closed" } | { kind: "timeout" };

type MessageLike = { origin: string; data: unknown };
type ChannelLike = { onmessage: ((e: { data: unknown }) => void) | null; close(): void };

export type WatchDeps = {
  /** This page's origin: messages from anywhere else are ignored. */
  origin: string;
  onMessage(fn: (e: MessageLike) => void): () => void;
  /** A BroadcastChannel, when the browser has one. */
  channel?: (name: string) => ChannelLike | null;
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

/** The outcome the closing page shows in its meta tag, or null while the window is elsewhere (or on any other page). */
export function readPopupOutcome(popup: PopupLike): FbOutcome | null {
  try {
    const value = popup.document?.querySelector(`meta[name="${FB_POPUP.meta}"]`)?.getAttribute("content") ?? null;
    return isFbOutcome(value) ? value : null;
  } catch {
    return null; // Facebook's page: another origin, not readable.
  }
}

/** Waits for the attempt in `popup` to end: the closing page's message or meta tag, the window closing, or the time limit. */
export function watchPopup(popup: PopupLike, deps: WatchDeps, timeoutMs = FB_POPUP_TIMEOUT_MS): Promise<WatchResult> {
  return new Promise((resolve) => {
    let finished = false;
    let channel: ChannelLike | null = null;
    const close = () => {
      try {
        if (!popup.closed) popup.close();
      } catch {
        // Already gone.
      }
    };
    const end = (r: WatchResult) => {
      if (finished) return;
      finished = true;
      stopMessages();
      deps.clearInterval(poll);
      deps.clearTimeout(timer);
      try {
        channel?.close();
      } catch {
        // Nothing to close.
      }
      if (r.kind !== "closed") close();
      resolve(r);
    };
    const stopMessages = deps.onMessage((e) => {
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
    const poll = deps.setInterval(() => {
      const outcome = readPopupOutcome(popup);
      if (outcome) end({ kind: "outcome", outcome });
      else if (popup.closed) end({ kind: "closed" });
    }, FB_POLL_MS);
    const timer = deps.setTimeout(() => end({ kind: "timeout" }), timeoutMs);
  });
}

function browserLaunchDeps(): LaunchDeps {
  return {
    open: (url, target, features) => window.open(url, target, features) as unknown as PopupLike | null,
    fetchStart: (popup) => apiFetch<{ url: string }>(popup ? `${FB_START_PATH}?popup=1` : FB_START_PATH, { method: "POST", body: popup ? { popup: 1 } : {} }),
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
 * from it). `onResult` runs once per attempt; a new attempt while one is open focuses nothing and starts again.
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
      if (s.kind === "redirected" || !popup) return;
      if (id === attempt.current) setPhase("waiting");
      void watchPopup(popup, makeWatch()).then((w) => finish(id, w));
    });
  }, [finish, makeLaunch, makeWatch]);

  const reset = useCallback(() => {
    attempt.current++;
    setPhase("idle");
    setResult(null);
  }, []);

  return { start, reset, phase, result };
}
