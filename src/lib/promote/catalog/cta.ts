/**
 * Calls to action by goal (docs/IG-PAGE-ADS-SPEC.md 4.3). Pure data plus one helper. The first type in `types` is the
 * default; "Button" under More options picks another from the same list (3.12). Every row is VERIFY until the runbook
 * (9.6) proves it, and creative-shapes.ts is the only place these become a creative body.
 */
import type { GoalKey } from "../types";

/** The link a Click-to-WhatsApp creative sends (4.3). */
export const WHATSAPP_LINK = "https://api.whatsapp.com/send";
/** The link a lead-form creative sends (4.3; Meta's short host, not a screen). */
export const LEAD_FORM_LINK = "https://fb.me/";
/** URL parameters added to website goals (4.3). Meta fills the {{...}} macros. */
export const DEFAULT_URL_TAGS = "utm_source=edwyz&utm_medium=paid_social&utm_campaign={{campaign.id}}&utm_content={{ad.id}}";

export type CtaValueFrom = "link" | "lead_form" | "page" | null;

export type CtaSpec = {
  goal: GoalKey;
  /** Allowed call-to-action types; the first is the default. Empty: the goal sends no button unless a link is given. */
  types: readonly string[];
  /** call_to_action.value apart from what `valueFrom` adds. */
  value: Readonly<Record<string, string>>;
  /** What call_to_action.value also carries: the link, the lead form id, or the Page id. */
  valueFrom: CtaValueFrom;
  /**
   * The creative's link when the goal fixes it (WhatsApp, lead forms). Otherwise the member's website link is used only by
   * goals whose button carries a link (valueFrom 'link'); chat goals and profile visits never send it, so a website link
   * cannot replace the chat or profile the button opens.
   */
  fixedLink: string | null;
  /** Website goals add url_tags (4.3). */
  urlTags: boolean;
  /** Chat goals carry page_welcome_message (VISUAL_EDITOR v2) with up to 3 ice breakers. */
  welcomeMessage: boolean;
  /** Runbook steps that prove the row (9.6). */
  verifyRefs: readonly string[];
};

export const CTA_BY_GOAL: Readonly<Record<GoalKey, CtaSpec>> = {
  whatsapp_chats: { goal: "whatsapp_chats", types: ["WHATSAPP_MESSAGE"], value: { app_destination: "WHATSAPP" }, valueFrom: null, fixedLink: WHATSAPP_LINK, urlTags: false, welcomeMessage: true, verifyRefs: ["V-P1", "V-P4"] },
  lead_form: { goal: "lead_form", types: ["SIGN_UP", "GET_QUOTE", "BOOK_NOW", "APPLY_NOW"], value: {}, valueFrom: "lead_form", fixedLink: LEAD_FORM_LINK, urlTags: false, welcomeMessage: false, verifyRefs: ["V-P1", "V-P7"] },
  website_visits: { goal: "website_visits", types: ["LEARN_MORE", "SHOP_NOW", "BOOK_NOW"], value: {}, valueFrom: "link", fixedLink: null, urlTags: true, welcomeMessage: false, verifyRefs: ["V-P1"] },
  // VERIFY V-P4: the docs show both INSTAGRAM_MESSAGE and MESSAGE_PAGE for Click-to-Instagram; the runbook picks one.
  instagram_dms: { goal: "instagram_dms", types: ["INSTAGRAM_MESSAGE", "MESSAGE_PAGE"], value: { app_destination: "INSTAGRAM_DIRECT" }, valueFrom: null, fixedLink: null, urlTags: false, welcomeMessage: true, verifyRefs: ["V-P4"] },
  messenger_chats: { goal: "messenger_chats", types: ["MESSAGE_PAGE"], value: { app_destination: "MESSENGER" }, valueFrom: null, fixedLink: null, urlTags: false, welcomeMessage: true, verifyRefs: ["V-P1"] },
  website_sales: { goal: "website_sales", types: ["SHOP_NOW", "LEARN_MORE", "BOOK_NOW"], value: {}, valueFrom: "link", fixedLink: null, urlTags: true, welcomeMessage: false, verifyRefs: ["V-P1"] },
  // VERIFY V-P4: the Instagram profile destination and its button.
  profile_visits: { goal: "profile_visits", types: ["VIEW_INSTAGRAM_PROFILE"], value: {}, valueFrom: null, fixedLink: null, urlTags: false, welcomeMessage: false, verifyRefs: ["V-P4"] },
  engagement: { goal: "engagement", types: [], value: {}, valueFrom: "link", fixedLink: null, urlTags: false, welcomeMessage: false, verifyRefs: ["V-P1"] },
  video_views: { goal: "video_views", types: [], value: {}, valueFrom: "link", fixedLink: null, urlTags: false, welcomeMessage: false, verifyRefs: ["V-P1", "V-P6"] },
  awareness: { goal: "awareness", types: [], value: {}, valueFrom: "link", fixedLink: null, urlTags: false, welcomeMessage: false, verifyRefs: ["V-P1"] },
  // VERIFY V-P1: the Page likes button carries the Page id.
  page_likes: { goal: "page_likes", types: ["LIKE_PAGE"], value: {}, valueFrom: "page", fixedLink: null, urlTags: false, welcomeMessage: false, verifyRefs: ["V-P1"] },
  // PRM-18: multi-destination needs asset_feed_spec's messaging destinations; the button is VERIFY.
  any_chat: { goal: "any_chat", types: ["MESSAGE_PAGE"], value: {}, valueFrom: null, fixedLink: null, urlTags: false, welcomeMessage: true, verifyRefs: ["V-P4"] },
};

/** The optional button for goals without one (engagement, video views, awareness) when the member adds a link. */
export const LINK_BUTTON_FALLBACK = "LEARN_MORE";

/** Every call-to-action type the catalog can emit. */
export const ALL_CTA_TYPES: readonly string[] = [...new Set([...Object.values(CTA_BY_GOAL).flatMap((c) => c.types), LINK_BUTTON_FALLBACK])];

/**
 * The button type for a goal: the member's choice when the goal allows it, else the default. Goals without a button get
 * LEARN_MORE only when a link is given, and null otherwise.
 */
export function ctaTypeFor(goal: GoalKey, chosen?: string | null, hasLink = false): string | null {
  const spec = CTA_BY_GOAL[goal];
  if (spec.types.length === 0) return hasLink ? LINK_BUTTON_FALLBACK : null;
  return chosen && spec.types.includes(chosen) ? chosen : spec.types[0];
}
