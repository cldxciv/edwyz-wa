import fc from "fast-check";
import { describe, expect, it } from "vitest";

/**
 * Draft paths (docs/IG-PAGE-ADS-SPEC.md 3.12, 7.5, 6.6; PRM-02 acceptance 7 and 10): every editable path has a tier, the
 * map is the allowlist for update_promotion_draft, values are parsed and bounded, and switching tiers loses no value.
 */
import {
  applyPath,
  applyPaths,
  chipPathOf,
  defaultDraft,
  DRAFT_PATH_LIST,
  DRAFT_PATHS,
  DraftPathError,
  hiddenNonDefaults,
  isDraftPath,
  pathsForTier,
  readPath,
  resetHidden,
  sameValue,
  valueTier,
} from "@/lib/promote/draft-paths";
import { type PromotionDraft, type Tier, TIERS, tierRank } from "@/lib/promote/types";

/** One valid, non-default value for every path. A new path must add its sample here. */
const SAMPLES: Record<string, unknown> = {
  name: "Diwali boost",
  goal: "lead_form",
  "source.kind": "ig_media",
  "source.ref": "17890000000000001",
  alsoOtherApp: false,
  format: "carousel",
  "text.primary": "Diwali offer: 20% off",
  "text.headline": "Book today",
  "text.link": "https://shop.example.in/offer",
  "media.feed": "media_feed_1",
  "media.vertical": "media_tall_1",
  "media.square": "media_square_1",
  "media.video": "media_video_1",
  cards: [
    { mediaId: "m1", headline: "Haircut", description: "From ₹499", link: "https://shop.example.in/hair" },
    { mediaId: "m2", headline: "Facial", description: "From ₹899", link: null },
  ],
  leadFormId: "lf_1",
  formType: "higher_intent",
  "welcome.message": "Hi! I saw your ad",
  "audience.mode": "near_shop",
  "audience.nearShop": { lat: 19.07, lng: 72.87, radiusKm: 5, label: "Bandra shop" },
  "budget.dailyMinor": "28000",
  "run.runDays": 5,
  "placements.mode": "instagram",
  specialAdCategory: "employment",
  "text.description": "Open 10 to 8",
  ctaType: "BOOK_NOW",
  "welcome.iceBreakers": [{ title: "Price?", response: "From ₹499" }],
  "audience.countries": ["IN", "AE"],
  "audience.ageMin": 21,
  "audience.ageMax": 45,
  "audience.genders": ["female"],
  "audience.interests": [{ id: "6003139266461", name: "Beauty" }],
  "audience.savedAudienceId": "aud_saved_1",
  "audience.customAudienceIds": ["aud_1", "aud_2"],
  "audience.excludedAudienceIds": ["aud_3"],
  "placements.positions": ["instagram_feed", "instagram_stories"],
  "run.startMode": "at",
  "run.startsAt": "2026-11-05T03:30:00.000Z",
  urlTags: "utm_source=diwali",
  enhancementsOptIn: true,
  "compare.mode": "fair_split",
  "compare.variable": "audience",
  "versions.B": { text: { primary: "Whole version B" }, media: { feed: "b_whole_feed" } },
  "versions.C": {},
  "versions.B.text.primary": "Version B text",
  "versions.B.text.headline": "Version B headline",
  "versions.B.text.description": "B description",
  "versions.B.text.link": "https://shop.example.in/b",
  "versions.B.media.feed": "b_feed",
  "versions.B.media.vertical": "b_tall",
  "versions.B.media.square": "b_square",
  "versions.B.media.video": "b_video",
  "versions.C.text.primary": "Version C text",
  "versions.C.text.headline": "Version C headline",
  "versions.C.text.description": "C description",
  "versions.C.text.link": "https://shop.example.in/c",
  "versions.C.media.feed": "c_feed",
  "versions.C.media.vertical": "c_tall",
  "versions.C.media.square": "c_square",
  "versions.C.media.video": "c_video",
  optimizationGoal: "QUALITY_LEAD",
  attribution: "7d_click",
  "bid.strategy": "COST_CAP",
  "bid.amountMinor": 15_000,
  "budget.lifetimeMinor": 500_000n,
  schedule: [{ days: [1, 2, 3], startMinute: 540, endMinute: 1_200 }],
  "placements.devicePlatforms": ["mobile"],
  "placements.softOptOut": true,
  destinations: ["whatsapp", "instagram"],
  enhancementFeatures: { image_touchups: true },
};

