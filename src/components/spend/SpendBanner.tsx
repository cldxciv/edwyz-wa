"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { cn } from "@/components/ui";
import type { SpendBannerKind } from "@/lib/spend/types";
import type { BannerOnlyView, SpendBannerView } from "@/lib/spend/summary";

/*
 * The spending banner in the AppShell banner slot (docs/SPEND-CONTROLS-SPEC.md 8.2, 7.4). One banner at a time, the first
 * that applies in this order: 1 platform freeze, 2 workspace stopped, 3 a limit used up, 4 requests waiting (approvers
 * only), 5 Meta's limit needs attention, 6 new-workspace limits (first 7 days, dismissible), 7 choose a spending ad account
 * (owners), 8 Meta's limit waiting for the owner (owners). The server builds the ordered list (GET /api/spend/summary
 * ?view=banner); this picks the first one not dismissed. A dismissal is remembered in localStorage, inside try/catch,
 * so a browser that blocks storage simply shows the banner again. Renders nothing while loading or on error.
 */

/** The 8.2 order, highest first (the server already sorts; kept here so the client never shows a lower one first). */
export const BANNER_ORDER: readonly SpendBannerKind[] = [
  "platform_frozen",
  "workspace_stopped",
  "limit_reached",
  "approvals_waiting",
  "meta_limit_attention",
  "new_workspace",
  "choose_spending_account",
  "meta_limit_waiting_owner",
];

const REFRESH_MS = 5 * 60_000;

export function isDismissed(key: string | undefined, storage: Pick<Storage, "getItem"> | null = safeStorage()): boolean {
  if (!key || !storage) return false;
  try {
    return storage.getItem(key) === "1";
  } catch {
    return false;
  }
}

export function rememberDismissal(key: string | undefined, storage: Pick<Storage, "setItem"> | null = safeStorage()): void {
  if (!key || !storage) return;
  try {
    storage.setItem(key, "1");
  } catch {
    // Storage blocked (private mode, policy): the banner comes back next time, which is harmless.
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** The banner to show: the highest priority one that is not a dismissed dismissible one. Pure. */
export function pickBanner(banners: readonly SpendBannerView[], dismissed: (key: string | undefined) => boolean): SpendBannerView | null {
  const sorted = [...banners].sort((a, b) => BANNER_ORDER.indexOf(a.kind) - BANNER_ORDER.indexOf(b.kind));
  return sorted.find((b) => !(b.dismissible && dismissed(b.dismissKey))) ?? null;
}

const TONE = {
  danger: "border-bad-line bg-bad-soft text-bad-fg",
  warning: "border-warn-line bg-warn-soft text-warn-fg",
  info: "border-info-line bg-info-soft text-info-fg",
} as const;

const ACTION: Record<SpendBannerKind, string> = {
  platform_frozen: "See spending",
  workspace_stopped: "See spending",
  limit_reached: "See limits",
  approvals_waiting: "Review requests",
  meta_limit_attention: "Check Meta's limit",
  new_workspace: "See limits",
  choose_spending_account: "Choose an ad account",
  meta_limit_waiting_owner: "Review",
};

/** One banner (rendered by tests too). */
export function SpendBannerBar({ banner, onDismiss }: { banner: SpendBannerView; onDismiss?: () => void }) {
  return (
    <div role={banner.tone === "danger" ? "alert" : "status"} className={cn("flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b px-4 py-2 text-sm print:hidden", TONE[banner.tone])} data-testid="spend-banner" data-kind={banner.kind}>
      <span className="min-w-0 flex-1">{banner.text}</span>
      <span className="flex items-center gap-3">
        <Link href={banner.link} className="inline-flex min-h-10 items-center font-semibold underline underline-offset-2">
          {ACTION[banner.kind]}
        </Link>
        {banner.dismissible && onDismiss && (
          <button type="button" onClick={onDismiss} className="inline-flex min-h-10 items-center font-medium underline underline-offset-2">
            Dismiss
          </button>
        )}
      </span>
    </div>
  );
}

/** Mount in the workspace banner slot for every member. */
export function SpendBanner() {
  const [banners, setBanners] = useState<SpendBannerView[]>([]);
  const [, setVersion] = useState(0);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/spend/summary?view=banner", { credentials: "same-origin" })
        .then((res) => (res.ok ? (res.json() as Promise<BannerOnlyView>) : null))
        .then((json) => alive && json && setBanners(Array.isArray(json.banners) ? json.banners : []))
        .catch(() => undefined);
    void load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const banner = pickBanner(banners, (key) => isDismissed(key));
  if (!banner) return null;
  return (
    <SpendBannerBar
      banner={banner}
      onDismiss={() => {
        rememberDismissal(banner.dismissKey);
        setVersion((n) => n + 1);
      }}
    />
  );
}
