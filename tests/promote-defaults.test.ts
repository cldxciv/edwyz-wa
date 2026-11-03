import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * docs/IG-PAGE-ADS-SPEC.md 3.1 (smart defaults), 3.1a, D3, D6, D8, D9, D11, D31 and PRM-09 acceptance 1 (promote-defaults): every
 * row of the 3.1 table, the no-spending-account chips for an owner and an admin, a ₹300 default lowered to maxFittingDaily under
 * tight limits, the USD default from Phase 0's FX rate, and Days 7 (2 with the chip for a 1-day request). The fact loader reads
 * a fake database: no network, no Meta.
 */
const h = vi.hoisted(() => ({
  db: {
    spendControl: { findUnique: vi.fn() },
    metaAsset: { findMany: vi.fn() },
    membership: { findFirst: vi.fn() },
    phoneNumber: { findFirst: vi.fn() },
    leadForm: { count: vi.fn() },
    brand: { findFirst: vi.fn() },
    platformSetting: { findUnique: vi.fn() },
    adCampaign: { findFirst: vi.fn() },
  },
  headroom: vi.fn(),
  readFx: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ prisma: h.db }));
vi.mock("@/lib/spend/book", () => ({ adsHeadroomDetail: (...a: unknown[]) => h.headroom(...a) }));
vi.mock("@/lib/spend/fx", async (orig) => ({ ...(await orig<typeof import("@/lib/spend/fx")>()), readFx: (...a: unknown[]) => h.readFx(...a) }));

import { promoteText } from "@/lib/promote/copy";
import { maxFittingDaily } from "@/lib/promote/cost";
import { runDates } from "@/lib/promote/dates";
import {
  countryOfPhone,
  defaultBudget,
  defaultGoal,
  defaultName,
  defaultRunDays,
  loadDefaultFacts,
  smartDefaults,
  SPENDING_LIMITS_PATH,
  type DefaultFacts,
} from "@/lib/promote/defaults";

// Wednesday 28 Oct 2026, 11:30 in India.
const NOW = new Date("2026-10-28T06:00:00Z");
const TZ = "Asia/Kolkata";

function facts(over: Partial<DefaultFacts> = {}): DefaultFacts {
  return {
    role: "owner",
    ownerName: "Asha",
    spendingAccount: { assetId: "acc", externalId: "act_1", currency: "INR", timezone: TZ, minDailyMinor: null },
    pages: [{ assetId: "page1", externalId: "p1", name: "Asha Salon", whatsappLinked: false }],
    instagram: [{ assetId: "ig1", externalId: "i1", name: "ashasalon", pageId: "p1" }],
    lastUsed: { pageExternalId: null, instagramExternalId: null },
    whatsappNumberId: null,
    hasForms: false,
    country: "IN",
    shop: null,
    welcome: {},
    brandCategory: "none",
    headroom: { leftTodayMinor: 10_000_000n, leftMonthMinor: 100_000_000n },
    fromInr: null,
    now: NOW,
    ...over,
  };
}

describe("ad account (D3)", () => {
  it("is the Phase 0 spending account", () => {
    const d = smartDefaults(facts());
    expect(d.adAccount).toEqual({ assetId: "acc", externalId: "act_1", currency: "INR", timezone: TZ });
    expect(d.chips).toEqual([]);
  });

  it("with none, an owner gets 'Choose a spending ad account' to Spending limits", () => {
    const d = smartDefaults(facts({ spendingAccount: null }));
    expect(d.adAccount).toBeNull();
    expect(d.chips).toContainEqual({ key: "choose_spending_account", text: "Choose a spending ad account", href: SPENDING_LIMITS_PATH });
  });

  it("with none, an admin gets 'Ask {owner} to choose a spending ad account'", () => {
    const d = smartDefaults(facts({ spendingAccount: null, role: "admin", ownerName: "Asha" }));
    expect(d.chips).toContainEqual({ key: "ask_owner_spending_account", text: "Ask Asha to choose a spending ad account" });
    expect(d.chips.some((c) => c.key === "choose_spending_account")).toBe(false);
    expect(smartDefaults(facts({ spendingAccount: null, role: "admin", ownerName: null })).chips[0].text).toBe("Ask the owner to choose a spending ad account");
  });
});

