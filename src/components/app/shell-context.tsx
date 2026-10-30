"use client";

import { createContext, useContext } from "react";
import type { Role } from "@/generated/prisma/client";
import type { EddyOpenDetail } from "@/components/eddy/events";

export type ShellState = {
  role: Role;
  unread: number;
  openPalette: () => void;
  openShortcuts: () => void;
  openDrawer: () => void;
  signOut: () => Promise<void>;
  /**
   * Opens Eddy (docs/EDDY-SPEC.md 6.1). A query is sent as the member's own message (the palette's `Ask Eddy: "q"`); a
   * reference carries ids only (a notice, a failed message), never customer text.
   */
  openEddy: (request?: string | EddyOpenDetail) => void;
  closeEddy: () => void;
  eddyOpen: boolean;
};

const ShellContext = createContext<ShellState | null>(null);

export const ShellProvider = ShellContext.Provider;

export function useShell(): ShellState {
  const value = useContext(ShellContext);
  if (!value) throw new Error("useShell must be used inside AppShell.");
  return value;
}
