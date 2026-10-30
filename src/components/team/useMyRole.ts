"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/components/ui";
import type { Role } from "./helpers";

export type MyRole = {
  /** The signed-in member's role, or null while loading or after a failed request. */
  role: Role | null;
  /** True when the role could not be loaded. Never treat this as "no permission". */
  error: boolean;
  retry: () => void;
};

/** Like useRole, but a failed request is reported as an error instead of being mistaken for the lowest role. */
export function useMyRole(): MyRole {
  const [state, setState] = useState<{ role: Role | null; error: boolean }>({ role: null, error: false });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    apiFetch<{ role: Role }>("/api/auth/me")
      .then((r) => live && setState({ role: r.role, error: false }))
      .catch(() => live && setState({ role: null, error: true }));
    return () => {
      live = false;
    };
  }, [tick]);

  const retry = useCallback(() => {
    setState({ role: null, error: false });
    setTick((n) => n + 1);
  }, []);

  return { ...state, retry };
}
