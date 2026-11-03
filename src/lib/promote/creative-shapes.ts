/**
 * The creative-shape library (docs/IG-PAGE-ADS-SPEC.md 4.3, D11, D16, 3.4, 3.6, PRM-02). Pure: one function per shape,
 * chosen by goal x source x format. ads/builders.ts buildCreative delegates here (PRM-04).
 *
 * The 6 shapes: a Facebook post boost, an Instagram media boost, a single image, a single video, a carousel, and
 * per-placement assets (asset_feed_spec: 4:5 on feeds, 9:16 on Stories and Reels).
 *
 * Rules every shape keeps (tests/promote-creative-shapes.test.ts):
 * - Every body carries the enhancements block, with each of Meta's automatic creative features OPT_OUT unless the owner
 *   turned on "Let Meta improve my ad", which flips every feature to OPT_IN (D11). Per-feature toggles (All settings)
 *   override one feature at a time.
 * - No body ever names the deprecated actor field, the deprecated enhancements bundle, the effective-story field, poll
 *   specs, or a budget or end-time field (rules B3 and B10). A creative carries no status (P0-1).
 * - asset_feed_spec customization rules are filtered to the chosen positions; explore_home takes single images only.
 * - Website goals add url_tags. Chat goals carry page_welcome_message as VISUAL_EDITOR v2 with at most 3 ice breakers
 *   (title up to 80 characters, response up to 300). A carousel lead ad uses one lead form for every card.
 * - A lead ad always needs its form, whatever the source. A boosted post for a goal whose button carries a value (lead
 *   form, website, chat; catalog/goals.ts BOOST_NEEDS_BUTTON) is refused as goal_source until the boost button is proven
 *   (V-P3); once proven, the post's button carries the form, the member's link or the chat app.
 *
 * Field names are VERIFY until the runbook (9.6) passes the step named next to each shape.
 */
import { CTA_BY_GOAL, ctaTypeFor, DEFAULT_URL_TAGS } from "./catalog/cta";
import { BOOST_NEEDS_BUTTON, boostCtaProven, formatsFor, sourcesFor } from "./catalog/goals";
import type { AdFormat, GoalKey, IceBreaker, PlacementKey, SourceKind } from "./types";

// ===== Enhancements (D11) =====

/**
 * Meta's automatic creative changes, all switched off for every creative so the ad shows exactly what the owner approved:
 * no rewritten text, crops, templates, stickers or animation. Keys from the Marketing API feature table; a feature that
 * does not apply to a creative is ignored by Meta. The list is pinned after V-P9. VERIFY: the docs' example says
 * image_template while the table says image_templates.
 */
export const OPTED_OUT_FEATURES = [
  "adapt_to_placement",
  "add_text_overlay",
  "creative_stickers",
  "description_automation",
  "enhance_cta",
  "image_animation",
  "image_background_gen",
  "image_brightness_and_contrast",
  "image_templates",
  "image_text_translation",
  "image_touchups",
  "image_uncrop",
  "inline_comment",
  "media_type_automation",
  "reveal_details_over_time",
  "text_optimizations",
  "text_translation",
] as const;
export type EnhancementFeature = (typeof OPTED_OUT_FEATURES)[number];
export type EnrollStatus = "OPT_IN" | "OPT_OUT";
export type EnhancementsBlock = { creative_features_spec: Record<string, { enroll_status: EnrollStatus }> };

/** The enhancements block: every feature OPT_OUT, or OPT_IN with "Let Meta improve my ad"; per-feature toggles win. */
export function enhancementsSpec(optIn = false, perFeature: Readonly<Record<string, boolean>> = {}): EnhancementsBlock {
  const status = (f: string): EnrollStatus => ((perFeature[f] ?? optIn) ? "OPT_IN" : "OPT_OUT");
  return { creative_features_spec: Object.fromEntries(OPTED_OUT_FEATURES.map((f) => [f, { enroll_status: status(f) }])) };
}

