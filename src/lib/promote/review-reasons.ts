/**
 * Ad review feedback and Meta errors in plain words (docs/IG-PAGE-ADS-SPEC.md 3.9, 4.10, 8.3a). Pure.
 *
 * - REVIEW_REASONS maps Meta's ad_review_feedback codes to a plain reason, what to do, and a fix kind (edit_text,
 *   edit_media, edit_link, appeal, set_category) in English, Hindi and Hinglish. Meta returns policy names as keys of
 *   `global` and of each placement in `placement_specific`; normalizeFeedbackCode() turns either form into a code.
 *   Unknown codes keep Meta's raw text under "Meta gave this reason: ..." (VERIFY V-P17 records the real codes).
 * - META_ERRORS holds the 4.10 rows: each Meta answer with its copy and fixes. classifyMetaError() reads code, subcode
 *   and the kinds the callers detect themselves.
 */
import type { SpecialAdCategory } from "@/lib/ads/types";
import { promoteText, promoteTextAll, type CopyVars, type PromoteCopyKey } from "./copy";
import type { MetaScreenKey, PromoteLang, ReviewFixKind } from "./types";

export type ReviewReason = {
  fix: ReviewFixKind;
  reasonKey: PromoteCopyKey;
  fixKey: PromoteCopyKey;
  /** set_category: the special ad category the copy should get. */
  category?: Exclude<SpecialAdCategory, "none">;
};

const r = (code: string, fix: ReviewFixKind, category?: Exclude<SpecialAdCategory, "none">): [string, ReviewReason] => [
  code,
  { fix, reasonKey: `review.reason.${code}` as PromoteCopyKey, fixKey: `review.fix.${code}` as PromoteCopyKey, ...(category ? { category } : {}) },
];

/** At least 25 codes (4.10). VERIFY V-P17: Meta's exact keys; aliases below catch the policy-name spellings. */
export const REVIEW_REASONS: Readonly<Record<string, ReviewReason>> = Object.fromEntries([
  r("TEXT_OVERLAY", "edit_media"),
  r("LANDING_PAGE_FAIL", "edit_link"),
  r("LOW_QUALITY_LANDING", "edit_link"),
  r("MISMATCHED_LANDING", "edit_link"),
  r("PERSONAL_ATTRIBUTES", "edit_text"),
  r("ADULT_CONTENT", "edit_media"),
  r("BRAND_USAGE", "edit_text"),
  r("SENSATIONAL_CONTENT", "edit_media"),
  r("VIOLENT_CONTENT", "edit_media"),
  r("PROFANITY", "edit_text"),
  r("GRAMMAR_PUNCTUATION", "edit_text"),
  r("MISLEADING_CLAIMS", "edit_text"),
  r("MISINFORMATION", "edit_text"),
  r("BEFORE_AFTER", "edit_media"),
  r("BODY_IMAGE", "edit_text"),
  r("HEALTH_CLAIMS", "edit_text"),
  r("PROHIBITED_PRODUCTS", "appeal"),
  r("TOBACCO", "appeal"),
  r("WEAPONS", "edit_media"),
  r("DRUGS", "edit_media"),
  r("ALCOHOL", "appeal"),
  r("GAMBLING", "appeal"),
  r("DATING", "appeal"),
  r("CRYPTOCURRENCY", "appeal"),
  r("FINANCIAL_PRODUCTS", "set_category", "credit"),
  r("EMPLOYMENT", "set_category", "employment"),
  r("HOUSING", "set_category", "housing"),
  r("SOCIAL_ISSUES", "set_category", "social_issues"),
  r("INTELLECTUAL_PROPERTY", "edit_media"),
  r("COUNTERFEIT", "edit_text"),
  r("MULTI_LEVEL_MARKETING", "edit_text"),
  r("CIRCUMVENTING_SYSTEMS", "appeal"),
  r("UNACCEPTABLE_BUSINESS_PRACTICES", "appeal"),
]);

/** The fallback for a code that is not mapped: Meta's own words, and "fix it or ask Meta to review again". */
export const OTHER_REASON: ReviewReason = { fix: "appeal", reasonKey: "review.reason.OTHER", fixKey: "review.fix.OTHER" };

