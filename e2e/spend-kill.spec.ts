/**
 * The kill switch in the browser (docs/SPEND-CONTROLS-SPEC.md 4.11, 8.1, 2.3.7, 2.3.13, 10.4; WP-17): an admin stops all
 * spending and the running ad is paused (dry-run Meta, so nothing leaves the machine); the banner and the page say automatic
 * messages are on hold while a reply the team types still goes out; only the owner turns spending back on, and nothing
 * restarts by itself: the campaign is listed for a guarded [Resume]. Axe, the dark theme and (Pixel 7, @mobile) no
 * horizontal scroll.
 *
 * Runs with SPEND_DRY_RUN=1 on the app under test.
 */
import { expect, test, type Page } from "@playwright/test";
import { ORIGIN, closeDb, connectFakeNumber, db, deliverInbound, signupUser, stamp, tick, watchErrors } from "./helpers";
import { agentContext, axeSerious, dismissWelcome, goDark, noHorizontalOverflow } from "./audience-campaigns-util";
import { connectSpendingAdAccount, ledgerRows, liftNewWorkspaceLimits, resetSpend, setAllowance, spendDryRun, storedFreeze } from "./spend-kit";

test.afterAll(closeDb);
test.beforeEach(() => {
  test.setTimeout(240_000);
});
test.skip(!spendDryRun(), "Spend specs need SPEND_DRY_RUN=1 on the app under test.");

async function open(page: Page) {
  await page.goto("/app/settings/spending");
  await dismissWelcome(page);
  await expect(page.getByRole("heading", { level: 1, name: "Spending limits" })).toBeVisible();
}

test("an admin stops all spending; only the owner turns it back on, and nothing restarts by itself @mobile", async ({ context, browser, page }) => {
  const errors = watchErrors(page);
  const owner = await signupUser(context, "spendkill");
  await resetSpend(owner.tenantId);
  const ads = await connectSpendingAdAccount(owner.tenantId, { userId: owner.userId });
  await liftNewWorkspaceLimits(owner.tenantId);
  await setAllowance(owner.tenantId, "ads", { currency: "INR", dailyMinor: 500_000n, monthlyMinor: 5_000_000n });
  const d = await db();
  const campaignId = `camp_kill_${stamp()}`;
  await d.query(
    `INSERT INTO "AdCampaign" (id, "tenantId", "adAccountAssetId", "metaCampaignId", name, template, objective, status, "dailyBudgetMinor", currency, "updatedAt") VALUES ($1,$2,$3,$4,'Diwali leads','traffic','OUTCOME_TRAFFIC','active',100000,'INR',now())`,
    [campaignId, owner.tenantId, ads.assetId, `m_${campaignId}`],
  );
  const fx = await connectFakeNumber(owner.tenantId);
  await deliverInbound(page.request, fx, `9198${stamp().slice(-8)}`, "Is the Diwali offer still on?");
  // Inbound webhooks are queued; the tick processes them (no worker daemon runs under e2e).
  await tick(page.request, 2);

  // The admin stops all spending.
  const admin = await agentContext(browser, owner.tenantId, "admin");
  await open(admin.page);
  await admin.page.getByRole("button", { name: "Stop all spending" }).click();
  const dialog = admin.page.getByRole("alertdialog").or(admin.page.getByRole("dialog"));
  await expect(dialog.getByText("We'll pause every ad Edwyz started and hold automatic WhatsApp messages and AI replies. Messages your team types still go out. Only the owner can turn spending back on.")).toBeVisible();
  await dialog.getByRole("button", { name: "Stop all spending" }).click();
  await expect(admin.page.getByTestId("spend-status")).toContainText("All spending is stopped since");
  await expect(admin.page.getByTestId("spend-status")).toContainText("Ads are paused and automatic messages are on hold.");
  expect((await storedFreeze(owner.tenantId)).workspace).toBe("all");
  await expect.poll(async () => (await d.query(`SELECT status FROM "AdCampaign" WHERE id = $1`, [campaignId])).rows[0].status, { timeout: 30_000 }).toBe("paused");
  expect((await ledgerRows(owner.tenantId, "kill.workspace")).map((r) => r.phase)).toEqual(["requested", "applied"]);

  // The admin cannot turn it back on, in the page or through the API.
  await expect(admin.page.getByRole("button", { name: "Turn spending back on" })).toHaveCount(0);
  await expect(admin.page.getByText("Only the owner can turn spending back on.").first()).toBeVisible();
  const refused = await admin.context.request.put("/api/spend/freeze", { headers: { origin: ORIGIN }, data: { level: "none" } });
  expect(refused.status()).toBe(403);
  expect((await storedFreeze(owner.tenantId)).workspace).toBe("all");
  await admin.context.close();

  // Every page shows the stop in the banner.
  await page.goto("/app");
  await dismissWelcome(page);
  await expect(page.getByTestId("spend-banner").first()).toContainText("All spending is stopped. Ads are paused and automatic messages are on hold.");

  // A reply the team types still goes out (2.3.7): it is queued, never held by the stop.
  const conv = (await d.query(`SELECT id FROM "Conversation" WHERE "tenantId" = $1 ORDER BY "createdAt" DESC LIMIT 1`, [owner.tenantId])).rows[0];
  const reply = await page.request.post(`/api/inbox/conversations/${conv.id}/messages`, { headers: { origin: ORIGIN }, data: { type: "text", body: "Yes, it is." } });
  expect(reply.status()).toBe(201);
  const sent = (await d.query(`SELECT origin, status FROM "Message" WHERE "conversationId" = $1 AND direction = 'outbound' ORDER BY "createdAt" DESC LIMIT 1`, [conv.id])).rows[0];
  expect(sent.origin).toBe("human");
  expect(sent.status).not.toBe("held");

  // The owner turns spending back on; the paused campaign stays paused and is listed for a guarded Resume.
  await open(page);
  await page.getByRole("button", { name: "Turn spending back on" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Turn spending back on" }).click();
  await expect(page.getByTestId("spend-status")).toHaveText("Spending is on");
  expect((await storedFreeze(owner.tenantId)).workspace).toBe("none");
  expect((await d.query(`SELECT status FROM "AdCampaign" WHERE id = $1`, [campaignId])).rows[0].status).toBe("paused");
  await expect(page.getByRole("heading", { name: "Paused by the stop" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Resume Diwali leads" })).toBeVisible();

  expect(await axeSerious(page, "spending page after a stop"), "axe").toEqual([]);
  await goDark(page);
  expect(await axeSerious(page, "spending page after a stop, dark"), "axe dark").toEqual([]);
  await noHorizontalOverflow(page, "spending page after a stop");
  expect(errors, errors.join("\n")).toEqual([]);
});
