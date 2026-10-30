import { createHmac } from "node:crypto";
import { expect as baseExpect, test } from "@playwright/test";
import { ORIGIN, closeDb, db, signupUser, stamp, watchErrors } from "./helpers";
import { axeSerious, createAgent, loginFresh, overflowsX, seedMeta, toggleTheme } from "./growth-helpers";

// The shared machine is busy with other testers: generous timeouts keep real defects apart from slowness.
const expect = baseExpect.configure({ timeout: 25_000 });
test.setTimeout(240_000);
test.use({ actionTimeout: 30_000, navigationTimeout: 60_000 });

test.afterAll(closeDb);

const SECRET = "shpss_test_secret_1234567890";

function shopifyWebhook(domain: string, secret: string, topic = "checkouts/create") {
  const body = JSON.stringify({ id: Number(String(stamp()).slice(-9)), token: `tok_${stamp()}`, updated_at: new Date().toISOString(), created_at: new Date().toISOString(), phone: "+919800000001", total_price: "1499.00", currency: "INR", line_items: [{ title: "Sofa", quantity: 1, price: "1499.00" }], abandoned_checkout_url: `https://${domain}/checkouts/abc` });
  const sig = createHmac("sha256", secret).update(body, "utf8").digest("base64");
  return { body, headers: { "content-type": "application/json", "x-shopify-shop-domain": domain, "x-shopify-hmac-sha256": sig, "x-shopify-topic": topic, "x-shopify-webhook-id": `wh_${stamp()}` } };
}

const TOKEN = "shpat_test_token_1234567890";

/**
 * The form now also asks for the Admin API access token, and the server proves store ownership by calling the real
 * https://<shop>.myshopify.com/admin/api/.../shop.json with it. A made-up shop cannot pass that in a test, so this fills the token
 * in the form (the browser enforces it) and strips it from the request before it reaches the server. The server's documented
 * token-less path then stores the connection as "pending_verification" ("Waiting for Shopify"). Returns what the browser sent.
 */
async function watchConnectRequests(page: import("@playwright/test").Page) {
  const sent: Array<Record<string, unknown>> = [];
  await page.route(/\/api\/commerce\/stores$/, async (route) => {
    const req = route.request();
    if (req.method() !== "POST") return route.continue();
    const body = JSON.parse(req.postData() ?? "{}") as Record<string, unknown>;
    sent.push(body);
    const { accessToken: _dropped, ...legacy } = body;
    return route.continue({ postData: JSON.stringify(legacy) });
  });
  return sent;
}

