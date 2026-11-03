import { describe, expect, it } from "vitest";

/**
 * Ads targeting and placements (docs/IG-PAGE-ADS-SPEC.md 4.3, 4.5, 5.4, D9, D10; PRM-04 acceptance 4 and 5): pins, postal
 * codes, custom audiences and exclusions, the device rule for Facebook Stories, Threads, the explicit Advantage+ audience
 * flag, Messenger placements that only parse, positions that are never sent, and the special-category limits.
 */
import {
  AUDIENCE_NOT_READY,
  audienceIdsOf,
  audienceProblems,
  AUDIENCES_NOT_HERE,
  emptyTargeting,
  MAX_AUDIENCES,
  MESSENGER_CHANGED,
  NEVER_SENT_POSITIONS,
  parseTargeting,
  PIN_RADIUS_KM,
  placementErrors,
  PLACEMENT_FIELDS,
  restrictForCategory,
  SPECIAL_CATEGORY_RULES,
  targetedCountries,
  toMetaTargeting,
  validateTargeting,
} from "@/lib/ads/targeting";
import { PLACEMENTS, type Placement, type SpecialAdCategory, type Targeting } from "@/lib/ads/types";
import { PLACEMENTS as CATALOG_PLACEMENTS, placementRow } from "@/lib/promote/catalog/placements";
import { promoteText } from "@/lib/promote/copy";
import { PLACEMENT_KEYS } from "@/lib/promote/types";

const CATEGORIES = ["housing", "employment", "credit", "social_issues"] as const;
const base = (over: Partial<Targeting> = {}): Targeting => ({ ...emptyTargeting(), geo: { countries: ["IN"], cities: [] }, ageMin: 18, ageMax: 65, ...over });
const positionsOf = (spec: Record<string, unknown>) =>
  Object.entries(spec)
    .filter(([k]) => k.endsWith("_positions"))
    .flatMap(([k, v]) => (v as string[]).map((p) => `${k.replace(/_positions$/, "")}/${p}`));

describe("placement keys (4.5)", () => {
  it("ads/types holds every 4.5 key, the old eight first, the same set as promote's PLACEMENT_KEYS", () => {
    expect(PLACEMENTS.slice(0, 8)).toEqual(["facebook_feed", "facebook_stories", "facebook_reels", "instagram_feed", "instagram_stories", "instagram_reels", "messenger_inbox", "audience_network"]);
    expect([...PLACEMENTS].sort()).toEqual([...PLACEMENT_KEYS].sort());
    expect(new Set(PLACEMENTS).size).toBe(PLACEMENTS.length);
  });

  it("PLACEMENT_FIELDS agrees with the catalog for every key, and the hidden Messenger row maps to nothing", () => {
    for (const row of CATALOG_PLACEMENTS) {
      if (row.state === "hidden") expect(PLACEMENT_FIELDS[row.key]).toBeNull();
      else expect(PLACEMENT_FIELDS[row.key], row.key).toEqual([row.platform, row.position]);
    }
    expect(Object.keys(PLACEMENT_FIELDS).sort()).toEqual([...PLACEMENT_KEYS].sort());
  });

  it("emits each new position under its app", () => {
    const spec = toMetaTargeting(base({ placements: ["instagram_profile_feed", "instagram_explore_home", "instagram_search", "facebook_marketplace", "facebook_right_column", "facebook_instream_video", "threads_stream"] }), "none");
    expect(spec.instagram_positions).toEqual(["profile_feed", "explore_home", "ig_search"]);
    expect(spec.facebook_positions).toEqual(["marketplace", "right_hand_column", "instream_video"]);
    expect(spec.threads_positions).toEqual(["threads_stream"]);
    expect(spec.publisher_platforms).toEqual(["instagram", "facebook", "threads"]);
  });

  it("sends threads_positions for Threads", () => {
    const spec = toMetaTargeting(base({ placements: ["instagram_feed", "threads_stream"] }), "none");
    expect(spec).toMatchObject({ publisher_platforms: ["instagram", "threads"], instagram_positions: ["stream"], threads_positions: ["threads_stream"] });
  });

  it("keeps the old wizard's placement output unchanged", () => {
    const spec = toMetaTargeting(base({ placements: ["facebook_feed", "instagram_feed", "instagram_reels", "audience_network"] }), "none");
    expect(spec).toStrictEqual({
      geo_locations: { countries: ["IN"] },
      age_min: 18,
      age_max: 65,
      facebook_positions: ["feed"],
      instagram_positions: ["stream", "reels"],
      audience_network_positions: ["classic"],
      publisher_platforms: ["facebook", "instagram", "audience_network"],
      targeting_automation: { advantage_audience: 0 },
    });
  });

  it("empty placements are automatic: no platform or position fields", () => {
    const spec = toMetaTargeting(base(), "none");
    expect(spec).not.toHaveProperty("publisher_platforms");
    expect(positionsOf(spec)).toEqual([]);
    expect(spec).not.toHaveProperty("device_platforms");
  });
});

