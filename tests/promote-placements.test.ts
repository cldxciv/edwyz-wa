import fc from "fast-check";
import { describe, expect, it } from "vitest";

/**
 * The placement catalog (docs/IG-PAGE-ADS-SPEC.md 4.5, D10; PRM-02 acceptance 3): explore, video_feeds, messenger_home
 * and Messenger story are never emitted, and each cross rule of 4.5 holds.
 */
import {
  automaticAllowed,
  availablePlacements,
  GOALS,
  metaPositions,
  NEVER_EMITTED,
  type PlacementCheckContext,
  placementProblems,
  placementProblemText,
  PLACEMENTS,
  placementsValid,
  resolvePositions,
  validPositions,
} from "@/lib/promote/catalog";
import { AD_FORMATS, type AdFormat, type GoalKey, PLACEMENT_KEYS, type PlacementKey, TIERS } from "@/lib/promote/types";

const EMITTABLE = PLACEMENT_KEYS.filter((k) => k !== "messenger_inbox");
const BANNED_PAIRS = [
  ["instagram_positions", "explore"],
  ["facebook_positions", "video_feeds"],
  ["messenger_positions", "messenger_home"],
  ["messenger_positions", "story"],
] as const;

function assertNoBannedPair(out: Record<string, string[] | undefined>) {
  for (const [field, position] of BANNED_PAIRS) expect(out[field] ?? [], `${field} ${position}`).not.toContain(position);
  expect(out.messenger_positions).toBeUndefined();
}

const ctx = (over: Partial<PlacementCheckContext> = {}): PlacementCheckContext => ({ goal: "website_visits", format: "single_image", hasInstagramIdentity: true, hasVerticalAsset: true, ...over });
const codes = (selection: PlacementKey[], over: Partial<PlacementCheckContext> = {}) => placementProblems(selection, ctx(over)).map((p) => p.code);