/** Every feature OPT_OUT (the default for every creative, D11). */
export function optOutSpec(): EnhancementsBlock {
  return enhancementsSpec(false);
}

// ===== Inputs =====

export const CREATIVE_SHAPES = ["fb_post_boost", "ig_media_boost", "single_image", "single_video", "carousel", "placement_assets"] as const;
export type CreativeShape = (typeof CREATIVE_SHAPES)[number];

/** Media already on the ad account: image hashes (M1) and video ids (M2) with their thumbnail hashes. */
export type ShapeMedia = {
  imageHash?: string | null;
  verticalImageHash?: string | null;
  videoId?: string | null;
  verticalVideoId?: string | null;
  thumbHash?: string | null;
  verticalThumbHash?: string | null;
};
export type ShapeCard = { imageHash?: string | null; videoId?: string | null; thumbHash?: string | null; headline: string; description?: string | null; link?: string | null };

export type CreativeShapeInput = {
  name: string;
  goal: GoalKey;
  source: SourceKind;
  format: AdFormat;
  pageId: string;
  /** The Instagram account (or Page-backed identity) the ad runs as. */
  instagramUserId?: string | null;
  /** Facebook post boost: the post's promotable_id (B1). */
  promotableId?: string | null;
  /** "Also show on Instagram" and Meta's is_instagram_eligible for the post (B3). */
  alsoInstagram?: boolean;
  igEligible?: boolean;
  /** Instagram media boost: the media id (B4). */
  igMediaId?: string | null;
  /**
   * Send a call to action on a boosted post. Default: only once the runbook proved it for this goal (V-P3). Without it, a
   * post can't be used for a goal whose button carries a value (goal_source).
   */
  ctaOnBoost?: boolean;
  primaryText?: string | null;
  headline?: string | null;
  description?: string | null;
  link?: string | null;
  /** null: the goal's default call to action (4.3). */
  ctaType?: string | null;
  leadFormId?: string | null;
  welcome?: { message: string; iceBreakers?: readonly IceBreaker[] } | null;
  media?: ShapeMedia;
  cards?: readonly ShapeCard[];
  /** The ad set's chosen positions; empty is Automatic. Filters the asset customization rules. */
  positions?: readonly PlacementKey[];
  enhancementsOptIn?: boolean;
  enhancementFeatures?: Readonly<Record<string, boolean>>;
  /** URL parameters (More options); null or empty uses the default for website goals. */
  urlTags?: string | null;
};

export const MAX_ICE_BREAKERS = 3;
export const ICE_BREAKER_TITLE_MAX = 80;
export const ICE_BREAKER_RESPONSE_MAX = 300;
const CAROUSEL_MIN = 2;
const CAROUSEL_MAX = 10;

const CHAT_GOALS: ReadonlySet<GoalKey> = new Set(["whatsapp_chats", "instagram_dms", "messenger_chats", "any_chat"]);
const WEBSITE_GOALS: ReadonlySet<GoalKey> = new Set(["website_visits", "website_sales"]);

// ===== Choosing a shape =====

/** The shape for a goal x source x format (and, for a single image or video, whether a tall version exists). */
export function chooseShape(i: Pick<CreativeShapeInput, "source" | "format" | "media">): CreativeShape {
  if (i.source === "fb_post") return "fb_post_boost";
  if (i.source === "ig_media") return "ig_media_boost";
  if (i.format === "carousel") return "carousel";
  if (i.format === "single_image") return i.media?.imageHash && i.media?.verticalImageHash ? "placement_assets" : "single_image";
  if (i.format === "single_video") return i.media?.videoId && i.media?.verticalVideoId ? "placement_assets" : "single_video";
  throw new RangeError("A new ad needs an image, a video or a carousel.");
}