test.describe("Shopify recovery", () => {
  test("setup instructions are complete and in plain words", async ({ page, context }) => {
    const errors = watchErrors(page);
    await signupUser(context, "shop");
    await page.goto("/app/commerce");
    await expect(page.getByRole("heading", { level: 1, name: "Shopify recovery" })).toBeVisible();
    await expect(page.getByText("Connect your Shopify store")).toBeVisible();
    for (const event of ["Checkout creation", "Checkout update", "Order creation"]) await expect(page.getByText(`Event: ${event}`).first()).toBeVisible();
    await expect(page.getByText(/\/webhooks\/shopify/).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: /Add three notifications in Shopify|Copy the signing secret|Connect your store here/ }).first()).toBeVisible();
    expect(await axeSerious(page), "axe").toEqual([]);
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("connect form rejects empty input and every malicious store address, and stores nothing", async ({ page, context }) => {
    const u = await signupUser(context, "shop");
    await page.goto("/app/commerce");
    const domain = page.getByLabel("Store address");
    const secret = page.getByLabel("Signing secret");
    const submit = page.getByRole("button", { name: "Connect store" });
    let posts = 0;
    page.on("request", (r) => {
      if (r.method() === "POST" && /\/api\/commerce\/stores$/.test(r.url())) posts++;
    });
    await submit.click();
    await expect(page.getByText("Enter your store address.")).toBeVisible();
    await expect(page.getByText("Paste the signing secret from Shopify.")).toBeVisible();

    const hostile = [
      "evil.com",
      "my-store.myshopify.com.evil.com",
      "https://evil.com/my-store.myshopify.com",
      "my-store.myshopify.com@evil.com",
      "evil.com#.myshopify.com",
      "javascript:alert(1).myshopify.com",
      "127.0.0.1",
      "localhost:3500",
      "169.254.169.254/latest/meta-data",
      "-bad.myshopify.com",
      "my store.myshopify.com",
      "<script>alert(1)</script>.myshopify.com",
      "my-store.myshopify.com:8080",
      "xn--e1afmkfd.myshopify.com.attacker.io",
      "a".repeat(80) + ".myshopify.com",
    ];
    await secret.fill(SECRET);
    for (const h of hostile) {
      await domain.fill(h);
      await submit.click();
      await expect(page.getByText(/Use the address that ends in \.myshopify\.com/), `domain ${h}`).toBeVisible();
    }
    expect(posts, "the browser must not even send a request for these").toBe(0);

    // Secret rules.
    await domain.fill("my-store.myshopify.com");
    await secret.fill("short");
    await submit.click();
    await expect(page.getByText(/looks too short/)).toBeVisible();
    await secret.fill("has space inside it");
    await submit.click();
    await expect(page.getByText("The secret has no spaces. Copy it again from Shopify.")).toBeVisible();
    expect(posts).toBe(0);
    const d = await db();
    expect((await d.query(`select count(*)::int as n from "ShopifyStore" where "tenantId" = $1`, [u.tenantId])).rows[0].n).toBe(0);

    // The server refuses the same addresses if someone bypasses the form.
    for (const h of hostile) {
      const r = await context.request.post("/api/commerce/stores", { headers: { origin: ORIGIN }, data: { shopDomain: h, webhookSecret: SECRET } });
      expect(r.status(), `server accepted ${h}`).toBe(400);
      expect(await r.text()).not.toMatch(/stack|prisma|undefined/i);
    }
    expect((await d.query(`select count(*)::int as n from "ShopifyStore" where "tenantId" = $1`, [u.tenantId])).rows[0].n).toBe(0);
  });

  test("connecting a store: pasted admin link and capitals are understood; duplicates and secrets are handled", async ({ page, context }) => {
    const errors = watchErrors(page);
    const u = await signupUser(context, "shop");
    const sent = await watchConnectRequests(page);
    await page.goto("/app/commerce");
    await page.getByLabel("Store address").fill("https://admin.shopify.com/store/Sunrise-Decor/products");
    await page.getByLabel("Signing secret").fill(SECRET);
    await page.getByLabel("Admin API access token").fill(TOKEN);
    await page.getByRole("button", { name: "Connect store" }).click();
    await expect(page.getByText("Store connected")).toBeVisible();
    expect(sent[0], "the pasted admin link is turned into the shop domain before sending").toMatchObject({ shopDomain: "sunrise-decor.myshopify.com", accessToken: TOKEN });
    await expect(page.getByRole("heading", { name: "Your store" })).toBeVisible();
    await expect(page.getByText("sunrise-decor.myshopify.com", { exact: true })).toBeVisible();
    await expect(page.getByText("Waiting for Shopify").first()).toBeVisible();
    await expect(page.locator("body")).not.toContainText(SECRET);
    expect(await axeSerious(page), "axe connected").toEqual([]);

    // Connecting it again is a readable message, not a crash.
    await page.getByText("Connect another store").click();
    await page.getByLabel("Store address").last().fill("sunrise-decor.myshopify.com");
    await page.getByLabel("Signing secret").last().fill(SECRET);
    await page.getByLabel("Admin API access token").last().fill(TOKEN);
    await page.getByRole("button", { name: "Connect store" }).click();
    await expect(page.getByText("This store is already connected.")).toBeVisible();

    // Updating the secret validates, then saves.
    await page.getByRole("button", { name: "Update secret for sunrise-decor.myshopify.com" }).click();
    const dlg = page.getByRole("dialog", { name: "Update signing secret" });
    await dlg.getByRole("button", { name: "Save secret" }).click();
    await expect(dlg.getByText("Paste the signing secret from Shopify.")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dlg).toBeHidden();
    await expect(page.getByRole("button", { name: "Update secret for sunrise-decor.myshopify.com" })).toBeFocused();

    // Pause, resume, disconnect with a confirmation.
    await page.getByRole("button", { name: "Pause sunrise-decor.myshopify.com" }).click();
    await expect(page.getByText("sunrise-decor.myshopify.com is paused").first()).toBeVisible();
    await page.getByRole("button", { name: "Resume sunrise-decor.myshopify.com" }).click();
    // Resuming re-proves ownership with Shopify, so a store with no saved token (connected without one, as here) asks for the
    // token in a dialog instead of failing silently. (A store connected with a token resumes without asking; see the unit tests.)
    const resumeDlg = page.getByRole("dialog", { name: "Resume this store" });
    await expect(resumeDlg).toBeVisible();
    await expect(resumeDlg.getByLabel("Admin API access token")).toBeVisible();
    await resumeDlg.getByRole("button", { name: "Cancel" }).click();
    await expect(resumeDlg).toBeHidden();
    await page.getByRole("button", { name: "Disconnect sunrise-decor.myshopify.com" }).click();
    const ask = page.getByRole("alertdialog").filter({ hasText: "Disconnect sunrise-decor.myshopify.com?" });
    await expect(ask).toBeVisible();
    await ask.getByRole("button", { name: "Disconnect store" }).click();
    await expect(page.getByText("sunrise-decor.myshopify.com disconnected").first()).toBeVisible();
    await expect(page.getByText("Connect your Shopify store")).toBeVisible();
    const d = await db();
    expect((await d.query(`select count(*)::int as n from "ShopifyStore" where "tenantId" = $1`, [u.tenantId])).rows[0].n).toBe(0);
    // The duplicate connect (409) and the resume that asks for a token (422) are deliberate; the browser logs every failed response, so only other console errors count.
    expect(errors.filter((e) => !/Failed to load resource.*(409|422)/.test(e)), errors.join("\n")).toEqual([]);
  });

  // Replaces the old "Shopify's first notification verifies the store" flow. A signature made with a secret the owner typed in proves
  // nothing about the shop, so ownership is now proven with the Admin API token (see src/lib/commerce/stores.ts) and webhooks are only
  // accepted for verified stores. The page tells the owner to use Verify, and this checks it keeps that promise honestly.
  test("a store Shopify has not confirmed waits, ignores notifications, and the page says to verify it with the token", async ({ page, context }) => {
    const u = await signupUser(context, "shop");
    await watchConnectRequests(page);
    await page.goto("/app/commerce");
    const domain = `verify-${stamp()}.myshopify.com`;
    await page.getByLabel("Store address").fill(domain);
    await page.getByLabel("Signing secret").fill(SECRET);
    await page.getByLabel("Admin API access token").fill(TOKEN);
    await page.getByRole("button", { name: "Connect store" }).click();
    await expect(page.getByText("Waiting for Shopify").first()).toBeVisible();
    await expect(page.getByText(/Choose Verify and paste the Admin API access token/)).toBeVisible();
    // A signed notification does not verify the store and nothing is ingested for it.
    const hook = shopifyWebhook(domain, SECRET);
    const res = await context.request.post("/webhooks/shopify", { headers: hook.headers, data: hook.body });
    expect(res.status()).toBe(401);
    const d = await db();
    const status = async () => (await d.query(`select status from "ShopifyStore" where "tenantId" = $1`, [u.tenantId])).rows[0].status;
    expect(await status()).toBe("pending_verification");
    // Verify asks for the token; a token Shopify cannot confirm for this made-up shop is a readable message and changes nothing.
    await page.getByRole("button", { name: `Verify ${domain}` }).click();
    const dlg = page.getByRole("dialog", { name: "Verify this store" });
    await dlg.getByLabel("Admin API access token").fill(TOKEN);
    await dlg.getByRole("button", { name: "Verify store" }).click();
    const problem = dlg.getByRole("alert");
    await expect(problem).toBeVisible({ timeout: 40_000 });
    expect(await problem.innerText()).not.toMatch(/stack|prisma|undefined|\[object/i);
    expect(await status()).toBe("pending_verification");
  });

  test("agents are told to ask an owner; other workspaces cannot see or change the store", async ({ context, browser }) => {
    const owner = await signupUser(context, "shop");
    const created = await context.request.post("/api/commerce/stores", { headers: { origin: ORIGIN }, data: { shopDomain: `iso-${stamp()}.myshopify.com`, webhookSecret: SECRET } });
    expect(created.status(), await created.text()).toBe(201);
    const storeId = (await created.json()).store.id as string;
    const agent = await createAgent(browser, owner);
    const a = await loginFresh(browser, agent.email);
    await a.page.goto("/app/commerce");
    await expect(a.page.getByRole("heading", { level: 1, name: "Shopify recovery" })).toBeVisible();
    await expect(a.page.getByRole("button", { name: /Connect store|Disconnect|Pause|Update secret/ })).toHaveCount(0);
    expect((await a.context.request.post("/api/commerce/stores", { headers: { origin: ORIGIN }, data: { shopDomain: "x-y.myshopify.com", webhookSecret: SECRET } })).status()).toBe(403);
    expect((await a.context.request.delete(`/api/commerce/stores/${storeId}`, { headers: { origin: ORIGIN } })).status()).toBe(403);
    await a.context.close();

    const bctx = await browser.newContext();
    const bpage = await bctx.newPage();
    await signupUser(bctx, "shop");
    await bpage.goto("/app/commerce");
    await expect(bpage.getByText("Connect your Shopify store")).toBeVisible();
    expect(JSON.stringify(await (await bctx.request.get("/api/commerce/stores")).json())).not.toContain("iso-");
    const del = await bctx.request.delete(`/api/commerce/stores/${storeId}`, { headers: { origin: ORIGIN } });
    expect([403, 404]).toContain(del.status());
    const patch = await bctx.request.patch(`/api/commerce/stores/${storeId}`, { headers: { origin: ORIGIN }, data: { status: "disabled" } });
    expect([403, 404]).toContain(patch.status());
    const d = await db();
    expect((await d.query(`select count(*)::int as n from "ShopifyStore" where id = $1`, [storeId])).rows[0].n).toBe(1);
    await bctx.close();
  });

  test("webhook receiver: wrong signature, unknown shop and oversized body are refused politely", async ({ context }) => {
    const bad = shopifyWebhook("nobody-here.myshopify.com", "wrong-secret-123456");
    const r1 = await context.request.post("/webhooks/shopify", { headers: bad.headers, data: bad.body });
    expect(r1.status()).toBe(401);
    expect(await r1.text()).not.toMatch(/stack|prisma|undefined/i);
    const r2 = await context.request.post("/webhooks/shopify", { headers: { ...bad.headers, "x-shopify-shop-domain": "evil.com" }, data: bad.body });
    expect(r2.status()).toBe(401);
    const r3 = await context.request.post("/webhooks/shopify", { headers: bad.headers, data: "x".repeat(600 * 1024) });
    expect([401, 413]).toContain(r3.status());
  });

  test("setup page fits a phone in dark theme @mobile", async ({ page, context }) => {
    await signupUser(context, "shop");
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto("/app/commerce");
    await expect(page.getByText("Connect your Shopify store")).toBeVisible();
    expect(await overflowsX(page), "setup at 360px").toBe(false);
    await toggleTheme(page).catch(async () => {
      await page.getByRole("button", { name: /^more$/i }).first().click();
      await toggleTheme(page);
    });
    expect(await axeSerious(page), "axe dark").toEqual([]);
  });
});

test.describe("Conversions (Meta conversions API) states", () => {
  test("a new workspace gets empty, well-formed answers; settings validate in plain words", async ({ context }) => {
    const u = await signupUser(context, "conv");
    const m = await seedMeta(u, { withDataset: true });
    const list = await context.request.get("/api/conversions");
    expect(list.status()).toBe(200);
    const body = await list.json();
    expect(body.events).toEqual([]);
    expect(body.counts).toEqual({});
    expect(body.settings).toEqual({ enabled: true, datasetAssetId: null });
    const sources = await (await context.request.get("/api/conversions/sources")).json();
    expect(sources.sources).toEqual([]);
    expect(sources.conversations).toEqual([]);
    const opts = await (await context.request.get("/api/conversions/settings")).json();
    expect(opts.datasets.map((x: { id: string }) => x.id)).toContain(m.dataset!.id);
    expect(JSON.stringify(opts)).not.toMatch(/tokenEnc|fake-token/);

    const put = (data: object) => context.request.put("/api/conversions/settings", { headers: { origin: ORIGIN }, data });
    const bad1 = await put({ enabled: "yes" });
    expect(bad1.status()).toBe(400);
    expect((await bad1.json()).error).toBe("enabled must be true or false.");
    const bad2 = await put({ enabled: true, datasetAssetId: "someone-elses-dataset" });
    expect(bad2.status()).toBe(400);
    expect((await bad2.json()).error).toBe("That dataset is not connected to this workspace.");
    const bad3 = await put({ enabled: true, datasetAssetId: 42 });
    expect(bad3.status()).toBe(400);
    const ok = await put({ enabled: true, datasetAssetId: m.dataset!.id });
    expect(ok.status()).toBe(200);
    expect((await (await context.request.get("/api/conversions/settings")).json()).settings.datasetAssetId).toBe(m.dataset!.id);
    const cross = await context.request.put("/api/conversions/settings", { headers: { origin: "https://evil.example" }, data: { enabled: false, datasetAssetId: null } });
    expect(cross.status()).toBe(403);
  });

  test("failed events show a reason and can be re-queued once; sent events cannot; other workspaces and agents are refused", async ({ context, browser }) => {
    const owner = await signupUser(context, "conv");
    const m = await seedMeta(owner, { withDataset: true });
    const d = await db();
    const ev = async (status: string, response: object | null) => {
      const id = `cev_${stamp()}`;
      await d.query(`insert into "ConversionEvent" (id,"tenantId","datasetId","eventName","eventTime",status,attempts,response) values ($1,$2,$3,'Lead',now(),$4,3,$5)`, [id, owner.tenantId, m.dataset!.externalId, status, response ? JSON.stringify(response) : null]);
      return id;
    };
    const failed = await ev("failed", { error: "Meta rejected the token. Reconnect Facebook." });
    const sent = await ev("sent", null);
    const skipped = await ev("skipped", { reason: "Lead has no consent on record." });
    const body = await (await context.request.get("/api/conversions?status=failed")).json();
    expect(body.events.map((e: { id: string }) => e.id)).toEqual([failed]);
    expect(body.events[0].reason).toContain("Reconnect Facebook");
    expect(body.counts).toMatchObject({ failed: 1, sent: 1, skipped: 1 });
    const weird = await context.request.get("/api/conversions?status=%27%3B%20drop%20table&limit=-5");
    expect(weird.status()).toBe(200);

    const post = (id: string) => context.request.post(`/api/conversions/${id}/requeue`, { headers: { origin: ORIGIN }, data: {} });
    expect((await post(failed)).status()).toBe(200);
    expect((await d.query(`select status, attempts from "ConversionEvent" where id = $1`, [failed])).rows[0]).toMatchObject({ status: "pending", attempts: 0 });
    const again = await post(failed);
    expect(again.status()).toBe(409);
    expect((await again.json()).error).toBe("Only failed or skipped events can be re-queued.");
    expect((await post(sent)).status()).toBe(409);
    expect((await post(skipped)).status()).toBe(200);
    expect((await post("does-not-exist")).status()).toBe(404);

    const agent = await createAgent(browser, owner);
    const a = await loginFresh(browser, agent.email);
    expect((await a.context.request.get("/api/conversions")).status()).toBe(403);
    expect((await a.context.request.get("/api/conversions/sources")).status()).toBe(403);
    expect((await a.context.request.put("/api/conversions/settings", { headers: { origin: ORIGIN }, data: { enabled: false } })).status()).toBe(403);
    await a.context.close();

    const bctx = await browser.newContext();
    await signupUser(bctx, "conv");
    expect(JSON.stringify(await (await bctx.request.get("/api/conversions")).json())).not.toContain(failed);
    const other = await bctx.request.post(`/api/conversions/${sent}/requeue`, { headers: { origin: ORIGIN }, data: {} });
    expect(other.status()).toBe(404);
    await bctx.close();
  });

  test("there is a page for conversions in the app", async ({ page, context }) => {
    await signupUser(context, "conv");
    const res = await page.goto("/app/conversions");
    // Owners are told in the API docs and privacy text that conversions are reported, but there is nowhere in the app to see or switch them off.
    expect(res?.status(), "no /app/conversions screen exists: owners cannot see delivery problems or pick a dataset").toBe(200);
  });
});
