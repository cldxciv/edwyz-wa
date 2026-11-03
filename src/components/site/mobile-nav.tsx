"use client";

import { useEffect, useState } from "react";
import { Icon } from "./icons";
import { NavLink } from "./nav-link";

type NavItem = { href: string; label: string };

export function MobileNav({ links }: { links: readonly NavItem[] }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="md:hidden">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="mobile-menu"
        aria-label={open ? "Close menu" : "Open menu"}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-11 w-11 items-center justify-center rounded-full border border-border hover:bg-surface"
      >
        <Icon name={open ? "close" : "menu"} />
      </button>
      {open && (
        <nav id="mobile-menu" aria-label="Mobile" className="absolute inset-x-0 top-full border-b border-border bg-background px-4 pb-4 pt-2 shadow-lg">
          <ul className="mx-auto flex max-w-6xl flex-col">
            {links.map((l) => (
              <li key={l.href}>
                <NavLink
                  href={l.href}
                  onClick={() => setOpen(false)}
                  className="block rounded-lg px-3 py-3 text-base font-medium hover:bg-surface"
                  currentClassName="bg-surface text-accent-ink"
                >
                  {l.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </div>
  );
}
