"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { cn } from "@/components/ui";
import { RECONNECT_PATH, tokenBannerContent, type TokenView } from "./token-banner";

const TONE = {
  warn: "border-warn-line bg-warn-soft text-warn-fg",
  bad: "border-bad-line bg-bad-soft text-bad-fg",
} as const;

const REFRESH_MS = 5 * 60_000;

/** Mount in the workspace banner slot. Renders nothing while loading, on error, or while the connection is healthy. */
export function WhatsAppConnectionBanner() {
  const [view, setView] = useState<TokenView | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/onboarding/token-health", { credentials: "same-origin" })
        .then((res) => (res.ok ? (res.json() as Promise<TokenView>) : null))
        .then((json) => alive && setView(json))
        .catch(() => undefined);
    void load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const banner = tokenBannerContent(view);
  if (!banner) return null;
  return (
    <div role={banner.tone === "bad" ? "alert" : "status"} className={cn("flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b px-4 py-2 text-sm print:hidden", TONE[banner.tone])}>
      <span className="min-w-0 flex-1">{banner.text}</span>
      {banner.action && (
        <Link href={RECONNECT_PATH} className="inline-flex min-h-10 items-center font-semibold underline underline-offset-2">
          {banner.action}
        </Link>
      )}
    </div>
  );
}
