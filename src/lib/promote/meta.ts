/**
 * Graph calls for Instagram and Facebook Page ads that cannot spend (docs/IG-PAGE-ADS-SPEC.md 4.1, 4.2, 4.9, D18, PRM-03).
 * One typed method per call: C2 to C9, B1 to B5, M1 to M3, P1 and P2, L1, L2 and L4, A1 to A9, R1 and R2. Results reads (R3 to
 * R5) stay in the ads insights fetcher, the only reader of that edge (the scope-alignment test), and lead reads (L5, L6) in
 * leads/, which reuse `probeCapability` and the lead field lists here.
 *
 * Rules every method follows:
 * - Every request goes through graphFetchAs, so the spend tripwire sees it first. Before that, each request is classified here
 *   too, and anything but `not_spend` is refused before any network I/O (a bug guard: no method here can spend).
 * - Tokens: the Page token (getAssetAccess of the Page, or of an Instagram account, which carries its Page's token) for Page,
 *   Instagram, form and lead edges; the user token (the connection's, which an ad account asset uses) for every `act_` edge,
 *   videos, pixels, audiences, previews, search and reach. Previews always use the user token (Meta refuses Page tokens there).
 * - Previews use only the ad account's preview edge (P1) and a creative's previews (P2). The unscoped preview edge, whose
 *   previews anyone can open, is never called.
 * - Paging is capped per call, and each call has a deadline. Reads back off on 613 and 17; when they persist, or on any other
 *   rate-limit code, the scope cools down (throttle.ts). A POST that may have reached Meta is never repeated (graphFetchAs),
 *   and writes here are never retried at all.
 * - Capability probes (lead `platform` and `is_organic`, Page `whatsapp_number`): asked with the field, asked once more without
 *   it on error #100, and the answer is cached in PlatformSetting `promote:capabilities` for 7 days.
 * - Audience writes that change or delete (A2, A3, A4, A6) first check the id is a custom audience on ctx's own ad account
 *   (`account_id` and `subtype`), so a campaign id or another account's audience is refused before any write.
 * - The L2 lead form body is rebuilt from allowlisted keys at every depth; a consent box is never ticked in advance (D35).
 * - Writes (images, videos, Page-backed Instagram, pixels, lead forms, test leads, audiences and their rows, deletes) answer with
 *   fake ids and make no network call under SPEND_DRY_RUN (or a sandbox account with SPEND_SIM, as fakeMetaWrites says). The
 *   input and the asset are still checked first, so a dry run refuses what a real run would.
 * - Nothing here calls the guarded ads client or names a budget or end field. The payment-method read appears only in the ad
 *   account field list and only `fundingPresent` comes back.
 *
 * Text Meta returns (captions, post messages, preview bodies, pixel code) is passed back as it came, capped in length: callers
 * treat it as untrusted.
 */
import { createHash } from "node:crypto";
import { GraphError, graphFetchAs, type AppGraphRequest } from "@/lib/graph";
import { consentKind } from "@/lib/leads/fields";
import type { AssetAccess } from "@/lib/meta-connect";
import { BANNED_PARAMS, classify, SPEND_KEYS } from "@/lib/spend/classify";
import { SpendGuardBypassError } from "@/lib/spend/errors";
import { spendDryRun, spendSim } from "@/lib/spend/flags";
import { HttpError } from "@/lib/tenancy";
import {
  adAccountScope,
  DEFAULT_COOLDOWN_MS,
  instagramScope,
  isThrottleError,
  pageScope,
  parseUsageHeaders,
  platformSettingStore,
  PRIORITY,
  PromoteThrottledError,
  throttle as defaultThrottle,
  type SettingStore,
  type Throttle,
  type ThrottlePriority,
  type ThrottleUsage,
} from "./throttle";

type Env = Record<string, string | undefined>;

// =====================================================================================================================
// Limits
// =====================================================================================================================

/** Pages followed per call at most, whatever the caller asks. */
export const MAX_PAGES_PER_CALL = 5;
/** Items returned per call at most. */
export const MAX_ITEMS_PER_CALL = 250;
/** Deadline of a read call, all of its pages and back-offs included. */
export const READ_TIMEOUT_MS = 20_000;
/** Deadline of a write call (an image upload can be large). */
export const WRITE_TIMEOUT_MS = 60_000;
/**
 * The transport's own per-attempt limit is set this far past the call's deadline, so the deadline always fires first and ends
 * the call as PromoteMetaError('timeout') (ambiguous for a write) rather than a plain network error.
 */
export const TRANSPORT_GRACE_MS = 1_000;
/** Reads hit by 613 or 17 are tried this many times in all before the scope cools down. */
export const THROTTLE_ATTEMPTS = 3;
/** Back-off before each retry of a throttled read. */
export const THROTTLE_BACKOFF_MS: readonly number[] = [1_000, 3_000];
/** R1 and R2 send at most this many ids per request (4.9). */
export const REVIEW_BATCH = 50;
/** A2 and A3 send at most this many rows per request. */
export const MAX_AUDIENCE_ROWS = 10_000;
/** M1 image bytes at most (Meta's limit is 30 MB). */
export const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
/** How long a capability answer is kept (4.1). */
export const CAPABILITY_TTL_MS = 7 * 24 * 3_600_000;
/** PlatformSetting key of the capability answers. */
export const CAPABILITIES_KEY = "promote:capabilities";
/** How long an audience's ad account (checked before its writes) is kept, and how many are kept per process. */
export const AUDIENCE_OWNER_TTL_MS = 3_600_000;
const AUDIENCE_OWNER_CACHE_MAX = 500;
const AUDIENCE_SUBTYPE = /^[A-Z][A-Z_]{1,59}$/;
const NOT_OUR_AUDIENCE = "That isn't an audience on this ad account. Choose one of its audiences.";
/** Preview bodies kept per answer, and the longest kept. */
const MAX_PREVIEW_BODIES = 6;
const MAX_PREVIEW_BODY = 64 * 1024;
const MAX_TEXT = 5_000;

// =====================================================================================================================
// Field lists
// =====================================================================================================================

export const PAGE_READINESS_FIELDS = "leadgen_tos_accepted";
export const INSTAGRAM_IDENTITY_FIELDS = "id,username";
/** C4. The last item is the payment-method read: only its presence is kept (bypass rule B11 allows this list only). */
export const AD_ACCOUNT_HEALTH_FIELDS = "account_status,disable_reason,currency,timezone_name,business{id},tos_accepted,user_tos_accepted,funding_source_details{type}";
export const PIXEL_FIELDS = "id,name,last_fired_time,is_unavailable";
export const PIXEL_CODE_FIELDS = "id,name,code";
export const POST_FIELDS = "id,message,created_time,full_picture,permalink_url,status_type,attachments{media_type,media,subattachments},is_eligible_for_promotion,promotable_id";
export const MEDIA_FIELDS = "id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,boost_eligibility_info,boost_ads_list";
export const VIDEO_STATUS_FIELDS = "status,length,thumbnails{uri,is_preferred}";
export const LEAD_FORM_FIELDS = "id,name,status,locale,questions,privacy_policy_url,created_time,leads_count";
export const AUDIENCE_FIELDS = "approximate_count_lower_bound,approximate_count_upper_bound,operation_status,delivery_status";
/** Asked before an audience write: whose ad account the audience is on, and what kind it is (a campaign has no subtype). */
export const AUDIENCE_OWNER_FIELDS = "account_id,subtype";
export const AD_REVIEW_FIELDS = "id,effective_status,configured_status,ad_review_feedback,issues_info,adset{id,targeting},creative{effective_object_story_id,effective_instagram_media_id}";
export const CAMPAIGN_ADVANTAGE_FIELDS = "id,advantage_state_info";
/** L5 and L6 (leads/): the fields every lead read asks for. */
export const LEAD_FIELDS_BASE = "id,created_time,ad_id,adset_id,campaign_id,form_id,field_data,custom_disclaimer_responses";

/** The response key of the payment-method read, taken from the field list so its name is written only there. */
const FUNDING_KEY = AD_ACCOUNT_HEALTH_FIELDS.slice(AD_ACCOUNT_HEALTH_FIELDS.lastIndexOf(",") + 1).replace(/\{.*$/, "");

// =====================================================================================================================
// Capabilities (4.1)
// =====================================================================================================================

/** Fields Meta may not have, each probed once a week. */
export const CAPABILITY_FIELDS = {
  page_whatsapp_number: ["whatsapp_number"],
  lead_platform: ["platform", "is_organic"],
} as const satisfies Record<string, readonly string[]>;
export type CapabilityName = keyof typeof CAPABILITY_FIELDS;

/** L5 and L6 field list: the base fields, plus `platform` and `is_organic` when Meta has them. */
export function leadFieldList(withPlatform: boolean): string {
  return withPlatform ? `${LEAD_FIELDS_BASE},${CAPABILITY_FIELDS.lead_platform.join(",")}` : LEAD_FIELDS_BASE;
}

/** Error #100 from an unknown field. "Object does not exist" (subcode 33) is not that. */
export const isUnknownFieldError = (e: unknown): boolean => e instanceof GraphError && e.code === 100 && e.subcode !== 33;

// =====================================================================================================================
// Errors and small helpers
// =====================================================================================================================

/** What a person sees for each PromoteMetaError. An ambiguous write is never "try again": it may already be saved on Meta. */
export const PROMOTE_META_MESSAGES = {
  timeout: "Meta took too long to answer. Try again in a minute.",
  bad_response: "Meta sent an answer we couldn't read. Try again in a minute.",
  timeout_ambiguous: "Meta didn't confirm this in time. It may already be saved. Check before you try again.",
  bad_response_ambiguous: "Meta's answer didn't confirm this. It may already be saved. Check before you try again.",
} as const;

/**
 * Meta did not answer in time, or answered with something unreadable. Nothing was retried. `ambiguous` is true when a write was
 * cut off, or answered without the new object: it may have reached Meta, so it is shown as unknown and the caller looks before
 * it sends it again (never an automatic retry, and never copy that says to try again).
 */
export class PromoteMetaError extends HttpError {
  readonly kind: "timeout" | "bad_response";
  readonly ambiguous: boolean;
  constructor(kind: "timeout" | "bad_response", ambiguous = false) {
    super(kind === "timeout" ? 504 : 502, PROMOTE_META_MESSAGES[ambiguous ? (`${kind}_ambiguous` as const) : kind]);
    this.name = "PromoteMetaError";
    this.kind = kind;
    this.ambiguous = ambiguous;
  }
}

const OBJECT_ID = /^(?!act_)[A-Za-z0-9_]{1,64}$/;
const CURSOR = /^[A-Za-z0-9_=-]{1,512}$/;

/** A Meta object id safe to put in a path: letters, digits and underscores, and never an ad account. */
function objectId(value: unknown, what: string): string {
  if (typeof value !== "string" || !OBJECT_ID.test(value)) throw new HttpError(400, `Choose a valid ${what}.`);
  return value;
}

const str = (v: unknown, max = MAX_TEXT): string | null => (typeof v === "string" && v.length > 0 ? v.slice(0, max) : null);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : isObject(v) && Array.isArray(v.data) ? v.data : []);

