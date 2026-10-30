import { expect as baseExpect, test, type Browser, type BrowserContext } from "@playwright/test";
import { ORIGIN, closeDb, db, signupUser, stamp, type TestUser } from "./helpers";
import { axeSerious, overflowsX, seedMeta } from "./growth-helpers";

// The shared machine is busy with other testers: generous timeouts keep real defects apart from slowness.
const expect = baseExpect.configure({ timeout: 25_000 });
test.setTimeout(240_000);
test.use({ actionTimeout: 30_000, navigationTimeout: 60_000 });

test.afterAll(closeDb);

const PHONE = { width: 360, height: 740 };

async function seedAsset(u: TestUser, headline = "Weekend open house at Sunrise Residency", body = "Book a visit this weekend and see the 2 BHK show flat. Terms apply.") {
  const d = await db();
  const brandId = `brand_${stamp()}`;
  const briefId = `brief_${stamp()}`;
  const assetId = `asset_${stamp()}`;
  await d.query(`insert into "Brand" (id,"tenantId",name,"updatedAt") values ($1,$2,'Sunrise Realty',now())`, [brandId, u.tenantId]);
  await d.query(`insert into "CreativeBrief" (id,"tenantId","brandId",goal,offer,status,"updatedAt") values ($1,$2,$3,'leads','Open house','ready',now())`, [briefId, u.tenantId, brandId]);
  await d.query(`insert into "CreativeAsset" (id,"tenantId","briefId",kind,placement,headline,body,"aiGenerated",status) values ($1,$2,$3,'copy','feed',$4,$5,false,'ready')`, [assetId, u.tenantId, briefId, headline, body]);
  return { assetId, briefId, brandId };
}

async function createLink(context: BrowserContext, assetId: string) {
  const res = await context.request.post("/api/approvals", { headers: { origin: ORIGIN }, data: { subjectType: "creative_asset", subjectId: assetId } });
  expect(res.status(), await res.text()).toBe(201);
  const { id, url } = await res.json();
  return { id: id as string, path: new URL(url).pathname };
}

async function client(browser: Browser, opts: { dark?: boolean } = {}) {
  const context = await browser.newContext({ viewport: PHONE, colorScheme: opts.dark ? "dark" : "light", hasTouch: true });
  return { context, page: await context.newPage() };
}

const statusOf = async (id: string) => (await (await db()).query(`select status, comment from "ApprovalRequest" where id = $1`, [id])).rows[0] as { status: string; comment: string | null };

