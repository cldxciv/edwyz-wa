"use client";

import { useEffect } from "react";

const RENEW_EVERY_MS = 10 * 60_000;
/** A renewal by any tab this recent leaves nothing to do: the cookies are shared, so every tab already has the fresh sign-in. */
export const FRESH_MS = 2 * 60_000;
const LOCK_NAME = "wa-session-renew";
const STAMP_KEY = "wa-session-renewed-at";

export type RenewDeps = {
  /** POST /api/auth/refresh; resolves with the HTTP status, rejects when offline. */
  refresh: () => Promise<number>;
  /** Runs `fn` while holding a lock shared by every tab (navigator.locks), or directly where the browser has none. */
  withLock: (fn: () => Promise<void>) => Promise<void>;
  /** When any tab last renewed (ms), shared through localStorage; 0 when unknown. */
  lastRenewed: () => number;
  markRenewed: (at: number) => void;
  onSignedOut: () => void;
  now?: () => number;
};

/**
 * One renewal at a time, in this tab and across tabs. Calls made while one is running share it, and a tab that waited for another
 * tab's renewal finds it fresh and does nothing. Two refreshes with the same token at once used to look like a stolen token and sign
 * the person out on every device; the server now forgives that within a minute, and this keeps it from happening at all.
 */
export function createRenewer(deps: RenewDeps): () => Promise<void> {
  const now = deps.now ?? Date.now;
  let inFlight: Promise<void> | null = null;
  const run = async () => {
    if (now() - deps.lastRenewed() < FRESH_MS) return;
    try {
      const status = await deps.refresh();
      if (status === 401) deps.onSignedOut();
      else if (status >= 200 && status < 300) deps.markRenewed(now());
    } catch {
      // offline: try again on the next tick
    }
  };
  return () => {
    inFlight ??= deps.withLock(run).finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}

function readStamp(): number {
  try {
    return Number(window.localStorage.getItem(STAMP_KEY)) || 0;
  } catch {
    return 0;
  }
}

function writeStamp(at: number): void {
  try {
    window.localStorage.setItem(STAMP_KEY, String(at));
  } catch {
    // storage blocked (private window): the in-tab single flight and the server's grace still apply
  }
}

function withBrowserLock(fn: () => Promise<void>): Promise<void> {
  // Older browsers and insecure origins have no Web Locks; the in-tab single flight and the server's grace still apply there.
  const locks = (navigator as Partial<Pick<Navigator, "locks">>).locks;
  return locks ? locks.request(LOCK_NAME, () => fn()).then(() => undefined) : fn();
}

/** Renews the 15-minute sign-in in the background while the app is open, and returns to login only if renewal is refused. */
export function SessionKeepAlive() {
  useEffect(() => {
    const renew = createRenewer({
      refresh: () => fetch("/api/auth/refresh", { method: "POST", credentials: "same-origin" }).then((res) => res.status),
      withLock: withBrowserLock,
      lastRenewed: readStamp,
      markRenewed: writeStamp,
      onSignedOut: () => window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname)}`),
    });
    // The page load itself carries a fresh sign-in (the layout renewed it if needed), so the first renewal is due one period from now.
    const mountedAt = Date.now();
    const due = () => Date.now() - Math.max(readStamp(), mountedAt) > RENEW_EVERY_MS;
    const timer = window.setInterval(() => void renew(), RENEW_EVERY_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible" && due()) void renew();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  return null;
}
