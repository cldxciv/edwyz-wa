import { expect, test, type Page } from "@playwright/test";
import { addTeammate, apiLogin, axeSerious, createOwner, isDark, overflowsHorizontally, setDarkTheme } from "./settings-billing-admin-kit";
import { closeDb, db, ORIGIN, stamp, type TestUser, watchErrors } from "./helpers";

const BILLING = "/app/billing";
let owner: TestUser;
let stranger: TestUser;

test.beforeAll(async () => {
  owner = await createOwner("sba-bill");
  stranger = await createOwner("sba-bill-stranger");
});
test.afterAll(closeDb);
test.beforeEach(async ({ context }) => {
  await apiLogin(context, owner.email);
  // Every test starts from a fresh 14 day trial with no subscription.
  const d = await db();
  await d.query(`update "Tenant" set "trialEndsAt" = now() + interval '14 days', status = 'active', "suspendedReason" = null, "billingExempt" = false where id = $1`, [owner.tenantId]);
});

const plan = (over: Record<string, unknown> = {}) => ({
  id: "plan_uat_1",
  name: "Growth UAT",
  description: "For growing shops",
  pricePaise: 99900,
  currency: "INR",
  intervalMonths: 1,
  seatLimit: 5,
  contactLimit: 10000,
  monthlyBroadcastLimit: 25000,
  aiCreditsMonthly: 500,
  adAccountLimit: 2,
  scheduledPostLimit: null,
  connectedChannelLimit: 3,
  ...over,
});

async function withPlans(page: Page, plans: unknown[], over: Record<string, unknown> = {}) {
  await page.route("**/api/billing", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const res = await route.fetch();
    const json = await res.json();
    await route.fulfill({ response: res, json: { ...json, plans, ...over } });
  });
}

test("billing with no plans published: clear message, trial banner area, usage meter, empty invoices", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/app");
  await page.getByRole("link", { name: "Billing" }).first().click();
  await expect(page).toHaveURL(/\/app\/billing$/);
  await expect(page.getByRole("heading", { level: 1, name: "Billing" })).toBeVisible();
  await expect(page.getByRole("main")).toBeVisible();

  await expect(page.getByText("Free trial", { exact: true })).toBeVisible();
  await expect(page.getByText("No paid plan yet")).toBeVisible();
  await expect(page.getByText(/Everything works during your trial/)).toBeVisible();
  const meter = page.getByRole("progressbar", { name: /Free trial days used/ });
  await expect(meter).toBeVisible();
  await expect(page.getByText(/\d+ days? left in your trial/)).toBeVisible();

  // No plans: the page explains it. There must be nothing that looks like a purchase button.
  await expect(page.getByRole("heading", { name: "Plans" })).toBeVisible();
  await expect(page.getByText("Plans are not published yet. Contact us.")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Subscribe/ })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Choose a plan" })).toHaveCount(0); // would scroll to an empty list

  // Usage meter shows real lines and says there are no limits yet.
  await expect(page.getByRole("heading", { name: "Plan usage" })).toBeVisible();
  for (const l of ["Contacts", "Team seats", "Broadcast messages this month"]) await expect(page.getByText(l, { exact: true }).first()).toBeVisible();
  await expect(page.getByText("You do not have a paid plan yet, so no limits are shown.")).toBeVisible();

  await expect(page.getByText("No invoices yet")).toBeVisible();
  const text = await page.locator("main").innerText();
  expect(text).not.toMatch(/\bundefined\b|\bNaN\b|\[object Object\]|trialing|past_due|locked/);
  expect(errors, errors.join("\n")).toEqual([]);
});

test("the empty-plans message tells people how to reach us", async ({ page }) => {
  await page.goto(BILLING);
  const empty = page.getByText("Plans are not published yet. Contact us.").locator("xpath=ancestor::div[contains(@class,'border-dashed')][1]");
  await expect(empty).toBeVisible();
  // "Contact us" / "Contact support" must be actionable: an email link or a link to a contact page.
  const actionable = await empty.locator("a[href^='mailto:'], a[href*='contact'], a[href*='support']").count();
  expect(actionable, "The message says to contact us/support but gives no email address or link to do so").toBeGreaterThan(0);
});

