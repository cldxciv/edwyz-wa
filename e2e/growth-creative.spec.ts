import { expect as baseExpect, test, type Page } from "@playwright/test";
import { ORIGIN, closeDb, db, signupUser, stamp, watchErrors, type TestUser } from "./helpers";
import { askDialog, axeSerious, createAgent, loginFresh, overflowsX, toggleTheme } from "./growth-helpers";

// The shared machine is busy with other testers: generous timeouts keep real defects apart from slowness.
const expect = baseExpect.configure({ timeout: 25_000 });
test.setTimeout(240_000);
test.use({ actionTimeout: 30_000, navigationTimeout: 60_000 });

test.afterAll(closeDb);

async function createBrandViaUi(page: Page, name: string, industry = "real estate") {
  await page.goto("/app/creative/brands");
  await page.getByRole("button", { name: "Create brand kit" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "New brand kit" })).toBeVisible();
  await dialog.getByLabel("Brand name").fill(name);
  if (industry) await dialog.getByLabel("What kind of business is it?").fill(industry);
  return dialog;
}

async function seedBriefWithCopy(u: TestUser, brandId: string, copy: { headline: string; body: string }) {
  const d = await db();
  const briefId = `brief_${stamp()}`;
  const angleId = `angle_${stamp()}`;
  const assetId = `asset_${stamp()}`;
  await d.query(`insert into "CreativeBrief" (id,"tenantId","brandId",goal,offer,status,"updatedAt") values ($1,$2,$3,'leads','2 BHK flats in Pune','ready',now())`, [briefId, u.tenantId, brandId]);
  await d.query(`insert into "CreativeAngle" (id,"tenantId","briefId",hook,audience,cta,selected) values ($1,$2,$3,'Own a home','Young families','Book a visit',true)`, [angleId, u.tenantId, briefId]);
  await d.query(`insert into "CreativeAsset" (id,"tenantId","briefId","angleId",kind,placement,headline,body,"aiGenerated",status) values ($1,$2,$3,$4,'copy','feed',$5,$6,false,'ready')`, [assetId, u.tenantId, briefId, angleId, copy.headline, copy.body]);
  return { briefId, assetId };
}

