import { describe, expect, it } from "vitest";
import { DEFAULT_OPTIMIZER_CONFIG, defaultsFor, parseConfigInput, sanitizeConfig } from "@/lib/optimizer/config";
import { dedupe } from "@/lib/optimizer/engine";
import {
  allProposals,
  hookPatterns,
  newAngleProposals,
  pauseAdProposals,
  rotateCreativeProposals,
  shiftAmount,
  shiftBudgetProposals,
  type AdRef,
  type AdSetRef,
  type Snap,
} from "@/lib/optimizer/rules";

const cfg = DEFAULT_OPTIMIZER_CONFIG;
const now = new Date("2026-10-27T10:00:00Z");
const day = (age: number) => new Date(Date.UTC(2026, 9, 27 - age));
const snap = (id: string, age: number, p: Partial<Snap> = {}): Snap => ({ entityMetaId: id, date: day(age), spendMinor: 0, impressions: 0, clicks: 0, results: 0, frequency: null, ...p });
const week = (id: string, spendPerDay: number, resultsPerDay: number): Snap[] => [0, 1, 2, 3, 4, 5, 6].map((a) => snap(id, a, { spendMinor: spendPerDay, results: resultsPerDay }));
const ad = (metaId: string, extra: Partial<AdRef> = {}): AdRef => ({ metaId, name: metaId, adSetMetaId: "s1", campaignMetaId: "c1", ...extra });

describe("pause_ad", () => {
  const ads = [ad("a1"), ad("a2"), ad("a3")];
  it("flags an ad with cost per result well above the campaign average", () => {
    const snaps = [...week("a1", 10_000, 2), ...week("a2", 10_000, 2), ...week("a3", 30_000, 1)];
    const out = pauseAdProposals(ads, snaps, cfg, now);
    expect(out.map((o) => o.targetMetaId)).toEqual(["a3"]);
    expect(out[0].payload.reason).toBe("high_cpr");
  });
  it("flags zero results after enough spend", () => {
    const snaps = [...week("a1", 10_000, 2), ...week("a2", 20_000, 0)];
    const out = pauseAdProposals(ads, snaps, cfg, now);
    expect(out.map((o) => o.targetMetaId)).toEqual(["a2"]);
    expect(out[0].payload.reason).toBe("zero_results");
  });
  it("ignores tiny spend and handles no data", () => {
    expect(pauseAdProposals(ads, week("a2", 100, 0), cfg, now)).toEqual([]);
    expect(pauseAdProposals(ads, [], cfg, now)).toEqual([]);
    expect(pauseAdProposals([], [], cfg, now)).toEqual([]);
  });
  it("ignores snapshots outside the window", () => {
    expect(pauseAdProposals(ads, [snap("a2", 20, { spendMinor: 900_000 })], cfg, now)).toEqual([]);
  });
  it("does not use the cost rule for a lone ad", () => {
    expect(pauseAdProposals([ad("a1")], week("a1", 10_000, 1), cfg, now)).toEqual([]);
  });
});

describe("shift_budget", () => {
  const sets: AdSetRef[] = [
    { metaId: "s1", name: "Worst", campaignMetaId: "c1", dailyBudgetMinor: 100_000 },
    { metaId: "s2", name: "Best", campaignMetaId: "c1", dailyBudgetMinor: 100_000 },
  ];
  const snaps = [...week("s1", 20_000, 1), ...week("s2", 10_000, 2)];
  it("moves at most 20 percent from worst to best", () => {
    const [d] = shiftBudgetProposals(sets, snaps, cfg, now, { maxDailyBudgetMinor: 500_000 });
    expect(d.payload).toMatchObject({ fromAdSetMetaId: "s1", toAdSetMetaId: "s2", amountMinor: 20_000, fromBudgetAfter: 80_000, toBudgetAfter: 120_000 });
  });
  it("never exceeds the cap on the receiving ad set", () => {
    const [d] = shiftBudgetProposals(sets, snaps, cfg, now, { maxDailyBudgetMinor: 105_000 });
    expect(d.payload.amountMinor).toBe(5_000);
    expect(shiftBudgetProposals(sets, snaps, cfg, now, { maxDailyBudgetMinor: 100_000 })).toEqual([]);
  });
  it("proposes nothing when no cap is configured", () => {
    expect(shiftBudgetProposals(sets, snaps, cfg, now, { maxDailyBudgetMinor: null })).toEqual([]);
  });
  it("respects the donor floor and a hostile config", () => {
    expect(shiftAmount(100_000, 0, { ...cfg, maxShiftPct: 90 }, 1_000_000)).toBe(20_000);
    expect(shiftAmount(12_000, 0, cfg, 1_000_000)).toBe(2_000);
    expect(shiftAmount(10_000, 0, cfg, 1_000_000)).toBe(0);
  });
  it("needs two judged ad sets and a real gap", () => {
    expect(shiftBudgetProposals(sets, [], cfg, now, { maxDailyBudgetMinor: 500_000 })).toEqual([]);
    expect(shiftBudgetProposals(sets, [...week("s1", 10_000, 2), ...week("s2", 10_000, 2)], cfg, now, { maxDailyBudgetMinor: 500_000 })).toEqual([]);
    expect(shiftBudgetProposals([sets[0]], snaps, cfg, now, { maxDailyBudgetMinor: 500_000 })).toEqual([]);
  });
  it("skips ad sets without their own budget", () => {
    const cbo = sets.map((s) => ({ ...s, dailyBudgetMinor: null }));
    expect(shiftBudgetProposals(cbo, snaps, cfg, now, { maxDailyBudgetMinor: 500_000 })).toEqual([]);
  });
});

