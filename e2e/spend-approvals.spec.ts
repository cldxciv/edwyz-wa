/**
 * Spending requests in the browser (docs/SPEND-CONTROLS-SPEC.md 7.3, 7.4, 8.1, 10.4; WP-17): an approval seeded straight into
 * the database; the one-tap link /s/<token> declines logged out; approving goes through sign-in and is then one tap on
 * Settings > Spending limits; a request past its time reads "Declined automatically". Axe, the dark theme and (Pixel 7,
 * @mobile) no horizontal scroll.
 *
 * Runs with SPEND_DRY_RUN=1 on the app under test.
 */
import { expect, test } from "@playwright/test";
import { PASSWORD, closeDb, db, signupUser } from "./helpers";
import { axeSerious, goDark, noHorizontalOverflow } from "./audience-campaigns-util";
import { connectSpendingAdAccount, liftNewWorkspaceLimits, resetSpend, seedApproval, spendDryRun } from "./spend-kit";

test.afterAll(closeDb);
test.beforeEach(() => {
  test.setTimeout(240_000);
});
test.skip(!spendDryRun(), "Spend specs need SPEND_DRY_RUN=1 on the app under test.");

const SUMMARY = "Raise the daily budget of 'Diwali leads - Delhi' from ₹800 to ₹1,000";

test("the one-tap link: declining works logged out @mobile", async ({ context, browser }) => {
  const owner = await signupUser(context, "spendreq");
  await resetSpend(owner.tenantId);
  await connectSpendingAdAccount(owner.tenantId, { userId: owner.userId });
  const { id, token } = await seedApproval(owner.tenantId);
  const anon = await browser.newContext();
  const page = await anon.newPage();
  await page.goto(`/s/${token}`);
  await expect(page.getByRole("heading", { level: 1, name: /^Spending request for / })).toBeVisible();
  await expect(page.getByRole("heading", { name: SUMMARY })).toBeVisible();
  await expect(page.getByText("Could add up to ₹4,550 this month (worst case)")).toBeVisible();
  await expect(page.getByText("Why: cost per lead is ₹62, well below your ₹100 target")).toBeVisible();
  await expect(page.getByText(/^Declined automatically in (11|12) hours$/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in to approve" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);

  expect(await axeSerious(page, "one-tap page"), "axe").toEqual([]);
  await noHorizontalOverflow(page, "one-tap page");
  await page.emulateMedia({ colorScheme: "dark" });
  expect(await axeSerious(page, "one-tap page dark"), "axe dark").toEqual([]);

  await page.getByRole("button", { name: "Decline" }).click();
  await expect(page.getByText(/Declined\. Nothing was changed\./).first()).toBeVisible();
  const d = await db();
  await expect.poll(async () => (await d.query(`SELECT status FROM "SpendApproval" WHERE id = $1`, [id])).rows[0].status, { timeout: 15_000 }).toBe("declined");
  await anon.close();
});

test("approving needs a signed-in approver: the link leads through sign-in, then one tap", async ({ context, browser }) => {
  const owner = await signupUser(context, "spendok");
  await resetSpend(owner.tenantId);
  await connectSpendingAdAccount(owner.tenantId, { userId: owner.userId });
  await liftNewWorkspaceLimits(owner.tenantId);
  const { id, token } = await seedApproval(owner.tenantId);
  const fresh = await browser.newContext();
  const page = await fresh.newPage();
  await page.goto(`/s/${token}`);
  await page.getByRole("link", { name: "Sign in to approve" }).click();
  await page.waitForURL(/\/login\?next=/);
  await page.getByLabel(/email/i).fill(owner.email);
  await page.getByLabel(/^password/i).fill(PASSWORD);
  await page.getByRole("button", { name: /sign in|log in/i }).click();
  await page.waitForURL(/\/app\/settings\/spending\?approval=/);
  const card = page.locator("#approvals");
  await expect(card.getByRole("heading", { name: "Waiting for you" })).toBeVisible();
  await expect(card.getByText(SUMMARY)).toBeVisible();
  await card.getByRole("button", { name: "Approve" }).click();
  const d = await db();
  await expect
    .poll(async () => (await d.query(`SELECT status, "decidedByUserId" FROM "SpendApproval" WHERE id = $1`, [id])).rows[0], { timeout: 15_000 })
    .toMatchObject({ decidedByUserId: owner.userId });
  const row = (await d.query(`SELECT status FROM "SpendApproval" WHERE id = $1`, [id])).rows[0];
  // The seeded intent points at no real ad set, so the re-check at apply may fail it; either way a person decided it.
  expect(["approved", "applied", "failed"]).toContain(row.status);
  await goDark(page);
  expect(await axeSerious(page, "spending page with a request, dark"), "axe dark").toEqual([]);
  await fresh.close();
});

test("a request past its time reads 'Declined automatically' and has no buttons", async ({ context, browser }) => {
  const owner = await signupUser(context, "spendexp");
  await resetSpend(owner.tenantId);
  const expiresAt = new Date(Date.now() - 60_000);
  const { id, token } = await seedApproval(owner.tenantId, { expiresAt });
  await (await db()).query(`UPDATE "SpendApproval" SET "createdAt" = $2 WHERE id = $1`, [id, new Date(expiresAt.getTime() - 12 * 3_600_000)]);
  const anon = await browser.newContext();
  const page = await anon.newPage();
  await page.goto(`/s/${token}`);
  await expect(page.getByText("Declined automatically (no answer in 12 hours).")).toBeVisible();
  await expect(page.getByRole("button", { name: "Decline" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);
  // A token that was never issued shows a plain message, never another workspace's request.
  await page.goto(`/s/${"x".repeat(43)}`);
  await expect(page.getByRole("heading", { name: "This link doesn't work" })).toBeVisible();
  await anon.close();
});
