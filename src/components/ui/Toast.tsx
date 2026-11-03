"use client";

import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { cn } from "./cn";
import { hasHost, mountHost, unmountHost } from "./host";
import { isAssertive, initialToastState, toastReducer, type ToastEvent, type ToastInput, type ToastItem, type ToastState, type ToastTone } from "./toast-state";

let state: ToastState = initialToastState;
let seq = 0;
let providers = 0;
const listeners = new Set<() => void>();

function dispatch(event: ToastEvent) {
  state = toastReducer(state, event);
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

function show(input: ToastInput): string {
  if (providers === 0 && !hasHost("toast")) mountHost("toast", <ToastViewport />);
  const id = `toast-${++seq}`;
  dispatch({ type: "add", id, input, now: Date.now() });
  return id;
}

type Options = Omit<ToastInput, "title" | "tone">;
type Message<T> = string | ((value: T) => string);

export type ToastApi = {
  show: (input: ToastInput) => string;
  success: (title: string, options?: Options) => string;
  info: (title: string, options?: Options) => string;
  warning: (title: string, options?: Options) => string;
  error: (title: string, options?: Options) => string;
  update: (id: string, patch: Partial<ToastInput>) => void;
  dismiss: (id: string) => void;
  clear: () => void;
  /** Shows a loading toast, then turns it into a success or error toast when the promise settles. */
  promise: <T>(promise: Promise<T>, messages: { loading: string; success: Message<T>; error: Message<unknown> }) => Promise<T>;
};

const resolve = <T,>(m: Message<T>, value: T) => (typeof m === "function" ? m(value) : m);

export const toast: ToastApi = {
  show,
  success: (title, options) => show({ ...options, title, tone: "success" }),
  info: (title, options) => show({ ...options, title, tone: "info" }),
  warning: (title, options) => show({ ...options, title, tone: "warning" }),
  error: (title, options) => show({ ...options, title, tone: "error" }),
  update: (id, patch) => dispatch({ type: "update", id, patch, now: Date.now() }),
  dismiss: (id) => dispatch({ type: "dismiss", id }),
  clear: () => dispatch({ type: "clear" }),
  promise: async (promise, messages) => {
    const id = show({ title: messages.loading, loading: true });
    try {
      const value = await promise;
      toast.update(id, { title: resolve(messages.success, value), tone: "success", loading: false });
      return value;
    } catch (e) {
      toast.update(id, { title: resolve(messages.error, e), tone: "error", loading: false });
      throw e;
    }
  },
};

/** Stable toast API. Works in any client component; no provider is required, but ToastProvider is the declarative mount point. */
export function useToast(): ToastApi {
  return toast;
}

const TONE_STYLE: Record<ToastTone, string> = {
  info: "text-info",
  success: "text-good",
  warning: "text-warn",
  error: "text-bad",
};

function ToneIcon({ tone, loading }: { tone: ToastTone; loading: boolean }) {
  if (loading) return <span className="ui-spinner mt-0.5 h-4 w-4 shrink-0 rounded-full border-2 border-border-strong border-t-accent" aria-hidden />;
  const path =
    tone === "success"
      ? "M9 12l2 2 4-4M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18z"
      : tone === "error"
        ? "M15 9l-6 6M9 9l6 6M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18z"
        : tone === "warning"
          ? "M12 9v4M12 17h.01M10.3 3.9L2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"
          : "M12 16v-4M12 8h.01M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18z";
  return (
    <svg className={cn("mt-0.5 h-5 w-5 shrink-0", TONE_STYLE[tone])} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={path} />
    </svg>
  );
}

function ToastCard({ item }: { item: ToastItem }) {
  return (
    <li
      className="ui-toast-in pointer-events-auto flex items-start gap-3 rounded-pop border border-border bg-raised p-3 pr-2 text-sm text-foreground shadow-pop"
      onMouseEnter={() => dispatch({ type: "pause", id: item.id })}
      onMouseLeave={() => dispatch({ type: "resume", id: item.id })}
      onFocus={() => dispatch({ type: "pause", id: item.id })}
      onBlur={() => dispatch({ type: "resume", id: item.id })}
      onKeyDown={(e) => {
        if (e.key === "Escape") dispatch({ type: "dismiss", id: item.id });
      }}
    >
      <ToneIcon tone={item.tone} loading={item.loading} />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{item.title}</p>
        {item.description && <p className="mt-0.5 text-muted">{item.description}</p>}
        {item.action && (
          <button
            type="button"
            onClick={() => {
              item.action?.onAction();
              dispatch({ type: "dismiss", id: item.id });
            }}
            className="mt-1.5 rounded text-sm font-semibold text-accent-ink underline underline-offset-2 hover:no-underline"
          >
            {item.action.label}
          </button>
        )}
      </div>
      <button
        type="button"
        onClick={() => dispatch({ type: "dismiss", id: item.id })}
        aria-label="Dismiss notification"
        className="rounded-full p-1.5 text-muted hover:bg-surface-2 hover:text-foreground"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" aria-hidden>
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </li>
  );
}

function ToastViewport() {
  const { toasts } = useSyncExternalStore(subscribe, () => state, () => initialToastState);
  const active = toasts.length > 0;

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => dispatch({ type: "tick", now: Date.now() }), 250);
    return () => clearInterval(timer);
  }, [active]);

  const polite = toasts.filter((t) => !isAssertive(t));
  const assertive = toasts.filter(isAssertive);
  const list = "flex flex-col gap-2";

  return (
    // On phones the app's bottom tab bar (4.25rem) would sit under the toasts and could not be tapped, so they rise above it there.
    <section aria-label="Notifications" className="pointer-events-none fixed inset-x-4 bottom-4 z-(--z-toast) flex flex-col gap-2 sm:left-auto sm:right-4 sm:w-96 max-md:[body:has([data-mobile-tabbar])_&]:bottom-[calc(5.25rem+env(safe-area-inset-bottom))]">
      <div role="status" aria-live="polite" aria-relevant="additions text" className="empty:hidden">
        <ul className={list}>
          {polite.map((t) => (
            <ToastCard key={t.id} item={t} />
          ))}
        </ul>
      </div>
      <div role="alert" aria-live="assertive" className="empty:hidden">
        <ul className={list}>
          {assertive.map((t) => (
            <ToastCard key={t.id} item={t} />
          ))}
        </ul>
      </div>
    </section>
  );
}

/** Optional. Renders the notification region inside your React tree instead of the lazily created one. */
export function ToastProvider({ children }: { children?: ReactNode }) {
  useEffect(() => {
    providers++;
    unmountHost("toast");
    return () => void providers--;
  }, []);
  return (
    <>
      {children}
      <ToastViewport />
    </>
  );
}
