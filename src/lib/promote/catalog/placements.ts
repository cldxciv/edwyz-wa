/**
 * The placement catalog (docs/IG-PAGE-ADS-SPEC.md 4.5, D10, 3.4, 3.5, 3.6). Pure: the 4.5 table including the rows that
 * are never emitted, validPositions() for the [Change] list, placementProblems() for every cross rule, resolvePositions()
 * for the Automatic / "Instagram only" / "Facebook only" chips, and metaPositions() for the targeting fields.
 *
 * Never emitted, by construction and by test: instagram/explore (errors on v26), facebook/video_feeds (deprecated in v24),
 * messenger/story (dropped silently since 2026-10-27) and messenger/messenger_home (hidden until V-P14 verifies it).
 */
import { promoteText, type PromoteCopyKey } from "../copy";
import type { AdFormat, FormType, GoalKey, PlacementKey, PlacementMode, PromoteLang, Tier, TripwireClass, VerifyState } from "../types";
import { PLACEMENT_KEYS, tierAllows } from "../types";
import { goalRow, type GoalPlatform } from "./goals";
import { verifyStateOf } from "./verified";

export type MetaPlatform = "instagram" | "facebook" | "messenger" | "threads" | "whatsapp" | "audience_network";
export type PlacementGroup = "feed" | "stories" | "reels" | "search" | "video" | "side" | "network";
/** ok: in the v26 docs. verify: VERIFY in 4.5. hidden: parses but never validates (messenger_inbox). */
export type PlacementState = "ok" | "verify" | "hidden";
export type PlacementRequire = { anyOf: readonly PlacementKey[]; rule: PromoteCopyKey } | { anyOther: true; rule: PromoteCopyKey } | null;

export type PlacementRow = {
  key: PlacementKey;
  platform: MetaPlatform;
  /** Meta's value in `<platform>_positions`. */
  position: string;
  tier: Tier;
  state: PlacementState;
  group: PlacementGroup;
  requires: PlacementRequire;
  needsInstagramIdentity: boolean;
  videoOnly: boolean;
  noCarousel: boolean;
  /** facebook_stories without facebook_feed adds device_platforms: ['mobile'] (4.3). */
  mobileOnly: boolean;
  desktop: boolean;
  nameKey: PromoteCopyKey;
  verify: VerifyState;
  verifyRefs: readonly string[];
  docUrl: string;
  tripwireClass: TripwireClass;
};

const PLACEMENT_DOC = "/docs/marketing-api/audiences/reference/placement-targeting";

type RowInput = Pick<PlacementRow, "key" | "platform" | "position" | "tier" | "state" | "group"> & Partial<Pick<PlacementRow, "requires" | "videoOnly" | "noCarousel" | "mobileOnly" | "desktop" | "verifyRefs">>;

const row = (r: RowInput): PlacementRow => ({
  requires: null,
  videoOnly: false,
  noCarousel: false,
  mobileOnly: false,
  desktop: false,
  verifyRefs: ["V-P14"],
  ...r,
  needsInstagramIdentity: r.platform === "instagram" || r.platform === "threads" || r.key === "whatsapp_status",
  nameKey: `placement.${r.key}` as PromoteCopyKey,
  verify: verifyStateOf(`placement.${r.key}`),
  docUrl: PLACEMENT_DOC,
  tripwireClass: "ads_create",
});

const NEEDS_STREAM = { anyOf: ["instagram_feed"] as const, rule: "placement.rule.needs_stream" as const };
const NEEDS_FB_FEED = { anyOf: ["facebook_feed"] as const, rule: "placement.rule.needs_feed" as const };