export type ShapeProblemCode =
  | "missing_page"
  | "goal_source"
  | "goal_format"
  | "missing_post"
  | "missing_instagram_account"
  | "missing_media"
  | "missing_thumbnail"
  | "missing_link"
  | "link_https"
  | "missing_form"
  | "carousel_cards"
  | "ice_breakers";

const https = (s: string | null | undefined) => !!s && /^https:\/\/[^\s]+$/.test(s);

/** What stops a body from being built, in order. Empty when the shape can be built. */
export function creativeShapeProblems(i: CreativeShapeInput): ShapeProblemCode[] {
  const out: ShapeProblemCode[] = [];
  if (!i.pageId) out.push("missing_page");
  // A post for a lead, website or chat goal only once its boost button is proven (V-P3): without it Meta gets no form,
  // link or chat app and refuses the ad at launch.
  const boost = { ctaOnBoost: i.ctaOnBoost };
  if (!sourcesFor(i.goal, boost).includes(i.source)) out.push("goal_source");
  else if (!formatsFor(i.goal, i.source, boost).includes(i.format)) out.push("goal_format");
  const spec = CTA_BY_GOAL[i.goal];
  if (i.source === "fb_post" && !i.promotableId) out.push("missing_post");
  if (i.source === "ig_media") {
    if (!i.igMediaId) out.push("missing_post");
    if (!i.instagramUserId) out.push("missing_instagram_account");
  }
  if (i.source === "new") {
    const m = i.media ?? {};
    if (i.format === "single_image" && !m.imageHash) out.push("missing_media");
    if (i.format === "single_video" && !m.videoId) out.push("missing_media");
    if (i.format === "single_video" && !m.thumbHash) out.push("missing_thumbnail");
    if (i.format === "carousel") {
      const cards = i.cards ?? [];
      if (cards.length < CAROUSEL_MIN || cards.length > CAROUSEL_MAX) out.push("carousel_cards");
      if (cards.some((c) => !c.imageHash && !c.videoId)) out.push("missing_media");
      if (cards.some((c) => c.videoId && !c.thumbHash)) out.push("missing_thumbnail");
      if (spec.valueFrom === "link" && !https(i.link) && cards.some((c) => !https(c.link))) out.push("missing_link");
    }
  }
  // Website goals send the member's link from a new ad and from a boosted post alike.
  if (WEBSITE_GOALS.has(i.goal) && i.format !== "carousel" && !https(i.link)) out.push("missing_link");
  if (i.link && !https(i.link)) out.push("link_https");
  // A lead ad needs its form whatever the source.
  if (spec.valueFrom === "lead_form" && !i.leadFormId) out.push("missing_form");
  const ice = i.welcome?.iceBreakers ?? [];
  if (ice.length > MAX_ICE_BREAKERS || ice.some((q) => !q.title.trim() || q.title.length > ICE_BREAKER_TITLE_MAX || !q.response.trim() || q.response.length > ICE_BREAKER_RESPONSE_MAX)) out.push("ice_breakers");
  return [...new Set(out)];
}

// ===== Pieces =====

type Body = Record<string, unknown>;
type Cta = { type: string; value: Record<string, string> };

/** True when the goal sends the member's own website link (website goals, engagement, video views, awareness). */
const usesMemberLink = (goal: GoalKey) => CTA_BY_GOAL[goal].valueFrom === "link";

/** The creative's link: fixed by the goal (WhatsApp, lead forms), else the member's when the goal takes one. */
function linkOf(i: CreativeShapeInput, own: string | null | undefined = i.link): string | null {
  const spec = CTA_BY_GOAL[i.goal];
  if (spec.fixedLink) return spec.fixedLink;
  return usesMemberLink(i.goal) ? own?.trim() || null : null;
}

/** Goals whose button opens a chat or the Instagram profile: link_data without a link (VERIFY V-P4). */
const BUTTON_ONLY_GOALS: ReadonlySet<GoalKey> = new Set(["instagram_dms", "messenger_chats", "any_chat", "profile_visits"]);

