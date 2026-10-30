/**
 * The installable web app (docs/PLAY-STORE.md): the manifest (src/app/manifest.ts), the service worker (public/sw.js) and its
 * offline page (src/app/offline/page.tsx). The Android app is a Trusted Web Activity over the same site, so these are what it shows
 * for its launcher icon, splash screen and status bar.
 *
 * The PNGs in public/icons were made once from web/public/img/logo-edwyz-mini.png and are committed (no build step): "any" icons
 * carry the mark over 80% of the side, maskable ones keep every drawn pixel inside the central 80% circle that launchers never crop.
 */

/** Light theme tokens from src/app/globals.css (--accent, --background); tests/pwa-manifest.test.ts keeps them equal. */
export const PWA_THEME_COLOR = "#047857";
export const PWA_BACKGROUND_COLOR = "#ffffff";

export const PWA_ICONS = {
  any192: "/icons/icon-192.png",
  any512: "/icons/icon-512.png",
  maskable192: "/icons/maskable-192.png",
  maskable512: "/icons/maskable-512.png",
  apple: "/icons/apple-touch-icon.png",
} as const;

/** The page the service worker stores at install and shows when a navigation fails; public/sw.js repeats the path. */
export const OFFLINE_PATH = "/offline";
export const SERVICE_WORKER_PATH = "/sw.js";
