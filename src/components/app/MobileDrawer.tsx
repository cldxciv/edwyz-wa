"use client";

import { usePathname } from "next/navigation";
import { useRef } from "react";
import type { Role } from "@/generated/prisma/client";
import { AvailabilityToggle } from "@/components/routing/AvailabilityToggle";
import { COMPANY } from "@/lib/config";
import { SUPPORT_MAILTO } from "./HelpMenu";
import { Icon } from "./Icon";
import { NavSections } from "./NavSections";
import { useShell } from "./shell-context";
import { ThemeToggle } from "./ThemeToggle";
import { useFocusTrap } from "./useFocusTrap";

const rowClass =
  "flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left text-sm font-medium hover:bg-surface focus-visible:outline-2 focus-visible:outline-accent";

/** Full-screen menu for phones: every page, grouped, plus availability, theme, help and sign out. */
export function MobileDrawer({ role, open, onClose }: { role: Role; open: boolean; onClose: () => void }) {
  const pathname = usePathname();
  const ref = useRef<HTMLDivElement>(null);
  const { unread, openPalette, signOut, openEddy } = useShell();
  useFocusTrap(ref, open, onClose);

  if (!open) return null;

  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label="Menu"
      tabIndex={-1}
      className="fixed inset-0 z-50 flex flex-col bg-background pt-[env(safe-area-inset-top)] md:hidden"
    >
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
        <span className="text-lg font-semibold tracking-tight">
          Edwyz <span className="text-accent">WA</span>
        </span>
        <button
          type="button"
          data-autofocus
          onClick={onClose}
          aria-label="Close menu"
          className="inline-flex h-10 w-10 items-center justify-center rounded-full hover:bg-surface"
        >
          <Icon name="close" className="h-6 w-6" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))]">
        <button
          type="button"
          onClick={() => {
            onClose();
            window.setTimeout(openPalette, 0);
          }}
          className="mt-4 flex w-full items-center gap-2 rounded-lg border border-border bg-surface px-3 py-3 text-sm text-muted"
        >
          <Icon name="search" className="h-4 w-4" />
          Search or jump to
        </button>
        {/* Eddy, the in-app AI helper (docs/EDDY-SPEC.md 6.1). */}
        <button
          type="button"
          onClick={() => {
            onClose();
            window.setTimeout(() => openEddy(), 0);
          }}
          className={rowClass + " mt-2"}
          data-drawer-ask-eddy
        >
          <Icon name="sparkles" className="h-[18px] w-[18px] text-accent" />
          Ask Eddy
          <span className="ml-auto truncate text-xs font-normal text-muted">The AI helper</span>
        </button>

        <nav aria-label="All pages" className="mt-3">
          <NavSections role={role} pathname={pathname} unread={unread} collapsible={false} onNavigate={onClose} />
        </nav>

        <div className="mt-6 space-y-1 border-t border-border pt-4">
          <h2 className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted">You</h2>
          <div className="flex items-center justify-between gap-3 px-3 py-2">
            <AvailabilityToggle />
            <span className="flex items-center gap-1 text-sm text-muted">
              Theme <ThemeToggle />
            </span>
          </div>
          <a href="/docs" target="_blank" rel="noopener noreferrer" className={rowClass}>
            <Icon name="book" className="h-[18px] w-[18px] text-muted" />
            Help and docs
          </a>
          <a href={SUPPORT_MAILTO} className={rowClass}>
            <Icon name="mail" className="h-[18px] w-[18px] text-muted" />
            Email support
            <span className="ml-auto truncate text-xs font-normal text-muted">{COMPANY.email}</span>
          </a>
          <button type="button" onClick={() => void signOut()} className={rowClass}>
            <Icon name="logout" className="h-[18px] w-[18px] text-muted" />
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
