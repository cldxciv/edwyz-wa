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
  DRAFT_NEW_CHOICES,
  DRAFT_ON_META,
  draftBlockedText,
  draftEditProblem,
  draftNotesText,
  friendlyAdsError,
  isMetaLoginProblem,
  isNotFoundError,
  META_LOGIN_FIX,
  MESSENGER_PLACEMENT_NOTE,
  isCategoryTermsMismatch,
  minorToText,
  parseCountries,
  pictureCovered,
  pictureLinkError,
  pictureReady,
  PLACEMENTS as WIZARD_PLACEMENTS,
  toMinor,
  typedTotalMatches,
  UNKNOWN_PLACEMENT_NOTE,
  wizardPlacements,
} from "@/components/ads/helpers";
import { emptyTargeting, MESSENGER_CHANGED, validateTargeting } from "@/lib/ads/targeting";
import { PLACEMENTS as CATALOG_PLACEMENTS } from "@/lib/promote/catalog/placements";
import { compactNumber, deltaView, fatigueReasons, futureRangeProblem, latestDay, nearestIndex, pacingView, qualityLabel } from "@/components/ads/insights/insight-helpers";
import { BudgetSummary, CategoryGuidance, Stepper, TermsAckBox } from "@/components/ads/wizard-parts";
import { DailyChart } from "@/components/ads/insights/DailyChart";
import { monthEndInput, wizardWorstCase, worstCaseLines, WorstCaseNote } from "@/components/ads/CampaignWizard";
import { CampaignsView, CapSummary, PromoteArea, capHelpText, capSummaryLines } from "@/components/ads/CampaignsView";
import { readFileSync } from "node:fs";
import { budgetChangeKind, draftToForm, endChangeKind, endProblem, toDateTimeLocal } from "@/components/ads/campaign-edit";
import {
  addCity,
  addInterest,
  adPictures,
  audienceText,
  CITY_RADII,
  cityLabel,
  cityRadiusKm,
  creativePictureText,
  DEFAULT_RADIUS_KM,
  MAX_CITY_RADIUS_KM,
  MAX_PICKED,
  MIN_CITY_RADIUS_KM,
  pickerPath,
  pictureFileProblem,
  postLabel,
  SPECIAL_MIN_RADIUS_KM,
} from "@/components/ads/picker-helpers";
import { accountLabel, chartMetrics, insightsQuery, splitByCurrency } from "@/components/ads/insights/account-filter";
import { CityPicker, InterestPicker, LeadFormPicker, PicturePicker, PostPicker } from "@/components/ads/pickers-ui";
import { feedbackReasons, readAdReview, reviewChanged, reviewFromMeta, reviewView } from "@/lib/ads/review";

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

