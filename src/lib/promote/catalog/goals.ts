/**
 * The goal catalog (docs/IG-PAGE-ADS-SPEC.md 4.4, 3.2, 3.4, D15, D16, D22). Pure data: one row per goal with its Meta
 * pairing (objective, optimization_goal, destination_type, promoted_object), its legacy template key, tier, verify state,
 * doc reference, Phase 0 tripwire class, readiness checks, valid sources and formats, and how results are counted.
 *
 * Every row starts at verify state `docs` (catalog/verified.ts) and moves up only through the runbook (9.6).
 *
 * `docUrl` is the path of the reference page on Meta's developer documentation site. The host is left out on purpose:
 * no file under src/lib/promote names a Meta host (8.4, the meta-screens grep); the runbook script prepends it.
 */
import type { PromoteCopyKey } from "../copy";
import type { AdFormat, GoalKey, ReadinessCheck, SourceKind, Tier, TripwireClass, VerifyState } from "../types";
import { verifyStateOf } from "./verified";

export type MetaObjective = "OUTCOME_ENGAGEMENT" | "OUTCOME_LEADS" | "OUTCOME_TRAFFIC" | "OUTCOME_SALES" | "OUTCOME_AWARENESS";
export type PromotedObjectKey = "page_id" | "whatsapp_phone_number" | "pixel_id" | "custom_event_type";
/** The apps whose positions a goal may use (placements.ts filters by them). */
export type GoalPlatform = "facebook" | "instagram" | "audience_network" | "threads" | "whatsapp";

export type GoalRow = {
  key: GoalKey;
  tier: Tier;
  objective: MetaObjective;
  /** The optimization goal. website_visits uses `optimizationWithPixel` when a pixel fired in the last 7 days. */
  optimizationGoal: string;
  optimizationWithPixel?: string;
  /** Allowed later (lead_form: QUALITY_LEAD), never offered by default. */
  optimizationLater?: readonly string[];
  /** null: the ad set sends no destination_type. */
  destinationType: string | null;
  /** any_chat may use a two-app subset (PRM-18, VERIFY). */
  destinationSubsets?: readonly string[];
  promotedObject: readonly PromotedObjectKey[];
  promotedObjectOptional?: readonly PromotedObjectKey[];
  promotedObjectFixed?: Readonly<Record<string, string>>;
  /** AdCampaign.template: the legacy key for a new ad and for an existing post. */
  template: { new: string; post: string };
  verify: VerifyState;
  /** Runbook steps that must pass before the row moves up (9.6). */
  verifyRefs: readonly string[];
  docUrl: string;
  /** The class of the writes this goal leads to: every object is created PAUSED under a create permit (6.1 rule 1). */
  tripwireClass: TripwireClass;
  /** Readiness checks of 3.2 (placements add the Instagram rows when Instagram positions are used). */
  prerequisites: readonly ReadinessCheck[];
  sources: readonly SourceKind[];
  formats: readonly AdFormat[];
  platforms: readonly GoalPlatform[];
  /** Replies land outside Edwyz (D15): the Instagram app or Messenger. */
  repliesOutsideEdwyz: boolean;
  /** The Meta action counted as a result (ads/insights-map.ts RESULT_ACTIONS); null until V-P17 for profile visits. */
  resultAction: string | null;
  resultActionWithoutPixel?: string;
  specialCategoriesAllowed: boolean;
  needsWhatsApp: boolean;
  copy: { title: PromoteCopyKey; chip: PromoteCopyKey; outcome: PromoteCopyKey; note?: PromoteCopyKey };
};

/** Checks every goal needs (3.2). */
export const BASE_PREREQUISITES: readonly ReadinessCheck[] = [
  "facebook_connected",
  "spending_account",
  "daily_limit",
  "account_active",
  "payment_method",
  "page_advertise",
  "currency_match",
];

