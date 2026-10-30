"use client";

import type { Role } from "@/generated/prisma/client";
import { Dropdown, type DropdownItem } from "./Dropdown";
import { hasRole } from "./nav";
import { useShell } from "./shell-context";

export const initials = (name: string, email: string) => {
  const source = name.trim() || email;
  const parts = source.split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : source.slice(0, 2)).toUpperCase();
};

export function UserMenu({ name, email, role }: { name: string; email: string; role: Role }) {
  const { signOut } = useShell();
  const items: DropdownItem[] = [
    ...(hasRole(role, "admin")
      ? ([
          { label: "Team and roles", icon: "team", href: "/app/settings/team" },
          { label: "Billing", icon: "card", href: "/app/billing" },
          { separator: true },
        ] as DropdownItem[])
      : []),
    { label: "Sign out", icon: "logout", onSelect: () => void signOut() },
  ];
  return (
    <Dropdown
      label="Account"
      triggerLabel={`${initials(name, email)}, account menu`}
      triggerClassName="h-9 w-9 justify-center bg-accent text-xs font-semibold text-white hover:bg-accent-strong"
      trigger={<span aria-hidden="true">{initials(name, email)}</span>}
      header={
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{name}</p>
          <p className="truncate text-xs text-muted">{email}</p>
          <p className="mt-0.5 text-xs capitalize text-muted">{role}</p>
        </div>
      }
      items={items}
    />
  );
}
