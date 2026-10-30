import { afterEach, describe, expect, it, vi } from "vitest";
import { PUBLIC_SITE_URL, isBuildPhase, siteUrl } from "@/lib/config";
import { pageMetadata, sitemapEntries } from "@/components/site/seo";
import robots from "@/app/robots";
import * as robotsRoute from "@/app/robots";
import * as sitemapRoute from "@/app/sitemap";

const BUILD = "phase-production-build";

afterEach(() => vi.unstubAllEnvs());

describe("siteUrl", () => {
  it("honours SITE_URL at run time, including a local address", () => {
    vi.stubEnv("SITE_URL", "http://localhost:3500");
    vi.stubEnv("NEXT_PHASE", "");
    expect(siteUrl()).toBe("http://localhost:3500");
    expect(isBuildPhase()).toBe(false);
  });

  it("falls back to the public address when SITE_URL is unset and strips a trailing slash", () => {
    vi.stubEnv("SITE_URL", "");
    expect(siteUrl({})).toBe(PUBLIC_SITE_URL);
    expect(siteUrl({ SITE_URL: "https://wa.edwyz.com/" })).toBe("https://wa.edwyz.com");
  });

  it("never bakes a workstation localhost SITE_URL into a production build", () => {
    const build = { NEXT_PHASE: BUILD };
    expect(isBuildPhase(build)).toBe(true);
    expect(siteUrl({ ...build, SITE_URL: "http://localhost:3500" })).toBe(PUBLIC_SITE_URL);
    expect(siteUrl({ ...build, SITE_URL: "http://127.0.0.1:3500/" })).toBe(PUBLIC_SITE_URL);
    expect(siteUrl({ ...build, SITE_URL: "http://[::1]:3500" })).toBe(PUBLIC_SITE_URL);
    expect(siteUrl({ ...build, SITE_URL: "https://localhost" })).toBe(PUBLIC_SITE_URL);
  });

  it("keeps a real staging or production SITE_URL during the build", () => {
    expect(siteUrl({ NEXT_PHASE: BUILD, SITE_URL: "https://staging.wa.edwyz.com" })).toBe("https://staging.wa.edwyz.com");
    expect(siteUrl({ NEXT_PHASE: BUILD, SITE_URL: "https://localhost.example.com" })).toBe("https://localhost.example.com");
  });
});

describe("prerendered SEO output under a build with the workstation .env", () => {
  it("writes public addresses into the home page canonical, og:url, sitemap and robots", () => {
    vi.stubEnv("SITE_URL", "http://localhost:3500");
    vi.stubEnv("NEXT_PHASE", BUILD);
    const home = pageMetadata({ title: "Home", description: "d", path: "" });
    expect(home.alternates?.canonical).toBe("https://wa.edwyz.com");
    expect((home.openGraph as { url?: string }).url).toBe("https://wa.edwyz.com");
    for (const e of sitemapEntries()) expect(e.url.startsWith("https://wa.edwyz.com")).toBe(true);
    expect(robots().sitemap).toBe("https://wa.edwyz.com/sitemap.xml");
  });

  it("renders robots.txt and sitemap.xml per request so they follow the running server, not the build machine", () => {
    expect(robotsRoute.dynamic).toBe("force-dynamic");
    expect(sitemapRoute.dynamic).toBe("force-dynamic");
  });
});
