import { expect, test } from "@playwright/test";
import { closeDb, db, watchErrors } from "./helpers";
import {
  checkPromoteQuality,
  chooseGoal,
  expectAppReadsFake,
  expectAppUsedFake,
  expectNoSpendViolations,
  expectStarted,
  fakeMark,
  ids,
  latestPromoteCampaign,
  next,
  pickLatestReel,
  promoteOwner,
  rupees,
  SOURCE_READS,
  t,
  tapStart,
  toReview,
  waitForCampaignStatus,
} from "./promote-helpers";
import { seedSpendControl } from "./spend-kit";

/**
 * 9.4 promote-boost: latest reel → WhatsApp chats → 5 days → the review shows ₹2,625 and the month split → Start → "Meta is
 * reviewing". Pause works while spending is stopped. Desktop Chrome and Pixel 7 (@mobile). The app runs against the fake Meta
 * server with SPEND_DRY_RUN=1 (e2e/promote-helpers.ts refuses to load otherwise).
 */

test.afterAll(closeDb);
test.setTimeout(240_000);
test.use({ actionTimeout: 30_000, navigationTimeout: 60_000 });

/** The calendar month of a time, in the ad account's zone. */
const monthIn = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit" }).format(d);

test.describe("Boost a post @mobile", () => {
  test("latest reel, WhatsApp chats, 5 days: ₹2,625 with the month split, Start, then Pause while spending is stopped", async ({ page, context }, testInfo) => {
    const errors = watchErrors(page);
    const mark = await fakeMark();
    const seed = await promoteOwner(context, "prm-boost");

    await page.goto("/app/ads/boost?days=5");
    await expect(page.getByTestId(ids.shell)).toBeVisible();
    await expect(page.getByTestId(ids.stepCount)).toContainText("1");
    await pickLatestReel(page);
    // The post picker is read by the server: it must have come from the fake, never from Meta.
    await expectAppUsedFake(mark, { match: SOURCE_READS });
    await expectAppReadsFake(page.request, mark);
    await checkPromoteQuality(page, testInfo, "boost-post");

    await next(page);
    await chooseGoal(page, "whatsapp_chats");
    await checkPromoteQuality(page, testInfo, "boost-goal");
    const review = await toReview(page);

    // 5 days at the ₹300 default: at most ₹300 x 5 x 1.75 = ₹2,625, and the split by month when the run crosses one.
    await expect(review).toContainText(/Boost your .+ for 5 days\?/);
    await expect(page.getByTestId(ids.worstCase)).toContainText(rupees(2625));
    const lastDay = new Date(Date.now() + 4 * 86_400_000);
    if (monthIn(lastDay) !== monthIn(new Date())) await expect(page.getByTestId(ids.worstCaseMonths)).toBeVisible();
    else await expect(page.getByTestId(ids.worstCaseMonths)).toHaveCount(0);
    await expect(page.getByTestId(ids.primary)).toHaveText(t("card.boost.start", { amount: rupees(2625) }));
    await checkPromoteQuality(page, testInfo, "boost-review");

    await tapStart(page);
    await expectStarted(page);
    await expect(page.getByTestId(ids.reviewState)).toContainText(/Meta is reviewing/);
    const campaignId = await waitForCampaignStatus(seed.owner.tenantId, "active");
    const started = await latestPromoteCampaign(seed.owner.tenantId);
    expect(started?.goal).toBe("whatsapp_chats");
    expect(started?.runDays).toBe(5);
    await checkPromoteQuality(page, testInfo, "boost-started");

    // Spending stopped for the workspace: a pause is a lowering and still goes through (I2).
    await seedSpendControl(seed.owner.tenantId, { freeze: "all", frozenByKind: "owner", frozenByUserId: seed.owner.userId, frozenReason: "e2e: owner stopped spending" });
    await page.goto(`/app/ads/${campaignId}`);
    // Pause stays available while spending is stopped (starting and raising are what the stop refuses).
    await expect(page.getByTestId("edit-pause")).toBeEnabled();
    await page.getByTestId("edit-pause").click();
    await expect(page.getByTestId("edits-status")).not.toBeEmpty();
    await expect.poll(async () => (await (await db()).query(`select status from "AdCampaign" where id = $1`, [campaignId])).rows[0]?.status).toBe("paused");
    await checkPromoteQuality(page, testInfo, "boost-paused");

    await expectNoSpendViolations();
    expect(errors, errors.join("\n")).toEqual([]);
  });
});
