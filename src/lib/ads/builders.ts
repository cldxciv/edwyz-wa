import { goalRow, type PromotedObjectKey } from "@/lib/promote/catalog/goals";
import {
  buildCreativeShape,
  creativeShapeProblems,
  enhancementsSpec,
  welcomeMessageJson,
  type CreativeShapeInput,
  type ShapeCard,
  type ShapeMedia,
  type ShapeProblemCode,
} from "@/lib/promote/creative-shapes";
import { toZonedIso } from "@/lib/promote/dates";
import type { AdFormat, FormType, GoalKey, SourceKind } from "@/lib/promote/types";
import { audienceProblems, DEFAULT_SPECIAL_CATEGORY_COUNTRY, metaSpecialCategories, targetedCountries, toMetaTargeting, validateTargeting } from "./targeting";
import { isLegacyTemplate, type AdTemplate, type CreativeInput, type LegacyTemplate, type Placement, type SpecialAdCategory, type Targeting } from "./types";

/*
 * Request builders for the Marketing API. Every campaign, ad set and ad is created with status PAUSED; a creative carries no
 * status at all (it has no delivery status, docs/SPEND-CONTROLS-SPEC.md erratum 12.1b).
 * Spend controls (4.5, 4.8): budget sharing between ad sets is always sent off (sharing would let Meta spend 2.1x a day); an
 * ad set sends end_time whenever the campaign has an end date, and a lifetime budget (lifetime_budget, which Meta only takes
 * with an end date) instead of a daily budget when one is set.
 * Goals (docs/IG-PAGE-ADS-SPEC.md 4.3, 4.4, PRM-04): each template key builds one goal of promote/catalog/goals.ts. The old
 * wizard's four templates keep their exact payloads; every new goal, format and boost source is built by
 * promote/creative-shapes.ts.
 * Validators first: every RangeError of buildCampaign, buildAdSet and buildCreative is also in campaignProblems,
 * adSetProblems and creativeBuildProblems (same plain copy), so callers refuse before the first Meta write rather than
 * leaving a paused campaign behind (a test walks every path).
 * Shapes are written from memory of the Marketing API; every field marked VERIFY must be checked against the
 * current reference (campaign, adset, adcreative, ad) for the pinned GRAPH_API_VERSION before real use.
 */

// Meta's automatic creative changes are switched off for every creative (D11). One list, kept in creative-shapes.
export { OPTED_OUT_FEATURES, optOutSpec } from "@/lib/promote/creative-shapes";

type Need = "link" | "leadFormId" | "whatsappNumberId" | "postId";

export type TemplateSpec = {
  /** The goal (4.4) whose ad set and creative this template builds. */
  goal: GoalKey;
  objective: string;
  optimizationGoal: string;
  /** Used instead when a pixel fired in the last 7 days (website visits: LANDING_PAGE_VIEWS). */
  optimizationWithPixel?: string;
  /** null: the ad set sends no destination_type (awareness). */
  destinationType: string | null;
  promotedObject: readonly PromotedObjectKey[];
  /** Sent only when the caller has the value (multi-destination's WhatsApp number). */
  promotedObjectOptional?: readonly PromotedObjectKey[];
  promotedObjectFixed?: Readonly<Record<string, string>>;
  /** What the old wizard's creative must provide. */
  needs: readonly Need[];
};

/** A template's spec, read from the goal catalog (4.4). */
function fromGoal(goal: GoalKey, over: Partial<TemplateSpec> = {}): TemplateSpec {
  const g = goalRow(goal);
  return {
    goal,
    objective: g.objective,
    optimizationGoal: g.optimizationGoal,
    ...(g.optimizationWithPixel ? { optimizationWithPixel: g.optimizationWithPixel } : {}),
    destinationType: g.destinationType,
    promotedObject: g.promotedObject,
    ...(g.promotedObjectOptional ? { promotedObjectOptional: g.promotedObjectOptional } : {}),
    ...(g.promotedObjectFixed ? { promotedObjectFixed: g.promotedObjectFixed } : {}),
    needs: [],
    ...over,
  };
}

