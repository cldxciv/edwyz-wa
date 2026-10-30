"use client";

import { useSyncExternalStore } from "react";

/** Phones, and small touch screens: there the canvas scrolls instead of dragging and zooming. Decided by the screen, not by the canvas width. */
export const COMPACT_QUERY = "(max-width: 639px), (pointer: coarse) and (max-width: 1023px)";

/** Same breakpoint as the `xl:` grid in the builder: from here the side panel sits beside the canvas. */
export const WIDE_QUERY = "(min-width: 1280px)";

export function matches(query: string): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;
}

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      if (typeof window.matchMedia !== "function") return () => {};
      const list = window.matchMedia(query);
      list.addEventListener("change", notify);
      return () => list.removeEventListener("change", notify);
    },
    () => matches(query),
    () => false,
  );
}
