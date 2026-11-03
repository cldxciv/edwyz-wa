import type { Metadata, Viewport } from "next";
import "./globals.css";
import { THEME_INIT_SCRIPT } from "@/components/app/theme-core";
import { ServiceWorkerRegistration } from "@/components/pwa/ServiceWorkerRegistration";
import { siteUrl } from "@/lib/config";
import { PWA_ICONS } from "@/lib/pwa";

// No canonical here: a canonical set on the root layout is inherited by every page that does not declare its own, which
// told search engines the docs subpages were copies of the home page. Each public page sets its own through pageMetadata().
export const metadata: Metadata = {
  metadataBase: new URL(siteUrl()),
  title: { default: "Edwyz WA | WhatsApp Business inbox, templates and broadcasts", template: "%s | Edwyz WA" },
  description:
    "Edwyz WA lets a business connect its own WhatsApp number to the WhatsApp Business Platform and manage conversations, message templates and broadcasts from one workspace.",
  // The web app manifest (src/app/manifest.ts) is linked by Next itself; iOS reads its home-screen icon from this link instead.
  icons: { apple: [{ url: PWA_ICONS.apple, sizes: "180x180", type: "image/png" }] },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    // The theme script below sets data-theme on <html> before React hydrates; suppressHydrationWarning covers that one attribute.
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen">
        {/* Applies the theme the person picked in the app (or the system one) before first paint, on every page, so /login and the home page match the workspace.
            It carries no nonce (this layout also wraps prerendered pages); the strict CSP allows it by its hash, THEME_INIT_SCRIPT_HASH in src/lib/security/csp.ts. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        {/* Pages with their own shell (app, admin) carry a skip link that jumps past the sidebar and top bar, so this one steps aside there.
            z-50 lifts it above the public pages' sticky header (z-30), which otherwise covers it while it has focus. */}
        <a
          href="#content"
          className="[body:has([data-shell-skip])_&]:hidden sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:border focus:border-border focus:bg-background focus:px-3 focus:py-2 focus:text-foreground focus:shadow-lg"
        >
          Skip to content
        </a>
        <div id="content">{children}</div>
        {/* Offline page for the installable app and the Android app (docs/PLAY-STORE.md); registers only in production builds. */}
        <ServiceWorkerRegistration />
      </body>
    </html>
  );
}