/** call_to_action for the goal (4.3), or null when the goal sends no button. */
function ctaOf(i: CreativeShapeInput, link: string | null, opts: { linkInValue?: boolean } = {}): Cta | null {
  const spec = CTA_BY_GOAL[i.goal];
  const type = ctaTypeFor(i.goal, i.ctaType, !!link);
  if (!type) return null;
  const value: Record<string, string> = { ...spec.value };
  if (spec.valueFrom === "link" && link) value.link = link;
  if (spec.valueFrom === "lead_form" && i.leadFormId) value.lead_gen_form_id = i.leadFormId;
  if (spec.valueFrom === "page") value.page = i.pageId;
  if (opts.linkInValue && link && !value.link) value.link = link;
  return { type, value };
}

/** page_welcome_message: today's VISUAL_EDITOR v2 JSON, extended with up to 3 ice breakers (VERIFY V-P4). */
export function welcomeMessageJson(message: string, iceBreakers: readonly IceBreaker[] = []): string {
  const ice = iceBreakers.slice(0, MAX_ICE_BREAKERS).map((q) => ({ title: q.title.slice(0, ICE_BREAKER_TITLE_MAX), response: q.response.slice(0, ICE_BREAKER_RESPONSE_MAX) }));
  return JSON.stringify({
    type: "VISUAL_EDITOR",
    version: 2,
    landing_screen_type: "welcome_message",
    media_type: "text",
    text_format: {
      customer_action_type: "autofill_message",
      message: { autofill_message: { body: message }, text: message, ...(ice.length > 0 ? { ice_breakers: ice } : {}) },
    },
  });
}

function welcomeOf(i: CreativeShapeInput): string | null {
  if (!CTA_BY_GOAL[i.goal].welcomeMessage || !i.welcome?.message?.trim()) return null;
  return welcomeMessageJson(i.welcome.message.trim(), i.welcome.iceBreakers ?? []);
}

/** url_tags for website goals: the member's parameters, or the default UTM set (4.3). */
function urlTagsOf(i: CreativeShapeInput): string | null {
  if (!WEBSITE_GOALS.has(i.goal)) return null;
  const custom = i.urlTags?.trim();
  return custom ? custom : DEFAULT_URL_TAGS;
}

const text = (v: string | null | undefined) => (v ?? "").trim();
const put = (o: Body, key: string, v: unknown) => {
  if (v !== undefined && v !== null && v !== "") o[key] = v;
};

function finish(i: CreativeShapeInput, body: Body): Body {
  body.degrees_of_freedom_spec = enhancementsSpec(i.enhancementsOptIn === true, i.enhancementFeatures ?? {});
  return body;
}

function storySpec(i: CreativeShapeInput): Body {
  const s: Body = { page_id: i.pageId };
  put(s, "instagram_user_id", i.instagramUserId);
  return s;
}

// ===== The 6 shapes =====

/** Facebook post boost (V-P2, V-P3): the post's promotable_id; Instagram too when asked and eligible. */
function fbPostBoost(i: CreativeShapeInput): Body {
  const id = text(i.promotableId);
  const body: Body = { name: i.name, object_story_id: id.includes("_") ? id : `${i.pageId}_${id}` };
  if (i.alsoInstagram && i.igEligible && i.instagramUserId) body.instagram_user_id = i.instagramUserId;
  if (BOOST_NEEDS_BUTTON.has(i.goal) && ctaOnBoost(i)) {
    if (CHAT_GOALS.has(i.goal)) {
      // A messaging goal on an existing post: DOF messaging with a matching call to action (VERIFY V-P3).
      const cta = ctaOf(i, linkOf(i));
      if (cta) body.asset_feed_spec = { optimization_type: "DOF_MESSAGING_DESTINATION", call_to_actions: [cta] };
    } else {
      // A lead form or website goal: the post's button carries the form or the member's link (VERIFY V-P3).
      const cta = ctaOf(i, linkOf(i), { linkInValue: true });
      if (cta) {
        body.call_to_action = cta;
        put(body, "url_tags", urlTagsOf(i));
      }
    }
  }
  return finish(i, body);
}

