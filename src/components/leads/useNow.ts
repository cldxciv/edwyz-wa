"use client";

import { useEffect, useState } from "react";

/** Current time in ms, refreshed on an interval so "waiting 12 min" labels stay true without a reload. */
export function useNow(everyMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}
