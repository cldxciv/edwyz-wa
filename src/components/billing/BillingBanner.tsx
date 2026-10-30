import Link from "next/link";
import { cn } from "@/components/ui";
import { bannerMessage, type BannerInput } from "./helpers";

const TONE = {
  warn: "border-warn-line bg-warn-soft text-warn-fg",
  bad: "border-bad-line bg-bad-soft text-bad-fg",
} as const;

/** Mount in the app layout with `status={await getBillingStatus(actor.tenantId)}`. Renders nothing when no action is needed. */
export function BillingBanner({ status }: { status: BannerInput }) {
  const banner = bannerMessage(status);
  if (!banner) return null;
  return (
    <div role={banner.tone === "bad" ? "alert" : "status"} className={cn("flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b px-4 py-2 text-sm print:hidden", TONE[banner.tone])}>
      <span className="min-w-0 flex-1">{banner.text}</span>
      <Link href="/app/billing" className="inline-flex min-h-10 items-center font-semibold underline underline-offset-2">
        {status.state === "suspended" ? "See details" : "Choose a plan"}
      </Link>
    </div>
  );
}