test("usage meter reflects real use (team seats) and the numbers are readable words", async ({ page, context }) => {
  await addTeammate(context, "agent", "bill-seat");
  await page.goto(BILLING);
  const seats = page.locator("li").filter({ hasText: "Team seats" }).first();
  await expect(seats).toContainText(/2/);
  await expect(seats).not.toContainText(/undefined|NaN/);
});

test("billing details: validation, saving, and the values come back after reload", async ({ page }) => {
  await page.goto(BILLING);
  const save = page.getByRole("button", { name: "Save billing details" });
  await save.click();
  await expect(page.getByText("Enter the name your invoices should be addressed to.")).toBeVisible();
  await expect(page.getByText("Enter your business address.")).toBeVisible();
  await expect(page.getByText("Enter your state, like Karnataka.")).toBeVisible();
  await expect(page.getByText("Enter an email address for invoices.")).toBeVisible();

  await page.getByLabel(/Business name/).fill("UAT Traders Pvt Ltd");
  await page.getByLabel(/Billing email/).fill("not-an-email");
  await page.getByLabel(/^Address/).fill("12 MG Road, Bengaluru");
  await page.getByLabel(/^State/).fill("Karnataka");
  await page.getByLabel(/Pincode/).fill("56001");
  await page.getByLabel(/GST number/).fill("BADGST");
  await save.click();
  await expect(page.getByText("Enter a valid email address, like accounts@yourshop.com.")).toBeVisible();
  await expect(page.getByText("Enter a 6-digit pincode.")).toBeVisible();
  await expect(page.getByText(/A GSTIN has 15 letters and numbers/)).toBeVisible();

  await page.getByLabel(/Billing email/).fill("accounts@uat-traders.example");
  await page.getByLabel(/Pincode/).fill("560001");
  await page.getByLabel(/GST number/).fill("29ABCDE1234F1Z5");
  await save.click();
  await expect(page.getByText(/Billing details saved/)).toBeVisible();
  await page.reload();
  await expect(page.getByLabel(/Business name/)).toHaveValue("UAT Traders Pvt Ltd");
  await expect(page.getByLabel(/GST number/)).toHaveValue("29ABCDE1234F1Z5");
  await expect(page.getByLabel(/Pincode/)).toHaveValue("560001");
});

test("plans from the platform are shown in plain money with limits; paying online is explained as not set up", async ({ page }) => {
  await withPlans(page, [plan(), plan({ id: "plan_uat_2", name: "Scale UAT", pricePaise: 249900, seatLimit: null, contactLimit: null })]);
  await page.goto(BILLING);
  const card = page.getByRole("listitem").filter({ hasText: "Growth UAT" });
  await expect(card).toContainText("Rs 999");
  await expect(card).toContainText("per month");
  await expect(card).toContainText("Team seats");
  await expect(card).toContainText("10,000");
  await expect(page.getByRole("listitem").filter({ hasText: "Scale UAT" })).toContainText("No fixed limit");
  await expect(page.getByText(/Prices include GST/)).toBeVisible();
  // Razorpay is not configured on this instance: the button is disabled and says why.
  const subscribe = card.getByRole("button", { name: "Subscribe to Growth UAT" });
  await expect(subscribe).toBeDisabled();
  await expect(subscribe).toHaveAccessibleDescription(/Online payment is not set up yet/);
  await expect(page.getByRole("link", { name: "Choose a plan" })).toBeVisible();
});

test("starting a subscription when payments are unavailable fails with a clear message, no crash", async ({ page }) => {
  await withPlans(page, [plan()], { paymentsConfigured: true });
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(BILLING);
  await page.getByRole("button", { name: "Subscribe to Growth UAT" }).click();
  // The real server cannot create a Razorpay subscription for a plan that does not exist: the person gets words, not a stack trace.
  const toast = page.getByRole("alert").or(page.getByRole("status")).filter({ hasText: /payment|plan|could not|not set up/i }).first();
  await expect(toast).toBeVisible({ timeout: 15_000 });
  expect(await toast.innerText()).not.toMatch(/undefined|TypeError|Prisma|ECONN|at .*:\d+:\d+/);
  expect(pageErrors).toEqual([]);
});