// VERIFY: objective names (ODAX), optimization_goal and destination_type pairings per template (goals.ts verifyRefs).
export const TEMPLATE_SPECS: Record<AdTemplate, TemplateSpec> = {
  lead_generation: fromGoal("lead_form", { needs: ["leadFormId"] }),
  click_to_whatsapp: fromGoal("whatsapp_chats", { needs: ["whatsappNumberId"] }),
  // The old wizard has always sent the Page with a traffic ad set, and keeps doing so; 4.4 lists none (VERIFY V-P1).
  traffic: fromGoal("website_visits", { promotedObject: ["page_id"], needs: ["link"] }),
  // The post is a Facebook post (postId) or an Instagram one (instagramMediaId); creativeProblems checks that one is chosen.
  boost_post: fromGoal("engagement"),
  click_to_instagram: fromGoal("instagram_dms"),
  click_to_messenger: fromGoal("messenger_chats"),
  website_sales: fromGoal("website_sales", { needs: ["link"] }),
  profile_visits: fromGoal("profile_visits"),
  engagement: fromGoal("engagement"),
  video_views: fromGoal("video_views"),
  awareness: fromGoal("awareness"),
  page_likes: fromGoal("page_likes"),
  multi_destination: fromGoal("any_chat"),
};

/** The old wizard's default call to action per template. New goals take theirs from promote/catalog/cta.ts. */
export const DEFAULT_CTA: Record<LegacyTemplate, string> = {
  lead_generation: "SIGN_UP",
  click_to_whatsapp: "WHATSAPP_MESSAGE",
  traffic: "LEARN_MORE",
  boost_post: "LEARN_MORE",
};

/**
 * True when promote/creative-shapes builds the creative: every new template, and any creative with a 5.4 format or a boost
 * source id. The old wizard's four templates without them keep their exact payloads.
 */
export function usesCreativeShapes(template: AdTemplate, c: Partial<CreativeInput>): boolean {
  return !isLegacyTemplate(template) || hasShapeFields(c);
}

const hasShapeFields = (c: Partial<CreativeInput>) => !!c.format || !!c.fbPromotableId || !!c.igMediaId;

/** Plain copy for each creative-shapes problem code. */
export const SHAPE_PROBLEM_TEXT: Readonly<Record<ShapeProblemCode, string>> = {
  missing_page: "Choose a Facebook Page.",
  goal_source: "This goal can't use an existing post yet. Make a new ad instead.",
  goal_format: "This goal can't use this kind of ad. Pick another format.",
  missing_post: "Choose the post to boost.",
  missing_instagram_account: "Choose the Instagram account the post is from.",
  missing_media: "Add a picture or a video.",
  missing_thumbnail: "Add a cover picture for the video.",
  missing_link: "Add the link to your website.",
  link_https: "The link must start with https://.",
  missing_form: "Choose a lead form.",
  carousel_cards: "A carousel needs 2 to 10 cards.",
  ice_breakers: "Use up to 3 quick questions. Each title can have up to 80 characters and each answer up to 300.",
};

export function creativeProblems(template: AdTemplate, c: CreativeInput): string[] {
  if (!isLegacyTemplate(template) || hasShapeFields(c)) return shapeProblems(template, c);
  const out: string[] = [];
  if (!c.pageId) out.push("Choose a Facebook Page.");
  if (template !== "boost_post" && !c.message?.trim()) out.push("The ad needs primary text.");
  for (const need of TEMPLATE_SPECS[template].needs) {
    if (!c[need]) out.push(`This template needs ${need}.`);
  }
  if (template === "boost_post") {
    if (!c.postId && !c.instagramMediaId) out.push("Choose the post to boost.");
    if (c.instagramMediaId && !c.instagramId) out.push("Choose the Instagram account the post is from.");
  }
  if (c.link && !/^https:\/\/[^\s]+$/.test(c.link)) out.push("The link must start with https://.");
  if (template !== "boost_post" && !c.imageUrl && !c.imageHash) out.push("Add an image (imageUrl or imageHash).");
  return out;
}

/** What stops a creative-shapes creative, in plain words. Media ids count as present: the caller resolves them at launch. */
function shapeProblems(template: AdTemplate, c: CreativeInput): string[] {
  const i = shapeInput({ name: "check", template, creative: c }, "check");
  const out: string[] = [];
  if (i.source === "new" && !c.message?.trim()) out.push("The ad needs primary text.");
  if (TEMPLATE_SPECS[template].needs.includes("whatsappNumberId") && !c.whatsappNumberId) out.push("Choose the WhatsApp number people will chat with.");
  out.push(...creativeShapeProblems(i).map((code) => SHAPE_PROBLEM_TEXT[code]));
  return [...new Set(out)];
}