function searchText(q: unknown): string {
  const text = typeof q === "string" ? q.trim().slice(0, 100) : "";
  if (text.length < 2) throw new HttpError(400, "Type at least two letters to search.");
  return text;
}

/** Keys that set spend, found at any depth of a value (a lead form body must have none). */
function spendKeysIn(value: unknown, depth = 0): string[] {
  if (depth > 16) return ["(too deep)"];
  const banned = new Set<string>([...SPEND_KEYS, ...BANNED_PARAMS]);
  if (Array.isArray(value)) return value.flatMap((v) => spendKeysIn(v, depth + 1));
  if (!isObject(value)) return [];
  return Object.entries(value).flatMap(([k, v]) => [...(banned.has(k) ? [k] : []), ...spendKeysIn(v, depth + 1)]);
}

// ----- Lead form bodies (L2): every nested object is rebuilt from allowlisted keys, so nothing else reaches Meta -----

const QUESTION_TYPE = /^[A-Z][A-Z0-9_]{1,59}$/;
const ENUM_VALUE = /^[A-Z][A-Z_]{1,39}$/;
const PHONE_TEXT = /^\+?[0-9][0-9 ()-]{3,28}$/;

const refuse = (message: string): never => {
  throw new HttpError(400, message);
};

/** Optional text, trimmed: refused when it is not text or is longer than `max`, left out when empty. */
function formText(v: unknown, max: number, message: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") return refuse(message);
  const t = v.trim();
  return t.length > max ? refuse(message) : t || undefined;
}

/** An optional web address (http or https only). */
function formUrl(v: unknown, message: string): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  let url: URL;
  try {
    url = new URL(String(v));
  } catch {
    return refuse(message);
  }
  return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : refuse(message);
}

const formObject = (v: unknown, message: string): Record<string, unknown> => (isObject(v) ? v : refuse(message));
const formEnum = (v: unknown, message: string): string | undefined => (v === undefined || v === null ? undefined : typeof v === "string" && ENUM_VALUE.test(v) ? v : refuse(message));
const defined = (o: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/** questions[]: {type, key, label, options[{key, value}]}. */
function formQuestion(v: unknown): Record<string, unknown> {
  const q = formObject(v, "Add between 1 and 15 questions.");
  const type = typeof q.type === "string" && QUESTION_TYPE.test(q.type) ? q.type : refuse("Choose a type for each question.");
  let options: Record<string, unknown>[] | undefined;
  if (q.options !== undefined) {
    if (!Array.isArray(q.options) || q.options.length < 1 || q.options.length > 50) refuse("A multiple-choice question needs between 1 and 50 answers.");
    options = (q.options as unknown[]).map((raw) => {
      const o = formObject(raw, "Each answer to choose from needs text.");
      const value = formText(o.value, 200, "Each answer to choose from can be up to 200 characters.") ?? refuse("Each answer to choose from needs text.");
      return defined({ key: formText(o.key, 100, "Each answer's key can be up to 100 characters."), value });
    });
  }
  return defined({
    type,
    key: formText(q.key, 100, "Each question's key can be up to 100 characters."),
    label: formText(q.label, 500, "Each question can be up to 500 characters."),
    options,
  });
}

/** thank_you_page: {title, body, button_type, button_text, website_url, business_phone_number}. */
function formThankYouPage(v: unknown): Record<string, unknown> {
  const t = formObject(v, "The thank-you page is not valid. Check it and try again.");
  const phone = formText(t.business_phone_number, 30, "The thank-you page's phone number is not valid.");
  if (phone !== undefined && !PHONE_TEXT.test(phone)) refuse("The thank-you page's phone number is not valid.");
  return defined({
    title: formText(t.title, 200, "The thank-you title can be up to 200 characters."),
    body: formText(t.body, 1000, "The thank-you message can be up to 1,000 characters."),
    button_type: formEnum(t.button_type, "Choose what the thank-you button does."),
    button_text: formText(t.button_text, 60, "The button text can be up to 60 characters."),
    website_url: formUrl(t.website_url, "The thank-you page's website link is not valid."),
    business_phone_number: phone,
  });
}

/**
 * custom_disclaimer.checkboxes[]: {key, text, is_required, is_checked_by_default}. Consent must be a clear action by the person
 * (D35, DPDP, WhatsApp's opt-in policy): no box is ever ticked for them, and a box that asks to message them stays optional.
 */
function formCheckbox(v: unknown): Record<string, unknown> {
  const c = formObject(v, "Each consent box needs text.");
  const text = formText(c.text, 1000, "Each consent box can be up to 1,000 characters.") ?? refuse("Each consent box needs text.");
  const key = formText(c.key, 100, "Each consent box's key can be up to 100 characters.");
  if (c.is_checked_by_default !== undefined && c.is_checked_by_default !== false) refuse("Consent boxes can't be ticked in advance. People must tick them themselves.");
  const required = c.is_required === true;
  // Read the way lead sync reads it (leads/form-definition.ts): a box that reads as messaging consent is never required.
  if (required && consentKind(key ?? "", text) !== null) refuse("The box that asks to message people must stay optional. Untick \"required\" and try again.");
  return defined({ key, text, is_required: required, is_checked_by_default: false });
}

/** custom_disclaimer: {title, body (text, or {text, url_entities[{offset, length, url}]}), checkboxes[]}. */
function formDisclaimer(v: unknown): Record<string, unknown> {
  const d = formObject(v, "The consent section is not valid. Check it and try again.");
  const bodyMessage = "The consent text can be up to 2,000 characters.";
  let body: unknown;
  if (isObject(d.body)) {
    const text = formText(d.body.text, 2000, bodyMessage);
    let links: Record<string, unknown>[] | undefined;
    if (d.body.url_entities !== undefined) {
      if (!Array.isArray(d.body.url_entities) || d.body.url_entities.length > 10) refuse("The consent text can have up to 10 links.");
      links = (d.body.url_entities as unknown[]).map((raw) => {
        const e = formObject(raw, "A link in the consent text is not valid.");
        const at = (n: unknown) => (Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) <= 2000 ? (n as number) : refuse("A link in the consent text is not valid."));
        return { offset: at(e.offset), length: at(e.length), url: formUrl(e.url, "A link in the consent text is not valid.") ?? refuse("A link in the consent text is not valid.") };
      });
    }
    body = text === undefined ? undefined : defined({ text, url_entities: links });
  } else body = formText(d.body, 2000, bodyMessage);
  let checkboxes: Record<string, unknown>[] | undefined;
  if (d.checkboxes !== undefined) {
    if (!Array.isArray(d.checkboxes) || d.checkboxes.length > 10) refuse("A form can have up to 10 consent boxes.");
    checkboxes = (d.checkboxes as unknown[]).map(formCheckbox);
  }
  return defined({ title: formText(d.title, 200, "The consent title can be up to 200 characters."), body, checkboxes });
}

/** context_card: {title, style, content[], button_text, cover_photo_id}. */
function formContextCard(v: unknown): Record<string, unknown> {
  const c = formObject(v, "The intro is not valid. Check it and try again.");
  let content: string[] | undefined;
  if (c.content !== undefined) {
    if (!Array.isArray(c.content) || c.content.length > 10) refuse("The intro can have up to 10 lines.");
    content = (c.content as unknown[]).map((line) => formText(line, 1000, "Each line of the intro must be text, up to 1,000 characters.")).filter((line): line is string => line !== undefined);
  }
  const cover = c.cover_photo_id;
  if (cover !== undefined && (typeof cover !== "string" || !OBJECT_ID.test(cover))) refuse("Choose a valid intro image.");
  return defined({
    title: formText(c.title, 200, "The intro title can be up to 200 characters."),
    style: formEnum(c.style, "Choose how the intro is laid out."),
    content,
    button_text: formText(c.button_text, 60, "The intro button text can be up to 60 characters."),
    cover_photo_id: cover,
  });
}

let fakeSeq = 0;
/** A recognisable fake Meta id for dry runs, never confused with a real numeric id (the ads client's format). */
const fakeId = (kind: string) => `dryrun_${kind}_${Date.now().toString(36)}${(++fakeSeq).toString(36)}`;

// =====================================================================================================================
// Shapes returned
// =====================================================================================================================

export type PageOf<T> = { items: T[]; after: string | null; complete: boolean };
export type ListOptions = { after?: string | null; maxPages?: number };

export type PageCtx = { tenantId: string; pageAssetId: string };
export type InstagramCtx = { tenantId: string; instagramAssetId: string };
export type AdCtx = { tenantId: string; adAccountAssetId: string };

