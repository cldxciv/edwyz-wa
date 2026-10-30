export type ToastTone = "info" | "success" | "warning" | "error";

export type ToastAction = { label: string; onAction: () => void };

export type ToastInput = {
  title: string;
  description?: string;
  tone?: ToastTone;
  /** Milliseconds before auto-dismiss. 0 keeps the toast until the user closes it. */
  duration?: number;
  /** Showing a toast with the same key replaces the earlier one instead of stacking. */
  key?: string;
  action?: ToastAction;
  /** A loading toast never auto-dismisses until it is updated. */
  loading?: boolean;
};

export type ToastItem = {
  id: string;
  key?: string;
  tone: ToastTone;
  title: string;
  description?: string;
  duration: number;
  remaining: number;
  paused: boolean;
  loading: boolean;
  action?: ToastAction;
};

export type ToastState = { toasts: ToastItem[]; lastTick: number | null };

export type ToastEvent =
  | { type: "add"; id: string; input: ToastInput; now: number }
  | { type: "update"; id: string; patch: Partial<ToastInput>; now: number }
  | { type: "dismiss"; id: string }
  | { type: "clear" }
  | { type: "pause"; id: string }
  | { type: "resume"; id: string }
  | { type: "tick"; now: number };

export const MAX_TOASTS = 4;

export const DEFAULT_DURATION: Record<ToastTone, number> = { info: 5000, success: 4000, warning: 7000, error: 10000 };

export const initialToastState: ToastState = { toasts: [], lastTick: null };

function build(id: string, input: ToastInput): ToastItem {
  const tone = input.tone ?? "info";
  const loading = input.loading ?? false;
  const duration = loading ? 0 : input.duration ?? (input.action ? 0 : DEFAULT_DURATION[tone]);
  return { id, key: input.key, tone, title: input.title, description: input.description, duration, remaining: duration, paused: false, loading, action: input.action };
}

export function toastReducer(state: ToastState, event: ToastEvent): ToastState {
  switch (event.type) {
    case "add": {
      const next = build(event.id, event.input);
      const existing = next.key ? state.toasts.find((t) => t.key === next.key) : undefined;
      const toasts = existing
        ? state.toasts.map((t) => (t === existing ? { ...next, id: existing.id } : t))
        : [...state.toasts, next].slice(-MAX_TOASTS);
      return { toasts, lastTick: state.lastTick ?? event.now };
    }
    case "update": {
      return {
        toasts: state.toasts.map((t) => {
          if (t.id !== event.id) return t;
          const { title, tone, description, key, action } = t;
          return { ...build(t.id, { title, tone, description, key, action, ...event.patch }), paused: t.paused };
        }),
        lastTick: state.lastTick ?? event.now,
      };
    }
    case "dismiss": {
      const toasts = state.toasts.filter((t) => t.id !== event.id);
      return { toasts, lastTick: toasts.length ? state.lastTick : null };
    }
    case "clear":
      return initialToastState;
    case "pause":
    case "resume":
      return { ...state, toasts: state.toasts.map((t) => (t.id === event.id ? { ...t, paused: event.type === "pause" } : t)) };
    case "tick": {
      const elapsed = state.lastTick === null ? 0 : Math.max(0, event.now - state.lastTick);
      const toasts = state.toasts
        .map((t) => (t.duration > 0 && !t.paused ? { ...t, remaining: t.remaining - elapsed } : t))
        .filter((t) => t.duration === 0 || t.remaining > 0);
      return { toasts, lastTick: toasts.length ? event.now : null };
    }
  }
}

/** Errors interrupt screen readers; everything else waits for a pause. */
export const isAssertive = (t: Pick<ToastItem, "tone">) => t.tone === "error";
