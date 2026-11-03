import { expect, test } from "@playwright/test";
import { closeDb, db, watchErrors } from "./helpers";
import {
  checkPromoteQuality,
  chooseGoal,
  expectAppReadsFake,
  expectNoSpendViolations,
  expectStarted,
  fakeMark,
  next,
  promoteOwner,
  t,
  tapStart,
  toReview,
  uploadAdImage,
  waitForCampaignStatus,
} from "./promote-helpers";

/**
 * 9.4 promote-versions: 2 versions, a results fixture, keep the winner with Undo. Desktop Chrome and Pixel 7 (@mobile).
 *
 * The versions run as a fair test (one ad set each, an equal share of the daily total). Results come from stored rows only
 * (src/lib/promote/abtest.ts), so the spec writes 8 days of ad set rows in which version B gets chats at half the cost: past
 * the 7-day, 15-result and 20% bars, so B is the likely winner. Keeping B pauses A through recordLowering; Undo turns A back on
 * through reserveAds, which SPEND_DRY_RUN fakes before it leaves the app.
 */

test.afterAll(closeDb);
test.setTimeout(240_000);
test.use({ actionTimeout: 30_000, navigationTimeout: 60_000 });

const DAY = 86_400_000;
const dayKey = (d: Date) => d.toISOString().slice(0, 10);

test.describe("Compare versions @mobile", () => {
  test("two versions, results in, keep the winner, then Undo", async ({ page, context }, testInfo) => {
    const errors = watchErrors(page);
    const mark = await fakeMark();
    const seed = await promoteOwner(context, "prm-versions");
    await expectAppReadsFake(page.request, mark);

    await page.goto("/app/ads/create?goal=whatsapp_chats&days=10");
    await chooseGoal(page, "whatsapp_chats");
    await next(page);

    await uploadAdImage(page);
    await page.getByTestId("copy-primary").first().fill("Fresh flowers delivered today. Chat with us on WhatsApp.");
    // Version B starts as a copy of A (same picture) and becomes the one being edited.
    await page.getByTestId("ad-add-version").click();
    await expect(page.getByRole("button", { name: t("ad.version", { letter: "B" }) })).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("copy-primary").first().fill("Same-day flowers across Pune. Tap to chat and order.");
    await checkPromoteQuality(page, testInfo, "versions-ad");

    const review = await toReview(page);
    await expect(review).toContainText(t("card.fact.versions"));
    await checkPromoteQuality(page, testInfo, "versions-review");
    await tapStart(page);
    await expectStarted(page);
    const campaignId = await waitForCampaignStatus(seed.owner.tenantId, "active");

    // The results fixture: the run started 8 days ago; A gets 21 chats for ₹1,400, B 42 for ₹1,400.
    const d = await db();
    const sets = (await d.query(`select id, "metaAdSetId" from "AdSet" where "campaignId" = $1 and "metaAdSetId" is not null order by "variantKey" asc nulls last, "createdAt" asc`, [campaignId])).rows as { id: string; metaAdSetId: string }[];
    expect(sets.length, "one ad set per version").toBe(2);
    const started = new Date(Date.now() - 8 * DAY);
    await d.query(`update "AdCampaign" set "startsAt" = $2, "launchedAt" = $2 where id = $1`, [campaignId, started]);
    for (const [i, set] of sets.entries()) {
      const perDay = i === 0 ? 3 : 6;
      for (let back = 7; back >= 1; back--) {
        await d.query(
          `insert into "InsightSnapshot" (id,"tenantId","entityType","entityMetaId",date,"spendMinor",impressions,clicks,results,"messagingStarts")
           values ($1,$2,'adset',$3,$4,20000,4000,60,$5,$5) on conflict ("tenantId","entityType","entityMetaId",date) do update set results = excluded.results, "messagingStarts" = excluded."messagingStarts", "spendMinor" = excluded."spendMinor"`,
          [`is_prm_${set.id}_${back}`, seed.owner.tenantId, set.metaAdSetId, dayKey(new Date(Date.now() - back * DAY)), perDay],
        );
      }
    }

    await page.goto(`/app/ads/${campaignId}`);
    const compare = page.getByTestId("compare-verdict");
    await expect(compare).toBeVisible();
    await expect(compare).toContainText(/likely winner/i);
    await checkPromoteQuality(page, testInfo, "versions-verdict");

    await page.getByTestId("compare-keep").click();
    await expect.poll(async () => (await d.query(`select status from "AdTest" where "campaignId" = $1`, [campaignId])).rows[0]?.status).toBe("decided");
    await expect.poll(async () => (await d.query(`select status from "AdSet" where id = $1`, [sets[0].id])).rows[0]?.status).toBe("paused");

    await page.getByTestId("compare-undo").click();
    const confirmUndo = page.getByTestId("compare-undo-confirm");
    if (await confirmUndo.isVisible().catch(() => false)) await confirmUndo.click();
    await expect.poll(async () => (await d.query(`select status from "AdTest" where "campaignId" = $1`, [campaignId])).rows[0]?.status).toBe("running");
    await expect.poll(async () => (await d.query(`select status from "AdSet" where id = $1`, [sets[0].id])).rows[0]?.status).toBe("active");
    await checkPromoteQuality(page, testInfo, "versions-undone");

    await expectNoSpendViolations();
    expect(errors, errors.join("\n")).toEqual([]);
  });
});
