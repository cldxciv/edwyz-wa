import { describe, expect, it, vi } from "vitest";

// The parser is pure; nothing here may reach a database.
vi.mock("@/lib/db", () => ({ prisma: {} }));

/**
 * The draft body (docs/IG-PAGE-ADS-SPEC.md 3.1a, 3.8, 4.3, 5.1, 5.4, 6.1 rule 3, D31; PRM-05 acceptance 1 and 9): the old
 * wizard's body parses exactly as before, and the new fields are checked before anything is saved.
 */
import {
  CAROUSEL_CARDS_INVALID,
  DRAFT_SURFACES,
  END_REQUIRED,
  ICE_BREAKERS_INVALID,
  MAX_REPLACED_ADS,
  parseDraftInput,
  parseReplacesAdIds,
  readReplacesAdIds,
  RUN_TOO_SHORT,
  runProblem,
  SPLIT_NEEDS_DAILY,
  VERSIONS_INVALID,
  type DraftParseOptions,
} from "@/lib/ads/draft-input";
import { parseDraftInput as fromService } from "@/lib/ads/service";
import { HttpError } from "@/lib/tenancy";

type Row = Record<string, unknown>;
const NOW = new Date("2026-10-28T06:30:00Z");
const at = (iso: string) => new Date(iso);
const hours = (h: number) => new Date(NOW.getTime() + h * 3_600_000).toISOString();
const promote: DraftParseOptions = { surface: "promote", now: NOW, timeZone: "Asia/Kolkata" };
const wizard: DraftParseOptions = { now: NOW };

const oldBody = (over: Row = {}): Row => ({
  name: "  Spring sale  ",
  template: "traffic",
  adAccountAssetId: "acc1",
  dailyBudgetMinor: 50000,
  specialAdCategory: "none",
  startsAt: "2026-11-01T04:30:00Z",
  endsAt: "2026-11-08T18:29:00Z",
  targeting: { geo: { countries: ["in"], cities: [] }, ageMin: 25, ageMax: 45, placements: ["facebook_feed"] },
  ads: [
    { name: "A", creative: { pageId: "page1", message: "Hello", headline: "Big sale", link: "https://example.com", imageUrl: "https://example.com/a.png", cta: "SHOP_NOW" } },
    { creativeAssetId: "asset2", creative: { pageId: "page1", message: "Hi", link: "https://example.com", mediaKey: "0123456789abcdef0123456789abcdef.png" } },
  ],
  ...over,
});

const creative = (over: Row = {}): Row => ({ pageId: "page1", message: "Diwali offer", link: "https://example.com/diwali", format: "single_image", media: { feed: "med_1" }, ...over });
const promoteBody = (over: Row = {}): Row => ({
  name: "Diwali",
  goal: "website_visits",
  adAccountAssetId: "acc1",
  dailyBudgetMinor: 30000,
  specialAdCategory: "none",
  endsAt: "2026-11-03T18:29:00Z",
  targeting: { geo: { countries: ["IN"], cities: [] } },
  ads: [{ name: "Offer", creative: creative() }],
  ...over,
});

function refusal(fn: () => unknown): { status: number; message: string } {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(HttpError);
    return { status: (e as HttpError).status, message: (e as Error).message };
  }
  throw new Error("expected a refusal");
}