/** The runbook proved a call to action on boosted posts for this goal (V-P3), unless the caller says otherwise. */
function ctaOnBoost(i: CreativeShapeInput): boolean {
  if (i.goal === "engagement") return false;
  return boostCtaProven(i.goal, { ctaOnBoost: i.ctaOnBoost });
}

/** Instagram media boost (V-P2, V-P3): the Page as object_id, the account, and the media. */
function igMediaBoost(i: CreativeShapeInput): Body {
  const body: Body = { name: i.name, object_id: i.pageId, instagram_user_id: i.instagramUserId, source_instagram_media_id: i.igMediaId };
  if (ctaOnBoost(i)) {
    const link = linkOf(i);
    const cta = ctaOf(i, link, { linkInValue: true });
    if (cta) {
      body.call_to_action = cta;
      put(body, "url_tags", urlTagsOf(i));
    }
  }
  return finish(i, body);
}

/** Single image (today's shape): link_data with the image hash; photo_data when the goal has no link at all. */
function singleImage(i: CreativeShapeInput): Body {
  const link = linkOf(i);
  const cta = ctaOf(i, link);
  const s = storySpec(i);
  if (!link && !BUTTON_ONLY_GOALS.has(i.goal) && !CHAT_GOALS.has(i.goal)) {
    // Engagement, awareness and Page likes without a website: a photo post (VERIFY V-P1).
    const photo: Body = { image_hash: i.media?.imageHash };
    put(photo, "caption", text(i.primaryText));
    if (cta) photo.call_to_action = cta;
    s.photo_data = photo;
    return finish(i, { name: i.name, object_story_spec: s });
  }
  const data: Body = { message: text(i.primaryText) };
  put(data, "name", text(i.headline));
  put(data, "description", text(i.description));
  data.image_hash = i.media?.imageHash;
  // Instagram DM and Messenger ads carry no link; the button opens the chat (VERIFY V-P4).
  put(data, "link", link);
  if (cta) data.call_to_action = cta;
  put(data, "page_welcome_message", welcomeOf(i));
  s.link_data = data;
  const body: Body = { name: i.name, object_story_spec: s };
  put(body, "url_tags", urlTagsOf(i));
  return finish(i, body);
}

/** Single video (V-P6): video_data with the video id and its thumbnail hash; the link rides in the button's value. */
function singleVideo(i: CreativeShapeInput): Body {
  const link = linkOf(i);
  const cta = ctaOf(i, link, { linkInValue: true });
  const data: Body = { video_id: i.media?.videoId, image_hash: i.media?.thumbHash };
  put(data, "message", text(i.primaryText));
  put(data, "title", text(i.headline));
  put(data, "link_description", text(i.description));
  if (cta) data.call_to_action = cta;
  put(data, "page_welcome_message", welcomeOf(i));
  const s = storySpec(i);
  s.video_data = data;
  const body: Body = { name: i.name, object_story_spec: s };
  put(body, "url_tags", urlTagsOf(i));
  return finish(i, body);
}

