import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* Fixes from the 2026-10-30 QA pass of the public pages (landing, auth, docs, legal, the spending-request link). */

const nav = vi.hoisted(() => ({ pathname: "/" as string | null }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname }));
const requestHeaders = vi.hoisted(() => new Map<string, string>([["x-real-ip", "10.0.0.1"]]));
vi.mock("next/headers", () => ({
  headers: async () => ({ get: (k: string) => requestHeaders.get(k) ?? null }),
  cookies: async () => ({ getAll: () => [] }),
}));
const spend = vi.hoisted(() => ({ loadApprovalByToken: vi.fn() }));
vi.mock("@/lib/spend/summary", () => spend);
vi.mock("@/lib/auth", () => ({ getActor: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: {} }));

import SpendApprovalPage from "@/app/s/[token]/page";
import AuthLayout from "@/app/(auth)/layout";
import ResetPasswordPage from "@/app/(auth)/reset-password/page";
import { DocShell } from "@/app/(site)/docs/parts";
import manifest from "@/app/manifest";
import { Header, LegalPage } from "@/components/shell";
import { MobileNav } from "@/components/site/mobile-nav";
import { currentFor } from "@/components/site/nav-link";
import { LEGAL } from "@/lib/legal";

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const visible = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&gt;/g, ">").replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, " ");
const saved = { ...process.env };
/** The opening tag of the link whose text is `text` (attribute order is React's, so tests look inside the tag). */
const linkTag = (out: string, text: string) => out.match(new RegExp(`<a [^>]*>${text}<`))?.[0] ?? "";

beforeEach(() => {
  nav.pathname = "/";
  spend.loadApprovalByToken.mockReset();
});
afterEach(() => {
  process.env = { ...saved };
});

describe("current page in the public navigation", () => {
  it("is the page itself, or a page below a section link; never an in-page link", () => {
    expect(currentFor("/pricing", "/pricing")).toBe("page");
    expect(currentFor("/docs", "/docs/endpoints")).toBe("true");
    expect(currentFor("/docs", "/docs/endpoints", true)).toBeUndefined();
    expect(currentFor("/docs", "/docsx")).toBeUndefined();
    expect(currentFor("/#features", "/")).toBeUndefined();
    expect(currentFor("/", "/pricing")).toBeUndefined();
    expect(currentFor("/pricing", null)).toBeUndefined();
  });

  it("marks the header link of the page being read, for screen readers and on screen", () => {
    nav.pathname = "/pricing";
    const out = html(createElement(Header));
    expect(out.match(/aria-current=/g)).toHaveLength(1);
    const pricing = linkTag(out, "Pricing");
    expect(pricing).toContain('href="/pricing"');
    expect(pricing).toContain('aria-current="page"');
    expect(pricing).toMatch(/class="[^"]*bg-surface text-accent-ink"/);
    nav.pathname = "/docs/errors";
    expect(linkTag(html(createElement(Header)), "Docs")).toContain('aria-current="true"');
    nav.pathname = "/";
    expect(html(createElement(Header))).not.toContain("aria-current");
  });

  it("marks exactly one docs sub-navigation link, and not Overview on a subpage", () => {
    nav.pathname = "/docs/endpoints";
    const out = html(createElement(DocShell, { title: "t", intro: "i", children: "x" }));
    expect(out.match(/aria-current=/g)).toHaveLength(1);
    const endpoints = linkTag(out, "Endpoints");
    expect(endpoints).toContain('aria-current="page"');
    expect(endpoints).toMatch(/class="[^"]*font-semibold/);
    expect(linkTag(out, "Overview")).not.toContain("aria-current");
    nav.pathname = "/docs";
    expect(linkTag(html(createElement(DocShell, { title: "t", intro: "i", children: "x" })), "Overview")).toContain('aria-current="page"');
  });

  it("the mobile menu renders (closed) without errors", () => {
    nav.pathname = "/pricing";
    expect(html(createElement(MobileNav, { links: [{ href: "/pricing", label: "Pricing" }] }))).toContain('aria-expanded="false"');
  });
});