describe("the old wizard's body parses exactly as before", () => {
  it("gives the same draft, field by field, with the new fields at their defaults", () => {
    const parsed = parseDraftInput(oldBody(), wizard);
    expect(parsed).toEqual({
      name: "Spring sale",
      template: "traffic",
      adAccountAssetId: "acc1",
      dailyBudgetMinor: 50000,
      lifetimeBudgetMinor: null,
      startsAt: at("2026-11-01T04:30:00Z"),
      endsAt: at("2026-11-08T18:29:00Z"),
      origin: "human",
      assistantKey: null,
      surface: "wizard",
      specialAdCategory: "none",
      confirmNoSpecialCategory: false,
      acknowledgeSpecialCategoryTerms: false,
      targeting: { geo: { countries: ["IN"], cities: [] }, ageMin: 25, ageMax: 45, genders: [], interests: [], placements: ["facebook_feed"], lookalikeAudienceIds: [] },
      ads: [
        { name: "A", creativeAssetId: null, variantKey: null, creative: { pageId: "page1", message: "Hello", headline: "Big sale", link: "https://example.com", imageUrl: "https://example.com/a.png", cta: "SHOP_NOW" } },
        { name: "Spring sale ad 2", creativeAssetId: "asset2", variantKey: null, creative: { pageId: "page1", message: "Hi", link: "https://example.com", mediaKey: "0123456789abcdef0123456789abcdef.png" } },
      ],
      goal: null,
      sourceKind: null,
      sourceRef: null,
      sourcePostTargetId: null,
      placementMode: "auto",
      runDays: null,
      startMode: null,
      compareMode: "none",
    });
    // No 5.4 field appears on an old creative, so the builders keep the old wizard's exact payloads.
    for (const ad of parsed.ads) {
      const defined = Object.entries(ad.creative).filter(([, v]) => v !== undefined).map(([k]) => k);
      expect(defined.some((k) => ["format", "media", "cards", "iceBreakers", "igMediaId", "fbPromotableId", "enhancementsOptIn", "ctaType", "urlTags", "description"].includes(k))).toBe(false);
    }
  });

  it("is still importable from ads/service, and keeps every old refusal and its words", () => {
    expect(fromService).toBe(parseDraftInput);
    expect(refusal(() => parseDraftInput(oldBody({ name: " " }), wizard)).message).toBe("name is required.");
    expect(refusal(() => parseDraftInput(oldBody({ template: "awareness" }), wizard)).message).toBe("template must be lead_generation, click_to_whatsapp, traffic or boost_post.");
    expect(refusal(() => parseDraftInput(oldBody({ specialAdCategory: "x" }), wizard)).message).toMatch(/Declare a special ad category/);
    expect(refusal(() => parseDraftInput(oldBody({ adAccountAssetId: "" }), wizard)).message).toBe("adAccountAssetId is required.");
    expect(refusal(() => parseDraftInput(oldBody({ dailyBudgetMinor: 1.5 }), wizard)).message).toMatch(/dailyBudgetMinor must be a positive whole number/);
    expect(refusal(() => parseDraftInput(oldBody({ endsAt: "2026-10-31T00:00:00Z" }), wizard)).message).toBe("endsAt must be after startsAt.");
    expect(refusal(() => parseDraftInput(oldBody({ startsAt: "soon" }), wizard)).message).toBe("startsAt must be an ISO date.");
    expect(refusal(() => parseDraftInput(oldBody({ ads: [] }), wizard)).message).toBe("Provide 1 to 10 ads.");
    expect(refusal(() => parseDraftInput(oldBody({ ads: [{ name: "x" }] }), wizard)).message).toBe("ads[0].creative is required.");
    expect(refusal(() => parseDraftInput(oldBody({ ads: [{ creative: { pageId: "p", mediaKey: "0123456789abcdef0123456789abcdef.webp" } }] }), wizard)).message).toMatch(/JPG or PNG/);
    // No end date is still fine for a person's old-wizard draft.
    expect(parseDraftInput(oldBody({ startsAt: undefined, endsAt: undefined }), wizard)).toMatchObject({ startsAt: null, endsAt: null });
  });
});

describe("a route body cannot choose its surface or origin", () => {
  it("ignores surface and origin in the body; only the trusted caller's options set them", () => {
    const body = oldBody({ surface: "eddy", origin: "assistant", assistantKey: "ads_launcher" });
    expect(parseDraftInput(body, wizard)).toMatchObject({ surface: "wizard", origin: "human", assistantKey: null });
    expect(parseDraftInput(oldBody(), { ...wizard, surface: "promote" }).surface).toBe("promote");
    expect(parseDraftInput(oldBody(), { ...wizard, origin: "api" })).toMatchObject({ surface: "api", origin: "api" });
    expect(parseDraftInput(oldBody(), { ...wizard, surface: "nonsense" as never }).surface).toBe("wizard");
    expect([...DRAFT_SURFACES]).toEqual(["wizard", "promote", "eddy", "api"]);
  });

  it("so a body that says it is a promotion can't use a goal the old routes don't build, nor skip the end date", () => {
    const sneaky = promoteBody({ goal: "awareness", surface: "promote", endsAt: undefined });
    expect(refusal(() => parseDraftInput(sneaky, wizard)).message).toMatch(/template must be/);
    expect(parseDraftInput(promoteBody({ goal: "awareness" }), promote)).toMatchObject({ template: "awareness", goal: "awareness", surface: "promote" });
  });
});