export type PageReadiness = { leadgenTermsAccepted: boolean | null; whatsappNumber: string | null; whatsappNumberChecked: boolean };
export type InstagramIdentity = { id: string; username: string | null };
export type AdAccountHealth = {
  accountStatus: number | null;
  disableReason: number | null;
  currency: string | null;
  timezone: string | null;
  businessId: string | null;
  /** Meta's terms map (for example Custom Audience terms by id), as it came. */
  tosAccepted: Record<string, number>;
  userTosAccepted: Record<string, number>;
  /** A payment method is on the account. Nothing else about it is read or kept. */
  fundingPresent: boolean;
};
export type MinimumBudgets = { currency: string | null; minimumsMinor: Record<string, number> };
export type Pixel = { id: string; name: string | null; lastFiredAt: string | null; unavailable: boolean | null; code?: string | null };
export type FacebookPost = {
  id: string;
  message: string | null;
  createdTime: string | null;
  picture: string | null;
  permalink: string | null;
  statusType: string | null;
  mediaType: string | null;
  eligible: boolean | null;
  promotableId: string | null;
};
export type InstagramMedia = {
  id: string;
  caption: string | null;
  mediaType: string | null;
  productType: string | null;
  mediaUrl: string | null;
  thumbnailUrl: string | null;
  permalink: string | null;
  timestamp: string | null;
  /** Meta's boost eligibility, undocumented: a boolean when one is given, and the raw reason texts. */
  boost: { eligible: boolean | null; reasons: string[] };
  boostAdsCount: number | null;
};
export type AdImage = { hash: string; url: string | null; width: number | null; height: number | null };
export type AdVideoStatus = { id: string; state: "processing" | "ready" | "error" | "unknown"; progress: number | null; lengthSec: number | null; thumbnailUrl: string | null };
export type Previews = { bodies: string[] };
export type LeadFormSummary = {
  id: string;
  name: string | null;
  status: string | null;
  locale: string | null;
  questions: unknown[];
  privacyPolicyUrl: string | null;
  createdTime: string | null;
  leadsCount: number | null;
};
export type LeadFormSpec = {
  name: string;
  /** Meta's question objects ({type, key?, label?, options?[{key?, value}]}); at most 15. Other keys are dropped. */
  questions: Record<string, unknown>[];
  privacyPolicy: { url: string; linkText?: string };
  /** {title, body, button_type, button_text, website_url, business_phone_number}; other keys are dropped. */
  thankYouPage?: Record<string, unknown>;
  /** {title, body, checkboxes[{key, text, is_required}]}: a box is never ticked in advance, and a consent box is never required. */
  customDisclaimer?: Record<string, unknown>;
  /** {title, style, content[], button_text, cover_photo_id}; other keys are dropped. */
  contextCard?: Record<string, unknown>;
  locale?: string;
  optimizedForQuality?: boolean;
};
export type AudienceSource = { id: string; type: "ig_business" | "page" | "lead" };
export type AudienceSpec =
  | { kind: "customer_list"; name: string; description?: string }
  | { kind: "engagement"; name: string; sources: AudienceSource[]; event: string; retentionDays: number; description?: string }
  | { kind: "website"; name: string; pixelId: string; retentionDays: number; urlContains?: string[]; description?: string }
  | { kind: "lookalike"; name: string; originAudienceId: string; ratio: number; country?: string };
export const AUDIENCE_SCHEMA_KEYS = ["EMAIL", "PHONE", "FN", "LN", "COUNTRY"] as const;
export type AudienceSchemaKey = (typeof AUDIENCE_SCHEMA_KEYS)[number];
export type AudienceRows = { schema: AudienceSchemaKey[]; rows: string[][] };
export type AudienceSession = { id: number; batchSeq: number; last: boolean; estimatedTotal?: number };
export type AudienceUpload = { audienceId: string; sessionId: number; numReceived: number; numInvalid: number };
export type AudienceInfo = {
  id: string;
  lower: number | null;
  upper: number | null;
  operationStatus: { code: number | null; description: string | null } | null;
  deliveryStatus: { code: number | null; description: string | null } | null;
};
export type Place = { key: string; name: string; type: string | null; region: string | null; countryCode: string | null };
export type Interest = { id: string; name: string; audienceLow: number | null; audienceHigh: number | null; path: string[] };
export type ReachEstimate = { lower: number | null; upper: number | null };
/** One reason of ad_review_feedback. `code` is Meta's key as it came (often a policy title); review.ts normalises it. */
export type ReviewFeedback = { scope: string; code: string; text: string };
export type AdReview = {
  id: string;
  effectiveStatus: string | null;
  configuredStatus: string | null;
  feedback: ReviewFeedback[];
  /** Meta's ad_review_feedback object as it came, for ads/review.ts reviewFromMeta (the same input as the structure sync). */
  rawFeedback?: unknown;
  issues: { code: number | null; summary: string | null; message: string | null; level: string | null }[];
  adSetId: string | null;
  targeting: unknown;
  effectiveObjectStoryId: string | null;
  effectiveInstagramMediaId: string | null;
};
export type CampaignAdvantage = { id: string; state: Record<string, string> };

// =====================================================================================================================
// The catalogue of calls (tests walk it)
// =====================================================================================================================

export type TokenKind = "page" | "user";
export type PromoteCallId =
  | "C2" | "C3" | "C4" | "C5" | "C6" | "C7" | "C8" | "C9"
  | "B1" | "B2" | "B3" | "B4" | "B5"
  | "M1" | "M2" | "M3"
  | "P1" | "P2"
  | "L1" | "L2" | "L4"
  | "A1" | "A2" | "A3" | "A4" | "A5" | "A6" | "A7" | "A8" | "A9"
  | "R1" | "R2";

/** Each call: the method, the token it must use, its throttle priority and whether it writes. */
export const PROMOTE_CALLS: Readonly<Record<PromoteCallId, { method: string; token: TokenKind; priority: ThrottlePriority; write: boolean }>> = {
  C2: { method: "getPageReadiness", token: "page", priority: PRIORITY.interactive, write: false },
  C3: { method: "listPageBackedInstagram", token: "page", priority: PRIORITY.interactive, write: false },
  C4: { method: "getAdAccountHealth", token: "user", priority: PRIORITY.interactive, write: false },
  C5: { method: "getMinimumBudgets", token: "user", priority: PRIORITY.interactive, write: false },
  C6: { method: "listAdAccountInstagram", token: "user", priority: PRIORITY.interactive, write: false },
  C7: { method: "getPixel", token: "user", priority: PRIORITY.interactive, write: false },
  C8: { method: "createPageBackedInstagram", token: "page", priority: PRIORITY.interactive, write: true },
  C9: { method: "createPixel", token: "user", priority: PRIORITY.interactive, write: true },
  B1: { method: "listPublishedPosts", token: "page", priority: PRIORITY.interactive, write: false },
  B2: { method: "listPromotablePosts", token: "page", priority: PRIORITY.interactive, write: false },
  B3: { method: "getPostInstagramEligibility", token: "page", priority: PRIORITY.interactive, write: false },
  B4: { method: "listInstagramMedia", token: "page", priority: PRIORITY.interactive, write: false },
  B5: { method: "listInstagramStories", token: "page", priority: PRIORITY.interactive, write: false },
  M1: { method: "uploadAdImage", token: "user", priority: PRIORITY.interactive, write: true },
  M2: { method: "createAdVideo", token: "user", priority: PRIORITY.interactive, write: true },
  M3: { method: "getAdVideoStatus", token: "user", priority: PRIORITY.interactive, write: false },
  P1: { method: "generatePreviews", token: "user", priority: PRIORITY.interactive, write: false },
  P2: { method: "getCreativePreviews", token: "user", priority: PRIORITY.interactive, write: false },
  L1: { method: "listLeadForms", token: "page", priority: PRIORITY.interactive, write: false },
  L2: { method: "createLeadForm", token: "page", priority: PRIORITY.interactive, write: true },
  L4: { method: "sendTestLead", token: "page", priority: PRIORITY.interactive, write: true },
  A1: { method: "createCustomAudience", token: "user", priority: PRIORITY.interactive, write: true },
  A2: { method: "addAudienceUsers", token: "user", priority: PRIORITY.audiences, write: true },
  A3: { method: "replaceAudienceUsers", token: "user", priority: PRIORITY.audiences, write: true },
  // Taking people who withdrew consent out of an audience is a privacy duty: it is not held when usage is high.
  A4: { method: "removeAudienceUsers", token: "user", priority: PRIORITY.review, write: true },
  A5: { method: "getAudience", token: "user", priority: PRIORITY.interactive, write: false },
  A6: { method: "deleteAudience", token: "user", priority: PRIORITY.interactive, write: true },
  A7: { method: "searchPlaces", token: "user", priority: PRIORITY.interactive, write: false },
  A8: { method: "searchInterests", token: "user", priority: PRIORITY.interactive, write: false },
  A9: { method: "estimateReach", token: "user", priority: PRIORITY.interactive, write: false },
  R1: { method: "getAdsReview", token: "user", priority: PRIORITY.review, write: false },
  R2: { method: "getCampaignAdvantage", token: "user", priority: PRIORITY.review, write: false },
};

// =====================================================================================================================
// The client
// =====================================================================================================================

export type PromoteMetaDeps = {
  /** Decrypted access to one connected asset (getAssetAccess). */
  access: (tenantId: string, assetId: string) => Promise<AssetAccess>;
  /** Whether an ad account asset is a Meta sandbox account (only asked with SPEND_SIM). */
  sandbox: (tenantId: string, adAccountAssetId: string) => Promise<boolean>;
  /** Where capability answers are cached (PlatformSetting). */
  store: SettingStore;
  throttle: Throttle;
  env: Env;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  readTimeoutMs: number;
  writeTimeoutMs: number;
};

const defaultDeps = (): PromoteMetaDeps => ({
  access: async (tenantId, assetId) => (await import("@/lib/meta-connect")).getAssetAccess(tenantId, assetId),
  sandbox: async (tenantId, assetId) => (await import("@/lib/spend/sandbox")).sandboxFlagFor(tenantId, assetId),
  store: platformSettingStore,
  throttle: defaultThrottle,
  env: process.env,
  sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  now: Date.now,
  readTimeoutMs: READ_TIMEOUT_MS,
  writeTimeoutMs: WRITE_TIMEOUT_MS,
});

/** A request this module may send: classified `not_spend`, or refused before any network I/O. */
function assertNotSpend(request: AppGraphRequest): void {
  const c = classify({ method: request.method ?? "GET", path: request.path, query: request.query, body: request.body });
  if (c.class !== "not_spend") throw new SpendGuardBypassError("promote_meta_spend_class");
}

type Access = { token: string; scope: string };
type Pager = { token: string; scope: string; priority: ThrottlePriority; signal: AbortSignal; deadline: number };