/** Carousel (V-P1): 2 to 10 cards, never auto-ordered and no end card. A lead goal uses one form for every card. */
function carousel(i: CreativeShapeInput): Body {
  const cards = i.cards ?? [];
  const link = linkOf(i) ?? linkOf(i, cards.find((c) => c.link?.trim())?.link);
  const children = cards.map((c) => {
    const cardLink = linkOf(i, c.link?.trim() || link);
    const child: Body = {};
    put(child, "link", cardLink);
    child.name = text(c.headline);
    put(child, "description", text(c.description));
    if (c.videoId) {
      child.video_id = c.videoId;
      put(child, "image_hash", c.thumbHash);
    } else child.image_hash = c.imageHash;
    const cta = ctaOf(i, cardLink);
    if (cta) child.call_to_action = cta;
    return child;
  });
  const data: Body = { message: text(i.primaryText) };
  put(data, "link", link);
  data.child_attachments = children;
  data.multi_share_end_card = false;
  data.multi_share_optimized = false;
  const cta = ctaOf(i, link);
  if (cta) data.call_to_action = cta;
  put(data, "page_welcome_message", welcomeOf(i));
  const s = storySpec(i);
  s.link_data = data;
  const body: Body = { name: i.name, object_story_spec: s };
  put(body, "url_tags", urlTagsOf(i));
  return finish(i, body);
}

/** The two customization rules of 4.3 before filtering: feeds take the 4:5 asset, Stories and Reels the 9:16 one. */
export const FEED_RULE_POSITIONS = { facebook: ["feed", "marketplace", "profile_feed"], instagram: ["stream", "profile_feed", "explore_home"] } as const;
export const VERTICAL_RULE_POSITIONS = { facebook: ["story", "facebook_reels"], instagram: ["story", "reels"] } as const;

/** Meta position names of the chosen placements, per app (for the rule filter). */
const CHOSEN: Readonly<Record<string, { platform: "facebook" | "instagram"; position: string }>> = {
  facebook_feed: { platform: "facebook", position: "feed" },
  facebook_marketplace: { platform: "facebook", position: "marketplace" },
  facebook_profile_feed: { platform: "facebook", position: "profile_feed" },
  facebook_stories: { platform: "facebook", position: "story" },
  facebook_reels: { platform: "facebook", position: "facebook_reels" },
  instagram_feed: { platform: "instagram", position: "stream" },
  instagram_profile_feed: { platform: "instagram", position: "profile_feed" },
  instagram_explore_home: { platform: "instagram", position: "explore_home" },
  instagram_stories: { platform: "instagram", position: "story" },
  instagram_reels: { platform: "instagram", position: "reels" },
};

/** One customization rule, filtered to the chosen positions; null when nothing is left. */
function rule(base: { facebook: readonly string[]; instagram: readonly string[] }, label: "feed" | "vertical", priority: number, positions: readonly PlacementKey[], video: boolean): Body | null {
  const chosen = positions.length === 0 ? null : positions.map((k) => CHOSEN[k]).filter(Boolean);
  const keep = (platform: "facebook" | "instagram") =>
    base[platform].filter((p) => (!video || p !== "explore_home") && (chosen === null || chosen.some((c) => c.platform === platform && c.position === p)));
  const fb = keep("facebook");
  const ig = keep("instagram");
  if (fb.length === 0 && ig.length === 0) return null;
  const spec: Body = { publisher_platforms: [...(fb.length ? ["facebook"] : []), ...(ig.length ? ["instagram"] : [])] };
  if (fb.length) spec.facebook_positions = fb;
  if (ig.length) spec.instagram_positions = ig;
  return { customization_spec: spec, [video ? "video_label" : "image_label"]: { name: label }, priority };
}