describe("Facebook Stories without Facebook Feed runs on phones (4.3)", () => {
  it("adds device_platforms ['mobile'] for stories without feed", () => {
    expect(toMetaTargeting(base({ placements: ["facebook_stories", "instagram_stories"] }), "none").device_platforms).toEqual(["mobile"]);
    expect(toMetaTargeting(base({ placements: ["facebook_stories"] }), "none").device_platforms).toEqual(["mobile"]);
  });

  it("leaves devices alone when Facebook Feed is chosen too, or Stories is not", () => {
    expect(toMetaTargeting(base({ placements: ["facebook_feed", "facebook_stories"] }), "none")).not.toHaveProperty("device_platforms");
    expect(toMetaTargeting(base({ placements: ["instagram_stories", "facebook_reels"] }), "none")).not.toHaveProperty("device_platforms");
  });
});

describe("Messenger placements and positions that are never sent (D10)", () => {
  it("messenger_inbox still parses but fails validation with the exact copy", () => {
    const t = parseTargeting({ ...base(), placements: ["facebook_feed", "messenger_inbox"] });
    expect(t.placements).toEqual(["facebook_feed", "messenger_inbox"]);
    const result = validateTargeting(t, "none");
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("Pick where your ad shows again: Meta changed Messenger placements");
    expect(result.errors).not.toContain("Unknown placement.");
    expect(MESSENGER_CHANGED).toBe(promoteText("placement.rule.messenger_changed"));
  });

  it("never sends messenger_home, even when asked", () => {
    const spec = toMetaTargeting(base({ placements: ["messenger_inbox", "facebook_feed"] }), "none");
    expect(spec.publisher_platforms).toEqual(["facebook"]);
    expect(spec).not.toHaveProperty("messenger_positions");
    expect(JSON.stringify(spec)).not.toContain("messenger");
  });

  it("explore, video_feeds and Messenger story are never emitted, for any key alone or all keys together", () => {
    const selections: Placement[][] = [...PLACEMENTS.map((p) => [p]), [...PLACEMENTS]];
    for (const placements of selections) {
      const spec = toMetaTargeting(base({ placements }), "none");
      const sent = positionsOf(spec);
      for (const banned of NEVER_SENT_POSITIONS) expect(sent, placements.join(",")).not.toContain(banned);
      expect(sent.some((p) => p.endsWith("/explore") || p.endsWith("/video_feeds"))).toBe(false);
      expect((spec.publisher_platforms as string[] | undefined) ?? []).not.toContain("messenger");
    }
    expect([...NEVER_SENT_POSITIONS].sort()).toEqual(["facebook/video_feeds", "instagram/explore", "messenger/messenger_home", "messenger/story"]);
  });

  it("an unknown stored key is refused by validation and skipped by the builder", () => {
    const t = parseTargeting({ ...base(), placements: ["facebook_feed", "facebook_video_feeds"] });
    expect(validateTargeting(t, "none").errors).toContain("Unknown placement.");
    expect(toMetaTargeting(t, "none").facebook_positions).toEqual(["feed"]);
  });

});