/** The creative-shapes problems with the media the caller resolved (Meta hashes and video ids): exactly what buildCreative throws on. */
const builtShapeProblems = (input: CreativeBuildInput) => [...new Set(creativeShapeProblems(shapeInput(input, "build")).map((code) => SHAPE_PROBLEM_TEXT[code]))];

/**
 * What stops buildCreative, in plain copy, once the caller has resolved the AdMedia ids in creative.media and creative.cards
 * into input.media and input.cards. creativeProblems counts those ids as present (they are resolved at launch); this check
 * does not, so an id the caller failed to resolve is reported here before any Meta write instead of thrown after one.
 */
export function creativeBuildProblems(input: CreativeBuildInput): string[] {
  const { template, creative: c } = input;
  if (!usesCreativeShapes(template, c)) return creativeProblems(template, c);
  return [...new Set([...shapeProblems(template, c), ...builtShapeProblems(input)])];
}

export const actId =(externalId: string) => (externalId.startsWith("act_") ? externalId : `act_${externalId}`);

export const SPECIAL_CATEGORY_NOT_ALLOWED = "This goal can't run as a special ad category. Pick another goal.";
export const PIXEL_NEEDED = "Ads for website sales need a Meta pixel. Choose one first.";
export const LIFETIME_NEEDS_END = "A lifetime budget needs an end date.";

export type CampaignBuildInput = {
  name: string;
  template: AdTemplate;
  specialAdCategory: SpecialAdCategory;
  /** The countries a special-category ad runs in. When none are named: the ad sets' targeted countries, else India. */
  specialAdCategoryCountries?: readonly string[];
  /** The campaign's ad set targeting, for the special-category countries. */
  targeting?: Targeting | readonly Targeting[];
};

/** What stops the campaign body, in plain copy; buildCampaign throws on the same list. */
export function campaignProblems(input: Pick<CampaignBuildInput, "template" | "specialAdCategory">): string[] {
  const goal = TEMPLATE_SPECS[input.template].goal;
  return input.specialAdCategory !== "none" && !goalRow(goal).specialCategoriesAllowed ? [SPECIAL_CATEGORY_NOT_ALLOWED] : [];
}

/** special_ad_category_country for a special category (4.3, VERIFY V-P1): the named countries, the targeted ones, or India. */
export function specialAdCategoryCountries(input: Pick<CampaignBuildInput, "specialAdCategory" | "specialAdCategoryCountries" | "targeting">): string[] {
  if (input.specialAdCategory === "none") return [];
  const clean = (list: readonly string[]) => [...new Set(list.map((c) => c.trim().toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c)))];
  const named = clean(input.specialAdCategoryCountries ?? []);
  if (named.length) return named;
  const sets = input.targeting === undefined ? [] : Array.isArray(input.targeting) ? (input.targeting as readonly Targeting[]) : [input.targeting as Targeting];
  const targeted = clean(sets.flatMap(targetedCountries));
  return targeted.length ? targeted : [DEFAULT_SPECIAL_CATEGORY_COUNTRY];
}

export function buildCampaign(input: CampaignBuildInput) {
  const problems = campaignProblems(input);
  if (problems.length) throw new RangeError(problems[0]);
  // VERIFY V-P1: Meta asks which countries a special-category ad runs in; always sent with a special category.
  const countries = specialAdCategoryCountries(input);
  return {
    name: input.name,
    objective: TEMPLATE_SPECS[input.template].objective,
    status: "PAUSED",
    // Always sent, even when empty, so Meta never infers a category.
    special_ad_categories: metaSpecialCategories(input.specialAdCategory),
    buying_type: "AUCTION",
    // VERIFY: required when the budget lives on the ad set rather than the campaign.
    // Always off: with sharing on, Meta may move up to 20% between ad sets and spend 2.1x a day (4.5).
    is_adset_budget_sharing_enabled: false,
    ...(countries.length ? { special_ad_category_country: countries } : {}),
  };
}

