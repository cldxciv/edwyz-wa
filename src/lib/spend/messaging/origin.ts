/**
 * Where an outbound WhatsApp message came from, and what Meta is likely to charge for it (docs/SPEND-CONTROLS-SPEC.md 4.9).
 * Pure: no database, no network, so the inbox enqueue path and the send gate can both import it.
 *
 * Every message is stamped with an origin when it is queued (queueOutbound, sendInteractive). The send gate (gate.ts) reads
 * the origin's class from ORIGIN_CLASS and applies the 4.9 table to it. `unknown` is what an unstamped caller gets while the
 * origin is optional; it behaves as automated, so an unstamped sender is held by freezes and the cost gate, never waved through.
 *
 * Bypass rule B13: no worker path (automation, chatbots, leads, commerce, broadcasts, worker) may claim `human`. Only the
 * inbox routes a signed-in member uses stamp it.
 */

/** Every origin a Message.origin can hold (0009 comment on "Message"."origin"). */
export const SEND_ORIGINS = [
  "human",
  "api",
  "mcp",
  "assistant",
  "broadcast",
  "automation",
  "chatbot",
  "ai_reply",
  "lead_sequence",
  "commerce",
  "consent",
  "approval",
  "admin_test",
  "system_notify",
  "eddy",
  "unknown",
] as const;
export type SendOrigin = (typeof SEND_ORIGINS)[number];

/** The rows of the 4.9 table. */
export type OriginClass = "human" | "compliance" | "platform" | "api" | "automated" | "eddy" | "assistant";

export const ORIGIN_CLASS: Readonly<Record<SendOrigin, OriginClass>> = Object.freeze({
  human: "human",
  approval: "human",
  consent: "compliance",
  system_notify: "platform",
  admin_test: "platform",
  api: "api",
  mcp: "api",
  broadcast: "automated",
  automation: "automated",
  chatbot: "automated",
  ai_reply: "automated",
  lead_sequence: "automated",
  commerce: "automated",
  unknown: "automated",
  eddy: "eddy",
  assistant: "assistant",
});

/**
 * Origins whose cost is always counted and never blocked (4.9 critic): the counter is incremented without the limit
 * conditions and the send is flagged over_limit when that takes the counter past the limit. A person's own message, a
 * STOP/START confirmation, the platform's own notices and a message the member confirmed on Eddy's card.
 */
export const NEVER_BLOCKED_BY_COST: ReadonlySet<SendOrigin> = new Set<SendOrigin>(["human", "approval", "consent", "system_notify", "eddy"]);

/** Conversational auto-replies: when the WhatsApp limit is used up they fail and hand the chat to the team (decision 2.3.12). */
export const HAND_OFF_ON_LIMIT: ReadonlySet<SendOrigin> = new Set<SendOrigin>(["chatbot", "ai_reply"]);

/** What a stored or queued row without a recognisable origin reads as (rows written before origins existed). */
export const DEFAULT_ORIGIN: SendOrigin = "unknown";

/**
 * The origin field of the inbox send inputs. Required (WP-11): every sender says who is sending, so tsc refuses a new send
 * path that forgets it. `unknown` is still accepted for a caller that truly cannot tell, and the gate treats it as automated.
 */
export type OriginField = { origin: SendOrigin };

export function isSendOrigin(value: unknown): value is SendOrigin {
  return typeof value === "string" && (SEND_ORIGINS as readonly string[]).includes(value);
}

/** A stored or queued origin; anything unrecognised is `unknown` (treated as automated). */
export function parseOrigin(value: unknown): SendOrigin {
  return isSendOrigin(value) ? value : DEFAULT_ORIGIN;
}

export function originClass(origin: SendOrigin): OriginClass {
  return ORIGIN_CLASS[origin] ?? "automated";
}

// ===== Pricing category =====

/** Meta's per-message pricing categories, plus SERVICE for free-form messages inside the 24-hour window. */
export const PRICING_CATEGORIES = ["MARKETING", "UTILITY", "AUTHENTICATION", "SERVICE"] as const;
export type PricingCategory = (typeof PRICING_CATEGORIES)[number];

/** Free-form text, media and interactive messages. */
export const FREE_FORM_CATEGORY: PricingCategory = "SERVICE";

/**
 * A template's category, or a category Meta reports in `statuses[].pricing.category`, as one of the four. Anything unknown is
 * MARKETING, the most expensive, so an estimate is never too low (4.9 bulk rules). Meta's variants map to their base category:
 * authentication_international is AUTHENTICATION, marketing_lite is MARKETING, referral_conversion (free entry point) is SERVICE.
 */
export function normalizeCategory(value: unknown): PricingCategory {
  const v = typeof value === "string" ? value.trim().toUpperCase().replace(/[\s-]+/g, "_") : "";
  if (!v) return "MARKETING";
  if (v.startsWith("AUTHENTICATION")) return "AUTHENTICATION";
  if (v.startsWith("UTILITY")) return "UTILITY";
  if (v === "SERVICE" || v === "REFERRAL_CONVERSION") return "SERVICE";
  return "MARKETING";
}

/** The category a queued message is stamped with: its template's (unknown template: MARKETING), or SERVICE for free-form. */
export function categoryForSend(type: string, templateCategory?: string | null): PricingCategory {
  if (type !== "template") return FREE_FORM_CATEGORY;
  return normalizeCategory(templateCategory);
}