/** Policy names and older spellings Meta uses, normalised, to our codes. */
const ALIASES: Readonly<Record<string, string>> = {
  IMAGE_TEXT: "TEXT_OVERLAY",
  TEXT_IN_IMAGE: "TEXT_OVERLAY",
  LANDING_PAGE_FUNCTIONALITY: "LANDING_PAGE_FAIL",
  NON_FUNCTIONAL_LANDING_PAGE: "LANDING_PAGE_FAIL",
  BROKEN_LINK: "LANDING_PAGE_FAIL",
  LOW_QUALITY_OR_DISRUPTIVE_CONTENT: "LOW_QUALITY_LANDING",
  LANDING_PAGE_MISMATCH: "MISMATCHED_LANDING",
  ADULT_NUDITY: "ADULT_CONTENT",
  ADULT_NUDITY_AND_SEXUAL_ACTIVITY: "ADULT_CONTENT",
  ADULT_SEXUAL_SOLICITATION: "ADULT_CONTENT",
  FACEBOOK_BRAND_USAGE: "BRAND_USAGE",
  INSTAGRAM_BRAND_USAGE: "BRAND_USAGE",
  META_BRAND_USAGE: "BRAND_USAGE",
  SENSATIONAL: "SENSATIONAL_CONTENT",
  VIOLENT_AND_GRAPHIC_CONTENT: "VIOLENT_CONTENT",
  VIOLENCE: "VIOLENT_CONTENT",
  GRAMMAR_PROFANITY: "PROFANITY",
  GRAMMAR_AND_PROFANITY: "PROFANITY",
  NONSTANDARD_PUNCTUATION: "GRAMMAR_PUNCTUATION",
  MISLEADING_OR_FALSE_CONTENT: "MISLEADING_CLAIMS",
  MISLEADING: "MISLEADING_CLAIMS",
  FALSE_CONTENT: "MISINFORMATION",
  BEFORE_AND_AFTER: "BEFORE_AFTER",
  PERSONAL_HEALTH_AND_APPEARANCE: "BODY_IMAGE",
  WEIGHT_LOSS: "BODY_IMAGE",
  HEALTH_AND_WELLNESS: "HEALTH_CLAIMS",
  PROHIBITED_CONTENT: "PROHIBITED_PRODUCTS",
  TOBACCO_AND_RELATED_PRODUCTS: "TOBACCO",
  WEAPONS_AMMUNITION_OR_EXPLOSIVES: "WEAPONS",
  UNSAFE_SUBSTANCES: "DRUGS",
  ILLEGAL_DRUGS: "DRUGS",
  ONLINE_GAMBLING_AND_GAMING: "GAMBLING",
  DATING_SERVICES: "DATING",
  CRYPTOCURRENCY_PRODUCTS_AND_SERVICES: "CRYPTOCURRENCY",
  FINANCIAL_AND_INSURANCE_PRODUCTS_AND_SERVICES: "FINANCIAL_PRODUCTS",
  CREDIT: "FINANCIAL_PRODUCTS",
  SPECIAL_AD_CATEGORY_CREDIT: "FINANCIAL_PRODUCTS",
  SPECIAL_AD_CATEGORY_EMPLOYMENT: "EMPLOYMENT",
  SPECIAL_AD_CATEGORY_HOUSING: "HOUSING",
  ISSUES_ELECTIONS_POLITICS: "SOCIAL_ISSUES",
  SOCIAL_ISSUES_ELECTIONS_OR_POLITICS: "SOCIAL_ISSUES",
  THIRD_PARTY_INFRINGEMENT: "INTELLECTUAL_PROPERTY",
  INTELLECTUAL_PROPERTY_INFRINGEMENT: "INTELLECTUAL_PROPERTY",
  COUNTERFEIT_GOODS: "COUNTERFEIT",
  MULTILEVEL_MARKETING: "MULTI_LEVEL_MARKETING",
  CIRCUMVENTING_SYSTEMS_POLICY: "CIRCUMVENTING_SYSTEMS",
  CIRCUMVENTION: "CIRCUMVENTING_SYSTEMS",
};