export type AdSetBuildInput = {
  name: string;
  metaCampaignId: string;
  template: AdTemplate;
  targeting: Targeting;
  specialAdCategory: SpecialAdCategory;
  /** The daily budget; ignored when a lifetime budget is set (Meta takes one or the other). */
  dailyBudgetMinor: number;
  /** A lifetime budget instead of a daily one. Needs endsAt. */
  lifetimeBudgetMinor?: number | null;
  pageId: string;
  whatsappDisplayPhone?: string;
  startsAt?: Date | null;
  endsAt?: Date | null;
  /**
   * The spending ad account's IANA zone (D30). With it, start_time and end_time carry that zone's offset at each instant
   * (so a run across a daylight-saving change gets two offsets). Without it, UTC as before.
   */
  timeZone?: string | null;
  /** Website sales: the Meta pixel the purchases are counted on. */
  pixelId?: string | null;
  /** A pixel fired in the last 7 days, so website visits optimise for landing page views. */
  pixelFiredRecently?: boolean;
  /**
   * AdAudience id to Meta audience id, for targeting.lookalikeAudienceIds, customAudienceIds and excludedAudienceIds. Built by
   * the caller from the workspace's own ready, consented and allowed AdAudience rows; an id missing here is refused.
   */
  audienceMetaIds?: Readonly<Record<string, string>>;
};

/** promoted_object for the template's goal (4.4): the Page, the WhatsApp number, or the pixel with PURCHASE. */
function promotedObject(spec: TemplateSpec, input: AdSetBuildInput): Record<string, string> {
  const promoted: Record<string, string> = {};
  const put = (key: PromotedObjectKey) => {
    if (key === "page_id") promoted.page_id = input.pageId;
    // VERIFY: whatsapp_phone_number format (E.164 with plus) for click-to-WhatsApp promoted_object.
    else if (key === "whatsapp_phone_number") {
      if (input.whatsappDisplayPhone) promoted.whatsapp_phone_number = input.whatsappDisplayPhone;
    } else if (key === "pixel_id") {
      // A required pixel is checked by adSetBuildProblems before this runs.
      if (input.pixelId) promoted.pixel_id = input.pixelId;
    } else if (key === "custom_event_type") promoted.custom_event_type = spec.promotedObjectFixed?.custom_event_type ?? "PURCHASE";
  };
  for (const key of spec.promotedObject) put(key);
  for (const key of spec.promotedObjectOptional ?? []) put(key);
  return promoted;
}

const lifetimeOf = (input: Pick<AdSetBuildInput, "lifetimeBudgetMinor">) => (typeof input.lifetimeBudgetMinor === "number" && input.lifetimeBudgetMinor > 0 ? input.lifetimeBudgetMinor : null);

/** Exactly what buildAdSet throws on, in this order. */
function adSetBuildProblems(input: AdSetBuildInput): string[] {
  const out = [...campaignProblems(input)];
  if (TEMPLATE_SPECS[input.template].promotedObject.includes("pixel_id") && !input.pixelId) out.push(PIXEL_NEEDED);
  if (lifetimeOf(input) !== null && !input.endsAt) out.push(LIFETIME_NEEDS_END);
  out.push(...audienceProblems(input.targeting, input.specialAdCategory, input.audienceMetaIds));
  return out;
}

/** What the caller knows about the ads of the ad set, for the 4.5 placement rules (see TargetingCheck). */
export type AdSetCheckInput = AdSetBuildInput & { format?: AdFormat; mediaKind?: "image" | "video"; hasInstagramIdentity?: boolean; formType?: FormType; allowUnverifiedPlacements?: boolean };

/**
 * What stops the ad set, in plain copy, before anything is created on Meta: everything buildAdSet would throw on (a special
 * category the goal can't take, a missing pixel, a lifetime budget without an end, an audience that isn't resolved), plus
 * the targeting and the 4.5 placement rules for the template's goal. Run it, with campaignProblems and
 * creativeBuildProblems, before the first Meta write: buildAdSet runs only after the campaign exists on Meta.
 */
export function adSetProblems(input: AdSetCheckInput): string[] {
  const { format, mediaKind, hasInstagramIdentity, formType, allowUnverifiedPlacements } = input;
  const targeting = validateTargeting(input.targeting, input.specialAdCategory, {
    goal: TEMPLATE_SPECS[input.template].goal,
    format,
    mediaKind,
    hasInstagramIdentity,
    formType,
    allowUnverifiedPlacements,
    audienceMetaIds: input.audienceMetaIds,
  });
  return [...new Set([...adSetBuildProblems(input), ...targeting.errors])];
}

