/**
 * The only file in Eddy that holds Meta URLs (docs/EDDY-SPEC.md 6.15, 12.1a decision 10).
 *
 * Owner rule: people go to Meta only for screens that cannot be avoided. Eddy's consent screens (Embedded Signup and
 * Facebook Login for Business) open from an intent card and need no URL here. Besides those, decision 10 allows exactly three
 * screens that Meta offers no API for, each shown only as a clearly labelled "Opens Meta" link (catalogue key
 * `link.opens_meta`, rendered by MetaLinkButton in src/components/eddy/ActionCard.tsx):
 * - adding or fixing a payment method on the WhatsApp Business account (error 131042),
 * - business verification,
 * - display-name review (error 131037).
 *
 * Links are built here, by server code, from a screen id; never from model text. help.json `source` URLs are never
 * rendered, and tests/eddy-meta-links.test.ts fails when a Meta host appears anywhere else in src/lib/eddy,
 * src/components/eddy, src/lib/actions or in help.json's display fields.
 */

export const META_LINK_SCREENS = ["payment_method", "business_verification", "display_name"] as const;
export type MetaLinkScreen = (typeof META_LINK_SCREENS)[number];

/** What the card renders: the screen (its label is `meta.screen.<screen>`), the https URL and the "Opens Meta" label key. */
export type MetaLink = { screen: MetaLinkScreen; url: string; labelKey: "link.opens_meta" };

const URLS: Readonly<Record<MetaLinkScreen, string>> = Object.freeze({
  payment_method: "https://business.facebook.com/billing_hub/payment_settings",
  business_verification: "https://business.facebook.com/settings/security",
  display_name: "https://business.facebook.com/wa/manage/phone-numbers/",
});

export const isMetaLinkScreen = (v: unknown): v is MetaLinkScreen => typeof v === "string" && (META_LINK_SCREENS as readonly string[]).includes(v);

/** The labelled link for one of the three no-API screens, or null for anything else. */
export function metaLinkFor(screen: unknown): MetaLink | null {
  if (!isMetaLinkScreen(screen)) return null;
  return { screen, url: URLS[screen], labelKey: "link.opens_meta" };
}

/** WhatsApp error codes whose only fix is one of those screens. */
const SCREEN_FOR_ERROR: Readonly<Record<string, MetaLinkScreen>> = Object.freeze({
  "131042": "payment_method",
  "131037": "display_name",
});

/** The no-API Meta screen that fixes a WhatsApp error code, or null (most errors are fixed inside Edwyz). */
export function metaScreenForError(code: string | number | null | undefined): MetaLinkScreen | null {
  const key = String(code ?? "").trim();
  return SCREEN_FOR_ERROR[key] ?? null;
}
