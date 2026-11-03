/**
 * Shared types of Instagram and Facebook Page ads (docs/IG-PAGE-ADS-SPEC.md 1.1, 3.1, 3.2, 3.12, 4.4 to 4.6, 6.2; PRM-02).
 *
 * Pure: types and constant lists only. No database, no network. The goal keys live in ./flags (PROMOTE_GOAL_KEYS), which
 * src/lib/env-rules.mjs mirrors, so there is one list; this file re-exports them under the catalog's names.
 */
import type { Gender, SpecialAdCategory } from "@/lib/ads/types";
import type { GraphSpendClass } from "@/lib/spend/types";
import { PROMOTE_GOAL_KEYS, type PromoteGoalKey } from "./flags";

// ===== Goals, sources, formats (4.4, 5.1) =====

/** The 12 goals of 4.4, in catalog order. */
export const GOAL_KEYS = PROMOTE_GOAL_KEYS;
export type GoalKey = PromoteGoalKey;
export const isGoalKey = (v: unknown): v is GoalKey => typeof v === "string" && (GOAL_KEYS as readonly string[]).includes(v);

/** What the ad is made from: a new creative, an existing Facebook post, or an existing Instagram post, reel or story. */
export const SOURCE_KINDS = ["new", "fb_post", "ig_media"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];
export const isSourceKind = (v: unknown): v is SourceKind => typeof v === "string" && (SOURCE_KINDS as readonly string[]).includes(v);

/** Ad.format (5.1 Ad_format_check). An existing post is always `existing_post`. */
export const AD_FORMATS = ["single_image", "single_video", "carousel", "existing_post"] as const;
export type AdFormat = (typeof AD_FORMATS)[number];
export const isAdFormat = (v: unknown): v is AdFormat => typeof v === "string" && (AD_FORMATS as readonly string[]).includes(v);

// ===== Placements (4.5) =====

/** Every placement key of 4.5 that a draft may hold. messenger_inbox only parses (old rows); it never validates. */
export const PLACEMENT_KEYS = [
  "instagram_feed",
  "instagram_stories",
  "instagram_reels",
  "instagram_profile_feed",
  "instagram_profile_reels",
  "instagram_explore_home",
  "instagram_search",
  "facebook_feed",
  "facebook_profile_feed",
  "facebook_marketplace",
  "facebook_search",
  "facebook_stories",
  "facebook_reels",
  "facebook_instream_video",
  "facebook_right_column",
  "messenger_inbox",
  "threads_stream",
  "whatsapp_status",
  "audience_network",
] as const;
export type PlacementKey = (typeof PLACEMENT_KEYS)[number];
export const isPlacementKey = (v: unknown): v is PlacementKey => typeof v === "string" && (PLACEMENT_KEYS as readonly string[]).includes(v);

/** AdCampaign.placementMode (5.1): Automatic, the "Instagram only" and "Facebook only" chips, or manual positions. */
export const PLACEMENT_MODES = ["auto", "instagram", "facebook", "custom"] as const;
export type PlacementMode = (typeof PLACEMENT_MODES)[number];

// ===== Tiers and verify states (1.1, 3.12, 7.5, D22) =====

/** Each catalog row's verify state: from the documentation only, proven in the sandbox, or proven live (9.6). */
export const VERIFY_STATES = ["docs", "sandbox", "live"] as const;
export type VerifyState = (typeof VERIFY_STATES)[number];

/** Progressive disclosure: Simple, More options, All settings. */
export const TIERS = ["simple", "more", "all"] as const;
export type Tier = (typeof TIERS)[number];
export const tierRank = (t: Tier): number => TIERS.indexOf(t);
/** True when a row of tier `row` shows at tier `at`. */
export const tierAllows = (at: Tier, row: Tier): boolean => tierRank(row) <= tierRank(at);

/** The Phase 0 tripwire class of the Meta request a catalog row ends up in (4.1). */
export type TripwireClass = GraphSpendClass;

// ===== Languages (D23) =====

export const PROMOTE_LANGS = ["en", "hi", "hinglish"] as const;
export type PromoteLang = (typeof PROMOTE_LANGS)[number];
export const isPromoteLang = (v: unknown): v is PromoteLang => typeof v === "string" && (PROMOTE_LANGS as readonly string[]).includes(v);

// ===== Dates (3.1a) =====

export const START_MODES = ["now", "at"] as const;
export type StartMode = (typeof START_MODES)[number];