export function buildAdSet(input: AdSetBuildInput) {
  const spec = TEMPLATE_SPECS[input.template];
  const problems = adSetBuildProblems(input);
  if (problems.length) throw new RangeError(problems[0]);
  const promoted = promotedObject(spec, input);
  const lifetime = lifetimeOf(input);
  const body: Record<string, unknown> = {
    name: input.name,
    campaign_id: input.metaCampaignId,
    status: "PAUSED",
    ...(lifetime !== null ? { lifetime_budget: lifetime } : { daily_budget: input.dailyBudgetMinor }),
    billing_event: "IMPRESSIONS",
    optimization_goal: input.pixelFiredRecently && spec.optimizationWithPixel ? spec.optimizationWithPixel : spec.optimizationGoal,
    bid_strategy: "LOWEST_COST_WITHOUT_CAP",
  };
  if (spec.destinationType) body.destination_type = spec.destinationType;
  if (Object.keys(promoted).length) body.promoted_object = promoted;
  body.targeting = toMetaTargeting(input.targeting, input.specialAdCategory, { audienceMetaIds: input.audienceMetaIds });
  // In the account zone when given (D30, promote/dates.ts), never one offset reused for both ends.
  const at = (d: Date) => (input.timeZone ? toZonedIso(d, input.timeZone) : d.toISOString());
  if (input.startsAt) body.start_time = at(input.startsAt);
  if (input.endsAt) body.end_time = at(input.endsAt);
  return body;
}

export type CreativeBuildInput = {
  name: string;
  template: AdTemplate;
  creative: CreativeInput;
  whatsappDisplayPhone?: string;
  /** Meta image hashes and video ids for creative.media, resolved by the caller at launch. AdMedia ids are never sent. */
  media?: ShapeMedia;
  /** The same for creative.cards, in card order. */
  cards?: readonly ShapeCard[];
  /** The ad set's chosen positions (empty is Automatic); per-placement asset rules follow them. */
  positions?: readonly Placement[];
  /** Facebook post boost: "Also show on Instagram", and Meta's is_instagram_eligible for the post. */
  alsoInstagram?: boolean;
  igEligible?: boolean;
};

/**
 * The goal, source and format a creative means. A post source comes from the format, or from a boost id when no format is
 * set; an Instagram media id wins over a Facebook post, as in the old wizard.
 */
function shapeInput(input: CreativeBuildInput, mode: "build" | "check"): CreativeShapeInput {
  const c = input.creative;
  const goal = TEMPLATE_SPECS[input.template].goal;
  const igMedia = c.igMediaId || c.instagramMediaId || null;
  const post = c.fbPromotableId || c.postId || null;
  const existing = c.format === "existing_post" || (!c.format && (!!igMedia || !!post));
  const source: SourceKind = !existing ? "new" : igMedia ? "ig_media" : "fb_post";
  const format: AdFormat = source !== "new" ? "existing_post" : c.format && c.format !== "existing_post" ? c.format : "single_image";
  let media: ShapeMedia;
  let cards: readonly ShapeCard[];
  if (mode === "build") {
    media = input.media ?? (c.imageHash ? { imageHash: c.imageHash } : {});
    cards = input.cards ?? [];
  } else {
    // Validation before launch: an AdMedia id stands in for the hash the caller will resolve.
    const ids = c.media ?? {};
    media = { imageHash: ids.feed || ids.square || c.imageHash || null, verticalImageHash: ids.vertical || null, videoId: ids.video || null, thumbHash: ids.video ? ids.video : null };
    cards = (c.cards ?? []).map((k) => ({ imageHash: k.mediaId || null, headline: k.headline ?? "", description: k.description ?? null, link: k.link ?? null }));
  }
  return {
    name: input.name,
    goal,
    source,
    format,
    pageId: c.pageId,
    instagramUserId: c.instagramId || null,
    promotableId: post,
    alsoInstagram: input.alsoInstagram === true,
    igEligible: input.igEligible === true,
    igMediaId: igMedia,
    primaryText: c.message ?? "",
    headline: c.headline ?? null,
    description: c.description ?? null,
    link: c.link || null,
    ctaType: c.ctaType || c.cta || null,
    leadFormId: c.leadFormId || null,
    welcome: c.welcomeMessage?.trim() ? { message: c.welcomeMessage, iceBreakers: c.iceBreakers ?? [] } : null,
    media,
    cards,
    positions: input.positions ?? [],
    enhancementsOptIn: c.enhancementsOptIn === true,
    urlTags: c.urlTags || null,
  };
}

