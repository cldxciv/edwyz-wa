/**
 * The only allowlist of "Opens Meta" screens for Instagram and Facebook Page ads (docs/IG-PAGE-ADS-SPEC.md 8.4, D19).
 *
 * Owner rule: people go to Meta only for screens Meta offers no API for. Every "Opens Meta" button in the ads pages and in
 * Eddy's promote cards is built from an entry here, on the server, from a screen key and a few validated ids; the browser
 * never writes a Meta address (src/components/promote/OpensMetaButton.tsx only renders the href it is given). A grep test
 * (tests/meta-screens-allowlist.test.ts) fails when a Meta host appears in src/lib/promote or src/components/promote, apart from
 * two named exemptions (an upload host and the preview iframe pattern).
 *
 * Eddy's own WhatsApp screens stay in src/lib/eddy/meta-links.ts (Eddy 12.1a decision 10). The two that the ads pages share,
 * payment_method and business_verification, are taken from there, never copied, and tagged for both workstreams.
 *
 * events_manager_pixel is not here: a pixel is created in Edwyz (C9, create_pixel) and its last visit is read through the API
 * (C7), so a trip to Events Manager is not needed. It comes back only if V-P18 shows the create is refused.
 *
 * Every URL template is VERIFY V-P16 (the screens move; the runbook opens each one).
 */
import { metaLinkFor } from "@/lib/eddy/meta-links";
import { META_SCREEN_KEYS, type MetaScreenKey } from "@/lib/promote/types";

export type { MetaScreenKey };

/** The workstreams that use a screen, for the two-way test in 3.2. */
export type MetaScreenTag = "promote" | "eddy";

/** Ids a template may carry: a Page id and an ad account number, digits only. */
export type MetaScreenParam = "pageId" | "act";
export type MetaScreenParams = Partial<Record<MetaScreenParam, string | null | undefined>>;

export type MetaScreenEntry = {
  key: MetaScreenKey;
  /** The copy key of the screen's label: a promote copy key, or Eddy's `meta.screen.*` key for the screens Eddy owns. */
  labelKey: string;
  /** The https address, with `{pageId}` or `{act}` where an id goes. */
  urlTemplate: string;
  /** Why it can't be done in Edwyz. */
  reason: string;
  tags: readonly MetaScreenTag[];
};

const eddyUrl = (screen: "payment_method" | "business_verification"): string => {
  const link = metaLinkFor(screen);
  if (!link) throw new Error(`Eddy has no Meta link for ${screen}.`);
  return link.url;
};

const entry = (key: MetaScreenKey, labelKey: string, urlTemplate: string, reason: string, tags: readonly MetaScreenTag[]): MetaScreenEntry =>
  Object.freeze({ key, labelKey, urlTemplate, reason, tags: Object.freeze([...tags]) });