describe("goals and sources", () => {
  it("the new flows get the template from the goal and the source; a stated template must match the goal", () => {
    expect(parseDraftInput(promoteBody(), promote)).toMatchObject({ template: "traffic", goal: "website_visits", sourceKind: null });
    expect(parseDraftInput(promoteBody({ goal: "engagement", sourceKind: "fb_post", sourceRef: "123_456", ads: [{ creative: { pageId: "page1", format: "existing_post", fbPromotableId: "123_456" } }] }), promote)).toMatchObject({
      template: "boost_post",
      goal: "engagement",
      sourceKind: "fb_post",
      sourceRef: "123_456",
    });
    expect(parseDraftInput(oldBody({ goal: "website_visits" }), wizard)).toMatchObject({ template: "traffic", goal: "website_visits" });
    expect(refusal(() => parseDraftInput(oldBody({ goal: "lead_form" }), wizard)).message).toMatch(/doesn't match/);
    expect(refusal(() => parseDraftInput(promoteBody({ goal: "sell_everything" }), promote)).message).toMatch(/goal from the list/);
    expect(refusal(() => parseDraftInput(promoteBody({ sourceKind: "tiktok" }), promote)).message).toMatch(/sourceKind/);
    expect(refusal(() => parseDraftInput(promoteBody({ goal: undefined }), promote)).message).toMatch(/goal from the list/);
  });

  it("stores the placement mode, and refuses an unknown one", () => {
    expect(parseDraftInput(promoteBody({ placementMode: "instagram" }), promote).placementMode).toBe("instagram");
    expect(refusal(() => parseDraftInput(promoteBody({ placementMode: "tv" }), promote)).message).toMatch(/placementMode/);
  });
});

describe("an end date for the new flows and Eddy (6.1 rule 3)", () => {
  it("a promote or Eddy draft without an end gets 400 with plain copy", () => {
    for (const surface of ["promote", "eddy"] as const) {
      expect(refusal(() => parseDraftInput(promoteBody({ endsAt: undefined }), { ...promote, surface }))).toEqual({ status: 400, message: END_REQUIRED });
    }
    expect(END_REQUIRED).toBe("Choose when your ads stop. Ads made here always have an end date.");
    // A run length gives the end.
    expect(parseDraftInput(promoteBody({ endsAt: undefined, runDays: 7 }), promote).endsAt).toBeInstanceOf(Date);
  });

  it("a run length ends on the start day plus runDays minus 1, at 23:59 in the account zone, whatever end the body sent", () => {
    // Wed 28 Oct 2026, 12:00 in Kolkata: 7 days end on Tue 3 Nov at 23:59 IST.
    const now7 = parseDraftInput(promoteBody({ endsAt: "2027-01-01T00:00:00Z", runDays: 7, startMode: "now" }), promote);
    expect(now7).toMatchObject({ runDays: 7, startMode: "now", startsAt: null, endsAt: at("2026-11-03T18:29:00Z") });
    // In New York the same run ends at 23:59 local, after the change to standard time on 1 Nov.
    expect(parseDraftInput(promoteBody({ runDays: 7 }), { ...promote, timeZone: "America/New_York" }).endsAt).toEqual(at("2026-11-04T04:59:00Z"));
    // A start on a date: the run counts from that day.
    const later = parseDraftInput(promoteBody({ runDays: 2, startMode: "at", startsAt: "2026-10-30T04:30:00Z" }), promote);
    expect(later).toMatchObject({ startMode: "at", startsAt: at("2026-10-30T04:30:00Z"), endsAt: at("2026-10-31T18:29:00Z") });
    // A start without startMode but with a start time means "at"; with neither, "now".
    expect(parseDraftInput(promoteBody({ runDays: 3, startsAt: "2026-10-30T04:30:00Z" }), promote).startMode).toBe("at");
    expect(parseDraftInput(promoteBody({ runDays: 3 }), promote).startMode).toBe("now");
  });

  it("a start that has passed, or a start mode 'at' without a time, is refused", () => {
    expect(refusal(() => parseDraftInput(promoteBody({ runDays: 3, startMode: "at", startsAt: "2026-10-27T00:00:00Z" }), promote)).message).toBe("This start time has passed. Start now or pick a new time.");
    expect(refusal(() => parseDraftInput(promoteBody({ runDays: 3, startMode: "at" }), promote)).message).toMatch(/Choose when your ads start/);
    expect(refusal(() => parseDraftInput(promoteBody({ startMode: "soon" }), promote)).message).toMatch(/startMode must be now or at/);
  });
});

describe("runs of 24 hours or less (D31)", () => {
  it("runDays 1 is refused with the D31 copy, and so is anything over 90 or not a whole number", () => {
    expect(RUN_TOO_SHORT).toBe("Meta needs ads with a daily budget to run for more than a day, so the shortest run is 2 days.");
    expect(refusal(() => parseDraftInput(promoteBody({ runDays: 1 }), promote))).toEqual({ status: 400, message: RUN_TOO_SHORT });
    expect(refusal(() => parseDraftInput(oldBody({ runDays: 1 }), wizard)).message).toBe(RUN_TOO_SHORT);
    expect(refusal(() => parseDraftInput(promoteBody({ runDays: 91 }), promote)).message).toMatch(/at most 90 days/);
    expect(refusal(() => parseDraftInput(promoteBody({ runDays: 2.5 }), promote)).message).toMatch(/whole number of days from 2 to 90/);
    expect(parseDraftInput(promoteBody({ runDays: 2 }), promote).runDays).toBe(2);
  });

  it("an end 24 hours or less after the start (or after now) is refused with the D31 copy, on every surface", () => {
    for (const opts of [promote, wizard]) {
      const body = opts === promote ? promoteBody : oldBody;
      expect(refusal(() => parseDraftInput(body({ startsAt: hours(2), endsAt: hours(26) }), opts)).message).toBe(RUN_TOO_SHORT);
      expect(refusal(() => parseDraftInput(body({ startsAt: undefined, endsAt: hours(20) }), opts)).message).toBe(RUN_TOO_SHORT);
      // An old-wizard start in the past counts from now; the new flows refuse a start that has passed.
      expect(refusal(() => parseDraftInput(body({ startsAt: hours(-48), endsAt: hours(12) }), opts)).message).toBe(opts === promote ? "This start time has passed. Start now or pick a new time." : RUN_TOO_SHORT);
      expect(parseDraftInput(body({ startsAt: hours(2), endsAt: hours(26.5) }), opts).endsAt).toEqual(new Date(hours(26.5)));
    }
    // A lifetime budget is not a daily budget: an old-wizard lifetime run may be shorter.
    expect(parseDraftInput(oldBody({ dailyBudgetMinor: undefined, lifetimeBudgetMinor: 100000, startsAt: undefined, endsAt: hours(20) }), wizard).lifetimeBudgetMinor).toBe(100000);
  });

  it("runProblem counts in the account zone for the new flows and plain hours for the rest", () => {
    const base = { daily: true, startMode: null, startsAt: null, runDays: null, now: NOW, tz: "Asia/Kolkata" } as const;
    expect(runProblem({ ...base, newFlow: false, endsAt: new Date(hours(24)) })).toBe(RUN_TOO_SHORT);
    expect(runProblem({ ...base, newFlow: false, endsAt: new Date(hours(25)) })).toBeNull();
    expect(runProblem({ ...base, newFlow: true, endsAt: new Date(hours(24)) })).toBe(RUN_TOO_SHORT);
    expect(runProblem({ ...base, newFlow: true, endsAt: new Date(NOW.getTime() + 100 * 86_400_000) })).toMatch(/at most 90 days/);
    expect(runProblem({ ...base, newFlow: true, endsAt: null })).toBeNull();
  });
});

describe("quick questions (5.4: at most 3, titles up to 80 characters, answers up to 300)", () => {
  const withIce = (iceBreakers: unknown) => promoteBody({ goal: "whatsapp_chats", ads: [{ creative: creative({ whatsappNumberId: "ph1", welcomeMessage: "Hi!", link: undefined, iceBreakers }) }] });

  it("keeps up to 3, trimmed, at the exact limits", () => {
    const ice = [
      { title: ` ${"t".repeat(80)} `, response: "r".repeat(300) },
      { title: "Price?", response: "From ₹499." },
      { title: "Where?", response: "Delhi." },
    ];
    expect(parseDraftInput(withIce(ice), promote).ads[0].creative.iceBreakers).toEqual([{ title: "t".repeat(80), response: "r".repeat(300) }, ice[1], ice[2]]);
    expect(parseDraftInput(withIce([]), promote).ads[0].creative.iceBreakers).toBeUndefined();
  });

  it("refuses more than 3, a title over 80 or an answer over 300 characters, or an empty one, never cutting them short", () => {
    const q = { title: "Price?", response: "From ₹499." };
    for (const bad of [[q, q, q, q], [{ title: "t".repeat(81), response: "ok" }], [{ title: "ok", response: "r".repeat(301) }], [{ title: " ", response: "ok" }], [{ title: "ok" }], "Price?"]) {
      expect(refusal(() => parseDraftInput(withIce(bad), promote))).toEqual({ status: 400, message: ICE_BREAKERS_INVALID });
    }
  });
});

describe("carousel cards (2 to 10) and library media", () => {
  const cards = (n: number) => Array.from({ length: n }, (_, i) => ({ mediaId: `med_${i}`, headline: `Card ${i}`, description: "Fresh", link: "https://example.com/p" }));
  const carousel = (c: unknown) => promoteBody({ ads: [{ creative: creative({ format: "carousel", media: undefined, cards: c }) }] });

  it("takes 2 to 10 cards and refuses 11 (or 1) with plain copy", () => {
    expect(parseDraftInput(carousel(cards(10)), promote).ads[0].creative.cards).toHaveLength(10);
    expect(parseDraftInput(carousel(cards(2)), promote).ads[0].creative.cards?.[0]).toEqual({ mediaId: "med_0", headline: "Card 0", description: "Fresh", link: "https://example.com/p" });
    expect(refusal(() => parseDraftInput(carousel(cards(11)), promote))).toEqual({ status: 400, message: CAROUSEL_CARDS_INVALID });
    expect(refusal(() => parseDraftInput(carousel(cards(1)), promote)).message).toBe(CAROUSEL_CARDS_INVALID);
    expect(refusal(() => parseDraftInput(carousel([{ headline: "no picture" }, ...cards(2)]), promote)).message).toMatch(/needs a picture or video/);
  });

  it("keeps the media slots as AdMedia ids and refuses anything else", () => {
    const parsed = parseDraftInput(promoteBody({ ads: [{ creative: creative({ media: { feed: "med_1", vertical: "med_2", video: "", other: "x" } }) }] }), promote);
    expect(parsed.ads[0].creative.media).toEqual({ feed: "med_1", vertical: "med_2" });
    expect(refusal(() => parseDraftInput(promoteBody({ ads: [{ creative: creative({ media: { feed: "../etc/passwd" } }) }] }), promote)).message).toMatch(/ad library/);
    expect(refusal(() => parseDraftInput(promoteBody({ ads: [{ creative: creative({ format: "hologram" }) }] }), promote)).message).toMatch(/format must be/);
  });

  it("keeps the other 5.4 creative fields only when they are given", () => {
    const c = parseDraftInput(promoteBody({ ads: [{ creative: creative({ description: "Free delivery", enhancementsOptIn: true, ctaType: "SHOP_NOW", urlTags: "utm_source=x", igMediaId: "1789" }) }] }), promote).ads[0].creative;
    expect(c).toMatchObject({ description: "Free delivery", enhancementsOptIn: true, ctaType: "SHOP_NOW", urlTags: "utm_source=x", igMediaId: "1789" });
    expect(parseDraftInput(promoteBody({ ads: [{ creative: creative({ enhancementsOptIn: "yes" }) }] }), promote).ads[0].creative.enhancementsOptIn).toBeUndefined();
  });
});

describe("versions to compare (3.8)", () => {
  const version = (key: unknown, over: Row = {}) => ({ key, creative: creative({ message: `Offer ${String(key)}`, ...over }) });

  it("takes 1 to 3 versions named A, B and C, sorted, each one ad; more than one is a fair test unless Meta picks", () => {
    const fair = parseDraftInput(promoteBody({ ads: undefined, versions: [version("B"), version("A"), version("C")] }), promote);
    expect(fair.compareMode).toBe("fair_split");
    expect(fair.ads.map((a) => [a.variantKey, a.name, a.creative.message])).toEqual([
      ["A", "Diwali · Version A", "Offer A"],
      ["B", "Diwali · Version B", "Offer B"],
      ["C", "Diwali · Version C", "Offer C"],
    ]);
    expect(parseDraftInput(promoteBody({ ads: undefined, compareMode: "meta_picks", versions: [version("A"), version("B")] }), promote).compareMode).toBe("meta_picks");
    expect(parseDraftInput(promoteBody({ ads: undefined, compareMode: "meta_picks", versions: [version("A")] }), promote).compareMode).toBe("none");
  });

  it("refuses more than 3 versions, other names, gaps or repeats, both versions and ads, and an unknown compare mode", () => {
    for (const versions of [[], [version("A"), version("B"), version("C"), version("D")], [version("A"), version("C")], [version("A"), version("A")], [version("X")], [{ key: "A" }]]) {
      const r = refusal(() => parseDraftInput(promoteBody({ ads: undefined, versions }), promote));
      expect(r.status).toBe(400);
      expect([VERSIONS_INVALID, "versions[0].creative is required."]).toContain(r.message);
    }
    expect(refusal(() => parseDraftInput(promoteBody({ versions: [version("A")] }), promote)).message).toMatch(/versions or the ads, not both/);
    expect(refusal(() => parseDraftInput(promoteBody({ ads: undefined, compareMode: "random", versions: [version("A"), version("B")] }), promote)).message).toMatch(/compareMode/);
  });

  it("a fair test needs a daily budget", () => {
    const body = promoteBody({ ads: undefined, dailyBudgetMinor: undefined, lifetimeBudgetMinor: 500000, versions: [version("A"), version("B")] });
    expect(refusal(() => parseDraftInput(body, promote)).message).toBe(SPLIT_NEEDS_DAILY);
    expect(parseDraftInput({ ...body, compareMode: "meta_picks" }, promote).lifetimeBudgetMinor).toBe(500000);
  });

  it("refuses the same library creative in two versions", () => {
    expect(refusal(() => parseDraftInput(promoteBody({ ads: undefined, versions: [{ ...version("A"), creativeAssetId: "c1" }, { ...version("B"), creativeAssetId: "c1" }] }), promote)).message).toMatch(/different creative/);
  });
});

describe("audiences and 'Let Meta find people' (5.4)", () => {
  it("folds the top-level audience lists and the switch into the ad set's targeting", () => {
    const t = parseDraftInput(promoteBody({ customAudienceIds: ["aud_1", "aud_1", "aud_2"], excludedAudienceIds: ["aud_3"], advantageAudience: true }), promote).targeting;
    expect(t).toMatchObject({ customAudienceIds: ["aud_1", "aud_2"], excludedAudienceIds: ["aud_3"], advantageAudience: true });
    const cleared = parseDraftInput(promoteBody({ targeting: { geo: { countries: ["IN"], cities: [] }, customAudienceIds: ["aud_9"], advantageAudience: true }, customAudienceIds: [], advantageAudience: false }), promote).targeting;
    expect(cleared.customAudienceIds).toBeUndefined();
    expect(cleared.advantageAudience).toBeUndefined();
  });

  it("refuses ids that are not audience ids and more than 20", () => {
    expect(refusal(() => parseDraftInput(promoteBody({ customAudienceIds: "aud_1" }), promote)).message).toMatch(/customAudienceIds/);
    expect(refusal(() => parseDraftInput(promoteBody({ excludedAudienceIds: ["a b"] }), promote)).message).toMatch(/excludedAudienceIds/);
    expect(refusal(() => parseDraftInput(promoteBody({ customAudienceIds: Array.from({ length: 21 }, (_, i) => `aud_${i}`) }), promote)).message).toMatch(/at most 20/);
  });
});

describe("Ad.creative.replacesAdIds (5.4)", () => {
  it("validates 1 to 10 ad ids and reads a stored value without trusting it", () => {
    expect(parseReplacesAdIds(["ad_1", "ad_1", "ad_2"])).toEqual(["ad_1", "ad_2"]);
    for (const bad of [[], "ad_1", [1], ["a b"], Array.from({ length: MAX_REPLACED_ADS + 1 }, (_, i) => `ad_${i}`)]) expect(() => parseReplacesAdIds(bad)).toThrow(HttpError);
    expect(readReplacesAdIds({ replacesAdIds: ["ad_1"] })).toEqual(["ad_1"]);
    expect(readReplacesAdIds({ replacesAdIds: "ad_1" })).toEqual([]);
    expect(readReplacesAdIds(null)).toEqual([]);
    expect(readReplacesAdIds({})).toEqual([]);
  });
});