/** "Personal Attributes" or "personal_attributes" -> "PERSONAL_ATTRIBUTES"; aliases resolved. */
export function normalizeFeedbackCode(raw: string): string {
  const code = raw
    .normalize("NFKD")
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return ALIASES[code] ?? code;
}

export function reviewReasonOf(raw: string): { code: string; reason: ReviewReason; known: boolean } {
  const code = normalizeFeedbackCode(raw);
  const reason = REVIEW_REASONS[code];
  return reason ? { code, reason, known: true } : { code, reason: OTHER_REASON, known: false };
}

/** Meta's ad_review_feedback: `global` and `placement_specific` (per placement), each mapping a policy to a description. */
export type AdReviewFeedback = {
  global?: Record<string, string> | null;
  placement_specific?: Record<string, Record<string, string> | null> | null;
};

export type ExplainedReason = {
  code: string;
  /** null for the whole ad; else Meta's placement key (instagram, facebook, ...). */
  placement: string | null;
  fix: ReviewFixKind;
  category?: Exclude<SpecialAdCategory, "none">;
  /** The plain reason and what to do, and the full sentence ("Meta didn't approve this ad: ..."). */
  reason: string;
  whatToDo: string;
  sentence: string;
  /** Ask Meta to review again opens Meta's appeal screen (8.4). */
  opensMeta: MetaScreenKey;
};

/** Cap on Meta's raw text shown for an unknown code, so a long policy description cannot flood a card. */
const RAW_MAX = 160;

function explainOne(rawCode: string, rawText: string | undefined, placement: string | null, lang: PromoteLang): ExplainedReason {
  const { code, reason, known } = reviewReasonOf(rawCode);
  const raw = (rawText?.trim() || rawCode).slice(0, RAW_MAX);
  const vars: CopyVars = known ? {} : { raw };
  const reasonText = promoteText(reason.reasonKey, vars, lang);
  const whatToDo = promoteText(reason.fixKey, {}, lang);
  return {
    code,
    placement,
    fix: reason.fix,
    ...(reason.category ? { category: reason.category } : {}),
    reason: reasonText,
    whatToDo,
    sentence: promoteText("review.rejected", { reason: reasonText, fix: whatToDo }, lang),
    opensMeta: "appeal_ad",
  };
}

/**
 * Every reason in an ad_review_feedback object, in plain words (3.9). Placement-specific reasons carry their placement,
 * so the timeline can say "Not approved on Instagram: ... It still runs on Facebook."
 */
export function explainReviewFeedback(feedback: AdReviewFeedback | null | undefined, lang: PromoteLang = "en"): ExplainedReason[] {
  if (!feedback) return [];
  const out: ExplainedReason[] = [];
  for (const [code, text] of Object.entries(feedback.global ?? {})) out.push(explainOne(code, text, null, lang));
  for (const [placement, reasons] of Object.entries(feedback.placement_specific ?? {})) {
    for (const [code, text] of Object.entries(reasons ?? {})) out.push(explainOne(code, text, placement, lang));
  }
  return out;
}

/** A reason in all three languages (the review-status route returns the member's; tests check all). */
export function reviewReasonTexts(code: string): { reason: Record<PromoteLang, string>; whatToDo: Record<PromoteLang, string>; fix: ReviewFixKind } {
  const { reason, known } = reviewReasonOf(code);
  return { reason: promoteTextAll(reason.reasonKey, known ? {} : { raw: code }), whatToDo: promoteTextAll(reason.fixKey), fix: reason.fix };
}

// ===== Meta errors (4.10) =====

export type ErrorFix =
  | { kind: "opens_meta"; key: MetaScreenKey }
  | { kind: "reconnect" }
  | { kind: "in_app"; action: "new_ad_from_post" | "shorten_text" | "facebook_only" | "run_two_days" }
  | { kind: "retry_at" }
  | { kind: "raise_to_min" };

