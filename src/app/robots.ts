import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/config";

// Built per request so the Sitemap line uses the server's SITE_URL, not the one on the machine that ran the build.
export const dynamic = "force-dynamic";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: ["/oauth", "/webhooks", "/api", "/data-deletion/status", "/approve"] }],
    sitemap: `${siteUrl()}/sitemap.xml`,
  };
}
