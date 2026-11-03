import type { Metadata } from "next";
import { buttonSizes, buttonVariants } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import { PWA_ICONS } from "@/lib/pwa";

export const metadata: Metadata = { title: "You are offline", robots: { index: false, follow: false } };

// Static on purpose. public/sw.js stores this page at install and refuses any response marked private or no-store, which is what
// a page rendered per request is sent with. It reads no data, cookies or headers, so it is the same for everyone.
export const dynamic = "force-static";

/**
 * Shown by the service worker in place of any page that cannot load without a connection, at that page's own address. "Try again"
 * is a link to the current address (href=""), so it works even when the page's scripts could not load either.
 */
export default function OfflinePage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-16 text-foreground">
      <div className="mx-auto max-w-sm text-center">
        {/* A plain img: the image optimizer is a server route and is not stored for offline use. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={PWA_ICONS.any192} alt="" width={72} height={72} className="mx-auto" />
        <p className="mt-6 text-sm font-semibold uppercase tracking-widest text-muted">Edwyz WA</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">You are offline.</h1>
        <p className="mt-3 text-base leading-relaxed text-muted">Edwyz WA needs the internet to show your chats.</p>
        <a href="" className={cn("mt-8 inline-flex items-center justify-center rounded-full font-semibold", buttonVariants.primary, buttonSizes.lg)}>
          Try again
        </a>
      </div>
    </main>
  );
}
