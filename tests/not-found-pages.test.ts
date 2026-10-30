import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import NotFound, { metadata as notFoundMetadata } from "@/app/not-found";
import AppNotFound from "@/app/(app)/app/not-found";
import AppCatchAll, { metadata as catchAllMetadata } from "@/app/(app)/app/[...rest]/page";
import { ADMIN_TITLE_SUFFIX, adminPageMetadata } from "@/components/admin/helpers";

const APP = path.resolve(__dirname, "../src/app");
const ADMIN = path.join(APP, "(admin)", "admin");
const read = (p: string) => readFileSync(p, "utf8");

function pagesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) return pagesUnder(p);
    return name === "page.tsx" ? [p] : [];
  });
}

describe("the site's page-not-found screen", () => {
  it("exists at the root so a 404 outside the app shell is never a blank page", () => {
    const html = renderToStaticMarkup(createElement(NotFound));
    expect(html).toContain("We could not find that page");
    expect(html).toContain("Check the address for typing mistakes");
    expect(html).toContain('href="/"');
    expect(html).toContain('href="/login"');
    expect(html).toContain("<header");
    expect(html).toContain("<footer");
  });

  it("carries a neutral title and no mention of admin", () => {
    expect(notFoundMetadata.title).toBe("Page not found");
    const html = renderToStaticMarkup(createElement(NotFound));
    expect(html.toLowerCase()).not.toContain("admin");
  });
});

describe("the workspace's page-not-found screen", () => {
  it("is reached for any unknown address under /app through a catch-all page that answers 404", () => {
    // Next only uses the root not-found for addresses no page claims; the catch-all claims them for the workspace shell.
    let digest = "";
    try {
      AppCatchAll();
    } catch (e) {
      digest = String((e as { digest?: unknown }).digest ?? "");
    }
    expect(digest).toMatch(/NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/);
    expect(catchAllMetadata.title).toBe("Page not found");
  });

  it("says what happened and offers the way back to the workspace", () => {
    const html = renderToStaticMarkup(createElement(AppNotFound));
    expect(html).toContain("We could not find that page");
    expect(html).toContain('href="/app"');
    expect(html).toContain("Back to your workspace");
  });
});

describe("admin titles", () => {
  it("are set by each page, after the access check, never by the admin layout", () => {
    const layout = read(path.join(ADMIN, "layout.tsx"));
    expect(layout).not.toMatch(/export const metadata/);
    expect(layout).not.toContain(ADMIN_TITLE_SUFFIX + '"');
    const pages = pagesUnder(ADMIN);
    expect(pages.length).toBeGreaterThan(5);
    for (const p of pages) {
      const src = read(p);
      expect(src, p).toMatch(/export const metadata = adminPageMetadata\("[^"]+"\);/);
      expect(src, p).toContain('from "@/components/admin/helpers"');
    }
  });

  it("read as before for a real admin and keep the area out of search engines", () => {
    const m = adminPageMetadata("Overview");
    expect(m.title).toEqual({ absolute: "Overview | Platform admin" });
    expect(m.robots).toEqual({ index: false, follow: false, nocache: true });
  });
});
