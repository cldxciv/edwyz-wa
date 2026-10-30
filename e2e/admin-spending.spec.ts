/**
 * The platform admin's spending pages in the browser (docs/SPEND-CONTROLS-SPEC.md 8.3, 4.11, 10.4; WP-18/WP-19):
 * - list filters (stopped, near a limit) and search over every workspace;
 * - an override ceiling set from a workspace's Spending card, with a reason, ledgered as the platform admin;
 * - lifting the new-workspace limits;
 * - the platform switch with the typed confirmation, seen in a workspace's Spending limits page within 5 s, then turned
 *   back on (it always ends switched back on, even when a step fails);
 * - a signed-in customer gets the same 404 as a missing page, on the pages and the APIs;
 * - axe in light and dark, and no horizontal scroll at 360 px.
 *
 * Needs, on the app under test: SPEND_DRY_RUN=1 (no Meta call leaves the machine), and PLATFORM_ADMIN_EMAILS containing
 * E2E_ADMIN_EMAIL (default admin-spend@example.com). The admin's TOTP step-up is a cookie signed with SESSION_SECRET, read
 * from the same .env as the app (e2e/helpers loads it).
 */
import { createHmac } from "node:crypto";
import { expect, request as pwRequest, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { axeSerious, dismissWelcome, noHorizontalOverflow } from "./audience-campaigns-util";
import { closeDb, db, ORIGIN, PASSWORD, stamp, type TestUser } from "./helpers";
import { apiLogin, createOwner, randomIp } from "./settings-billing-admin-kit";
import { clearPlatformFreeze, ledgerRows, seedSpendControl, spendDryRun, storedFreeze } from "./spend-kit";

const ADMIN = (process.env.E2E_ADMIN_EMAIL ?? "admin-spend@example.com").trim().toLowerCase();
const adminAllowed = () =>
  (process.env.PLATFORM_ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .includes(ADMIN);
const PLATFORM_ASSISTANTS_TEXT = "Edwyz has paused assistants for all workspaces while we check something.";

test.afterAll(async () => {
  await clearPlatformFreeze().catch(() => undefined);
  await closeDb();
});
test.beforeEach(() => {
  test.setTimeout(240_000);
});
test.skip(!spendDryRun(), "Spend specs need SPEND_DRY_RUN=1 on the app under test.");
test.skip(!adminAllowed() || !process.env.SESSION_SECRET, `Needs PLATFORM_ADMIN_EMAILS to contain ${ADMIN} and SESSION_SECRET in the app's .env.`);

/** The admin step-up cookie, signed exactly like src/lib/admin/stepup.ts signStepUp (30-minute lifetime). */
function stepUpValue(userId: string, nowMs = Date.now()): string {
  const key = createHmac("sha256", process.env.SESSION_SECRET ?? "").update("admin-stepup-v1").digest();
  const body = `${userId}.${Math.floor(nowMs / 1000) + 30 * 60}`;
  return `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
}

/** A signed-in platform admin who passed the TOTP step-up just now. */
async function adminSession(browser: Browser): Promise<{ context: BrowserContext; page: Page; userId: string }> {
  const context = await browser.newContext();
  const res = await context.request.post("/api/auth/signup", { headers: { origin: ORIGIN, "x-real-ip": randomIp() }, data: { name: "Spend Admin", email: ADMIN, password: PASSWORD, workspaceName: "spend admin workspace" } });
  expect([200, 201, 409]).toContain(res.status());
  const d = await db();
  await d.query(`UPDATE "User" SET "emailVerifiedAt" = COALESCE("emailVerifiedAt", now()), "totpEnabledAt" = COALESCE("totpEnabledAt", now()), "disabledAt" = NULL WHERE email = $1`, [ADMIN]);
  const userId = (await d.query(`SELECT id FROM "User" WHERE email = $1`, [ADMIN])).rows[0].id as string;
  await apiLogin(context, ADMIN);
  await context.addCookies([{ name: "wa_admin", value: stepUpValue(userId), url: ORIGIN, httpOnly: true, sameSite: "Strict" }]);
  return { context, page: await context.newPage(), userId };
}

/** A cached spending row for the list (what the 5-minute breakers task writes). */
async function seedSummary(user: TestUser, riskPct: number): Promise<void> {
  const money = (minor: number, currency = "INR") => ({ minor: String(minor), currency, formatted: currency === "CRD" ? `${minor} credits` : `₹${(minor / 100).toLocaleString("en-IN")}` });
  const value = {
    tenantId: user.tenantId,
    name: user.workspace,
    slug: user.workspace,
    plan: null,
    demo: false,
    newWorkspaceLimits: "on",
    adsToday: { spent: money(150_000), setAside: money(30_000), limit: money(200_000) },
    adsMonth: { spent: money(500_000), setAside: money(100_000), limit: money(2_000_000) },
    whatsappMonth: { spent: money(1_000), setAside: money(0), limit: money(500_000) },
    aiMonth: { used: money(10, "CRD"), limit: money(500, "CRD") },
    metaLimit: { state: "off", label: "Off" },
    breakersOpen: 0,
    requestsWaiting: 0,
    state: "on",
    riskPct,
    asOf: new Date().toISOString(),
    noAdAccount: false,
    noWhatsApp: true,
  };
  await (await db()).query(`INSERT INTO "PlatformSetting" ("key","value","updatedAt") VALUES ($1,$2,now()) ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value", "updatedAt" = now()`, [`spend:summary:${user.tenantId}`, JSON.stringify(value)]);
}

const spendingRow = (page: Page, name: string) => page.getByRole("link", { name, exact: true });

test.describe.configure({ mode: "serial" });

test("filters: Stopped and Near a limit narrow the list of every workspace", async ({ browser }) => {
  const stopped = await createOwner("admspend-stop");
  const busy = await createOwner("admspend-busy");
  await seedSpendControl(stopped.tenantId, { freeze: "all", frozenByKind: "owner", frozenReason: "Holiday" });
  await seedSummary(busy, 91);
  const admin = await adminSession(browser);
  const { page } = admin;
  try {
    await page.goto("/admin/spending");
    await expect(page.getByRole("heading", { level: 1, name: "Spending across workspaces" })).toBeVisible();
    await expect(page.getByText("Spending is on for all workspaces").first()).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Alerts" })).toBeVisible();

    await page.getByLabel("Search workspaces").fill(stopped.workspace);
    await page.getByLabel("Show").selectOption("stopped");
    await page.getByRole("button", { name: "Show", exact: true }).click();
    await expect(page).toHaveURL(/filter=stopped/);
    await expect(spendingRow(page, stopped.workspace)).toBeVisible();
    await expect(page.getByText("Stopped", { exact: true }).first()).toBeVisible();

    await page.goto(`/admin/spending?filter=stopped&q=${encodeURIComponent(busy.workspace)}`);
    await expect(spendingRow(page, busy.workspace)).toHaveCount(0);
    await page.goto(`/admin/spending?filter=near_limit&q=${encodeURIComponent(busy.workspace)}`);
    await expect(spendingRow(page, busy.workspace)).toBeVisible();
    await expect(page.getByText("Highest use 91%")).toBeVisible();
    // A workspace with no saved figures yet is still listed, with the safe defaults.
    await page.goto(`/admin/spending?q=${encodeURIComponent(stopped.workspace)}`);
    await expect(page.getByText("Not checked yet").first()).toBeVisible();
  } finally {
    await admin.context.close();
  }
});

test("an override ceiling with a reason, from the workspace's Spending card, applies and is ledgered as the platform admin", async ({ browser }) => {
  const owner = await createOwner("admspend-ovr");
  const admin = await adminSession(browser);
  const { page } = admin;
  try {
    await page.goto(`/admin/tenants/${owner.tenantId}`);
    const card = page.locator("section", { has: page.getByRole("heading", { level: 2, name: "Spending", exact: true }) });
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "Override ceiling" }).click();
    const dialog = page.getByRole("dialog", { name: "Override ceiling" });
    await dialog.getByLabel("What it limits").selectOption("messaging");
    await dialog.getByLabel("Most per month").fill("300");
    // A reason is required: the form will not send without one.
    await dialog.getByRole("button", { name: "Override ceiling" }).click();
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Reason").fill("Spam complaints from customers");
    await dialog.getByRole("button", { name: "Override ceiling" }).click();
    await expect(dialog).toBeHidden();
    const d = await db();
    const row = (await d.query(`SELECT "monthlyMinor"::text AS m, "reason" FROM "SpendCeiling" WHERE scope = 'tenant' AND "scopeId" = $1 AND pot = 'messaging'`, [owner.tenantId])).rows[0];
    expect(row).toEqual({ m: "30000", reason: "Spam complaints from customers" });
    const ledger = await ledgerRows(owner.tenantId, "ceiling.change");
    expect(ledger.map((r) => [r.phase, r.actorType])).toEqual([
      ["requested", "platform_admin"],
      ["applied", "platform_admin"],
    ]);
    const audit = (await d.query(`SELECT count(*)::int AS n FROM "AuditLog" WHERE action = 'admin.tenant.set_spend_ceiling' AND "tenantId" = $1`, [owner.tenantId])).rows[0].n;
    expect(audit).toBe(1);
    await page.reload();
    await expect(card.getByText("Spam complaints from customers").first()).toBeVisible();
  } finally {
    await admin.context.close();
  }
});

