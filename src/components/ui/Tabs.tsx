"use client";

import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { nextTabIndex } from "./a11y";
import { cn } from "./cn";

export type TabItem = {
  id: string;
  label: string;
  /** Small number or text after the label, for example a count. */
  badge?: ReactNode;
  disabled?: boolean;
  /** Panel content. Only the selected tab's content is mounted. Omit it to render your own panel (see tabIds). */
  content?: ReactNode;
};

export function tabIds(prefix: string, id: string) {
  return { tab: `${prefix}-tab-${id}`, panel: `${prefix}-panel-${id}` };
}

type TabsProps = {
  tabs: TabItem[];
  /** Accessible name for the tab list, for example "Contact sections". */
  label: string;
  value?: string;
  defaultValue?: string;
  onChange?: (id: string) => void;
  variant?: "underline" | "pill";
  /** Pass the same prefix to tabIds() when you render panels yourself. */
  idPrefix?: string;
  className?: string;
};

/** WAI-ARIA tabs: roving tabindex, Left/Right (or Home/End) move and select, panels labelled by their tab. */
export function Tabs({ tabs, label, value, defaultValue, onChange, variant = "underline", idPrefix, className }: TabsProps) {
  const generated = useId();
  const prefix = idPrefix ?? generated;
  const [inner, setInner] = useState(defaultValue ?? tabs.find((t) => !t.disabled)?.id ?? "");
  const selected = value ?? inner;
  const list = useRef<HTMLDivElement>(null);

  function select(id: string) {
    if (value === undefined) setInner(id);
    onChange?.(id);
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const current = tabs.findIndex((t) => t.id === selected);
    const next = nextTabIndex(tabs.length, current < 0 ? 0 : current, e.key, tabs.map((t) => !!t.disabled));
    if (next === null) return;
    e.preventDefault();
    select(tabs[next].id);
    list.current?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
  }

  const hasPanels = tabs.some((t) => t.content !== undefined);

  return (
    <div className={className}>
      <div
        ref={list}
        role="tablist"
        aria-label={label}
        onKeyDown={onKeyDown}
        className={cn("flex gap-1 overflow-x-auto", variant === "underline" ? "border-b border-border" : "rounded-full bg-surface-2 p-1")}
      >
        {tabs.map((t) => {
          const active = t.id === selected;
          const ids = tabIds(prefix, t.id);
          return (
            <button
              key={t.id}
              id={ids.tab}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls={ids.panel}
              tabIndex={active ? 0 : -1}
              disabled={t.disabled}
              onClick={() => select(t.id)}
              // A selected pill's fill is nearly the track colour in dark mode, so its accent border carries the 3:1 "selected" cue.
              className={cn(
                "inline-flex shrink-0 items-center gap-2 whitespace-nowrap text-sm font-medium transition-colors duration-(--dur-fast) disabled:cursor-not-allowed disabled:opacity-50",
                variant === "underline"
                  ? cn("-mb-px border-b-2 px-3 py-2.5", active ? "border-accent text-foreground" : "border-transparent text-muted hover:text-foreground")
                  : cn("rounded-full border px-3.5 py-1.5", active ? "border-accent-ink bg-raised text-foreground shadow-raised" : "border-transparent text-muted hover:text-foreground"),
              )}
            >
              {t.label}
              {t.badge !== undefined && <span className="rounded-full bg-surface-2 px-1.5 text-xs tabular-nums text-muted">{t.badge}</span>}
            </button>
          );
        })}
      </div>
      {hasPanels &&
        tabs.map((t) => {
          const active = t.id === selected;
          const ids = tabIds(prefix, t.id);
          return (
            <div key={t.id} id={ids.panel} role="tabpanel" aria-labelledby={ids.tab} tabIndex={0} hidden={!active} className="pt-4">
              {active ? t.content : null}
            </div>
          );
        })}
    </div>
  );
}