describe("placement cross rules (4.5) in validation, before anything reaches Meta", () => {
  const errors = (placements: Placement[], check: Parameters<typeof validateTargeting>[2] = {}) => validateTargeting(base({ placements }), "none", check).errors;
  /** A companion that satisfies each row's requirement, so a key can be checked on its own merits. */
  const COMPANION: Partial<Record<Placement, Placement[]>> = {
    instagram_profile_feed: ["instagram_feed"],
    instagram_profile_reels: ["instagram_reels"],
    instagram_explore_home: ["instagram_feed"],
    instagram_search: ["instagram_feed"],
    facebook_profile_feed: ["facebook_feed"],
    facebook_marketplace: ["facebook_feed"],
    facebook_search: ["facebook_feed"],
    facebook_stories: ["facebook_feed"],
    threads_stream: ["instagram_feed"],
    whatsapp_status: ["instagram_stories"],
    audience_network: ["facebook_feed"],
  };

  it("every documented key passes with its companion, on the old route (no goal, a picture)", () => {
    for (const row of CATALOG_PLACEMENTS.filter((r) => r.state === "ok")) {
      const placements = [row.key, ...(COMPANION[row.key] ?? [])];
      const check = row.videoOnly ? { format: "single_video" as const } : {};
      expect(errors(placements, check), row.key).toEqual([]);
    }
  });

  it("refuses a key alone when 4.5 needs a companion, with the catalog's copy", () => {
    expect(errors(["audience_network"])).toEqual(["Apps and sites outside Meta can't be the only place your ad shows."]);
    expect(errors(["facebook_stories"])).toEqual(["Facebook Stories needs Facebook Feed or Instagram Stories too."]);
    expect(errors(["facebook_stories", "instagram_stories"])).toEqual([]);
    for (const key of ["instagram_explore_home", "instagram_search", "instagram_profile_feed"] as const) expect(errors([key, "instagram_reels"]), key).toEqual([expect.stringMatching(/needs Instagram Feed too\.$/)]);
    for (const key of ["facebook_profile_feed", "facebook_marketplace", "facebook_search"] as const) expect(errors([key, "instagram_feed"]), key).toEqual([expect.stringMatching(/needs Facebook Feed too\.$/)]);
  });

  it("refuses in-stream video without a video", () => {
    expect(errors(["facebook_feed", "facebook_instream_video"])).toEqual([expect.stringMatching(/shows videos only\.$/)]);
    expect(errors(["facebook_feed", "facebook_instream_video"], { format: "single_video" })).toEqual([]);
    expect(errors(["facebook_feed", "facebook_instream_video"], { format: "existing_post", mediaKind: "video" })).toEqual([]);
  });

  it("refuses the keys still marked VERIFY (V-P14) on the old route, and checks their companions once allowed", () => {
    const unverified = CATALOG_PLACEMENTS.filter((r) => r.state === "verify").map((r) => r.key);
    expect([...unverified].sort()).toEqual(["instagram_profile_reels", "threads_stream", "whatsapp_status"]);
    for (const key of unverified) expect(errors([key, ...(COMPANION[key] ?? [])]).join(" "), key).toMatch(/isn't available yet\. Pick another place for your ad\./);
    const open = { allowUnverifiedPlacements: true };
    expect(errors(["threads_stream"], open)).toEqual(["Threads needs an Instagram account and Instagram Feed too."]);
    expect(errors(["instagram_feed", "threads_stream"], open)).toEqual([]);
    expect(errors(["instagram_profile_reels"], open)).toEqual([expect.stringMatching(/needs Instagram Reels too\.$/)]);
  });

  it("with a goal, refuses places the goal can't use (WhatsApp Status, a single-app goal on Automatic)", () => {
    const open = { allowUnverifiedPlacements: true };
    expect(errors(["instagram_stories", "whatsapp_status"], { ...open, goal: "website_visits" })).toEqual(["WhatsApp Status needs Instagram Stories and the WhatsApp chats goal."]);
    expect(errors(["instagram_stories", "whatsapp_status"], { ...open, goal: "whatsapp_chats" })).toEqual([]);
    expect(errors([], { goal: "profile_visits" })).toEqual(["Ads for this goal show only on Instagram."]);
    expect(errors(["facebook_feed"], { goal: "instagram_dms" })).toEqual(["Instagram DM ads show only on Instagram."]);
    // Without a goal these rules wait for the goal (the old route has only its four goals, which run on Facebook and Instagram).
    expect(errors([])).toEqual([]);
  });

  it("checks the Instagram account only when the caller says whether there is one", () => {
    expect(errors(["instagram_feed"])).toEqual([]);
    expect(errors(["instagram_feed"], { hasInstagramIdentity: false })).toEqual(["Instagram places need an Instagram account. Choose one, or run on Facebook only."]);
  });

  it("placementErrors leaves messenger_inbox and unknown keys to validateTargeting, so each is said once", () => {
    expect(placementErrors(["messenger_inbox", "facebook_video_feeds", "facebook_feed"])).toEqual([]);
    const all = validateTargeting(parseTargeting({ ...base(), placements: ["messenger_inbox", "facebook_feed"] }), "none").errors;
    expect(all.filter((e) => e === MESSENGER_CHANGED)).toHaveLength(1);
    expect(placementRow("messenger_inbox").state).toBe("hidden");
  });
});

describe("pins, postal codes and audiences (5.4)", () => {
  const rich = (): Targeting =>
    base({
      geo: {
        countries: ["IN"],
        cities: [{ key: "1035921", name: "Delhi", radiusKm: 25 }],
        customLocations: [{ lat: 28.6139, lng: 77.209, radiusKm: 5, label: "Shop" }],
        zips: [{ key: "IN:110001", name: "110001" }],
      },
      lookalikeAudienceIds: ["aud_like_1"],
      customAudienceIds: ["aud_local_1", "aud_local_3"],
      excludedAudienceIds: ["aud_local_2"],
    });
  // What the caller builds from the workspace's own ready, consented and allowed AdAudience rows.
  const ids = { aud_like_1: "2385000000001", aud_local_1: "2385000000101", aud_local_2: "2385000000102", aud_local_3: "2385000000009" };

  it("emits custom_locations and zips in geo_locations", () => {
    const spec = toMetaTargeting(rich(), "none", { audienceMetaIds: ids });
    expect(spec.geo_locations).toStrictEqual({
      countries: ["IN"],
      cities: [{ key: "1035921", radius: 25, distance_unit: "kilometer" }],
      custom_locations: [{ latitude: 28.6139, longitude: 77.209, radius: 5, distance_unit: "kilometer" }],
      zips: [{ key: "IN:110001" }],
    });
  });

  it("emits custom_audiences (lookalikes first, then custom audiences resolved to Meta ids) and excluded_custom_audiences", () => {
    const spec = toMetaTargeting(rich(), "none", { audienceMetaIds: ids });
    expect(spec.custom_audiences).toEqual([{ id: "2385000000001" }, { id: "2385000000101" }, { id: "2385000000009" }]);
    expect(spec.excluded_custom_audiences).toEqual([{ id: "2385000000102" }]);
  });

  it("never sends a local audience id: one that is not resolved is refused", () => {
    expect(() => toMetaTargeting(rich(), "none")).toThrow(RangeError);
    expect(() => toMetaTargeting(rich(), "none")).toThrow(AUDIENCES_NOT_HERE);
    expect(() => toMetaTargeting(rich(), "none", { audienceMetaIds: { aud_local_1: "2385000000101" } })).toThrow(AUDIENCE_NOT_READY);
    expect(() => toMetaTargeting(base({ customAudienceIds: ["constructor"] }), "none", { audienceMetaIds: {} })).toThrow(RangeError);
    // A map value that is not a Meta id is refused too.
    expect(() => toMetaTargeting(base({ customAudienceIds: ["a"] }), "none", { audienceMetaIds: { a: "aud_x" } })).toThrow(AUDIENCE_NOT_READY);
  });

  it("never passes a typed Meta id through, even all digits: another workspace's list can't be used (5.4)", () => {
    const map = { a: "1" };
    for (const t of [base({ customAudienceIds: ["123456"] }), base({ excludedAudienceIds: ["999"] }), base({ lookalikeAudienceIds: ["2385000000001"] })]) {
      expect(() => toMetaTargeting(t, "none", { audienceMetaIds: map })).toThrow(AUDIENCE_NOT_READY);
      expect(() => toMetaTargeting(t, "none")).toThrow(AUDIENCES_NOT_HERE);
      // Validation says the same before anything is created on Meta.
      expect(validateTargeting(t, "none", { audienceMetaIds: map }).errors).toContain(AUDIENCE_NOT_READY);
      expect(validateTargeting(t, "none").errors).toContain(AUDIENCES_NOT_HERE);
    }
  });

  it("audienceProblems agrees with the builder for every list, and is silent under a special category (nothing is sent)", () => {
    expect(audienceIdsOf(rich())).toEqual(["aud_like_1", "aud_local_1", "aud_local_3", "aud_local_2"]);
    expect(audienceProblems(rich(), "none", ids)).toEqual([]);
    expect(audienceProblems(base(), "none")).toEqual([]);
    expect(audienceProblems(rich(), "none")).toEqual([AUDIENCES_NOT_HERE]);
    expect(audienceProblems(rich(), "none", { ...ids, aud_local_2: undefined as unknown as string })).toEqual([AUDIENCE_NOT_READY]);
    for (const category of CATEGORIES) {
      expect(audienceProblems(rich(), category)).toEqual([]);
      expect(() => toMetaTargeting(rich(), category)).not.toThrow();
    }
    const maps: (Readonly<Record<string, string>> | undefined)[] = [undefined, {}, { aud_local_1: "1" }, ids];
    for (const map of maps) {
      const problems = audienceProblems(rich(), "none", map);
      let threw = false;
      try {
        toMetaTargeting(rich(), "none", { audienceMetaIds: map });
      } catch (e) {
        threw = true;
        expect(problems).toContain((e as Error).message);
      }
      expect(threw).toBe(problems.length > 0);
    }
  });

  it("names the countries a special-category ad runs in: targeted countries and the postal codes' countries", () => {
    expect(targetedCountries(base())).toEqual(["IN"]);
    expect(targetedCountries(base({ geo: { countries: [], cities: [], zips: [{ key: "AE:00000" }, { key: "IN:110001" }, { key: "1234" }] } }))).toEqual(["AE", "IN"]);
    expect(targetedCountries(base({ geo: { countries: [], cities: [{ key: "1035921", radiusKm: 25 }] } }))).toEqual([]);
  });

  it("parses the new fields from stored JSON, and leaves old rows exactly as they were", () => {
    const old = { geo: { countries: ["in"], cities: [] }, ageMin: 18, ageMax: 65, genders: [], interests: [], placements: ["facebook_feed"], lookalikeAudienceIds: [] };
    expect(parseTargeting(old)).toStrictEqual({ ...old, geo: { countries: ["IN"], cities: [] } });
    const parsed = parseTargeting({
      ...old,
      geo: { countries: ["IN"], cities: [], customLocations: [{ lat: "28.6", lng: 77.2, radiusKm: 3, label: "Shop" }, "junk"], zips: [{ key: " IN:110001 ", name: "CP" }] },
      customAudienceIds: ["a", "a", " b "],
      excludedAudienceIds: ["c"],
      advantageAudience: true,
    });
    expect(parsed.geo.customLocations).toEqual([{ lat: 28.6, lng: 77.2, radiusKm: 3, label: "Shop" }]);
    expect(parsed.geo.zips).toEqual([{ key: "IN:110001", name: "CP" }]);
    expect(parsed.customAudienceIds).toEqual(["a", "b"]);
    expect(parsed.excludedAudienceIds).toEqual(["c"]);
    expect(parsed.advantageAudience).toBe(true);
    expect(parseTargeting({ ...old, advantageAudience: "yes" })).not.toHaveProperty("advantageAudience");
  });

  it("validates pins, postal codes and audience lists with plain copy", () => {
    expect(validateTargeting(rich(), "none", { audienceMetaIds: ids })).toEqual({ ok: true, errors: [] });
    const onlyPin = base({ geo: { countries: [], cities: [], customLocations: [{ lat: 19.07, lng: 72.87, radiusKm: 2 }] } });
    expect(validateTargeting(onlyPin, "none").ok).toBe(true);
    const errors = (t: Targeting) => validateTargeting(t, "none").errors.join(" ");
    expect(errors(base({ geo: { countries: ["IN"], cities: [], customLocations: [{ lat: 91, lng: 0, radiusKm: 5 }] } }))).toMatch(/no valid position/);
    expect(errors(base({ geo: { countries: ["IN"], cities: [], customLocations: [{ lat: 1, lng: 1, radiusKm: PIN_RADIUS_KM.max + 1 }] } }))).toMatch(/between 1 and 80 km/);
    expect(errors(base({ geo: { countries: ["IN"], cities: [], customLocations: [{ lat: 1, lng: 1, radiusKm: 0.5 }] } }))).toMatch(/between 1 and 80 km/);
    expect(errors(base({ geo: { countries: ["IN"], cities: [], zips: [{ key: "" }] } }))).toMatch(/postal code needs a Meta location key/);
    expect(errors(base({ customAudienceIds: ["a"], excludedAudienceIds: ["a"] }))).toMatch(/both included and left out/);
    const many = Array.from({ length: MAX_AUDIENCES + 1 }, (_, i) => `a${i}`);
    expect(errors(parseTargeting({ ...base(), customAudienceIds: many }))).toMatch(new RegExp(`at most ${MAX_AUDIENCES} audiences`));
    expect(errors(base({ geo: { countries: [], cities: [] } }))).toMatch(/Choose at least one country or city/);
  });
});

describe("the Advantage+ audience flag is always explicit (D9)", () => {
  it("sends 1 for 'Let Meta find people' and leaves out age_max", () => {
    const spec = toMetaTargeting(base({ advantageAudience: true, ageMin: 21 }), "none");
    expect(spec.targeting_automation).toEqual({ advantage_audience: 1 });
    expect(spec.age_min).toBe(21);
    expect(spec).not.toHaveProperty("age_max");
  });

  it("sends 0, with age_max, when the old wizard leaves it unset or it is off", () => {
    for (const t of [base(), base({ advantageAudience: false })]) {
      const spec = toMetaTargeting(t, "none");
      expect(spec.targeting_automation).toEqual({ advantage_audience: 0 });
      expect(spec.age_max).toBe(65);
    }
  });

  it.each(CATEGORIES)("sends 0 with the %s category, even when 'Let Meta find people' is on", (category) => {
    const spec = toMetaTargeting(base({ advantageAudience: true }), category);
    expect(spec.targeting_automation).toEqual({ advantage_audience: 0 });
    expect(spec.age_max).toBe(65);
  });
});

describe("special categories (4.3, D17)", () => {
  const loose = (): Targeting =>
    base({
      ageMin: 25,
      ageMax: 40,
      genders: ["female"],
      interests: [{ id: "6003", name: "Yoga" }],
      geo: { countries: ["IN"], cities: [{ key: "k", radiusKm: 17 }], customLocations: [{ lat: 28.6, lng: 77.2, radiusKm: 3, label: "Shop" }], zips: [{ key: "IN:110001" }] },
      lookalikeAudienceIds: ["2385000000001"],
      customAudienceIds: ["2385000000002"],
      excludedAudienceIds: ["2385000000003"],
      advantageAudience: true,
    });

  it.each(CATEGORIES)("restrictForCategory strips lookalikes, custom audiences, postal codes and expansion, and forces the radius (%s)", (category: Exclude<SpecialAdCategory, "none">) => {
    const original = loose();
    const { targeting, adjustments } = restrictForCategory(original, category);
    const min = SPECIAL_CATEGORY_RULES[category].minRadiusKm;
    expect(targeting.lookalikeAudienceIds).toEqual([]);
    expect(targeting).not.toHaveProperty("customAudienceIds");
    expect(targeting).not.toHaveProperty("excludedAudienceIds");
    expect(targeting).not.toHaveProperty("advantageAudience");
    expect(targeting.geo).not.toHaveProperty("zips");
    expect(targeting.geo.cities[0].radiusKm).toBe(min);
    expect(targeting.geo.customLocations![0]).toEqual({ lat: 28.6, lng: 77.2, radiusKm: min, label: "Shop" });
    expect(adjustments).toEqual(
      expect.arrayContaining(["Lookalike audiences removed.", "Custom audiences removed.", "'Let Meta find people' turned off.", `Radius raised to ${min} km.`, "Postal codes removed. Use a city or a place on the map instead."]),
    );
    expect(new Set(adjustments).size).toBe(adjustments.length);
    expect(validateTargeting(targeting, category)).toEqual({ ok: true, errors: [] });
    // The input is not changed.
    expect(original.customAudienceIds).toEqual(["2385000000002"]);
    expect(original.geo.customLocations![0].radiusKm).toBe(3);
    expect(original.geo.zips).toHaveLength(1);
  });

  it.each(CATEGORIES)("validation names each limit the %s category breaks", (category) => {
    const text = validateTargeting(loose(), category).errors.join(" ");
    for (const word of [/lookalike/, /custom audiences/, /postal code/, /radius of at least 25 km/, /gender/, /interest/, /age/]) expect(text).toMatch(word);
  });

  it.each(CATEGORIES)("the %s ad set sends no interests, lookalikes, custom audiences, exclusions or postal codes", (category) => {
    const spec = toMetaTargeting(loose(), category);
    for (const key of ["flexible_spec", "custom_audiences", "excluded_custom_audiences"]) expect(spec).not.toHaveProperty(key);
    expect(spec.geo_locations).not.toHaveProperty("zips");
    expect(spec.targeting_automation).toEqual({ advantage_audience: 0 });
  });

  it("a pin under a special category keeps a radius of at least 25 km after restriction", () => {
    const { targeting } = restrictForCategory(base({ geo: { countries: [], cities: [], customLocations: [{ lat: 1, lng: 1, radiusKm: 40 }] } }), "credit");
    expect(targeting.geo.customLocations![0].radiusKm).toBe(40);
    expect(toMetaTargeting(targeting, "credit").geo_locations).toMatchObject({ custom_locations: [{ radius: 40 }] });
  });

  it("no category leaves targeting untouched", () => {
    const t = loose();
    expect(restrictForCategory(t, "none")).toEqual({ targeting: t, adjustments: [] });
  });
});
