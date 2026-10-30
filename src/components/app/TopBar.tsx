"use client";

import type { Role } from "@/generated/prisma/client";
import { AvailabilityToggle } from "@/components/routing/AvailabilityToggle";
import { EddyLauncher } from "@/components/eddy/EddyLauncher";
import { HelpMenu } from "./HelpMenu";
import { Icon } from "./Icon";
import { Logo } from "./Sidebar";
import { useShell } from "./shell-context";
import { ThemeToggle } from "./ThemeToggle";
import { UserMenu } from "./UserMenu";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

type Props = { workspaceName: string; userName: string; email: string; role: Role };

export function TopBar({ workspaceName, userName, email, role }: Props) {
  const { openPalette } = useShell();
  return (
    <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-border bg-background/95 px-3 backdrop-blur md:h-16 md:px-6">
      <div className="mr-1 shrink-0 md:hidden">
        <Logo />
      </div>
      <div className="min-w-0 flex-1">
        <WorkspaceSwitcher currentName={workspaceName} />
      </div>
      <button
        type="button"
        onClick={openPalette}
        aria-label="Search or jump to (Ctrl K)"
        aria-keyshortcuts="Control+K Meta+K"
        className="inline-flex h-9 w-9 items-center justify-center rounded-full text-muted hover:bg-surface hover:text-foreground md:hidden"
      >
        <Icon name="search" className="h-5 w-5" />
      </button>
      {/* Eddy (docs/EDDY-SPEC.md 6.1): after search on phones, before Help on desktop. One is hidden per breakpoint. */}
      <EddyLauncher className="md:hidden" />
      <div className="hidden md:block">
        <AvailabilityToggle />
      </div>
      <div className="hidden md:block">
        <EddyLauncher />
      </div>
      <div className="hidden md:block">
        <HelpMenu />
      </div>
      <div className="hidden md:block">
        <ThemeToggle />
      </div>
      <UserMenu name={userName} email={email} role={role} />
    </header>
  );
}