export const PROMOTE_ERROR_KINDS = [
  "custom_audience_tos",
  "leadgen_tos",
  "audience_flagged",
  "boost_ineligible",
  "meta_busy",
  "ad_creation_capped",
  "caption_too_long",
  "ig_not_usable",
  "ig_personal",
  "run_too_short",
  "account_restricted",
  "media_not_ready",
  "below_min",
] as const;
export type PromoteErrorKind = (typeof PROMOTE_ERROR_KINDS)[number];

/** The 4.10 table: each Meta answer, its copy and its fixes. Phase 0 refusals keep spend/copy.ts (fixes from cost.ts). */
export const META_ERRORS: Readonly<Record<PromoteErrorKind, { key: PromoteCopyKey; fixes: readonly ErrorFix[]; blocksStart: boolean }>> = {
  custom_audience_tos: { key: "error.custom_audience_tos", fixes: [{ kind: "opens_meta", key: "custom_audience_tos" }], blocksStart: false },
  leadgen_tos: { key: "error.leadgen_tos", fixes: [{ kind: "opens_meta", key: "leadgen_tos" }], blocksStart: true },
  audience_flagged: { key: "error.audience_flagged", fixes: [], blocksStart: false },
  boost_ineligible: { key: "error.boost_ineligible", fixes: [{ kind: "in_app", action: "new_ad_from_post" }], blocksStart: true },
  meta_busy: { key: "error.meta_busy", fixes: [{ kind: "retry_at" }], blocksStart: false },
  ad_creation_capped: { key: "error.ad_creation_capped", fixes: [], blocksStart: true },
  caption_too_long: { key: "error.caption_too_long", fixes: [{ kind: "in_app", action: "shorten_text" }], blocksStart: true },
  ig_not_usable: { key: "error.ig_not_usable", fixes: [{ kind: "reconnect" }, { kind: "in_app", action: "facebook_only" }], blocksStart: true },
  ig_personal: { key: "error.ig_personal", fixes: [{ kind: "reconnect" }], blocksStart: true },
  run_too_short: { key: "error.run_too_short", fixes: [{ kind: "in_app", action: "run_two_days" }], blocksStart: true },
  account_restricted: { key: "error.account_restricted", fixes: [{ kind: "opens_meta", key: "account_quality" }], blocksStart: true },
  media_not_ready: { key: "error.media_not_ready", fixes: [], blocksStart: true },
  below_min: { key: "error.below_min", fixes: [{ kind: "raise_to_min" }], blocksStart: true },
};

export type MetaErrorInput = {
  code?: number | null;
  /** Meta's error_subcode (graph/index.ts names it `subcode`). */
  subcode?: number | null;
  /** The same, as Meta's error body names it, so a caller can pass `error` straight through. */
  error_subcode?: number | null;
  /** The HTTP status Meta answered with (471 for a flagged audience). */
  status?: number | null;
  /** A kind the caller already knows (from discovery, validation or a 409 media_not_ready). */
  kind?: PromoteErrorKind;
};

/** Custom Audience terms not accepted: code 2655, or code 100 with subcode 1870090 (4.10; VERIFY in the runbook). */
const AUDIENCE_TERMS_SUBCODE = 1870090;
/** Lead Ads terms not accepted: code 100 with subcode 1892040 (VERIFY in the runbook). */
const LEADGEN_TERMS_SUBCODE = 1892040;

/** Which 4.10 row a Meta answer is; null when it is none of them (the caller shows its generic error). */
export function classifyMetaError(e: MetaErrorInput): PromoteErrorKind | null {
  if (e.kind) return e.kind;
  const subcode = e.subcode ?? e.error_subcode ?? null;
  if (e.code === 2655 || subcode === AUDIENCE_TERMS_SUBCODE) return "custom_audience_tos";
  if (subcode === LEADGEN_TERMS_SUBCODE) return "leadgen_tos";
  if (subcode === 1713232) return "audience_flagged";
  if (e.code === 613 && subcode === 1487225) return "ad_creation_capped";
  if (e.code === 613 || e.code === 17) return "meta_busy";
  return null;
}

/** The plain copy of a 4.10 row in the language. */
export function metaErrorText(kind: PromoteErrorKind, vars: CopyVars = {}, lang: PromoteLang = "en"): string {
  return promoteText(META_ERRORS[kind].key, vars, lang);
}