describe("header fits one line at 320px", () => {
  it("keeps the logo and the call to action on one line, with a shorter label below 360px", () => {
    nav.pathname = "/";
    const out = html(createElement(Header));
    expect(out).toMatch(/aria-label="Edwyz WA home" class="[^"]*whitespace-nowrap/);
    const mobileCta = out.match(/<a[^>]*max-\[359px\]:px-3[^>]*>([^]*?)<\/a>/)?.[1] ?? "";
    expect(mobileCta).toMatch(/<span class="max-\[359px\]:hidden">Start free trial<\/span>/);
    expect(mobileCta).toMatch(/<span class="hidden max-\[359px\]:inline">Free trial<\/span>/);
    expect(out).toMatch(/<a[^>]+class="[^"]*whitespace-nowrap[^"]*"[^>]*>Start free trial</); // the desktop button
  });
});

describe("keyboard and anchors", () => {
  it("lifts the skip link above the sticky header (z-30) while it has focus, readable in both themes", () => {
    const layout = read("src/app/layout.tsx");
    const skip = layout.match(/<a\s+href="#content"\s+className="([^"]+)"/)?.[1] ?? "";
    expect(skip).toContain("focus:z-50");
    expect(read("src/components/shell.tsx")).toContain("sticky top-0 z-30");
    expect(skip).toContain("focus:bg-background");
    expect(skip).toContain("focus:text-foreground");
  });

  it("offsets anchor jumps once: html scroll-padding only, no scroll-margin on the landing or legal sections", () => {
    expect(read("src/app/globals.css")).toMatch(/html\s*{\s*scroll-padding-top:\s*5rem;/);
    expect(read("src/app/(site)/page.tsx")).not.toMatch(/scroll-mt-/);
    expect(read("src/app/(site)/privacy/legal-doc.tsx")).not.toMatch(/scroll-mt-/);
  });
});

describe("honest claims", () => {
  it("the auth side panel and the app manifest promise nothing about ads, which are still coming soon", () => {
    const panel = visible(html(createElement(AuthLayout, null, createElement("p", null, "child"))));
    expect(panel).not.toMatch(/\bads?\b/i);
    expect(panel).toContain("Your WhatsApp chats, broadcasts and team in one place");
    expect(panel).toContain("Keep WhatsApp messaging and AI spend under limits you set");
    expect(manifest().description).not.toMatch(/\bads?\b/i);
  });
});

describe("an incomplete reset link", () => {
  const page = async () => html(await ResetPasswordPage({ searchParams: Promise.resolve({}) }));

  it("while email is off, points to the mailbox (no new link can be sent) and back to sign in", async () => {
    delete process.env.SMTP_USER;
    const out = await page();
    expect(out).not.toContain('href="/forgot-password"');
    expect(out).toMatch(/<a[^>]+href="mailto:hello@edwyz\.com[^"]*"[^>]*>hello@edwyz\.com</);
    expect(out).toMatch(/<a[^>]+href="\/login"[^>]*>Back to sign in</);
    expect(out).toMatch(/role="alert"/);
  });

  it("while email works, offers a new link and back to sign in", async () => {
    process.env.SMTP_USER = "smtp-user";
    const out = await page();
    expect(out).toMatch(/<a[^>]+href="\/forgot-password"[^>]*>request a new one</);
    expect(out).toMatch(/<a[^>]+href="\/login"[^>]*>Back to sign in</);
  });

  it("the form page links back to sign in too", async () => {
    const out = html(await ResetPasswordPage({ searchParams: Promise.resolve({ token: "abc" }) }));
    expect(out).toContain("<form");
    expect(out).toMatch(/<a[^>]+href="\/login"[^>]*>Back to sign in</);
  });
});

describe("legal page dating", () => {
  it("the data deletion status page uses the same Last updated and Version line as the other legal pages", () => {
    const out = visible(html(createElement(LegalPage, { title: "Data deletion status", children: "x" })));
    expect(out).toContain(`Last updated ${LEGAL.lastUpdated} · Version ${LEGAL.version}`);
    expect(out).not.toContain("Effective");
  });
});

describe("spending request link that does not work (/s/<token>)", () => {
  it("names the product and links to Settings > Spending limits, which signs the person in first when needed", async () => {
    spend.loadApprovalByToken.mockResolvedValue(null);
    const out = html(await SpendApprovalPage({ params: Promise.resolve({ token: "abc" }) }));
    expect(visible(out)).toContain("This link doesn't work");
    expect(visible(out)).toContain("Settings > Spending limits in Edwyz WA.");
    expect(out).toMatch(/<a[^>]+href="\/app\/settings\/spending"[^>]*>Open Spending limits</);
  });
});
