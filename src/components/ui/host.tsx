"use client";

import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

type Host = { root: Root; el: HTMLElement };

const hosts = new Map<string, Host>();

/**
 * Mounts a detached React root once per key. Toasts and confirm dialogs use it so they work from any event handler
 * even when no provider is rendered. A provider that mounts later calls unmountHost to take over.
 */
export function mountHost(key: string, node: ReactNode): void {
  if (typeof document === "undefined" || hosts.has(key)) return;
  const el = document.createElement("div");
  el.setAttribute("data-ui-host", key);
  document.body.appendChild(el);
  const root = createRoot(el);
  hosts.set(key, { root, el });
  root.render(node);
}

export function unmountHost(key: string): void {
  const host = hosts.get(key);
  if (!host) return;
  hosts.delete(key);
  queueMicrotask(() => {
    host.root.unmount();
    host.el.remove();
  });
}

export const hasHost = (key: string) => hosts.has(key);