const NEW_FORMATS: readonly AdFormat[] = ["single_image", "single_video", "carousel"];
const ALL_FORMATS: readonly AdFormat[] = [...NEW_FORMATS, "existing_post"];
const ALL_SOURCES: readonly SourceKind[] = ["new", "fb_post", "ig_media"];
const CHAT_RESULT = "onsite_conversion.messaging_conversation_started_7d";
const OBJECTIVES_DOC = "/docs/marketing-api/reference/ad-campaign-group";

const copyOf = (key: GoalKey, note?: PromoteCopyKey): GoalRow["copy"] => ({
  title: `goal.${key}.title` as PromoteCopyKey,
  chip: `goal.${key}.chip` as PromoteCopyKey,
  outcome: `goal.${key}.outcome` as PromoteCopyKey,
  ...(note ? { note } : {}),
});

type RowInput = Omit<GoalRow, "verify" | "tripwireClass" | "prerequisites" | "copy" | "specialCategoriesAllowed" | "needsWhatsApp" | "repliesOutsideEdwyz"> & {
  extraPrereqs?: readonly ReadinessCheck[];
  note?: PromoteCopyKey;
  specialCategoriesAllowed?: boolean;
  needsWhatsApp?: boolean;
  repliesOutsideEdwyz?: boolean;
};

const goal = ({ extraPrereqs = [], note, specialCategoriesAllowed = true, needsWhatsApp = false, repliesOutsideEdwyz = false, ...r }: RowInput): GoalRow => ({
  ...r,
  verify: verifyStateOf(`goal.${r.key}`),
  tripwireClass: "ads_create",
  prerequisites: [...BASE_PREREQUISITES, ...extraPrereqs],
  copy: copyOf(r.key, note),
  specialCategoriesAllowed,
  needsWhatsApp,
  repliesOutsideEdwyz,
});

