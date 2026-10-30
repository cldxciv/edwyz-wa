/**
 * Settings > Spending limits in the browser (docs/SPEND-CONTROLS-SPEC.md 8.1, 8.4, 10.4; WP-17): the owner sets limits and
 * sees what is left, an admin lowers and gets the owner-only copy for a raise, a team member reads and gets 403 on PUT,
 * "Not set" shows instead of an invented number, and the new-workspace note shows. Each test checks serious axe issues,
 * the dark theme, and (tagged @mobile, run on Pixel 7) no horizontal scroll.
 *
 * Runs with SPEND_DRY_RUN=1 on the app under test (no Meta write leaves the machine) and seeds through e2e/spend-kit.ts.
 */
import { expect, test, type Page } from "@playwright/test";
import { ORIGIN, closeDb, db, signupUser, watchErrors } from "./helpers";
import { agentContext, axeSerious, dismissWelcome, goDark, isDark, noHorizontalOverflow } from "./audience-campaigns-util";
import { connectSpendingAdAccount, ledgerRows, liftNewWorkspaceLimits, resetSpend, setAllowance, spendDryRun } from "./spend-kit";

test.afterAll(closeDb);
test.beforeEach(() => {
  test.setTimeout(240_000);
});
test.skip(!spendDryRun(), "Spend specs need SPEND_DRY_RUN=1 on the app under test.");

const SUBTITLE =
  "Choose the most Edwyz can spend for you each month and each day. Every ad change, automatic WhatsApp message and AI reply is checked against these limits first. Meta and WhatsApp bill you directly; Edwyz never holds your ad money.";

async function openSpending(page: Page) {
  await page.goto("/app");
  await dismissWelcome(page);
  // Reached from the navigation like a member would: the Settings group lists it for every role.
  const nav = page.getByRole("navigation").getByRole("link", { name: "Spending limits", exact: true }).first();
  if (await nav.isVisible().catch(() => false)) await nav.click();
  else await page.goto("/app/settings/spending");
  await page.waitForURL(/\/app\/settings\/spending/);
  await expect(page.getByRole("heading", { level: 1, name: "Spending limits" })).toBeVisible();
}

async function checkPage(page: Page, label: string) {
  expect(await axeSerious(page, label), `${label}: axe`).toEqual([]);
  await goDark(page);
  expect(await isDark(page)).toBe(true);
  expect(await axeSerious(page, `${label} dark`), `${label}: axe in dark`).toEqual([]);
  await noHorizontalOverflow(page, label);
}

test("the owner sets the ads limits and sees what is left; Not set shows for the other pots", async ({ page, context }) => {
  const errors = watchErrors(page);
  const owner = await signupUser(context, "spendset");
  await resetSpend(owner.tenantId);
  await connectSpendingAdAccount(owner.tenantId, { userId: owner.userId });
  await liftNewWorkspaceLimits(owner.tenantId);
  await openSpending(page);
  await expect(page.getByText(SUBTITLE)).toBeVisible();
  await expect(page.getByText("Days and months follow Asia/Kolkata time, the same as your ad account.")).toBeVisible();
  await expect(page.getByTestId("spend-status")).toHaveText("Spending is on");

  const ads = page.locator("#ads");
  await expect(ads.getByRole("heading", { name: "Ads on Facebook and Instagram" })).toBeVisible();
  await expect(ads.getByText("Not set. Ads can't start until you set a daily limit.")).toBeVisible();
  await ads.getByLabel("Monthly limit").fill("20000");
  await ads.getByLabel("Daily limit").fill("2000");
  await ads.getByRole("button", { name: "Save limits" }).click();
  await expect(page.locator("#ads").getByText("Saved. Monthly limit ₹20,000, daily limit ₹2,000.")).toBeVisible();
  await expect(page.locator("#ads")).toContainText("Left to use");
  await expect(page.locator("#ads")).toContainText("₹20,000");
  await expect(page.locator("#ads").getByText(/A ₹2,000 daily limit allows ads with up to ₹1,142 a day in total budget\./)).toBeVisible();

  // WhatsApp and AI have no owner limit yet: words, not a zero.
  await expect(page.locator("#whatsapp")).toContainText("Not set");
  const rows = await ledgerRows(owner.tenantId, "allowance.change");
  expect(rows.map((r) => r.phase)).toEqual(["requested", "applied"]);
  await checkPage(page, "owner spending page");
  expect(errors, errors.join("\n")).toEqual([]);
});