/** The 4.5 table, in display order. */
export const PLACEMENTS: readonly PlacementRow[] = [
  row({ key: "instagram_feed", platform: "instagram", position: "stream", tier: "simple", state: "ok", group: "feed" }),
  row({ key: "instagram_stories", platform: "instagram", position: "story", tier: "simple", state: "ok", group: "stories" }),
  row({ key: "instagram_reels", platform: "instagram", position: "reels", tier: "simple", state: "ok", group: "reels" }),
  row({ key: "instagram_profile_feed", platform: "instagram", position: "profile_feed", tier: "more", state: "ok", group: "feed", requires: NEEDS_STREAM }),
  row({ key: "instagram_profile_reels", platform: "instagram", position: "profile_reels", tier: "more", state: "verify", group: "reels", requires: { anyOf: ["instagram_reels"], rule: "placement.rule.needs_reels" } }),
  row({ key: "instagram_explore_home", platform: "instagram", position: "explore_home", tier: "more", state: "ok", group: "feed", requires: NEEDS_STREAM }),
  row({ key: "instagram_search", platform: "instagram", position: "ig_search", tier: "more", state: "ok", group: "search", requires: NEEDS_STREAM }),
  row({ key: "facebook_feed", platform: "facebook", position: "feed", tier: "simple", state: "ok", group: "feed" }),
  row({ key: "facebook_profile_feed", platform: "facebook", position: "profile_feed", tier: "more", state: "ok", group: "feed", requires: NEEDS_FB_FEED }),
  row({ key: "facebook_marketplace", platform: "facebook", position: "marketplace", tier: "more", state: "ok", group: "feed", requires: NEEDS_FB_FEED }),
  row({ key: "facebook_search", platform: "facebook", position: "search", tier: "more", state: "ok", group: "search", requires: NEEDS_FB_FEED }),
  row({
    key: "facebook_stories",
    platform: "facebook",
    position: "story",
    tier: "simple",
    state: "ok",
    group: "stories",
    requires: { anyOf: ["facebook_feed", "instagram_stories"], rule: "placement.rule.fb_story" },
    noCarousel: true,
    mobileOnly: true,
  }),
  row({ key: "facebook_reels", platform: "facebook", position: "facebook_reels", tier: "simple", state: "ok", group: "reels" }),
  row({ key: "facebook_instream_video", platform: "facebook", position: "instream_video", tier: "all", state: "ok", group: "video", videoOnly: true }),
  row({ key: "facebook_right_column", platform: "facebook", position: "right_hand_column", tier: "all", state: "ok", group: "side", desktop: true }),
  row({ key: "messenger_inbox", platform: "messenger", position: "messenger_home", tier: "all", state: "hidden", group: "feed" }),
  row({ key: "threads_stream", platform: "threads", position: "threads_stream", tier: "all", state: "verify", group: "feed", requires: { anyOf: ["instagram_feed"], rule: "placement.rule.threads" } }),
  row({ key: "whatsapp_status", platform: "whatsapp", position: "status", tier: "all", state: "verify", group: "stories", requires: { anyOf: ["instagram_stories"], rule: "placement.rule.whatsapp_status" } }),
  row({ key: "audience_network", platform: "audience_network", position: "classic", tier: "more", state: "ok", group: "network", requires: { anyOther: true, rule: "placement.rule.never_alone" } }),
];

/** Rows of 4.5 that no code path may ever send (D10). */
export const NEVER_EMITTED: readonly { platform: MetaPlatform; position: string; reason: string }[] = [
  { platform: "instagram", position: "explore", reason: "Errors on v26; explore_home is the valid position." },
  { platform: "facebook", position: "video_feeds", reason: "Deprecated in v24 and errors." },
  { platform: "messenger", position: "story", reason: "Dropped silently since 2026-10-27." },
  { platform: "messenger", position: "messenger_home", reason: "Not in the current docs; hidden until V-P14 verifies it." },
];

const BY_KEY: ReadonlyMap<PlacementKey, PlacementRow> = new Map(PLACEMENTS.map((p) => [p.key, p]));

export function placementRow(key: PlacementKey): PlacementRow {
  const r = BY_KEY.get(key);
  if (!r) throw new RangeError(`Unknown placement: ${key}`);
  return r;
}

/** The positions that higher-intent lead forms allow (3.5). */
export const HIGHER_INTENT_POSITIONS: readonly PlacementKey[] = ["facebook_feed", "instagram_feed"];

export type PositionContext = {
  /** An Instagram account (or a Page-backed identity) is chosen for the ad. */
  hasInstagramIdentity: boolean;
  /** Lead forms only. */
  formType?: FormType;
  /** Hide rows above this tier (the member's disclosure level). */
  tier?: Tier;
  /** For an existing post: whether the post is a video (in-stream video takes videos only). */
  mediaKind?: "image" | "video";
};

