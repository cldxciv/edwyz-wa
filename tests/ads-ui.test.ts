import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  activeBudgetElsewhere,
  budgetRoom,
  campaignNotice,
  campaignStatusView,
  capUsagePercent,
  checkBudget,
  friendlyAdsError,
  isMetaLoginProblem,
  META_LOGIN_FIX,
  isCategoryTermsMismatch,
  minorToText,
  parseCountries,
  pictureCovered,
  pictureLinkError,
  pictureReady,
  toMinor,
  typedTotalMatches,
} from "@/components/ads/helpers";
import { compactNumber, deltaView, fatigueReasons, nearestIndex, pacingView, qualityLabel } from "@/components/ads/insights/insight-helpers";
import { BudgetSummary, CategoryGuidance, Stepper, TermsAckBox } from "@/components/ads/wizard-parts";
import { DailyChart } from "@/components/ads/insights/DailyChart";
import { monthEndInput, wizardWorstCase, worstCaseLines, WorstCaseNote } from "@/components/ads/CampaignWizard";
import { CampaignsView, CapSummary, capHelpText, capSummaryLines } from "@/components/ads/CampaignsView";
import { readFileSync } from "node:fs";

describe("budget helpers", () => {
  it("converts typed amounts to minor units and back", () => {
    expect(toMinor("500", "INR")).toBe(50000);
    expect(toMinor("1,499.50", "INR")).toBe(149950);
    expect(toMinor("500", "JPY")).toBe(500);
    expect(toMinor("", "INR")).toBeNull();
    expect(toMinor("0", "INR")).toBeNull();
    expect(toMinor("abc", "INR")).toBeNull();
    expect(minorToText(50000, "INR")).toBe("500");
    expect(minorToText(149950, "INR")).toBe("1499.5");
  });

  it("requires the typed total to equal the campaign total exactly", () => {
    expect(typedTotalMatches("500", 50000, "INR")).toBe(true);
    expect(typedTotalMatches(" 500.00 ", 50000, "INR")).toBe(true);
    expect(typedTotalMatches("5,00", 50000, "INR")).toBe(true);
    expect(typedTotalMatches("499", 50000, "INR")).toBe(false);
    expect(typedTotalMatches("", 50000, "INR")).toBe(false);
    expect(typedTotalMatches("5000", 50000, "INR")).toBe(false);
  });

  it("explains a budget problem in plain words", () => {
    expect(checkBudget("", "INR", 100000).state).toBe("empty");
    expect(checkBudget("abc", "INR", 100000).message).toMatch(/above zero/);
    const over = checkBudget("2000", "INR", 100000);
    expect(over.state).toBe("over");
    expect(over.message).toMatch(/daily limit/);
    expect(checkBudget("500", "INR", 100000)).toEqual({ state: "ok", message: null });
    expect(checkBudget("500", "INR", null).state).toBe("ok");
  });

  it("computes how much of the workspace limit a campaign uses", () => {
    expect(capUsagePercent(25000, 100000)).toBe(25);
    expect(capUsagePercent(250000, 100000)).toBe(100);
    expect(capUsagePercent(null, 100000)).toBeNull();
    expect(capUsagePercent(25000, null)).toBeNull();
  });
});

describe("audience helpers", () => {
  it("normalises country codes and reports bad entries", () => {
    expect(parseCountries("in, AE  us")).toEqual({ codes: ["IN", "AE", "US"], invalid: [] });
    expect(parseCountries("IN, India, in")).toEqual({ codes: ["IN"], invalid: ["India"] });
    expect(parseCountries("")).toEqual({ codes: [], invalid: [] });
  });
});