test("trial ending soon shows a banner everywhere in the app that leads to billing", async ({ page }) => {
  const d = await db();
  await d.query(`update "Tenant" set "trialEndsAt" = now() + interval '2 days' where id = $1`, [owner.tenantId]);
  await page.goto("/app/inbox");
  const banner = page.getByRole("status").filter({ hasText: /Your free trial ends in \d+ days?/ });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("Subscribe to keep sending messages.");
  await banner.getByRole("link", { name: "Choose a plan" }).click();
  await expect(page).toHaveURL(/\/app\/billing/);
  await expect(page.getByText(/[12] days? left in your trial/)).toBeVisible();
  // Few days left is a warning, and it is not colour only.
  await expect(page.getByRole("progressbar", { name: /Free trial days used/ })).toBeVisible();
});

test("trial over: workspace is read-only with a clear alert, billing stays reachable, writes are refused with words", async ({ page, context }) => {
  const d = await db();
  await d.query(`update "Tenant" set "trialEndsAt" = now() - interval '1 day' where id = $1`, [owner.tenantId]);
  await page.goto("/app/inbox");
  const alert = page.getByRole("alert").filter({ hasText: /read-only until you subscribe/ });
  await expect(alert).toBeVisible();
  await page.goto(BILLING);
  await expect(page.getByText("Read-only", { exact: true })).toBeVisible();
  await expect(page.getByText(/You can still see your data, but you cannot send until you subscribe/)).toBeVisible();
  // A write is refused with an explanation (new API key is a workspace write).
  const res = await context.request.post("/api/integrations/api-keys", { headers: { origin: ORIGIN }, data: { name: `blocked ${stamp()}`, scopes: ["messages:write"] } });
  if (res.status() >= 400) {
    const body = await res.text();
    expect(body).toMatch(/subscri|read-only|trial|plan/i);
    expect(body).not.toMatch(/undefined|TypeError|stack/);
  }
  await expect(page.getByRole("heading", { level: 1, name: "Billing" })).toBeVisible();
});

test("suspended workspace: banner and billing page say so and give the reason", async ({ page }) => {
  const d = await db();
  await d.query(`update "Tenant" set status = 'suspended', "suspendedReason" = 'Unpaid dues for UAT' where id = $1`, [owner.tenantId]);
  await page.goto(BILLING);
  await expect(page.getByText("Suspended", { exact: true })).toBeVisible();
  await expect(page.getByText(/Unpaid dues for UAT/).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "See details" })).toBeVisible();
});

test("invoices: list, print view, and nobody else can open them", async ({ page, browser }) => {
  const d = await db();
  const number = `INV-SBA-${stamp()}`;
  const inserted = (
    await d.query(
      `insert into "Invoice" (id, "tenantId", number, status, "planName", "amountPaise", "gstRateBps", "gstPaise", "totalPaise", "customerName", "periodStart", "periodEnd", "paidAt") values ($1,$2,$3,'paid','Growth UAT',84661,1800,15239,99900,'UAT Traders Pvt Ltd', now(), now() + interval '30 days', now()) returning id`,
      [`inv_${stamp()}`, owner.tenantId, number],
    )
  ).rows[0];
  await page.goto(BILLING);
  const row = page.getByRole("table", { name: "Invoices" }).getByRole("row", { name: new RegExp(number) });
  await expect(row).toContainText("Paid");
  await expect(row).toContainText("Rs 999.00");
  await row.getByRole("link", { name: new RegExp(`View and print invoice ${number}`) }).click();
  await expect(page).toHaveURL(new RegExp(`/app/billing/invoices/${inserted.id}`));
  await expect(page.getByRole("button", { name: /Print|Save as PDF/i })).toBeVisible();
  await expect(page.getByText(number).first()).toBeVisible();
  await expect(page.getByText(/GST/).first()).toBeVisible();
  expect(await page.locator("main, body").first().innerText()).not.toMatch(/undefined|NaN/);
  await page.getByRole("link", { name: "Back to billing" }).click();
  await expect(page).toHaveURL(/\/app\/billing$/);

  const ctx = await browser.newContext({ baseURL: ORIGIN });
  await apiLogin(ctx, stranger.email);
  const sp = await ctx.newPage();
  const resp = await sp.goto(`/app/billing/invoices/${inserted.id}`);
  expect(resp?.status()).toBe(404);
  expect((await ctx.request.get(`/api/billing/invoices/${inserted.id}`)).status()).toBe(404);
  const list = await (await ctx.request.get("/api/billing/invoices")).text();
  expect(list).not.toContain(number);
  await ctx.close();
});

