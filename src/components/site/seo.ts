import type { Metadata, MetadataRoute } from "next";
import { COMPANY, siteUrl } from "@/lib/config";

// Ads are not described here: Instagram and Facebook Page ads are coming soon, not live (docs/IG-PAGE-ADS-SPEC.md).
export const TAGLINE = "WhatsApp team inbox, broadcasts, chatbots and AI replies in one place";

export const HOME_TITLE = `${COMPANY.product}: WhatsApp team inbox, broadcasts, chatbots and AI in one place`;
export const HOME_DESCRIPTION =
  "Connect your WhatsApp Business number in about 5 minutes. Reply as a team, send broadcasts, automate with chatbots and an AI agent, and set spending limits.";

/** The share preview picture, served by src/app/og.png/route.tsx. */
export const OG_IMAGE = { path: "/og.png", width: 1200, height: 630, alt: `${COMPANY.product}: ${TAGLINE}` } as const;

type PageMeta = { title: string; description: string; path: string; noindex?: boolean; absoluteTitle?: boolean };

/**
 * Metadata for one public page. Every page declares its own canonical, Open Graph and Twitter tags here (the root layout
 * sets none), so a page can never inherit another page's canonical. siteUrl() is read when this runs, which is per
 * request because the public layouts render dynamically; see src/app/(site)/layout.tsx.
 */
export function pageMetadata({ title, description, path, noindex = false, absoluteTitle = false }: PageMeta): Metadata {
  const base = siteUrl();
  const url = `${base}${path}`;
  const shown = absoluteTitle ? title : `${title} | ${COMPANY.product}`;
  const image = { url: `${base}${OG_IMAGE.path}`, width: OG_IMAGE.width, height: OG_IMAGE.height, alt: OG_IMAGE.alt };
  return {
    title: absoluteTitle ? { absolute: title } : title,
    description,
    alternates: { canonical: url },
    robots: noindex ? { index: false, follow: false } : { index: true, follow: true },
    openGraph: { type: "website", siteName: COMPANY.product, locale: "en_IN", url, title: shown, description, images: [image] },
    twitter: { card: "summary_large_image", title: shown, description, images: [image.url] },
  };
}

export const SITEMAP_ENTRIES = [
  { path: "", changeFrequency: "weekly", priority: 1 },
  { path: "/pricing", changeFrequency: "weekly", priority: 0.9 },
  { path: "/signup", changeFrequency: "monthly", priority: 0.8 },
  { path: "/docs", changeFrequency: "monthly", priority: 0.6 },
  // The docs subpages (DOC_LINKS in src/app/(site)/docs/parts.tsx, minus the OpenAPI file); each sets its own canonical.
  { path: "/docs/authentication", changeFrequency: "monthly", priority: 0.5 },
  { path: "/docs/endpoints", changeFrequency: "monthly", priority: 0.5 },
  { path: "/docs/webhooks", changeFrequency: "monthly", priority: 0.5 },
  { path: "/docs/rate-limits", changeFrequency: "monthly", priority: 0.5 },
  { path: "/docs/errors", changeFrequency: "monthly", priority: 0.5 },
  { path: "/login", changeFrequency: "yearly", priority: 0.3 },
  { path: "/privacy", changeFrequency: "yearly", priority: 0.3 },
  { path: "/terms", changeFrequency: "yearly", priority: 0.3 },
  { path: "/data-deletion", changeFrequency: "yearly", priority: 0.3 },
] as const satisfies readonly { path: string; changeFrequency: MetadataRoute.Sitemap[number]["changeFrequency"]; priority: number }[];

export function sitemapEntries(): MetadataRoute.Sitemap {
  const base = siteUrl();
  return SITEMAP_ENTRIES.map((e) => ({ url: `${base}${e.path}`, changeFrequency: e.changeFrequency, priority: e.priority }));
}

export type JsonLdOffer = { name: string; pricePaise: number; currency: string };

export function organizationLd() {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: COMPANY.legalName,
    alternateName: COMPANY.product,
    url: siteUrl(),
    email: COMPANY.email,
    address: { "@type": "PostalAddress", streetAddress: COMPANY.address, addressCountry: "IN" },
  };
}

/** No ratings or review counts: we have none to report. Offers appear only when real plans are passed in. */
export function softwareApplicationLd(offers: JsonLdOffer[] = []) {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: COMPANY.product,
    applicationCategory: "BusinessApplication",
    operatingSystem: "Web",
    url: siteUrl(),
    description: HOME_DESCRIPTION,
    publisher: { "@type": "Organization", name: COMPANY.legalName },
    ...(offers.length > 0
      ? {
          offers: offers.map((o) => ({
            "@type": "Offer",
            name: o.name,
            price: (o.pricePaise / 100).toFixed(2),
            priceCurrency: o.currency,
          })),
        }
      : {}),
  };
}

export function faqLd(items: readonly { q: string; a: string }[]) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((i) => ({ "@type": "Question", name: i.q, acceptedAnswer: { "@type": "Answer", text: i.a } })),
  };
}

export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}
