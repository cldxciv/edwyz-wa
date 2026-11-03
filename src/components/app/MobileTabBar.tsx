"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useId } from "react";
import type { Role } from "@/generated/prisma/client";
import { cn } from "@/components/ui";
import { Icon } from "./Icon";
import { activeHref, mobileTabs, moreIsCurrent } from "./nav";
import { useShell } from "./shell-context";
import { formatBadge } from "./useUnread";

// Six tabs share the width, and "Automation" at 10 px needs about 56 px: a tab of 64 px (a 384 px screen) with its padding.
// Narrower phones (360 and 375 px are common) get tighter letters and less padding, and below 352 px a 9 px face, instead of
// a cut-off label. Measured with system-ui, Roboto and Arial.
const tabClass =
  "relative flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 px-1 py-1.5 text-[10px] font-medium leading-tight max-[383px]:px-0.5 max-[383px]:tracking-tight max-[351px]:text-[9px] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent";

/** Bottom tab bar for phones: the five main destinations plus a More button that opens the full menu. */
export function MobileTabBar({ role, drawerOpen }: { role: Role; drawerOpen: boolean }) {
  const pathname = usePathname();
  const { unread, openDrawer } = useShell();
  const tabs = mobileTabs(role);
  const current = activeHref(pathname, tabs);
  const inMore = moreIsCurrent(pathname, role);
  const moreHint = useId();

  return (
    <nav
      aria-label="Main"
      data-mobile-tabbar
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
      {/* A description, not part of the name: the button stays "More" for voice control and every page's tests. */}
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={drawerOpen}
        aria-describedby={inMore ? moreHint : undefined}
        onClick={openDrawer}
        className={cn(tabClass, inMore ? "text-accent" : "text-muted")}
      >
        <Icon name="menu" className="h-6 w-6" />
        <span>More</span>
      </button>
      {inMore && (
        <span id={moreHint} hidden>
          The current page is in this menu
        </span>
      )}
    </nav>
  );
}
