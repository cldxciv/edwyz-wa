import { expect, test } from "@playwright/test";
import { closeDb, db, login, ORIGIN, PASSWORD } from "./helpers";

// Needs the server started with PLATFORM_ADMIN_EMAILS containing this address.
const ADMIN = "admin-qr@example.com";
test.afterAll(closeDb);

test("admin two-factor setup shows a scannable QR code next to the setup key", async ({ page, context }) => {
  const ip = `10.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`;
  const res = await context.request.post("/api/auth/signup", { headers: { origin: ORIGIN, "x-real-ip": ip }, data: { name: "QR Admin", email: ADMIN, password: PASSWORD, workspaceName: "qr admin workspace" } });
  expect([200, 201, 409]).toContain(res.status());
  const d = await db();
  await d.query(`UPDATE "User" SET "emailVerifiedAt" = now(), "totpEnabledAt" = NULL WHERE email = $1`, [ADMIN]);
  if (res.status() === 409) await login(page, ADMIN);

  await page.goto("/admin/security");
  await expect(page.getByRole("heading", { name: "Admin security" })).toBeVisible();
  await page.getByRole("button", { name: "Start setup" }).click();

  const qr = page.getByRole("img", { name: /QR code for your authenticator app/ });
  await expect(qr).toBeVisible();
  const box = await qr.boundingBox();
  expect(box && box.width).toBeGreaterThanOrEqual(150);
  expect(await qr.locator("svg").count()).toBe(1);
  // the modules are one large path (a few hundred squares), drawn on a white background so it scans in the dark theme as well
  const longest = await qr.locator("svg path").evaluateAll((els) => Math.max(0, ...els.map((e) => (e.getAttribute("d") ?? "").length)));
  expect(longest).toBeGreaterThan(500);
  expect(await qr.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(255, 255, 255)");

  // the text key is still offered as the fallback
  await expect(page.getByRole("button", { name: "Copy key" })).toBeVisible();
  await expect(page.locator("code").first()).toHaveText(/^[A-Z2-7]{16,}$/);

  await qr.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/admin-2fa-qr.png", fullPage: false });
});
