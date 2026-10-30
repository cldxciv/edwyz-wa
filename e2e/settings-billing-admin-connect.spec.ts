import { expect, test, type Page } from "@playwright/test";
import { addTeammate, apiLogin, axeSerious, createOwner, isDark, overflowsHorizontally, setDarkTheme, trackCsp } from "./settings-billing-admin-kit";
import { closeDb, db, type TestUser, watchErrors } from "./helpers";

const CONNECT = "/app/settings/connect";

/** Known environment limitation: the Facebook SDK refuses FB.login on plain http pages, and localhost is http. */
const HTTP_ONLY = /FB\.login can no longer be called from http pages/;

let owner: TestUser;

test.beforeAll(async () => {
  owner = await createOwner("sba-conn");
});
test.afterAll(closeDb);
test.beforeEach(async ({ context }) => {
  await apiLogin(context, owner.email);
  const d = await db();
  await d.query(`update "Tenant" set "onboardingStatus" = 'not_started' where id = $1`, [owner.tenantId]);
});

async function openConnectBySidebar(page: Page) {
  await page.goto("/app");
  const link = page.getByRole("link", { name: "Connect WhatsApp" }).first();
  await expect(link, "Connect WhatsApp should be in the settings menu for an owner").toBeVisible();
  await link.click();
  await expect(page).toHaveURL(/\/app\/settings\/connect/);
}

async function configured(page: Page): Promise<boolean> {
  const res = await page.request.get("/api/onboarding/start");
  return res.ok();
}

test("stepper explains every step before anything is clicked", async ({ page }) => {
  const errors = watchErrors(page);
  await openConnectBySidebar(page);

  await expect(page.getByRole("heading", { level: 1, name: "Connect WhatsApp" })).toBeVisible();
  await expect(page.getByRole("main")).toBeVisible();
  await expect(page.getByRole("navigation").first()).toBeVisible();
  for (const t of ["Get ready", "Sign in with Facebook", "We finish the setup", "Add a payment method"]) {
    await expect(page.getByRole("heading", { name: t })).toBeVisible();
  }
  await expect(page.getByText(/Four short steps, about 5 minutes/)).toBeVisible();
  await expect(page.getByText("Have these ready")).toBeVisible();

  // The "what will Facebook ask me" guide opens by keyboard and lists every screen.
  await page.getByText("What will Facebook ask me?").focus();
  await page.keyboard.press("Enter");
  for (const s of ["Log in to Facebook", "Choose or create a business portfolio", "Choose or create a WhatsApp Business account", "Add and verify your phone number", "Review what you are allowing"]) {
    await expect(page.getByText(s).first()).toBeVisible();
  }

  // Help card: each topic opens and has an answer.
  const topics = page.locator("details").filter({ has: page.locator("summary", { hasText: /Facebook window did not open|closed the window|cannot choose|cannot be used|limited|failed on the last screen|cannot send messages/ }) });
  expect(await topics.count()).toBeGreaterThanOrEqual(7);
  for (let i = 0; i < (await topics.count()); i++) {
    await topics.nth(i).locator("summary").click();
    await expect(topics.nth(i).locator("p")).toBeVisible();
  }
  // Plain language: no raw ids, enums or stack traces.
  const text = await page.locator("main").innerText();
  expect(text).not.toMatch(/\bundefined\b|\[object Object\]|TypeError|\bFINISH_\w+|\bWA_EMBEDDED_SIGNUP\b/);
  expect(errors, errors.join("\n")).toEqual([]);
});

test("clicking Connect with the Meta configuration missing gives a helpful message and never throws", async ({ page }) => {
  test.skip(await configured(page), "This instance has a Meta embedded signup configuration, so the missing-config path cannot be reached.");
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  const sdkRequests: string[] = [];
  page.on("request", (r) => /connect\.facebook\.net/.test(r.url()) && sdkRequests.push(r.url()));
  await page.goto(CONNECT);
  await page.getByRole("button", { name: "Connect WhatsApp" }).click();

  const alert = page.getByRole("group", { name: "Connecting is not available yet" });
  await expect(alert).toBeVisible();
  await expect(alert).toBeFocused(); // focus moves to the result for keyboard and screen reader users
  await expect(alert).toContainText("This is a problem on our side, not yours.");
  await expect(alert).toContainText(/try again later/i);
  // The technical detail is tucked away and readable when opened.
  await alert.getByText("Details").click();
  await expect(alert.getByText("WhatsApp connection is not configured yet.")).toBeVisible();
  expect(await page.locator("main").innerText()).not.toMatch(/META_ES_CONFIG_ID|META_APP_ID|STATE_SECRET|undefined/);

  // Trying again is safe and gives the same clear message.
  await alert.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("group", { name: "Connecting is not available yet" })).toBeVisible();
  expect(pageErrors).toEqual([]);
  // Observation recorded for the report: the SDK is only requested after the configuration check, so on a page with
  // no configuration the SDK is never initialised and a dashboard mistake (such as the JSSDK toggle) cannot be seen.
  expect(sdkRequests).toEqual([]);
});