export function createPromoteMeta(overrides: Partial<PromoteMetaDeps> = {}) {
  const deps: PromoteMetaDeps = { ...defaultDeps(), ...overrides };

  // ----- Tokens -----

  async function pageAccess(tenantId: string, assetId: string): Promise<Access & { pageId: string }> {
    const a = await deps.access(tenantId, assetId);
    if (a.type !== "page") throw new HttpError(400, "Choose a Facebook Page first.");
    return { token: a.token, scope: pageScope(objectId(a.externalId, "Facebook Page")), pageId: a.externalId };
  }

  async function instagramAccess(tenantId: string, assetId: string): Promise<Access & { igId: string }> {
    const a = await deps.access(tenantId, assetId);
    if (a.type !== "instagram") throw new HttpError(400, "Choose an Instagram account first.");
    return { token: a.token, scope: instagramScope(objectId(a.externalId, "Instagram account")), igId: a.externalId };
  }

  /** The user token: an ad account asset carries none of its own, so getAssetAccess gives the connection's. */
  async function adAccess(tenantId: string, assetId: string): Promise<Access & { act: string; num: string }> {
    const a = await deps.access(tenantId, assetId);
    if (a.type !== "ad_account") throw new HttpError(400, "Choose an ad account first.");
    const num = String(a.externalId ?? "").replace(/^act_/, "");
    if (!/^\d{1,30}$/.test(num)) throw new HttpError(400, "Choose a valid ad account.");
    return { token: a.token, scope: adAccountScope(num), act: `act_${num}`, num };
  }

  // ----- Dry run -----

  /** Writes are faked under SPEND_DRY_RUN (no further lookup), or for a sandbox ad account with SPEND_SIM (fakeMetaWrites). */
  async function fakeWrites(tenantId: string, adAccountAssetId: string | null): Promise<boolean> {
    if (spendDryRun(deps.env)) return true;
    if (!adAccountAssetId || !spendSim(deps.env)) return false;
    const sandbox = await deps.sandbox(tenantId, adAccountAssetId);
    const { fakeMetaWrites } = await import("@/lib/spend/sandbox");
    return fakeMetaWrites(sandbox, deps.env);
  }

  // ----- Sending -----

  async function withDeadline<T>(write: boolean, run: (signal: AbortSignal, deadline: number) => Promise<T>): Promise<T> {
    const ms = write ? deps.writeTimeoutMs : deps.readTimeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      return await run(controller.signal, deps.now() + ms);
    } catch (e) {
      if (controller.signal.aborted && !(e instanceof PromoteThrottledError) && !(e instanceof PromoteMetaError)) throw new PromoteMetaError("timeout", write);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  async function send<T>(p: Pager, request: AppGraphRequest): Promise<T> {
    assertNotSpend(request);
    await deps.throttle.check(p.scope, p.priority);
    const write = (request.method ?? "GET") !== "GET";
    for (let attempt = 1; ; attempt++) {
      const seen: { usage: ThrottleUsage | null } = { usage: null };
      try {
        const res = await graphFetchAs<T>(p.token, request, {
          signal: p.signal,
          timeoutMs: Math.max(0, p.deadline - deps.now()) + TRANSPORT_GRACE_MS,
          onHeaders: (h) => void (seen.usage = parseUsageHeaders(h)),
        });
        await deps.throttle.noteUsage(p.scope, seen.usage);
        return res;
      } catch (e) {
        await deps.throttle.noteUsage(p.scope, seen.usage);
        if (p.signal.aborted) throw new PromoteMetaError("timeout", write);
        if (!(e instanceof GraphError) || !isThrottleError(e.code, e.subcode)) throw e;
        const delay = THROTTLE_BACKOFF_MS[attempt - 1] ?? 0;
        // Reads back off and try again, unless Meta already said how long to wait; writes never repeat.
        if (!write && attempt < THROTTLE_ATTEMPTS && !seen.usage?.regainMs && deps.now() + delay < p.deadline) {
          await deps.sleep(delay);
          if (p.signal.aborted) throw new PromoteMetaError("timeout");
          continue;
        }
        const cooldown = await deps.throttle.noteError(p.scope, { code: e.code, subcode: e.subcode }, seen.usage);
        throw new PromoteThrottledError({ reason: "cooldown", until: cooldown?.until ?? new Date(deps.now() + DEFAULT_COOLDOWN_MS), metaCode: e.code ?? null, scope: p.scope, now: deps.now() });
      }
    }
  }

  async function one<T>(access: Access, priority: ThrottlePriority, request: AppGraphRequest): Promise<T> {
    const write = (request.method ?? "GET") !== "GET";
    return withDeadline(write, (signal, deadline) => send<T>({ token: access.token, scope: access.scope, priority, signal, deadline }, request));
  }

  type Paged<T> = { data?: T[]; paging?: { cursors?: { after?: string }; next?: string } };

  /** Follows cursors up to the per-call caps. `after` is the cursor to continue from next time, or null at the end. */
  async function pages<T>(access: Access, priority: ThrottlePriority, path: string, query: Record<string, string>, opts: ListOptions = {}, maxDefault = 1): Promise<PageOf<T>> {
    if (opts.after !== undefined && opts.after !== null && !CURSOR.test(opts.after)) throw new HttpError(400, "That list position is not valid. Start from the top.");
    const maxPages = Math.min(MAX_PAGES_PER_CALL, Math.max(1, Math.floor(opts.maxPages ?? maxDefault)));
    return withDeadline(false, async (signal, deadline) => {
      const items: T[] = [];
      let after: string | null = opts.after ?? null;
      for (let page = 0; page < maxPages; page++) {
        const res = await send<Paged<T>>({ token: access.token, scope: access.scope, priority, signal, deadline }, { method: "GET", path, query: { ...query, ...(after ? { after } : {}) } });
        if (res !== null && res !== undefined && !isObject(res)) throw new PromoteMetaError("bad_response");
        items.push(...(Array.isArray(res?.data) ? res.data : []));
        const cursor = res?.paging?.next ? res.paging.cursors?.after : undefined;
        after = typeof cursor === "string" && CURSOR.test(cursor) ? cursor : null;
        if (items.length >= MAX_ITEMS_PER_CALL) return { items: items.slice(0, MAX_ITEMS_PER_CALL), after: after ?? null, complete: false };
        if (!after) return { items, after: null, complete: true };
      }
      return { items, after, complete: false };
    });
  }

  // ----- Capability probes -----

  type CapabilityCache = Record<string, { supported: boolean; checkedAt: string }>;

  async function readCapabilities(): Promise<CapabilityCache> {
    try {
      const raw = await deps.store.get(CAPABILITIES_KEY);
      return isObject(raw) ? (raw as CapabilityCache) : {};
    } catch {
      return {};
    }
  }

  /** The cached answer while it is younger than 7 days, else null. */
  async function capability(name: CapabilityName): Promise<boolean | null> {
    const entry = (await readCapabilities())[name];
    if (!entry || typeof entry.supported !== "boolean") return null;
    const at = Date.parse(entry.checkedAt);
    if (!Number.isFinite(at) || deps.now() - at >= CAPABILITY_TTL_MS) return null;
    return entry.supported;
  }

  async function rememberCapability(name: CapabilityName, supported: boolean): Promise<void> {
    try {
      const all = await readCapabilities();
      all[name] = { supported, checkedAt: new Date(deps.now()).toISOString() };
      await deps.store.set(CAPABILITIES_KEY, all);
    } catch {
      // The probe simply runs again next time.
    }
  }

  /**
   * Runs a read with the capability's fields; on error #100 runs it once more without them. The answer (fields kept or dropped)
   * is cached for 7 days, so a missing field costs one extra call a week. A failure of the second read is thrown and not cached.
   */
  async function probeCapability<T>(name: CapabilityName, run: (withFields: boolean) => Promise<T>): Promise<{ result: T; supported: boolean }> {
    const known = await capability(name);
    if (known === false) return { result: await run(false), supported: false };
    try {
      const result = await run(true);
      if (known !== true) await rememberCapability(name, true);
      return { result, supported: true };
    } catch (e) {
      if (!isUnknownFieldError(e)) throw e;
      const result = await run(false);
      await rememberCapability(name, false);
      return { result, supported: false };
    }
  }

  // =================================================================================================================
  // Connect and readiness (C2 to C9)
  // =================================================================================================================

  /** C2: Lead Gen terms, and the WhatsApp number linked to the Page (capability-probed). */
  async function getPageReadiness(ctx: PageCtx): Promise<PageReadiness> {
    const a = await pageAccess(ctx.tenantId, ctx.pageAssetId);
    const { result, supported } = await probeCapability("page_whatsapp_number", (withField) =>
      one<Record<string, unknown>>(a, PRIORITY.interactive, {
        method: "GET",
        path: a.pageId,
        query: { fields: withField ? `${PAGE_READINESS_FIELDS},${CAPABILITY_FIELDS.page_whatsapp_number.join(",")}` : PAGE_READINESS_FIELDS },
      }),
    );
    return { leadgenTermsAccepted: bool(result?.leadgen_tos_accepted), whatsappNumber: supported ? str(result?.whatsapp_number, 40) : null, whatsappNumberChecked: supported };
  }

  const identity = (r: unknown): InstagramIdentity | null => (isObject(r) && typeof r.id === "string" && OBJECT_ID.test(r.id) ? { id: r.id, username: str(r.username, 100) } : null);

  /** C3: the Page's ads-only Instagram identities. */
  async function listPageBackedInstagram(ctx: PageCtx): Promise<InstagramIdentity[]> {
    const a = await pageAccess(ctx.tenantId, ctx.pageAssetId);
    const res = await pages<unknown>(a, PRIORITY.interactive, `${a.pageId}/page_backed_instagram_accounts`, { fields: INSTAGRAM_IDENTITY_FIELDS });
    return res.items.map(identity).filter((x): x is InstagramIdentity => x !== null);
  }

  /** C4: account health, terms, and whether a payment method exists (only that boolean is kept). */
  async function getAdAccountHealth(ctx: AdCtx): Promise<AdAccountHealth> {
    const a = await adAccess(ctx.tenantId, ctx.adAccountAssetId);
    const r = await one<Record<string, unknown>>(a, PRIORITY.interactive, { method: "GET", path: a.act, query: { fields: AD_ACCOUNT_HEALTH_FIELDS } });
    const terms = (v: unknown): Record<string, number> =>
      isObject(v) ? Object.fromEntries(Object.entries(v).filter(([k, n]) => /^[A-Za-z0-9_]{1,40}$/.test(k) && num(n) !== null).slice(0, 50).map(([k, n]) => [k, num(n) as number])) : {};
    const funding = r?.[FUNDING_KEY];
    return {
      accountStatus: num(r?.account_status),
      disableReason: num(r?.disable_reason),
      currency: str(r?.currency, 3),
      timezone: str(r?.timezone_name, 64),
      businessId: isObject(r?.business) ? str(r.business.id, 40) : null,
      tosAccepted: terms(r?.tos_accepted),
      userTosAccepted: terms(r?.user_tos_accepted),
      fundingPresent: isObject(funding) && funding.type !== undefined && funding.type !== null,
    };
  }

  /** C5: Meta's minimum daily amounts by billing kind, keyed by Meta's own field names (shape still to verify, V-P10). */
  async function getMinimumBudgets(ctx: AdCtx): Promise<MinimumBudgets> {
    const a = await adAccess(ctx.tenantId, ctx.adAccountAssetId);
    const r = await one<unknown>(a, PRIORITY.interactive, { method: "GET", path: `${a.act}/minimum_budgets` });
    const rows = list(r).filter(isObject);
    const row = rows[0] ?? (isObject(r) ? r : {});
    const minimumsMinor: Record<string, number> = {};
    for (const [k, v] of Object.entries(row)) {
      const n = num(v);
      if (/^min_[a-z_]{1,60}$/.test(k) && n !== null && n >= 0) minimumsMinor[k] = n;
    }
    return { currency: str(row.currency, 3), minimumsMinor };
  }

  /** C6: Instagram identities usable from the ad account (connected_instagram_accounts, or instagram_accounts on #100). */
  async function listAdAccountInstagram(ctx: AdCtx): Promise<{ items: InstagramIdentity[]; edge: "connected_instagram_accounts" | "instagram_accounts" }> {
    const a = await adAccess(ctx.tenantId, ctx.adAccountAssetId);
    const read = async (edge: "connected_instagram_accounts" | "instagram_accounts") => {
      const res = await pages<unknown>(a, PRIORITY.interactive, `${a.act}/${edge}`, { fields: INSTAGRAM_IDENTITY_FIELDS }, {}, 2);
      return { items: res.items.map(identity).filter((x): x is InstagramIdentity => x !== null), edge };
    };
    try {
      return await read("connected_instagram_accounts");
    } catch (e) {
      if (!isUnknownFieldError(e)) throw e;
      return read("instagram_accounts");
    }
  }

  /** C7 (and C9's install code): a pixel's readiness. */
  async function getPixel(ctx: AdCtx, pixelId: string, opts: { withCode?: boolean } = {}): Promise<Pixel> {
    const id = objectId(pixelId, "pixel");
    const a = await adAccess(ctx.tenantId, ctx.adAccountAssetId);
    const r = await one<Record<string, unknown>>(a, PRIORITY.interactive, { method: "GET", path: id, query: { fields: opts.withCode ? `${PIXEL_FIELDS},code` : PIXEL_FIELDS } });
    return {
      id: str(r?.id, 64) ?? id,
      name: str(r?.name, 200),
      lastFiredAt: str(r?.last_fired_time, 40),
      unavailable: bool(r?.is_unavailable),
      ...(opts.withCode ? { code: str(r?.code, 20_000) } : {}),
    };
  }

  /** C8: makes the Page's ads-only Instagram identity ("Run Instagram ads using your Page"). */
  async function createPageBackedInstagram(ctx: PageCtx): Promise<{ id: string }> {
    const a = await pageAccess(ctx.tenantId, ctx.pageAssetId);
    if (await fakeWrites(ctx.tenantId, null)) return { id: fakeId("page_backed_ig") };
    const r = await one<Record<string, unknown>>(a, PRIORITY.interactive, { method: "POST", path: `${a.pageId}/page_backed_instagram_accounts` });
    return { id: requireId(r) };
  }

  /** C9: a pixel on the ad account. Read its install code with getPixel(..., {withCode: true}). */
  async function createPixel(ctx: AdCtx, name: string): Promise<{ id: string }> {
    const label = typeof name === "string" ? name.trim().slice(0, 100) : "";
    if (!label) throw new HttpError(400, "Give the pixel a name.");
    const a = await adAccess(ctx.tenantId, ctx.adAccountAssetId);
    if (await fakeWrites(ctx.tenantId, ctx.adAccountAssetId)) return { id: fakeId("pixel") };
    const r = await one<Record<string, unknown>>(a, PRIORITY.interactive, { method: "POST", path: `${a.act}/adspixels`, body: { name: label } });
    return { id: requireId(r) };
  }

  /** The new object's id from a create's answer. Only writes call this: without the id the object may still exist on Meta. */
  function requireId(r: unknown): string {
    const id = isObject(r) ? r.id : undefined;
    if (typeof id !== "string" || !OBJECT_ID.test(id)) throw new PromoteMetaError("bad_response", true);
    return id;
  }

  // =================================================================================================================
  // Boost a post (B1 to B5)
  // =================================================================================================================

  const post = (r: unknown): FacebookPost | null => {
    if (!isObject(r) || typeof r.id !== "string" || !OBJECT_ID.test(r.id)) return null;
    const attachment = list(r.attachments)[0];
    return {
      id: r.id,
      message: str(r.message),
      createdTime: str(r.created_time, 40),
      picture: str(r.full_picture, 2000),
      permalink: str(r.permalink_url, 2000),
      statusType: str(r.status_type, 60),
      mediaType: isObject(attachment) ? str(attachment.media_type, 40) : null,
      eligible: bool(r.is_eligible_for_promotion),
      promotableId: typeof r.promotable_id === "string" && OBJECT_ID.test(r.promotable_id) ? r.promotable_id : null,
    };
  };

  async function postList(ctx: PageCtx, edge: "published_posts" | "promotable_posts", opts: ListOptions): Promise<PageOf<FacebookPost>> {
    const a = await pageAccess(ctx.tenantId, ctx.pageAssetId);
    const res = await pages<unknown>(a, PRIORITY.interactive, `${a.pageId}/${edge}`, { fields: POST_FIELDS, limit: "25" }, opts);
    return { ...res, items: res.items.map(post).filter((x): x is FacebookPost => x !== null) };
  }

  /** B1: the Page's published posts, newest first. */
  const listPublishedPosts = (ctx: PageCtx, opts: ListOptions = {}) => postList(ctx, "published_posts", opts);
  /** B2: promotable posts, including scheduled and unpublished ones (the fallback). */
  const listPromotablePosts = (ctx: PageCtx, opts: ListOptions = {}) => postList(ctx, "promotable_posts", opts);

  /** B3: whether a Page post can also run on Instagram. */
  async function getPostInstagramEligibility(ctx: PageCtx, postId: string): Promise<boolean | null> {
    const id = objectId(postId, "post");
    const a = await pageAccess(ctx.tenantId, ctx.pageAssetId);
    const r = await one<Record<string, unknown>>(a, PRIORITY.interactive, { method: "GET", path: id, query: { fields: "is_instagram_eligible" } });
    return bool(r?.is_instagram_eligible);
  }

  const media = (r: unknown): InstagramMedia | null => {
    if (!isObject(r) || typeof r.id !== "string" || !OBJECT_ID.test(r.id)) return null;
    const info = isObject(r.boost_eligibility_info) ? r.boost_eligibility_info : null;
    const reasons: string[] = [];
    let eligible: boolean | null = null;
    for (const v of Object.values(info ?? {})) {
      if (typeof v === "boolean" && eligible === null) eligible = v;
      else if (typeof v === "string" && v.trim() && reasons.length < 5) reasons.push(v.trim().slice(0, 300));
    }
    return {
      id: r.id,
      caption: str(r.caption),
      mediaType: str(r.media_type, 40),
      productType: str(r.media_product_type, 40),
      mediaUrl: str(r.media_url, 2000),
      thumbnailUrl: str(r.thumbnail_url, 2000),
      permalink: str(r.permalink, 2000),
      timestamp: str(r.timestamp, 40),
      boost: { eligible, reasons },
      boostAdsCount: r.boost_ads_list === undefined ? null : list(r.boost_ads_list).length,
    };
  };

  /** B4: the Instagram account's posts and reels, newest first. */
  async function listInstagramMedia(ctx: InstagramCtx, opts: ListOptions = {}): Promise<PageOf<InstagramMedia>> {
    const a = await instagramAccess(ctx.tenantId, ctx.instagramAssetId);
    const res = await pages<unknown>(a, PRIORITY.interactive, `${a.igId}/media`, { fields: MEDIA_FIELDS, limit: "25" }, opts);
    return { ...res, items: res.items.map(media).filter((x): x is InstagramMedia => x !== null) };
  }

  /** B5: the account's active stories. */
  async function listInstagramStories(ctx: InstagramCtx): Promise<InstagramMedia[]> {
    const a = await instagramAccess(ctx.tenantId, ctx.instagramAssetId);
    const res = await pages<unknown>(a, PRIORITY.interactive, `${a.igId}/stories`, { fields: MEDIA_FIELDS });
    return res.items.map(media).filter((x): x is InstagramMedia => x !== null);
  }

  // =================================================================================================================
  // Media (M1 to M3)
  // =================================================================================================================

  /** M1: an image for the ad account, from bytes or copied from another account. Returns its hash. */
  async function uploadAdImage(ctx: AdCtx, input: { bytes: Uint8Array } | { copyFrom: { sourceAccountId: string; hash: string } }): Promise<AdImage> {
    let body: Record<string, unknown>;
    if ("bytes" in input) {
      if (!(input.bytes instanceof Uint8Array) || input.bytes.length === 0) throw new HttpError(400, "Choose an image first.");
      if (input.bytes.length > MAX_IMAGE_BYTES) throw new HttpError(400, "This image is too large. Use one under 30 MB.");
      body = { bytes: Buffer.from(input.bytes).toString("base64") };
    } else {
      const source = String(input.copyFrom?.sourceAccountId ?? "").replace(/^act_/, "");
      const hash = String(input.copyFrom?.hash ?? "");
      if (!/^\d{1,30}$/.test(source) || !/^[A-Za-z0-9]{1,64}$/.test(hash)) throw new HttpError(400, "Choose a valid image to copy.");
      body = { copy_from: { source_account_id: source, hash } };
    }
    const a = await adAccess(ctx.tenantId, ctx.adAccountAssetId);
    if (await fakeWrites(ctx.tenantId, ctx.adAccountAssetId)) {
      const seed = "bytes" in input ? input.bytes : new TextEncoder().encode(JSON.stringify(body.copy_from));
      return { hash: `dryrun${createHash("sha256").update(seed).digest("hex").slice(0, 26)}`, url: null, width: null, height: null };
    }
    const r = await one<Record<string, unknown>>(a, PRIORITY.interactive, { method: "POST", path: `${a.act}/adimages`, body });
    const images = isObject(r?.images) ? Object.values(r.images) : [];
    const image = images.find(isObject);
    if (!image || typeof image.hash !== "string" || !/^[A-Za-z0-9]{1,64}$/.test(image.hash)) throw new PromoteMetaError("bad_response", true);
    return { hash: image.hash, url: str(image.url, 2000), width: num(image.width), height: num(image.height) };
  }

  /** M2: a video the ad account fetches from a signed URL. Poll getAdVideoStatus until it is ready. */
  async function createAdVideo(ctx: AdCtx, input: { fileUrl: string; name: string }): Promise<{ id: string }> {
    let url: URL;
    try {
      url = new URL(String(input.fileUrl ?? ""));
    } catch {
      throw new HttpError(400, "The video link is not valid.");
    }
    if (url.protocol !== "https:") throw new HttpError(400, "The video link must start with https.");
    const name = String(input.name ?? "").trim().slice(0, 100) || "Video";
    const a = await adAccess(ctx.tenantId, ctx.adAccountAssetId);
    if (await fakeWrites(ctx.tenantId, ctx.adAccountAssetId)) return { id: fakeId("video") };
    const r = await one<Record<string, unknown>>(a, PRIORITY.interactive, { method: "POST", path: `${a.act}/advideos`, body: { file_url: url.toString(), name } });
    return { id: requireId(r) };
  }

  /** M2 with PROMOTE_VIDEO=resumable: starts an upload session (the bytes go up from promote/media.ts). */
  async function startVideoUpload(ctx: AdCtx, fileSize: number): Promise<{ videoId: string; uploadUrl: string | null }> {
    if (!Number.isSafeInteger(fileSize) || fileSize < 1) throw new HttpError(400, "Choose a video first.");
    const a = await adAccess(ctx.tenantId, ctx.adAccountAssetId);
    if (await fakeWrites(ctx.tenantId, ctx.adAccountAssetId)) return { videoId: fakeId("video"), uploadUrl: null };
    const r = await one<Record<string, unknown>>(a, PRIORITY.interactive, { method: "POST", path: `${a.act}/video_ads`, body: { upload_phase: "start", file_size: fileSize } });
    const videoId = r?.video_id;
    if (typeof videoId !== "string" || !OBJECT_ID.test(videoId)) throw new PromoteMetaError("bad_response", true);
    return { videoId, uploadUrl: str(r?.upload_url, 2000) };
  }

  /** M2 with PROMOTE_VIDEO=resumable: finishes the upload session. */
  async function finishVideoUpload(ctx: AdCtx, videoId: string): Promise<{ success: boolean }> {
    const id = objectId(videoId, "video");
    const a = await adAccess(ctx.tenantId, ctx.adAccountAssetId);
    if (await fakeWrites(ctx.tenantId, ctx.adAccountAssetId)) return { success: true };
    const r = await one<Record<string, unknown>>(a, PRIORITY.interactive, { method: "POST", path: `${a.act}/video_ads`, body: { upload_phase: "finish", video_id: id } });
    return { success: r?.success !== false };
  }

  /** M3: a video's processing state, length and preferred thumbnail. */
  async function getAdVideoStatus(ctx: AdCtx, videoId: string): Promise<AdVideoStatus> {
    const id = objectId(videoId, "video");
    const a = await adAccess(ctx.tenantId, ctx.adAccountAssetId);
    const r = await one<Record<string, unknown>>(a, PRIORITY.interactive, { method: "GET", path: id, query: { fields: VIDEO_STATUS_FIELDS } });
    const status = isObject(r?.status) ? r.status : {};
    const raw = typeof status.video_status === "string" ? status.video_status.toLowerCase() : "";
    const state: AdVideoStatus["state"] = raw === "ready" ? "ready" : raw === "error" ? "error" : raw === "processing" || raw === "upload_complete" || raw === "uploading" ? "processing" : "unknown";
    const thumbs = list(r?.thumbnails).filter(isObject);
    const thumb = thumbs.find((t) => t.is_preferred === true) ?? thumbs[0];
    return { id, state, progress: num(status.processing_progress), lengthSec: num(r?.length), thumbnailUrl: thumb ? str(thumb.uri, 2000) : null };
  }

  // =================================================================================================================
  // Previews (P1, P2), always with the user token
  // =================================================================================================================

  const AD_FORMAT = /^[A-Z][A-Z0-9_]{2,59}$/;

  function previewBodies(r: unknown): Previews {
    const bodies = list(r)
      .filter(isObject)
      .map((row) => row.body)
      .filter((b): b is string => typeof b === "string" && b.length > 0 && b.length <= MAX_PREVIEW_BODY)
      .slice(0, MAX_PREVIEW_BODIES);
    return { bodies };
  }

  /** P1: Meta's preview of a creative spec before launch, scoped to the ad account. */
  async function generatePreviews(ctx: AdCtx, input: { creative: Record<string, unknown>; adFormat: string }): Promise<Previews> {
    if (!isObject(input.creative)) throw new HttpError(400, "There is nothing to preview yet.");
    if (!AD_FORMAT.test(String(input.adFormat ?? ""))) throw new HttpError(400, "Choose where to preview the ad.");
    const creative = JSON.stringify(input.creative);
    if (creative.length > 50_000) throw new HttpError(400, "This ad is too large to preview.");
    const a = await adAccess(ctx.tenantId, ctx.adAccountAssetId);
    const r = await one<unknown>(a, PRIORITY.interactive, { method: "GET", path: `act_${a.num}/generatepreviews`, query: { creative, ad_format: input.adFormat } });
    return previewBodies(r);
  }

  /** P2: Meta's preview of a launched creative. */
  async function getCreativePreviews(ctx: AdCtx, creativeId: string, adFormat: string): Promise<Previews> {
    const id = objectId(creativeId, "ad");
    if (!AD_FORMAT.test(String(adFormat ?? ""))) throw new HttpError(400, "Choose where to preview the ad.");
    const a = await adAccess(ctx.tenantId, ctx.adAccountAssetId);
    const r = await one<unknown>(a, PRIORITY.interactive, { method: "GET", path: `${id}/previews`, query: { ad_format: adFormat } });
    return previewBodies(r);
  }

  // =================================================================================================================
  // Lead forms (L1, L2, L4)
  // =================================================================================================================

  const form = (r: unknown): LeadFormSummary | null => {
    if (!isObject(r) || typeof r.id !== "string" || !OBJECT_ID.test(r.id)) return null;
    return {
      id: r.id,
      name: str(r.name, 200),
      status: str(r.status, 40),
      locale: str(r.locale, 20),
      questions: Array.isArray(r.questions) ? r.questions.slice(0, 50) : [],
      privacyPolicyUrl: str(r.privacy_policy_url, 2000),
      createdTime: str(r.created_time, 40),
      leadsCount: num(r.leads_count),
    };
  };

  /** L1: the Page's lead forms (up to 4 pages of 50 unless asked otherwise). */
  async function listLeadForms(ctx: PageCtx, opts: ListOptions = {}): Promise<PageOf<LeadFormSummary>> {
    const a = await pageAccess(ctx.tenantId, ctx.pageAssetId);
    const res = await pages<unknown>(a, PRIORITY.interactive, `${a.pageId}/leadgen_forms`, { fields: LEAD_FORM_FIELDS, limit: "50" }, opts, 4);
    return { ...res, items: res.items.map(form).filter((x): x is LeadFormSummary => x !== null) };
  }

  /**
   * The L2 body, built from allowlisted keys only, at every depth (the questions, thank-you page, consent section and intro are
   * rebuilt key by key; anything else is dropped). Refuses any spend key at any depth of what the caller gave, a consent box
   * ticked in advance, and a required box that asks to message people (D35).
   */
  function leadFormBody(spec: LeadFormSpec): Record<string, unknown> {
    const name = typeof spec?.name === "string" ? spec.name.trim() : "";
    if (!name || name.length > 200) throw new HttpError(400, "Give the form a name (up to 200 characters).");
    if (!Array.isArray(spec.questions) || spec.questions.length < 1 || spec.questions.length > 15 || !spec.questions.every(isObject)) {
      throw new HttpError(400, "Add between 1 and 15 questions.");
    }
    // A spend key anywhere in the input is a bug, refused before the allowlist could quietly drop it.
    if (spendKeysIn([spec.questions, spec.thankYouPage, spec.customDisclaimer, spec.contextCard]).length > 0) throw new SpendGuardBypassError("lead_form_spend_key");
    let privacy: URL;
    try {
      privacy = new URL(String(spec.privacyPolicy?.url ?? ""));
    } catch {
      throw new HttpError(400, "Add a link to your privacy policy.");
    }
    if (privacy.protocol !== "https:") throw new HttpError(400, "Your privacy policy link must start with https.");
    const linkText = String(spec.privacyPolicy?.linkText ?? "Privacy policy").trim().slice(0, 70) || "Privacy policy";
    const locale = typeof spec.locale === "string" && /^[a-z]{2}_[A-Z]{2}$/.test(spec.locale) ? spec.locale : "en_US";
    const body: Record<string, unknown> = {
      name,
      questions: spec.questions.map(formQuestion),
      privacy_policy: { url: privacy.toString(), link_text: linkText },
      locale,
      is_optimized_for_quality: spec.optimizedForQuality === true,
      block_display_for_non_targeted_viewer: false,
    };
    const given = (v: unknown) => v !== undefined && v !== null;
    if (given(spec.thankYouPage)) body.thank_you_page = formThankYouPage(spec.thankYouPage);
    if (given(spec.customDisclaimer)) body.custom_disclaimer = formDisclaimer(spec.customDisclaimer);
    if (given(spec.contextCard)) body.context_card = formContextCard(spec.contextCard);
    if (spendKeysIn(body).length > 0) throw new SpendGuardBypassError("lead_form_spend_key");
    if (JSON.stringify(body).length > 100_000) throw new HttpError(400, "This form is too large. Shorten the questions and try again.");
    return body;
  }

  /** L2: makes a lead form on the Page. */
  async function createLeadForm(ctx: PageCtx, spec: LeadFormSpec): Promise<{ id: string }> {
    const body = leadFormBody(spec);
    const a = await pageAccess(ctx.tenantId, ctx.pageAssetId);
    if (await fakeWrites(ctx.tenantId, null)) return { id: fakeId("leadform") };
    const r = await one<Record<string, unknown>>(a, PRIORITY.interactive, { method: "POST", path: `${a.pageId}/leadgen_forms`, body });
    return { id: requireId(r) };
  }

  /** L4: a test lead on the form, with the Page token. */
  async function sendTestLead(ctx: PageCtx, formId: string, fieldData?: { name: string; values: string[] }[]): Promise<{ id: string }> {
    const id = objectId(formId, "lead form");
    let body: Record<string, unknown> | undefined;
    if (fieldData !== undefined) {
      if (!Array.isArray(fieldData) || fieldData.length > 30) throw new HttpError(400, "Too many test answers.");
      body = {
        field_data: fieldData.map((f) => ({
          name: String(f?.name ?? "").slice(0, 100),
          values: (Array.isArray(f?.values) ? f.values : []).slice(0, 10).map((v) => String(v).slice(0, 500)),
        })),
      };
    }
    const a = await pageAccess(ctx.tenantId, ctx.pageAssetId);
    if (await fakeWrites(ctx.tenantId, null)) return { id: fakeId("testlead") };
    const r = await one<Record<string, unknown>>(a, PRIORITY.interactive, { method: "POST", path: `${id}/test_leads`, ...(body ? { body } : {}) });
    return { id: requireId(r) };
  }

  // =================================================================================================================
  // Audiences and targeting (A1 to A9)
  // =================================================================================================================

  const RETENTION_DAY = 86_400;
  const EVENT = /^[a-z][a-z0-9_]{2,60}$/;

  function audienceBody(spec: AudienceSpec): Record<string, unknown> {
    const name = typeof spec?.name === "string" ? spec.name.trim().slice(0, 100) : "";
    if (!name) throw new HttpError(400, "Give the audience a name.");
    const description = "description" in spec && typeof spec.description === "string" ? spec.description.trim().slice(0, 500) : undefined;
    const days = (n: unknown, max: number) => {
      const d = Math.floor(Number(n));
      if (!Number.isFinite(d) || d < 1 || d > max) throw new HttpError(400, `Choose between 1 and ${max} days.`);
      return d * RETENTION_DAY;
    };
    switch (spec.kind) {
      case "customer_list":
        return { name, subtype: "CUSTOM", customer_file_source: "USER_PROVIDED_ONLY", ...(description ? { description } : {}) };
      case "engagement": {
        if (!Array.isArray(spec.sources) || spec.sources.length < 1 || spec.sources.length > 10) throw new HttpError(400, "Choose where people engaged.");
        const sources = spec.sources.map((s) => {
          if (!["ig_business", "page", "lead"].includes(s?.type)) throw new HttpError(400, "Choose where people engaged.");
          return { id: objectId(s.id, "account"), type: s.type };
        });
        if (!EVENT.test(String(spec.event ?? ""))) throw new HttpError(400, "Choose what people did.");
        // Instagram and Page engagers: up to 730 days (3.7); lead forms: up to 90 (promote/audiences.ts enforces the per-kind bound).
        const rule = { inclusions: { operator: "or", rules: [{ event_sources: sources, retention_seconds: days(spec.retentionDays, 730), filter: { operator: "and", filters: [{ field: "event", operator: "eq", value: spec.event }] } }] } };
        return { name, rule, prefill: 1, ...(description ? { description } : {}) };
      }
      case "website": {
        const pixel = objectId(spec.pixelId, "pixel");
        const parts = (Array.isArray(spec.urlContains) ? spec.urlContains : []).map((u) => String(u).trim().slice(0, 200)).filter(Boolean).slice(0, 10);
        const filters = parts.length ? parts.map((value) => ({ field: "url", operator: "i_contains", value })) : [{ field: "url", operator: "i_contains", value: "" }];
        const rule = { inclusions: { operator: "or", rules: [{ event_sources: [{ id: pixel, type: "pixel" }], retention_seconds: days(spec.retentionDays, 180), filter: { operator: parts.length > 1 ? "or" : "and", filters } }] } };
        return { name, rule, prefill: 1, ...(description ? { description } : {}) };
      }
      case "lookalike": {
        const origin = objectId(spec.originAudienceId, "audience");
        const ratio = Number(spec.ratio);
        if (!Number.isFinite(ratio) || ratio < 0.01 || ratio > 0.2) throw new HttpError(400, "Choose a size between 1% and 20%.");
        const country = spec.country === undefined ? "IN" : String(spec.country);
        if (!/^[A-Z]{2}$/.test(country)) throw new HttpError(400, "Choose a country.");
        return { name, subtype: "LOOKALIKE", origin_audience_id: origin, lookalike_spec: { ratio, country, type: "similarity" } };
      }
      default:
        throw new HttpError(400, "Choose a kind of audience.");
    }
  }

  /** A1: a customer list, engagement, website or lookalike audience on the ad account. */
  async function createCustomAudience(ctx: AdCtx, spec: AudienceSpec): Promise<{ id: string }> {
    const body = audienceBody(spec);
    const a = await adAccess(ctx.tenantId, ctx.adAccountAssetId);
    if (await fakeWrites(ctx.tenantId, ctx.adAccountAssetId)) return { id: fakeId("audience") };
    const r = await one<Record<string, unknown>>(a, PRIORITY.interactive, { method: "POST", path: `${a.act}/customaudiences`, body });
    return { id: requireId(r) };
  }

  const HASHED = /^[0-9a-f]{64}$/;

  /** Rows must already be hashed (sha256 hex) by promote/hashing: plain text never leaves through here. */
  function audiencePayload(input: AudienceRows): { schema: string[]; data: string[][] } {
    const schema = Array.isArray(input?.schema) ? input.schema : [];
    if (schema.length < 1 || schema.length > AUDIENCE_SCHEMA_KEYS.length || !schema.every((k) => (AUDIENCE_SCHEMA_KEYS as readonly string[]).includes(k)) || new Set(schema).size !== schema.length) {
      throw new HttpError(400, "The customer list columns are not valid.");
    }
    const rows = Array.isArray(input.rows) ? input.rows : [];
    if (rows.length < 1) throw new HttpError(400, "There are no customers to send.");
    if (rows.length > MAX_AUDIENCE_ROWS) throw new HttpError(400, `Send at most ${MAX_AUDIENCE_ROWS.toLocaleString("en-IN")} customers at a time.`);
    for (const row of rows) {
      if (!Array.isArray(row) || row.length !== schema.length || !row.every((v) => v === "" || (typeof v === "string" && HASHED.test(v)))) {
        throw new HttpError(400, "Customer details must be hashed before they are sent.");
      }
    }
    return { schema: [...schema], data: rows.map((r) => [...r]) };
  }

  function sessionBody(s: AudienceSession, rows: number): Record<string, unknown> {
    if (!Number.isSafeInteger(s?.id) || s.id < 1 || !Number.isSafeInteger(s.batchSeq) || s.batchSeq < 1) throw new HttpError(400, "The upload session is not valid.");
    return {
      session_id: s.id,
      batch_seq: s.batchSeq,
      last_batch_flag: s.last === true,
      ...(Number.isSafeInteger(s.estimatedTotal) && (s.estimatedTotal as number) >= rows ? { estimated_num_total: s.estimatedTotal } : {}),
    };
  }

  const audienceOwners = new Map<string, { subtype: string; at: number }>();

  /**
   * Before every audience write that changes or deletes (A2, A3, A4, A6): the id must be a custom audience on ctx's own ad
   * account. The ad account only picks the token, and the same Meta user can reach a campaign, or another workspace's audience,
   * by id; a DELETE classifies as not_spend, so without this check a wrong id could delete a live campaign out of the Spend
   * Book's sight. Asked once per audience and kept for an hour (an audience never moves to another account). Not asked for a
   * faked write, which touches nothing on Meta.
   */
  async function assertOwnAudience(a: Access & { num: string }, aud: string, priority: ThrottlePriority, customerList: boolean): Promise<void> {
    const key = `${a.num}:${aud}`;
    let known = audienceOwners.get(key);
    if (!known || deps.now() - known.at >= AUDIENCE_OWNER_TTL_MS) {
      let r: Record<string, unknown> | null;
      try {
        r = await one<Record<string, unknown>>(a, priority, { method: "GET", path: aud, query: { fields: AUDIENCE_OWNER_FIELDS } });
      } catch (e) {
        // Meta's #100 for an unknown field: the id is a campaign, ad set, ad, Page or person, not an audience.
        if (isUnknownFieldError(e)) throw new HttpError(400, NOT_OUR_AUDIENCE);
        throw e;
      }
      const owner = String(r?.account_id ?? "").replace(/^act_/, "");
      const subtype = typeof r?.subtype === "string" && AUDIENCE_SUBTYPE.test(r.subtype) ? r.subtype : null;
      if (owner !== a.num || subtype === null) throw new HttpError(400, NOT_OUR_AUDIENCE);
      known = { subtype, at: deps.now() };
      if (audienceOwners.size >= AUDIENCE_OWNER_CACHE_MAX) audienceOwners.delete(audienceOwners.keys().next().value as string);
      audienceOwners.set(key, known);
    }
    if (customerList && known.subtype !== "CUSTOM") throw new HttpError(400, "Customers can only be added to or removed from a customer list audience.");
  }

  async function uploadRows(ctx: AdCtx, audienceId: string, edge: "users" | "usersreplace", input: AudienceRows, session: AudienceSession): Promise<AudienceUpload> {
    const aud = objectId(audienceId, "audience");
    const payload = audiencePayload(input);
    const sessionPart = sessionBody(session, payload.data.length);
    const a = await adAccess(ctx.tenantId, ctx.adAccountAssetId);
    if (await fakeWrites(ctx.tenantId, ctx.adAccountAssetId)) return { audienceId: aud, sessionId: session.id, numReceived: payload.data.length, numInvalid: 0 };
    await assertOwnAudience(a, aud, PRIORITY.audiences, true);
    const r = await one<Record<string, unknown>>(a, PRIORITY.audiences, { method: "POST", path: `${aud}/${edge}`, body: { payload, session: sessionPart } });
    return { audienceId: str(r?.audience_id, 64) ?? aud, sessionId: num(r?.session_id) ?? session.id, numReceived: num(r?.num_received) ?? 0, numInvalid: num(r?.num_invalid_entries) ?? 0 };
  }

  /** A2: adds hashed customer rows (at most 10,000 per call) within an upload session. */
  const addAudienceUsers = (ctx: AdCtx, audienceId: string, input: AudienceRows, session: AudienceSession) => uploadRows(ctx, audienceId, "users", input, session);
  /** A3: replaces the audience's rows without resetting learning (a 90-minute session). */
  const replaceAudienceUsers = (ctx: AdCtx, audienceId: string, input: AudienceRows, session: AudienceSession) => uploadRows(ctx, audienceId, "usersreplace", input, session);

  /** A4: removes hashed rows (erasure and opt-out). */
  async function removeAudienceUsers(ctx: AdCtx, audienceId: string, input: AudienceRows): Promise<{ numReceived: number }> {
    const aud = objectId(audienceId, "audience");
    const payload = audiencePayload(input);
    const a = await adAccess(ctx.tenantId, ctx.adAccountAssetId);
    if (await fakeWrites(ctx.tenantId, ctx.adAccountAssetId)) return { numReceived: payload.data.length };
    await assertOwnAudience(a, aud, PROMOTE_CALLS.A4.priority, true);
    const r = await one<Record<string, unknown>>(a, PROMOTE_CALLS.A4.priority, { method: "DELETE", path: `${aud}/users`, body: { payload } });
    return { numReceived: num(r?.num_received) ?? payload.data.length };
  }

  /** A5: an audience's size range and status. */
  async function getAudience(ctx: AdCtx, audienceId: string): Promise<AudienceInfo> {
    const aud = objectId(audienceId, "audience");
    const a = await adAccess(ctx.tenantId, ctx.adAccountAssetId);
    const r = await one<Record<string, unknown>>(a, PRIORITY.interactive, { method: "GET", path: aud, query: { fields: AUDIENCE_FIELDS } });
    const status = (v: unknown) => (isObject(v) ? { code: num(v.code), description: str(v.description, 500) } : null);
    return { id: aud, lower: num(r?.approximate_count_lower_bound), upper: num(r?.approximate_count_upper_bound), operationStatus: status(r?.operation_status), deliveryStatus: status(r?.delivery_status) };
  }

  /** A6: deletes an audience on Meta (only one on this ad account: never a campaign, ad set or ad). */
  async function deleteAudience(ctx: AdCtx, audienceId: string): Promise<{ deleted: boolean }> {
    const aud = objectId(audienceId, "audience");
    const a = await adAccess(ctx.tenantId, ctx.adAccountAssetId);
    if (await fakeWrites(ctx.tenantId, ctx.adAccountAssetId)) return { deleted: true };
    await assertOwnAudience(a, aud, PRIORITY.interactive, false);
    const r = await one<Record<string, unknown>>(a, PRIORITY.interactive, { method: "DELETE", path: aud });
    return { deleted: r?.success !== false };
  }

  const PLACE_TYPES = ["city", "zip", "region"] as const;

  /** A7: cities, PIN codes and states by name. */
  async function searchPlaces(ctx: AdCtx, q: string, opts: { types?: (typeof PLACE_TYPES)[number][]; countryCode?: string } = {}): Promise<Place[]> {
    const text = searchText(q);
    const types = (opts.types ?? [...PLACE_TYPES]).filter((t) => (PLACE_TYPES as readonly string[]).includes(t));
    const country = opts.countryCode ?? "IN";
    if (!types.length || !/^[A-Z]{2}$/.test(country)) throw new HttpError(400, "Choose what kind of place to look for.");
    const a = await adAccess(ctx.tenantId, ctx.adAccountAssetId);
    const r = await one<unknown>(a, PRIORITY.interactive, { method: "GET", path: "search", query: { type: "adgeolocation", location_types: JSON.stringify(types), country_code: country, q: text, limit: "25" } });
    return list(r)
      .filter(isObject)
      .filter((p) => (typeof p.key === "string" || typeof p.key === "number") && typeof p.name === "string")
      .slice(0, 25)
      .map((p) => ({ key: String(p.key).slice(0, 64), name: String(p.name).slice(0, 200), type: str(p.type, 30), region: str(p.region, 200), countryCode: str(p.country_code, 2) }));
  }

  /** A8: interests by name. */
  async function searchInterests(ctx: AdCtx, q: string): Promise<Interest[]> {
    const text = searchText(q);
    const a = await adAccess(ctx.tenantId, ctx.adAccountAssetId);
    const r = await one<unknown>(a, PRIORITY.interactive, { method: "GET", path: "search", query: { type: "adinterest", q: text, limit: "25" } });
    return list(r)
      .filter(isObject)
      .filter((i) => typeof i.id === "string" && OBJECT_ID.test(i.id) && typeof i.name === "string")
      .slice(0, 25)
      .map((i) => ({
        id: String(i.id),
        name: String(i.name).slice(0, 200),
        audienceLow: num(i.audience_size_lower_bound),
        audienceHigh: num(i.audience_size_upper_bound),
        path: Array.isArray(i.path) ? i.path.filter((s): s is string => typeof s === "string").slice(0, 8).map((s) => s.slice(0, 100)) : [],
      }));
  }

  /** A9: how many people a targeting spec reaches (only the two bounds are used). */
  async function estimateReach(ctx: AdCtx, targeting: Record<string, unknown>): Promise<ReachEstimate> {
    if (!isObject(targeting)) throw new HttpError(400, "Choose who should see the ad.");
    const spec = JSON.stringify(targeting);
    if (spec.length > 50_000) throw new HttpError(400, "This audience is too detailed to size.");
    const a = await adAccess(ctx.tenantId, ctx.adAccountAssetId);
    const r = await one<Record<string, unknown>>(a, PRIORITY.interactive, { method: "GET", path: `${a.act}/reachestimate`, query: { targeting_spec: spec } });
    const data = isObject(r?.data) ? r.data : list(r).find(isObject) ?? {};
    return { lower: num(data.users_lower_bound), upper: num(data.users_upper_bound) };
  }

  // =================================================================================================================
  // Review status (R1, R2)
  // =================================================================================================================

  /**
   * A feedback key as Meta sends it: a code ("TEXT_OVERLAY") or, usually, a policy title ("Adult Nudity & Sexual Activity").
   * Any key up to 80 characters without control characters is kept as it came; review.ts normalises it to a code.
   */
  // eslint-disable-next-line no-control-regex
  const FEEDBACK_CODE = /^[^\u0000-\u001f\u007f]{1,80}$/;

  function feedbackOf(v: unknown): ReviewFeedback[] {
    if (!isObject(v)) return [];
    const out: ReviewFeedback[] = [];
    const add = (scope: string, entries: unknown) => {
      if (!isObject(entries)) return;
      for (const [code, text] of Object.entries(entries)) {
        if (out.length >= 25) return;
        if (FEEDBACK_CODE.test(code)) out.push({ scope, code, text: typeof text === "string" ? text.slice(0, 1000) : "" });
      }
    };
    add("global", v.global);
    if (isObject(v.placement_specific)) for (const [placement, entries] of Object.entries(v.placement_specific).slice(0, 20)) add(placement.slice(0, 40), entries);
    return out;
  }

  const inIds = (ids: string[]) => JSON.stringify([{ field: "id", operator: "IN", value: ids }]);

  function idBatches(ids: string[], what: string): string[][] {
    const unique = [...new Set((Array.isArray(ids) ? ids : []).map((id) => objectId(id, what)))];
    const out: string[][] = [];
    for (let i = 0; i < unique.length; i += REVIEW_BATCH) out.push(unique.slice(i, i + REVIEW_BATCH));
    return out;
  }

  /** R1: review status and feedback of ads, in batches of 50 ids. */
  async function getAdsReview(ctx: AdCtx, adIds: string[]): Promise<AdReview[]> {
    const batches = idBatches(adIds, "ad");
    if (!batches.length) return [];
    const a = await adAccess(ctx.tenantId, ctx.adAccountAssetId);
    const out: AdReview[] = [];
    for (const batch of batches) {
      const res = await pages<unknown>(a, PRIORITY.review, `${a.act}/ads`, { filtering: inIds(batch), fields: AD_REVIEW_FIELDS, limit: String(REVIEW_BATCH) }, {}, 2);
      for (const r of res.items) {
        if (!isObject(r) || typeof r.id !== "string" || !OBJECT_ID.test(r.id)) continue;
        const adset = isObject(r.adset) ? r.adset : {};
        const creative = isObject(r.creative) ? r.creative : {};
        out.push({
          id: r.id,
          effectiveStatus: str(r.effective_status, 40),
          configuredStatus: str(r.configured_status, 40),
          feedback: feedbackOf(r.ad_review_feedback),
          rawFeedback: isObject(r.ad_review_feedback) ? r.ad_review_feedback : null,
          issues: list(r.issues_info)
            .filter(isObject)
            .slice(0, 20)
            .map((i) => ({ code: num(i.error_code), summary: str(i.error_summary, 500), message: str(i.error_message, 1000), level: str(i.level, 40) })),
          adSetId: str(adset.id, 64),
          targeting: adset.targeting ?? null,
          effectiveObjectStoryId: str(creative.effective_object_story_id, 80),
          effectiveInstagramMediaId: str(creative.effective_instagram_media_id, 80),
        });
      }
    }
    return out;
  }

  /** R2: Meta's Advantage+ state of campaigns (once after launch). */
  async function getCampaignAdvantage(ctx: AdCtx, campaignIds: string[]): Promise<CampaignAdvantage[]> {
    const batches = idBatches(campaignIds, "campaign");
    if (!batches.length) return [];
    const a = await adAccess(ctx.tenantId, ctx.adAccountAssetId);
    const out: CampaignAdvantage[] = [];
    for (const batch of batches) {
      const res = await pages<unknown>(a, PRIORITY.review, `${a.act}/campaigns`, { filtering: inIds(batch), fields: CAMPAIGN_ADVANTAGE_FIELDS, limit: String(REVIEW_BATCH) }, {}, 2);
      for (const r of res.items) {
        if (!isObject(r) || typeof r.id !== "string" || !OBJECT_ID.test(r.id)) continue;
        const info = isObject(r.advantage_state_info) ? r.advantage_state_info : {};
        const state = Object.fromEntries(
          Object.entries(info)
            .filter(([k, v]) => /^[a-z_]{1,60}$/.test(k) && typeof v === "string")
            .slice(0, 20)
            .map(([k, v]) => [k, String(v).slice(0, 100)]),
        );
        out.push({ id: r.id, state });
      }
    }
    return out;
  }

  return {
    // Connect and readiness
    getPageReadiness,
    listPageBackedInstagram,
    getAdAccountHealth,
    getMinimumBudgets,
    listAdAccountInstagram,
    getPixel,
    createPageBackedInstagram,
    createPixel,
    // Boost a post
    listPublishedPosts,
    listPromotablePosts,
    getPostInstagramEligibility,
    listInstagramMedia,
    listInstagramStories,
    // Media
    uploadAdImage,
    createAdVideo,
    startVideoUpload,
    finishVideoUpload,
    getAdVideoStatus,
    // Previews
    generatePreviews,
    getCreativePreviews,
    // Lead forms
    listLeadForms,
    createLeadForm,
    sendTestLead,
    // Audiences and targeting
    createCustomAudience,
    addAudienceUsers,
    replaceAudienceUsers,
    removeAudienceUsers,
    getAudience,
    deleteAudience,
    searchPlaces,
    searchInterests,
    estimateReach,
    // Review
    getAdsReview,
    getCampaignAdvantage,
    // Capabilities (leads/ uses these for L5 and L6)
    probeCapability,
    capability,
  };
}

export type PromoteMeta = ReturnType<typeof createPromoteMeta>;

/** The process-wide client: getAssetAccess for tokens, PlatformSetting for caches and cooldowns. */
export const promoteMeta: PromoteMeta = createPromoteMeta();