describe("the 4.5 table", () => {
  it("has every placement key, and the never-emitted rows", () => {
    expect(PLACEMENTS.map((p) => p.key).sort()).toEqual([...PLACEMENT_KEYS].sort());
    expect(NEVER_EMITTED.map((n) => `${n.platform}/${n.position}`).sort()).toEqual(["facebook/video_feeds", "instagram/explore", "messenger/messenger_home", "messenger/story"]);
    for (const n of NEVER_EMITTED) expect(n.reason.length).toBeGreaterThan(5);
    // No row maps to a never-emitted pair.
    for (const p of PLACEMENTS) {
      if (p.state === "hidden") continue;
      expect(NEVER_EMITTED.some((n) => n.platform === p.platform && n.position === p.position), p.key).toBe(false);
    }
    expect(PLACEMENTS.find((p) => p.key === "messenger_inbox")).toMatchObject({ state: "hidden", platform: "messenger", position: "messenger_home" });
    expect(PLACEMENTS.find((p) => p.key === "instagram_explore_home")!.position).toBe("explore_home");
    for (const p of PLACEMENTS) {
      expect(TIERS).toContain(p.tier);
      expect(p.docUrl).toMatch(/^\/docs\//);
      expect(p.tripwireClass).toBe("ads_create");
    }
  });

  it("maps the 4.5 positions", () => {
    const pairs = Object.fromEntries(PLACEMENTS.map((p) => [p.key, `${p.platform}/${p.position}/${p.tier}`]));
    expect(pairs).toMatchObject({
      instagram_feed: "instagram/stream/simple",
      instagram_stories: "instagram/story/simple",
      instagram_reels: "instagram/reels/simple",
      instagram_profile_feed: "instagram/profile_feed/more",
      instagram_profile_reels: "instagram/profile_reels/more",
      instagram_search: "instagram/ig_search/more",
      facebook_feed: "facebook/feed/simple",
      facebook_marketplace: "facebook/marketplace/more",
      facebook_stories: "facebook/story/simple",
      facebook_reels: "facebook/facebook_reels/simple",
      facebook_instream_video: "facebook/instream_video/all",
      facebook_right_column: "facebook/right_hand_column/all",
      threads_stream: "threads/threads_stream/all",
      whatsapp_status: "whatsapp/status/all",
      audience_network: "audience_network/classic/more",
    });
  });
});

describe("never emitted (D10)", () => {
  it("no subset of placements ever sends explore, video_feeds, messenger_home or Messenger story", () => {
    fc.assert(
      fc.property(fc.subarray([...EMITTABLE], { minLength: 0 }), (selection) => {
        assertNoBannedPair(metaPositions(selection) as Record<string, string[] | undefined>);
      }),
      { numRuns: 400 },
    );
  });

  it("refuses messenger_inbox in any selection, so messenger_home cannot reach Meta", () => {
    fc.assert(
      fc.property(fc.subarray([...EMITTABLE]), (selection) => {
        expect(() => metaPositions([...selection, "messenger_inbox"])).toThrow(/Messenger placements/);
      }),
      { numRuns: 100 },
    );
  });

  it("no goal, format, identity, form type or tier ever offers a hidden row, and no resolved mode emits a banned pair", () => {
    for (const g of GOALS) {
      for (const format of AD_FORMATS) {
        for (const hasInstagramIdentity of [true, false]) {
          for (const formType of ["more_volume", "higher_intent"] as const) {
            for (const tier of TIERS) {
              const valid = validPositions(g.key, format, { hasInstagramIdentity, formType, tier, mediaKind: "video" });
              expect(valid).not.toContain("messenger_inbox");
              assertNoBannedPair(metaPositions(valid) as Record<string, string[] | undefined>);
              for (const mode of ["auto", "instagram", "facebook"] as const) {
                const resolved = resolvePositions(mode, [], g.key, format, { hasInstagramIdentity, formType });
                assertNoBannedPair(metaPositions(resolved) as Record<string, string[] | undefined>);
              }
            }
          }
        }
      }
    }
  });

  it("an old row with messenger_inbox parses but fails validation with plain copy", () => {
    const problems = placementProblems(["messenger_inbox", "facebook_feed"], ctx());
    expect(problems.map((p) => p.code)).toContain("messenger_changed");
    expect(placementProblemText(problems.find((p) => p.code === "messenger_changed")!)).toBe("Pick where your ad shows again: Meta changed Messenger placements");
  });
});

describe("cross rules (4.5)", () => {
  it("Instagram positions need an Instagram identity", () => {
    const noIg = validPositions("whatsapp_chats", "single_image", { hasInstagramIdentity: false, tier: "all" });
    expect(noIg.filter((k) => k.startsWith("instagram_") || k === "threads_stream" || k === "whatsapp_status")).toEqual([]);
    expect(noIg).toContain("facebook_feed");
    expect(codes(["instagram_feed", "facebook_feed"], { hasInstagramIdentity: false })).toContain("needs_instagram_identity");
    expect(codes(["instagram_feed", "facebook_feed"], { hasInstagramIdentity: true })).toEqual([]);
    // Automatic without an identity runs only where none is needed.
    const auto = resolvePositions("auto", [], "website_visits", "single_image", { hasInstagramIdentity: false });
    expect(auto.length).toBeGreaterThan(0);
    expect(auto.some((k) => k.startsWith("instagram_"))).toBe(false);
    expect(automaticAllowed("website_visits", { hasInstagramIdentity: true })).toBe(true);
    expect(resolvePositions("auto", [], "website_visits", "single_image", { hasInstagramIdentity: true })).toEqual([]);
  });

  it("higher-intent lead forms allow only Facebook Feed and Instagram Feed", () => {
    expect(validPositions("lead_form", "single_image", { hasInstagramIdentity: true, formType: "higher_intent", tier: "all" })).toEqual(["instagram_feed", "facebook_feed"]);
    expect(codes(["facebook_feed", "facebook_stories"], { goal: "lead_form", formType: "higher_intent" })).toContain("higher_intent_feeds_only");
    expect(codes(["facebook_feed", "instagram_feed"], { goal: "lead_form", formType: "higher_intent" })).toEqual([]);
    expect(codes([], { goal: "lead_form", formType: "higher_intent" })).toContain("higher_intent_feeds_only");
    expect(resolvePositions("auto", [], "lead_form", "single_image", { hasInstagramIdentity: true, formType: "higher_intent" })).toEqual(["instagram_feed", "facebook_feed"]);
    expect(validPositions("lead_form", "single_image", { hasInstagramIdentity: true, formType: "more_volume" })).toContain("instagram_stories");
  });

  it("a Click-to-Instagram ad allows only Instagram positions", () => {
    const valid = validPositions("instagram_dms", "single_image", { hasInstagramIdentity: true, tier: "all" });
    expect(valid.length).toBeGreaterThan(0);
    expect(valid.every((k) => k.startsWith("instagram_"))).toBe(true);
    expect(codes(["instagram_feed", "facebook_feed"], { goal: "instagram_dms" })).toContain("instagram_only");
    expect(codes([], { goal: "instagram_dms" })).toContain("instagram_only");
    expect(codes(["instagram_feed", "instagram_stories"], { goal: "instagram_dms" })).toEqual([]);
    const auto = resolvePositions("auto", [], "instagram_dms", "single_image", { hasInstagramIdentity: true });
    expect(auto.length).toBeGreaterThan(0);
    expect(auto.every((k) => k.startsWith("instagram_"))).toBe(true);
    // Without an identity, the explicit list still names Instagram, so the missing identity is the problem shown.
    const noIg = resolvePositions("auto", [], "instagram_dms", "single_image", { hasInstagramIdentity: false });
    expect(placementProblems(noIg, ctx({ goal: "instagram_dms", hasInstagramIdentity: false })).map((p) => p.code)).toContain("needs_instagram_identity");
  });

  it("a Messenger ad excludes the right column", () => {
    expect(validPositions("messenger_chats", "single_image", { hasInstagramIdentity: true, tier: "all" })).not.toContain("facebook_right_column");
    expect(validPositions("website_visits", "single_image", { hasInstagramIdentity: true, tier: "all" })).toContain("facebook_right_column");
    expect(codes(["facebook_feed", "facebook_right_column"], { goal: "messenger_chats" })).toContain("no_right_column_messenger");
    expect(codes(["facebook_feed", "facebook_right_column"], { goal: "website_visits" })).toEqual([]);
  });

  it("Stories and Reels without a 9:16 asset warn with Add a tall version; videos can't be cropped", () => {
    const image = placementProblems(["instagram_stories", "instagram_feed"], ctx({ hasVerticalAsset: false }));
    expect(image).toEqual([expect.objectContaining({ code: "needs_tall_image", severity: "warn", key: "placement.rule.add_tall" })]);
    expect(placementsValid(["instagram_stories", "instagram_feed"], ctx({ hasVerticalAsset: false }))).toBe(true);
    const video = placementProblems(["facebook_reels"], ctx({ format: "single_video", hasVerticalAsset: false }));
    expect(video.map((p) => p.code)).toEqual(["needs_tall_video"]);
    expect(placementProblemText(video[0])).toContain("Videos can't be cropped here");
    expect(codes(["instagram_stories"], { hasVerticalAsset: true })).toEqual([]);
    expect(codes(["facebook_feed"], { hasVerticalAsset: false })).toEqual([]);
    // Automatic shows in Stories and Reels too.
    expect(codes([], { hasVerticalAsset: false })).toEqual(["needs_tall_image"]);
  });

  it("Facebook Stories needs Facebook Feed or Instagram Stories, and runs on phones only without Facebook Feed", () => {
    expect(codes(["facebook_stories"])).toContain("requires_companion");
    expect(placementProblemText(placementProblems(["facebook_stories"], ctx())[0])).toBe("Facebook Stories needs Facebook Feed or Instagram Stories too.");
    expect(codes(["facebook_stories", "instagram_stories"])).toEqual([]);
    expect(codes(["facebook_stories", "facebook_feed"])).toEqual([]);
    expect(metaPositions(["facebook_stories", "instagram_stories"]).device_platforms).toEqual(["mobile"]);
    expect(metaPositions(["facebook_stories", "facebook_feed"]).device_platforms).toBeUndefined();
  });

  it("Audience Network never runs alone", () => {
    expect(codes(["audience_network"])).toContain("never_alone");
    expect(codes(["audience_network", "facebook_feed"])).toEqual([]);
    expect(validPositions("whatsapp_chats", "single_image", { hasInstagramIdentity: true, tier: "all" })).not.toContain("audience_network");
  });

  it("explore_home, ig_search and the Instagram profile feed need Instagram Feed; profile reels need Reels", () => {
    for (const k of ["instagram_explore_home", "instagram_search", "instagram_profile_feed"] as const) {
      expect(codes([k]), k).toContain("requires_companion");
      expect(codes([k, "instagram_feed"]), k).toEqual([]);
    }
    expect(codes(["instagram_profile_reels"])).toContain("requires_companion");
    expect(codes(["instagram_profile_reels", "instagram_reels"])).toEqual([]);
    expect(placementProblemText(placementProblems(["instagram_search"], ctx())[0])).toBe("Instagram search results needs Instagram Feed too.");
  });

  it("Facebook profile feed, Marketplace and search need Facebook Feed", () => {
    for (const k of ["facebook_profile_feed", "facebook_marketplace", "facebook_search"] as const) {
      expect(codes([k]), k).toContain("requires_companion");
      expect(codes([k, "facebook_feed"]), k).toEqual([]);
    }
  });

  it("no carousel in Facebook Stories", () => {
    expect(validPositions("website_visits", "carousel", { hasInstagramIdentity: true })).not.toContain("facebook_stories");
    expect(codes(["facebook_feed", "facebook_stories"], { format: "carousel" })).toContain("no_carousel_fb_stories");
  });

  it("in-stream video takes videos only", () => {
    expect(validPositions("website_visits", "single_image", { hasInstagramIdentity: true, tier: "all" })).not.toContain("facebook_instream_video");
    expect(validPositions("website_visits", "single_video", { hasInstagramIdentity: true, tier: "all" })).toContain("facebook_instream_video");
    expect(validPositions("website_visits", "existing_post", { hasInstagramIdentity: true, tier: "all", mediaKind: "video" })).toContain("facebook_instream_video");
    expect(codes(["facebook_feed", "facebook_instream_video"])).toContain("video_only");
  });

  it("Threads needs Instagram and Instagram Feed; WhatsApp Status needs Instagram Stories and the WhatsApp goal", () => {
    expect(codes(["threads_stream", "facebook_feed"])).toContain("requires_companion");
    expect(codes(["threads_stream", "instagram_feed"])).toEqual([]);
    expect(codes(["threads_stream", "instagram_feed"], { hasInstagramIdentity: false })).toContain("needs_instagram_identity");
    expect(codes(["whatsapp_status", "instagram_stories"], { goal: "whatsapp_chats" })).toEqual([]);
    expect(codes(["whatsapp_status", "instagram_feed"], { goal: "whatsapp_chats" })).toContain("requires_companion");
    expect(codes(["whatsapp_status", "instagram_stories"], { goal: "website_visits" })).toContain("whatsapp_status_goal");
    expect(validPositions("whatsapp_chats", "single_image", { hasInstagramIdentity: true, tier: "all" })).toContain("whatsapp_status");
    expect(validPositions("lead_form", "single_image", { hasInstagramIdentity: true, tier: "all" })).not.toContain("whatsapp_status");
  });

  it("goals limited to one app keep to it", () => {
    expect(validPositions("profile_visits", "single_image", { hasInstagramIdentity: true, tier: "all" }).every((k) => k.startsWith("instagram_"))).toBe(true);
    expect(validPositions("page_likes", "single_image", { hasInstagramIdentity: true, tier: "all" }).every((k) => k.startsWith("facebook_"))).toBe(true);
    expect(codes([], { goal: "page_likes" })).toContain("app_only");
    expect(placementProblemText(placementProblems([], ctx({ goal: "page_likes" }))[0], "hi")).toBe("इस लक्ष्य के विज्ञापन सिर्फ़ Facebook पर दिखते हैं।");
    expect(codes(["instagram_feed"], { goal: "page_likes" })).toContain("not_for_goal");
  });

  it("the Instagram only and Facebook only chips keep to their app's valid positions", () => {
    const ig = resolvePositions("instagram", [], "whatsapp_chats", "single_image", { hasInstagramIdentity: true });
    const fb = resolvePositions("facebook", [], "whatsapp_chats", "single_image", { hasInstagramIdentity: true });
    expect(ig).toEqual(["instagram_feed", "instagram_stories", "instagram_reels", "instagram_profile_feed", "instagram_profile_reels", "instagram_explore_home", "instagram_search"]);
    expect(fb).toEqual(["facebook_feed", "facebook_profile_feed", "facebook_marketplace", "facebook_search", "facebook_stories", "facebook_reels"]);
    expect(placementsValid(ig, ctx({ goal: "whatsapp_chats" }))).toBe(true);
    expect(placementsValid(fb, ctx({ goal: "whatsapp_chats" }))).toBe(true);
    expect(resolvePositions("custom", ["facebook_feed"], "whatsapp_chats", "single_image", { hasInstagramIdentity: true })).toEqual(["facebook_feed"]);
  });

  it("every valid list passes its own cross rules (fast-check)", () => {
    const goals = GOALS.map((g) => g.key);
    fc.assert(
      fc.property(fc.constantFrom(...goals), fc.constantFrom<AdFormat>("single_image", "single_video", "carousel"), fc.boolean(), fc.constantFrom("more_volume" as const, "higher_intent" as const), (goal: GoalKey, format, hasInstagramIdentity, formType) => {
        const valid = validPositions(goal, format, { hasInstagramIdentity, formType, tier: "all" });
        if (valid.length === 0) return;
        const blocks = placementProblems(valid, { goal, format, hasInstagramIdentity, formType, hasVerticalAsset: true }).filter((p) => p.severity === "block");
        expect(blocks).toEqual([]);
      }),
      { numRuns: 300 },
    );
  });

  it("availablePlacements hides docs-state rows outside sandbox (D22)", () => {
    expect(availablePlacements("website_visits", "single_image", { hasInstagramIdentity: true, sandboxAccount: false, experimental: true })).toEqual([]);
    expect(availablePlacements("website_visits", "single_image", { hasInstagramIdentity: true, sandboxAccount: true, experimental: true })).toContain("instagram_feed");
    expect(availablePlacements("website_visits", "single_image", { hasInstagramIdentity: true, sandboxAccount: true, experimental: true, tier: "simple" })).toEqual([
      "instagram_feed",
      "instagram_stories",
      "instagram_reels",
      "facebook_feed",
      "facebook_stories",
      "facebook_reels",
    ]);
    const verified = (id: string) => (id === "placement.facebook_feed" ? ("sandbox" as const) : ("docs" as const));
    expect(availablePlacements("website_visits", "single_image", { hasInstagramIdentity: true, sandboxAccount: false, verified })).toEqual(["facebook_feed"]);
  });
});
