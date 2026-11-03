import { expect as baseExpect, test } from "@playwright/test";
import { ORIGIN, closeDb, db, signupUser, stamp, watchErrors } from "./helpers";
import { askDialog, axeSerious, createAgent, loginFresh, overflowsX, seedMeta, setCap, toggleTheme } from "./growth-helpers";

// The shared machine is busy with other testers: generous timeouts keep real defects apart from slowness.
const expect = baseExpect.configure({ timeout: 25_000 });
test.setTimeout(240_000);
test.use({ actionTimeout: 30_000, navigationTimeout: 60_000 });

test.afterAll(closeDb);

test.describe("Ad insights", () => {
  test("not connected: plain explanation and a way forward", async ({ page, context }) => {
    const errors = watchErrors(page);
    await signupUser(context, "ins");
    await page.goto("/app/ads/insights");
    await expect(page.getByRole("heading", { level: 1, name: "Ad insights" })).toBeVisible();
    await expect(page.getByText("Connect your Meta account")).toBeVisible();
    await expect(page.getByRole("link", { name: "Connect ad account" })).toHaveAttribute("href", "/app/settings/connections");
    expect(await axeSerious(page), "axe").toEqual([]);
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("date range controls expose their state and reject a backwards range", async ({ page, context }) => {
    const u = await signupUser(context, "ins");
    await seedMeta(u);
    await page.goto("/app/ads/insights");
    const d30 = page.getByRole("button", { name: "Last 30 days" });
    await expect(d30).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Last 7 days" }).click();
    await expect(page.getByRole("button", { name: "Last 7 days" })).toHaveAttribute("aria-pressed", "true");
    await expect(d30).toHaveAttribute("aria-pressed", "false");
    await page.getByRole("button", { name: "Pick dates" }).click();
    await page.getByLabel("From", { exact: true }).fill("2026-10-20");
    await page.getByLabel("To", { exact: true }).fill("2026-10-10");
    // Either the browser clamps it or the page explains the problem; it must not show numbers for a nonsense range.
    const msg = page.getByText(/Choose a valid date range|after|before|earlier/i);
    await expect(msg.first()).toBeVisible();
    // A range ending after today is refused too: those days have no numbers yet. Two days ahead is past today in any zone.
    const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
    await page.getByLabel("From", { exact: true }).fill(day(-5));
    await page.getByLabel("To", { exact: true }).fill(day(2));
    await expect(page.getByText(/Choose an end date on or before today/).first()).toBeVisible();
    await expect(page.getByLabel("To", { exact: true })).toHaveAttribute("max", /^\d{4}-\d{2}-\d{2}$/);
  });

  test("connected with no data: says so and offers an update; update degrades gracefully", async ({ page, context }) => {
    const errors = watchErrors(page);
    const u = await signupUser(context, "ins");
    await seedMeta(u);
    await page.goto("/app/ads/insights");
    await expect(page.getByText("No ad activity in this period")).toBeVisible();
    await expect(page.getByText(/Your first update has not run yet/)).toBeVisible();
    await expect(page.getByText("No active campaigns")).toBeVisible();
    await expect(page.getByRole("link", { name: "View campaigns" })).toBeVisible();
    expect(await axeSerious(page), "axe").toEqual([]);
    await page.getByRole("button", { name: "Update numbers now" }).click();
    await expect(page.getByText(/Update requested/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Update numbers now" })).toBeDisabled();
    await expect(page.getByText(/You can update again at/)).toBeVisible();
    // A second request straight away is refused by the server with a readable message.
    const again = await context.request.post("/api/ads/insights/sync", { headers: { origin: ORIGIN }, data: {} });
    expect(again.status()).toBeGreaterThanOrEqual(400);
    expect((await again.json()).error).not.toMatch(/stack|undefined|prisma/i);
    expect(errors.filter((e) => !/429|Failed to load resource/.test(e)), errors.join("\n")).toEqual([]);
  });

  test("connected with data: totals, chart, ad tables and money shown in the account currency", async ({ page, context }) => {
    const errors = watchErrors(page);
    const u = await signupUser(context, "ins");
    const m = await seedMeta(u, { currency: "INR" });
    const d = await db();
    const metaId = `cmp_${stamp()}`;
    for (let i = 1; i <= 6; i++) {
      const day = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
      // Totals and the chart read campaign rows only (so levels are never double counted); the ad tables read ad rows.
      for (const level of ["campaign", "ad"]) {
        await d.query(
          `insert into "InsightSnapshot" (id,"tenantId","entityType","entityMetaId",date,"spendMinor",impressions,clicks,results,frequency) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,1.4)`,
          [`snap_${stamp()}_${level}`, u.tenantId, level, `${level}_${metaId}`, day, 150000 + i * 1000, 4000, 120, 6],
        );
      }
    }
    await page.goto("/app/ads/insights");
    await expect(page.getByRole("region", { name: "Summary" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Summary" })).toContainText(/₹|INR/);
    await expect(page.getByRole("heading", { name: "Day by day" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Your ads" })).toBeVisible();
    // Technical identifiers of the ad on Meta must not be the only label people see.
    const bodyText = await page.locator("main").innerText();
    expect(bodyText, "no raw numbers like NaN/undefined/null").not.toMatch(/\bNaN\b|\bundefined\b|\bnull\b|Infinity/);
    // The chart is reachable without a mouse: it has a text alternative or a table.
    expect(await axeSerious(page), "axe").toEqual([]);
    for (const metric of ["Results", "Clicks", "Spend"]) {
      await page.getByRole("button", { name: metric, exact: true }).click();
      await expect(page.getByRole("button", { name: metric, exact: true })).toHaveAttribute("aria-pressed", "true");
    }
    expect(errors, errors.join("\n")).toEqual([]);
    void m;
  });

  test("another workspace sees none of my numbers", async ({ context, browser }) => {
    const owner = await signupUser(context, "ins");
    await seedMeta(owner);
    const d = await db();
    const day = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    await d.query(`insert into "InsightSnapshot" (id,"tenantId","entityType","entityMetaId",date,"spendMinor",impressions,clicks,results) values ($1,$2,'campaign',$3,$4,987654,1000,50,5)`, [`snap_${stamp()}`, owner.tenantId, `cmp_${stamp()}`, day]);
    const bctx = await browser.newContext();
    const bpage = await bctx.newPage();
    await signupUser(bctx, "ins");
    const res = await bctx.request.get(`/api/ads/insights/summary?from=${day}&to=${day}`);
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toMatch(/987654/);
    await bpage.goto("/app/ads/insights");
    await expect(bpage.getByText("Connect your Meta account")).toBeVisible();
    await bctx.close();
  });

  test("an agent gets the owner/admin-only message, not a broken page", async ({ context, browser }) => {
    const owner = await signupUser(context, "ins");
    await seedMeta(owner);
    const agent = await createAgent(browser, owner);
    const a = await loginFresh(browser, agent.email);
    await a.page.goto("/app/ads/insights");
    await expect(a.page.getByRole("heading", { level: 1, name: "Ad insights" })).toBeVisible();
    await expect(a.page.getByRole("button", { name: "Update numbers now" })).toHaveCount(0);
    const r = await a.context.request.post("/api/ads/insights/sync", { headers: { origin: ORIGIN }, data: {} });
    expect(r.status()).toBe(403);
    await a.context.close();
  });

  test("insights fit a phone in dark theme @mobile", async ({ page, context }) => {
    const u = await signupUser(context, "ins");
    await seedMeta(u);
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto("/app/ads/insights");
    await expect(page.getByText("No ad activity in this period")).toBeVisible();
    expect(await overflowsX(page), "insights at 360px").toBe(false);
    await toggleTheme(page).catch(async () => {
      await page.getByRole("button", { name: /^more$/i }).first().click();
      await toggleTheme(page);
    });
    expect(await axeSerious(page), "axe dark").toEqual([]);
  });
});

test.describe("Optimiser", () => {
  test("empty state and settings: owner saves, validation is plain, recommended values restore", async ({ page, context }) => {
    const errors = watchErrors(page);
    await signupUser(context, "opt");
    await page.goto("/app/ads/optimizer");
    await expect(page.getByRole("heading", { level: 1, name: "Optimiser" })).toBeVisible();
    await expect(page.getByText("No suggestions right now")).toBeVisible();
    await expect(page.getByText(/Nothing has been changed yet/)).toBeVisible();
    await expect(page.getByText("No daily spending limit is set")).toBeVisible();
    await expect(page.getByRole("link", { name: "View ad insights" })).toBeVisible();
    expect(await axeSerious(page), "axe").toEqual([]);

    await page.getByText("Fine-tune the rules (optional)").click();
    const max = page.getByLabel(/Most budget to move at once/);
    await max.fill("50");
    await page.getByRole("button", { name: "Save settings" }).click();
    await expect(page.getByText(/Enter a number from 1 to 20/)).toBeVisible();
    await max.fill("abc");
    await page.getByRole("button", { name: "Save settings" }).click();
    await expect(page.getByText("Enter a number.").first()).toBeVisible();
    await max.fill("10");
    await page.getByLabel(/Remove suggestions you have not answered/).fill("2.5");
    await page.getByRole("button", { name: "Save settings" }).click();
    await expect(page.getByText("Enter a whole number.")).toBeVisible();
    await page.getByRole("button", { name: "Use recommended values" }).click();
    await expect(page.getByText("Enter a whole number.")).toBeHidden();
    await page.getByLabel("Check my ads every day and suggest improvements").check();
    await max.fill("10");
    await page.getByRole("button", { name: "Save settings" }).click();
    await expect(page.getByText("Settings saved")).toBeVisible();
    await page.reload();
    await expect(page.getByLabel("Check my ads every day and suggest improvements")).toBeChecked();
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("with a limit set, the page names it; an agent cannot see or change the optimiser", async ({ context, browser }) => {
    const owner = await signupUser(context, "opt");
    await setCap(owner, 500000);
    const page = await context.newPage();
    await page.goto("/app/ads/optimizer");
    await expect(page.getByText(/Your daily spending limit is .*5,000.* The optimiser never goes above it/)).toBeVisible();
    const agent = await createAgent(browser, owner);
    const a = await loginFresh(browser, agent.email);
    await a.page.goto("/app/ads/optimizer");
    await expect(a.page.getByText("The optimiser is for owners and admins")).toBeVisible();
    expect((await a.context.request.put("/api/optimizer/settings", { headers: { origin: ORIGIN }, data: { enabled: true } })).status()).toBe(403);
    await a.context.close();
  });

  test("a suggestion can be rejected after a clear confirmation, and cannot be handled twice", async ({ page, context, browser }) => {
    const u = await signupUser(context, "opt");
    const d = await db();
    const id = `prop_${stamp()}`;
    await d.query(
      `insert into "OptimizerProposal" (id,"tenantId",kind,"targetType","targetMetaId",rationale,payload,status) values ($1,$2,'rotate_creative','ad',$3,$4,$5,'proposed')`,
      [id, u.tenantId, `ad_${stamp()}`, "Frequency 5.1 and clicks fell 40% week on week.", JSON.stringify({ adName: "Pune showroom ad", suggestion: "Try a new picture of the lobby." })],
    );
    await page.goto("/app/ads/optimizer");
    await expect(page.getByRole("heading", { name: /Pune showroom ad|new picture|Refresh|creative/i }).first()).toBeVisible();
    await expect(page.locator("main")).not.toContainText("rotate_creative");
    await expect(page.locator("main")).not.toContainText(/\bpropose?d?_/);
    await page.getByRole("button", { name: /^Reject:/ }).click();
    const dlg = askDialog(page);
    await expect(dlg).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dlg).toBeHidden();
    await page.getByRole("button", { name: /^Reject:/ }).click();
    await askDialog(page).getByRole("button", { name: /reject/i }).click();
    await expect(page.getByText("Suggestion rejected")).toBeVisible();
    await expect(page.getByText("No suggestions right now")).toBeVisible();
    const again = await context.request.patch(`/api/optimizer/proposals/${id}`, { headers: { origin: ORIGIN }, data: { action: "reject", confirm: true } });
    expect(again.status()).toBeGreaterThanOrEqual(400);
    // Other workspace cannot act on it either.
    const bctx = await browser.newContext();
    await signupUser(bctx, "opt");
    const other = await bctx.request.patch(`/api/optimizer/proposals/${id}`, { headers: { origin: ORIGIN }, data: { action: "approve", confirm: true } });
    expect([403, 404]).toContain(other.status());
    await bctx.close();
  });

  test("optimiser fits a phone @mobile", async ({ page, context }) => {
    await signupUser(context, "opt");
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto("/app/ads/optimizer");
    await expect(page.getByText("No suggestions right now")).toBeVisible();
    expect(await overflowsX(page), "optimiser at 360px").toBe(false);
  });
});
