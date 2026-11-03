import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { closeDb, db, ORIGIN, signupUser, watchErrors } from "./helpers";
import { checkPromoteQuality, proveAppUsesFake } from "./promote-helpers";

/**
 * 9.4 promote-connect-popup: route-mocked facebook.com; the popup's outcome reaches the page through the BroadcastChannel; a
 * blocked popup falls back to the full-page redirect. Desktop Chrome and Pixel 7 (@mobile).
 *
 * context.route answers facebook.com only (the consent screen is browser-side); everything the server fetches goes to the fake
 * Meta server (e2e/promote-helpers.ts, imported above for its guard). Facebook "answers" with a cancel, which Meta sends as
 * ?error=access_denied: that ends the attempt without a code exchange, so no token is involved anywhere and the server makes
 * no Graph call of its own here. So before the tests, proveAppUsesFake checks with a throwaway workspace that this same app
 * reads Graph from the fake.
 * The Connect button shows only when the app has META_APP_ID and META_LOGIN_CONFIG_ID; otherwise these tests skip with that reason.
 */

test.afterAll(closeDb);
test.setTimeout(120_000);
test.beforeAll(async ({ browser }) => {
  await proveAppUsesFake(browser);
});

const CONNECT_CHANNEL = "edwyz-meta-connect";
const CANCELLED = "The Meta login was cancelled. Nothing was changed.";

type DialogSeen = { url: string; state: string };

/** facebook.com's login dialog, answered as a cancel: Meta redirects back to the callback with the same state. */
async function mockFacebook(context: BrowserContext): Promise<DialogSeen[]> {
  const seen: DialogSeen[] = [];
  await context.route(/^https:\/\/(www|web|m)\.facebook\.com\//, async (route) => {
    const url = new URL(route.request().url());
    const state = url.searchParams.get("state") ?? "";
    seen.push({ url: `${url.origin}${url.pathname}`, state });
    const back = new URL("/api/meta-connect/callback", ORIGIN);
    back.searchParams.set("error", "access_denied");
    back.searchParams.set("error_reason", "user_denied");
    back.searchParams.set("state", state);
    await route.fulfill({ status: 302, headers: { location: back.toString(), "cache-control": "no-store" } });
  });
  return seen;
}

async function openConnections(page: Page) {
  await page.goto("/app/settings/connections");
  const button = page.getByTestId("meta-connect-button");
  const configured = await button.isVisible({ timeout: 15_000 }).catch(() => false);
  test.skip(!configured, "The app has no META_APP_ID or META_LOGIN_CONFIG_ID, so it shows no Connect button.");
  return button;
}

async function connectionCount(tenantId: string): Promise<number> {
  return Number((await (await db()).query(`select count(*)::int as n from "MetaConnection" where "tenantId" = $1`, [tenantId])).rows[0].n);
}

test.describe("Facebook Login in a popup @mobile", () => {
  test("the outcome comes back through the BroadcastChannel even when the popup lost its opener and storage", async ({ page, context }, testInfo) => {
    const errors = watchErrors(page);
    const owner = await signupUser(context, "prm-popup");
    const seen = await mockFacebook(context);
    // On the callback's page only: cut window.opener and the storage write, so neither postMessage nor the storage event can
    // carry the outcome. The BroadcastChannel (and the meta tag) still can.
    await context.addInitScript(() => {
      if (location.pathname !== "/api/meta-connect/callback") return;
      try {
        Object.defineProperty(window, "opener", { configurable: true, get: () => null });
      } catch {
        // keep the real opener
      }
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key: string, value: string) {
        if (key === "wa-meta-connect") return;
        return setItem.call(this, key, value);
      };
    });
    const button = await openConnections(page);
    await checkPromoteQuality(page, testInfo, "connect-before");

    // Listen on the same channel as the page, to see the message itself.
    await page.evaluate((name) => {
      const w = window as unknown as { __prmChannel: unknown[] };
      w.__prmChannel = [];
      const c = new BroadcastChannel(name);
      c.onmessage = (e) => w.__prmChannel.push(e.data);
    }, CONNECT_CHANNEL);

    const popupOpened = page.waitForEvent("popup");
    await button.click();
    const popup = await popupOpened;
    // The window closes itself once the callback's page has told the opener (it may already be gone).
    if (!popup.isClosed()) await popup.waitForEvent("close", { timeout: 30_000 }).catch(() => undefined);

    await expect(page.getByText(CANCELLED)).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __prmChannel: unknown[] }).__prmChannel)).toContainEqual({ source: CONNECT_CHANNEL, outcome: "cancelled" });
    // The popup attempt asked Facebook's dialog for this app's configuration, with the popup marker on its state.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0].url).toMatch(/\/dialog\/oauth$/);
    expect(seen[0].state.endsWith(".popup")).toBe(true);
    expect(await connectionCount(owner.tenantId)).toBe(0);
    await checkPromoteQuality(page, testInfo, "connect-cancelled");
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("a blocked popup falls back to the full-page redirect", async ({ page, context }, testInfo) => {
    const errors = watchErrors(page);
    const owner = await signupUser(context, "prm-popup-blocked");
    const seen = await mockFacebook(context);
    // A popup blocker: window.open gives nothing back on this site's pages.
    await page.addInitScript((origin) => {
      if (location.origin === origin) window.open = () => null;
    }, ORIGIN);
    const button = await openConnections(page);
    await button.click();

    // The whole page goes to Facebook and comes back to Connections with the outcome.
    await page.waitForURL(/\/app\/settings\/connections\?status=cancelled/, { timeout: 30_000 });
    await expect(page.getByText(CANCELLED)).toBeVisible();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0].state.endsWith(".popup"), "the redirect attempt carries no popup marker").toBe(false);
    expect(await connectionCount(owner.tenantId)).toBe(0);
    await checkPromoteQuality(page, testInfo, "connect-redirect");
    expect(errors, errors.join("\n")).toEqual([]);
  });
});
