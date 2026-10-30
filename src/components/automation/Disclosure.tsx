"use client";

import { useState, type ReactNode } from "react";
import { cn } from "@/components/ui";

type Props = {
  summary: string;
  /** Whether the section starts open. Read once; later changes never open or close it under the user. */
  defaultOpen?: boolean;
  /** Opens the section the first time this turns true (for example when a hidden field has an error). */
  openOnce?: boolean;
  className?: string;
  children: ReactNode;
};

/**
 * A native details element whose open state belongs to the user. A plain `open={condition}` prop would snap shut the moment the
 * condition flips (for example when a text box inside is cleared), taking the keyboard focus with it.
 */
export function Disclosure({ summary, defaultOpen = false, openOnce = false, className, children }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const [forced, setForced] = useState(false);
  if (openOnce && !forced) {
    setForced(true);
    setOpen(true);
  }
  return (
    <details className={cn("rounded-card border border-border p-3", className)} open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="min-h-10 cursor-pointer text-sm font-medium leading-10">{summary}</summary>
      <div className="mt-3 space-y-4">{children}</div>
    </details>
  );
}