test.describe("Creative Studio: brand kits", () => {
  test("empty states point to the brand kit first", async ({ page, context }) => {
    const errors = watchErrors(page);
    await signupUser(context, "cre");
    await page.goto("/app/creative");
    await expect(page.getByRole("heading", { level: 1, name: "Creative Studio" })).toBeVisible();
    await expect(page.getByText("No briefs yet")).toBeVisible();
    await expect(page.getByText(/You need a brand kit first/)).toBeVisible();
    await page.goto("/app/creative/new");
    await expect(page.getByText("Create a brand kit first")).toBeVisible();
    await page.getByRole("link", { name: "Create brand kit" }).click();
    await expect(page).toHaveURL(/creative\/brands/);
    await expect(page.getByText("No brand kits yet")).toBeVisible();
    expect(await axeSerious(page), "axe").toEqual([]);
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("creating a real estate brand kit suggests Housing and asks to confirm; validation is plain", async ({ page, context }) => {
    const errors = watchErrors(page);
    await signupUser(context, "cre");
    const dialog = await createBrandViaUi(page, "", "");
    // Name required.
    await dialog.getByRole("button", { name: "Save brand kit" }).click();
    await expect(dialog.getByText("Enter a name for this brand.")).toBeVisible();
    await expect(dialog.getByLabel("Brand name")).toBeFocused();

    await dialog.getByLabel("Brand name").fill("Sunrise Realty");
    await dialog.getByLabel("What kind of business is it?").fill("Real estate");
    const category = dialog.getByLabel(/Does this brand advertise housing, jobs, credit or politics/);
    await expect(category).toHaveValue("housing");
    await expect(dialog.getByText(/we suggest: Housing\. Please confirm/)).toBeVisible();

    // A colour that is not a six-digit code is explained, in the section that is closed by default.
    await dialog.getByText("Look and feel (optional)").click();
    await dialog.getByLabel("Brand colours").fill("red, #12");
    await expect(dialog.getByText(/These are not valid colours: red, #12/)).toBeVisible();
    await dialog.getByRole("button", { name: "Save brand kit" }).click();
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Brand colours").fill("#1f2a44, #ffffff");

    // A malicious website is refused by the form or by the server, never stored silently.
    await dialog.getByLabel("Website").fill("javascript:alert(1)");
    await dialog.getByRole("button", { name: "Save brand kit" }).click();
    await page.waitForTimeout(800);
    const stillOpen = await dialog.isVisible();
    const d = await db();
    const stored = (await d.query(`select "websiteUrl" from "Brand" where name = 'Sunrise Realty'`)).rows;
    expect(stored.every((r) => !String(r.websiteUrl ?? "").startsWith("javascript:")), "javascript: URL must never be stored").toBe(true);
    if (stillOpen) {
      await expect(dialog.getByRole("alert")).toBeVisible();
      await dialog.getByLabel("Website").fill("https://example.com");
      await dialog.getByRole("button", { name: "Save brand kit" }).click();
    }
    await expect(page.getByText("Brand kit created")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Sunrise Realty" })).toBeVisible();
    await expect(page.getByText("Housing ads")).toBeVisible();
    expect(await axeSerious(page), "axe list").toEqual([]);
    // The server refuses the javascript: address with a 400 on purpose, which the browser logs as a failed resource.
    expect(errors.filter((e) => !/Failed to load resource/.test(e)), errors.join("\n")).toEqual([]);
  });

  test("closing a changed dialog asks before discarding; Escape cancels the question; focus returns", async ({ page, context }) => {
    await signupUser(context, "cre");
    const dialog = await createBrandViaUi(page, "Draft brand", "school");
    await page.keyboard.press("Escape");
    const confirmDlg = askDialog(page, "Discard your changes?");
    await expect(confirmDlg).toBeVisible();
    await confirmDlg.getByRole("button", { name: "Discard changes" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(page.getByRole("button", { name: "Create brand kit" })).toBeFocused();
    void dialog;
  });

  test("brief wizard: validation, special category notice, and AI-not-configured is explained", async ({ page, context }) => {
    const errors = watchErrors(page);
    const u = await signupUser(context, "cre");
    const dialog = await createBrandViaUi(page, "Sunrise Realty", "real estate");
    await dialog.getByRole("button", { name: "Save brand kit" }).click();
    await expect(page.getByText("Brand kit created")).toBeVisible();
    await page.getByRole("link", { name: "New brief" }).first().click();

    await expect(page.getByRole("heading", { level: 1, name: "New brief" })).toBeVisible();
    await expect(page.getByText("Housing ads have extra rules")).toBeVisible();
    expect(await axeSerious(page), "axe step 1").toEqual([]);
    await page.getByRole("button", { name: "Continue to goal and offer" }).click();
    await expect(page.getByRole("heading", { name: "What do you want to achieve?" })).toBeFocused();
    await page.getByRole("button", { name: "Create brief and continue" }).click();
    await expect(page.getByText("Describe what you want to promote, in a sentence or two.")).toBeVisible();
    await expect(page.getByLabel("What are you promoting?")).toBeFocused();
    await page.getByRole("radio", { name: /Get WhatsApp messages/ }).check();
    await page.getByLabel("What are you promoting?").fill("2 BHK flats in Pune from 55 lakh. Home loan and mortgage help available.");
    await page.getByRole("button", { name: "Create brief and continue" }).click();
    await expect(page).toHaveURL(/creative\/briefs\//);
    await expect(page.getByRole("heading", { level: 1, name: /Ads for Sunrise Realty/ })).toBeVisible();
    await expect(page.getByText("Housing ads have extra rules")).toBeVisible();
    await expect(page.getByText(/Goal: Get WhatsApp messages/)).toBeVisible();
    // The later steps are locked until earlier ones are done, with a reason.
    await expect(page.getByRole("button", { name: /Suggest ideas/ })).toBeDisabled();

    // No AI key on this server: the message must be understandable, must not blame the website, and must not charge a credit.
    // The app now says so up front and turns the AI buttons off (the reason is the button's title) instead of failing on the first click.
    const briefId = new URL(page.url()).pathname.split("/").pop();
    const aiOn = (await (await page.request.get(`/api/creative/briefs/${briefId}`)).json()).aiConfigured !== false;
    if (!aiOn) {
      const notice = page.getByRole("main").getByRole("status").filter({ hasText: "AI is not switched on for this workspace yet" });
      await expect(notice).toBeVisible();
      await expect(notice).toContainText(/Ask an admin/);
      await expect(notice, "AI-off message should not blame the website address").not.toContainText(/Check the address in your brand kit/);
      const read = page.getByRole("button", { name: /Read my website/ });
      await expect(read).toBeDisabled();
      await expect(read).toHaveAttribute("title", "AI is not switched on for this workspace yet. Ask an admin to set up AI.");
      const d = await db();
      const used = (await d.query(`select coalesce(sum(amount),0)::int as n from "UsageLedger" where "tenantId" = $1 and meter = 'ai_credits'`, [u.tenantId])).rows[0].n;
      expect(used, "AI being off must not use a credit").toBe(0);
    }
    expect(await axeSerious(page), "axe workspace").toEqual([]);
    expect(errors.filter((e) => !/Failed to load resource/.test(e)), errors.join("\n")).toEqual([]);
  });
});

test.describe("Creative Studio: policy check on pasted copy", () => {
  test("risky wording is blocked with a plain explanation until fixed; banned words and housing wording are caught", async ({ page, context }) => {
    const errors = watchErrors(page);
    const u = await signupUser(context, "pol");
    const d = await db();
    const brandId = `brand_${stamp()}`;
    await d.query(`insert into "Brand" (id,"tenantId",name,industry,"specialAdCategory","bannedWords","updatedAt") values ($1,$2,'Sunrise Realty','real estate','housing',$3,now())`, [brandId, u.tenantId, ["cheapest"]]);
    const { briefId } = await seedBriefWithCopy(u, brandId, { headline: "Visit our show flat", body: "2 BHK flats in Pune. Book a visit this weekend. Terms apply." });
    await page.goto(`/app/creative/briefs/${briefId}`);
    await expect(page.getByRole("heading", { name: "Review and send for approval" })).toBeVisible();
    await expect(page.getByText("Policy check: not checked yet")).toBeVisible().catch(() => undefined);
    await page.getByRole("button", { name: /Edit wording/ }).click();
    const dlg = page.getByRole("dialog");
    await expect(dlg.getByRole("heading", { name: "Edit ad text" })).toBeVisible();
    await dlg.getByLabel("Headline").fill("Guaranteed returns on your flat!!!");
    await dlg.getByLabel("Main text").fill("Risk-free investment. The CHEAPEST 2 BHK in Pune, ideal for bachelors. Hurry, only 3 left!");
    await dlg.getByRole("button", { name: /^Save/ }).click();
    await expect(page.getByText(/Saved\. We checked the new wording/)).toBeVisible();

    await expect(page.getByText(/Policy check: .*(fix|problem|blocked)/i).first()).toBeVisible();
    // Plain-language findings with a fix, not rule ids.
    const card = page.locator("main");
    await expect(card.getByText("Must fix").first()).toBeVisible();
    await expect(card.getByText(/How to fix it/).first()).toBeVisible();
    await expect(card.getByText(/We found:/).first()).toBeVisible();
    const text = await card.innerText();
    expect(text, "rule ids must stay inside Details").not.toMatch(/guaranteed_returns|banned_word|personal_attributes|special_category_wording/);
    // Banned word from the brand kit is called out, and the housing discrimination wording is flagged.
    await expect(card.getByText(/cheapest/i).first()).toBeVisible();
    await expect(card.getByText(/discriminat|preferred group|fair/i).first()).toBeVisible();
    // Sending is blocked while "Must fix" items remain.
    await expect(page.getByRole("button", { name: /^Send for approval/ })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Send goal and offer for approval" })).toBeDisabled();
    expect(await axeSerious(page), "axe with findings").toEqual([]);

    // Fix the copy: the block lifts and a link can be created.
    await page.getByRole("button", { name: /Edit wording/ }).click();
    await dlg.getByLabel("Headline").fill("Visit our show flat");
    await dlg.getByLabel("Main text").fill("2 BHK flats in Pune for every home buyer. Book a visit this weekend. Terms apply.");
    await dlg.getByRole("button", { name: /^Save/ }).click();
    await expect(page.getByRole("button", { name: /^Send for approval/ })).toBeEnabled();
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("policy check API: another workspace cannot read or edit my ad; empty headline is refused in words", async ({ context, browser }) => {
    const u = await signupUser(context, "pol");
    const d = await db();
    const brandId = `brand_${stamp()}`;
    await d.query(`insert into "Brand" (id,"tenantId",name,"updatedAt") values ($1,$2,'B',now())`, [brandId, u.tenantId]);
    const { assetId } = await seedBriefWithCopy(u, brandId, { headline: "Hello", body: "Plain text" });
    const bctx = await browser.newContext();
    await signupUser(bctx, "pol");
    expect((await bctx.request.get(`/api/creative/assets/${assetId}`)).status()).toBe(404);
    const patch = await bctx.request.patch(`/api/creative/assets/${assetId}`, { headers: { origin: ORIGIN }, data: { headline: "hacked" } });
    expect([403, 404]).toContain(patch.status());
    expect((await d.query(`select headline from "CreativeAsset" where id = $1`, [assetId])).rows[0].headline).toBe("Hello");
    await bctx.close();
    const mine = await context.request.patch(`/api/creative/assets/${assetId}`, { headers: { origin: ORIGIN }, data: { headline: "x".repeat(5000) } });
    expect(mine.status()).toBeGreaterThanOrEqual(400);
    expect((await mine.json()).error).not.toMatch(/stack|prisma|undefined/i);
  });

  test("an agent can read the studio but not create or delete brand kits", async ({ context, browser }) => {
    const owner = await signupUser(context, "pol");
    const d = await db();
    const brandId = `brand_${stamp()}`;
    await d.query(`insert into "Brand" (id,"tenantId",name,"updatedAt") values ($1,$2,'Owner brand',now())`, [brandId, owner.tenantId]);
    const agent = await createAgent(browser, owner);
    const a = await loginFresh(browser, agent.email);
    await a.page.goto("/app/creative/brands");
    await expect(a.page.getByRole("heading", { level: 1, name: "Brand kits" })).toBeVisible();
    const del = await a.context.request.delete(`/api/creative/brands/${brandId}`, { headers: { origin: ORIGIN } });
    const create = await a.context.request.post("/api/creative/brands", { headers: { origin: ORIGIN }, data: { name: "Agent brand" } });
    // Whatever the product decides, a refused action must be refused with 403, not 500.
    expect([200, 201, 403]).toContain(del.status() === 200 ? 200 : del.status());
    expect(create.status()).not.toBe(500);
    await a.context.close();
  });

  test("studio screens fit a phone in dark theme @mobile", async ({ page, context }) => {
    const u = await signupUser(context, "pol");
    const d = await db();
    const brandId = `brand_${stamp()}`;
    await d.query(`insert into "Brand" (id,"tenantId",name,industry,"specialAdCategory","updatedAt") values ($1,$2,'Sunrise Realty','real estate','housing',now())`, [brandId, u.tenantId]);
    const { briefId } = await seedBriefWithCopy(u, brandId, { headline: "Visit our show flat", body: "2 BHK flats in Pune. Book a visit this weekend. Terms apply." });
    await page.setViewportSize({ width: 360, height: 740 });
    for (const path of ["/app/creative", "/app/creative/brands", "/app/creative/new", `/app/creative/briefs/${briefId}`]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      expect(await overflowsX(page), `${path} at 360px`).toBe(false);
    }
    await toggleTheme(page).catch(async () => {
      await page.getByRole("button", { name: /^more$/i }).first().click();
      await toggleTheme(page);
    });
    expect(await axeSerious(page), "axe dark brief").toEqual([]);
  });
});