test("Facebook SDK loads and initialises from connect.facebook.net with no console errors, CSP violations or crashes", async ({ page }) => {
  const appId = process.env.META_APP_ID;
  test.skip(!appId, "META_APP_ID is not available to the test process");
  const csp = await trackCsp(page);
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const sdkRequests: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && !HTTP_ONLY.test(m.text())) consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("request", (r) => /connect\.facebook\.net/.test(r.url()) && sdkRequests.push(r.url()));
  // Present a complete embedded-signup configuration so the SDK path is exercised against the real SDK.
  await page.route("**/api/onboarding/start", (route) => route.fulfill({ json: { configId: "1234567890", appId, state: "uat-state" } }));

  await page.goto(CONNECT);
  const popup = page.waitForEvent("popup", { timeout: 25_000 }).catch(() => null);
  await page.getByRole("button", { name: "Connect WhatsApp" }).click();

  await expect.poll(() => sdkRequests.length, { timeout: 25_000 }).toBeGreaterThan(0);
  expect(sdkRequests[0]).toBe("https://connect.facebook.net/en_US/sdk.js");
  await expect.poll(() => page.evaluate(() => typeof (window as unknown as { FB?: { init?: unknown } }).FB?.init), { timeout: 25_000 }).toBe("function");
  const pop = await popup;
  expect(pop, "FB.login should open the Facebook window").not.toBeNull();
  await page.waitForTimeout(2500);

  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
  const violations = (await csp()).filter((v) => /^enforce/.test(v) && /facebook/.test(v));
  expect(violations, `CSP blocks Facebook SDK traffic:\n${violations.join("\n")}`).toEqual([]);
  expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
  await pop?.close().catch(() => {});
});

test("SDK blocked by an ad blocker shows a clear message with a way to retry", async ({ page }) => {
  await page.route("**/api/onboarding/start", (route) => route.fulfill({ json: { configId: "1234567890", appId: "1", state: "s" } }));
  await page.route("https://connect.facebook.net/**", (route) => route.abort());
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(CONNECT);
  await page.getByRole("button", { name: "Connect WhatsApp" }).click();
  const blocked = page.getByRole("group", { name: "The Facebook window could not open" });
  await expect(blocked).toBeVisible();
  await expect(blocked.getByText(/ad blocker/i).first()).toBeVisible();
  await expect(blocked.getByRole("button", { name: "Try again" })).toBeVisible();
  // The technical sentence stays one click away under Details.
  await blocked.getByText("Details").click();
  await expect(blocked.getByText(/Could not load the Facebook sign-in/)).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test("closing the Facebook window shows a calm cancelled state, and a reply without account details is explained", async ({ page }) => {
  await page.route("**/api/onboarding/start", (route) => route.fulfill({ json: { configId: "1", appId: "1", state: "s" } }));
  await page.route("https://connect.facebook.net/**", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `window.FB={init:function(){},login:function(cb){setTimeout(function(){cb(window.__fbReply||{authResponse:null})},50)}};if(window.fbAsyncInit)window.fbAsyncInit();`,
    }),
  );
  await page.goto(CONNECT);
  await page.getByRole("button", { name: "Connect WhatsApp" }).click();
  const cancelled = page.getByRole("group", { name: "The Facebook window was closed" });
  await expect(cancelled).toBeVisible();
  await expect(cancelled).toContainText("No changes were made");
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();

  await page.evaluate(() => ((window as unknown as { __fbReply: unknown }).__fbReply = { authResponse: { code: "abc" } }));
  await page.getByRole("button", { name: "Try again" }).click();
  const failure = page.getByRole("group").filter({ hasText: "Meta did not return your WhatsApp account details" });
  await expect(failure.first()).toBeVisible({ timeout: 15_000 });
  await expect(failure.first().getByText("What to check")).toBeVisible();
  await expect(failure.first().getByRole("button", { name: "Try again" })).toBeVisible();
});