describe("plain-language errors", () => {
  it("hides field names and units", () => {
    expect(friendlyAdsError("dailyBudgetMinor must be a positive whole number in minor units.")).toBe("Enter a daily budget above zero.");
    expect(friendlyAdsError("No daily budget cap is set. An owner must set a cap in ad settings before anything can launch.")).toMatch(/daily spending limit/);
    expect(friendlyAdsError("")).toMatch(/try again/i);
    expect(friendlyAdsError("Ad account not found.")).toBe("Ad account not found.");
  });

  it("turns Meta's raw login error into a reconnect instruction instead of 'try again'", () => {
    const raw = "Create campaign: Invalid OAuth access token - Cannot parse access token. Objects already created on Meta were saved; launch again to continue.";
    expect(isMetaLoginProblem(raw)).toBe(true);
    expect(friendlyAdsError(raw)).toBe(META_LOGIN_FIX);
    expect(META_LOGIN_FIX).toMatch(/Reconnect under Meta connections/);
    expect(META_LOGIN_FIX).not.toMatch(/OAuth|token|launch again/i);
    expect(friendlyAdsError("Error validating access token: Session has expired on Monday.")).toBe(META_LOGIN_FIX);
    expect(friendlyAdsError("(#190) This method must be called with a valid access token")).toBe(META_LOGIN_FIX);
    expect(isMetaLoginProblem("Ad account not found.")).toBe(false);
    expect(isMetaLoginProblem(null)).toBe(false);
    expect(friendlyAdsError("Create ad set: Meta said no. Objects already created on Meta were saved; launch again to continue.")).toMatch(/Meta said no/);
  });

  it("recognises the special category wording mismatch", () => {
    const raw = "Your ad copy, links or brand industry suggest the housing special ad category, but you declared none. Choose the matching special ad category (API field acknowledgeSpecialCategoryTerms).";
    expect(isCategoryTermsMismatch(raw)).toBe(true);
    const friendly = friendlyAdsError(raw);
    expect(friendly).toMatch(/housing/);
    expect(friendly).not.toMatch(/acknowledgeSpecialCategoryTerms/);
    expect(isCategoryTermsMismatch("Ad account not found.")).toBe(false);
  });
});

describe("campaign status", () => {
  it("never shows raw enum values", () => {
    expect(campaignStatusView("launching").label).toBe("Setting up on Meta");
    expect(campaignStatusView("error")).toEqual({ label: "Needs attention", tone: "bad" });
    expect(campaignStatusView("active").tone).toBe("good");
  });

  it("gives guidance for each lifecycle stage", () => {
    for (const s of ["draft", "launching", "paused", "active", "archived"]) expect(campaignNotice(s)?.title).toBeTruthy();
    expect(campaignNotice("error")).toBeNull();
    expect(campaignNotice("paused")?.body).toMatch(/Activate/);
  });
});

describe("insight helpers", () => {
  it("shows change against the previous period and which direction is good", () => {
    expect(deltaView(120, 100)).toEqual({ value: "20% vs previous period", direction: "up", good: true });
    expect(deltaView(80, 100, { lowerIsBetter: true })).toEqual({ value: "20% vs previous period", direction: "down", good: true });
    expect(deltaView(120, 100, { lowerIsBetter: true })?.good).toBe(false);
    expect(deltaView(120, 100, { neutral: true })?.good).toBeUndefined();
    expect(deltaView(100, 100)?.direction).toBe("flat");
    expect(deltaView(5, 0)).toBeNull();
    expect(deltaView(null, 5)).toBeNull();
  });

  it("describes pacing with words, not just colour", () => {
    expect(pacingView("under", 40)).toMatchObject({ label: "Under budget", tone: "warn", fill: 40 });
    expect(pacingView("over", 130)).toMatchObject({ label: "Over budget", fill: 100 });
    expect(pacingView("on_track", 95)).toMatchObject({ label: "On track", tone: "good" });
    expect(pacingView("under", 40).detail).toBe("Spending 40% of the daily budget");
  });

  it("translates quality rankings and fatigue reasons", () => {
    expect(qualityLabel("below_average_35")).toBe("Below average");
    expect(qualityLabel("above_average")).toBe("Above average");
    expect(qualityLabel(null)).toBe("Unknown");
    expect(fatigueReasons({ frequency: 4.26, qualityRanking: "below_average_20", reasons: ["frequency", "quality"] })).toEqual(["Each person has seen it about 4.3 times", "Meta rates its quality below average"]);
  });

  it("finds the nearest chart point and compacts axis numbers", () => {
    expect(nearestIndex(0, 50, 250, 5)).toBe(0);
    expect(nearestIndex(150, 50, 250, 5)).toBe(2);
    expect(nearestIndex(900, 50, 250, 5)).toBe(4);
    expect(nearestIndex(10, 50, 250, 1)).toBe(0);
    expect(compactNumber(1200)).toBe("1.2K");
  });
});

