"use client";

import { useEffect } from "react";
import { SERVICE_WORKER_PATH } from "@/lib/pwa";

/** Production builds only. next dev and the test runners never run a worker that could answer with an outdated offline page. */
export function serviceWorkerEnabled(nodeEnv: string | undefined = process.env.NODE_ENV): boolean {
  return nodeEnv === "production";
}

/**
 * Registers public/sw.js (offline page only, docs/PLAY-STORE.md) after the page has loaded, so it never competes with the first
 * paint. Outside production it removes a worker left behind by an earlier production run on the same address (localhost:3500).
 * Renders nothing; mounted once from the root layout.
 */
export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const workers = navigator.serviceWorker;
    if (!serviceWorkerEnabled()) {
      void workers
        .getRegistrations()
        .then((registrations) => registrations.filter((r) => r.active?.scriptURL.endsWith(SERVICE_WORKER_PATH)).forEach((r) => void r.unregister()))
        .catch(() => undefined);
      return;
    }
    const register = () => void workers.register(SERVICE_WORKER_PATH, { scope: "/", updateViaCache: "none" }).catch(() => undefined);
    if (document.readyState === "complete") {
      register();
      return;
    }
    window.addEventListener("load", register, { once: true });
    return () => window.removeEventListener("load", register);
  }, []);
  return null;
}
