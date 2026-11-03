import type { AdFormat, IceBreaker } from "@/lib/promote/types";

/** The old wizard's four templates. Their payloads stay exactly as they were (docs/IG-PAGE-ADS-SPEC.md PRM-04). */
export const LEGACY_TEMPLATES = ["lead_generation", "click_to_whatsapp", "traffic", "boost_post"] as const;
export type LegacyTemplate = (typeof LEGACY_TEMPLATES)[number];

/**
 * Every template key (AdCampaign.template): the four legacy ones first, then the legacy keys of the goal catalog (4.4,
 * src/lib/promote/catalog/goals.ts `template`). AdCampaign.goal holds the plain goal; this key only picks the payload.
 */
export const TEMPLATES = [
  ...LEGACY_TEMPLATES,
  "click_to_instagram",
  "click_to_messenger",
  "website_sales",
  "profile_visits",
  "engagement",
  "video_views",
  "awareness",
  "page_likes",
  "multi_destination",
] as const;
export type AdTemplate = (typeof TEMPLATES)[number];

export const SPECIAL_CATEGORIES = ["none", "housing", "employment", "credit", "social_issues"] as const;
export type SpecialAdCategory = (typeof SPECIAL_CATEGORIES)[number];

export type GeoCity = { key: string; name?: string; radiusKm: number };
/** A pin with a radius, such as "People near my shop" (5.4 AdSet.targeting geo.customLocations). */
export type CustomLocation = { lat: number; lng: number; radiusKm: number; label?: string };
/** A postal code from Meta's location search, such as "IN:110001" (5.4 geo.zips). */
export type GeoZip = { key: string; name?: string };
export type Interest = { id: string; name: string };
export type Gender = "male" | "female";

/**
 * Every placement key of 4.5. The old eight come first so stored rows keep parsing. messenger_inbox only parses: validation
 * refuses it and it is never sent (D10). src/lib/promote/types.ts PLACEMENT_KEYS holds the same keys (a test checks).
 */
export const PLACEMENTS = [
  "facebook_feed",
  "facebook_stories",
  "facebook_reels",
  "instagram_feed",
  "instagram_stories",
  "instagram_reels",
  "messenger_inbox",
  "audience_network",
  "instagram_profile_feed",
  "instagram_profile_reels",
  "instagram_explore_home",
  "instagram_search",
  "facebook_profile_feed",
  "facebook_marketplace",
  "facebook_search",
  "facebook_instream_video",
  "facebook_right_column",
  "threads_stream",
  "whatsapp_status",
] as const;
export type Placement = (typeof PLACEMENTS)[number];

export type Targeting = {
  geo: {
    countries: string[];
    cities: GeoCity[];
    customLocations?: CustomLocation[];
    zips?: GeoZip[];
  };
  ageMin: number;
  ageMax: number;
  /** Empty means all genders. */
  genders: Gender[];
  interests: Interest[];
  /** Empty means automatic placements. */
  placements: Placement[];
  lookalikeAudienceIds: string[];
  /** AdAudience ids. The caller resolves them to Meta audience ids when it builds the ad set. */
  customAudienceIds?: string[];
  excludedAudienceIds?: string[];
  /** "Let Meta find people" (Advantage+ audience, D9). Off unless set, so the old wizard keeps sending 0. */
  advantageAudience?: boolean;
};

/** Ad.creative's media slots (5.4): AdMedia ids, resolved to Meta image hashes and video ids at launch. */
export type CreativeMediaIds = { feed?: string; vertical?: string; square?: string; video?: string };
/** One carousel card (5.4): an AdMedia id plus its text. */
export type CreativeCard = { mediaId: string; headline: string; description?: string; link?: string | null };

export type CreativeInput = {
  pageId: string;
  instagramId?: string;
  message: string;
  headline?: string;
  /** The line under the headline (More options). */
  description?: string;
  link?: string;
  cta?: string;
  leadFormId?: string;
  whatsappNumberId?: string;
  welcomeMessage?: string;
  postId?: string;
  /** Boost an Instagram post instead of a Facebook one: the media id, with instagramId naming the account it is from. */
  instagramMediaId?: string;
  imageUrl?: string;
  imageHash?: string;
  /** A JPEG or PNG from the workspace media library. Its public link is signed again at launch, so it never expires in a draft. */
  mediaKey?: string;
  /** Set by the server when the admin acknowledged housing, employment or credit terms in a campaign declared as category none. */
  categoryTermsAck?: boolean;

  // ===== 5.4 Ad.creative additions (new flows). A creative with a format is built by promote/creative-shapes. =====
  /** As Ad.format. */
  format?: AdFormat;
  media?: CreativeMediaIds;
  /** 2 to 10 cards for a carousel. */
  cards?: CreativeCard[];
  /** The boost source: an Instagram media id, or a Facebook post's promotable_id. */
  igMediaId?: string;
  fbPromotableId?: string;
  /** Up to 3 quick questions under the chat welcome message (title up to 80 characters, response up to 300). */
  iceBreakers?: IceBreaker[];
  /** "Let Meta improve my ad" (D11). Off unless set, so every enhancement is sent as OPT_OUT. */
  enhancementsOptIn?: boolean;
  /** The call to action; the goal's default when empty. */
  ctaType?: string;
  /** URL parameters for website goals; the default UTM set when empty. */
  urlTags?: string;
};

export const isLegacyTemplate = (v: unknown): v is LegacyTemplate => typeof v === "string" && (LEGACY_TEMPLATES as readonly string[]).includes(v);
/** Every template key of 4.4, old and new: for code that builds the new goals (promote, and the old routes once PRM-05 wires them). */
export const isAnyTemplate = (v: unknown): v is AdTemplate => typeof v === "string" && (TEMPLATES as readonly string[]).includes(v);
/**
 * The old routes' guard (POST and PATCH /api/ads/campaigns via parseDraftInput, and validateCampaign before preview and
 * launch): the four old keys only. Those routes are live and not behind PROMOTE_ENABLED, and they cannot build the new
 * goals (no pixel, no media resolution), so every other key stays "Unknown template." until PRM-05 wires them (train P1
 * stays dark). Use isAnyTemplate for the full 4.4 set.
 */
export const isTemplate = (v: unknown): v is LegacyTemplate => isLegacyTemplate(v);
export const isCategory = (v: unknown): v is SpecialAdCategory => typeof v === "string" && (SPECIAL_CATEGORIES as readonly string[]).includes(v);