describe("rotate_creative", () => {
  const fatigued = (freq: number | null, earlyClicks: number, lateClicks: number): Snap[] =>
    [0, 1, 2, 3, 4, 5, 6].map((a) => snap("a1", a, { impressions: 1000, clicks: a < 3 ? lateClicks : earlyClicks, frequency: a === 0 ? freq : 2 }));
  it("flags high frequency with falling CTR", () => {
    const [d] = rotateCreativeProposals([ad("a1")], fatigued(3.5, 30, 15), cfg, now);
    expect(d.kind).toBe("rotate_creative");
    expect(d.payload.ctrDropPct).toBe(50);
  });
  it("ignores low frequency, stable CTR, missing frequency and thin data", () => {
    expect(rotateCreativeProposals([ad("a1")], fatigued(2.5, 30, 15), cfg, now)).toEqual([]);
    expect(rotateCreativeProposals([ad("a1")], fatigued(3.5, 30, 29), cfg, now)).toEqual([]);
    expect(rotateCreativeProposals([ad("a1")], fatigued(null, 30, 10).map((s) => ({ ...s, frequency: null })), cfg, now)).toEqual([]);
    expect(rotateCreativeProposals([ad("a1")], [snap("a1", 0, { frequency: 5, impressions: 10, clicks: 0 })], cfg, now)).toEqual([]);
    expect(rotateCreativeProposals([ad("a1")], [], cfg, now)).toEqual([]);
  });
});

describe("new_angle", () => {
  const ads = [
    ad("a1", { hookText: "Need a new phone? Get 20% off" }),
    ad("a2", { hookText: "Looking for deals? Visit us" }),
    ad("a3", { hookText: "Our shop sells phones" }),
  ];
  const snaps = [...week("a1", 10_000, 3), ...week("a2", 10_000, 3), ...week("a3", 10_000, 0.3)];
  it("suggests text based on the winning hook pattern", () => {
    const [d] = newAngleProposals(ads, snaps, cfg, now);
    expect(d.kind).toBe("new_angle");
    expect(d.payload.pattern).toBe("question");
    expect(d.payload.advisory).toBe(true);
    expect(typeof d.payload.suggestion).toBe("string");
  });
  it("needs enough winners and spend", () => {
    expect(newAngleProposals(ads, [], cfg, now)).toEqual([]);
    expect(newAngleProposals(ads, [...week("a1", 10_000, 3), ...week("a3", 10_000, 0.3)], cfg, now)).toEqual([]);
  });
  it("classifies hooks", () => {
    expect(hookPatterns("")).toEqual([]);
    expect(hookPatterns("Free delivery today")).toEqual(expect.arrayContaining(["offer", "urgency"]));
  });
});

describe("orchestration and config", () => {
  it("returns nothing when disabled", () => {
    expect(allProposals({ ads: [ad("a1")], adSets: [], adSnaps: week("a1", 900_000, 0), adSetSnaps: [], cfg: { ...cfg, enabled: false }, now, limits: { maxDailyBudgetMinor: null } })).toEqual([]);
  });
  it("dedupes against open proposals", () => {
    const drafts = [{ kind: "pause_ad", targetMetaId: "a1" }, { kind: "pause_ad", targetMetaId: "a2" }, { kind: "pause_ad", targetMetaId: "a2" }] as never[];
    expect(dedupe(drafts, [{ kind: "pause_ad", targetMetaId: "a1" }])).toHaveLength(1);
  });
  it("clamps and validates settings", () => {
    expect(sanitizeConfig({ maxShiftPct: 50, cprMultiple: 3, bogus: 1 })).toMatchObject({ maxShiftPct: 20, cprMultiple: 3 });
    expect(sanitizeConfig("x")).toEqual(cfg);
    expect(() => parseConfigInput({ maxShiftPct: 50 })).toThrow();
    expect(() => parseConfigInput({ nope: 1 })).toThrow();
    expect(parseConfigInput({ enabled: false, expireDays: 3 })).toEqual({ enabled: false, expireDays: 3 });
  });
});

