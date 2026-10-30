"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Role } from "@/generated/prisma/client";
import { cn } from "@/components/ui";
import { Icon } from "./Icon";
import { activeHref, mobileTabs } from "./nav";
import { useShell } from "./shell-context";
import { formatBadge } from "./useUnread";

const tabClass =
  "relative flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 px-1 py-1.5 text-[10px] font-medium leading-tight focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent";

/** Bottom tab bar for phones: the five main destinations plus a More button that opens the full menu. */
export function MobileTabBar({ role, drawerOpen }: { role: Role; drawerOpen: boolean }) {
  const pathname = usePathname();
  const { unread, openDrawer } = useShell();
  const tabs = mobileTabs(role);
  const current = activeHref(pathname, tabs);

  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-30 flex border-t border-border bg-background pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] md:hidden"
    >
      {tabs.map((tab) => {
        const active = current === tab.href;
        return (
          <Link key={tab.href} href={tab.href} aria-current={active ? "page" : undefined} className={cn(tabClass, active ? "text-accent" : "text-muted")}>
            <span className="relative">
              <Icon name={tab.icon ?? "grid"} className="h-6 w-6" />
              {tab.href === "/app/inbox" && unread > 0 && (
                <span className="absolute -right-2.5 -top-1.5 min-w-4 rounded-full bg-accent px-1 text-center text-[10px] font-semibold leading-4 text-white" aria-hidden="true">
                  {formatBadge(unread)}
                </span>
              )}
            </span>
            <span className="max-w-full truncate">{tab.label}</span>
            {tab.href === "/app/inbox" && unread > 0 && <span className="sr-only">{unread} unread</span>}
          </Link>
        );
      })}
      <button type="button" aria-haspopup="dialog" aria-expanded={drawerOpen} onClick={openDrawer} className={cn(tabClass, "text-muted")}>
        <Icon name="menu" className="h-6 w-6" />
        <span>More</span>
      </button>
    </nav>
  );
}