/** Per-placement assets (V-P15): one ad, 4:5 on feeds and 9:16 on Stories and Reels. */
function placementAssets(i: CreativeShapeInput): Body {
  const m = i.media ?? {};
  const video = i.format === "single_video";
  const link = linkOf(i);
  const cta = ctaOf(i, link);
  const feed: Body = video ? { video_id: m.videoId, adlabels: [{ name: "feed" }] } : { hash: m.imageHash, adlabels: [{ name: "feed" }] };
  const vertical: Body = video ? { video_id: m.verticalVideoId, adlabels: [{ name: "vertical" }] } : { hash: m.verticalImageHash, adlabels: [{ name: "vertical" }] };
  if (video) {
    put(feed, "thumbnail_hash", m.thumbHash);
    put(vertical, "thumbnail_hash", m.verticalThumbHash ?? m.thumbHash);
  }
  const positions = i.positions ?? [];
  const rules = [rule(FEED_RULE_POSITIONS, "feed", 1, positions, video), rule(VERTICAL_RULE_POSITIONS, "vertical", 2, positions, video)].filter((r): r is Body => r !== null);
  const spec: Body = { [video ? "videos" : "images"]: [feed, vertical] };
  if (text(i.primaryText)) spec.bodies = [{ text: text(i.primaryText) }];
  if (text(i.headline)) spec.titles = [{ text: text(i.headline) }];
  if (text(i.description)) spec.descriptions = [{ text: text(i.description) }];
  if (link) spec.link_urls = [{ website_url: link }];
  if (cta) {
    spec.call_to_action_types = [cta.type];
    // Chat and lead buttons carry a value Meta needs (the app or the form), VERIFY V-P15.
    if (Object.keys(cta.value).some((k) => k !== "link")) spec.call_to_actions = [cta];
  }
  spec.ad_formats = [video ? "SINGLE_VIDEO" : "SINGLE_IMAGE"];
  spec.optimization_type = "PLACEMENT";
  spec.asset_customization_rules = rules;
  const s = storySpec(i);
  put(s, "page_welcome_message", welcomeOf(i));
  const body: Body = { name: i.name, object_story_spec: s, asset_feed_spec: spec };
  put(body, "url_tags", urlTagsOf(i));
  return finish(i, body);
}

const BUILDERS: Readonly<Record<CreativeShape, (i: CreativeShapeInput) => Body>> = {
  fb_post_boost: fbPostBoost,
  ig_media_boost: igMediaBoost,
  single_image: singleImage,
  single_video: singleVideo,
  carousel,
  placement_assets: placementAssets,
};

/**
 * The creative body for a draft's ad. Throws RangeError with the problem codes when the input is incomplete; validation
 * (creativeShapeProblems) shows them as plain copy first, so a throw here is a programming error.
 */
export function buildCreativeShape(i: CreativeShapeInput): { shape: CreativeShape; body: Record<string, unknown> } {
  const problems = creativeShapeProblems(i);
  if (problems.length > 0) throw new RangeError(`The ad isn't complete: ${problems.join(", ")}.`);
  const shape = chooseShape(i);
  return { shape, body: BUILDERS[shape](i) };
}

/**
 * Every key a creative body may hold, at any depth (the snapshot test walks each body against it). The welcome message is
 * a JSON string, so its own keys are not part of the body.
 */
export const CREATIVE_KEYS: ReadonlySet<string> = new Set([
  "name",
  "object_story_id",
  "object_id",
  "instagram_user_id",
  "source_instagram_media_id",
  "object_story_spec",
  "page_id",
  "link_data",
  "photo_data",
  "video_data",
  "message",
  "caption",
  "description",
  "link_description",
  "title",
  "image_hash",
  "video_id",
  "link",
  "call_to_action",
  "call_to_actions",
  "type",
  "value",
  "app_destination",
  "lead_gen_form_id",
  "page",
  "page_welcome_message",
  "child_attachments",
  "multi_share_end_card",
  "multi_share_optimized",
  "url_tags",
  "asset_feed_spec",
  "optimization_type",
  "images",
  "videos",
  "hash",
  "thumbnail_hash",
  "adlabels",
  "bodies",
  "titles",
  "descriptions",
  "text",
  "link_urls",
  "website_url",
  "call_to_action_types",
  "ad_formats",
  "asset_customization_rules",
  "customization_spec",
  "publisher_platforms",
  "facebook_positions",
  "instagram_positions",
  "image_label",
  "video_label",
  "priority",
  "degrees_of_freedom_spec",
  "creative_features_spec",
  "enroll_status",
  ...OPTED_OUT_FEATURES,
]);