test("lifting the new-workspace limits shows at once in the list", async ({ browser }) => {
  const owner = await createOwner("admspend-lift");
  const admin = await adminSession(browser);
  const { page } = admin;
  try {
    await page.goto(`/admin/tenants/${owner.tenantId}`);
    await page.getByRole("button", { name: "Lift new-workspace limits" }).click();
    const dialog = page.getByRole("dialog", { name: "Lift new-workspace limits" });
    await dialog.getByLabel("Reason").fill("Known customer, paid by bank transfer");
    await dialog.getByRole("button", { name: "Lift new-workspace limits" }).click();
    await expect(dialog).toBeHidden();
    const d = await db();
    expect((await d.query(`SELECT probation FROM "SpendControl" WHERE "tenantId" = $1`, [owner.tenantId])).rows[0].probation).toBe("lifted");
    expect((await ledgerRows(owner.tenantId, "probation.change")).every((r) => r.actorType === "platform_admin")).toBe(true);
    await page.goto(`/admin/spending?q=${encodeURIComponent(owner.workspace)}`);
    await expect(spendingRow(page, owner.workspace)).toBeVisible();
    await expect(page.getByText("Lifted", { exact: true }).first()).toBeVisible();
    await page.goto(`/admin/spending?filter=new_workspace&q=${encodeURIComponent(owner.workspace)}`);
    await expect(spendingRow(page, owner.workspace)).toHaveCount(0);
  } finally {
    await admin.context.close();
  }
});