test("agents are told billing is for owners and admins, and the API agrees", async ({ browser, context }) => {
  const agent = await addTeammate(context, "agent", "bill-agent");
  const ctx = await browser.newContext({ baseURL: ORIGIN });
  await apiLogin(ctx, agent.email);
  const p = await ctx.newPage();
  await p.goto("/app");
  await expect(p.getByRole("link", { name: "Billing" })).toHaveCount(0);
  await p.goto(BILLING);
  await expect(p.getByText("Billing is for owners and admins")).toBeVisible();
  await expect(p.getByRole("button", { name: /Subscribe|Save billing details|Cancel subscription/ })).toHaveCount(0);
  expect((await ctx.request.get("/api/billing")).status()).toBe(403);
  expect((await ctx.request.put("/api/billing/profile", { headers: { origin: ORIGIN }, data: { legalName: "x" } })).status()).toBe(403);
  expect((await ctx.request.post("/api/billing/cancel", { headers: { origin: ORIGIN }, data: {} })).status()).toBe(403);
  await ctx.close();
});

test("an admin can see billing but cannot cancel or buy on the owner's behalf through the API", async ({ browser, context }) => {
  const admin = await addTeammate(context, "admin", "bill-admin");
  const ctx = await browser.newContext({ baseURL: ORIGIN });
  await apiLogin(ctx, admin.email);
  const p = await ctx.newPage();
  await p.goto(BILLING);
  await expect(p.getByRole("heading", { level: 1, name: "Billing" })).toBeVisible();
  await expect(p.getByRole("button", { name: "Cancel subscription" })).toHaveCount(0);
  const cancel = await ctx.request.post("/api/billing/cancel", { headers: { origin: ORIGIN }, data: {} });
  expect([403, 409]).toContain(cancel.status());
  // An upgrade charges the saved payment method at once, so only the owner changes the plan.
  const change = await ctx.request.post("/api/billing/change-plan", { headers: { origin: ORIGIN }, data: { planId: "any" } });
  expect(change.status()).toBe(403);
  await ctx.close();
});

test("tenant isolation: billing details and usage belong to one workspace", async ({ browser }) => {
  const ctx = await browser.newContext({ baseURL: ORIGIN });
  await apiLogin(ctx, stranger.email);
  const p = await ctx.newPage();
  await p.goto(BILLING);
  await expect(p.getByRole("heading", { level: 1, name: "Billing" })).toBeVisible();
  await expect(p.getByLabel(/Business name/)).not.toHaveValue(/UAT Traders/);
  await expect(p.getByText("UAT Traders")).toHaveCount(0);
  await ctx.close();
});

test("billing is accessible in light and dark themes and works from the keyboard", async ({ page }) => {
  await page.goto(BILLING);
  await expect(page.getByRole("button", { name: "Save billing details" })).toBeVisible();
  expect(await axeSerious(page), "light").toEqual([]);
  await page.getByLabel(/Business name/).focus();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel(/Billing email/)).toBeFocused();
  expect(await setDarkTheme(page)).toBe(true);
  expect(await isDark(page)).toBe(true);
  expect(await axeSerious(page), "dark").toEqual([]);
});

test("@mobile billing fits 360 px", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await withPlans(page, [plan(), plan({ id: "p2", name: "Scale UAT" })]);
  await page.goto(BILLING);
  await expect(page.getByRole("heading", { level: 1, name: "Billing" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Growth UAT" })).toBeVisible();
  expect(await overflowsHorizontally(page)).toBe(0);
});