export function buildCreative(input: CreativeBuildInput): Record<string, unknown> {
  const { template, creative: c } = input;
  // Every new goal, format and boost source (4.3). Throws a RangeError in plain copy when incomplete; creativeBuildProblems
  // (and creativeProblems before the media is resolved) says why first.
  if (!isLegacyTemplate(template) || hasShapeFields(c)) {
    const problems = builtShapeProblems(input);
    if (problems.length) throw new RangeError(problems.join(" "));
    return buildCreativeShape(shapeInput(input, "build")).body;
  }
  // The old wizard's four templates, exactly as before. Enhancements stay OPT_OUT unless "Let Meta improve my ad" is on.
  const enhancements = enhancementsSpec(c.enhancementsOptIn === true);
  if (template === "boost_post") {
    if (c.instagramMediaId) {
      // VERIFY: an existing Instagram post is source_instagram_media_id, with the Page as object_id and the account as instagram_user_id.
      return { name: input.name, object_id: c.pageId, instagram_user_id: c.instagramId, source_instagram_media_id: c.instagramMediaId, degrees_of_freedom_spec: enhancements };
    }
    // VERIFY: object_story_id is "<page_id>_<post_id>".
    return { name: input.name, object_story_id: c.postId!.includes("_") ? c.postId : `${c.pageId}_${c.postId}`, degrees_of_freedom_spec: enhancements };
  }
  const cta = c.ctaType || c.cta || DEFAULT_CTA[template];
  const linkData: Record<string, unknown> = { message: c.message };
  if (c.headline) linkData.name = c.headline;
  if (c.imageHash) linkData.image_hash = c.imageHash;
  else if (c.imageUrl) linkData.picture = c.imageUrl;
  if (template === "lead_generation") {
    // VERIFY: lead form ads carry the form in call_to_action.value.lead_gen_form_id and a link to the form's privacy policy or site.
    linkData.link = c.link ?? "https://fb.me/";
    linkData.call_to_action = { type: cta, value: { lead_gen_form_id: c.leadFormId } };
  } else if (template === "click_to_whatsapp") {
    // VERIFY: link and app_destination shape for click-to-WhatsApp creatives.
    linkData.link = "https://api.whatsapp.com/send";
    linkData.call_to_action = { type: cta, value: { app_destination: "WHATSAPP" } };
  } else {
    linkData.link = c.link;
    linkData.call_to_action = { type: cta, value: { link: c.link } };
  }
  const storySpec: Record<string, unknown> = { page_id: c.pageId, link_data: linkData };
  if (c.instagramId) storySpec.instagram_user_id = c.instagramId;
  const body: Record<string, unknown> = { name: input.name, object_story_spec: storySpec, degrees_of_freedom_spec: enhancements };
  if (template === "click_to_whatsapp" && c.welcomeMessage) {
    // VERIFY: page_welcome_message is a JSON string in the visual-editor format (VERIFY V-P4 for the ice breakers).
    body.object_story_spec = { ...storySpec, link_data: { ...linkData, page_welcome_message: welcomeMessageJson(c.welcomeMessage, c.iceBreakers ?? []) } };
  }
  // URL parameters only when the member set them, so the old wizard's payload is unchanged.
  if (template === "traffic" && c.urlTags?.trim()) body.url_tags = c.urlTags.trim();
  return body;
}

export function buildAd(input: { name: string; metaAdSetId: string; metaCreativeId: string }) {
  return { name: input.name, adset_id: input.metaAdSetId, creative: { creative_id: input.metaCreativeId }, status: "PAUSED" };
}

export type PayloadPreview = {
  campaign: Record<string, unknown>;
  adSet: Record<string, unknown>;
  ads: { name: string; creative: Record<string, unknown> }[];
};
