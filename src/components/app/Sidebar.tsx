"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Role } from "@/generated/prisma/client";
import { Icon } from "./Icon";
import { NavSections } from "./NavSections";
import { useShell } from "./shell-context";

export function Logo() {
  return (
    <Link href="/app" className="rounded-md text-lg font-semibold tracking-tight">
      Edwyz <span className="text-accent">WA</span>
    </Link>
  );
}

/** Desktop navigation rail (md and up). On smaller screens the tab bar and drawer take over. */
export function Sidebar({ role }: { role: Role }) {
  const pathname = usePathname();
  const { unread, openPalette } = useShell();

  return (
    <aside className="hidden border-r border-border bg-background md:sticky md:top-0 md:flex md:h-screen md:w-64 md:shrink-0 md:flex-col">
      <div className="flex h-16 shrink-0 items-center px-5">
        <Logo />
      </div>
      <div className="px-3 pb-2">
        <button
          type="button"
          onClick={openPalette}
          className="flex w-full items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-muted hover:text-foreground"
        >
          <Icon name="search" className="h-4 w-4" />
          <span className="flex-1 text-left">Search or jump to</span>
          <kbd className="rounded border border-border bg-background px-1.5 py-0.5 text-[10px] font-medium">Ctrl K</kbd>
        </button>
      </div>
      <nav id="app-nav" aria-label="Workspace" className="min-h-0 flex-1 overflow-y-auto px-3 pb-6">
        <NavSections role={role} pathname={pathname} unread={unread} />
      </nav>
    </aside>
  );
}
