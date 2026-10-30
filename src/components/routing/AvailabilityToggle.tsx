"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch, cn, toast } from "@/components/ui";

type Agents = { agents: { userId: string; available: boolean }[]; me: string };

const CHANGED = "wa:availability-changed";

/** Tells every switch and list on the page that someone's availability changed, so none keeps showing the old state. */
export const announceAvailability = () => window.dispatchEvent(new Event(CHANGED));

/** Runs `fn` whenever availability changes anywhere on the page. */
export function useAvailabilityChanged(fn: () => void) {
  useEffect(() => {
    window.addEventListener(CHANGED, fn);
    return () => window.removeEventListener(CHANGED, fn);
  }, [fn]);
}

/**
 * Lets the signed-in member mark themselves available or away for automatic chat assignment. Safe to embed anywhere in the app.
 * The name stays "Available for new chats" and aria-checked carries the state, so a screen reader says "on" or "off", never a double negative.
 * The switch uses aria-disabled while it works, so keyboard focus stays on it.
 */
export function AvailabilityToggle({ className }: { className?: string }) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    apiFetch<Agents>("/api/routing/agents")
      .then((d) => {
        if (!live) return;
        setAvailable(d.agents.find((a) => a.userId === d.me)?.available ?? true);
        setLoadFailed(false);
      })
      .catch(() => live && setLoadFailed(true));
    return () => {
      live = false;
    };
  }, [attempt]);

  const retry = useCallback(() => {
    setLoadFailed(false);
    setAttempt((n) => n + 1);
  }, []);
  useAvailabilityChanged(useCallback(() => setAttempt((n) => n + 1), []));

  async function toggle() {
    if (available === null || busy) return;
    const next = !available;
    setBusy(true);
    try {
      await apiFetch("/api/routing/availability", { method: "PUT", body: { available: next } });
      setAvailable(next);
      announceAvailability();
      toast.success(next ? "You are available for new chats" : "You are away. New chats will go to others", { key: "availability" });
    } catch (e) {
      toast.error("We could not update your availability", { description: e instanceof Error ? e.message : "Please try again.", key: "availability" });
    } finally {
      setBusy(false);
    }
  }

  const unavailable = available === null;
  const state = loadFailed ? "Unavailable" : unavailable ? "Loading" : available ? "On" : "Off";

  return (
    <div className={cn("inline-flex flex-wrap items-center gap-2", className)}>
      <button
        type="button"
        role="switch"
        aria-checked={available === true}
        aria-disabled={unavailable || busy || undefined}
        aria-busy={busy || undefined}
        onClick={() => void toggle()}
        className="inline-flex min-h-10 items-center gap-2 rounded-full border border-border-strong bg-raised px-3 text-xs font-semibold text-foreground transition-colors duration-(--dur-fast) hover:bg-surface-2 aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
      >
        <span className={cn("h-2.5 w-2.5 shrink-0 rounded-full", available ? "bg-good" : "border-2 border-muted bg-transparent")} aria-hidden />
        Available for new chats
        <span aria-hidden className="font-normal text-muted">
          {state}
        </span>
      </button>
      {loadFailed && (
        <span role="alert" className="inline-flex items-center gap-1 text-xs text-bad-fg">
          We could not load your status.
          <button type="button" onClick={retry} className="min-h-8 rounded-full px-2 font-semibold underline">
            Try again
          </button>
        </span>
      )}
    </div>
  );
}
