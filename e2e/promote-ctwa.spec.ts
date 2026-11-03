import { expect, test } from "@playwright/test";
import { closeDb, db, tick, watchErrors } from "./helpers";
import {
  checkPromoteQuality,
  chooseGoal,
  deliverReferral,
  expectAppReadsFake,
  expectNoSpendViolations,
  expectStarted,
  fakeMark,
  fakeScenario,
  ids,
  next,
  pickLatestReel,
  promoteOwner,
  readinessRow,
  setPageWhatsAppLink,
  t,
  tapStart,
  toReview,
  waitForCampaignStatus,
} from "./promote-helpers";

/**
 * 9.4 promote-ctwa: WhatsApp not linked to the Page shows the Opens Meta row → seed the link → Start. A referral webhook (a
 * message from the Click-to-WhatsApp ad) creates a Lead. Desktop Chrome and Pixel 7 (@mobile).
 *
 * The readiness row reads the link the way discovery stores it on the Page asset (`whatsappLinkState`). While the row is
 * checked, the fake Meta server's `page_whatsapp_missing` scenario also answers the Page's number as Meta does for a Page with
 * none (#100), so nothing the server reads live disagrees. Scenarios are shared by the specs running at the same time, so it
 * is on only until the row has been seen.
 */

test.afterAll(closeDb);
test.setTimeout(240_000);
test.use({ actionTimeout: 30_000, navigationTimeout: 60_000 });

test.describe("Click-to-WhatsApp ads @mobile", () => {
  test("the not-linked row opens Meta; once linked, Start; a message from the ad makes one Lead", async ({ page, context }, testInfo) => {
    const errors = watchErrors(page);
    const mark = await fakeMark();
    const seed = await promoteOwner(context, "prm-ctwa", { linkWhatsApp: false });

    await page.goto("/app/ads/boost?days=3");
    await pickLatestReel(page);
    await expectAppReadsFake(page.request, mark);
    await next(page);

    await fakeScenario("page_whatsapp_missing", true);
    try {
      await chooseGoal(page, "whatsapp_chats");
      const row = readinessRow(page, "whatsapp_page_link");
      await expect(row).toBeVisible();
      await expect(row).toHaveAttribute("data-status", "missing");
      // Linking a number to a Page has no API: the fix opens that screen in Meta, in a new tab, and says so.
      const opens = row.locator('[data-opens-meta="link_whatsapp_to_page"]');
      await expect(opens).toBeVisible();
      await expect(opens).toContainText(t("opens_meta.label"));
      await checkPromoteQuality(page, testInfo, "ctwa-not-linked");
    } finally {
      await fakeScenario("page_whatsapp_missing", false);
    }

    // The owner links the number in Meta; Edwyz sees it on the next check.
    await setPageWhatsAppLink(seed.page.id, true);
    await page.reload();
    await expect(page.getByTestId(ids.shell)).toBeVisible();
    // The row turns green, or the list folds into "all ready" once nothing is left to fix.
    await expect(readinessRow(page, "whatsapp_page_link").and(page.locator('[data-status="missing"]'))).toHaveCount(0);

    const review = await toReview(page);
    await expect(review).toContainText(t("card.fact.goal"));
    await expect(page.getByTestId(ids.welcome).or(review.getByText(/WhatsApp/)).first()).toBeVisible();
    await checkPromoteQuality(page, testInfo, "ctwa-review");
    await tapStart(page);
    await expectStarted(page);
    const campaignId = await waitForCampaignStatus(seed.owner.tenantId, "active");

    // A person taps the ad and messages the business: the referral names the ad.
    const ad = (await (await db()).query(`select a."metaAdId" from "Ad" a join "AdSet" s on s.id = a."adSetId" where s."campaignId" = $1 and a."metaAdId" is not null limit 1`, [campaignId])).rows[0] as { metaAdId: string } | undefined;
    expect(ad?.metaAdId, "the launched ad has a Meta id (a dry-run id)").toBeTruthy();
    const from = `9198${String(Date.now()).slice(-8)}`;
    await deliverReferral(page.request, { wabaId: seed.whatsapp!.wabaId, phoneNumberId: seed.whatsapp!.phoneNumberId }, from, ad!.metaAdId);
    // A second message from the same person and ad within 30 days makes no second Lead.
    await deliverReferral(page.request, { wabaId: seed.whatsapp!.wabaId, phoneNumberId: seed.whatsapp!.phoneNumberId }, from, ad!.metaAdId, "Is it still on?");
    const chatLeads = async () => {
      await tick(page.request, 1);
      return Number((await (await db()).query(`select count(*)::int as n from "Lead" where "tenantId" = $1 and source <> 'instant_form'`, [seed.owner.tenantId])).rows[0].n);
    };
    await expect.poll(chatLeads, { timeout: 60_000, message: "one chat Lead from the ad" }).toBe(1);
    const lead = (await (await db()).query(`select "leadgenId", "isTest" from "Lead" where "tenantId" = $1 and source <> 'instant_form'`, [seed.owner.tenantId])).rows[0] as { leadgenId: string; isTest: boolean };
    expect(lead.leadgenId.startsWith("ctwa:")).toBe(true);
    expect(lead.isTest).toBe(false);

    await page.goto("/app/leads");
    await expect(page.getByText("Ad Customer").first()).toBeVisible();
    await checkPromoteQuality(page, testInfo, "ctwa-lead");

    await expectNoSpendViolations();
    expect(errors, errors.join("\n")).toEqual([]);
  });
});
