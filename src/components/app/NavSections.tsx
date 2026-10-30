"use client";

import Link from "next/link";
import { useEffect, useSyncExternalStore } from "react";
import type { Role } from "@/generated/prisma/client";
import { cn } from "@/components/ui";
import { Icon } from "./Icon";
import { activeHref, activeSection, groupNav, HOME_ITEM, navFor, type NavItem, type SectionId } from "./nav";
import { readStoredList, writeStored } from "./storage";
import { formatBadge } from "./useUnread";

const KEY = "wa-nav-collapsed";
const EVENT = "wa:nav-collapsed";

function subscribe(onChange: () => void) {
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

const snapshot = () => JSON.stringify(readStoredList(KEY));

function useCollapsed() {
  const raw = useSyncExternalStore(subscribe, snapshot, () => "[]");
  const collapsed = JSON.parse(raw) as string[];
  const set = (next: string[]) => {
    writeStored(KEY, JSON.stringify(next));
    window.dispatchEvent(new Event(EVENT));
  };
  return { collapsed, set };
}

const linkBase =
  "group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-foreground hover:bg-surface focus-visible:outline-2 focus-visible:outline-accent";

function NavLink({ item, active, unread, onNavigate }: { item: NavItem; active: boolean; unread: number; onNavigate?: () => void }) {
  const showBadge = item.href === "/app/inbox" && unread > 0;
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(linkBase, active && "bg-surface text-accent shadow-[inset_2px_0_0_var(--accent)]")}
    >
      <Icon name={item.icon ?? "grid"} className={cn("h-[18px] w-[18px]", active ? "text-accent" : "text-muted group-hover:text-foreground")} />
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {showBadge && (
        <span className="rounded-full bg-accent px-1.5 py-0.5 text-[11px] font-semibold leading-none text-white" aria-hidden="true">
          {formatBadge(unread)}
        </span>
      )}
      {showBadge && <span className="sr-only">{unread} unread conversations</span>}
    </Link>
  );
}

type Props = {
  role: Role;
  pathname: string;
  unread: number;
  /** Mobile drawer shows every section open with no collapse control. */
  collapsible?: boolean;
  onNavigate?: () => void;
};

export function NavSections({ role, pathname, unread, collapsible = true, onNavigate }: Props) {
  const { collapsed, set } = useCollapsed();
  const items = navFor(role);
  const current = activeHref(pathname, [HOME_ITEM, ...items]);
  const currentSection = activeSection(pathname, role);

  useEffect(() => {
    if (!collapsible || !currentSection) return;
    const stored = readStoredList(KEY);
    if (stored.includes(currentSection)) {
      writeStored(KEY, JSON.stringify(stored.filter((id) => id !== currentSection)));
      window.dispatchEvent(new Event(EVENT));
    }
  }, [pathname, currentSection, collapsible]);

  function toggle(id: SectionId) {
    set(collapsed.includes(id) ? collapsed.filter((c) => c !== id) : [...collapsed, id]);
  }

  return (
    <div className="space-y-1">
      <NavLink item={HOME_ITEM} active={current === HOME_ITEM.href} unread={0} onNavigate={onNavigate} />
      {groupNav(role).map((group) => {
        const open = !collapsible || !collapsed.includes(group.id);
        const listId = `nav-section-${group.id}`;
        return (
          <section key={group.id} aria-labelledby={`${listId}-label`} className="pt-3">
            {collapsible ? (
              <button
                type="button"
                aria-expanded={open}
                aria-controls={listId}
                onClick={() => toggle(group.id)}
                className="flex w-full items-center justify-between rounded-lg px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-accent"
              >
                <span id={`${listId}-label`}>{group.label}</span>
                {!open && group.id === "conversations" && unread > 0 && (
                  <span className="ml-auto mr-2 rounded-full bg-accent px-1.5 py-0.5 text-[11px] leading-none text-white">{formatBadge(unread)}</span>
                )}
                <Icon name="chevron-down" className={cn("h-4 w-4 transition-transform", !open && "-rotate-90")} />
              </button>
            ) : (
              <h2 id={`${listId}-label`} className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted">
                {group.label}
              </h2>
            )}
            <ul id={listId} hidden={!open} className="mt-0.5 space-y-0.5">
              {group.items.map((item) => (
                <li key={item.href}>
                  <NavLink item={item} active={current === item.href} unread={unread} onNavigate={onNavigate} />
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
