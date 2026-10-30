"use client";

import { COMPANY } from "@/lib/config";
import { Dropdown } from "./Dropdown";
import { Icon } from "./Icon";
import { useShell } from "./shell-context";

export const SUPPORT_MAILTO = `mailto:${COMPANY.email}?subject=${encodeURIComponent("Edwyz WA support")}`;

export function HelpMenu() {
  const { openShortcuts, openEddy } = useShell();
  return (
    <Dropdown
      label="Help"
      triggerClassName="h-9 w-9 justify-center text-muted hover:bg-surface hover:text-foreground"
      trigger={<Icon name="help" className="h-5 w-5" />}
      items={[
        { label: "Ask Eddy", description: "The AI helper in Edwyz", icon: "sparkles", onSelect: () => window.setTimeout(() => openEddy(), 0) },
        { label: "Getting started", description: "Your setup checklist", icon: "home", href: "/app/getting-started" },
        { label: "Help and docs", description: "Guides and API reference", icon: "book", href: "/docs", external: true },
        { label: "Email support", description: COMPANY.email, icon: "mail", href: SUPPORT_MAILTO, external: true },
        { label: "Keyboard shortcuts", description: "Press ? anywhere", icon: "keyboard", onSelect: openShortcuts },
      ]}
    />
  );
}