describe("plain-language rationale and currency-aware thresholds (docs/SPEND-CONTROLS-SPEC.md 7.3, 8.4)", () => {
  const ads3 = [ad("a1"), ad("a2"), ad("a3")];
  const shiftSets: AdSetRef[] = [
    { metaId: "s1", name: "Worst", campaignMetaId: "c1", dailyBudgetMinor: 100_000 },
    { metaId: "s2", name: "Best", campaignMetaId: "c1", dailyBudgetMinor: 100_000 },
  ];

  it("no proposal text says 'minor units'; money is formatted with the currency and its exponent", () => {
    const all = [
      ...pauseAdProposals(ads3, [...week("a1", 10_000, 2), ...week("a2", 20_000, 0)], cfg, now),
      ...pauseAdProposals(ads3, [...week("a1", 10_000, 2), ...week("a2", 10_000, 2), ...week("a3", 30_000, 1)], cfg, now),
      ...shiftBudgetProposals(shiftSets, [...week("s1", 20_000, 1), ...week("s2", 10_000, 2)], cfg, now, { maxDailyBudgetMinor: 500_000 }),
      ...newAngleProposals(
        [ad("a1", { hookText: "Need a new phone? Get 20% off" }), ad("a2", { hookText: "Looking for deals? Visit us" }), ad("a3", { hookText: "Our shop sells phones" })],
        [...week("a1", 10_000, 3), ...week("a2", 10_000, 3), ...week("a3", 10_000, 0.3)],
        cfg,
        now,
      ),
    ];
    expect(all.length).toBeGreaterThanOrEqual(4);
    for (const d of all) expect(d.rationale).not.toMatch(/minor units/i);
    expect(all[0].rationale).toBe("Spent ₹1,400 in 7 days with no results.");
    expect(all[1].rationale).toBe("Cost per result is 3 times the campaign average over 7 days (₹300 against ₹100).");
    expect(all[2].rationale).toBe('Ad set "Worst" costs ₹200 per result against ₹50 for "Best" over 7 days. Move ₹200 of daily budget (20%).');
    // The optimizer page reads the ad set names from this sentence.
    expect(/Ad set "(.+?)" costs .* for "(.+?)" over/.exec(all[2].rationale)?.slice(1)).toEqual(["Worst", "Best"]);
    const jpy = pauseAdProposals(ads3, [...week("a1", 1_000, 2), ...week("a2", 200_000, 0)], { ...cfg, minSpendMinor: 0, zeroResultSpendMinor: 0 }, now, "JPY");
    expect(jpy[0].rationale).toBe("Spent ¥14,00,000 in 7 days with no results.");
    expect(allProposals({ ads: ads3, adSets: [], adSnaps: [...week("a1", 10_000, 2), ...week("a2", 20_000, 0)], adSetSnaps: [], cfg, now, limits: { maxDailyBudgetMinor: null }, currency: "USD" })[0].rationale).toBe("Spent $1,400 in 7 days with no results.");
  });

  it("converts the INR money thresholds for other currencies, and keeps ratios as they are", () => {
    expect(defaultsFor("INR")).toEqual(DEFAULT_OPTIMIZER_CONFIG);
    const jpy = defaultsFor("JPY");
    expect([jpy.minSpendMinor, jpy.zeroResultSpendMinor, jpy.minAdSetBudgetMinor]).toEqual([500, 1_000, 100]);
    expect(jpy.cprMultiple).toBe(DEFAULT_OPTIMIZER_CONFIG.cprMultiple);
    const usd = defaultsFor("USD", { base: "INR", rates: { USD: { currency: "USD", rate: "83.5", updatedAt: now } }, updatedAt: now, byUserId: null }, now);
    expect(usd.minSpendMinor).toBe(598);
    expect(sanitizeConfig({ minSpendMinor: 1_234 }, jpy).minSpendMinor).toBe(1_234);
  });

  it("suggestions expire in hours (1 to 48, default 12); the old days setting is still accepted", () => {
    expect(DEFAULT_OPTIMIZER_CONFIG.expireHours).toBe(12);
    expect(sanitizeConfig({ expireHours: 6 }).expireHours).toBe(6);
    expect(sanitizeConfig({ expireHours: 49 }).expireHours).toBe(12);
    expect(() => parseConfigInput({ expireHours: 0 })).toThrow();
    expect(parseConfigInput({ expireDays: 3 })).toEqual({ expireDays: 3 });
  });
});