const isVideo = (format: AdFormat, ctx: PositionContext) => format === "single_video" || (format === "existing_post" && ctx.mediaKind === "video");

function platformAllowed(goal: GoalKey, row: PlacementRow): boolean {
  const platforms = goalRow(goal).platforms as readonly string[];
  if (!platforms.includes(row.platform)) return false;
  // A Messenger ad never shows in the right column (4.5).
  if (goal === "messenger_chats" && row.key === "facebook_right_column") return false;
  return true;
}

function requirementMet(row: PlacementRow, set: ReadonlySet<PlacementKey>): boolean {
  const req = row.requires;
  if (!req) return true;
  if ("anyOther" in req) return [...set].some((k) => k !== row.key && placementRow(k).platform !== "audience_network");
  return req.anyOf.some((k) => set.has(k));
}

/**
 * The positions that can be valid for a goal and format, in table order: never a hidden row, only the goal's apps, an
 * Instagram identity for Instagram rows, feeds only for higher-intent forms, videos only where a row takes only videos,
 * no carousel in Facebook Stories, and only rows whose required companion can also be chosen. This is the [Change] list
 * (3.4); placementProblems() checks a concrete selection.
 */
export function validPositions(goal: GoalKey, format: AdFormat, ctx: PositionContext): PlacementKey[] {
  let set = new Set<PlacementKey>();
  for (const row of PLACEMENTS) {
    if (row.state === "hidden") continue;
    if (ctx.tier && !tierAllows(ctx.tier, row.tier)) continue;
    if (!platformAllowed(goal, row)) continue;
    if (row.needsInstagramIdentity && !ctx.hasInstagramIdentity) continue;
    if (goal === "lead_form" && ctx.formType === "higher_intent" && !HIGHER_INTENT_POSITIONS.includes(row.key)) continue;
    if (row.videoOnly && !isVideo(format, ctx)) continue;
    if (row.noCarousel && format === "carousel") continue;
    set.add(row.key);
  }
  // Drop rows whose companion cannot be chosen, until nothing changes (a dependency of a dependency).
  for (let changed = true; changed; ) {
    changed = false;
    const next = new Set([...set].filter((k) => requirementMet(placementRow(k), set)));
    if (next.size !== set.size) {
      set = next;
      changed = true;
    }
  }
  return PLACEMENTS.map((p) => p.key).filter((k) => set.has(k));
}

/** The one app a goal is limited to, when it is limited to one (Click-to-Instagram, profile visits, Page likes). */
export function singleAppOf(goal: GoalKey): "instagram" | "facebook" | null {
  const apps = goalRow(goal).platforms.filter((p): p is "instagram" | "facebook" => p === "instagram" || p === "facebook");
  return apps.length === 1 ? apps[0] : null;
}

/** True when Automatic (an empty position list) may be sent as is. */
export function automaticAllowed(goal: GoalKey, ctx: PositionContext): boolean {
  if (singleAppOf(goal)) return false;
  if (goal === "lead_form" && ctx.formType === "higher_intent") return false;
  return ctx.hasInstagramIdentity;
}

const APP_PLATFORMS: Readonly<Record<"instagram" | "facebook", readonly MetaPlatform[]>> = { instagram: ["instagram"], facebook: ["facebook"] };

/**
 * The positions to send for a placement mode (3.1, 3.4): Automatic is [] (Meta chooses) when allowed, otherwise the goal's
 * valid positions up to More; "Instagram only" and "Facebook only" are that app's valid positions up to More; custom keeps
 * the member's list (placementProblems() judges it).
 */
