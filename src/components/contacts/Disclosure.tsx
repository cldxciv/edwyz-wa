"use client";

import { useId, useState, type ReactNode } from "react";

/**
 * Show/hide section built on a real button instead of details/summary.
 * Buttons are part of the Dialog focus trap, so Tab and Shift+Tab work correctly inside dialogs.
 */
export function Disclosure({ title, children, defaultOpen = false }: { title: string; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();
  return (
    <div className="rounded-lg border border-border text-sm">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-10 w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left font-medium hover:bg-surface-2"
      >
        <span>{title}</span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden className={open ? "shrink-0 rotate-180" : "shrink-0"}>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      <div id={panelId} hidden={!open} className="px-3 pb-3">
        {open && children}
      </div>
    </div>
  );
}
