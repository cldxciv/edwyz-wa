import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(path.resolve(__dirname, "../src/app/globals.css"), "utf8");

function block(source: string, opener: string): string {
  const start = source.indexOf(opener);
  if (start < 0) throw new Error(`missing block ${opener}`);
  let depth = 0;
  for (let i = source.indexOf("{", start); i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}" && --depth === 0) return source.slice(source.indexOf("{", start) + 1, i);
  }
  throw new Error(`unterminated block ${opener}`);
}

function declarations(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

const light = declarations(block(css, ":root {"));
const dark = declarations(block(css, ':root[data-theme="dark"] {'));
const systemDark = declarations(block(block(css, "@media (prefers-color-scheme: dark)"), ':root:not([data-theme="light"])'));

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const TONES = ["good", "warn", "bad", "info"] as const;

type Theme = { name: string; vars: Record<string, string> };
const themes: Theme[] = [
  { name: "light", vars: light },
  { name: "dark", vars: { ...light, ...dark } },
];

describe("theme tokens", () => {
  it("defines the forced dark theme exactly once so no later block silently overrides the tokens", () => {
    expect(css.split(':root[data-theme="dark"] {').length - 1).toBe(1);
    expect(css.split("--background:").length - 1).toBe(3);
  });

  it("keeps the forced dark block and the system dark block identical", () => {
    expect(systemDark).toEqual(dark);
  });

  it("defines every token the light theme defines in the dark theme (except static scales)", () => {
    const missing = Object.keys(light).filter((k) => /^--(background|foreground|muted|surface|border|accent|good|warn|bad|info|ring|danger)/.test(k) && !(k in dark));
    expect(missing).toEqual([]);
  });

  it("uses hex values for every colour token so contrast can be verified", () => {
    for (const { vars } of themes) {
      for (const [k, v] of Object.entries(vars)) {
        if (/^--(background|foreground|muted|surface|surface-2|raised|border|border-strong|accent|accent-strong|accent-soft|accent-ink|on-accent|danger|danger-strong|ring|(good|warn|bad|info)(-soft|-fg|-line)?)$/.test(k)) {
          expect(v, `${k}`).toMatch(/^#[0-9a-f]{6}$/i);
        }
      }
    }
  });
});

describe.each(themes)("$name theme contrast", ({ vars }) => {
  const text: [string, string][] = [
    ["foreground", "background"],
    ["foreground", "surface"],
    ["foreground", "surface-2"],
    ["foreground", "raised"],
    ["muted", "background"],
    ["muted", "surface"],
    ["muted", "surface-2"],
    ["muted", "raised"],
    ["accent-ink", "background"],
    ["accent-ink", "surface"],
    ["accent-ink", "raised"],
    ["accent-ink", "accent-soft"],
    ["on-accent", "accent"],
    ["on-accent", "accent-strong"],
    ["on-accent", "danger"],
    ["on-accent", "danger-strong"],
    ...TONES.flatMap((t): [string, string][] => [
      [`${t}-fg`, `${t}-soft`],
      [`${t}-fg`, "background"],
      [`${t}-fg`, "raised"],
    ]),
  ];
  it.each(text)("text %s on %s is at least 4.5:1", (fg, bg) => {
    expect(contrast(vars[`--${fg}`], vars[`--${bg}`])).toBeGreaterThanOrEqual(4.5);
  });

  const nonText: [string, string][] = [
    ["border-strong", "background"],
    ["border-strong", "surface"],
    ["border-strong", "raised"],
    ["ring", "background"],
    ["ring", "surface"],
    ["ring", "raised"],
    ["accent", "background"],
    ...TONES.map((t): [string, string] => [t, "background"]),
    ...TONES.map((t): [string, string] => [t, "surface"]),
  ];
  it.each(nonText)("component colour %s against %s is at least 3:1", (fg, bg) => {
    expect(contrast(vars[`--${fg}`], vars[`--${bg}`])).toBeGreaterThanOrEqual(3);
  });
});

describe("dark palette overrides for legacy Tailwind colour classes", () => {
  const v = { ...light, ...dark };
  const pairs: [string, string][] = [
    ["--color-red-700", "--background"],
    ["--color-red-700", "--surface"],
    ["--color-red-800", "--color-red-50"],
    ["--color-red-900", "--color-red-100"],
    ["--color-red-800", "--background"],
    ["--color-amber-900", "--color-amber-50"],
    ["--color-amber-800", "--color-amber-50"],
    ["--color-amber-900", "--color-amber-100"],
    ["--color-amber-800", "--background"],
    ["--color-emerald-800", "--color-emerald-50"],
    ["--color-emerald-900", "--color-emerald-100"],
    ["--color-emerald-700", "--background"],
    ["--color-sky-900", "--color-sky-100"],
    ["--color-sky-600", "--background"],
  ];
  it.each(pairs)("%s on %s is at least 4.5:1", (fg, bg) => {
    expect(contrast(v[fg], v[bg])).toBeGreaterThanOrEqual(4.5);
  });

  it("applies the same overrides in both dark blocks", () => {
    const keys = Object.keys(dark).filter((k) => k.startsWith("--color-"));
    expect(keys.length).toBeGreaterThan(10);
    for (const k of keys) expect(systemDark[k]).toBe(dark[k]);
  });
});

describe("motion safety", () => {
  it("collapses animation and transition durations under prefers-reduced-motion", () => {
    const reduced = block(css, "@media (prefers-reduced-motion: reduce)");
    expect(reduced).toContain("animation-duration: 0.01ms !important");
    expect(reduced).toContain("transition-duration: 0.01ms !important");
  });

  it("keeps a focus ring rule for keyboard users", () => {
    expect(css).toMatch(/:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--ring\)/);
  });
});
