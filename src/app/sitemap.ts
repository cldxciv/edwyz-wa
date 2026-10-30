import type { MetadataRoute } from "next";
import { sitemapEntries } from "@/components/site/seo";

// Built per request so the <loc> entries use the server's SITE_URL, not the one on the machine that ran the build.
export const dynamic = "force-dynamic";

export default function sitemap(): MetadataRoute.Sitemap {
  return sitemapEntries();
}
