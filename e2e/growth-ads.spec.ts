import { expect as baseExpect, test, type Page } from "@playwright/test";
import { ORIGIN, closeDb, db, signupUser, stamp, watchErrors } from "./helpers";
import { axeSerious, createAgent, loginFresh, overflowsX, seedMeta, setCap, toggleTheme } from "./growth-helpers";
import { liftNewWorkspaceLimits } from "./spend-kit";

// The shared machine is busy with other testers: generous timeouts keep real defects apart from slowness.
const expect = baseExpect.configure({ timeout: 25_000 });
test.setTimeout(240_000);
test.use({ actionTimeout: 30_000, navigationTimeout: 60_000 });

test.afterAll(closeDb);

async function step1(page: Page, goal: string, name: string) {
  await page.getByRole("radio", { name: new RegExp(goal, "i") }).check();
  await page.getByLabel("Campaign name").fill(name);
  await page.getByLabel("Ad account").selectOption({ index: 1 });
  await page.getByRole("button", { name: "Continue to budget" }).click();
  await expect(page.getByRole("heading", { name: "Set your budget" })).toBeVisible();
}

async function step2(page: Page, budget: string, category: RegExp) {
  await page.getByRole("textbox", { name: /Daily budget/ }).fill(budget);
  await page.getByRole("radio", { name: category }).check();
}

async function toStep4(page: Page) {
  await page.getByRole("button", { name: "Continue to audience" }).click();
  await expect(page.getByRole("heading", { name: "Who should see it?" })).toBeVisible();
  await page.getByRole("button", { name: "Continue to your ad" }).click();
  await expect(page.getByRole("heading", { name: "Write your ad" })).toBeVisible();
}

async function step4Traffic(page: Page, text: string, link = "https://example.com/offer", picture: string | null = "https://example.com/offer.jpg") {
  await page.getByLabel("Facebook Page").selectOption({ index: 1 });
  await page.getByLabel("Main text").fill(text);
  // Meta needs a picture for a link ad: the review refuses to continue without one (see the dedicated picture test below).
  if (picture) await page.getByLabel("Picture link").fill(picture);
  await page.getByLabel("Website address").fill(link);
}