test("the platform switch needs STOP SPENDING and a reason, shows in a workspace within 5 s, and turns back on with START SPENDING", async ({ browser, context, page }) => {
  const owner = await createOwner("admspend-switch");
  await apiLogin(context, owner.email);
  await page.goto("/app/settings/spending");
  await dismissWelcome(page);
  await expect(page.getByRole("heading", { level: 1, name: "Spending limits" })).toBeVisible();
  const admin = await adminSession(browser);
  const a = admin.page;
  try {
    await a.goto("/admin/spending");
    await a.getByRole("button", { name: "Stop assistants everywhere" }).click();
    const dialog = a.getByRole("alertdialog", { name: "Stop assistants for every workspace?" });
    await expect(dialog).toBeVisible();
    const go = dialog.getByRole("button", { name: "Stop assistants everywhere" });
    await dialog.getByLabel("Reason").fill("Checking a problem in the ad assistant");
    await expect(go).toBeDisabled();
    await dialog.getByLabel("Type STOP SPENDING to confirm").fill("stop spending");
    await expect(go).toBeDisabled();
    await dialog.getByLabel("Type STOP SPENDING to confirm").fill("STOP SPENDING");
    await go.click();
    await expect(dialog).toBeHidden();
    const stoppedAt = Date.now();
    expect((await storedFreeze(owner.tenantId)).platform).toBe("assistants");

    await page.reload();
    await expect(page.getByText(PLATFORM_ASSISTANTS_TEXT).first()).toBeVisible({ timeout: 5_000 });
    expect(Date.now() - stoppedAt).toBeLessThan(15_000);
    const rows = await ledgerRows("*", "kill.platform");
    expect(rows.at(-1)).toMatchObject({ phase: "applied", actorType: "platform_admin", reason: "Checking a problem in the ad assistant" });

    await a.reload();
    await expect(a.getByText(/Assistants stopped since .* by .*: Checking a problem in the ad assistant/).first()).toBeVisible();
    await a.getByRole("button", { name: "Turn spending back on" }).click();
    const back = a.getByRole("dialog", { name: "Turn spending back on for every workspace?" });
    await back.getByLabel("Reason").fill("Checked, all fine");
    await back.getByLabel("Type START SPENDING to confirm").fill("START SPENDING");
    await back.getByRole("button", { name: "Turn spending back on" }).click();
    await expect(back).toBeHidden();
    expect((await storedFreeze(owner.tenantId)).platform).toBe("none");
    await expect(a.getByText("Spending is on for all workspaces").first()).toBeVisible();
  } finally {
    await clearPlatformFreeze();
    await admin.context.close();
  }
});