// ===== Lead forms (3.5) =====

export const FORM_TYPES = ["more_volume", "higher_intent"] as const;
export type FormType = (typeof FORM_TYPES)[number];

// ===== Readiness (3.2) =====

/** The readiness checks of 3.2 (and 3.6's two chat rows). prereqs.ts (PRM-07) evaluates them per goal. */
export const READINESS_CHECKS = [
  "facebook_connected",
  "spending_account",
  "daily_limit",
  "account_active",
  "payment_method",
  "page_advertise",
  "currency_match",
  "instagram_identity",
  "instagram_page_link",
  "instagram_ad_account",
  "instagram_messages_access",
  "whatsapp_connected",
  "whatsapp_page_link",
  "leadgen_tos",
  "pixel",
  "custom_audience_tos",
  "privacy_link",
  "shop_location",
  "lead_access",
] as const;
export type ReadinessCheck = (typeof READINESS_CHECKS)[number];
export type ReadinessStatus = "ok" | "missing" | "unknown";

/**
 * The "Opens Meta" screens (8.4). src/lib/meta-connect/meta-screens.ts (PRM-07) is the only allowlist and holds the URLs;
 * this union names the keys the pure core may point at. tests/meta-screens-allowlist.test.ts checks the two agree.
 */
export const META_SCREEN_KEYS = [
  "payment_method",
  "business_verification",
  "leadgen_tos",
  "custom_audience_tos",
  "link_whatsapp_to_page",
  "link_instagram_to_page",
  "page_advertise_task",
  "lead_access_manager",
  "appeal_ad",
  "account_quality",
] as const;
export type MetaScreenKey = (typeof META_SCREEN_KEYS)[number];

export type ReadinessFixKind = "in_app" | "reconnect" | "opens_meta" | "settings" | "ask_owner";
/** One fix per row: an in-app action, Reconnect (the popup), an Opens Meta screen, a settings page, or "Ask {owner}". */
export type ReadinessFix =
  | { kind: "opens_meta"; key: MetaScreenKey }
  | { kind: "in_app" | "reconnect" | "settings" | "ask_owner"; key: string };
export type ReadinessRow = {
  check: ReadinessCheck;
  status: ReadinessStatus;
  fix: ReadinessFix | null;
  /** A row that warns but never blocks Start (an `unknown` row until its VERIFY step passes). */
  warningOnly?: boolean;
};

// ===== Cost (6.2) =====

/** A one-tap refusal fix (3.3, 6.2). Only fixes that fit are ever offered. */
export type Fix =
  | { kind: "lower_daily"; toMinor: bigint }
  | { kind: "fewer_days"; days: number }
  | { kind: "ask_owner" }
  | { kind: "retry_at"; at: Date }
  | { kind: "retry" }
  | { kind: "raise_to_min"; toMinor: bigint };
export type FixKind = Fix["kind"];

export type CostLines = {
  /** "About ₹1,500 in total." */
  about: string;
  /** "At most ₹2,625, because Meta can spend up to 75% more on a busy day." */
  atMost: string;
  /** "Up to ₹2,100 in October and ₹525 in November." */
  byMonth: string;
  /** "₹1,475 left today · ₹17,900 left this month"; null when no daily limit is set. */
  left: string | null;
  /** "November's part is set aside on 1 Nov. ..."; null when the run stays in one month. */
  monthCross: string | null;
  /** "Money is set aside from today, although the ads start on 5 Nov." (D32); null for a start today. */
  setAside: string | null;
};

export type CostView = {
  currency: string;
  /** D x days, summed over versions. */
  aboutTotalMinor: bigint;
  /** Phase 0's worst case for the whole run, summed over versions. */
  atMostMinor: bigint;
  /** The most Phase 0 sets aside per account month (this month first). */
  byMonth: { month: string; minor: bigint }[];
  /** This month's part: what reserveAds checks against the monthly limit. */
  worstMonthMinor: bigint;
  /** What today can add against the daily limit. */
  todayMinor: bigint;
  /** What is left today after this run (null: no daily limit). */
  leftTodayMinor: bigint | null;
  /** What is left this month after this run (null: no monthly limit). */
  leftMonthMinor: bigint | null;
  /** Today's and this month's parts fit what is left. */
  fits: boolean;
  crossesMonth: boolean;
  /** D5, 6.1 rule 5: this month's worst case is at least 50% of what is left this month. */
  typedConfirmRequired: boolean;
  /** D32: the ads start on a later day but money is set aside from today. */
  setAsideFromToday: boolean;
  lines: CostLines;
};

