"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/components/ui";
import { UNREAD_REFRESH_EVENT, unreadCountFrom } from "@/components/inbox/ux";

const POLL_MS = 30_000;

/**
 * Conversations with unread messages, from the inbox list API. Pauses while the tab is hidden. Other screens may dispatch
 * `wa:unread-refresh` to update it at once; when the event carries the count (the inbox list just received it) no request is made.
 */
export function useUnread(): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let live = true;
    const load = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const data = await apiFetch<{ unreadConversations?: number }>("/api/inbox/conversations?limit=1");
        if (live && typeof data.unreadConversations === "number") setCount(data.unreadConversations);
      } catch {
        // keep the last known count
      }
    };
    const onRefresh = (e: Event) => {
      const known = unreadCountFrom(e);
      if (known !== null) setCount(known);
      else void load();
    };
    void load();
    const timer = window.setInterval(load, POLL_MS);
    document.addEventListener("visibilitychange", load);
    window.addEventListener(UNREAD_REFRESH_EVENT, onRefresh);
    return () => {
      live = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
      window.removeEventListener(UNREAD_REFRESH_EVENT, onRefresh);
    };
  }, []);

  return count;
}

export const formatBadge = (n: number) => (n > 99 ? "99+" : String(n));