/** 8.4, in the spec's order. */
export const META_SCREENS: Readonly<Record<MetaScreenKey, MetaScreenEntry>> = Object.freeze({
  payment_method: entry("payment_method", "meta.screen.payment_method", eddyUrl("payment_method"), "Meta has no API to add or fix a payment method.", ["eddy", "promote"]),
  business_verification: entry("business_verification", "meta.screen.business_verification", eddyUrl("business_verification"), "Business verification happens only in Meta's settings.", ["eddy", "promote"]),
  leadgen_tos: entry(
    "leadgen_tos",
    "readiness.leadgen_tos.fix",
    "https://www.facebook.com/ads/leadgen/tos?page_id={pageId}",
    "Edwyz can read whether the Page accepted Meta's lead ad terms, but Meta has no API to accept them.",
    ["promote"],
  ),
  custom_audience_tos: entry(
    "custom_audience_tos",
    "error.custom_audience_tos",
    "https://business.facebook.com/ads/manage/customaudiences/tos/?act={act}",
    "Meta's audience terms are accepted per person and business, and Meta has no API to accept them.",
    ["promote"],
  ),
  link_whatsapp_to_page: entry(
    "link_whatsapp_to_page",
    "readiness.whatsapp_page_link.hint",
    "https://www.facebook.com/settings/?tab=linked_whatsapp",
    "Linking a WhatsApp number to a Page needs a code Meta sends to the number, in the Page's own settings. There is no API.",
    ["promote"],
  ),
  link_instagram_to_page: entry(
    "link_instagram_to_page",
    "ig.fix.connect_own",
    "https://www.facebook.com/settings/?tab=linked_instagram",
    "Meta has no API to connect an existing Instagram account to a Page. Edwyz can create an ads-only identity instead.",
    ["promote"],
  ),
  page_advertise_task: entry(
    "page_advertise_task",
    "readiness.page_advertise.meta",
    "https://business.facebook.com/latest/settings/pages?selected_asset_id={pageId}",
    "Only a Page admin can give someone the Advertise permission, in Meta's business settings. The first fix stays in Edwyz: connect again as someone who has it.",
    ["promote"],
  ),
  lead_access_manager: entry(
    "lead_access_manager",
    "readiness.lead_access",
    "https://business.facebook.com/settings/leads-accesses",
    "Lead Access Manager is a business setting with no API.",
    ["promote"],
  ),
  appeal_ad: entry("appeal_ad", "status.appeal", "https://www.facebook.com/accountquality/", "Meta has no public API to ask for a rejected ad to be reviewed again.", ["promote"]),
  account_quality: entry(
    "account_quality",
    "status.appeal",
    "https://www.facebook.com/accountquality/",
    "Meta has no public API to see or appeal a restriction on an ad account, Page or Instagram account.",
    ["promote"],
  ),
});

export const isMetaScreenKey = (v: unknown): v is MetaScreenKey => typeof v === "string" && (META_SCREEN_KEYS as readonly string[]).includes(v);

/** The screens one workstream uses. */
export function metaScreensTagged(tag: MetaScreenTag): MetaScreenKey[] {
  return META_SCREEN_KEYS.filter((k) => META_SCREENS[k].tags.includes(tag));
}

/** The `{param}` names a template needs. */
export function templateParams(template: string): MetaScreenParam[] {
  return [...template.matchAll(/\{(pageId|act)\}/g)].map((m) => m[1] as MetaScreenParam);
}

const ID = /^\d{1,30}$/;

function paramValue(name: MetaScreenParam, raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const v = name === "act" ? raw.trim().replace(/^act_/, "") : raw.trim();
  return ID.test(v) ? v : null;
}

/** Meta's own hosts: the address must end on one of them, over https. */
function isMetaHttps(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && /(^|\.)facebook\.com$/.test(u.hostname) && !u.username && !u.password;
  } catch {
    return false;
  }
}

/**
 * The address of one screen, resolved on the server. Ids are checked (digits only) and encoded; a screen whose template needs
 * an id that is missing or malformed gives null, so no half-built link is ever shown. An unknown key gives null too.
 */
export function metaScreenHref(key: unknown, params: MetaScreenParams = {}): string | null {
  if (!isMetaScreenKey(key)) return null;
  const screen = META_SCREENS[key];
  let url = screen.urlTemplate;
  for (const name of templateParams(screen.urlTemplate)) {
    const value = paramValue(name, params[name]);
    if (value === null) return null;
    url = url.split(`{${name}}`).join(encodeURIComponent(value));
  }
  return isMetaHttps(url) ? url : null;
}

/** What an "Opens Meta" button needs, all resolved on the server. */
export type OpensMetaLink = { key: MetaScreenKey; labelKey: string; href: string };

export function opensMetaLink(key: unknown, params: MetaScreenParams = {}): OpensMetaLink | null {
  const href = metaScreenHref(key, params);
  return href && isMetaScreenKey(key) ? { key, labelKey: META_SCREENS[key].labelKey, href } : null;
}
