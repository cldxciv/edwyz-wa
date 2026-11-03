import type { MetadataRoute } from "next";
import { PWA_BACKGROUND_COLOR, PWA_ICONS, PWA_THEME_COLOR } from "@/lib/pwa";

// Served at /manifest.webmanifest; Next links it from every page. The Android app (package com.edwyz.wa) is generated from it by
// Bubblewrap, so a change to the name, colours or icons here also needs a new Android build to reach the launcher (docs/PLAY-STORE.md).
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/app",
    name: "Edwyz WA",
    short_name: "Edwyz WA",
    // No ads here: Instagram and Facebook ads are still coming soon (see the landing page).
    description: "Team inbox, broadcasts, chatbots and AI replies for your WhatsApp Business number.",
    start_url: "/app?source=twa",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    theme_color: PWA_THEME_COLOR,
    background_color: PWA_BACKGROUND_COLOR,
    categories: ["business", "productivity"],
    icons: [
      { src: PWA_ICONS.any192, sizes: "192x192", type: "image/png", purpose: "any" },
      { src: PWA_ICONS.any512, sizes: "512x512", type: "image/png", purpose: "any" },
      { src: PWA_ICONS.maskable192, sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: PWA_ICONS.maskable512, sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
