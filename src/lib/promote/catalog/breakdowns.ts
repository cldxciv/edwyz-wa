/**
 * Insights breakdowns (docs/IG-PAGE-ADS-SPEC.md 3.10, 4.2 R3 to R5 and R3a, 5.1 InsightBreakdown). Pure data plus the
 * placement name map. ads/insights-fetch.ts (PRM-12) is the only file that makes these calls.
 */
import { promoteText, type PromoteCopyKey } from "../copy";
import type { PlacementKey, PromoteLang } from "../types";

/** InsightBreakdown.dimension (5.1 InsightBreakdown_dimension_check). */
export const BREAKDOWN_DIMENSIONS = ["placement", "asset_body", "asset_title", "asset_image", "asset_video", "asset_cta", "age_gender", "region", "run_total"] as const;
export type BreakdownDimension = (typeof BREAKDOWN_DIMENSIONS)[number];

export type BreakdownRow = {
  dimension: BreakdownDimension;
  /** Meta's `breakdowns` values; empty for the run total (R3a: no breakdown, no time_increment). */
  breakdowns: readonly string[];
  call: "R3" | "R3a" | "R4" | "R5";
  level: "ad" | "campaign";
  /** One row per day (time_increment=1); the run total is one row per campaign. */
  daily: boolean;
  /** Only for ads with per-placement assets (R4). */
  assetAdsOnly: boolean;
};

export const BREAKDOWNS: readonly BreakdownRow[] = [
  { dimension: "placement", breakdowns: ["publisher_platform", "platform_position"], call: "R3", level: "ad", daily: true, assetAdsOnly: false },
  { dimension: "asset_body", breakdowns: ["body_asset"], call: "R4", level: "ad", daily: true, assetAdsOnly: true },
  { dimension: "asset_title", breakdowns: ["title_asset"], call: "R4", level: "ad", daily: true, assetAdsOnly: true },
  { dimension: "asset_image", breakdowns: ["image_asset"], call: "R4", level: "ad", daily: true, assetAdsOnly: true },
  { dimension: "asset_video", breakdowns: ["video_asset"], call: "R4", level: "ad", daily: true, assetAdsOnly: true },
  { dimension: "asset_cta", breakdowns: ["call_to_action_asset"], call: "R4", level: "ad", daily: true, assetAdsOnly: true },
  { dimension: "age_gender", breakdowns: ["age", "gender"], call: "R5", level: "campaign", daily: true, assetAdsOnly: false },
  { dimension: "region", breakdowns: ["region"], call: "R5", level: "campaign", daily: true, assetAdsOnly: false },
  { dimension: "run_total", breakdowns: [], call: "R3a", level: "campaign", daily: false, assetAdsOnly: false },
];

/** The run total's fixed dimension key (R3a). */
export const RUN_TOTAL_KEY = "all";

/** InsightBreakdown.dimKey of a placement row: Meta's raw `publisher_platform|platform_position` pair, lower case. */
export function placementDimKey(platform: string, position: string): string {
  return `${platform.trim().toLowerCase()}|${position.trim().toLowerCase()}`;
}

/**
 * Known `publisher_platform|platform_position` pairs as Meta reports them. Instagram's are documented; Facebook's are not
 * (4.2), so unknown pairs show as "Facebook: {raw}" until V-P17 records them.
 */
export const KNOWN_PLACEMENTS: Readonly<Record<string, PlacementKey>> = {
  "instagram|feed": "instagram_feed",
  "instagram|stream": "instagram_feed",
  "instagram|story": "instagram_stories",
  "instagram|reels": "instagram_reels",
  "instagram|profile_feed": "instagram_profile_feed",
  "instagram|profile_reels": "instagram_profile_reels",
  "instagram|explore_home": "instagram_explore_home",
  "instagram|ig_search": "instagram_search",
  "facebook|feed": "facebook_feed",
  "facebook|profile_feed": "facebook_profile_feed",
  "facebook|marketplace": "facebook_marketplace",
  "facebook|search": "facebook_search",
  "facebook|facebook_stories": "facebook_stories",
  "facebook|story": "facebook_stories",
  "facebook|facebook_reels": "facebook_reels",
  "facebook|instream_video": "facebook_instream_video",
  "facebook|right_hand_column": "facebook_right_column",
  "threads|threads_stream": "threads_stream",
  "whatsapp|status": "whatsapp_status",
  "audience_network|classic": "audience_network",
  "audience_network|an_classic": "audience_network",
};

const PLATFORM_COPY: Readonly<Record<string, PromoteCopyKey>> = {
  facebook: "results.platform.facebook",
  instagram: "results.platform.instagram",
  messenger: "results.platform.messenger",
  threads: "results.platform.threads",
  whatsapp: "results.platform.whatsapp",
  audience_network: "results.platform.audience_network",
};

/** The placement a dimension key names, or null when it is not a known pair. */
export function placementOfDimKey(dimKey: string): PlacementKey | null {
  return KNOWN_PLACEMENTS[dimKey.trim().toLowerCase()] ?? null;
}

/** "Instagram Reels" for a known pair, else "Facebook: {raw position}" (3.10, 4.2). */
export function placementName(dimKey: string, lang: PromoteLang = "en"): string {
  const known = placementOfDimKey(dimKey);
  if (known) return promoteText(`placement.${known}` as PromoteCopyKey, {}, lang);
  const [platform = "", raw = ""] = dimKey.split("|");
  const key = PLATFORM_COPY[platform.trim().toLowerCase()];
  const platformName = key ? promoteText(key, {}, lang) : platform;
  return promoteText("results.unknown_position", { platform: platformName, raw }, lang);
}
