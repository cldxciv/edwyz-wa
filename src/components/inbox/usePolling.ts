"use client";
import { useEffect, useRef } from "react";

/**
 * How long to wait before the next poll when polling (re)starts. The first start fetches at once. When only the interval changed
 * (the live stream opened or dropped), the time already waited counts, so a fetch that just happened is not repeated.
 */
export function nextPollDelay(lastRunAt: number | null, intervalMs: number, now: number): number {
  if (lastRunAt === null) return 0;
  return Math.max(0, Math.min(intervalMs, lastRunAt + intervalMs - now));
}

/** Calls fn immediately and then every intervalMs, only while the tab is visible. Stops on unmount or when disabled. */
export function usePolling(fn: () => Promise<void> | void, intervalMs: number, enabled = true) {
  const ref = useRef(fn);
  const lastRun = useRef<number | null>(null);
  useEffect(() => {
    ref.current = fn;
  });

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;

    const run = async () => {
      if (document.visibilityState === "visible") {
        lastRun.current = Date.now();
        await Promise.resolve(ref.current()).catch(() => undefined);
      }
      if (!cancelled) timer = setTimeout(run, intervalMs);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible" && !cancelled) {
        clearTimeout(timer);
        void run();
      }
    };
    const wait = nextPollDelay(lastRun.current, intervalMs, Date.now());
    if (wait === 0) void run();
    else timer = setTimeout(run, wait);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [intervalMs, enabled]);
}
