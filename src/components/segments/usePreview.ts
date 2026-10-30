"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/components/ui";
import type { Preview } from "./helpers";

type State = { key: string | null; preview: Preview | null; error: string | null };

/**
 * Debounced POST that answers "who does this reach?". `body` null means nothing to ask yet. `pending` is true from the moment
 * the inputs change until the answer for them arrives, so the screen never shows a count that belongs to older inputs.
 */
export function usePreview(url: string, body: Record<string, unknown> | null, delayMs = 400) {
  const key = body === null ? null : JSON.stringify(body);
  const [state, setState] = useState<State>({ key: null, preview: null, error: null });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (key === null) return;
    let live = true;
    const id = setTimeout(() => {
      apiFetch<Preview>(url, { method: "POST", body: JSON.parse(key) })
        .then((preview) => live && setState({ key, preview, error: null }))
        .catch((e: Error) => live && setState({ key, preview: null, error: e.message }));
    }, delayMs);
    return () => {
      live = false;
      clearTimeout(id);
    };
  }, [key, url, delayMs, tick]);

  const settled = state.key === key;
  return {
    preview: settled ? state.preview : null,
    error: settled ? state.error : null,
    pending: key !== null && !settled,
    retry: () => setTick((n) => n + 1),
  };
}
