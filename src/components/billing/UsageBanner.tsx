"use client";

import Link from "next/link";
import { cn } from "@/components/ui";
import { useApi } from "@/components/contacts/hooks";
import { usageBannerText, type MeterLine } from "./helpers";

const TONE = {
  warn: "border-warn-line bg-warn-soft text-warn-fg",
  bad: "border-bad-line bg-bad-soft text-bad-fg",
} as const;

/** Mount in the workspace banner slot for owners and admins. Renders nothing while loading, on error, or when every limit is under 80 percent. */
export function UsageBanner() {
  const { data } = useApi<{ alerts: MeterLine[] }>("/api/billing/usage");
  const banner = data ? usageBannerText(data.alerts) : null;
  if (!banner) return null;
  return (
    <div role={banner.tone === "bad" ? "alert" : "status"} className={cn("flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b px-4 py-2 text-sm print:hidden", TONE[banner.tone])}>
      <span className="min-w-0 flex-1">{banner.text}</span>
      <Link href="/app/billing#usage" className="inline-flex min-h-10 items-center font-semibold underline underline-offset-2">
        See usage
      </Link>
    </div>
  );
}
