"use client";

import { useEffect } from "react";

const RENEW_EVERY_MS = 10 * 60_000;

/** Renews the 15-minute sign-in in the background while the app is open, and returns to login only if renewal is refused. */
export function SessionKeepAlive() {
  useEffect(() => {
    let last = Date.now();
    const renew = async () => {
      try {
        const res = await fetch("/api/auth/refresh", { method: "POST", credentials: "same-origin" });
        if (res.status === 401) window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname)}`);
        else last = Date.now();
      } catch {
        // offline: try again on the next tick
      }
    };
    const timer = window.setInterval(renew, RENEW_EVERY_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible" && Date.now() - last > RENEW_EVERY_MS) void renew();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  return null;
}
