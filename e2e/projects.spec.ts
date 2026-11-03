/**
 * All projects and New project in the browser (D3, one workspace per project): every live workspace the person belongs to is a
 * card with its role, plan and figures and a Switch button; a deleted workspace is never listed; the workspace menu's New
 * project creates a workspace with a free trial and opens it; the account menu and the sidebar lead to the page. Each test
 * checks serious axe issues; the dark theme and (tagged @mobile, run on Pixel 7) sideways scrolling are checked too.
 */
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { closeDb, db, signupUser, stamp, watchErrors, type TestUser } from "./helpers";
import { axeSerious, goDark, isDark, noHorizontalOverflow } from "./audience-campaigns-util";
import { freshIp, skipWelcome } from "./auth-onboarding-util";

test.afterAll(closeDb);
test.beforeEach(() => {
  test.setTimeout(180_000);
});

async function owner(context: BrowserContext, page: Page): Promise<TestUser> {
  const u = await signupUser(context, "projects");
  await skipWelcome(context, u.userId);
  // Starting a project counts against the signup limit of the connection: give this browser its own address.
  await page.setExtraHTTPHeaders({ "x-real-ip": freshIp() });
  return u;
}

/** Gives the person another workspace (as an agent) and a deleted one, straight in the database. */
async function moreWorkspaces(userId: string) {
  const d = await db();
  const id = stamp();
  const second = `Second Shop ${id}`;
  const gone = `Deleted Shop ${id}`;
  await d.query(`insert into "Tenant" (id, name, slug) values ($1,$2,$3)`, [`t2_${id}`, second, `second-shop-${id}`]);
  await d.query(`insert into "Membership" (id, "tenantId", "userId", role) values ($1,$2,$3,'agent')`, [`m2_${id}`, `t2_${id}`, userId]);
  await d.query(`insert into "Tenant" (id, name, slug, "deletedAt") values ($1,$2,$3, now())`, [`t3_${id}`, gone, `deleted-shop-${id}`]);
  await d.query(`insert into "Membership" (id, "tenantId", "userId", role) values ($1,$2,$3,'owner')`, [`m3_${id}`, `t3_${id}`, userId]);
  return { second, gone };
}

test("All projects lists every live workspace with role, plan and figures, and switches to another", async ({ page, context }) => {
  const errors = watchErrors(page);
  const u = await owner(context, page);
  const { second, gone } = await moreWorkspaces(u.userId);

  await page.goto("/app");
  await page.getByRole("button", { name: "Account" }).click();
  await page.getByRole("menu", { name: "Account" }).getByRole("menuitem", { name: "All projects" }).click();
  await page.waitForURL(/\/app\/projects$/);
  await expect(page.getByRole("heading", { level: 1, name: "All projects" })).toBeVisible();
  await expect(page.getByText("2 projects", { exact: true })).toBeVisible();

  const mine = page.getByRole("article", { name: u.workspace });
  await expect(mine).toContainText("Current");
  await expect(mine).toContainText("Your role: Owner");
  await expect(mine).toContainText("Free trial");
  await expect(mine).toContainText("Trial ends on");
  await expect(mine).toContainText("WhatsApp number");
  await expect(mine).toContainText("Not connected");
  await expect(mine.getByRole("link", { name: "Open dashboard" })).toHaveAttribute("href", "/app");

  const other = page.getByRole("article", { name: second });
  await expect(other).toContainText("Your role: Agent");
  await expect(page.getByText(gone)).toHaveCount(0);

  expect(await axeSerious(page, "projects light"), "axe light").toEqual([]);
  await goDark(page);
  expect(await isDark(page)).toBe(true);
  expect(await axeSerious(page, "projects dark"), "axe dark").toEqual([]);

  await other.getByRole("button", { name: `Switch to ${second}` }).click();
  await page.waitForURL(/\/app$/);
  await expect(page.getByRole("button", { name: "Workspace" })).toContainText(second);
  expect(errors, errors.join("\n")).toEqual([]);
});

test("New project from the workspace menu starts a workspace with a free trial and opens it", async ({ page, context }) => {
  const errors = watchErrors(page);
  const u = await owner(context, page);
  const name = `Client ${stamp()}`;

  await page.goto("/app");
  await page.getByRole("button", { name: "Workspace" }).click();
  await page.getByRole("menu", { name: "Workspace" }).getByRole("menuitem", { name: /New project/ }).click();
  await page.waitForURL(/\/app\/projects\?new=1$/);
  const dialog = page.getByRole("dialog", { name: "Start a new project" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel(/Project name/)).toBeFocused();

  // The form checks itself and keeps the cursor in the field.
  await dialog.getByRole("button", { name: "Create project" }).click();
  await expect(dialog.getByText("Enter a name for the project.")).toBeVisible();
  await expect(dialog.getByLabel(/Project name/)).toBeFocused();

  await dialog.getByLabel(/Project name/).fill(name);
  await dialog.getByRole("button", { name: "Create project" }).click();
  await page.waitForURL(/\/app$/);
  await expect(page.getByRole("button", { name: "Workspace" })).toContainText(name);

  const d = await db();
  const row = (
    await d.query(
      `select t."trialEndsAt", m.role from "Tenant" t join "Membership" m on m."tenantId" = t.id where t.name = $1 and m."userId" = $2`,
      [name, u.userId],
    )
  ).rows[0];
  expect(row.role).toBe("owner");
  expect(row.trialEndsAt).not.toBeNull();

  // The same name again is refused under the field.
  await page.goto("/app/projects?new=1");
  const again = page.getByRole("dialog", { name: "Start a new project" });
  await again.getByLabel(/Project name/).fill(name);
  await again.getByRole("button", { name: "Create project" }).click();
  await expect(again.getByText(`You already have a project called "${name}". Choose a different name.`)).toBeVisible();
  await again.getByRole("button", { name: "Cancel" }).click();
  await expect(again).toBeHidden();
  await expect(page).toHaveURL(/\/app\/projects$/);
  expect(errors.filter((e) => !/409/.test(e)), errors.join("\n")).toEqual([]);
});

test("All projects works on a phone: one column of cards, no sideways scroll, reachable from the menu @mobile", async ({ page, context }) => {
  const u = await owner(context, page);
  await moreWorkspaces(u.userId);
  await page.goto("/app/projects");
  await expect(page.getByRole("heading", { level: 1, name: "All projects" })).toBeVisible();
  await expect(page.getByRole("article")).toHaveCount(2);
  await noHorizontalOverflow(page, "projects mobile");
  expect(await axeSerious(page, "projects mobile"), "axe mobile").toEqual([]);
  await goDark(page);
  await noHorizontalOverflow(page, "projects mobile dark");
  await page.getByRole("button", { name: "New project" }).click();
  await expect(page.getByRole("dialog", { name: "Start a new project" })).toBeVisible();
  await noHorizontalOverflow(page, "new project mobile");
});
