import Link from "next/link";
import type { QuickAction } from "./helpers";

const ICONS: Record<string, string> = {
  inbox: "M4 13l2-7h12l2 7v5H4zM4 13h5a3 3 0 006 0h5",
  broadcast: "M3 11l18-7-6 17-3-7z",
  contacts: "M9 11a3 3 0 100-6 3 3 0 000 6zM3 19c0-3 2.5-5 6-5s6 2 6 5M17 8v6M14 11h6",
  template: "M6 3h9l4 4v14H6zM9 12h7M9 16h5",
  team: "M8 11a3 3 0 100-6 3 3 0 000 6zM2 19c0-3 2.5-5 6-5s6 2 6 5M16 6a3 3 0 010 6M18 14c2 .5 4 2 4 5",
  reports: "M4 20V4M4 20h16M8 16v-4M13 16V8M18 16v-6",
  connect: "M9 17H7a5 5 0 010-10h2M15 7h2a5 5 0 010 10h-2M8 12h8",
  templates: "M6 3h9l4 4v14H6zM9 12h7M9 16h5",
  leads: "M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z",
};

/**
 * Shortcuts to the jobs people do most. Each one says what it does in plain words.
 * `grid-cols-1` (minmax(0, 1fr)) lets a long hint truncate at 320 px instead of widening the page sideways.
 */
export function QuickActions({ actions }: { actions: QuickAction[] }) {
  return (
    <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {actions.map((a) => (
        <li key={a.id}>
          <Link href={a.href} className="flex h-full items-center gap-3 rounded-xl border border-border p-3 hover:bg-surface">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d={ICONS[a.id] ?? ICONS.inbox} />
              </svg>
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium">{a.label}</span>
              <span className="block truncate text-xs text-muted">{a.hint}</span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