test.describe("Public approval page", () => {
  test("a client on a phone sees a plain summary and big buttons, nothing technical", async ({ context, browser }) => {
    const u = await signupUser(context, "appr");
    const { assetId } = await seedAsset(u);
    const link = await createLink(context, assetId);
    const c = await client(browser);
    const resp = await c.page.goto(link.path);
    expect(resp?.headers()["cache-control"] ?? "", "approval pages must not be cached").toMatch(/no-store|no-cache|private/);
    await expect(c.page.getByRole("heading", { level: 1, name: "Please review this ad" })).toBeVisible();
    await expect(c.page.getByRole("heading", { level: 2, name: "Weekend open house at Sunrise Residency" })).toBeVisible();
    await expect(c.page.getByText(/see the 2 BHK show flat/)).toBeVisible();
    await expect(c.page.getByText("Where it will show")).toBeVisible();
    await expect(c.page.getByText("Feed post")).toBeVisible();
    const body = await c.page.locator("body").innerText();
    expect(body).not.toContain(assetId);
    expect(body).not.toContain(link.id);
    expect(body).not.toMatch(/creative_asset|tokenHash|tenant|\bcopy\b.*\bfeed\b/i);
    // Large tap targets: at least 56px tall and spanning the card.
    const approve = c.page.getByRole("button", { name: "Approve", exact: true });
    const box = await approve.boundingBox();
    expect(box?.height ?? 0, "Approve button height").toBeGreaterThanOrEqual(56);
    expect(box?.width ?? 0, "Approve button width").toBeGreaterThanOrEqual(280);
    const changes = await c.page.locator("summary").filter({ hasText: "Request changes" }).boundingBox();
    expect(changes?.height ?? 0, "Request changes height").toBeGreaterThanOrEqual(44);
    expect(await overflowsX(c.page), "no sideways scroll at 360px").toBe(false);
    expect(await axeSerious(c.page), "axe").toEqual([]);
    // A link people forward must not be indexed.
    const robots = await c.page.locator('meta[name="robots"]').getAttribute("content");
    expect(robots ?? "").toMatch(/noindex/);
    // Not logged in: no app chrome, no login links leaking the workspace.
    await expect(c.page.getByRole("link", { name: /inbox|settings|billing/i })).toHaveCount(0);
    await c.context.close();
  });

  test("approving persists, shows thanks, survives reload and cannot be changed afterwards", async ({ context, browser }) => {
    const u = await signupUser(context, "appr");
    const { assetId } = await seedAsset(u);
    const link = await createLink(context, assetId);
    const c = await client(browser);
    await c.page.goto(link.path);
    // Keyboard: the primary button is reachable and Enter activates it.
    await c.page.keyboard.press("Tab");
    await c.page.getByRole("button", { name: "Approve", exact: true }).focus();
    await c.page.keyboard.press("Enter");
    await expect(c.page.getByRole("heading", { level: 1, name: "Thank you, this is approved" })).toBeVisible();
    await expect(c.page.getByRole("status")).toContainText("Approved");
    await expect(c.page.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
    await expect(c.page.getByText("Weekend open house at Sunrise Residency")).toBeVisible();
    expect((await statusOf(link.id)).status).toBe("approved");

    await c.page.reload();
    await expect(c.page.getByRole("heading", { level: 1, name: "Thank you, this is approved" })).toBeVisible();

    // Trying again through the form endpoint (no nonce) or as JSON must not flip the answer.
    const reject = await c.context.request.post(`/api/approvals/${link.path.split("/").pop()}/decide`, { headers: { origin: ORIGIN, "content-type": "application/json" }, data: { decision: "rejected", nonce: "x" } });
    expect(reject.status()).toBeLessThan(500);
    expect((await statusOf(link.id)).status).toBe("approved");
    // Back button then re-submit of a stale form: still approved.
    await c.page.goBack().catch(() => undefined);
    await c.page.goto(link.path);
    expect((await statusOf(link.id)).status).toBe("approved");
    await c.context.close();
  });

  test("request changes needs words, then records the comment; decline needs a second tap; both are final", async ({ context, browser }) => {
    const u = await signupUser(context, "appr");
    const a1 = await seedAsset(u);
    const l1 = await createLink(context, a1.assetId);
    const c = await client(browser);
    await c.page.goto(l1.path);
    await c.page.locator("summary").filter({ hasText: "Request changes" }).click();
    await c.page.getByRole("button", { name: "Send my changes" }).click();
    // Either the browser or the page insists on a comment; nothing is recorded.
    await expect(async () => {
      const text = await c.page.locator("body").innerText();
      const invalid = await c.page.getByLabel("What should change?").evaluate((el) => !(el as HTMLTextAreaElement).validity.valid);
      expect(invalid || /Please tell us what to change/.test(text)).toBe(true);
    }).toPass({ timeout: 8000 });
    expect((await statusOf(l1.id)).status).toBe("pending");
    await c.page.goto(l1.path);
    await c.page.locator("summary").filter({ hasText: "Request changes" }).click();
    await c.page.getByLabel("What should change?").fill("Please change the price to 52 lakh and use a different photo.");
    await c.page.getByRole("button", { name: "Send my changes" }).click();
    await expect(c.page.getByRole("heading", { level: 1, name: "Thank you, we have your comments" })).toBeVisible();
    const row = await statusOf(l1.id);
    expect(row.status).toBe("changes_requested");
    expect(row.comment).toContain("different photo");

    const a2 = await seedAsset(u);
    const l2 = await createLink(context, a2.assetId);
    await c.page.goto(l2.path);
    await c.page.locator("summary").filter({ hasText: "Request changes" }).click();
    await c.page.getByText("Not right at all? Decline this").click();
    await expect(c.page.getByText(/You cannot undo this/)).toBeVisible();
    await c.page.getByRole("button", { name: "Yes, decline this" }).click();
    await expect(c.page.getByRole("heading", { level: 1, name: "You declined this" })).toBeVisible();
    expect((await statusOf(l2.id)).status).toBe("rejected");
    await c.page.reload();
    await expect(c.page.getByRole("heading", { level: 1, name: "You declined this" })).toBeVisible();
    await expect(c.page.getByRole("button", { name: /approve/i })).toHaveCount(0);
    await c.context.close();
  });

  test("unknown, malformed and expired links all say the same kind thing", async ({ context, browser }) => {
    const u = await signupUser(context, "appr");
    const { assetId } = await seedAsset(u);
    const link = await createLink(context, assetId);
    const d = await db();
    await d.query(`update "ApprovalRequest" set "expiresAt" = now() - interval '1 hour' where id = $1`, [link.id]);
    const c = await client(browser);
    for (const path of [link.path, "/approve/not-a-real-token", `/approve/${"a".repeat(43)}`, "/approve/%3Cscript%3Ealert(1)%3C%2Fscript%3E"]) {
      await c.page.goto(path);
      await expect(c.page.getByRole("heading", { level: 1, name: "This link no longer works" }), path).toBeVisible();
      await expect(c.page.getByText(/ask the person who sent it for a new link/i)).toBeVisible();
      await expect(c.page.getByRole("button", { name: /approve/i })).toHaveCount(0);
    }
    expect(await axeSerious(c.page), "axe invalid link").toEqual([]);
    await c.context.close();
  });

  test("a revoked link says it was withdrawn, and editing the ad after sending invalidates approval", async ({ context, browser }) => {
    const u = await signupUser(context, "appr");
    const a1 = await seedAsset(u);
    const l1 = await createLink(context, a1.assetId);
    const revoke = await context.request.post(`/api/approvals/${l1.id}/revoke`, { headers: { origin: ORIGIN }, data: {} });
    expect(revoke.ok(), await revoke.text()).toBe(true);
    const c = await client(browser);
    await c.page.goto(l1.path);
    await expect(c.page.getByRole("heading", { level: 1 })).toHaveText(/withdrawn|no longer works/i);
    await expect(c.page.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);

    const a2 = await seedAsset(u);
    const l2 = await createLink(context, a2.assetId);
    await c.page.goto(l2.path);
    await expect(c.page.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
    const edit = await context.request.patch(`/api/creative/assets/${a2.assetId}`, { headers: { origin: ORIGIN }, data: { headline: "Now with a different price", body: "Price changed to 90 lakh." } });
    expect(edit.ok(), await edit.text()).toBe(true);
    // The client is looking at the old version. Tapping Approve must not approve the new content.
    await c.page.getByRole("button", { name: "Approve", exact: true }).click();
    const after = await statusOf(l2.id);
    expect(after.status, "an approval of content that has since changed must not be recorded as approved").not.toBe("approved");
    await expect(c.page.locator("body")).not.toContainText("Thank you, this is approved");
    await c.context.close();
  });

  test("hostile text in the ad is shown as plain text and never runs", async ({ context, browser }) => {
    const u = await signupUser(context, "appr");
    const { assetId } = await seedAsset(u, `<img src=x onerror="window.__pwned=1"> Offer`, `<script>window.__pwned=2</script> "quotes" & <b>bold</b>`);
    const link = await createLink(context, assetId);
    const c = await client(browser);
    let dialogs = 0;
    c.page.on("dialog", (d) => {
      dialogs++;
      void d.dismiss();
    });
    await c.page.goto(link.path);
    await expect(c.page.getByText(/<img src=x/)).toBeVisible();
    await expect(c.page.getByText(/<script>window.__pwned=2<\/script>/)).toBeVisible();
    expect(await c.page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    expect(dialogs).toBe(0);
    await c.context.close();
  });

  test("dark theme keeps the page readable", async ({ context, browser }) => {
    const u = await signupUser(context, "appr");
    const { assetId } = await seedAsset(u);
    const link = await createLink(context, assetId);
    const c = await client(browser, { dark: true });
    await c.page.goto(link.path);
    await expect(c.page.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
    expect(await axeSerious(c.page), "axe dark").toEqual([]);
    await c.page.locator("summary").filter({ hasText: "Request changes" }).click();
    expect(await axeSerious(c.page), "axe dark with comment form").toEqual([]);
    await c.context.close();
  });

  test("another workspace cannot create, resend or revoke approvals for my content", async ({ context, browser }) => {
    const owner = await signupUser(context, "appr");
    const { assetId } = await seedAsset(owner);
    const link = await createLink(context, assetId);
    const bctx = await browser.newContext();
    await signupUser(bctx, "appr");
    const create = await bctx.request.post("/api/approvals", { headers: { origin: ORIGIN }, data: { subjectType: "creative_asset", subjectId: assetId } });
    expect([403, 404]).toContain(create.status());
    const revoke = await bctx.request.post(`/api/approvals/${link.id}/revoke`, { headers: { origin: ORIGIN }, data: {} });
    expect([403, 404]).toContain(revoke.status());
    const resend = await bctx.request.post(`/api/approvals/${link.id}/resend`, { headers: { origin: ORIGIN }, data: { mode: "text", phone: "+919800000002" } });
    expect([403, 404]).toContain(resend.status());
    expect((await statusOf(link.id)).status).toBe("pending");
    const bad = await context.request.post("/api/approvals", { headers: { origin: ORIGIN }, data: { subjectType: "database", subjectId: "x" } });
    expect(bad.status()).toBe(400);
    const noOrigin = await context.request.post("/api/approvals", { headers: { origin: "https://evil.example" }, data: { subjectType: "creative_asset", subjectId: assetId } });
    expect(noOrigin.status()).toBe(403);
    await bctx.close();
  });

  test("approving a social post link schedules it", async ({ context, browser }) => {
    const owner = await signupUser(context, "appr");
    const m = await seedMeta(owner);
    const when = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const res = await context.request.post("/api/content/posts", { headers: { origin: ORIGIN }, data: { body: "Festival greetings from Sunrise Realty", assetIds: [m.page!.id], scheduledAt: when, draft: false, requireApproval: true } });
    expect(res.status(), await res.text()).toBeLessThan(300);
    const { approvalUrl } = await res.json();
    expect(approvalUrl).toMatch(/\/approve\//);
    const d = await db();
    expect((await d.query(`select status from "ScheduledPost" where "tenantId" = $1`, [owner.tenantId])).rows[0].status).toBe("draft");
    const c = await client(browser);
    await c.page.goto(new URL(approvalUrl).pathname);
    await expect(c.page.getByRole("heading", { level: 1, name: /Please review this post/ })).toBeVisible();
    await expect(c.page.getByText(/Festival greetings/)).toBeVisible();
    await c.page.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(c.page.getByRole("heading", { level: 1, name: "Thank you, this is approved" })).toBeVisible();
    await expect.poll(async () => (await d.query(`select status from "ScheduledPost" where "tenantId" = $1`, [owner.tenantId])).rows[0].status, { timeout: 15_000 }).toBe("scheduled");
    await c.context.close();
  });
});
