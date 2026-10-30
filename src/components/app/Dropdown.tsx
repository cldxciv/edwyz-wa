"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { cn } from "@/components/ui";
import { Icon } from "./Icon";
import type { IconName } from "./nav";

export type DropdownItem =
  | { separator: true }
  | {
      label: string;
      description?: string;
      icon?: IconName;
      href?: string;
      external?: boolean;
      onSelect?: () => void;
      checked?: boolean;
      danger?: boolean;
    };

type Props = {
  /** Accessible name for the menu popup. */
  label: string;
  /** Accessible name for the button when it differs from the menu's, e.g. to contain the button's visible text (WCAG 2.5.3). */
  triggerLabel?: string;
  trigger: ReactNode;
  items: DropdownItem[];
  header?: ReactNode;
  align?: "left" | "right";
  className?: string;
  triggerClassName?: string;
  onOpen?: () => void;
};

const itemClass =
  "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm hover:bg-surface focus-visible:bg-surface focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent";

/** Menu button with a keyboard-operable popup: arrows, Home/End, Escape, and focus returns to the button. */
export function Dropdown({ label, triggerLabel, trigger, items, header, align = "right", className, triggerClassName, onOpen }: Props) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const itemsKey = items.map((item) => ("separator" in item ? "-" : item.label)).join("|");

  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLElement>('[role="menuitem"], [role="menuitemradio"]')?.focus();
    const onPointer = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    // Focus can be lost to the page (see below), so Escape is also heard here, not only on the menu.
    const onEscape = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onEscape);
    };
  }, [open]);

  // When the items are swapped while open (for example "Loading..." replaced by the real list), the focused one is unmounted: refocus the menu.
  useEffect(() => {
    if (!open || root.current?.querySelector('[role="menu"]')?.contains(document.activeElement)) return;
    root.current?.querySelector<HTMLElement>('[role="menuitem"], [role="menuitemradio"]')?.focus();
  }, [open, itemsKey]);

  function toggle() {
    if (!open) onOpen?.();
    setOpen((v) => !v);
  }

  function onMenuKey(e: React.KeyboardEvent) {
    const entries = Array.from(root.current?.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"]') ?? []);
    const at = entries.indexOf(document.activeElement as HTMLElement);
    const move = (i: number) => {
      e.preventDefault();
      entries[(i + entries.length) % entries.length]?.focus();
    };
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      button.current?.focus();
    } else if (e.key === "ArrowDown") move(at + 1);
    else if (e.key === "ArrowUp") move(at - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(entries.length - 1);
    else if (e.key === "Tab") setOpen(false);
  }

  return (
    <div ref={root} className={cn("relative", className)}>
      <button
        ref={button}
        type="button"
        aria-label={triggerLabel ?? label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={toggle}
        // A trigger with its own colours (the account initials on bg-accent) must not pick up the light hover surface: white text on it fails contrast.
        className={cn("inline-flex items-center gap-2 rounded-full", triggerClassName ?? "hover:bg-surface")}
      >
        {trigger}
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label={label}
          onKeyDown={onMenuKey}
          className={cn(
            "absolute top-full z-50 mt-2 w-72 max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-background p-1.5 shadow-lg",
            align === "right" ? "right-0" : "left-0",
          )}
        >
          {header && <div className="border-b border-border px-3 pb-2 pt-1.5 mb-1.5">{header}</div>}
          {items.map((item, i) => {
            if ("separator" in item) return <div key={`sep-${i}`} role="separator" className="my-1 h-px bg-border" />;
            const content = (
              <>
                {item.icon && <Icon name={item.icon} className="h-4 w-4 text-muted" />}
                <span className="min-w-0 flex-1">
                  <span className={cn("block truncate", item.danger && "text-red-600")}>{item.label}</span>
                  {item.description && <span className="block truncate text-xs text-muted">{item.description}</span>}
                </span>
                {item.checked && <Icon name="check" className="h-4 w-4 text-accent" />}
              </>
            );
            const close = () => {
              setOpen(false);
              item.onSelect?.();
            };
            if (item.href && item.external) {
              return (
                <a key={item.label} role="menuitem" href={item.href} target={item.href.startsWith("mailto:") ? undefined : "_blank"} rel="noopener noreferrer" onClick={() => setOpen(false)} className={itemClass}>
                  {content}
                </a>
              );
            }
            if (item.href) {
              return (
                <Link key={item.label} role="menuitem" href={item.href} onClick={() => setOpen(false)} className={itemClass}>
                  {content}
                </Link>
              );
            }
            return (
              <button key={item.label} type="button" role={item.checked !== undefined ? "menuitemradio" : "menuitem"} aria-checked={item.checked} onClick={close} className={itemClass}>
                {content}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
