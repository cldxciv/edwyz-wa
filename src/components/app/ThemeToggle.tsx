"use client";

import { cn } from "@/components/ui";
import { Icon } from "./Icon";
import { toggleTheme, useTheme } from "./theme";

export function ThemeToggle({ className }: { className?: string }) {
  const theme = useTheme();
  const dark = theme === "dark";
  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
      title={dark ? "Switch to light theme" : "Switch to dark theme"}
      className={cn("inline-flex h-9 w-9 items-center justify-center rounded-full text-muted hover:bg-surface hover:text-foreground", className)}
    >
      <Icon name={dark ? "sun" : "moon"} className="h-5 w-5" />
    </button>
  );
}