test.describe("Ad campaigns: list and spending limit", () => {
  test("empty list, owner sets and raises the daily limit with clear validation", async ({ page, context }) => {
    const errors = watchErrors(page);
    await signupUser(context, "ads");
    await page.goto("/app/ads");
    await expect(page.getByRole("heading", { level: 1, name: "Ad campaigns" })).toBeVisible();
    await expect(page.getByText("No campaigns yet")).toBeVisible();
    await expect(page.getByText("No limit set yet")).toBeVisible();
    // No ad account yet: the list says so and its buttons go to the connection, not to a wizard that can only say "connect first".
    await expect(page.getByText(/Campaigns run in your Meta ad account\. Connect it first/)).toBeVisible();
    await expect(page.getByRole("link", { name: "Connect ad account" }).first()).toHaveAttribute("href", "/app/settings/connections");
    await expect(page.getByRole("link", { name: "New campaign" })).toHaveCount(0);
    expect(await axeSerious(page), "axe").toEqual([]);

    const amount = page.getByLabel(/^(New daily limit|Daily limit)/);
    await page.getByRole("button", { name: "Save limit" }).click();
    await expect(page.getByText("Enter an amount above zero, like 5000.")).toBeVisible();
    await amount.fill("-5");
    await page.getByRole("button", { name: "Save limit" }).click();
    await expect(page.getByText("Enter an amount above zero, like 5000.")).toBeVisible();
    await amount.fill("abc");
    await page.getByRole("button", { name: "Save limit" }).click();
    await expect(page.getByText("Enter an amount above zero, like 5000.")).toBeVisible();

    await amount.fill("5000");
    await page.getByRole("button", { name: "Save limit" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText(/allowed to spend up to/)).toBeVisible();
    // Escape cancels and puts focus back on the button that opened it.
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("button", { name: "Save limit" })).toBeFocused();
    await page.getByRole("button", { name: "Save limit" }).click();
    await dialog.getByRole("button", { name: "Save limit" }).click();
    await expect(page.getByTestId("cap-status")).toContainText(/5,000/);
    await expect(page.getByTestId("cap-status")).toContainText("a day");
    // 8.2: the number keeps its meaning; the help text says what it means for the daily ads limit (1.75x).
    await expect(page.getByText("Up to ₹5,000 a day in ad budgets. Because Meta can spend 75% more on a busy day, this sets your daily ads limit to ₹8,750.")).toBeVisible();
    await expect(page.getByTestId("cap-summary")).toContainText(/Ads limit: .+ left today · .+ this month/);
    await expect(page.getByTestId("cap-summary")).toContainText("Set aside for running ads: ₹0");

    // Raising asks a differently worded question.
    await page.getByLabel("New daily limit").fill("9000");
    await page.getByRole("button", { name: "Save limit" }).click();
    await expect(page.getByRole("dialog").getByText("Raise your daily spending limit?")).toBeVisible();
    await page.getByRole("dialog").getByRole("button", { name: "Save limit" }).click();
    await expect(page.getByTestId("cap-status")).toContainText(/9,000/);
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("with an ad account connected the list offers New campaign", async ({ page, context }) => {
    const u = await signupUser(context, "ads");
    await seedMeta(u);
    await page.goto("/app/ads");
    await expect(page.getByText("No campaigns yet")).toBeVisible();
    await expect(page.getByRole("link", { name: "New campaign" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Create a campaign" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Connect ad account" })).toHaveCount(0);
  });

  test("the limit panel links to all spending limits, and shows the same stored limit there", async ({ page, context }) => {
    const u = await signupUser(context, "ads");
    await setCap(u, 100000);
    await liftNewWorkspaceLimits(u.tenantId);
    await page.goto("/app/ads");
    await expect(page.getByTestId("cap-status")).toContainText(/1,000/);
    await expect(page.getByTestId("cap-summary")).toContainText("Ads limit: ₹1,750 of ₹1,750 left today");
    await page.getByRole("link", { name: "All spending limits" }).click();
    await page.waitForURL(/\/app\/settings\/spending/);
    await expect(page.getByRole("heading", { level: 1, name: "Spending limits" })).toBeVisible();
    await expect(page.locator("#ads")).toContainText("₹1,750");
    expect(await axeSerious(page), "axe").toEqual([]);
    expect(await overflowsX(page)).toBe(false);
  });

  test("an agent cannot see or change campaigns or the limit", async ({ context, browser }) => {
    const owner = await signupUser(context, "ads");
    await seedMeta(owner);
    await setCap(owner, 500000);
    const agent = await createAgent(browser, owner);
    const a = await loginFresh(browser, agent.email);
    for (const path of ["/app/ads", "/app/ads/new"]) {
      await a.page.goto(path);
      await expect(a.page.getByText(/only owners and admins|are for owners and admins/i)).toBeVisible();
    }
    expect((await a.context.request.get("/api/ads/caps")).status()).toBe(403);
    const put = await a.context.request.put("/api/ads/caps", { headers: { origin: ORIGIN }, data: { maxDailyBudgetMinor: 100, currency: "INR" } });
    expect(put.status()).toBe(403);
    await a.context.close();
  });

  test("an admin can create campaigns but only an owner can change the limit", async ({ context, browser }) => {
    const owner = await signupUser(context, "ads");
    await setCap(owner, 500000);
    const agent = await createAgent(browser, owner);
    const d = await db();
    await d.query(`update "Membership" set role = 'admin' where "userId" = $1`, [agent.userId]);
    const a = await loginFresh(browser, agent.email);
    await a.page.goto("/app/ads");
    await expect(a.page.getByTestId("cap-status")).toContainText(/5,000/);
    await expect(a.page.getByText("Only an owner can change the limit.")).toBeVisible();
    await expect(a.page.getByLabel(/daily limit/i)).toHaveCount(0);
    await a.context.close();
  });

  test("another workspace cannot read or touch my campaign", async ({ context, browser }) => {
    const owner = await signupUser(context, "ads");
    const m = await seedMeta(owner);
    const d = await db();
    const id = `camp_${stamp()}`;
    await d.query(`insert into "AdCampaign" (id,"tenantId","adAccountAssetId",name,template,objective,status,"dailyBudgetMinor",currency,"updatedAt") values ($1,$2,$3,'Private diwali offer','traffic','OUTCOME_TRAFFIC','draft',50000,'INR',now())`, [id, owner.tenantId, m.adAccount.id]);
    const bctx = await browser.newContext();
    const bpage = await bctx.newPage();
    await signupUser(bctx, "ads");
    await bpage.goto("/app/ads");
    await expect(bpage.getByText("No campaigns yet")).toBeVisible();
    await expect(bpage.locator("body")).not.toContainText("Private diwali offer");
    await bpage.goto(`/app/ads/${id}`);
    // Another workspace's campaign looks exactly like a missing one: a not-found state with a way back, no Try again.
    await expect(bpage.getByRole("heading", { level: 1, name: "Campaign not found" })).toBeVisible();
    await expect(bpage.getByText("This campaign does not exist")).toBeVisible();
    await expect(bpage.getByRole("button", { name: "Try again" })).toHaveCount(0);
    await bpage.getByRole("link", { name: "Back to ad campaigns" }).click();
    await expect(bpage).toHaveURL(/\/app\/ads$/);
    await expect(bpage.locator("body")).not.toContainText("Private diwali offer");
    expect((await bctx.request.get(`/api/ads/campaigns/${id}`)).status()).toBe(404);
    for (const action of ["launch", "activate", "archive", "pause"]) {
      const r = await bctx.request.post(`/api/ads/campaigns/${id}/${action}`, { headers: { origin: ORIGIN }, data: {} });
      expect([403, 404], `${action} on someone else's campaign`).toContain(r.status());
    }
    const row = (await d.query(`select status from "AdCampaign" where id = $1`, [id])).rows[0];
    expect(row.status).toBe("draft");
    await bctx.close();
  });
});

test.describe("Ad campaign wizard", () => {
  test("without an ad account the wizard sends the owner to connect one", async ({ page, context }) => {
    await signupUser(context, "wiz");
    await page.goto("/app/ads/new");
    await expect(page.getByText("Connect your ad account first")).toBeVisible();
    await page.getByRole("link", { name: "Connect ad account" }).click();
    await expect(page).toHaveURL(/settings\/connections/);
  });

  test("steps, validation, keyboard and focus", async ({ page, context }) => {
    const errors = watchErrors(page);
    const u = await signupUser(context, "wiz");
    await seedMeta(u, { currency: "INR" });
    await setCap(u, 500000);
    await liftNewWorkspaceLimits(u.tenantId);
    await page.goto("/app/ads/new");
    await expect(page.getByRole("heading", { level: 1, name: "New campaign" })).toBeVisible();
    await expect(page.getByText("Step 1 of 5: Goal")).toBeVisible();
    expect(await axeSerious(page), "axe step 1").toEqual([]);

    // Continue is disabled until the basics are given, and says why.
    await expect(page.getByRole("button", { name: "Continue to budget" })).toBeDisabled();
    await expect(page.getByText("Pick a goal, name your campaign and choose an ad account to continue.")).toBeVisible();
    await page.getByRole("radio", { name: /Visit your website/ }).check();
    await page.getByLabel("Campaign name").fill("Showroom weekend launch");
    await page.getByLabel("Ad account").selectOption({ index: 1 });
    // Enter inside a text field moves on, and focus lands on the new step's heading.
    await page.getByLabel("Campaign name").press("Enter");
    await expect(page.getByRole("heading", { name: "Set your budget" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Set your budget" })).toBeFocused();
    await expect(page.getByText("Step 2 of 5: Budget")).toBeVisible();

    // Budget validation in plain words.
    await expect(page.getByRole("button", { name: "Continue to audience" })).toBeDisabled();
    await page.getByRole("textbox", { name: /Daily budget/ }).fill("0");
    await expect(page.getByText("Enter an amount above zero, like 500 or 499.50.")).toBeVisible();
    await page.getByRole("textbox", { name: /Daily budget/ }).fill("6000");
    await expect(page.getByText(/more than your daily limit of .*5,000/)).toBeVisible();
    await page.getByRole("textbox", { name: /Daily budget/ }).fill("500");
    await expect(page.getByTestId("wizard-cap")).toContainText(/5,000/);
    // The end must be after the start. Labels are anchored: the "No end date" checkbox sentence (docs/SPEND-CONTROLS-SPEC.md 8.2)
    // also says "end" and "start of each month".
    await page.getByLabel(/^Start/).fill("2026-12-10T10:00");
    await page.getByLabel(/^End/).fill("2026-12-09T10:00");
    await expect(page.getByText("Choose an end that is after the start.")).toBeVisible();
    await page.getByLabel(/^End/).fill("2026-12-20T10:00");
    await expect(page.getByRole("button", { name: "Continue to audience" })).toBeDisabled();
    await expect(page.getByText("Choose whether your ad is about any special category to continue.")).toBeVisible();
    await page.getByRole("radio", { name: /None of these apply/ }).check();
    expect(await axeSerious(page), "axe step 2").toEqual([]);
    await page.getByRole("button", { name: "Continue to audience" }).click();

    // Audience validation.
    await expect(page.getByRole("heading", { name: "Who should see it?" })).toBeVisible();
    await page.getByLabel("Countries").fill("India, 12");
    await expect(page.getByText(/These are not country codes: India, 12/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue to your ad" })).toBeDisabled();
    await page.getByLabel("Countries").fill("in, ae");
    await page.getByLabel("Youngest age").fill("10");
    await expect(page.getByText("Ages must be between 13 and 65.")).toBeVisible();
    await page.getByLabel("Youngest age").fill("40");
    await page.getByLabel("Oldest age").fill("30");
    await expect(page.getByText("The minimum age cannot be higher than the maximum.")).toBeVisible();
    await page.getByLabel("Youngest age").fill("21");
    await page.getByLabel("Oldest age").fill("45");
    expect(await axeSerious(page), "axe step 3").toEqual([]);
    await page.getByRole("button", { name: "Continue to your ad" }).click();

    // Ad step: required fields.
    await expect(page.getByRole("heading", { name: "Write your ad" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Review campaign" })).toBeDisabled();
    await step4Traffic(page, "Visit our new showroom this weekend. Free parking. Offer valid till 30 November.");
    expect(await axeSerious(page), "axe step 4").toEqual([]);
    await page.getByRole("button", { name: "Back" }).click();
    await expect(page.getByRole("heading", { name: "Who should see it?" })).toBeVisible();
    await expect(page.getByLabel("Countries")).toHaveValue("in, ae");
    await page.getByRole("button", { name: "Continue to your ad" }).click();
    await expect(page.getByLabel("Main text")).toHaveValue(/new showroom/);
    await page.getByRole("button", { name: "Review campaign" }).click();

    // Review.
    await expect(page.getByRole("heading", { name: "Check everything" })).toBeVisible();
    await expect(page.getByTestId("total-budget")).toContainText(/500/);
    const create = page.getByRole("button", { name: "Create on Meta (paused)" });
    await expect(create).toBeDisabled();
    await page.getByLabel(/Type the daily total to confirm/).fill("400");
    await expect(page.getByText("That does not match the total daily budget above.")).toBeVisible();
    await expect(create).toBeDisabled();
    await page.getByLabel(/Type the daily total to confirm/).fill("500");
    await expect(create).toBeEnabled();
    // Details for support never appear unless opened, and never show tokens.
    await expect(page.locator("body")).not.toContainText("fake-token");
    expect(await axeSerious(page), "axe review").toEqual([]);
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("blocked without a workspace limit: the review says so in plain words", async ({ page, context }) => {
    const u = await signupUser(context, "wiz");
    await seedMeta(u);
    await page.goto("/app/ads/new");
    await step1(page, "Visit your website", "No cap campaign");
    await expect(page.getByText("No daily spending limit is set")).toBeVisible();
    await expect(page.getByText(/cannot be created on Meta until an owner sets a limit/)).toBeVisible();
    await step2(page, "500", /None of these apply/);
    await toStep4(page);
    await step4Traffic(page, "Weekend sale at our store. Terms apply.");
    await page.getByRole("button", { name: "Review campaign" }).click();
    await expect(page.getByRole("heading", { name: "Check everything" })).toBeVisible();
    await expect(page.getByText("Fix these before creating the campaign")).toBeVisible();
    await expect(page.getByText("No daily spending limit is set yet. An owner needs to set one on the Ad campaigns page first.")).toBeVisible();
    await page.getByLabel(/Type the daily total to confirm/).fill("500");
    await expect(page.getByRole("button", { name: "Create on Meta (paused)" })).toBeDisabled();
    // The same refusal comes from the server when the UI is bypassed.
    const d = await db();
    const id = (await d.query(`select id from "AdCampaign" where "tenantId" = $1 order by "createdAt" desc limit 1`, [u.tenantId])).rows[0].id;
    const r = await context.request.post(`/api/ads/campaigns/${id}/launch`, { headers: { origin: ORIGIN }, data: {} });
    expect(r.status()).toBe(400);
    expect((await r.json()).error).toMatch(/No daily budget cap is set/);
    expect((await d.query(`select status, "metaCampaignId" from "AdCampaign" where id = $1`, [id])).rows[0]).toMatchObject({ status: "draft", metaCampaignId: null });
  });

  test("a limit in another currency than the ad account is explained", async ({ page, context }) => {
    const u = await signupUser(context, "wiz");
    await seedMeta(u, { currency: "INR" });
    await setCap(u, 500000, "USD");
    await page.goto("/app/ads/new");
    await step1(page, "Visit your website", "Currency campaign");
    await expect(page.getByText("Your limit is in a different currency")).toBeVisible();
    await expect(page.getByText(/set in USD, but this ad account uses INR/)).toBeVisible();
  });

  test("special category: housing wording with 'none' needs a second acknowledgement, then reaches Review", async ({ page, context }) => {
    const errors = watchErrors(page);
    const u = await signupUser(context, "wiz");
    await seedMeta(u);
    await setCap(u, 500000);
    await liftNewWorkspaceLimits(u.tenantId);
    await page.goto("/app/ads/new");
    await step1(page, "Visit your website", "Sunrise Residency");
    await step2(page, "800", /None of these apply/);
    await toStep4(page);
    await step4Traffic(page, "Spacious 2 BHK flat in Pune with easy home loan and low mortgage rates. Book a site visit.");
    await page.getByRole("button", { name: "Review campaign" }).click();
    // Not silently accepted, not a raw server sentence.
    // The warning is a polite status region (warn tone), not an assertive alert.
    const alert = page.getByRole("status").filter({ hasText: "Check the special category" });
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(/looks like it is about/i);
    await expect(alert).not.toContainText(/acknowledgeSpecialCategoryTerms|API field/);
    await expect(page.getByRole("button", { name: "Change the category" })).toBeVisible();
    const ack = page.getByRole("checkbox", { name: /I have read Meta.s rules and my ad is not about housing, jobs, credit or social issues/ });
    await expect(ack).not.toBeChecked();
    expect(await axeSerious(page), "axe ack").toEqual([]);
    await ack.check();
    await page.getByRole("button", { name: "Review campaign" }).click();
    await expect(page.getByRole("heading", { name: "Check everything" })).toBeVisible();
    await expect(page.getByText("Special category")).toBeVisible();
    const d = await db();
    const rows = (await d.query(`select a.creative from "Ad" a join "AdCampaign" c on c.id = (select "campaignId" from "AdSet" where id = a."adSetId") where c."tenantId" = $1 order by a."createdAt" desc limit 1`, [u.tenantId])).rows;
    expect(rows[0].creative.categoryTermsAck, "the acknowledgement is stored with the ad").toBe(true);
    // The server's 400 for the unacknowledged housing wording is the point of this test; the browser logs it as a failed resource.
    const unexpected = errors.filter((e) => !/Failed to load resource.*400/.test(e));
    expect(unexpected, unexpected.join("\n")).toEqual([]);
  });

  test("special category: choosing Housing fixes the audience and explains why", async ({ page, context }) => {
    const u = await signupUser(context, "wiz");
    await seedMeta(u);
    await setCap(u, 500000);
    await liftNewWorkspaceLimits(u.tenantId);
    await page.goto("/app/ads/new");
    await step1(page, "Visit your website", "Lakeview apartments");
    await page.getByRole("textbox", { name: /Daily budget/ }).fill("800");
    await page.getByRole("radio", { name: /Housing: real estate/ }).check();
    await expect(page.getByText("Housing ads have extra rules")).toBeVisible();
    await expect(page.getByText(/no narrowing by age or gender/i)).toBeVisible();
    await page.getByRole("button", { name: "Continue to audience" }).click();
    await expect(page.getByText("Some choices are fixed for this category")).toBeVisible();
    await expect(page.getByLabel("Youngest age")).toBeDisabled();
    await expect(page.getByLabel("Oldest age")).toBeDisabled();
    await expect(page.getByLabel("Gender")).toBeDisabled();
    await page.getByRole("button", { name: "Continue to your ad" }).click();
    await step4Traffic(page, "3 BHK apartments near the lake. Mortgage assistance available.");
    await page.getByRole("button", { name: "Review campaign" }).click();
    await expect(page.getByRole("heading", { name: "Check everything" })).toBeVisible();
    // The wizard already sends category-safe targeting (fixed on the audience step), so the server has nothing to adjust and no "adjusted" notice is expected.
    await expect(page.getByText("Special category")).toBeVisible();
    await expect(page.getByText("Housing", { exact: true }).first()).toBeVisible();
  });

  test("a real-estate brand makes the wizard ask for confirmation before choosing None", async ({ page, context }) => {
    const u = await signupUser(context, "wiz");
    await seedMeta(u);
    await setCap(u, 500000);
    await liftNewWorkspaceLimits(u.tenantId);
    const d = await db();
    await d.query(`insert into "Brand" (id,"tenantId",name,industry,"specialAdCategory","updatedAt") values ($1,$2,'Sunrise Realty','real estate','housing',now())`, [`brand_${stamp()}`, u.tenantId]);
    await page.goto("/app/ads/new");
    await step1(page, "Visit your website", "Brand flagged");
    await expect(page.getByText(/Your business profile points to housing/)).toBeVisible();
    await page.getByRole("textbox", { name: /Daily budget/ }).fill("800");
    await page.getByRole("radio", { name: /None of these apply/ }).check();
    await expect(page.getByRole("button", { name: "Continue to audience" })).toBeDisabled();
    await page.getByRole("checkbox", { name: /I confirm my ad is not about housing/ }).check();
    await expect(page.getByRole("button", { name: "Continue to audience" })).toBeEnabled();
  });

  // The wizard now stops this at the field: "Review campaign" stays disabled until a picture link is given, with a visible reason, so an
  // owner never reaches a review that cannot be created. (The review's "Fix these before creating the campaign" box remains for problems
  // the server finds, and friendlyAdsError turns the picture one into plain words; see the ads unit tests.)
  test("the picture is required for a link ad: the field says so and the review stays blocked until it is given", async ({ page, context }) => {
    const u = await signupUser(context, "wiz");
    await seedMeta(u);
    await setCap(u, 500000);
    await liftNewWorkspaceLimits(u.tenantId);
    await page.goto("/app/ads/new");
    await step1(page, "Visit your website", "No picture");
    await step2(page, "500", /None of these apply/);
    await toStep4(page);
    await step4Traffic(page, "Weekend sale at our store. Terms apply.", "https://example.com/offer", null);
    // A field marked optional must not block the review.
    await expect(page.getByText("Picture link").locator("..")).not.toContainText("optional");
    const review = page.getByRole("button", { name: "Review campaign" });
    await expect(review, "no picture, so the review cannot be reached").toBeDisabled();
    await expect(page.getByText("Fill in the required fields above to continue.")).toBeVisible();
    // A link that is not https is called out on the field and still blocks the review.
    await page.getByLabel("Picture link").fill("http://example.com/offer.jpg");
    await expect(page.getByText("Use a web address that starts with https://.")).toBeVisible();
    await expect(review).toBeDisabled();
    await page.getByLabel("Picture link").fill("https://example.com/offer.jpg");
    await expect(review).toBeEnabled();
    await review.click();
    await expect(page.getByRole("heading", { name: "Check everything" })).toBeVisible();
    await expect(page.locator("body"), "owners must not see API field names").not.toContainText(/imageUrl|imageHash/);
  });

  test("leaving a half-filled wizard asks first; creating on Meta with a placeholder account fails kindly", async ({ page, context }) => {
    const u = await signupUser(context, "wiz");
    await seedMeta(u);
    await setCap(u, 500000);
    await liftNewWorkspaceLimits(u.tenantId);
    await page.goto("/app/ads/new");
    await step1(page, "Visit your website", "Leave me");
    await page.getByRole("link", { name: "Ad campaigns" }).first().click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog.getByText("Leave this campaign?")).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("heading", { name: "Set your budget" })).toBeVisible();

    await step2(page, "500", /None of these apply/);
    await toStep4(page);
    await step4Traffic(page, "Weekend sale at our store. Terms apply.");
    await page.getByRole("button", { name: "Review campaign" }).click();
    await page.getByLabel(/Type the daily total to confirm/).fill("500");
    await page.getByRole("button", { name: "Create on Meta (paused)" }).click();
    const failure = page.getByRole("alert").filter({ hasText: /could not create the campaign/i });
    await expect(failure).toBeVisible({ timeout: 40_000 });
    const text = await failure.innerText();
    expect(text).not.toMatch(/OAuthException|\"error\"|\bstack\b|TypeError|\bundefined\b|\[object|Something went wrong\.?$/i);
    const d = await db();
    const row = (await d.query(`select status, "metaCampaignId" from "AdCampaign" where "tenantId" = $1 order by "createdAt" desc limit 1`, [u.tenantId])).rows[0];
    expect(["draft", "error"]).toContain(row.status);
  });

  test("wizard and list fit a phone and the dark theme @mobile", async ({ page, context }) => {
    const u = await signupUser(context, "wiz");
    await seedMeta(u);
    await setCap(u, 500000);
    await liftNewWorkspaceLimits(u.tenantId);
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto("/app/ads");
    await expect(page.getByRole("heading", { level: 1, name: "Ad campaigns" })).toBeVisible();
    expect(await overflowsX(page), "list at 360px").toBe(false);
    await page.goto("/app/ads/new");
    await expect(page.getByText("Step 1 of 5: Goal")).toBeVisible();
    expect(await overflowsX(page), "step 1 at 360px").toBe(false);
    await step1(page, "Visit your website", "Phone campaign");
    expect(await overflowsX(page), "step 2 at 360px").toBe(false);
    await toggleTheme(page).catch(async () => {
      await page.getByRole("button", { name: /^more$/i }).first().click();
      await toggleTheme(page);
    });
    expect(await axeSerious(page), "axe dark step 2").toEqual([]);
  });
});
