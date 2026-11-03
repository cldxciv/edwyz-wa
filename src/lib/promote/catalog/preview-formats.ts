/**
 * Meta preview formats per placement (docs/IG-PAGE-ADS-SPEC.md 4.5, 7.4, D18). The `ad_format` of
 * `act_X/generatepreviews` (before launch) and `{creative}/previews` (after), or 'local' where Meta has none and only
 * "Our preview (approximate)" is shown. null: the placement is never previewed (it never validates). VERIFY V-P5.
 */
import type { PlacementKey } from "../types";

export type PreviewFormat = string;

export const PREVIEW_AD_FORMATS: Readonly<Record<PlacementKey, PreviewFormat | "local" | null>> = {
  instagram_feed: "INSTAGRAM_STANDARD",
  instagram_stories: "INSTAGRAM_STORY",
  instagram_reels: "INSTAGRAM_REELS",
  instagram_profile_feed: "INSTAGRAM_PROFILE_FEED",
  instagram_profile_reels: "INSTAGRAM_PROFILE_REELS",
  instagram_explore_home: "INSTAGRAM_EXPLORE_GRID_HOME",
  instagram_search: "local",
  facebook_feed: "MOBILE_FEED_STANDARD",
  facebook_profile_feed: "FACEBOOK_PROFILE_FEED_MOBILE",
  facebook_marketplace: "MARKETPLACE_MOBILE",
  facebook_search: "local",
  facebook_stories: "FACEBOOK_STORY_MOBILE",
  facebook_reels: "FACEBOOK_REELS_MOBILE",
  facebook_instream_video: "local",
  facebook_right_column: "RIGHT_COLUMN_STANDARD",
  messenger_inbox: null,
  threads_stream: "THREADS_STREAM",
  whatsapp_status: "WHATSAPP_STATUS_MEDIA",
  audience_network: "local",
};

/** The preview tabs shown by default (7.4): Instagram Feed, Stories and Reels; Facebook Feed, Stories and Reels. */
export const DEFAULT_PREVIEW_TABS: readonly PlacementKey[] = ["instagram_feed", "instagram_stories", "instagram_reels", "facebook_feed", "facebook_stories", "facebook_reels"];

/** At most 6 Meta previews per review, each cached for 1 hour (D18). */
export const MAX_META_PREVIEWS_PER_REVIEW = 6;
export const PREVIEW_CACHE_MS = 60 * 60_000;

/** The ad_format for a placement, or 'local' (also for a placement Meta has no format for). */
export function previewFormatFor(key: PlacementKey): PreviewFormat | "local" {
  return PREVIEW_AD_FORMATS[key] ?? "local";
}

/** Every Meta ad_format the catalog may request. */
export const META_PREVIEW_FORMATS: readonly PreviewFormat[] = Object.values(PREVIEW_AD_FORMATS).filter((f): f is string => typeof f === "string" && f !== "local");
