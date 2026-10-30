import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/auth/signed-in", () => ({ signedInUser: async () => null }));

import * as siteLayout from "@/app/(site)/layout";
import * as authLayout from "@/app/(auth)/layout";
import * as sitemapRoute from "@/app/sitemap";
import * as robotsRoute from "@/app/robots";
import { metadata as rootMeta } from "@/app/layout";
import { metadata as docsMeta } from "@/app/(site)/docs/page";
import { metadata as authDocsMeta } from "@/app/(site)/docs/authentication/page";
import { metadata as endpointsMeta } from "@/app/(site)/docs/endpoints/page";
import { metadata as errorsMeta } from "@/app/(site)/docs/errors/page";
import { metadata as rateLimitsMeta } from "@/app/(site)/docs/rate-limits/page";
import { metadata as webhooksMeta } from "@/app/(site)/docs/webhooks/page";
import { metadata as privacyMeta } from "@/app/(site)/privacy/page";
import { metadata as termsMeta } from "@/app/(site)/terms/page";
import { metadata as deletionMeta } from "@/app/(site)/data-deletion/page";
import { metadata as homeMeta } from "@/app/(site)/page";
import { metadata as signupMeta } from "@/app/(auth)/signup/page";
import { GET as ogImage } from "@/app/og.png/route";
import { OG_IMAGE, pageMetadata, sitemapEntries } from "@/components/site/seo";

const saved = process.env.SITE_URL;
beforeEach(() => {
  delete process.env.SITE_URL;
});
afterEach(() => {
  if (saved === undefined) delete process.env.SITE_URL;
  else process.env.SITE_URL = saved;
});

describe("public URLs follow the server's SITE_URL, not the build machine's", () => {
  it("renders the public layouts, the sitemap and robots per request", () => {
    // A statically prerendered page evaluates siteUrl() once at `next build`; a developer's SITE_URL=http://localhost:3500 then
    // shipped to production in every canonical, JSON-LD block, the docs' base URL and the legal pages' callback URLs.
    expect(siteLayout.dynamic).toBe("force-dynamic");
    expect(authLayout.dynamic).toBe("force-dynamic");
    expect(sitemapRoute.dynamic).toBe("force-dynamic");
    expect(robotsRoute.dynamic).toBe("force-dynamic");
  });

  it("reads SITE_URL when the sitemap, robots and page metadata are built, not when the module loads", () => {
    process.env.SITE_URL = "https://staging.example.com/";
    expect(sitemapRoute.default().every((e) => e.url.startsWith("https://staging.example.com/") || e.url === "https://staging.example.com")).toBe(true);
    expect(robotsRoute.default().sitemap).toBe("https://staging.example.com/sitemap.xml");
    expect(pageMetadata({ title: "x", description: "y", path: "/docs" }).alternates?.canonical).toBe("https://staging.example.com/docs");
    delete process.env.SITE_URL;
    expect(sitemapEntries()[0].url).toBe("https://wa.edwyz.com");
    expect(robotsRoute.default().sitemap).toBe("https://wa.edwyz.com/sitemap.xml");
  });
});

describe("every indexable page declares its own canonical and share tags", () => {
  it("the root layout sets no canonical for pages to inherit", () => {
    expect(rootMeta.alternates?.canonical).toBeUndefined();
  });

  it.each([
    ["/docs", docsMeta],
    ["/docs/authentication", authDocsMeta],
    ["/docs/endpoints", endpointsMeta],
    ["/docs/errors", errorsMeta],
    ["/docs/rate-limits", rateLimitsMeta],
    ["/docs/webhooks", webhooksMeta],
    ["/privacy", privacyMeta],
    ["/terms", termsMeta],
    ["/data-deletion", deletionMeta],
    ["/signup", signupMeta],
    ["", homeMeta],
  ])("%s", (path, meta) => {
    const url = `https://wa.edwyz.com${path}`;
    expect(meta.alternates?.canonical).toBe(url);
    expect(meta.robots).toEqual({ index: true, follow: true });
    const og = meta.openGraph as { url?: string; title?: string; images?: { url: string; width: number; height: number; alt: string }[] };
    expect(og.url).toBe(url);
    expect(og.title).toBeTruthy();
    expect(og.images).toEqual([{ url: `https://wa.edwyz.com${OG_IMAGE.path}`, width: 1200, height: 630, alt: OG_IMAGE.alt }]);
    const tw = meta.twitter as { card?: string; images?: string[] };
    expect(tw.card).toBe("summary_large_image");
    expect(tw.images).toEqual([`https://wa.edwyz.com${OG_IMAGE.path}`]);
  });
});

describe("share preview image", () => {
  it("is served as a 1200 by 630 PNG", async () => {
    const res = ogImage();
    expect(res.headers.get("content-type")).toBe("image/png");
    const png = Buffer.from(await res.arrayBuffer());
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    // IHDR: width and height are big-endian 32-bit integers at bytes 16 and 20.
    expect(png.readUInt32BE(16)).toBe(OG_IMAGE.width);
    expect(png.readUInt32BE(20)).toBe(OG_IMAGE.height);
  }, 60_000);
});
