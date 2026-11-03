"use client";

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Role } from "@/generated/prisma/client";
import { apiFetch, cn } from "@/components/ui";
import { EddyRoot, type EddyRequest } from "@/components/eddy/EddyRoot";
import { EDDY_EVENTS, onEddyEvent, type EddyOpenDetail } from "@/components/eddy/events";
import { CommandPalette } from "./CommandPalette";
import { MobileDrawer } from "./MobileDrawer";
import { MobileTabBar } from "./MobileTabBar";
import { isActive } from "./nav";
import { ShellProvider } from "./shell-context";
import { ShortcutsDialog } from "./ShortcutsDialog";
import { IDLE, isTypingTarget, resolveShortcut, type ShortcutState } from "./shortcuts";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { useUnread } from "./useUnread";

type Props = {
  role: Role;
  workspaceName: string;
  userName: string;
  email: string;
  /** Server-rendered notice shown above the top bar (for example the billing banner). */
  banner?: ReactNode;
  children: ReactNode;
};

export function AppShell({ role, workspaceName, userName, email, banner, children }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const unread = useUnread();
  const [palette, setPalette] = useState(false);
  const [shortcuts, setShortcuts] = useState(false);
  const [drawerPath, setDrawerPath] = useState<string | null>(null);
  const drawer = drawerPath === pathname;
  const [eddyOpen, setEddyOpen] = useState(false);
  const [eddyRequest, setEddyRequest] = useState<EddyRequest | null>(null);
  const chord = useRef<ShortcutState>(IDLE);
  const modalOpen = useRef(false);
  // A page that fills the screen (the inbox, whose panes scroll on their own) gets a column exactly one screen tall and a flex
  // main, so it takes what is left under the banners and the top bar, whatever their height, and the page never scrolls twice.
  const fill = isActive(pathname, "/app/inbox");

  useEffect(() => {
    modalOpen.current = palette || shortcuts || drawer;
  }, [palette, shortcuts, drawer]);

  const signOut = useCallback(async () => {
    try {
      await apiFetch("/api/auth/logout", { method: "POST", body: {} });
    } finally {
      window.location.assign("/login");
    }
  }, []);

  // Eddy (docs/EDDY-SPEC.md 6.1): opened from the launcher, the palette, the Help menu, the phone drawer, or any page
  // through the checked `wa:eddy-open` event. A query is sent as the member's own message; a reference carries ids only.
  const openEddy = useCallback((request?: string | EddyOpenDetail) => {
    const detail: EddyOpenDetail = typeof request === "string" ? { query: request } : (request ?? {});
    setEddyOpen(true);
    if (detail.query || detail.ref) setEddyRequest((r) => ({ seq: (r?.seq ?? 0) + 1, ...(detail.query ? { query: detail.query } : {}), ...(detail.ref ? { ref: detail.ref } : {}) }));
  }, []);
  const closeEddy = useCallback(() => setEddyOpen(false), []);
  useEffect(() => onEddyEvent(EDDY_EVENTS.open, (detail) => openEddy(detail)), [openEddy]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const foreignModal = !modalOpen.current && document.querySelector('[aria-modal="true"], dialog[open]') !== null;
      const result = resolveShortcut(
        chord.current,
        { key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, shiftKey: e.shiftKey, typing: isTypingTarget(e.target as HTMLElement | null) },
        role,
        Date.now(),
        modalOpen.current || foreignModal,
      );
      chord.current = result.state;
      if (!result.action) return;
      if (result.preventDefault) e.preventDefault();
      if (result.action.type === "palette") setPalette((v) => !v);
      else if (result.action.type === "help") setShortcuts(true);
      else router.push(result.action.href);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [role, router]);

  const state = useMemo(
    () => ({
      role,
      unread,
      signOut,
      openPalette: () => setPalette(true),
      openShortcuts: () => setShortcuts(true),
      openDrawer: () => setDrawerPath(pathname),
      openEddy,
      closeEddy,
      eddyOpen,
    }),
    [role, unread, signOut, pathname, openEddy, closeEddy, eddyOpen],
  );

  return (
    <ShellProvider value={state}>
      <a
        href="#main-content"
        data-shell-skip
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[70] focus:rounded-lg focus:bg-accent focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-white"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById("main-content")?.focus();
        }}
      >
        Skip to main content
      </a>
      {/* h-dvh on both for a full-screen page: a 100vh row is taller than the screen while a phone shows its address bar. */}
      <div className={cn("flex", fill ? "h-dvh" : "min-h-screen")}>
        <Sidebar role={role} />
        <div className={cn("flex min-w-0 flex-1 flex-col", fill && "h-dvh")}>
          {banner}
          <TopBar workspaceName={workspaceName} userName={userName} email={email} role={role} />
          <main
            id="main-content"
            tabIndex={-1}
            className={cn(
              "flex-1 px-4 outline-none md:px-8 2xl:px-12",
              fill ? "flex min-h-0 flex-col pt-3 pb-[calc(4.25rem+env(safe-area-inset-bottom))] md:py-4" : "py-6 pb-[calc(5.5rem+env(safe-area-inset-bottom))] md:pb-8",
            )}
          >
            {children}
          </main>
        </div>
        <EddyRoot role={role} userName={userName} workspaceName={workspaceName} open={eddyOpen} request={eddyRequest} onOpen={openEddy} onClose={closeEddy} />
      </div>
      <MobileTabBar role={role} drawerOpen={drawer} />
      <MobileDrawer role={role} open={drawer} onClose={() => setDrawerPath(null)} />
      {palette && <CommandPalette role={role} open onClose={() => setPalette(false)} />}
      {shortcuts && <ShortcutsDialog role={role} onClose={() => setShortcuts(false)} />}
    </ShellProvider>
  );
}