describe("Page and Instagram account: the only one, else the last used, else ask", () => {
  const two = [
    { assetId: "page1", externalId: "p1", name: "One", whatsappLinked: false },
    { assetId: "page2", externalId: "p2", name: "Two", whatsappLinked: false },
  ];
  it("takes the only one", () => {
    const d = smartDefaults(facts());
    expect(d.page?.assetId).toBe("page1");
    expect(d.instagram?.assetId).toBe("ig1");
  });

  it("takes the last used of several", () => {
    const d = smartDefaults(facts({ pages: two, lastUsed: { pageExternalId: "p2", instagramExternalId: null } }));
    expect(d.page?.assetId).toBe("page2");
  });

  it("asks when there are several and none was used before", () => {
    const d = smartDefaults(facts({ pages: two }));
    expect(d.page).toBeNull();
    expect(d.chips.map((c) => c.key)).toContain("choose_page");
    expect(smartDefaults(facts({ pages: [] })).chips.map((c) => c.key)).toContain("connect_page");
  });

  it("takes what the member chose", () => {
    expect(smartDefaults(facts({ pages: two }), { pageAssetId: "page1" }).page?.assetId).toBe("page1");
  });

  it("asks for the Instagram account when several could be used", () => {
    const igs = [
      { assetId: "ig1", externalId: "i1", name: "a", pageId: null },
      { assetId: "ig2", externalId: "i2", name: "b", pageId: null },
    ];
    const d = smartDefaults(facts({ instagram: igs }));
    expect(d.instagram).toBeNull();
    expect(d.chips.map((c) => c.key)).toContain("choose_instagram");
    expect(smartDefaults(facts({ instagram: igs, lastUsed: { pageExternalId: null, instagramExternalId: "i2" } })).instagram?.assetId).toBe("ig2");
  });
});

describe("goal", () => {
  it("is the one asked for", () => {
    expect(smartDefaults(facts(), { goal: "profile_visits" }).goal).toBe("profile_visits");
  });

  it("is WhatsApp chats when the workspace number is linked to the Page", () => {
    const d = smartDefaults(facts({ whatsappNumberId: "ph1", pages: [{ assetId: "page1", externalId: "p1", name: "x", whatsappLinked: true }] }));
    expect(d.goal).toBe("whatsapp_chats");
    expect(d.whatsappNumberId).toBe("ph1");
  });

  it("then a lead form when the workspace has forms, then website visits for a post with a link, then engagement", () => {
    expect(smartDefaults(facts({ hasForms: true })).goal).toBe("lead_form");
    expect(smartDefaults(facts(), { source: { kind: "ig_media", ref: "m1", caption: "Order at https://shop.example" } }).goal).toBe("website_visits");
    expect(smartDefaults(facts()).goal).toBe("engagement");
  });

  it("skips goals PROMOTE_GOALS doesn't offer", () => {
    expect(defaultGoal({ whatsappLinked: true, hasForms: true, postHasLink: false, allowed: ["lead_form", "engagement"] })).toBe("lead_form");
    expect(defaultGoal({ asked: "whatsapp_chats", whatsappLinked: false, hasForms: false, postHasLink: false, allowed: ["engagement"] })).toBe("engagement");
  });

  it("always picks an offered goal when any is offered (the service passes PROMOTE_GOALS and the D22 verify states)", () => {
    expect(defaultGoal({ whatsappLinked: true, hasForms: true, postHasLink: true, allowed: ["awareness"] })).toBe("awareness");
    expect(smartDefaults(facts({ hasForms: true, allowedGoals: ["website_visits", "page_likes"] })).goal).toBe("website_visits");
  });
});

