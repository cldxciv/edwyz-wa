"use client";

import { useEffect, useState } from "react";

/** The zone the browser reports, or UTC when it cannot say. The server may map an old name (Asia/Calcutta) to its current one. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * The browser's time zone, known only after mount. The server cannot know it, so reading it during render would make the
 * first client render differ from the server HTML (React hydration error #418). Null until it is known.
 */
export function useBrowserTimeZone(): string | null {
  const [tz, setTz] = useState<string | null>(null);
  useEffect(() => {
    setTz(browserTimeZone());
  }, []);
  return tz;
}