test("a signed-in customer gets the same 404 on every spending page and API", async ({ context, page }) => {
  const owner = await createOwner("admspend-probe");
  await apiLogin(context, owner.email);
  for (const p of ["/admin/spending", "/admin/spending/settings"]) {
    const res = await page.goto(p);
    expect(res?.status(), p).toBe(404);
    expect(await page.locator("body").innerText()).not.toMatch(/spending across|platform admin|notification sender/i);
  }
  for (const g of ["/api/admin/spending", "/api/admin/spending/settings", `/api/admin/spending/${owner.tenantId}`]) expect((await context.request.get(g)).status(), g).toBe(404);
  const o = { headers: { origin: ORIGIN } };
  expect((await context.request.post("/api/admin/spending/platform", { ...o, data: { action: "stop_all", reason: "x", confirm: "STOP SPENDING" } })).status()).toBe(404);
  expect((await context.request.post(`/api/admin/spending/${owner.tenantId}`, { ...o, data: { action: "lift_probation", reason: "x" } })).status()).toBe(404);
  expect((await context.request.put("/api/admin/spending/settings", { ...o, data: { section: "fx", currency: "USD", rate: "1", reason: "x" } })).status()).toBe(404);
  expect((await storedFreeze(owner.tenantId)).platform).toBe("none");
  const anon = await pwRequest.newContext({ baseURL: ORIGIN });
  expect((await anon.get("/api/admin/spending")).status()).toBe(404);
  await anon.dispose();
});

test("the spending pages pass axe in light and dark and fit a 360 px screen @mobile", async ({ browser }) => {
  const admin = await adminSession(browser);
  const { page } = admin;
  try {
    const marker = `admspend-axe-${stamp()}`;
    for (const path of ["/admin/spending", "/admin/spending/settings"]) {
      await page.emulateMedia({ colorScheme: "light" });
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      expect(await axeSerious(page, `${path} light ${marker}`)).toEqual([]);
      await page.emulateMedia({ colorScheme: "dark" });
      await page.reload();
      expect(await axeSerious(page, `${path} dark ${marker}`)).toEqual([]);
      await page.setViewportSize({ width: 360, height: 740 });
      await page.reload();
      await noHorizontalOverflow(page, `${path} at 360px`);
      await page.setViewportSize({ width: 1280, height: 800 });
    }
  } finally {
    await admin.context.close();
  }
});