export function resolvePositions(mode: PlacementMode, positions: readonly PlacementKey[], goal: GoalKey, format: AdFormat, ctx: PositionContext): PlacementKey[] {
  if (mode === "custom") return [...positions];
  if (mode === "auto" && automaticAllowed(goal, ctx)) return [];
  // Explicit lists are built as if an Instagram identity existed, so a missing identity shows as its own problem
  // ("Choose your Instagram account") instead of turning an empty list into Automatic.
  const base = validPositions(goal, format, { ...ctx, hasInstagramIdentity: true, tier: "more" });
  if (mode === "auto") {
    if (ctx.hasInstagramIdentity || singleAppOf(goal) === "instagram") return base;
    // No Instagram identity: Automatic runs where no identity is needed (Facebook and Audience Network).
    const noIg = validPositions(goal, format, { ...ctx, tier: "more" });
    return noIg.length > 0 ? noIg : base;
  }
  const keep = new Set<MetaPlatform>(APP_PLATFORMS[mode]);
  const app = base.filter((k) => keep.has(placementRow(k).platform));
  // Re-check companions inside the one app (Facebook Stories may lean on Instagram Stories).
  const set = new Set(app);
  return app.filter((k) => requirementMet(placementRow(k), set));
}

export type PlacementProblemCode =
  | "messenger_changed"
  | "needs_instagram_identity"
  | "higher_intent_feeds_only"
  | "instagram_only"
  | "app_only"
  | "no_right_column_messenger"
  | "not_for_goal"
  | "video_only"
  | "no_carousel_fb_stories"
  | "requires_companion"
  | "never_alone"
  | "whatsapp_status_goal"
  | "needs_tall_image"
  | "needs_tall_video";

export type PlacementProblem = {
  code: PlacementProblemCode;
  severity: "block" | "warn";
  placement: PlacementKey | null;
  key: PromoteCopyKey;
  /** Template vars: `placement` is a copy key of the placement's name, `app` a plain app name. */
  vars?: { placement?: PromoteCopyKey; app?: string };
};

export type PlacementCheckContext = PositionContext & {
  goal: GoalKey;
  format: AdFormat;
  /** A 9:16 asset (image or video) is in the creative. */
  hasVerticalAsset?: boolean;
};

const TALL_GROUPS: ReadonlySet<PlacementGroup> = new Set(["stories", "reels"]);

/**
 * Every cross rule of 4.5 over a concrete selection (an empty selection is Automatic). Blocks stop Start with their fix;
 * warnings ("Add a tall version") do not.
 */
export function placementProblems(selection: readonly PlacementKey[], ctx: PlacementCheckContext): PlacementProblem[] {
  const out: PlacementProblem[] = [];
  const push = (p: PlacementProblem) => {
    if (!out.some((o) => o.code === p.code && o.placement === p.placement)) out.push(p);
  };
  const set = new Set(selection.filter((k): k is PlacementKey => (PLACEMENT_KEYS as readonly string[]).includes(k)));
  const app = singleAppOf(ctx.goal);
  const higherIntent = ctx.goal === "lead_form" && ctx.formType === "higher_intent";

  if (set.size === 0) {
    if (ctx.goal === "instagram_dms") push({ code: "instagram_only", severity: "block", placement: null, key: "placement.rule.instagram_only" });
    else if (app) push({ code: "app_only", severity: "block", placement: null, key: "placement.rule.app_only", vars: { app: app === "instagram" ? "Instagram" : "Facebook" } });
    if (higherIntent) push({ code: "higher_intent_feeds_only", severity: "block", placement: null, key: "placement.rule.higher_intent" });
  }

  for (const key of set) {
    const row = placementRow(key);
    const name = row.nameKey;
    if (row.state === "hidden") {
      push({ code: "messenger_changed", severity: "block", placement: key, key: "placement.rule.messenger_changed" });
      continue;
    }
    if (key === "whatsapp_status" && ctx.goal !== "whatsapp_chats") push({ code: "whatsapp_status_goal", severity: "block", placement: key, key: "placement.rule.whatsapp_status" });
    else if (ctx.goal === "messenger_chats" && key === "facebook_right_column") push({ code: "no_right_column_messenger", severity: "block", placement: key, key: "placement.rule.no_right_column" });
    else if (!platformAllowed(ctx.goal, row)) {
      if (ctx.goal === "instagram_dms") push({ code: "instagram_only", severity: "block", placement: key, key: "placement.rule.instagram_only" });
      else push({ code: "not_for_goal", severity: "block", placement: key, key: "placement.rule.not_for_goal", vars: { placement: name } });
    }
    if (row.needsInstagramIdentity && !ctx.hasInstagramIdentity) push({ code: "needs_instagram_identity", severity: "block", placement: null, key: "placement.rule.needs_ig_identity" });
    if (higherIntent && !HIGHER_INTENT_POSITIONS.includes(key)) push({ code: "higher_intent_feeds_only", severity: "block", placement: key, key: "placement.rule.higher_intent" });
    if (row.videoOnly && !isVideo(ctx.format, ctx)) push({ code: "video_only", severity: "block", placement: key, key: "placement.rule.video_only", vars: { placement: name } });
    if (row.noCarousel && ctx.format === "carousel") push({ code: "no_carousel_fb_stories", severity: "block", placement: key, key: "placement.rule.no_carousel" });
    if (!requirementMet(row, set)) {
      const anyOther = row.requires !== null && "anyOther" in row.requires;
      push({ code: anyOther ? "never_alone" : "requires_companion", severity: "block", placement: key, key: row.requires!.rule, vars: { placement: name } });
    }
  }

  // Stories and Reels without a tall asset (4.5): a warning with "Add a tall version"; videos cannot be cropped.
  const showsTall = set.size === 0 || [...set].some((k) => TALL_GROUPS.has(placementRow(k).group));
  if (showsTall && !ctx.hasVerticalAsset && (ctx.format === "single_image" || ctx.format === "single_video")) {
    if (ctx.format === "single_video") push({ code: "needs_tall_video", severity: "warn", placement: null, key: "placement.rule.video_not_tall" });
    else push({ code: "needs_tall_image", severity: "warn", placement: null, key: "placement.rule.add_tall" });
  }
  return out;
}