test("an admin lowers a limit; a raise gets the owner-only copy, in the page and from the API", async ({ context, browser }) => {
  const owner = await signupUser(context, "spendadm");
  await resetSpend(owner.tenantId);
  await connectSpendingAdAccount(owner.tenantId, { userId: owner.userId });
  await liftNewWorkspaceLimits(owner.tenantId);
  const { version } = await setAllowance(owner.tenantId, "ads", { currency: "INR", dailyMinor: 200_000n, monthlyMinor: 2_000_000n });
  const admin = await agentContext(browser, owner.tenantId, "admin");
  const page = admin.page;
  await openSpending(page);
  await expect(page.getByText("You can lower limits or stop spending. Only the owner can raise a limit.")).toBeVisible();
  const ads = page.locator("#ads");
  await expect(ads.getByLabel("Daily limit")).toHaveAttribute("max", "2000");
  await ads.getByLabel("Daily limit").fill("1500");
  await ads.getByRole("button", { name: "Lower limits" }).click();
  await expect(page.locator("#ads").getByText("Saved. Monthly limit ₹20,000, daily limit ₹1,500.")).toBeVisible();

  await page.locator("#ads").getByLabel("Daily limit").fill("2500");
  await page.locator("#ads").getByRole("button", { name: "Lower limits" }).click();
  await expect(page.locator("#ads").getByText(/Only the owner can raise a limit\. You can lower it\./)).toBeVisible();

  const res = await admin.context.request.put("/api/spend/allowances", { headers: { origin: ORIGIN }, data: { pot: "ads", dailyLimitMinor: "250000", version: version + 1 } });
  expect(res.status()).toBe(403);
  expect((await res.json()).error).toBe("Only the owner can raise a limit. You can lower it.");
  const d = await db();
  expect((await d.query(`SELECT "dailyLimitMinor"::text AS v FROM "SpendAllowance" WHERE "tenantId" = $1 AND pot = 'ads'`, [owner.tenantId])).rows[0].v).toBe("150000");
  await checkPage(page, "admin spending page");
  await admin.context.close();
});

test("a team member reads the page and gets 403 on PUT; the new-workspace note shows", async ({ context, browser }) => {
  const owner = await signupUser(context, "spendagt");
  await resetSpend(owner.tenantId);
  await connectSpendingAdAccount(owner.tenantId, { userId: owner.userId });
  const agent = await agentContext(browser, owner.tenantId, "agent");
  const page = agent.page;
  await openSpending(page);
  await expect(page.getByText("Only the owner can change spending limits. Ask them if you need more.")).toBeVisible();
  await expect(page.getByText(/Your workspace is new, so ads can spend up to ₹2,000 a day and ₹20,000 a month for now\./)).toBeVisible();
  for (const card of ["#ads", "#whatsapp", "#ai"]) await expect(page.locator(`${card} input`)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Stop all spending" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Activity" })).toHaveCount(0);
  const res = await agent.context.request.put("/api/spend/allowances", { headers: { origin: ORIGIN }, data: { pot: "ads", dailyLimitMinor: "100000", version: 0 } });
  expect(res.status()).toBe(403);
  expect((await agent.context.request.get("/api/spend/ledger")).status()).toBe(403);
  await checkPage(page, "team member spending page");
  await agent.context.close();
});

test("works with no ad account and no WhatsApp number: limits can be set ahead @mobile", async ({ page, context }) => {
  const owner = await signupUser(context, "spendnone");
  await resetSpend(owner.tenantId);
  await openSpending(page);
  await expect(page.getByText("No ad account connected yet. You can set your ads limits now; they apply as soon as you connect one.")).toBeVisible();
  await expect(page.getByText("Connect WhatsApp to use this. You can set a limit now.")).toBeVisible();
  await expect(page.getByText("Days and months follow Asia/Kolkata time.")).toBeVisible();
  await expect(page.locator("#ads").getByLabel("Currency")).toBeVisible();
  await noHorizontalOverflow(page, "spending page at phone width");
  await checkPage(page, "spending page, nothing connected");
});