describe("the old wizard's placement choices (docs/IG-PAGE-ADS-SPEC.md 4.5, D10)", () => {
  const simpleValid = CATALOG_PLACEMENTS.filter((p) => p.tier === "simple" && p.state !== "hidden").map((p) => p.key);

  it("offers exactly the valid simple keys, and never messenger_inbox", () => {
    const keys = WIZARD_PLACEMENTS.map((p) => p.key);
    expect([...keys].sort()).toEqual([...simpleValid].sort());
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).not.toContain("messenger_inbox");
  });

  it("every choice has a plain label and passes validation, Facebook stories only with a feed or Instagram stories (4.5)", () => {
    const check = (placements: string[]) => validateTargeting({ ...emptyTargeting(), geo: { countries: ["IN"], cities: [] }, placements: placements as never }, "none");
    for (const p of WIZARD_PLACEMENTS) {
      expect(p.label).toMatch(/^(Facebook|Instagram) (feed|stories|reels)$/);
      expect(check([p.key, "facebook_feed"]).ok, p.key).toBe(true);
      if (p.key !== "facebook_stories") expect(check([p.key]).ok, p.key).toBe(true);
    }
    expect(check(["facebook_stories"]).errors).toEqual(["Facebook Stories needs Facebook Feed or Instagram Stories too."]);
    expect(check(["facebook_stories", "instagram_stories"]).ok).toBe(true);
    // Every combination of the six choices that Meta takes passes; the only refused ones are Facebook stories without its companion.
    for (let mask = 1; mask < 1 << WIZARD_PLACEMENTS.length; mask++) {
      const keys = WIZARD_PLACEMENTS.filter((_, i) => mask & (1 << i)).map((p) => p.key);
      const lonelyStory = keys.includes("facebook_stories") && !keys.includes("facebook_feed") && !keys.includes("instagram_stories");
      expect(check(keys).ok, keys.join(",")).toBe(!lonelyStory);
    }
  });

  it("a stored messenger_inbox reopens without it, with a note the member sees (no box to untick)", () => {
    expect(MESSENGER_PLACEMENT_NOTE).toBe(MESSENGER_CHANGED);
    expect(wizardPlacements(["facebook_feed", "messenger_inbox"])).toEqual({ placements: ["facebook_feed"], notes: [MESSENGER_PLACEMENT_NOTE] });
    expect(wizardPlacements(["messenger_inbox"])).toEqual({ placements: [], notes: [MESSENGER_PLACEMENT_NOTE] });
    // A key Meta no longer has is dropped with its own note; valid keys pass through (draftEditProblem judges them).
    expect(wizardPlacements(["facebook_video_feeds", "instagram_feed", "instagram_feed", 7])).toEqual({ placements: ["instagram_feed"], notes: [UNKNOWN_PLACEMENT_NOTE] });
    expect(wizardPlacements(undefined)).toEqual({ placements: [], notes: [] });
    expect(draftNotesText([MESSENGER_PLACEMENT_NOTE])).toBe(`${MESSENGER_PLACEMENT_NOTE}. Change it in step 3, Who should see it, under More targeting options.`);
    expect(draftNotesText([UNKNOWN_PLACEMENT_NOTE])).not.toContain("..");
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

  it("tells a missing record (404) apart from a failed request, so the page offers a way back instead of Try again", () => {
    expect(isNotFoundError("Campaign not found.")).toBe(true);
    expect(isNotFoundError("Brief not found.")).toBe(true);
    expect(isNotFoundError("  Campaign not found  ")).toBe(true);
    expect(isNotFoundError("We could not reach the server.")).toBe(false);
    expect(isNotFoundError("Something went wrong.")).toBe(false);
    expect(isNotFoundError("")).toBe(false);
    expect(isNotFoundError(null)).toBe(false);
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

  it("keeps a custom range from ending after today, on the later of the UTC and the browser's own today", () => {
    expect(latestDay("2026-10-30", "2026-10-31")).toBe("2026-10-31");
    expect(latestDay("2026-10-30", "2026-10-29")).toBe("2026-10-30");
    expect(futureRangeProblem("2026-12-31", "2026-10-30")).toMatch(/on or before today/);
    expect(futureRangeProblem("2026-10-30", "2026-10-30")).toBeNull();
    expect(futureRangeProblem("2026-10-01", "2026-10-30")).toBeNull();
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

describe("the Promote tiles on /app/ads (docs/IG-PAGE-ADS-SPEC.md 7.1, D5)", () => {
  const campaigns = [
    { id: "1", name: "Diwali boost", template: "boost_post", status: "active", currency: "INR", totalDailyBudgetMinor: 30_000, surface: "promote" },
    { id: "2", name: "Chats", template: "click_to_whatsapp", status: "draft", currency: "INR", totalDailyBudgetMinor: 30_000, surface: "promote" },
    { id: "3", name: "Old wizard one", template: "traffic", status: "active", currency: "INR", totalDailyBudgetMinor: 30_000, surface: "wizard" },
  ];
  const area = (access: Parameters<typeof PromoteArea>[0]["access"]) => renderToStaticMarkup(createElement(PromoteArea, { access, campaigns }));

  it("render only when promoteAccess makes the feature visible", () => {
    // GET /api/promote/access answers 404 while the feature is hidden, which leaves the access null.
    expect(area(null)).toBe("");
    expect(area(undefined)).toBe("");
    expect(area({ visible: false })).toBe("");
    const shown = area({ visible: true, canWrite: true });
    expect(shown).toContain('data-testid="promote-tiles"');
    expect(shown).toContain('data-testid="promote-running-1"');
    // Old-wizard campaigns stay in the table only.
    expect(shown).not.toContain("Old wizard one");
    // The page as first rendered (the member's access not loaded yet) shows no tiles and keeps the CapPanel.
    const page = renderToStaticMarkup(createElement(CampaignsView));
    expect(page).not.toContain('data-testid="promote-tiles"');
    expect(page).toContain('data-testid="cap-status"');
  });

  it("'All settings (advanced)' links to the old wizard at /app/ads/new", () => {
    const tile = area({ visible: true }).match(/<a\b[^>]*data-testid="promote-tile-advanced"[^>]*>([\s\S]*?)<\/a>/);
    expect(tile?.[0]).toContain('href="/app/ads/new"');
    expect(tile?.[1]).toContain("All settings (advanced)");
  });

  it("names nothing e2e/growth-ads.spec.ts looks for, so its locators find exactly what they did before", () => {
    const out = area({ visible: true, canWrite: true });
    const text = out.replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/&#x27;/g, "'");
    const labels = [...out.matchAll(/aria-label="([^"]*)"/g)].map((m) => m[1]);
    // Playwright matches a name or a text as a case-insensitive substring by default.
    const SPEC = /new campaign|create a campaign|connect ad account|all spending limits|save limit|try again|no campaigns yet|no limit set yet|daily limit|only an owner can change the limit|back to ad campaigns|campaign not found/i;
    for (const s of [text, ...labels]) expect(s).not.toMatch(SPEC);
    expect(out).not.toMatch(/<h1\b/);
    // The tiles sit above the CapPanel, whose words and cap-status region are unchanged.
    const source = readFileSync("src/components/ads/CampaignsView.tsx", "utf8");
    expect(source.indexOf("<PromoteArea")).toBeGreaterThan(-1);
    expect(source.indexOf("<PromoteArea")).toBeLessThan(source.indexOf("<CapPanel role"));
  });
});

describe("changing a campaign on Meta", () => {
  it("tells raises and cuts, later and earlier ends, apart", () => {
    expect(budgetChangeKind(50000, 70000)).toBe("raise");
    expect(budgetChangeKind(50000, 30000)).toBe("cut");
    expect(budgetChangeKind(50000, 50000)).toBe("same");
    const end = new Date("2026-11-10T10:00:00Z");
    expect(endChangeKind(end, new Date("2026-11-20T10:00:00Z"))).toBe("later");
    expect(endChangeKind(end, new Date("2026-11-05T10:00:00Z"))).toBe("earlier");
    expect(endChangeKind(null, new Date("2026-11-05T10:00:00Z"))).toBe("earlier");
    expect(endChangeKind(end, new Date(end))).toBe("same");
  });

  it("checks the new end date like the server does", () => {
    const now = new Date("2026-10-30T10:00:00Z");
    expect(endProblem("", now, null)).toMatch(/Choose the new end/);
    expect(endProblem("not a date", now, null)).toMatch(/date and time/);
    expect(endProblem("2026-10-30T10:30:00Z", now, null)).toMatch(/an hour from now/);
    expect(endProblem("2026-11-01T10:00:00Z", now, new Date("2026-11-02T00:00:00Z"))).toMatch(/after the start/);
    expect(endProblem("2026-11-03T10:00:00Z", now, null)).toBeNull();
  });

  it("writes a date for a datetime-local field in local time", () => {
    const d = new Date(2026, 9, 5, 7, 3);
    expect(toDateTimeLocal(d)).toBe("2026-10-05T07:03");
  });

  it("rebuilds the wizard answers from a saved draft, and refuses anything already on Meta", () => {
    const campaign = {
      id: "c1",
      name: "Diwali",
      template: "traffic",
      status: "draft",
      adAccountAssetId: "acc1",
      currency: "INR",
      dailyBudgetMinor: 50000,
      startsAt: null,
      endsAt: "2026-11-30T18:29:00.000Z",
      specialAdCategory: "none",
      editable: true,
      adSets: [
        {
          targeting: { geo: { countries: [], cities: [{ key: "1035921", name: "Pune", radiusKm: 25 }] }, ageMin: 25, ageMax: 45, genders: ["female"], interests: [{ id: "6003", name: "Yoga" }], placements: ["instagram_feed"] },
          dailyBudgetMinor: 50000,
          ads: [{ creativeAssetId: null, creative: { pageId: "p1", instagramId: "ig1", message: "Hello", headline: "Hi", link: "https://e.com", imageUrl: "https://wa.edwyz.com/api/content/media-public/t1/k.jpg?exp=1", mediaKey: "k.jpg" } }],
        },
      ],
    };
    const form = draftToForm(campaign)!;
    expect(form).toMatchObject({ template: "traffic", name: "Diwali", accountId: "acc1", budgetMinor: 50000, noEnd: false, category: "none", ageMin: "25", ageMax: "45", gender: "female", pageId: "p1", instagramId: "ig1", message: "Hello", mediaKey: "k.jpg", imageUrl: "" });
    expect(form.cities).toEqual([{ key: "1035921", name: "Pune", radiusKm: 25 }]);
    expect(form.interests).toEqual([{ id: "6003", name: "Yoga" }]);
    expect(form.placements).toEqual(["instagram_feed"]);
    expect(form.endsAt).toBe(toDateTimeLocal(new Date("2026-11-30T18:29:00.000Z")));
    expect(draftToForm({ ...campaign, status: "paused" })).toBeNull();
    expect(draftToForm({ ...campaign, editable: false })).toBeNull();
    const ab = draftToForm({ ...campaign, adSets: [{ ...campaign.adSets[0], ads: [{ creativeAssetId: "a", creative: { message: "" } }, { creativeAssetId: "b", creative: { message: "" } }] }] })!;
    expect(ab.creativeIds).toEqual(["a", "b"]);
    expect(ab.message).toBe("");
    expect(form.notes).toEqual([]);
  });

  describe("drafts the old wizard can't edit without losing or widening them", () => {
    const draft = (targeting: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
      id: "c1",
      name: "Shop",
      template: "click_to_whatsapp",
      status: "draft",
      adAccountAssetId: "acc1",
      currency: "INR",
      dailyBudgetMinor: 50000,
      startsAt: null,
      endsAt: null,
      specialAdCategory: "none",
      editable: true,
      adSets: [{ targeting: { geo: { countries: ["IN"], cities: [] }, ageMin: 18, ageMax: 65, genders: [], interests: [], placements: [], lookalikeAudienceIds: [], ...targeting }, dailyBudgetMinor: 50000, ads: [{ creativeAssetId: null, creative: { pageId: "p1", message: "Hi" } }] }],
      ...over,
    });

    it("a draft aimed only at a pin is not reopened (it would be saved as all of India)", () => {
      const pinOnly = draft({ geo: { countries: [], cities: [], customLocations: [{ lat: 19.07, lng: 72.87, radiusKm: 2, label: "Shop" }] } });
      expect(draftToForm(pinOnly)).toBeNull();
      expect(draftBlockedText(pinOnly)).toBe(DRAFT_NEW_CHOICES);
    });

    it.each([
      ["postal codes", { geo: { countries: ["IN"], cities: [], zips: [{ key: "IN:110001" }] } }],
      ["audiences to include", { customAudienceIds: ["aud_1"] }],
      ["audiences to leave out", { excludedAudienceIds: ["aud_2"] }],
      ["lookalikes", { lookalikeAudienceIds: ["aud_3"] }],
      ["Let Meta find people", { advantageAudience: true }],
      ["a place the wizard doesn't offer", { placements: ["facebook_feed", "audience_network"] }],
    ])("a draft with %s is not reopened", (_, targeting) => {
      expect(draftToForm(draft(targeting))).toBeNull();
      expect(draftEditProblem({ template: "traffic", targeting: draft(targeting).adSets[0].targeting })).toBe(DRAFT_NEW_CHOICES);
    });

    it("a draft with a newer goal is not reopened (no goal box would be ticked)", () => {
      for (const template of ["awareness", "website_sales", "multi_destination"]) {
        expect(draftToForm(draft({}, { template })), template).toBeNull();
        expect(draftBlockedText(draft({}, { template }))).toBe(DRAFT_NEW_CHOICES);
      }
    });

    it("a stored messenger_inbox reopens without it and with the note", () => {
      const form = draftToForm(draft({ placements: ["facebook_feed", "messenger_inbox"] }))!;
      expect(form.placements).toEqual(["facebook_feed"]);
      expect(form.notes).toEqual([MESSENGER_PLACEMENT_NOTE]);
    });

    it("plain drafts still reopen, and the on-Meta copy is kept for campaigns already on Meta", () => {
      expect(draftToForm(draft({ placements: ["facebook_feed", "instagram_stories"], genders: ["female"] }))).toMatchObject({ template: "click_to_whatsapp", countries: "IN", placements: ["facebook_feed", "instagram_stories"], notes: [] });
      expect(draftEditProblem({ template: "boost_post", targeting: null })).toBeNull();
      expect(draftBlockedText(draft({}, { status: "paused" }))).toBe(DRAFT_ON_META);
      expect(draftBlockedText(draft({ advantageAudience: true }, { editable: false }))).toBe(DRAFT_ON_META);
      for (const text of [DRAFT_ON_META, DRAFT_NEW_CHOICES]) expect(text).toMatch(/^[A-Z].*\.$/);
    });

    it("the wizard shows why a draft can't open, and the notes of one that did", () => {
      const source = readFileSync("src/components/ads/CampaignWizard.tsx", "utf8");
      for (const part of ["setDraftProblem(draftBlockedText(campaign))", "setDraftNotes(form.notes)", "draftNotesText(draftNotes)"]) expect(source).toContain(part);
    });
  });

  it("the campaign page offers the budget, end date, draft edit and client approval", () => {
    const source = readFileSync("src/components/ads/CampaignDetail.tsx", "utf8");
    for (const label of ["Change budget", "Change end date", "Edit draft", "/app/ads/new?draft=", "ApprovalsPanel", 'subjectType="ad_campaign"', 'run("budget"', 'run("end"', "confirmTotalMinor"]) expect(source).toContain(label);
    expect(source).not.toContain("A draft cannot be edited here");
  });
});

describe("Meta's ad review", () => {
  const now = new Date("2026-10-30T10:00:00Z");

  it("maps Meta's status and reasons", () => {
    expect(reviewFromMeta({ effective_status: "PENDING_REVIEW" }, now)).toEqual({ state: "in_review", metaStatus: "PENDING_REVIEW", reasons: [], checkedAt: now.toISOString() });
    expect(reviewFromMeta({ effective_status: "disapproved", ad_review_feedback: { global: { A: "Too much text\u0007", B: "Too much text" }, placement_specific: { instagram: { C: "Wrong crop" } } } }, now)).toMatchObject({ state: "rejected", reasons: ["Too much text", "Wrong crop"] });
    expect(reviewFromMeta({ effective_status: "ACTIVE", ad_review_feedback: { global: { A: "ignored" } } }, now)!.reasons).toEqual([]);
    expect(reviewFromMeta({ effective_status: "WHO_KNOWS" }, now)).toBeNull();
    expect(feedbackReasons({ a: "1", b: "2", c: "3", d: "4" })).toEqual(["1", "2", "3"]);
    expect(feedbackReasons("x".repeat(400))[0]).toHaveLength(300);
  });

  it("reads the stored review and notices a real change only", () => {
    const r = reviewFromMeta({ effective_status: "DISAPPROVED", ad_review_feedback: { global: { A: "No" } } }, now)!;
    expect(readAdReview({ pageId: "p", metaReview: r })).toEqual(r);
    expect(readAdReview({ metaReview: { state: "bogus" } })).toBeNull();
    expect(readAdReview(null)).toBeNull();
    expect(reviewChanged(r, { ...r, checkedAt: "later" })).toBe(false);
    expect(reviewChanged(r, { ...r, state: "approved", metaStatus: "ACTIVE", reasons: [] })).toBe(true);
    expect(reviewChanged(null, r)).toBe(true);
  });

  it("says it in plain words, with the reason", () => {
    const rejected = reviewView({ state: "rejected", metaStatus: "DISAPPROVED", reasons: ["Ads must not imply personal attributes"], checkedAt: "" })!;
    expect(rejected).toMatchObject({ label: "Not approved", tone: "bad" });
    expect(rejected.detail).toMatch(/^Not approved: Ads must not imply personal attributes\. Change the ad/);
    expect(reviewView({ state: "in_review", metaStatus: "PENDING_REVIEW", reasons: [], checkedAt: "" })!.label).toBe("Meta is reviewing");
    expect(reviewView({ state: "paused", metaStatus: "PAUSED", reasons: [], checkedAt: "" })).toBeNull();
    expect(reviewView(null)).toBeNull();
  });
});

describe("wizard pickers", () => {
  it("builds picker requests and keeps chosen items unique and capped", () => {
    expect(pickerPath("cities", { account: "acc1", q: "Pune", country: null })).toBe("/api/ads/pickers?kind=cities&account=acc1&q=Pune");
    const one = addInterest([], { id: "1", name: "Yoga" });
    expect(addInterest(one, { id: "1", name: "Yoga" })).toBe(one);
    const full = Array.from({ length: MAX_PICKED }, (_, i) => ({ id: String(i), name: "x" }));
    expect(addInterest(full, { id: "999", name: "y" })).toHaveLength(MAX_PICKED);
    expect(addCity([], { key: "k1", name: "Pune", region: "Maharashtra", countryCode: "IN" }, 25)).toEqual([{ key: "k1", name: "Pune, Maharashtra, IN", radiusKm: 25 }]);
    expect(cityLabel({ key: "k", name: "Dubai", region: null, countryCode: "AE" })).toBe("Dubai, AE");
    expect(audienceText(1_200_000, 1_500_000)).toBe("About 1.2M to 1.5M people");
    expect(audienceText(null, null)).toBe("");
  });

  it("offers only city radii Meta takes: 17 to 80 km, and at least 15 miles for a special category", () => {
    expect(MIN_CITY_RADIUS_KM).toBe(17);
    expect(MAX_CITY_RADIUS_KM).toBe(80);
    for (const r of CITY_RADII) {
      expect(r).toBeGreaterThanOrEqual(17);
      expect(r).toBeLessThanOrEqual(80);
    }
    expect(CITY_RADII).toContain(DEFAULT_RADIUS_KM);
    // 15 miles is 24.14 km, so 24 km would be refused for housing, jobs, credit and social issues.
    expect(SPECIAL_MIN_RADIUS_KM).toBeGreaterThanOrEqual(15 * 1.609344);
    expect(CITY_RADII).toContain(SPECIAL_MIN_RADIUS_KM);
    expect(cityRadiusKm(10)).toBe(17);
    expect(cityRadiusKm(40)).toBe(40);
    expect(cityRadiusKm(120)).toBe(80);
    expect(cityRadiusKm(Number.NaN)).toBe(DEFAULT_RADIUS_KM);
    expect(cityRadiusKm(17, SPECIAL_MIN_RADIUS_KM)).toBe(25);
    expect(cityRadiusKm(40, SPECIAL_MIN_RADIUS_KM)).toBe(40);
  });

  it("the city picker shows the radius the campaign is sent with", () => {
    const html = (minRadiusKm?: number) =>
      renderToStaticMarkup(createElement(CityPicker, { accountId: "acc1", country: "IN", value: [{ key: "k1", name: "Pune", radiusKm: 10 }], onChange: () => undefined, minRadiusKm }));
    const plain = html();
    expect(plain).not.toContain(">10 km<");
    expect(plain).toMatch(/<option value="17" selected="">17 km<\/option>/);
    const special = html(SPECIAL_MIN_RADIUS_KM);
    expect(special).not.toContain(">17 km<");
    expect(special).toMatch(/<option value="25" selected="">25 km<\/option>/);
  });

  it("accepts only JPG and PNG pictures up to 8 MB, and names WebP creatives", () => {
    expect(pictureFileProblem({ type: "image/webp", size: 10 })).toMatch(/JPG or PNG/);
    expect(pictureFileProblem({ type: "image/png", size: 9 * 1024 * 1024 })).toMatch(/too large/);
    expect(pictureFileProblem({ type: "image/jpeg", size: 1000 })).toBeNull();
    expect(adPictures([{ key: "a.jpg", kind: "image" }, { key: "b.mp4", kind: "video" }, { key: "c.png" }]).map((m) => m.key)).toEqual(["a.jpg", "c.png"]);
    expect(creativePictureText({ kind: "image", hasImage: false, imageProblem: "format" })).toBe("Picture needs a JPG or PNG (add a picture below)");
    expect(creativePictureText({ kind: "image", hasImage: true })).toBe("Picture");
    expect(creativePictureText({ kind: "image", hasImage: false, imageProblem: "placeholder" })).toBe("Picture preview (add a picture below)");
    expect(creativePictureText({ kind: "copy" })).toBe("Text");
  });

  it("labels posts plainly", () => {
    expect(postLabel({ text: "Big sale", createdAt: null })).toBe("Big sale");
    expect(postLabel({ caption: "", createdAt: null })).toBe("Post without text");
    expect(postLabel({ text: "x".repeat(120) }).length).toBe(90);
  });

  it("renders the pickers with labels and no raw ids", () => {
    const html = renderToStaticMarkup;
    const interests = html(createElement(InterestPicker, { accountId: "acc1", value: [{ id: "6003", name: "Yoga" }], onChange: () => undefined }));
    expect(interests).toContain("Search interests");
    expect(interests).toContain('aria-label="Remove Yoga"');
    expect(interests).not.toContain("6003");
    expect(html(createElement(PostPicker, { pageAssetId: "", instagramAssetId: "", postId: "", instagramMediaId: "", onPick: () => undefined }))).toContain("Choose the Facebook Page above");
    expect(html(createElement(PostPicker, { pageAssetId: "pg1", instagramAssetId: "ig1", postId: "", instagramMediaId: "", onPick: () => undefined }))).toContain("Instagram");
    expect(html(createElement(LeadFormPicker, { pageAssetId: "", value: "", onChange: () => undefined }))).toContain("Choose a Page first");
    const picture = html(createElement(PicturePicker, { mediaKey: "", imageUrl: "", onMediaKey: () => undefined, onImageUrl: () => undefined, required: true }));
    expect(picture).toContain("Upload a picture");
    expect(picture).toContain('accept="image/jpeg,image/png"');
    // The file input sits behind the "Upload a picture" button: named, but out of the tab order and the accessibility tree.
    expect(picture).toMatch(/<input[^>]*type="file"[^>]*aria-label="Upload a picture"[^>]*aria-hidden="true"[^>]*tabindex="-1"/i);
    expect(picture).toContain("Choose from your media library");
    expect(html(createElement(PicturePicker, { mediaKey: "abc.jpg", imageUrl: "", onMediaKey: () => undefined, onImageUrl: () => undefined, required: true }))).toContain("/api/content/media/abc.jpg");
  });

  it("the wizard uses the pickers instead of asking for Meta ids, and edits drafts in place", () => {
    const source = readFileSync("src/components/ads/CampaignWizard.tsx", "utf8");
    for (const part of ["<PostPicker", "<LeadFormPicker", "<InterestPicker", "<CityPicker", "<PicturePicker", 'method: "PATCH"', "draftToForm"]) expect(source).toContain(part);
    expect(source).not.toContain("the interest ID from Meta");
    // Cities are sent when chosen (the old wizard always sent none).
    expect(source).not.toContain("geo: { countries: parsedCountries.codes, cities: [] }");
    expect(source).toContain('geo: where === "cities" ? { countries: [], cities: cities.map(');
    expect(source).not.toContain("/archive`, { method: \"POST\" }).catch");
    // getByLabel("Countries") must find only the Countries field, so no other label in the wizard says "countries".
    expect(source.match(/countries\s*<\/label>/gi) ?? []).toEqual([]);
    expect(source).toContain("Whole country");
    expect(source).toContain("cityRadiusKm(c.radiusKm, restricted ? SPECIAL_MIN_RADIUS_KM : undefined)");
  });
});

describe("insights by ad account", () => {
  it("adds the ad account to the query and never draws mixed currencies as one spend line", () => {
    expect(insightsQuery({ from: "2026-10-01", to: "2026-10-30" }, "")).toBe("from=2026-10-01&to=2026-10-30");
    expect(insightsQuery({ from: "2026-10-01", to: "2026-10-30" }, "acc 1")).toBe("from=2026-10-01&to=2026-10-30&adAccount=acc%201");
    expect(accountLabel({ name: "Main", currency: "INR" })).toBe("Main (INR)");
    expect(accountLabel({ name: null, currency: null })).toBe("Ad account");
    const t = { spendMinor: 1, impressions: 1, clicks: 1, results: 1, ctr: null, costPerResultMinor: null };
    expect(splitByCurrency([{ currency: "INR", current: t, previous: t }])).toBeNull();
    expect(splitByCurrency(null)).toBeNull();
    expect(splitByCurrency([{ currency: "INR", current: t, previous: t }, { currency: "USD", current: t, previous: t }])).toHaveLength(2);
    expect(chartMetrics(true).map((m) => m.key)).toEqual(["results", "clicks"]);
    expect(chartMetrics(false).map((m) => m.key)).toEqual(["spendMinor", "results", "clicks"]);
  });
});