describe("rendered pieces", () => {
  it("marks the current wizard step for assistive technology", () => {
    const html = renderToStaticMarkup(createElement(Stepper, { steps: ["Goal", "Budget", "Audience", "Ad", "Review"], current: 2 }));
    expect(html).toContain("Step 2 of 5");
    expect(html).toContain('aria-current="step"');
    expect(html).toContain("Done: ");
  });

  it("shows the campaign budget and the workspace limit side by side with a labelled meter", () => {
    const html = renderToStaticMarkup(createElement(BudgetSummary, { budgetMinor: 50000, capMinor: 200000, currency: "INR" }));
    expect(html).toContain("This campaign, per day");
    expect(html).toContain("Your daily limit, all campaigns");
    expect(html).toContain('role="progressbar"');
    expect(html).toContain("25% of your limit");
  });

  it("shows Not set when there is no budget or limit", () => {
    const html = renderToStaticMarkup(createElement(BudgetSummary, { budgetMinor: null, capMinor: null, currency: "INR" }));
    expect(html.match(/Not set/g)?.length).toBe(2);
    expect(html).not.toContain("progressbar");
  });

  it("explains special categories in simple words and the extra rules when one applies", () => {
    const none = renderToStaticMarkup(createElement(CategoryGuidance, { category: "none", suggested: "none" }));
    expect(none).toContain("housing, jobs, credit");
    expect(none).not.toContain("extra rules");
    const housing = renderToStaticMarkup(createElement(CategoryGuidance, { category: "housing", suggested: "housing" }));
    expect(housing).toContain("Housing ads have extra rules");
    expect(housing).toContain("no narrowing by age or gender");
  });

  it("draws an accessible chart with a table fallback and keyboard help", () => {
    const html = renderToStaticMarkup(
      createElement(DailyChart, { title: "Spend per day", name: "Spend", days: ["2026-10-01", "2026-10-02", "2026-10-03"], values: [100, 300, 200], format: (n: number) => `Rs ${n}` }),
    );
    expect(html).toContain('role="img"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain("Use the left and right arrow keys");
    expect(html).toContain("View as table");
    expect(html).toContain("Rs 600 in total, highest on");
    expect(html).not.toMatch(/#[0-9a-f]{6}/i);
  });

  it("describes an empty chart without inventing numbers", () => {
    const html = renderToStaticMarkup(createElement(DailyChart, { title: "Results per day", name: "Results", days: [], values: [], format: String }));
    expect(html).toContain("Results: none in this period.");
  });
});

describe("shared workspace limit", () => {
  const list = [
    { status: "active", currency: "INR", totalDailyBudgetMinor: 30000 },
    { status: "active", currency: "INR", totalDailyBudgetMinor: 20000 },
    { status: "paused", currency: "INR", totalDailyBudgetMinor: 90000 },
    { status: "active", currency: "USD", totalDailyBudgetMinor: 5000 },
  ];

  it("adds up only active campaigns in the same currency", () => {
    expect(activeBudgetElsewhere(list, "INR")).toBe(50000);
    expect(activeBudgetElsewhere(list, "USD")).toBe(5000);
    expect(activeBudgetElsewhere([], "INR")).toBe(0);
  });

  it("says what is left and whether a budget fits", () => {
    expect(budgetRoom(40000, 100000, 50000)).toEqual({ leftMinor: 50000, fits: true });
    expect(budgetRoom(60000, 100000, 50000)).toEqual({ leftMinor: 50000, fits: false });
    expect(budgetRoom(10000, 100000, 120000)).toEqual({ leftMinor: 0, fits: false });
    expect(budgetRoom(null, 100000, 50000)?.fits).toBe(true);
    expect(budgetRoom(10000, null, 50000)).toBeNull();
    expect(budgetRoom(10000, 100000, null)).toBeNull();
  });

  it("shows what other campaigns use and what is left", () => {
    const html = renderToStaticMarkup(createElement(BudgetSummary, { budgetMinor: 20000, capMinor: 100000, currency: "INR", usedMinor: 50000 }));
    expect(html).toContain("Already used by active campaigns");
    expect(html).toContain("Left for this campaign");
    expect(html).toContain('data-testid="wizard-left"');
  });

  it("falls back to a note when the other campaigns are unknown", () => {
    const html = renderToStaticMarkup(createElement(BudgetSummary, { budgetMinor: 20000, capMinor: 100000, currency: "INR" }));
    expect(html).not.toContain("Already used by active campaigns");
    expect(html).toContain("Other active campaigns also count toward this limit.");
  });

  it("explains the server's cap messages in plain words", () => {
    const shared = friendlyAdsError("The workspace daily budget cap is ₹5,000.00. Active campaigns already use ₹4,000.00, so this campaign (₹2,000.00) would exceed the cap.");
    expect(shared).toContain("₹5,000.00 across all campaigns");
    expect(shared).toContain("already use ₹4,000.00");
    expect(shared).toMatch(/pause another campaign/);
    const single = friendlyAdsError("The daily budget ₹6,000.00 exceeds the cap of ₹5,000.00.");
    expect(single).toContain("₹6,000.00");
    expect(single).toContain("limit of ₹5,000.00.");
    expect(friendlyAdsError("The budget cap is set in INR but this campaign uses USD.")).toMatch(/set the limit in USD/);
    expect(friendlyAdsError("The budget cap has no currency. An owner must save the cap again in ad settings.")).toMatch(/needs a currency/);
  });

  it("offers the special category acknowledgement as a labelled checkbox", () => {
    const html = renderToStaticMarkup(createElement(TermsAckBox, { checked: false, onChange: () => undefined }));
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("I have read Meta&#x27;s rules");
  });
});

describe("picture link", () => {
  const withPicture = { id: "a", headline: null, body: null, hasImage: true };
  const noPicture = { id: "b", headline: null, body: null, hasImage: false };

  it("needs an https address unless every chosen creative already has a picture", () => {
    expect(pictureReady("", [])).toBe(false);
    expect(pictureReady("http://x.test/a.png", [])).toBe(false);
    expect(pictureReady(" https://x.test/a.png ", [])).toBe(true);
    expect(pictureReady("", [withPicture])).toBe(true);
    expect(pictureReady("", [withPicture, noPicture])).toBe(false);
    expect(pictureCovered([])).toBe(false);
  });

  it("names a typed address that is not usable", () => {
    expect(pictureLinkError("")).toBeNull();
    expect(pictureLinkError("https://x.test/a.png")).toBeNull();
    expect(pictureLinkError("x.test/a.png")).toMatch(/https/);
  });

  it("puts the server's missing-image rule in plain words", () => {
    expect(friendlyAdsError("Leave me ad: Add an image (imageUrl or imageHash).")).toBe("Add a picture link for your ad.");
  });
});

describe("the wizard's worst-case lines (docs/SPEND-CONTROLS-SPEC.md 4.5, 8.2)", () => {
  /** A moment in October 2026, Asia/Kolkata. */
  const oct = (d: number, hour = 0) => new Date(Date.UTC(2026, 9, d, hour) - 5.5 * 3_600_000);
  const base = { budgetMinor: 100_000, currency: "INR", startsAt: null, endsAt: null, timeZone: "Asia/Kolkata" };

  it("says what Meta may spend on a busy day: 1.75 x the daily budget", () => {
    expect(worstCaseLines({ ...base, now: oct(28, 12) })[0]).toBe("Meta may spend up to ₹1,750 on a busy day.");
    expect(worstCaseLines({ ...base, budgetMinor: 114_285, now: oct(28, 12) })[0]).toBe("Meta may spend up to ₹1,999.99 on a busy day.");
  });

  it("with an end date this month, gives what the campaign could use of the monthly limit (the October table)", () => {
    expect(worstCaseLines({ ...base, endsAt: oct(14, 23), now: oct(1) })[1]).toBe("With an end date of 14 Oct this campaign could use up to ₹19,250 of your monthly limit.");
    expect(worstCaseLines({ ...base, endsAt: oct(31, 23), now: oct(28, 10) })[1]).toBe("With an end date of 31 Oct this campaign could use up to ₹7,000 of your monthly limit.");
  });

  it("without an end date, says money is set aside until the end of each month", () => {
    expect(worstCaseLines({ ...base, now: oct(1) })[1]).toBe("Without an end date we set money aside until the end of each month: up to ₹33,250 this month.");
  });

  it("an end date next month counts this month, and says the rest is set aside later", () => {
    const end = new Date(Date.UTC(2026, 10, 14, 17, 30));
    expect(worstCaseLines({ ...base, endsAt: end, now: oct(28, 10) })[1]).toBe("With an end date of 14 Nov this campaign could use up to ₹7,000 of this month's limit. We set the rest aside at the start of each month until then.");
  });

  it("counts from the start date when that is later, in the ad account's time zone (Asia/Kolkata when unknown)", () => {
    const start = new Date(Date.UTC(2026, 10, 1) - 5.5 * 3_600_000);
    const end = new Date(Date.UTC(2026, 10, 14, 17, 30));
    expect(wizardWorstCase({ ...base, startsAt: start, endsAt: end, now: oct(28), timeZone: null })).toEqual({ busyDayMinor: 175_000n, monthMinor: 1_400_000n, endsThisMonth: true });
  });

  it("defaults the end date to the last day of the month", () => {
    expect(monthEndInput(new Date(2026, 9, 28, 12))).toBe("2026-10-31T23:59");
    expect(monthEndInput(new Date(2026, 11, 1))).toBe("2026-12-31T23:59");
    expect(monthEndInput(new Date(2028, 1, 10))).toBe("2028-02-29T23:59");
  });

  it("renders the lines in a polite status region, with theme tokens only", () => {
    const html = renderToStaticMarkup(createElement(WorstCaseNote, { ...base, endsAt: oct(14, 23), now: oct(1) }));
    expect(html).toContain('role="status"');
    expect(html).toContain("What Meta could spend");
    expect(html).toContain("Meta may spend up to ₹1,750 on a busy day.");
    expect(html).toContain('data-testid="worst-case"');
    expect(html).not.toMatch(/dark:|#[0-9a-f]{3,6}/i);
  });
});

describe("the CapPanel on /app/ads (docs/SPEND-CONTROLS-SPEC.md 8.2)", () => {
  const money = (minor: number) => ({ minor: String(minor), currency: "INR", formatted: `₹${(minor / 100).toLocaleString("en-IN")}` });
  const ads = {
    today: { spent: money(85_000), committed: money(0), held: money(0), left: money(115_000), usedPct: 42 },
    month: { spent: money(620_000), committed: money(700_000), held: money(0), left: money(680_000), usedPct: 66 },
    limits: {
      daily: money(200_000),
      monthly: money(2_000_000),
      effectiveDaily: money(200_000),
      effectiveMonthly: money(2_000_000),
      ceiling: { daily: null, monthly: null, source: null, expiresAt: null, unknown: false },
      binding: "owner" as const,
      migratedFromCap: null,
      planCapMonthly: null,
      version: 1,
    },
  };

  it("keeps its labels and the cap-status region, and adds the summary lines and the link", () => {
    const html = renderToStaticMarkup(createElement(CampaignsView));
    expect(html).toContain("Daily spending limit");
    expect(html).toContain('data-testid="cap-status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("Only an owner can change the limit.");
    expect(html).toContain('href="/app/settings/spending"');
    expect(html).toContain("All spending limits");
    // The owner's form keeps its labels (rendered once the role is known in the browser).
    const source = readFileSync("src/components/ads/CampaignsView.tsx", "utf8");
    for (const label of ["Daily spending limit", "New daily limit", "Save limit", "Only an owner can change the limit.", 'data-testid="cap-status"']) expect(source).toContain(label);
  });

  it("says what is left today and this month, and what is set aside, in the 8.2 words", () => {
    expect(capSummaryLines(ads)).toEqual(["Ads limit: ₹1,150 of ₹2,000 left today · ₹6,800 of ₹20,000 left this month", "Set aside for running ads: ₹7,000"]);
    const notSet = { ...ads, limits: { ...ads.limits, effectiveDaily: null, effectiveMonthly: null }, today: { ...ads.today, left: null }, month: { ...ads.month, left: null } };
    expect(capSummaryLines(notSet)[0]).toBe("Ads limit: Not set today · Not set this month");
    const html = renderToStaticMarkup(createElement(CapSummary, { ads }));
    expect(html).toContain("Ads limit: ₹1,150 of ₹2,000 left today · ₹6,800 of ₹20,000 left this month");
    expect(html).toContain('data-testid="cap-summary"');
  });

  it("explains the 1.75x rule: the number keeps meaning the most daily budgets may add up to", () => {
    expect(capHelpText(100_000, "INR")).toBe("Up to ₹1,000 a day in ad budgets. Because Meta can spend 75% more on a busy day, this sets your daily ads limit to ₹1,750.");
    expect(capHelpText(114_200, "INR")).toBe("Up to ₹1,142 a day in ad budgets. Because Meta can spend 75% more on a busy day, this sets your daily ads limit to ₹1,998.50.");
    expect(capHelpText(null, "INR")).toBe("Because Meta can spend up to 75% more than a daily budget on a busy day, your daily ads limit is set to 1.75 times the amount you enter.");
  });
});
