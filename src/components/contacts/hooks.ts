"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/components/ui";

export type Role = "owner" | "admin" | "agent";

export const canManage = (role: Role | null) => role === "owner" || role === "admin";

/** Current member's role in the active workspace, or null while loading. */
export function useRole(): Role | null {
  const [role, setRole] = useState<Role | null>(null);
  useEffect(() => {
    apiFetch<{ role: Role }>("/api/auth/me")
      .then((r) => setRole(r.role))
      .catch(() => setRole("agent"));
  }, []);
  return role;
}

export type ApiState<T> = {
  data: T | null;
  error: string | null;
  loading: boolean;
  /** Silent refetch: keeps the current data and error on screen until the response arrives. */
  reload: () => void;
  /** Visible refetch for a Try again button: clears the error and shows the loading state right away. */
  retry: () => void;
};

/** GET helper with loading, error and retry. Optional silent polling that does not flip loading. */
export function useApi<T>(path: string | null, pollMs?: number): ApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  const retry = useCallback(() => {
    setError(null);
    setLoading(true);
    setTick((n) => n + 1);
  }, []);

  useEffect(() => {
    if (path === null) return;
    let live = true;
    apiFetch<T>(path)
      .then((d) => {
        if (!live) return;
        setData(d);
        setError(null);
      })
      .catch((e: Error) => live && setError(e.message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [path, tick]);

  useEffect(() => {
    if (!pollMs || path === null) return;
    const id = setInterval(reload, pollMs);
    return () => clearInterval(id);
  }, [pollMs, path, reload]);

  return { data, error, loading, reload, retry };
}
