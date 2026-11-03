import { expect, test, type APIRequestContext } from "@playwright/test";
import { closeDb, watchErrors } from "./helpers";
import {
  api,
  checkPromoteQuality,
  eddyReady,
  eddySlot,
  eddyV2,
  expectAppReadsFake,
  expectNoSpendViolations,
  expectStarted,
  FAKE_LATEST_REEL,
  fakeMark,
  ids,
  memberOf,
  openEddy,
  pinDraftId,
  promoteOwner,
  rupees,
  t,
  tapStart,
  tellEddy,
  toReview,
  tPattern,
  waitForCampaignStatus,
} from "./promote-helpers";
import { setAllowance } from "./spend-kit";

/**
 * 9.4 promote-limits: over the daily limit → Phase 0's copy → [Lower to ₹X a day] → Start succeeds. Typed confirmation above
 * the threshold. Through Eddy, a non-approver admin gets the hand-over. Desktop Chrome and Pixel 7 (@mobile).
 */

test.afterAll(closeDb);
test.setTimeout(240_000);
test.use({ actionTimeout: 30_000, navigationTimeout: 60_000 });

/** A boost draft made through the API (POST /api/promote/drafts), as the signed-in owner of `request`. */
async function boostDraft(request: APIRequestContext, days: number, dailyMinor: number): Promise<string> {
  const res = await api<{ campaignId: string }>(request, "POST", "/api/promote/drafts", {
    goal: "whatsapp_chats",
    days,
    source: { kind: "ig_media", ref: FAKE_LATEST_REEL, postKind: "reel" },
    dailyMinor,
    categoryAnswer: "none",
    lang: "en",
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.campaignId;
}

/** Days left in this month in Asia/Kolkata, today included. */
function daysLeftInMonth(now = new Date()): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "numeric", day: "numeric" }).formatToParts(now).map((p) => [p.type, p.value]));
  const last = new Date(Date.UTC(Number(parts.year), Number(parts.month), 0)).getUTCDate();
  return last - Number(parts.day) + 1;
}

test.describe("Spending limits on Start @mobile", () => {
  test("over the daily limit: Phase 0's words, [Lower to ₹200 a day], then Start goes through", async ({ page, context }, testInfo) => {
    const errors = watchErrors(page);
    // The most the daily budgets may add up to: ₹200. The draft asks ₹300 a day.
    const mark = await fakeMark();
    const seed = await promoteOwner(context, "prm-limits", { maxDailyBudgetMinor: 20_000 });
    await expectAppReadsFake(page.request, mark);
    const draft = await boostDraft(page.request, 2, 30_000);

    await page.goto(`/app/ads/boost?draft=${draft}&step=review`);
    await toReview(page);
    await tapStart(page);
    const state = page.getByTestId(ids.reviewState);
    await expect(state).toContainText("This would go over your ads limit for today.");
    const lower = page.getByTestId(ids.fixChips).getByText(tPattern("fix.lower_daily")).first();
    await expect(lower).toBeVisible();
    await expect(lower).toHaveText(t("fix.lower_daily", { amount: rupees(200) }));
    await checkPromoteQuality(page, testInfo, "limits-over-daily");

    await lower.click();
    // The card is computed again for ₹200 a day: 2 days, at most ₹700.
    await expect(page.getByTestId(ids.primary)).toHaveText(t("card.boost.start", { amount: rupees(700) }));
    await tapStart(page);
    await expectStarted(page);
    await waitForCampaignStatus(seed.owner.tenantId, "active");
    await expectNoSpendViolations();
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("at half or more of what is left this month, Start asks to type the amount", async ({ page, context }, testInfo) => {
    const errors = watchErrors(page);
    const mark = await fakeMark();
    const seed = await promoteOwner(context, "prm-typed");
    await expectAppReadsFake(page.request, mark);
    // ₹300 a day for 2 days: at most ₹525 a day. The monthly limit is set so this month's part is 60% of what is left.
    const inMonth = Math.min(2, daysLeftInMonth()) * 52_500;
    const monthly = Math.ceil(inMonth / 0.6 / 100) * 100;
    await setAllowance(seed.owner.tenantId, "ads", { dailyMinor: monthly, monthlyMinor: monthly });
    const draft = await boostDraft(page.request, 2, 30_000);

    await page.goto(`/app/ads/boost?draft=${draft}&step=review`);
    await toReview(page);
    const typed = page.getByTestId(ids.typedConfirm);
    if (!(await typed.isVisible().catch(() => false))) await tapStart(page);
    await expect(typed).toBeVisible();
    await expect(typed).toContainText(t("card.typed_confirm", { amount: rupees(1050) }));
    await checkPromoteQuality(page, testInfo, "limits-typed");

    // A wrong figure keeps Start off and says what to type; the exact one starts.
    const box = typed.getByRole("textbox");
    await box.fill("1000");
    await box.blur();
    await expect(typed.getByRole("alert")).toHaveText(t("review.typed_wrong", { amount: rupees(1050) }));
    await expect(page.getByTestId(ids.primary)).toHaveAttribute("aria-disabled", "true");
    await box.fill("1050");
    await tapStart(page);
    await expectStarted(page);
    await waitForCampaignStatus(seed.owner.tenantId, "active");
    await expectNoSpendViolations();
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("through Eddy, an admin who is not an approver gets the hand-over, not a Start button", async ({ page, context, browser }, testInfo) => {
    test.skip(!eddyV2(), "start_promotion is a v2 Eddy action: run with EDDY_PHASE=2 once Eddy train E5 is live (docs/IG-PAGE-ADS-SPEC.md 9.7 P5).");
    const mark = await fakeMark();
    const seed = await promoteOwner(context, "prm-limits-eddy");
    test.skip(!(await eddyReady(context)), "Eddy is not ready on this server: start it with EDDY_ENABLED=true, an AI key and EDDY_FAKE_MODEL=scripted.");
    await expectAppReadsFake(page.request, mark);
    await boostDraft(page.request, 5, 30_000);
    const slot = eddySlot("limits", "admin", testInfo.project.name);
    await pinDraftId(seed.owner.tenantId, slot);

    const admin = await memberOf(browser, seed.owner, "admin", "limits-admin");
    await eddyReady(admin.context, false);
    await admin.page.goto("/app/ads");
    await openEddy(admin.page);
    const panel = await tellEddy(admin.page, `e2e-prm start ${slot}`);
    const card = panel.locator("[data-eddy-card]").last();
    await expect(card).toBeVisible();
    await expect(card).toContainText(/can confirm spending that Eddy prepares/);
    await expect(card.getByRole("button", { name: /^Start/ })).toHaveCount(0);
    await checkPromoteQuality(admin.page, testInfo, "limits-eddy-handover");
    await admin.context.close();
  });
});
