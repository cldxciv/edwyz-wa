export type Theme = "light" | "dark";
export const THEME_KEY = "wa-theme";

/**
 * Inline script run before first paint so the saved or system theme is applied without a flash.
 * The strict CSP allows it by its sha256 (THEME_INIT_SCRIPT_HASH in src/lib/security/csp.ts): change both together, or the script
 * is blocked once CSP_MODE=enforce. tests/ops-csp.test.ts fails and prints the new hash until they match.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem('${THEME_KEY}');if(t!=='light'&&t!=='dark'){t=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}document.documentElement.dataset.theme=t}catch(e){}})();`;

export function resolveTheme(stored: string | null, prefersDark: boolean): Theme {
  if (stored === "light" || stored === "dark") return stored;
  return prefersDark ? "dark" : "light";
}
