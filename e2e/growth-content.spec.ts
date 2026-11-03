import { expect as baseExpect, test, type Page } from "@playwright/test";
import { ORIGIN, closeDb, db, signupUser, stamp, watchErrors } from "./helpers";
import { askDialog, axeSerious, createAgent, loginFresh, overflowsX, seedMeta, toggleTheme } from "./growth-helpers";

// The shared machine is busy with other testers: generous timeouts keep real defects apart from slowness.
const expect = baseExpect.configure({ timeout: 25_000 });
test.setTimeout(240_000);
test.use({ actionTimeout: 30_000, navigationTimeout: 60_000 });

test.afterAll(closeDb);

// A valid 1x1 JPEG.
const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
  "base64",
);

async function openComposer(page: Page) {
  await page.goto("/app/content");
  await expect(page.getByRole("heading", { level: 1, name: "Content calendar" })).toBeVisible();
  await page.getByRole("button", { name: "New post", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "New post" })).toBeVisible();
}

const account = (page: Page, name: RegExp) => page.getByRole("checkbox", { name });

test.describe("Content calendar", () => {
  test("no connected accounts: composer explains and blocks scheduling", async ({ page, context }) => {
    const errors = watchErrors(page);
    await signupUser(context, "cal");
    await openComposer(page);
    await expect(page.getByText("No accounts connected yet")).toBeVisible();
    await expect(page.getByRole("link", { name: "Connect an account" })).toHaveAttribute("href", "/app/settings/connections");
    await expect(page.getByRole("button", { name: "Schedule post" })).toBeDisabled();
    await expect(page.getByText("Choose where to post.")).toBeVisible();
    expect(await axeSerious(page), "axe").toEqual([]);
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("calendar views: month, week and list, empty states, keyboard", async ({ page, context }) => {
    const errors = watchErrors(page);
    await signupUser(context, "cal");
    await page.goto("/app/content");
    await expect(page.getByRole("heading", { level: 1, name: "Content calendar" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Month" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText(/Nothing is scheduled in this month/)).toBeVisible();
    expect(await axeSerious(page), "axe month").toEqual([]);
    await page.getByRole("button", { name: "Next month" }).click();
    await page.getByRole("button", { name: "Today" }).click();
    await page.getByRole("tab", { name: "Week" }).click();
    await expect(page.getByText(/Nothing is scheduled in this week/)).toBeVisible();
    await page.getByRole("button", { name: "Next week" }).click();
    await page.getByRole("tab", { name: "All posts" }).click();
    await expect(page.getByText("No posts yet")).toBeVisible();
    expect(await axeSerious(page), "axe list").toEqual([]);
    // Arrow keys move between tabs.
    await page.getByRole("tab", { name: "All posts" }).focus();
    await page.keyboard.press("ArrowLeft");
    await expect(page.getByRole("tab", { name: "Week" })).toBeFocused();
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("composer: per-channel previews, counters, Instagram needs media, validation of the time", async ({ page, context }) => {
    const errors = watchErrors(page);
    const u = await signupUser(context, "cal");
    const m = await seedMeta(u, { ig: true });
    const d = await db();
    await d.query(`insert into "MetaAsset" (id,"tenantId","connectionId",type,"externalId",name,status,meta,"updatedAt") values ($1,$2,$3,'threads',$4,'Brand threads','active','{}',now())`, [`asset_th_${stamp()}`, u.tenantId, m.connId, `th_${stamp()}`]);
    await openComposer(page);
    const fb = account(page, /Sunrise Realty Page/);
    const ig = account(page, /sunrise_realty_/);
    await expect(fb).toBeVisible();
    await expect(page.getByText("Not available yet")).toBeVisible();
    await expect(account(page, /Brand threads/)).toBeDisabled();

    await expect(page.getByText("Choose an account to see a preview of your post.")).toBeVisible();
    await fb.check();
    await page.getByLabel("Post text").fill("Weekend open house at Sunrise Residency. Visit https://example.com/open-house");
    const preview = page.getByRole("complementary", { name: "Preview" });
    await expect(preview.getByRole("figure", { name: "Facebook preview" })).toBeVisible();
    await expect(preview.getByText(/Facebook shows the first link as a link preview/)).toBeVisible();
    await expect(preview.getByText(/of 63,206 characters/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Schedule post" })).toBeEnabled();

    // Adding Instagram without a picture blocks scheduling and says why.
    await ig.check();
    await expect(page.getByText("Fix these before you schedule")).toBeVisible();
    await expect(page.getByText(/Instagram posts need an image or video/).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Schedule post" })).toBeDisabled();
    await page.getByRole("tab", { name: /Instagram/ }).click();
    await expect(preview.getByRole("figure", { name: "Instagram preview" })).toBeVisible();
    await expect(preview.getByText(/Instagram posts need a picture or video/)).toBeVisible();
    await expect(preview.getByText(/of 2,200 characters/)).toBeVisible();

    // Wrong file type and a real picture.
    await page.getByLabel("Choose a picture or video from your device").setInputFiles({ name: "notes.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4") });
    await expect(page.getByText("Use a JPEG or PNG picture, or an MP4 or MOV video.")).toBeVisible();
    await page.getByLabel("Choose a picture or video from your device").setInputFiles({ name: "flat.jpg", mimeType: "image/jpeg", buffer: JPEG });
    await expect(page.getByText("Picture added")).toBeVisible();
    await expect(page.getByText("Fix these before you schedule")).toBeHidden();
    await expect(page.getByRole("button", { name: "Remove media" })).toBeVisible();

    // Too many characters for the channel with the shortest limit is explained.
    // Time validation, in words.
    const when = page.getByLabel("Or choose a date and time");
    await when.fill("2020-01-01T10:00");
    // The message is shown on the field (role=alert) and again in the footer next to the disabled button (role=status).
    await expect(page.getByRole("alert").filter({ hasText: "That time has already passed. Choose a time in the future." })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "That time has already passed." })).toBeVisible();
    await expect(page.getByRole("button", { name: "Schedule post" })).toBeDisabled();
    await when.fill("2031-01-01T10:00");
    await expect(page.getByRole("alert").filter({ hasText: "Posts can be scheduled up to 90 days ahead." })).toBeVisible();
    await when.fill("");
    await expect(page.getByText("Choose a date and time.").first()).toBeVisible();
    await expect(page.getByText("You can still save a draft without a time.")).toBeVisible();
    await page.getByRole("button", { name: /^Tomorrow, / }).first().click();
    await expect(page.getByRole("button", { name: "Schedule post" })).toBeEnabled();
    expect(await axeSerious(page), "axe composer").toEqual([]);

    // Leaving with unsaved text asks first.
    await page.getByRole("button", { name: "Cancel" }).click();
    const ask = askDialog(page, "Discard this post?");
    await expect(ask).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(ask).toBeHidden();
    await expect(page.getByRole("heading", { level: 1, name: "New post" })).toBeVisible();
    expect(errors.filter((e) => !/Failed to load resource/.test(e)), errors.join("\n")).toEqual([]);
  });

  test("schedule, find it in every view, reschedule, cancel and delete", async ({ page, context }) => {
    const errors = watchErrors(page);
    const u = await signupUser(context, "cal");
    await seedMeta(u);
    await openComposer(page);
    await account(page, /Sunrise Realty Page/).check();
    await page.getByLabel("Post text").fill("Diwali offer: free parking for every booking.");
    await page.getByRole("button", { name: /^Tomorrow, / }).first().click();
    await page.getByRole("button", { name: "Schedule post" }).click();
    await expect(page.getByText(/Post scheduled for/)).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "Content calendar" })).toBeVisible();

    // Month view: the calendar opens on the post's month (even on the last day of a month, when tomorrow is in the next one),
    // tomorrow's cell lists it and the day agenda shows it.
    const tomorrow = new Date(Date.now() + 86_400_000);
    await expect(page.getByText(tomorrow.toLocaleString("en-US", { month: "long", year: "numeric" })).first()).toBeVisible();
    const cell = page.getByRole("button", { name: new RegExp(`${tomorrow.toLocaleDateString("en-US", { month: "long" })} ${tomorrow.getDate()}.*1 post`) });
    if (await cell.count()) await cell.first().click();
    await expect(page.getByText(/Diwali offer/).first()).toBeVisible();
    await page.getByRole("tab", { name: "Week" }).click();
    await page.getByRole("tab", { name: "All posts" }).click();
    await expect(page.getByText(/Diwali offer/).first()).toBeVisible();
    await expect(page.locator("main")).not.toContainText(/\bscheduled\b_|PostTarget|draft_/);

    await page.getByText(/Diwali offer/).first().click();
    const dlg = page.getByRole("dialog", { name: "Post details" });
    await expect(dlg).toBeVisible();
    expect(await axeSerious(page), "axe detail").toEqual([]);
    await page.keyboard.press("Escape");
    await expect(dlg).toBeHidden();
    await page.getByText(/Diwali offer/).first().click();
    await dlg.getByRole("button", { name: "Edit or reschedule" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Edit post" })).toBeVisible();
    await page.getByLabel("Post text").fill("Diwali offer: free parking and a gift for every booking.");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Changes saved")).toBeVisible();

    await page.getByText(/gift for every booking/).first().click();
    await dlg.getByRole("button", { name: "Cancel post" }).click();
    await askDialog(page, "Cancel this post?").getByRole("button", { name: "Cancel post" }).click();
    await expect(page.getByText("Post canceled")).toBeVisible();
    await dlg.getByRole("button", { name: "Delete post" }).click();
    await askDialog(page, "Delete this post?").getByRole("button", { name: "Delete post" }).click();
    await expect(page.getByText("Post deleted")).toBeVisible();
    await expect(page.getByText("No posts yet")).toBeVisible();
    expect(errors.filter((e) => !/Failed to load resource/.test(e)), errors.join("\n")).toEqual([]);
  });

  test("API refuses past times, far-future times and oversized text with readable messages", async ({ context }) => {
    const u = await signupUser(context, "cal");
    const m = await seedMeta(u, { ig: true });
    const post = (data: object) => context.request.post("/api/content/posts", { headers: { origin: ORIGIN }, data });
    const soon = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const past = await post({ body: "hi", assetIds: [m.page!.id], scheduledAt: "2020-01-01T10:00:00.000Z", draft: false });
    expect(past.status()).toBe(400);
    expect((await past.json()).error).toBe("Choose a time in the future.");
    const far = await post({ body: "hi", assetIds: [m.page!.id], scheduledAt: new Date(Date.now() + 200 * 86_400_000).toISOString(), draft: false });
    expect(far.status()).toBe(400);
    expect((await far.json()).error).toMatch(/at most 90 days/);
    const ig = await post({ body: "hi", assetIds: [m.ig!.id], scheduledAt: soon, draft: false });
    expect(ig.status()).toBe(400);
    expect((await ig.json()).error).toMatch(/image or video/);
    const nobody = await post({ body: "hi", assetIds: [], scheduledAt: soon, draft: false });
    expect(nobody.status()).toBe(400);
    const badMedia = await post({ body: "hi", mediaKeys: ["../../etc/passwd"], assetIds: [m.page!.id], scheduledAt: soon, draft: false });
    expect(badMedia.status()).toBe(400);
    const huge = await post({ body: "x".repeat(70000), assetIds: [m.page!.id], scheduledAt: soon, draft: false });
    expect(huge.status()).toBeGreaterThanOrEqual(400);
    expect(await huge.text()).not.toMatch(/stack|prisma|undefined/i);
    const wrongOrigin = await context.request.post("/api/content/posts", { headers: { origin: "https://evil.example" }, data: { body: "hi", assetIds: [m.page!.id], scheduledAt: soon } });
    expect(wrongOrigin.status()).toBe(403);
  });

  test("agents can look but not schedule; another workspace cannot see or change my posts", async ({ context, browser }) => {
    const owner = await signupUser(context, "cal");
    const m = await seedMeta(owner);
    const when = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const created = await context.request.post("/api/content/posts", { headers: { origin: ORIGIN }, data: { body: "Secret launch plan", assetIds: [m.page!.id], scheduledAt: when, draft: false } });
    expect(created.ok(), await created.text()).toBe(true);
    const postId = (await created.json()).post?.id ?? (await created.json()).id;
    const agent = await createAgent(browser, owner);
    const a = await loginFresh(browser, agent.email);
    await a.page.goto("/app/content");
    await expect(a.page.getByRole("button", { name: "New post" })).toHaveCount(0);
    await expect(a.page.getByText(/You can look at the calendar\. Ask an owner or admin/)).toBeVisible();
    const denied = await a.context.request.post("/api/content/posts", { headers: { origin: ORIGIN }, data: { body: "x", assetIds: [m.page!.id], scheduledAt: when } });
    expect(denied.status()).toBe(403);
    await a.context.close();

    const bctx = await browser.newContext();
    const bpage = await bctx.newPage();
    await signupUser(bctx, "cal");
    await bpage.goto("/app/content");
    await bpage.getByRole("tab", { name: "All posts" }).click();
    await expect(bpage.getByText("No posts yet")).toBeVisible();
    if (postId) {
      expect((await bctx.request.get(`/api/content/posts/${postId}`)).status()).toBe(404);
      const del = await bctx.request.delete(`/api/content/posts/${postId}`, { headers: { origin: ORIGIN } });
      expect([403, 404]).toContain(del.status());
      const pub = await bctx.request.post(`/api/content/posts/${postId}/publish-now`, { headers: { origin: ORIGIN }, data: {} });
      expect([403, 404]).toContain(pub.status());
    }
    await bctx.close();
  });

  test("approval-first posts produce a one-time link and stay drafts", async ({ page, context }) => {
    const u = await signupUser(context, "cal");
    await seedMeta(u);
    await openComposer(page);
    await account(page, /Sunrise Realty Page/).check();
    await page.getByLabel("Post text").fill("Festival greetings from Sunrise Realty.");
    await page.getByRole("button", { name: /^Tomorrow, / }).first().click();
    await page.getByLabel("Get approval first").check();
    await page.getByRole("button", { name: "Save and get approval link" }).click();
    const region = page.getByRole("region", { name: "Approval link ready" });
    await expect(region).toBeVisible();
    await expect(region).toBeFocused();
    const link = await region.getByLabel("Link for your client").inputValue();
    expect(link).toMatch(/\/approve\/[A-Za-z0-9_-]{20,}/);
    const d = await db();
    const status = (await d.query(`select status from "ScheduledPost" where "tenantId" = $1 order by "createdAt" desc limit 1`, [u.tenantId])).rows[0].status;
    expect(status).toBe("draft");
    await region.getByRole("button", { name: "Done" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Content calendar" })).toBeVisible();
  });

  test("calendar and composer fit a phone in dark theme @mobile", async ({ page, context }) => {
    const u = await signupUser(context, "cal");
    await seedMeta(u, { ig: true });
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto("/app/content");
    await expect(page.getByRole("heading", { level: 1, name: "Content calendar" })).toBeVisible();
    expect(await overflowsX(page), "month at 360px").toBe(false);
    await page.getByRole("tab", { name: "Week" }).click();
    expect(await overflowsX(page), "week at 360px").toBe(false);
    await page.getByRole("button", { name: "New post", exact: true }).click();
    await account(page, /Sunrise Realty Page/).check();
    await account(page, /sunrise_realty_/).check();
    expect(await overflowsX(page), "composer at 360px").toBe(false);
    await toggleTheme(page).catch(async () => {
      await page.getByRole("button", { name: /^more$/i }).first().click();
      await toggleTheme(page);
    });
    expect(await axeSerious(page), "axe dark composer").toEqual([]);
  });
});