test("an already connected workspace shows the payment step, Meta link and reconnect confirmation", async ({ page }) => {
  const d = await db();
  await d.query(`update "Tenant" set "onboardingStatus" = 'live' where id = $1`, [owner.tenantId]);
  await page.goto(CONNECT);
  await expect(page.getByText("Your WhatsApp number is connected")).toBeVisible();
  const manager = page.getByRole("link", { name: /Open WhatsApp Manager/ });
  await expect(manager).toHaveAttribute("href", /business\.facebook\.com/);
  await expect(manager).toHaveAttribute("target", "_blank");
  await expect(manager).toHaveAttribute("rel", /noopener/);
  await expect(page.getByRole("link", { name: "Go to templates" })).toHaveAttribute("href", "/app/templates");
  await page.getByText("Good to know before your first message").click();
  await expect(page.getByText(/250 people in 24 hours/)).toBeVisible();

  await page.getByText("Connect again or use a different number").click();
  await page.getByRole("button", { name: "Connect WhatsApp again" }).click();
  const dialog = page.getByRole("dialog", { name: "Connect WhatsApp again?" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Connect WhatsApp again" })).toBeFocused();
});

test("a failed earlier attempt is explained and can be resumed", async ({ page }) => {
  const d = await db();
  await d.query(`update "Tenant" set "onboardingStatus" = 'failed' where id = $1`, [owner.tenantId]);
  await page.goto(CONNECT);
  await expect(page.getByText("Your last attempt did not finish")).toBeVisible();
  await expect(page.getByText(/Nothing is lost/).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect WhatsApp" })).toBeVisible();
});

test("an agent cannot connect WhatsApp: no menu entry, calm explanation, API refuses", async ({ page, browser, context }) => {
  const mate = await addTeammate(context, "agent", "conn-agent");
  const agentCtx = await browser.newContext({ baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3500" });
  await apiLogin(agentCtx, mate.email);
  const ap = await agentCtx.newPage();
  await ap.goto("/app");
  await expect(ap.getByRole("main")).toBeVisible();
  await expect(ap.getByRole("link", { name: "Connect WhatsApp" })).toHaveCount(0);
  await ap.goto(CONNECT);
  await expect(ap.getByText("Ask an owner or admin to connect WhatsApp")).toBeVisible();
  await expect(ap.getByRole("button", { name: "Connect WhatsApp" })).toHaveCount(0);
  const res = await agentCtx.request.get("/api/onboarding/start");
  expect(res.status()).toBe(403);
  expect(await ap.locator("main").innerText()).not.toMatch(/undefined|Forbidden/);
  await agentCtx.close();
  void page;
});

test("a signed-out visitor is sent to sign in, not shown the page", async ({ page, context }) => {
  await context.clearCookies();
  await page.goto(CONNECT);
  await expect(page).toHaveURL(/\/login/);
});

test("accessible in light and dark themes (axe), tab order reaches Connect, dark theme stays readable", async ({ page }) => {
  await page.goto(CONNECT);
  await expect(page.getByRole("button", { name: "Connect WhatsApp" })).toBeVisible();
  expect(await axeSerious(page), "light theme").toEqual([]);

  let reached = false;
  for (let i = 0; i < 60 && !reached; i++) {
    await page.keyboard.press("Tab");
    reached = await page.evaluate(() => document.activeElement?.textContent?.trim() === "Connect WhatsApp" && document.activeElement.tagName === "BUTTON");
  }
  expect(reached, "Connect WhatsApp button must be reachable with Tab").toBe(true);

  expect(await setDarkTheme(page), "a visible theme toggle").toBe(true);
  expect(await isDark(page)).toBe(true);
  await expect(page.getByRole("heading", { name: "Connect your WhatsApp number" })).toBeVisible();
  expect(await axeSerious(page), "dark theme").toEqual([]);
});

test("@mobile fits a 360 px screen", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto(CONNECT);
  await expect(page.getByRole("button", { name: "Connect WhatsApp" })).toBeVisible();
  expect(await overflowsHorizontally(page)).toBe(0);
  await page.getByText("What will Facebook ask me?").click();
  expect(await overflowsHorizontally(page)).toBe(0);
});