describe("placements, audience, category, enhancements", () => {
  it("placements are Automatic, or one app when the request names it", () => {
    expect(smartDefaults(facts()).placementMode).toBe("auto");
    expect(smartDefaults(facts(), { placements: "instagram" }).placementMode).toBe("instagram");
    expect(smartDefaults(facts(), { placements: "facebook" }).placementMode).toBe("facebook");
  });

  it("the audience is 'Let Meta find people' in the workspace country, 18+", () => {
    expect(smartDefaults(facts({ country: "AE" })).audience).toEqual({ mode: "meta_finds", countries: ["AE"], ageMin: 18, advantageAudience: true, nearShop: null });
  });

  it("'near my shop' uses the stored shop: 5 km in a city, 15 km elsewhere", () => {
    const city = smartDefaults(facts({ shop: { lat: 19.1, lng: 72.8, label: "Andheri, Mumbai", pincode: null } }), { nearShop: true });
    expect(city.audience.mode).toBe("near_shop");
    expect(city.audience.nearShop).toEqual({ lat: 19.1, lng: 72.8, radiusKm: 5, label: "Andheri, Mumbai" });
    const town = smartDefaults(facts({ shop: { lat: 26.2, lng: 78.1, label: "Main Road, Morena", pincode: null } }), { nearShop: true });
    expect(town.audience.nearShop?.radiusKm).toBe(15);
    const none = smartDefaults(facts(), { nearShop: true });
    expect(none.audience.mode).toBe("meta_finds");
    expect(none.chips.map((c) => c.key)).toContain("add_shop");
  });

  it("the special ad category comes from the brand kit, and then Meta's audience expansion is off (D9)", () => {
    const d = smartDefaults(facts({ brandCategory: "housing" }));
    expect(d.specialAdCategory).toBe("housing");
    expect(d.audience.advantageAudience).toBe(false);
  });

  it("enhancements stay OPT_OUT and the call to action is the goal's own", () => {
    const d = smartDefaults(facts());
    expect(d.enhancementsOptIn).toBe(false);
    expect(d.ctaType).toBeNull();
  });

  it("chat goals get the localized first message (or the saved one) and the quick-question presets as chips", () => {
    const wa = facts({ whatsappNumberId: "ph1", pages: [{ assetId: "page1", externalId: "p1", name: "x", whatsappLinked: true }] });
    const d = smartDefaults(wa);
    expect(d.welcome).toEqual({ message: promoteText("chat.first_message_default"), iceBreakers: [] });
    expect(d.quickQuestionPresets).toEqual(["Price?", "Do you deliver to my area?", "Timings?"]);
    expect(smartDefaults(wa, { lang: "hi" }).welcome.message).toBe(promoteText("chat.first_message_default", {}, "hi"));
    expect(smartDefaults({ ...wa, welcome: { en: "Hello! Ask us anything." } }).welcome.message).toBe("Hello! Ask us anything.");
    expect(smartDefaults(facts()).welcome.message).toBe("");
  });
});

describe("budget per day (D8, 3.1a)", () => {
  it("is ₹300 when it fits", () => {
    expect(smartDefaults(facts()).budget).toEqual({ dailyMinor: 30_000n, stepMinor: 1_000n, known: true });
  });

  it("is lowered to maxFittingDaily under tight limits (₹500 left today gives ₹280)", () => {
    const tight = facts({ headroom: { leftTodayMinor: 50_000n, leftMonthMinor: 1_790_000n } });
    const d = smartDefaults(tight);
    const dates = runDates({ runDays: 7, startMode: "now", tz: TZ, now: NOW });
    const fit = maxFittingDaily({ startsAt: dates.startsAt, endsAt: dates.endsAt, tz: TZ, now: NOW, leftTodayMinor: 50_000n, leftMonthMinor: 1_790_000n, stepMinor: 1_000n, currency: "INR" });
    expect(fit).toBe(28_000n);
    expect(d.budget.dailyMinor).toBe(28_000n);
  });

  it("is never below the ad account's minimum", () => {
    const d = smartDefaults(facts({ spendingAccount: { assetId: "acc", externalId: "act_1", currency: "INR", timezone: TZ, minDailyMinor: 40_000n } }));
    expect(d.budget.dailyMinor).toBe(40_000n);
    expect(defaultBudget({ currency: "INR", fromInr: null, minDailyMinor: 40_000n, headroom: { leftTodayMinor: 50_000n, leftMonthMinor: null }, runDays: 7, tz: TZ, now: NOW }).dailyMinor).toBe(40_000n);
  });

  it("in USD is the FX equivalent of ₹300 rounded down to a whole dollar, with a step of ₹10's equivalent rounded up", () => {
    // ₹1 = $0.012: ₹300 is $3.60, so $3.00; ₹10 is $0.12, so the step is $1.
    const fromInr = (inr: bigint) => (inr * 12n) / 1000n;
    const usd = facts({ spendingAccount: { assetId: "acc", externalId: "act_1", currency: "USD", timezone: "America/New_York", minDailyMinor: null }, fromInr, headroom: null });
    expect(smartDefaults(usd).budget).toEqual({ dailyMinor: 300n, stepMinor: 100n, known: true });
  });

  it("with no fresh FX rate and no known minimum, asks for an amount", () => {
    const usd = facts({ spendingAccount: { assetId: "acc", externalId: "act_1", currency: "USD", timezone: "America/New_York", minDailyMinor: null }, fromInr: null, headroom: null });
    const d = smartDefaults(usd);
    expect(d.budget.known).toBe(false);
    expect(d.chips.map((c) => c.key)).toContain("type_amount");
  });
});