/** The 12 goals of 4.4, in catalog order (the same order as PROMOTE_GOAL_KEYS). */
export const GOALS: readonly GoalRow[] = [
  goal({
    key: "whatsapp_chats",
    tier: "simple",
    objective: "OUTCOME_ENGAGEMENT",
    optimizationGoal: "CONVERSATIONS",
    destinationType: "WHATSAPP",
    promotedObject: ["page_id", "whatsapp_phone_number"],
    template: { new: "click_to_whatsapp", post: "click_to_whatsapp" },
    verifyRefs: ["V-P1", "V-P3", "V-P4", "V-P12"],
    docUrl: "/docs/marketing-api/ad-creative/messaging-ads/click-to-whatsapp",
    extraPrereqs: ["whatsapp_connected", "whatsapp_page_link"],
    sources: ALL_SOURCES,
    formats: ALL_FORMATS,
    platforms: ["facebook", "instagram", "whatsapp"],
    resultAction: CHAT_RESULT,
    needsWhatsApp: true,
  }),
  goal({
    key: "lead_form",
    tier: "simple",
    objective: "OUTCOME_LEADS",
    optimizationGoal: "LEAD_GENERATION",
    optimizationLater: ["QUALITY_LEAD"],
    destinationType: "ON_AD",
    promotedObject: ["page_id"],
    template: { new: "lead_generation", post: "lead_generation" },
    verifyRefs: ["V-P1", "V-P3", "V-P7"],
    docUrl: "/docs/marketing-api/guides/lead-ads",
    extraPrereqs: ["leadgen_tos", "privacy_link", "lead_access"],
    sources: ALL_SOURCES,
    formats: ALL_FORMATS,
    platforms: ["facebook", "instagram"],
    resultAction: "lead",
  }),
  goal({
    key: "website_visits",
    tier: "simple",
    objective: "OUTCOME_TRAFFIC",
    optimizationGoal: "LINK_CLICKS",
    optimizationWithPixel: "LANDING_PAGE_VIEWS",
    destinationType: "WEBSITE",
    promotedObject: [],
    template: { new: "traffic", post: "traffic" },
    verifyRefs: ["V-P1", "V-P3"],
    docUrl: OBJECTIVES_DOC,
    sources: ALL_SOURCES,
    formats: ALL_FORMATS,
    platforms: ["facebook", "instagram", "audience_network", "threads"],
    resultAction: "landing_page_view",
    resultActionWithoutPixel: "link_click",
  }),
  goal({
    key: "instagram_dms",
    tier: "more",
    objective: "OUTCOME_ENGAGEMENT",
    optimizationGoal: "CONVERSATIONS",
    destinationType: "INSTAGRAM_DIRECT",
    promotedObject: ["page_id"],
    template: { new: "click_to_instagram", post: "click_to_instagram" },
    verifyRefs: ["V-P1", "V-P4"],
    docUrl: "/docs/marketing-api/ad-creative/messaging-ads/click-to-instagram-direct",
    extraPrereqs: ["instagram_identity", "instagram_page_link", "instagram_ad_account", "instagram_messages_access"],
    sources: ["new", "ig_media"],
    formats: ALL_FORMATS,
    platforms: ["instagram"],
    resultAction: CHAT_RESULT,
    repliesOutsideEdwyz: true,
    note: "goal.ig_dm.note",
  }),
  goal({
    key: "messenger_chats",
    tier: "more",
    objective: "OUTCOME_ENGAGEMENT",
    optimizationGoal: "CONVERSATIONS",
    destinationType: "MESSENGER",
    promotedObject: ["page_id"],
    template: { new: "click_to_messenger", post: "click_to_messenger" },
    verifyRefs: ["V-P1"],
    docUrl: "/docs/marketing-api/ad-creative/messaging-ads/click-to-messenger",
    sources: ["new", "fb_post"],
    formats: ALL_FORMATS,
    platforms: ["facebook", "instagram"],
    resultAction: CHAT_RESULT,
    repliesOutsideEdwyz: true,
    note: "goal.messenger.note",
  }),
  goal({
    key: "website_sales",
    tier: "more",
    objective: "OUTCOME_SALES",
    optimizationGoal: "OFFSITE_CONVERSIONS",
    destinationType: "WEBSITE",
    promotedObject: ["pixel_id", "custom_event_type"],
    promotedObjectFixed: { custom_event_type: "PURCHASE" },
    template: { new: "website_sales", post: "website_sales" },
    verifyRefs: ["V-P1", "V-P18"],
    docUrl: "/docs/marketing-api/reference/ad-promoted-object",
    extraPrereqs: ["pixel"],
    sources: ["new"],
    formats: NEW_FORMATS,
    platforms: ["facebook", "instagram", "audience_network", "threads"],
    resultAction: "offsite_conversion.fb_pixel_purchase",
    note: "goal.sales.needs_pixel",
  }),
  goal({
    key: "profile_visits",
    tier: "more",
    objective: "OUTCOME_TRAFFIC",
    // VERIFY V-P4: the Instagram profile optimization, destination and promoted object.
    optimizationGoal: "VISIT_INSTAGRAM_PROFILE",
    destinationType: "INSTAGRAM_PROFILE",
    promotedObject: ["page_id"],
    template: { new: "profile_visits", post: "profile_visits" },
    verifyRefs: ["V-P1", "V-P4", "V-P17"],
    docUrl: OBJECTIVES_DOC,
    extraPrereqs: ["instagram_identity", "instagram_page_link", "instagram_ad_account"],
    sources: ["new", "ig_media"],
    formats: ALL_FORMATS,
    platforms: ["instagram"],
    // VERIFY V-P17: the action Meta reports for profile visits.
    resultAction: null,
  }),
  goal({
    key: "engagement",
    tier: "more",
    objective: "OUTCOME_ENGAGEMENT",
    optimizationGoal: "POST_ENGAGEMENT",
    destinationType: "ON_POST",
    promotedObject: ["page_id"],
    template: { new: "engagement", post: "boost_post" },
    verifyRefs: ["V-P1", "V-P2"],
    docUrl: OBJECTIVES_DOC,
    sources: ALL_SOURCES,
    formats: ALL_FORMATS,
    platforms: ["facebook", "instagram", "threads"],
    resultAction: "post_engagement",
  }),
  goal({
    key: "video_views",
    tier: "more",
    objective: "OUTCOME_ENGAGEMENT",
    optimizationGoal: "THRUPLAY",
    destinationType: "ON_VIDEO",
    promotedObject: ["page_id"],
    template: { new: "video_views", post: "video_views" },
    verifyRefs: ["V-P1", "V-P6"],
    docUrl: OBJECTIVES_DOC,
    sources: ALL_SOURCES,
    formats: ["single_video", "existing_post"],
    platforms: ["facebook", "instagram", "audience_network", "threads"],
    resultAction: "video_thruplay_watched_actions",
  }),
  goal({
    key: "awareness",
    tier: "more",
    objective: "OUTCOME_AWARENESS",
    optimizationGoal: "REACH",
    destinationType: null,
    promotedObject: ["page_id"],
    template: { new: "awareness", post: "awareness" },
    verifyRefs: ["V-P1"],
    docUrl: OBJECTIVES_DOC,
    sources: ALL_SOURCES,
    formats: ALL_FORMATS,
    platforms: ["facebook", "instagram", "audience_network", "threads"],
    resultAction: "reach",
  }),
  goal({
    key: "page_likes",
    tier: "all",
    objective: "OUTCOME_ENGAGEMENT",
    optimizationGoal: "PAGE_LIKES",
    destinationType: "ON_PAGE",
    promotedObject: ["page_id"],
    template: { new: "page_likes", post: "page_likes" },
    verifyRefs: ["V-P1"],
    docUrl: OBJECTIVES_DOC,
    sources: ["new"],
    formats: ["single_image", "single_video"],
    platforms: ["facebook"],
    resultAction: "like",
  }),
  goal({
    key: "any_chat",
    tier: "all",
    objective: "OUTCOME_ENGAGEMENT",
    optimizationGoal: "CONVERSATIONS",
    destinationType: "MESSAGING_INSTAGRAM_DIRECT_MESSENGER_WHATSAPP",
    destinationSubsets: ["MESSAGING_MESSENGER_WHATSAPP", "MESSAGING_INSTAGRAM_DIRECT_MESSENGER", "MESSAGING_INSTAGRAM_DIRECT_WHATSAPP"],
    promotedObject: ["page_id"],
    promotedObjectOptional: ["whatsapp_phone_number"],
    template: { new: "multi_destination", post: "multi_destination" },
    verifyRefs: ["V-P1", "V-P4", "V-P12"],
    docUrl: "/docs/marketing-api/ad-creative/messaging-ads",
    extraPrereqs: ["whatsapp_connected", "whatsapp_page_link", "instagram_identity"],
    sources: ["new"],
    formats: ["single_image", "single_video"],
    platforms: ["facebook", "instagram"],
    resultAction: CHAT_RESULT,
    repliesOutsideEdwyz: true,
    specialCategoriesAllowed: false,
    needsWhatsApp: true,
    note: "goal.any_chat.note",
  }),
];

