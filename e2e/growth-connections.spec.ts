import { expect as baseExpect, test } from "@playwright/test";
import { ORIGIN, closeDb, db, signupUser, watchErrors } from "./helpers";
import { askDialog, axeSerious, createAgent, loginFresh, overflowsX, seedMeta, toggleTheme } from "./growth-helpers";

// The shared machine is busy with other testers: generous timeouts keep real defects apart from slowness.
const expect = baseExpect.configure({ timeout: 25_000 });
test.setTimeout(240_000);
test.use({ actionTimeout: 30_000, navigationTimeout: 60_000 });

test.afterAll(closeDb);

test.describe("Meta connections", () => {
  test("not connected: explains the situation and the next step", async ({ page, context }) => {
    const errors = watchErrors(page);
    await signupUser(context, "conn");
    await page.goto("/app/settings/connections");
    await expect(page.getByRole("heading", { level: 1, name: "Connections" })).toBeVisible();
    await expect(page.getByText("Nothing connected yet")).toBeVisible();
    // The scopes explanation is shown with a plain-language purpose for every permission.
    await expect(page.getByRole("heading", { name: "What we can access" })).toBeVisible();
    // docs/SPEND-CONTROLS-SPEC.md 5.10: ads_management also covers keeping Meta's spending limit in line with the owner's limits.
    await expect(page.getByText("Create and change ad campaigns, and keep Meta's spending limit in line with your limits.")).toBeVisible();
    await expect(page.getByText(/tokens are encrypted and never shown/i)).toBeVisible();
    // A next step must exist: either the connect button, or a clear statement of why it is missing.
    const connectBtn = page.getByRole("button", { name: /connect with facebook/i });
    if (!(await connectBtn.count())) {
      // With no connections the empty state itself now explains why (the separate "not configured" line only shows when connections exist).
      await expect(page.getByText(/Connecting Pages, Instagram and ads is not switched on for this server yet/)).toBeVisible();
      await expect(page.getByRole("main").getByRole("button", { name: "Email support" })).toBeVisible();
    }
    expect(await overflowsX(page)).toBe(false);
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("not configured: the empty state must not point the owner at a button that does not exist", async ({ page, context }) => {
    await signupUser(context, "conn");
    const cfg = await (await context.request.get("/api/meta-connect/connections")).json();
    test.skip(cfg.configured, "Meta login is configured on this server");
    await page.goto("/app/settings/connections");
    await expect(page.getByText("Nothing connected yet")).toBeVisible();
    // The empty state says to connect a Facebook account but offers nothing to click.
    const actions = page.getByRole("main").getByRole("button");
    expect(await actions.count(), "owner sees no action at all on a page whose only purpose is connecting").toBeGreaterThan(0);
  });

  test("starting a connection without Meta login configured fails with a plain message", async ({ context }) => {
    await signupUser(context, "conn");
    const res = await context.request.post("/api/meta-connect/start", { headers: { origin: ORIGIN }, data: {} });
    const cfg = await (await context.request.get("/api/meta-connect/connections")).json();
    if (!cfg.configured) {
      expect(res.ok()).toBe(false);
      const body = await res.text();
      expect(body).not.toMatch(/stack|TypeError|undefined|\bECONN|prisma/i);
      expect(JSON.parse(body).error).toBeTruthy();
    }
  });

  test("connected: assets listed by type, permission gaps explained, refresh and disconnect degrade gracefully", async ({ page, context }) => {
    const errors = watchErrors(page);
    const u = await signupUser(context, "conn");
    const m = await seedMeta(u, { ig: true, withDataset: true });
    await page.goto("/app/settings/connections");
    await expect(page.getByRole("heading", { name: "Facebook Pages" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Instagram accounts" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Ad accounts" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Datasets (pixels)" })).toBeVisible();
    await expect(page.getByText(m.adAccount.name)).toBeVisible();
    await expect(page.getByText(/Permission missing:/)).toBeVisible();
    await expect(page.getByText(/Reconnect and approve everything/)).toBeVisible();
    await expect(page.locator("body")).not.toContainText("fake-token");

    // Refresh with a token Meta will refuse: a readable error or notice, no raw JSON or stack.
    await page.getByRole("button", { name: "Refresh assets" }).click();
    await page.waitForTimeout(3000);
    const body = await page.locator("main").innerText();
    expect(body).not.toMatch(/OAuthException|"error"|\bstack\b|TypeError|\bundefined\b|\bECONN|\[object|graph\.facebook/i);
    // BUG-CANDIDATE: Meta rejecting the token produces only "Something went wrong." with no next step.
    expect.soft(body, "refresh failure should say what to do (reconnect), not only that something went wrong").not.toMatch(/^Something went wrong\.$/m);
    expect(await axeSerious(page), "axe").toEqual([]);

    // Disconnect: an in-app confirmation (docs/ui-guidelines.md, no window.confirm; docs/SPEND-CONTROLS-SPEC.md 5.9) names what
    // happens, then the connection is marked disconnected.
    await page.getByRole("button", { name: "Disconnect" }).click();
    const ask = askDialog(page, "Disconnect this Meta account?");
    await expect(ask).toContainText(/revoke|delete the stored tokens/i);
    await ask.getByRole("button", { name: "Disconnect", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: /disconnected/i })).toBeVisible({ timeout: 25_000 });
    const d = await db();
    const row = (await d.query(`select status from "MetaConnection" where id = $1`, [m.connId])).rows[0];
    expect(row?.status ?? "revoked").toBe("revoked");
    expect(errors.filter((e) => !/Failed to load resource/.test(e)), errors.join("\n")).toEqual([]);
  });

  test("expired connection offers a way to reconnect", async ({ page, context }) => {
    const u = await signupUser(context, "conn");
    await seedMeta(u, { status: "expired" });
    await page.goto("/app/settings/connections");
    await expect(page.getByText("Expired, reconnect")).toBeVisible();
    const cfg = await (await context.request.get("/api/meta-connect/connections")).json();
    test.skip(!cfg.configured, "Meta login is not configured here, so no Reconnect button can exist");
    await expect(page.getByRole("button", { name: "Reconnect" })).toBeVisible();
  });

  test("an agent can look but not change; another workspace sees nothing", async ({ context, browser }) => {
    const owner = await signupUser(context, "conn");
    const m = await seedMeta(owner);
    const agent = await createAgent(browser, owner);
    const a = await loginFresh(browser, agent.email);
    await a.page.goto("/app/settings/connections");
    await expect(a.page.getByText(m.adAccount.name)).toBeVisible();
    await expect(a.page.getByText(/only an owner or admin can connect, refresh or disconnect/i)).toBeVisible();
    await expect(a.page.getByRole("button", { name: /disconnect|refresh assets|connect with facebook/i })).toHaveCount(0);
    const r = await a.context.request.post("/api/meta-connect/disconnect", { headers: { origin: ORIGIN }, data: { connectionId: m.connId } });
    expect(r.status()).toBe(403);
    await a.context.close();

    const bctx = await browser.newContext();
    const bpage = await bctx.newPage();
    await signupUser(bctx, "conn");
    await bpage.goto("/app/settings/connections");
    await expect(bpage.getByText("Nothing connected yet")).toBeVisible();
    await expect(bpage.locator("body")).not.toContainText(m.adAccount.name);
    const res = await bctx.request.post("/api/meta-connect/disconnect", { headers: { origin: ORIGIN }, data: { connectionId: m.connId } });
    expect([403, 404]).toContain(res.status());
    const d = await db();
    expect((await d.query(`select status from "MetaConnection" where id = $1`, [m.connId])).rows[0].status).toBe("active");
    await bctx.close();
  });

  test("app shell: the workspace switcher's accessible name contains its visible text (axe label-content-name-mismatch)", async ({ page, context }) => {
    await signupUser(context, "conn");
    await page.goto("/app/settings/connections");
    await expect(page.getByRole("heading", { level: 1, name: "Connections" })).toBeVisible();
    const res = await new (await import("@axe-core/playwright")).default({ page }).withRules(["label-content-name-mismatch"]).analyze();
    expect(res.violations.map((v) => v.nodes.map((n) => n.target.join(" ")).join(" | ")), "workspace switcher").toEqual([]);
  });

  test("phone width and dark theme stay usable @mobile", async ({ page, context }) => {
    const u = await signupUser(context, "conn");
    await seedMeta(u, { ig: true });
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto("/app/settings/connections");
    await expect(page.getByRole("heading", { name: "Facebook Pages" })).toBeVisible();
    expect(await overflowsX(page), "no sideways scroll at 360px").toBe(false);
    await toggleTheme(page).catch(async () => {
      await page.getByRole("button", { name: /^more$/i }).first().click();
      await toggleTheme(page);
    });
    expect(await axeSerious(page), "axe in dark theme").toEqual([]);
  });
});