/** A problem as plain text in the language (the placement name is translated too). */
export function placementProblemText(p: PlacementProblem, lang: PromoteLang = "en"): string {
  const vars: Record<string, string> = {};
  if (p.vars?.placement) vars.placement = promoteText(p.vars.placement, {}, lang);
  if (p.vars?.app) vars.app = p.vars.app;
  return promoteText(p.key, vars, lang);
}

/** True when a selection has no blocking problem. */
export function placementsValid(selection: readonly PlacementKey[], ctx: PlacementCheckContext): boolean {
  return !placementProblems(selection, ctx).some((p) => p.severity === "block");
}

export type MetaPositions = {
  publisher_platforms?: string[];
  facebook_positions?: string[];
  instagram_positions?: string[];
  messenger_positions?: string[];
  audience_network_positions?: string[];
  threads_positions?: string[];
  /** VERIFY V-P14: the field for WhatsApp Status. */
  whatsapp_positions?: string[];
  device_platforms?: string[];
};

/**
 * The targeting fields for a selection (4.3). Empty means Automatic and sends nothing. A hidden row throws, so
 * messenger_home can never reach Meta, and the never-emitted positions have no key that maps to them.
 */
export function metaPositions(selection: readonly PlacementKey[]): MetaPositions {
  if (selection.length === 0) return {};
  const out: MetaPositions = {};
  const platforms: string[] = [];
  for (const row of PLACEMENTS) {
    if (!selection.includes(row.key)) continue;
    if (row.state === "hidden") throw new RangeError("Pick where your ad shows again: Meta changed Messenger placements");
    if (!platforms.includes(row.platform)) platforms.push(row.platform);
    const field = `${row.platform}_positions` as keyof MetaPositions;
    out[field] = [...(out[field] ?? []), row.position];
  }
  for (const key of selection) if (!BY_KEY.has(key)) throw new RangeError(`Unknown placement: ${String(key)}`);
  out.publisher_platforms = platforms;
  // Facebook Stories without Facebook Feed runs on phones only (4.3).
  if (selection.includes("facebook_stories") && !selection.includes("facebook_feed")) out.device_platforms = ["mobile"];
  return out;
}

/** The goal's apps as placement platforms, for the "Where" fact. */
export function platformsOfGoal(goal: GoalKey): readonly GoalPlatform[] {
  return goalRow(goal).platforms;
}