const BY_KEY: ReadonlyMap<GoalKey, GoalRow> = new Map(GOALS.map((g) => [g.key, g]));

/** The catalog row of a goal. */
export function goalRow(key: GoalKey): GoalRow {
  const row = BY_KEY.get(key);
  if (!row) throw new RangeError(`Unknown goal: ${key}`);
  return row;
}

/**
 * Pairings the catalog never offers (4.4): Click-to-WhatsApp under OUTCOME_LEADS allows only CONVERSATIONS and is not the
 * documented CTWA path, and Click-to-Instagram is not documented under OUTCOME_LEADS at all.
 */
export const FORBIDDEN_PAIRINGS: readonly { objective: MetaObjective; destinationType: string }[] = [
  { objective: "OUTCOME_LEADS", destinationType: "WHATSAPP" },
  { objective: "OUTCOME_LEADS", destinationType: "INSTAGRAM_DIRECT" },
];

/** True when the catalog would ever send this objective with this destination. */
export function pairingAllowed(objective: string, destinationType: string | null): boolean {
  if (FORBIDDEN_PAIRINGS.some((p) => p.objective === objective && p.destinationType === destinationType)) return false;
  return GOALS.some((g) => g.objective === objective && (g.destinationType === destinationType || (g.destinationSubsets ?? []).includes(destinationType ?? "")));
}