describe("days (D6, D31), start and name", () => {
  it("is 7 by default, as asked otherwise, and the run starts now", () => {
    expect(smartDefaults(facts()).run).toEqual({ runDays: 7, startMode: "now" });
    expect(smartDefaults(facts(), { days: 5 }).run.runDays).toBe(5);
  });

  it("a 1-day request runs 2 days, with the chip", () => {
    const d = smartDefaults(facts(), { days: 1 });
    expect(d.run.runDays).toBe(2);
    expect(d.chips).toContainEqual({ key: "min_days", text: "Meta needs at least 2 days. Run for 2 days?" });
    expect(defaultRunDays(120).runDays).toBe(90);
    expect(defaultRunDays(null)).toEqual({ runDays: 7, chip: null });
  });

  it("names the draft automatically", () => {
    expect(defaultName({ goal: "engagement", source: { kind: "ig_media", ref: "m1", caption: "Diwali offer", postKind: "reel" }, now: NOW, tz: TZ })).toBe("Boost · Reel 'Diwali offer' · 28 Oct");
    expect(defaultName({ goal: "engagement", source: { kind: "ig_media", ref: "m1", caption: "Diwali offer on every saree this week", postKind: "reel" }, now: NOW, tz: TZ })).toBe("Boost · Reel 'Diwali offer on…' · 28 Oct");
    expect(smartDefaults(facts({ whatsappNumberId: "ph1", pages: [{ assetId: "page1", externalId: "p1", name: "x", whatsappLinked: true }] })).name).toBe("Get WhatsApp chats · 28 Oct");
  });
});

describe("loadDefaultFacts", () => {
  beforeEach(() => {
    h.db.spendControl.findUnique.mockReset().mockResolvedValue({ spendingAdAccountAssetId: "acc", timezone: "Asia/Kolkata" });
    h.db.metaAsset.findMany.mockReset().mockResolvedValue([
      { id: "acc", type: "ad_account", externalId: "act_1", name: "Ads", meta: { currency: "inr", timezone: "Asia/Kolkata", minDailyBudgetMinor: 10_000 } },
      { id: "page1", type: "page", externalId: "p1", name: "Asha Salon", meta: { whatsappNumber: "+91 98765 43210" } },
      { id: "ig1", type: "instagram", externalId: "i1", name: null, meta: { username: "ashasalon", pageId: "p1" } },
    ]);
    h.db.membership.findFirst.mockReset().mockResolvedValue({ user: { name: "Asha" } });
    h.db.phoneNumber.findFirst.mockReset().mockResolvedValue({ id: "ph1", displayPhone: "+91 98765 43210" });
    h.db.leadForm.count.mockReset().mockResolvedValue(0);
    h.db.brand.findFirst.mockReset().mockResolvedValue(null);
    h.db.platformSetting.findUnique.mockReset().mockResolvedValue(null);
    h.db.adCampaign.findFirst.mockReset().mockResolvedValue(null);
    h.headroom.mockReset().mockResolvedValue({ headroom: { today: { left: 50_000n }, month: { left: 1_790_000n } } });
    h.readFx.mockReset();
  });

  it("reads the spending account, the number linked to the Page, the country and the limits", async () => {
    const f = await loadDefaultFacts({ tenantId: "t1", userId: "u1", role: "admin" }, { now: NOW });
    expect(f.spendingAccount).toEqual({ assetId: "acc", externalId: "act_1", currency: "INR", timezone: "Asia/Kolkata", minDailyMinor: 10_000n });
    expect(f.pages[0].whatsappLinked).toBe(true);
    expect(f.country).toBe("IN");
    expect(f.headroom).toEqual({ leftTodayMinor: 50_000n, leftMonthMinor: 1_790_000n });
    expect(h.readFx).not.toHaveBeenCalled();
    const d = smartDefaults(f);
    expect(d.goal).toBe("whatsapp_chats");
    expect(d.budget.dailyMinor).toBe(28_000n);
  });

  it("has no account when the owner chose none, and never fails on an optional fact", async () => {
    h.db.spendControl.findUnique.mockResolvedValue(null);
    h.headroom.mockRejectedValue(new Error("down"));
    const f = await loadDefaultFacts({ tenantId: "t1", userId: "u1", role: "owner" }, { now: NOW });
    expect(f.spendingAccount).toBeNull();
    expect(smartDefaults(f).chips[0].key).toBe("choose_spending_account");
  });

  it("reads the country from the WhatsApp number's calling code", () => {
    expect(countryOfPhone("+971 50 123 4567")).toBe("AE");
    expect(countryOfPhone("+1 415 555 0100")).toBe("US");
    expect(countryOfPhone(null)).toBe("IN");
  });
});
