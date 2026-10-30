export const COMPANY = {
  product: "Edwyz WA",
  legalName: "Edwyz Technologies Private Limited",
  address: "#2, Type 3, Parimahal, Shimla-9 (H.P.), India",
  email: "hello@edwyz.com",
  effectiveDate: "26 October 2026",
} as const;

// Latest stable per Meta's changelog on 2026-10-26. Review quarterly; Meta retires versions about two years after release.
export const GRAPH_API_VERSION = "v26.0";

/** The real public address. Used when SITE_URL is unset, and instead of a loopback SITE_URL while `next build` prerenders. */
export const PUBLIC_SITE_URL = "https://wa.edwyz.com";

const LOOPBACK = /^https?:\/\/(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])(?::\d+)?$/i;

type SiteEnv = Readonly<Record<string, string | undefined>>;

/** True while `next build` runs (Next sets NEXT_PHASE for the build and its prerender workers), never under `next start` or `next dev`. */
export const isBuildPhase = (env: SiteEnv = process.env) => env.NEXT_PHASE === "phase-production-build";

/**
 * Site origin without a trailing slash. Static routes (robots, sitemap, the home page's canonical and og:url) are rendered once at
 * `next build`, so whatever SITE_URL says then is frozen into the release. A workstation .env says http://localhost:3500, and that
 * must never reach search engines or link previews, so during the build a loopback address falls back to the public address.
 * At run time SITE_URL is always honoured, so local production-mode runs and e2e keep working.
 */
export const siteUrl = (env: SiteEnv = process.env) => {
  const configured = (env.SITE_URL ?? PUBLIC_SITE_URL).replace(/\/$/, "");
  return isBuildPhase(env) && LOOPBACK.test(configured) ? PUBLIC_SITE_URL : configured;
};