/** The optimization goal for a goal: website visits optimise for landing page views only with a recently fired pixel. */
export function optimizationFor(key: GoalKey, opts: { pixelFiredRecently?: boolean } = {}): string {
  const row = goalRow(key);
  return opts.pixelFiredRecently && row.optimizationWithPixel ? row.optimizationWithPixel : row.optimizationGoal;
}

/** The result action, following the optimization (link clicks without a recently fired pixel). */
export function resultActionFor(key: GoalKey, opts: { pixelFiredRecently?: boolean } = {}): string | null {
  const row = goalRow(key);
  if (row.resultActionWithoutPixel && !opts.pixelFiredRecently) return row.resultActionWithoutPixel;
  return row.resultAction;
}

/** The legacy template key (AdCampaign.template). Legacy `boost_post` rows map back to goal engagement with source fb_post. */
export function templateFor(key: GoalKey, source: SourceKind): string {
  const row = goalRow(key);
  return source === "new" ? row.template.new : row.template.post;
}

/**
 * Goals whose ad needs a value on its button (4.3): the lead form (ON_AD), the member's website link (WEBSITE), or the
 * chat app. A boosted post carries a button only once the runbook proves it for the goal (V-P3, `boost_cta.<goal>`).
 * Until then these goals can't use a post: Meta refuses the ad without the form, link or app.
 */
export const BOOST_NEEDS_BUTTON: ReadonlySet<GoalKey> = new Set<GoalKey>(["whatsapp_chats", "lead_form", "website_visits", "instagram_dms", "messenger_chats", "website_sales", "any_chat"]);

export type BoostOptions = {
  /** Send the goal's call to action on a boosted post. The runbook passes true to prove it (V-P3); default: the verify state. */
  ctaOnBoost?: boolean;
  /** Verify states; default catalog/verified.ts. */
  verified?: (id: string) => VerifyState;
};

/** True when a boosted post may carry the goal's call to action: the caller says so, or `boost_cta.<goal>` is proven. */
export function boostCtaProven(key: GoalKey, opts: BoostOptions = {}): boolean {
  return opts.ctaOnBoost ?? (opts.verified ?? verifyStateOf)(`boost_cta.${key}`) !== "docs";
}

/**
 * The sources a goal can use now (`GoalRow.sources` lists what it takes once proven): a post only when the goal needs no
 * button value, or its boost button is proven (BOOST_NEEDS_BUTTON). The catalog offers these and the shape library
 * builds only these, so no pairing is offered that would launch without its form, link or chat app.
 */
export function sourcesFor(key: GoalKey, opts: BoostOptions = {}): SourceKind[] {
  const row = goalRow(key);
  return row.sources.filter((s) => s === "new" || !BOOST_NEEDS_BUTTON.has(key) || boostCtaProven(key, opts));
}

/** The formats a goal takes from a source: a new ad uses the goal's new formats; a post is always existing_post. */
export function formatsFor(key: GoalKey, source: SourceKind, opts: BoostOptions = {}): AdFormat[] {
  const row = goalRow(key);
  if (!sourcesFor(key, opts).includes(source)) return [];
  return source === "new" ? row.formats.filter((f) => f !== "existing_post") : row.formats.includes("existing_post") ? ["existing_post"] : [];
}

/** The goal and source a legacy template means (4.4: boost_post is engagement from a Facebook post). */
export function goalOfLegacyTemplate(template: string): { goal: GoalKey; source: SourceKind } | null {
  if (template === "boost_post") return { goal: "engagement", source: "fb_post" };
  const row = GOALS.find((g) => g.template.new === template);
  return row ? { goal: row.key, source: "new" } : null;
}
