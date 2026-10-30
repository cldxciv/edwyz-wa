"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/components/ui";

type State<T> = { data: T | null; dataKey: string | null; error: string | null; errorKey: string | null };

/**
 * GET helper that remembers which request its data belongs to, so a screen can tell fresh data from data
 * loaded for a previous month or tag choice. `stale` is true until the response for the current path arrives.
 */
export function useKeyedApi<T>(path: string) {
  const [state, setState] = useState<State<T>>({ data: null, dataKey: null, error: null, errorKey: null });
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  const retry = useCallback(() => {
    setState((s) => ({ ...s, error: null, errorKey: null }));
    setTick((n) => n + 1);
  }, []);

  useEffect(() => {
    let live = true;
    apiFetch<T>(path)
      .then((data) => live && setState({ data, dataKey: path, error: null, errorKey: null }))
      .catch((e: Error) => live && setState((s) => ({ ...s, error: e.message, errorKey: path })));
    return () => {
      live = false;
    };
  }, [path, tick]);

  const failed = state.errorKey === path;
  const fresh = state.dataKey === path;
  return {
    data: state.data,
    freshData: fresh ? state.data : null,
    error: failed ? state.error : null,
    stale: !fresh && !failed,
    reload,
    retry,
  };
}