const DEFAULT = defaultDraft("whatsapp_chats");
const full = (): PromotionDraft => DRAFT_PATH_LIST.reduce((d, p) => applyPath(d, p, SAMPLES[p]), DEFAULT);

/** Every leaf of the draft, as a dotted path (stopping at allowlisted paths, which may hold objects or arrays). */
function leaves(v: unknown, prefix = "", out: string[] = []): string[] {
  if (prefix && isDraftPath(prefix)) {
    out.push(prefix);
    return out;
  }
  if (v && typeof v === "object" && !Array.isArray(v) && typeof v !== "bigint") {
    for (const [k, x] of Object.entries(v)) leaves(x, prefix ? `${prefix}.${k}` : k, out);
    return out;
  }
  out.push(prefix);
  return out;
}

describe("the path map (3.12)", () => {
  it("gives every path a tier and a sample", () => {
    expect(DRAFT_PATH_LIST.length).toBeGreaterThan(60);
    for (const p of DRAFT_PATH_LIST) expect(TIERS, p).toContain(DRAFT_PATHS[p].tier);
    expect(Object.keys(SAMPLES).sort()).toEqual([...DRAFT_PATH_LIST].sort());
  });

  it("covers every editable leaf of the draft", () => {
    for (const leaf of leaves(DEFAULT)) {
      const covered = isDraftPath(leaf) || DRAFT_PATH_LIST.some((p) => p.startsWith(`${leaf}.`));
      expect(covered, leaf).toBe(true);
    }
    for (const leaf of leaves(full())) expect(isDraftPath(leaf), leaf).toBe(true);
  });

  it("puts each setting in the 3.12 tier", () => {
    const tier = (p: string) => DRAFT_PATHS[p].tier;
    for (const p of ["goal", "budget.dailyMinor", "run.runDays", "text.primary", "placements.mode", "audience.mode"]) expect(tier(p), p).toBe("simple");
    for (const p of ["placements.positions", "audience.ageMin", "audience.interests", "ctaType", "run.startsAt", "urlTags", "enhancementsOptIn", "compare.mode", "audience.customAudienceIds"]) expect(tier(p), p).toBe("more");
    for (const p of ["optimizationGoal", "attribution", "bid.strategy", "bid.amountMinor", "budget.lifetimeMinor", "schedule", "placements.devicePlatforms", "placements.softOptOut", "destinations", "enhancementFeatures"]) expect(tier(p), p).toBe("all");
    expect(pathsForTier("simple").every((p) => DRAFT_PATHS[p].tier === "simple")).toBe(true);
    expect(pathsForTier("all")).toHaveLength(DRAFT_PATH_LIST.length);
  });

  it("is the allowlist: anything else is refused", () => {
    for (const p of ["budget.daily_budget", "status", "__proto__", "constructor", "audience", "versions.D.text.primary", "versions", "versions.B.text", "versions.B.nope", "versions.D", "toString", ""]) {
      expect(isDraftPath(p), p).toBe(false);
      expect(() => applyPath(DEFAULT, p, 1)).toThrow(DraftPathError);
    }
    const thrown = (() => {
      try {
        applyPath(DEFAULT, "budget.lifetime", 1);
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(thrown).toMatchObject({ code: "unknown_path", key: "draft.unknown_path" });
    expect(() => applyPath(DEFAULT, "run.runDays", 0)).toThrow(expect.objectContaining({ code: "bad_value", key: "draft.bad_value" }));
  });
});

describe("applying values", () => {
  it("applies every sample without touching the input, and reads it back", () => {
    const before = structuredClone(DEFAULT);
    const d = full();
    expect(DEFAULT).toEqual(before);
    expect(readPath(d, "budget.dailyMinor")).toBe(28_000n);
    expect(readPath(d, "bid.amountMinor")).toBe(15_000n);
    expect(readPath(d, "run.startsAt")).toBe("2026-11-05T03:30:00.000Z");
    expect(readPath(d, "versions.B.text.primary")).toBe("Version B text");
    expect(readPath(DEFAULT, "versions.B.text.primary")).toBeUndefined();
    for (const p of DRAFT_PATH_LIST) expect(sameValue(readPath(d, p), readPath(DEFAULT, p)), p).toBe(false);
  });

  it("starts a compared version empty the first time one of its fields is set", () => {
    const d = applyPath(DEFAULT, "versions.C.media.vertical", "c_tall");
    expect(d.versions.C).toEqual({ text: { primary: "", headline: "", description: "", link: null }, media: { feed: null, vertical: "c_tall", square: null, video: null } });
    expect(d.versions.B).toBeNull();
  });

  it("refuses a bad value on every path", () => {
    for (const p of DRAFT_PATH_LIST) {
      expect(() => applyPath(DEFAULT, p, undefined), p).toThrow(DraftPathError);
      expect(() => applyPath(DEFAULT, p, { nope: Symbol("x") }), p).toThrow(DraftPathError);
    }
  });

  it("bounds the values that matter for money, dates and Meta's limits", () => {
    const bad = (p: string, v: unknown) => expect(() => applyPath(DEFAULT, p, v), `${p} ${String(v)}`).toThrow(DraftPathError);
    bad("budget.dailyMinor", -1);
    bad("budget.dailyMinor", "1e5");
    bad("budget.dailyMinor", 1.5);
    expect(readPath(applyPath(DEFAULT, "budget.dailyMinor", 30_000), "budget.dailyMinor")).toBe(30_000n);
    expect(readPath(applyPath(DEFAULT, "budget.dailyMinor", 30_000n), "budget.dailyMinor")).toBe(30_000n);
    bad("run.runDays", 1);
    bad("run.runDays", 91);
    bad("run.runDays", 2.5);
    bad("text.link", "http://shop.example.in");
    bad("welcome.iceBreakers", [{ title: "x".repeat(81), response: "y" }]);
    bad("welcome.iceBreakers", Array.from({ length: 4 }, () => ({ title: "a", response: "b" })));
    bad("placements.positions", ["instagram_explore"]);
    bad("ctaType", "BUY_NOW_PLEASE");
    bad("goal", "boost_post");
    bad("audience.countries", ["india"]);
    bad("audience.interests", [{ id: "abc", name: "x" }]);
    bad("schedule", [{ days: [1], startMinute: 30, endMinute: 120 }]);
    bad("enhancementFeatures", { standard_enhancements: true });
    bad("cards", Array.from({ length: 11 }, (_, i) => ({ mediaId: `m${i}`, headline: "h", description: "", link: null })));
    bad("run.startsAt", "not a date");
    bad("versions.B", { text: { primary: "x", status: "ACTIVE" } });
    bad("versions.B", { text: { link: "http://shop.example.in" } });
    bad("versions.C", { media: "m1" });
    bad("versions.C", []);
    // messenger_inbox still parses (old rows); validation (placements.ts) refuses it with plain copy.
    expect(readPath(applyPath(DEFAULT, "placements.positions", ["messenger_inbox"]), "placements.positions")).toEqual(["messenger_inbox"]);
  });

  it("applies a PATCH all or nothing, and returns the before values for Undo", () => {
    const { draft, before } = applyPaths(DEFAULT, { "budget.dailyMinor": 25_000, "run.runDays": 5 });
    expect(draft.budget.dailyMinor).toBe(25_000n);
    expect(draft.run.runDays).toBe(5);
    expect(before).toEqual({ "budget.dailyMinor": 30_000n, "run.runDays": 7 });
    expect(applyPaths(draft, before).draft).toEqual(DEFAULT);
    expect(() => applyPaths(DEFAULT, { "run.runDays": 5, "budget.dailyMinor": -5 })).toThrow(DraftPathError);
  });

  it("round-trips Undo for every path, starting from the defaults", () => {
    for (const p of DRAFT_PATH_LIST) {
      const { draft, before } = applyPaths(DEFAULT, { [p]: SAMPLES[p] });
      expect(sameValue(readPath(draft, p), readPath(DEFAULT, p)), p).toBe(false);
      expect(applyPaths(draft, before).draft, p).toEqual(DEFAULT);
    }
    // And from a draft where every path is set: each path back to its default (a version's field to the other
    // version's sample, a whole version to null), then Undo.
    const d = full();
    const swap = (p: string) => (p.startsWith("versions.B") ? p.replace("versions.B", "versions.C") : p.replace("versions.C", "versions.B"));
    for (const p of DRAFT_PATH_LIST) {
      const value = chipPathOf(p) !== p ? SAMPLES[swap(p)] : readPath(DEFAULT, p);
      const { draft, before } = applyPaths(d, { [p]: value });
      expect(sameValue(readPath(draft, p), readPath(d, p)), p).toBe(false);
      expect(applyPaths(draft, before).draft, p).toEqual(d);
    }
  });

  it("Undo of a compared version's first edit removes the version again", () => {
    const { draft, before } = applyPaths(DEFAULT, { "versions.B.text.primary": "hello", "versions.B.media.feed": "b_feed" });
    expect(draft.versions.B).toEqual({ text: { primary: "hello", headline: "", description: "", link: null }, media: { feed: "b_feed", vertical: null, square: null, video: null } });
    expect(before).toEqual({ "versions.B": null });
    const undone = applyPaths(draft, before);
    expect(undone.draft.versions).toEqual({ B: null, C: null });
    expect(undone.draft).toEqual(DEFAULT);
    // Redo replays the before of the Undo.
    expect(applyPaths(undone.draft, undone.before).draft).toEqual(draft);
  });

  it("adds, replaces and removes a whole compared version (3.8 remove a version), and Undo brings it back", () => {
    const withB = applyPath(DEFAULT, "versions.B", { text: { primary: "B text", link: "https://shop.example.in/b" } });
    expect(withB.versions.B).toEqual({ text: { primary: "B text", headline: "", description: "", link: "https://shop.example.in/b" }, media: { feed: null, vertical: null, square: null, video: null } });
    expect(applyPath(DEFAULT, "versions.C", {}).versions.C).toEqual({ text: { primary: "", headline: "", description: "", link: null }, media: { feed: null, vertical: null, square: null, video: null } });
    const { draft: removed, before } = applyPaths(withB, { "versions.B": null });
    expect(removed.versions.B).toBeNull();
    expect(before).toEqual({ "versions.B": withB.versions.B });
    expect(applyPaths(removed, before).draft).toEqual(withB);
    // Removing a version that is not there is harmless, and so is its Undo.
    const again = applyPaths(DEFAULT, { "versions.C": null });
    expect(again.draft).toEqual(DEFAULT);
    expect(applyPaths(again.draft, again.before).draft).toEqual(DEFAULT);
  });

  it("never targets anyone under 18 (DPDP Act s.9(3), Meta's teen rules)", () => {
    for (const age of [13, 14, 15, 16, 17, 0, -1, 66, 17.5]) {
      expect(() => applyPath(DEFAULT, "audience.ageMin", age), `ageMin ${age}`).toThrow(DraftPathError);
      expect(() => applyPath(DEFAULT, "audience.ageMax", age), `ageMax ${age}`).toThrow(DraftPathError);
    }
    expect(applyPath(DEFAULT, "audience.ageMin", 18).audience.ageMin).toBe(18);
    expect(applyPath(DEFAULT, "audience.ageMax", 65).audience.ageMax).toBe(65);
    expect(applyPath(DEFAULT, "audience.ageMax", null).audience.ageMax).toBeNull();
    expect(DEFAULT.audience.ageMin).toBe(18);
  });
});

describe("switching tiers loses no value (7.5)", () => {
  it("keeps every value through any sequence of tier switches", () => {
    const d = full();
    const snapshot = structuredClone(d);
    for (const tier of ["simple", "more", "all", "simple", "more", "simple", "all"] as Tier[]) {
      hiddenNonDefaults(d, tier);
      pathsForTier(tier);
      expect(d).toEqual(snapshot);
      for (const p of DRAFT_PATH_LIST) expect(sameValue(readPath(d, p), readPath(snapshot, p)), p).toBe(true);
    }
  });

  it("shows every hidden non-default value as a chip, and nothing that is visible", () => {
    const d = full();
    const simple = hiddenNonDefaults(d, "simple").map((h) => h.path);
    for (const p of DRAFT_PATH_LIST) {
      const hidden = tierRank(valueTier(p, readPath(d, p))) > tierRank("simple");
      // A version's fields share the version's chip.
      expect(simple.includes(chipPathOf(p)), p).toBe(hidden);
      if (chipPathOf(p) !== p) expect(simple.includes(p), p).toBe(false);
    }
    expect(hiddenNonDefaults(d, "all")).toEqual([]);
    const more = hiddenNonDefaults(d, "more");
    expect(more.every((h) => h.tier === "all")).toBe(true);
    expect(more.map((h) => h.path)).toEqual(DRAFT_PATH_LIST.filter((p) => DRAFT_PATHS[p].tier === "all"));
    expect(hiddenNonDefaults(DEFAULT, "simple")).toEqual([]);
  });

  it("lists values that only a higher tier offers (an All-settings goal, a long run, an All-settings position)", () => {
    const d = applyPaths(DEFAULT, { goal: "page_likes", "run.runDays": 45, "placements.mode": "custom", "placements.positions": ["facebook_feed", "facebook_right_column"] }).draft;
    expect(hiddenNonDefaults(d, "simple", defaultDraft("whatsapp_chats"))).toEqual([
      { path: "goal", tier: "all" },
      { path: "run.runDays", tier: "more" },
      { path: "placements.mode", tier: "more" },
      { path: "placements.positions", tier: "all" },
    ]);
    expect(hiddenNonDefaults(d, "more", defaultDraft("whatsapp_chats")).map((h) => h.path)).toEqual(["goal", "placements.positions"]);
    expect(valueTier("run.runDays", 30)).toBe("simple");
  });

  it("puts hidden values back only on an explicit Reset", () => {
    const d = full();
    const reset = resetHidden(d, "more");
    for (const p of DRAFT_PATH_LIST) {
      const isAll = tierRank(valueTier(p, readPath(d, p))) > tierRank("more");
      expect(sameValue(readPath(reset, p), isAll ? readPath(defaultDraft(d.goal), p) : readPath(d, p)), p).toBe(true);
    }
    expect(hiddenNonDefaults(reset, "more")).toEqual([]);
    const simple = resetHidden(d, "simple");
    expect(simple.versions).toEqual({ B: null, C: null });
    expect(simple.budget.dailyMinor).toBe(28_000n);
  });

  it("counts a compared version once in the chip, however many of its fields changed", () => {
    const d = applyPaths(DEFAULT, { "versions.B.text.primary": "B text", "versions.B.text.headline": "B headline", "versions.B.media.feed": "b_feed" }).draft;
    expect(hiddenNonDefaults(d, "simple")).toEqual([{ path: "versions.B", tier: "more" }]);
    expect(hiddenNonDefaults(applyPath(DEFAULT, "versions.C", {}), "simple")).toEqual([{ path: "versions.C", tier: "more" }]);
    expect(hiddenNonDefaults(d, "more")).toEqual([]);
    expect(resetHidden(d, "simple")).toEqual(DEFAULT);
    expect(chipPathOf("versions.C.media.video")).toBe("versions.C");
    expect(chipPathOf("versions.B")).toBe("versions.B");
    expect(chipPathOf("text.primary")).toBe("text.primary");
  });

  it("every changed value is either visible or chipped, whatever was edited (fast-check)", () => {
    const pathArb = fc.subarray([...DRAFT_PATH_LIST], { minLength: 1 });
    fc.assert(
      fc.property(pathArb, fc.constantFrom<Tier>(...TIERS), fc.constantFrom<Tier>(...TIERS), (paths, first, second) => {
        const d = paths.reduce((acc, p) => applyPath(acc, p, SAMPLES[p]), DEFAULT);
        const copy = structuredClone(d);
        for (const tier of [first, second]) {
          const chips = new Set(hiddenNonDefaults(d, tier).map((h) => h.path));
          for (const p of paths) {
            const visible = tierRank(valueTier(p, readPath(d, p))) <= tierRank(tier);
            expect(visible || chips.has(chipPathOf(p)), `${p} at ${tier}`).toBe(true);
          }
        }
        expect(d).toEqual(copy);
      }),
      { numRuns: 200 },
    );
  });
});
