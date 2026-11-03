/**
 * The only file in Eddy that holds Meta URLs (docs/EDDY-SPEC.md 6.15, 12.1a decision 10; docs/IG-PAGE-ADS-SPEC.md E-R2).
 *
 * Owner rule: people go to Meta only for screens that cannot be avoided. Eddy's consent screens (Embedded Signup and
 * Facebook Login for Business) open from an intent card and need no URL here. Besides those, decision 10 allows exactly three
 * screens that Meta offers no API for, each shown only as a clearly labelled "Opens Meta" link (catalogue key
 * `link.opens_meta`, rendered by MetaLinkButton in src/components/eddy/ActionCard.tsx):
 * - adding or fixing a payment method on the WhatsApp Business account (error 131042),
 * - business verification,
 * - display-name review (error 131037).
 *
 * E-R2 extends decision 10 to the ads screens of IG-PAGE-ADS-SPEC 8.4 under the same principle. Their addresses live only in
 * src/lib/meta-connect/meta-screens.ts; metaScreenHint() delegates those keys there (a lazy import, because meta-screens.ts
 * reads this file's three screens when it loads) and keeps its own three. The result is the `meta_screen` UI hint
 * (contract.ts MetaScreenHint) that ActionCard's MetaScreenButton renders.
 *
 * Links are built here, by server code, from a screen id; never from model text. help.json `source` URLs are never
 * rendered, and tests/eddy-meta-links.test.ts fails when a Meta host appears anywhere else in src/lib/eddy,
 * src/components/eddy, src/lib/actions or in help.json's display fields.
 *
 * Load order: meta-screens.ts calls metaLinkFor() while it loads. Everything that call touches is a function declaration (no
 * top-level constant), so it answers correctly whichever of the two modules loads first.
 */
import { isMetaScreenHintKey, type MetaScreenHint } from "./contract";

export const META_LINK_SCREENS = ["payment_method", "business_verification", "display_name"] as const;
export type MetaLinkScreen = (typeof META_LINK_SCREENS)[number];

/** What the card renders: the screen (its label is `meta.screen.<screen>`), the https URL and the "Opens Meta" label key. */
export type MetaLink = { screen: MetaLinkScreen; url: string; labelKey: "link.opens_meta" };

/** The three addresses (a switch, not a constant table, so a call during the other module's load never meets an uninitialised binding). */
function urlOf(screen: MetaLinkScreen): string {
  switch (screen) {
    case "payment_method":
      return "https://business.facebook.com/billing_hub/payment_settings";
    case "business_verification":
      return "https://business.facebook.com/settings/security";
    case "display_name":
      return "https://business.facebook.com/wa/manage/phone-numbers/";
  }
}

export function isMetaLinkScreen(v: unknown): v is MetaLinkScreen {
  return v === "payment_method" || v === "business_verification" || v === "display_name";
}

/** The labelled link for one of the three no-API screens, or null for anything else. */
export function metaLinkFor(screen: unknown): MetaLink | null {
  if (!isMetaLinkScreen(screen)) return null;
  return { screen, url: urlOf(screen), labelKey: "link.opens_meta" };
}

/** WhatsApp error codes whose only fix is one of those screens. */
function screenForErrorCode(code: string): MetaLinkScreen | null {
  if (code === "131042") return "payment_method";
  if (code === "131037") return "display_name";
  return null;
}

/** The no-API Meta screen that fixes a WhatsApp error code, or null (most errors are fixed inside Edwyz). */
export function metaScreenForError(code: string | number | null | undefined): MetaLinkScreen | null {
  return screenForErrorCode(String(code ?? "").trim());
}

/**
 * True for an address on Meta's own hosts over https, with no credentials: what an "Opens Meta" button may open. The card checks
 * every href with this before it renders one, so a hint that did not come from this file or meta-screens.ts shows nothing.
 */
export function isMetaHref(href: unknown): href is string {
  if (typeof href !== "string" || href.length === 0 || href.length > 1024) return false;
  try {
    const url = new URL(href);
    return url.protocol === "https:" && !url.username && !url.password && /(^|\.)facebook\.com$/.test(url.hostname);
  } catch {
    return false;
  }
}

/** Ids an ads screen's address may carry (a Page id, an ad account number); meta-screens.ts checks them (digits only). */
export type MetaScreenParams = { pageId?: string | null; act?: string | null };

/**
 * The E-R2 "Opens Meta" hint for a screen key, resolved on the server, or null for a key outside the allowlist or an address
 * that needs an id that is missing or malformed (no half-built link is ever shown). Eddy's own three screens keep their
 * addresses here and their `meta.screen.*` labels; the ads screens come from meta-connect/meta-screens.ts, with their promote
 * copy keys under `promote.` (E-R5).
 */
export async function metaScreenHint(key: unknown, params: MetaScreenParams = {}): Promise<MetaScreenHint | null> {
  if (!isMetaScreenHintKey(key)) return null;
  if (isMetaLinkScreen(key)) return { kind: "meta_screen", key, href: urlOf(key), labelKey: `meta.screen.${key}` };
  const { opensMetaLink } = await import("@/lib/meta-connect/meta-screens");
  const link = opensMetaLink(key, params);
  if (!link || !isMetaHref(link.href)) return null;
  const labelKey = link.labelKey.startsWith("meta.screen.") ? link.labelKey : `promote.${link.labelKey}`;
  return { kind: "meta_screen", key, href: link.href, labelKey };
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The hint for an address the server already resolved through meta-connect/meta-screens.ts (a readiness or review fix that
 * carries its `href`), checked again here: the key must be allowlisted and the address must be that screen's own, the
 * template's fixed text with digits only where an id goes. Anything else gives null, so a fix whose address came from
 * anywhere else (Meta's text, a model) never becomes a button.
 */
export async function metaScreenHintFromHref(key: unknown, href: unknown): Promise<MetaScreenHint | null> {
  if (!isMetaScreenHintKey(key) || !isMetaHref(href)) return null;
  if (isMetaLinkScreen(key)) return href === urlOf(key) ? { kind: "meta_screen", key, href, labelKey: `meta.screen.${key}` } : null;
  const { META_SCREENS } = await import("@/lib/meta-connect/meta-screens");
  const entry = META_SCREENS[key as keyof typeof META_SCREENS];
  if (!entry) return null;
  const pattern = new RegExp(`^${entry.urlTemplate.split(/\{(?:pageId|act)\}/).map(escapeRegExp).join("\\d{1,30}")}$`);
  if (!pattern.test(href)) return null;
  const labelKey = entry.labelKey.startsWith("meta.screen.") ? entry.labelKey : `promote.${entry.labelKey}`;
  return { kind: "meta_screen", key, href, labelKey };
}
