import { expect, test, type APIRequestContext } from "@playwright/test";
import { closeDb, db, watchErrors } from "./helpers";
import {
  api,
  checkPromoteQuality,
  eddyReady,
  eddySlot,
  eddyV2,
  expectAppReadsFake,
  expectNoSpendViolations,
  FAKE_LATEST_REEL,
  fakeMark,
  latestPromoteCampaign,
  memberOf,
  openEddy,
  pinDraftId,
  promoteOwner,
  rupees,
  t,
  tellEddy,
  waitForCampaignStatus,
} from "./promote-helpers";

/**
 * 9.4 eddy-promote, with the scripted fake model (EDDY_FAKE_MODEL=scripted, e2e/fixtures/eddy/promote-e2e.json): "boost my last
 * reel 5 days" gives a draft, then a card; the owner confirms; an admin who is not an approver sees Ask. Desktop Chrome and
 * Pixel 7 (@mobile).
 *
 * A scripted round cannot read the id an earlier tool call returned, so the start scenarios name fixed campaign ids, one per
 * role and Playwright project (eddySlot), and the spec gives its draft that id first (pinDraftId).
 * create_promotion_draft is a v1 action and runs wherever the scripted Eddy is ready. start_promotion is v2: those tests run
 * with EDDY_PHASE=2 once Eddy train E5 is live (9.7 P5), and skip with that reason before.
 */

test.afterAll(closeDb);
test.setTimeout(240_000);
test.use({ actionTimeout: 30_000, navigationTimeout: 60_000 });

const LATEST_REEL = FAKE_LATEST_REEL;

async function boostDraft(request: APIRequestContext): Promise<string> {
  const res = await api<{ campaignId: string }>(request, "POST", "/api/promote/drafts", {
    goal: "whatsapp_chats",
    days: 5,
    source: { kind: "ig_media", ref: LATEST_REEL, postKind: "reel" },
    dailyMinor: 30_000,
    categoryAnswer: "none",
    lang: "en",
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.campaignId;
}

test.describe("Eddy boosts a post @mobile", () => {
  test("'boost my last reel 5 days' gives a draft and spends nothing", async ({ page, context }, testInfo) => {
    const errors = watchErrors(page);
    const mark = await fakeMark();
    const seed = await promoteOwner(context, "prm-eddy-draft");
    test.skip(!(await eddyReady(context)), "Eddy is not ready on this server: start it with EDDY_ENABLED=true, an AI key and EDDY_FAKE_MODEL=scripted.");
    await expectAppReadsFake(page.request, mark);
    await page.goto("/app/ads");
    await openEddy(page);
    const panel = await tellEddy(page, "e2e-prm boost my last reel 5 days");
    await expect(panel.locator('[data-eddy-item="eddy"]').last()).toContainText("saved as a draft for 5 days");
    await expect
      .poll(async () => {
        const c = await latestPromoteCampaign(seed.owner.tenantId);
        return c ? `${c.surface}:${c.status}:${c.goal}:${c.runDays}` : null;
      })
      .toBe("eddy:draft:whatsapp_chats:5");
    const source = (await (await db()).query(`select "sourceKind", "sourceRef" from "AdCampaign" where "tenantId" = $1 and surface = 'eddy' order by "createdAt" desc limit 1`, [seed.owner.tenantId])).rows[0] as { sourceKind: string; sourceRef: string | null };
    expect(source.sourceKind).toBe("ig_media");
    expect(source.sourceRef ?? "").toContain(LATEST_REEL);
    await checkPromoteQuality(page, testInfo, "eddy-draft");
    await expectNoSpendViolations();
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("the start card shows the worst case; the owner confirms and the boost starts", async ({ page, context }, testInfo) => {
    test.skip(!eddyV2(), "start_promotion is a v2 Eddy action: run with EDDY_PHASE=2 once Eddy train E5 is live (docs/IG-PAGE-ADS-SPEC.md 9.7 P5).");
    const errors = watchErrors(page);
    const mark = await fakeMark();
    const seed = await promoteOwner(context, "prm-eddy-owner");
    test.skip(!(await eddyReady(context)), "Eddy is not ready on this server: start it with EDDY_ENABLED=true, an AI key and EDDY_FAKE_MODEL=scripted.");
    await expectAppReadsFake(page.request, mark);
    await boostDraft(page.request);
    const slot = eddySlot("eddy", "owner", testInfo.project.name);
    await pinDraftId(seed.owner.tenantId, slot);

    await page.goto("/app/ads");
    await openEddy(page);
    const panel = await tellEddy(page, `e2e-prm start ${slot}`);
    const card = panel.locator("[data-eddy-card]").last();
    await expect(card).toBeVisible();
    // The card shows what Meta will show and the worst case, exactly like the page's review card (6.5).
    const start = card.getByRole("button", { name: t("card.boost.start", { amount: rupees(2625) }) });
    await expect(start).toBeVisible();
    await expect(card).toContainText(/5 days/);
    await checkPromoteQuality(page, testInfo, "eddy-card");
    await page.waitForTimeout(700); // the 600 ms tap guard
    await start.click();
    await expect(card.locator("[data-eddy-card-status]")).not.toBeEmpty();
    await waitForCampaignStatus(seed.owner.tenantId, "active");
    await expectNoSpendViolations();
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("an admin who is not an approver sees Ask instead of Start", async ({ page, context, browser }, testInfo) => {
    test.skip(!eddyV2(), "start_promotion is a v2 Eddy action: run with EDDY_PHASE=2 once Eddy train E5 is live (docs/IG-PAGE-ADS-SPEC.md 9.7 P5).");
    const mark = await fakeMark();
    const seed = await promoteOwner(context, "prm-eddy-ask");
    test.skip(!(await eddyReady(context)), "Eddy is not ready on this server: start it with EDDY_ENABLED=true, an AI key and EDDY_FAKE_MODEL=scripted.");
    await expectAppReadsFake(page.request, mark);
    await boostDraft(page.request);
    const slot = eddySlot("eddy", "admin", testInfo.project.name);
    await pinDraftId(seed.owner.tenantId, slot);

    const admin = await memberOf(browser, seed.owner, "admin", "eddy-admin");
    const errors = watchErrors(admin.page);
    await eddyReady(admin.context, false);
    await admin.page.goto("/app/ads");
    await openEddy(admin.page);
    const panel = await tellEddy(admin.page, `e2e-prm start ${slot}`);
    const card = panel.locator("[data-eddy-card]").last();
    await expect(card).toBeVisible();
    await expect(card).toContainText(/can confirm spending that Eddy prepares/);
    await expect(card.getByRole("button", { name: /^Start/ })).toHaveCount(0);
    await expect(card.getByRole("button", { name: /Ask/ }).or(card.getByRole("link", { name: /Ask/ })).first()).toBeVisible();
    await checkPromoteQuality(admin.page, testInfo, "eddy-ask");
    expect(errors, errors.join("\n")).toEqual([]);
    await admin.context.close();
  });
});
