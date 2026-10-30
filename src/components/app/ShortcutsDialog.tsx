"use client";

import { useRef } from "react";
import type { Role } from "@/generated/prisma/client";
import { Icon } from "./Icon";
import { goShortcutsFor } from "./shortcuts";
import { useFocusTrap } from "./useFocusTrap";

function Row({ label, keys, joiner }: { label: string; keys: string[]; joiner?: string }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5 text-sm">
      <dt>{label}</dt>
      <dd className="flex shrink-0 items-center gap-1">
        {keys.map((k, i) => (
          <span key={i} className="flex items-center gap-1">
            {i > 0 && joiner && <span className="text-xs text-muted">{joiner}</span>}
            <kbd className="min-w-6 rounded border border-border bg-surface px-1.5 py-0.5 text-center text-xs font-medium">{k}</kbd>
          </span>
        ))}
      </dd>
    </div>
  );
}

export function ShortcutsDialog({ role, onClose }: { role: Role; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, true, onClose);
  const go = goShortcutsFor(role);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-3" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-title"
        tabIndex={-1}
        className="max-h-[calc(100dvh-1.5rem)] w-full max-w-md overflow-y-auto rounded-2xl border border-border bg-background p-5 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="shortcuts-title" className="text-lg font-semibold">
              Keyboard shortcuts
            </h2>
            <p className="mt-0.5 text-sm text-muted">Shortcuts pause while you are typing in a field.</p>
          </div>
          <button type="button" data-autofocus onClick={onClose} aria-label="Close shortcuts" className="-mr-2 -mt-1 inline-flex h-9 w-9 items-center justify-center rounded-full hover:bg-surface">
            <Icon name="close" className="h-5 w-5" />
          </button>
        </div>

        <h3 className="mt-4 text-xs font-semibold uppercase tracking-wider text-muted">Anywhere</h3>
        <dl className="mt-1 divide-y divide-border">
          <Row label="Search pages and actions" keys={["Ctrl", "K"]} joiner="+" />
          <Row label="Search (Mac)" keys={["Cmd", "K"]} joiner="+" />
          <Row label="Show this list" keys={["?"]} />
          <Row label="Close a window or menu" keys={["Esc"]} />
        </dl>

        <h3 className="mt-5 text-xs font-semibold uppercase tracking-wider text-muted">Go to (press G, then a key)</h3>
        <dl className="mt-1 divide-y divide-border">
          {go.map((s) => (
            <Row key={s.key} label={s.label.replace(/^Go to /, "")} keys={["G", s.key.toUpperCase()]} joiner="then" />
          ))}
        </dl>
      </div>
    </div>
  );
}