// ===== Review (3.9, 4.10) =====

export const REVIEW_FIX_KINDS = ["edit_text", "edit_media", "edit_link", "appeal", "set_category"] as const;
export type ReviewFixKind = (typeof REVIEW_FIX_KINDS)[number];

// ===== Media (4.6, PRM-03 probe) =====

/** What the server probe (promote/probe.ts, PRM-03) learns about a file. Dimensions are as stored, before rotation. */
export type MediaProbe = {
  kind: "image" | "video";
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  /** Degrees from the video's tkhd matrix: 0, 90, 180 or 270. */
  rotation?: number | null;
  durationMs?: number | null;
  /** Codec four-cc or name: avc1, hvc1, hev1, vp09, av01... */
  videoCodec?: string | null;
};

export const MEDIA_RATIOS = ["1:1", "4:5", "9:16", "1.91:1", "other"] as const;
export type MediaRatio = (typeof MEDIA_RATIOS)[number];

// ===== The draft as the pure core sees it (3.1a, 3.12, 5.4, D28) =====

export type IceBreaker = { title: string; response: string };
export type CarouselCard = { mediaId: string; headline: string; description: string; link: string | null };
export type DraftMedia = { feed: string | null; vertical: string | null; square: string | null; video: string | null };
export type DraftText = { primary: string; headline: string; description: string; link: string | null };
/** A compared version's own creative (3.8). Version A is the draft's top-level creative. */
export type DraftVersion = { text: DraftText; media: DraftMedia };
export type AudienceMode = "meta_finds" | "near_shop" | "i_choose";
export type ShopLocation = { lat: number; lng: number; radiusKm: number; label: string };
export type CompareMode = "single" | "fair_split" | "meta_picks";
export type CompareVariable = "creative" | "audience" | "placement";
export type BidStrategy = "LOWEST_COST_WITHOUT_CAP" | "COST_CAP" | "LOWEST_COST_WITH_BID_CAP";
export type DaypartWindow = { days: number[]; startMinute: number; endMinute: number };

/**
 * A promotion draft as the pure core edits it. The rows (AdCampaign, AdSet, Ad with status draft, D28) stay the truth;
 * promote/service (PRM-09) maps rows to this view and back. Every editable leaf has a path in draft-paths.ts.
 */
export type PromotionDraft = {
  name: string;
  goal: GoalKey;
  source: { kind: SourceKind; ref: string | null };
  /** "Also show on Instagram" (or on Facebook) for a boosted post. */
  alsoOtherApp: boolean;
  format: AdFormat;
  text: DraftText;
  /** null: the goal's call to action (4.3). */
  ctaType: string | null;
  welcome: { message: string; iceBreakers: IceBreaker[] };
  media: DraftMedia;
  cards: CarouselCard[];
  leadFormId: string | null;
  audience: {
    mode: AudienceMode;
    countries: string[];
    ageMin: number;
    ageMax: number | null;
    genders: Gender[];
    interests: { id: string; name: string }[];
    savedAudienceId: string | null;
    customAudienceIds: string[];
    excludedAudienceIds: string[];
    nearShop: ShopLocation | null;
  };
  placements: { mode: PlacementMode; positions: PlacementKey[]; devicePlatforms: ("mobile" | "desktop")[]; softOptOut: boolean };
  budget: { dailyMinor: bigint; lifetimeMinor: bigint | null };
  run: { runDays: number; startMode: StartMode; startsAt: string | null };
  compare: { mode: CompareMode; variable: CompareVariable };
  versions: { B: DraftVersion | null; C: DraftVersion | null };
  specialAdCategory: SpecialAdCategory;
  enhancementsOptIn: boolean;
  /** Per-feature enhancement toggles (All settings); a missing feature follows enhancementsOptIn. */
  enhancementFeatures: Record<string, boolean>;
  urlTags: string | null;
  formType: FormType;
  optimizationGoal: string | null;
  attribution: string | null;
  bid: { strategy: BidStrategy; amountMinor: bigint | null };
  schedule: DaypartWindow[];
  /** Multi-destination messaging (PRM-18): the apps people may choose. Empty: off. */
  destinations: ("whatsapp" | "instagram" | "messenger")[];
};
