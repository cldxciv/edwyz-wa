import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { THEME_INIT_SCRIPT, THEME_KEY } from "@/components/app/theme-core";

const SRC = path.resolve(__dirname, "../src");
const read = (p: string) => readFileSync(path.join(SRC, p), "utf8");

/** Runs the inline script the way a browser would, with the saved theme and the system preference given. */
function themeAfterInit(stored: string | null, prefersDark: boolean): string | undefined {
  const dataset: { theme?: string } = {};
  vm.runInNewContext(THEME_INIT_SCRIPT, {
    localStorage: { getItem: (k: string) => (k === THEME_KEY ? stored : null) },
    window: { matchMedia: () => ({ matches: prefersDark }) },
    document: { documentElement: { dataset } },
  });
  return dataset.theme;
}

describe("the theme on public pages", () => {
  it("is applied before first paint from the root layout, so /login and the home page honour the choice made in the app", () => {
    const root = read("app/layout.tsx");
    expect(root).toContain("THEME_INIT_SCRIPT");
    expect(root).toMatch(/<script dangerouslySetInnerHTML=\{\{ __html: THEME_INIT_SCRIPT \}\} \/>/);
    // The root layout wraps every page, so the app and admin layouts must not run it a second time.
    expect(read("app/(app)/app/layout.tsx")).not.toContain("THEME_INIT_SCRIPT");
    expect(read("app/(admin)/admin/layout.tsx")).not.toContain("THEME_INIT_SCRIPT");
  });

  it("uses the saved choice over the operating system, and the system when nothing was chosen", () => {
    expect(themeAfterInit("light", true)).toBe("light");
    expect(themeAfterInit("dark", false)).toBe("dark");
    expect(themeAfterInit(null, true)).toBe("dark");
    expect(themeAfterInit(null, false)).toBe("light");
    expect(themeAfterInit("sepia", true)).toBe("dark");
  });

  it("is honoured by the public pages' own stylesheet, not just by the app's", () => {
    const css = read("components/site/site.css");
    // The OS-dark block steps aside when light was chosen.
    expect(css).toMatch(/@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\):has\(\.pub\)/);
    // A chosen dark theme applies without the OS being dark.
    expect(css).toMatch(/:root\[data-theme="dark"\]:has\(\.pub\) \{[^}]*--background: #0b1220/);
    expect(css).toMatch(/:root\[data-theme="dark"\]:has\(\.pub\) \{[^}]*color-scheme: dark/);
    expect(css).toMatch(/:root\[data-theme="light"\]:has\(\.pub\) \{[^}]*color-scheme: light/);
  });
});
