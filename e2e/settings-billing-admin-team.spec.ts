import { expect, test, type Page } from "@playwright/test";
import { addTeammate, apiLogin, axeSerious, createOwner, esc, isDark, overflowsHorizontally, setDarkTheme } from "./settings-billing-admin-kit";
import { closeDb, db, ORIGIN, PASSWORD, stamp, type TestUser, watchErrors } from "./helpers";

const TEAM = "/app/settings/team";
let owner: TestUser;
let stranger: TestUser;

test.beforeAll(async () => {
  owner = await createOwner("sba-team");
  stranger = await createOwner("sba-stranger");
});
test.afterAll(closeDb);
test.beforeEach(async ({ context }) => {
  await apiLogin(context, owner.email);
});

async function inviteViaUi(page: Page, email: string, roleLabel?: string) {
  await page.getByRole("button", { name: "Invite teammate" }).first().click();
  const dlg = page.getByRole("dialog", { name: "Invite a teammate" });
  await expect(dlg).toBeVisible();
  await dlg.getByLabel(/Email address/).fill(email);
  if (roleLabel) await dlg.getByLabel("Role").selectOption({ label: roleLabel });
  await dlg.getByRole("button", { name: "Create invite" }).click();
}

test("owner opens Team from the menu and sees themself, the role help and an empty invite list", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/app");
  await page.getByRole("link", { name: "Team", exact: true }).first().click();
  await expect(page).toHaveURL(/\/app\/settings\/team$/);
  await expect(page.getByRole("heading", { level: 1, name: "Team" })).toBeVisible();
  await expect(page.getByRole("main")).toBeVisible();
  const members = page.getByRole("table", { name: "People in this workspace" });
  await expect(members.getByRole("row", { name: new RegExp(esc(owner.email)) })).toBeVisible();
  await expect(members.getByText("You", { exact: true })).toBeVisible();
  await expect(page.getByText(/pick a new role, then select Change role/)).toBeVisible();
  await expect(page.getByText("No pending invites")).toBeVisible();
  // Plain language: role is shown as a label, never the raw enum.
  expect(await page.locator("main").innerText()).not.toMatch(/\bundefined\b|\[object Object\]/);
  expect(errors, errors.join("\n")).toEqual([]);
});

test("?invite=1 opens the invite dialog, validation errors are inline, Escape returns focus, and the link works again afterwards", async ({ page }) => {
  await page.goto(`${TEAM}?invite=1`);
  const dlg = page.getByRole("dialog", { name: "Invite a teammate" });
  await expect(dlg).toBeVisible();
  await expect(dlg.getByLabel(/Email address/)).toBeFocused();

  // Empty and malformed email.
  await dlg.getByRole("button", { name: "Create invite" }).click();
  await expect(dlg.getByText("Enter their email address.")).toBeVisible();
  await dlg.getByLabel(/Email address/).fill("not-an-email");
  await dlg.getByRole("button", { name: "Create invite" }).click();
  await expect(dlg.getByText(/Enter a full email address/)).toBeVisible();
  // Owner may pick Admin or Agent; Agent is the default.
  await expect(dlg.getByLabel("Role")).toHaveValue("agent");
  await expect(dlg.getByLabel("Role").locator("option")).toHaveText(["Agent", "Admin"]);

  // Escape closes, the parameter is removed and focus goes back to the page.
  await page.keyboard.press("Escape");
  await expect(dlg).toBeHidden();
  await expect(page).toHaveURL(/\/app\/settings\/team$/);
  await expect(page.getByRole("button", { name: "Invite teammate" }).first()).toBeVisible();

  // Same command works again.
  await page.goto(`${TEAM}?invite=1`);
  await expect(page.getByRole("dialog", { name: "Invite a teammate" })).toBeVisible();
});

test("owner invites an agent, copies the one-time link, cancels it, and the dead link says so plainly", async ({ page, context, browser }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
  await page.goto(TEAM);
  const email = `invitee+${stamp()}@example.com`;
  await inviteViaUi(page, email);
  const done = page.getByRole("dialog", { name: "Invite ready" });
  await expect(done).toBeVisible();
  const link = await done.getByLabel("Invite link").inputValue();
  expect(link).toMatch(/\/accept-invite\?token=/);
  await done.getByRole("button", { name: "Copy link" }).click();
  await expect(done.getByText("Copied").first()).toBeVisible();
  await done.getByRole("button", { name: "Done" }).click();
  await expect(done).toBeHidden();

  const invites = page.getByRole("table", { name: "Pending invites" });
  const row = invites.getByRole("row", { name: new RegExp(esc(email)) });
  await expect(row).toBeVisible();
  await expect(row).toContainText("Waiting to join");
  await expect(row).toContainText(/Expires in \d+ days?/);

  // Duplicate invite replaces the old one instead of piling up.
  await inviteViaUi(page, email);
  await page.getByRole("dialog", { name: "Invite ready" }).getByRole("button", { name: "Done" }).click();
  await expect(invites.getByRole("row", { name: new RegExp(esc(email)) })).toHaveCount(1);

  // Cancel the invite with a confirmation, then the old link is dead.
  await row.getByRole("button", { name: /Cancel invite/ }).click();
  const confirm = page.getByRole("alertdialog", { name: new RegExp(`Cancel the invite for ${esc(email)}`) });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Keep invite" }).click();
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: /Cancel invite/ }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Cancel invite" }).click();
  await expect(page.getByText("Invite canceled")).toBeVisible();
  await expect(page.getByText("No pending invites")).toBeVisible();

  const guest = await browser.newContext({ baseURL: ORIGIN });
  const gp = await guest.newPage();
  await gp.goto(link.replace(/^https?:\/\/[^/]+/, ""));
  await expect(gp.getByRole("alert").filter({ hasText: /invalid or has expired/ })).toBeVisible();
  await expect(gp.getByRole("link", { name: "Sign in" })).toBeVisible();
  await guest.close();
});

test("inviting someone who is already on the team is refused with a plain message", async ({ page }) => {
  await page.goto(TEAM);
  await inviteViaUi(page, owner.email);
  const dlg = page.getByRole("dialog", { name: "Invite a teammate" });
  await expect(dlg.getByRole("alert")).toContainText("already a member");
  await expect(dlg.getByLabel(/Email address/)).toBeFocused();
});

test("a new teammate joins from the emailed link, then the owner changes their role and removes them", async ({ page, browser }) => {
  await page.goto(TEAM);
  const email = `joiner+${stamp()}@example.com`;
  await inviteViaUi(page, email, "Agent");
  const done = page.getByRole("dialog", { name: "Invite ready" });
  const link = await done.getByLabel("Invite link").inputValue();
  await done.getByRole("button", { name: "Done" }).click();

  // The invited person follows the link as a real new user.
  const guest = await browser.newContext({ baseURL: ORIGIN });
  const gp = await guest.newPage();
  await gp.goto(link.replace(/^https?:\/\/[^/]+/, ""));
  await expect(gp.getByRole("heading", { level: 1 })).toContainText(owner.workspace);
  await expect(gp.getByText(`You were invited as agent using ${email}`)).toBeVisible();
  await gp.getByLabel("Your name").fill("Joiner Person");
  await gp.getByLabel("Choose a password").fill(PASSWORD);
  await gp.getByRole("button", { name: "Join workspace" }).click();
  await gp.waitForURL(/\/app/, { timeout: 30_000 });
  await expect(gp.getByRole("main")).toBeVisible();
  // The link is single-use.
  const again = await guest.request.post("/api/auth/accept-invite", { headers: { origin: ORIGIN }, data: { token: new URL(link).searchParams.get("token"), name: "x", password: PASSWORD } });
  expect(again.status()).toBe(400);

  // Owner sees them as an agent and changes their role to admin.
  await page.reload();
  const members = page.getByRole("table", { name: "People in this workspace" });
  const row = members.getByRole("row", { name: /Joiner Person/ });
  await expect(row).toBeVisible();
  const select = row.getByLabel("Role for Joiner Person");
  await expect(select).toHaveValue("agent");
  await expect(row.getByRole("button", { name: /Change role/ })).toHaveCount(0); // nothing is sent until asked
  await select.selectOption("admin");
  await row.getByRole("button", { name: /Change role/ }).click();
  await expect(page.getByText("Joiner Person is now admin")).toBeVisible();
  await expect(select).toBeFocused();

  // Owner is not a role choice any more: handing over the workspace is a separate, password-protected step.
  expect((await select.locator("option").allInnerTexts()).sort()).toEqual(["Admin", "Agent"]);
  await page.getByLabel("New owner").selectOption({ label: "Joiner Person" });
  await page.getByRole("button", { name: "Transfer ownership" }).click();
  const ownerConfirm = page.getByRole("dialog", { name: "Make Joiner Person the owner?" });
  await expect(ownerConfirm).toBeVisible();
  await ownerConfirm.getByRole("button", { name: "Transfer ownership" }).click(); // no password entered: nothing happens
  await expect(ownerConfirm.getByText("Enter your password to confirm.")).toBeVisible();
  await ownerConfirm.getByRole("button", { name: "Cancel" }).click();
  await expect(ownerConfirm).toBeHidden();
  await select.selectOption("agent");
  await row.getByRole("button", { name: /Change role/ }).click();
  await expect(page.getByText("Joiner Person is now agent")).toBeVisible();

  // Remove with confirmation; the person loses access straight away.
  await row.getByRole("button", { name: /Remove/ }).click();
  const rm = page.getByRole("alertdialog", { name: "Remove Joiner Person?" });
  await expect(rm).toBeVisible();
  await rm.getByRole("button", { name: "Remove from team" }).click();
  await expect(page.getByText("Joiner Person was removed")).toBeVisible();
  await expect(members.getByRole("row", { name: /Joiner Person/ })).toHaveCount(0);
  const after = await guest.request.get("/api/workspace/members");
  expect([401, 403, 404]).toContain(after.status());
  await gp.goto("/app/inbox");
  await expect(gp).not.toHaveURL(/\/app\/inbox$/);
  await guest.close();
});

test("the last owner can neither leave nor demote themself, and the page says why", async ({ page, context }) => {
  await page.goto(TEAM);
  const members = page.getByRole("table", { name: "People in this workspace" });
  const me = members.getByRole("row", { name: new RegExp(esc(owner.email)) });
  await expect(me).toBeVisible();
  // Neither is offered: the server would refuse both (a workspace keeps one owner), so the page says what to do instead.
  await expect(page.getByText("You are the only owner, so you can't leave or change your own role. Make someone else the owner first.")).toBeVisible();
  await expect(me.getByRole("button", { name: /Leave workspace/ })).toHaveCount(0);
  await expect(me.getByLabel(`Role for ${owner.name}`)).toHaveCount(0);
  await expect(me.getByText("Owner", { exact: true })).toBeVisible();
  // With nobody to hand over to, the hand-over section says what to do instead of an empty picker.
  await expect(page.getByText("Invite a teammate first. Once they join, you can make them the owner here.")).toBeVisible();
  await expect(page.getByLabel("New owner")).toHaveCount(0);

  // The server still refuses, with the reason, for anyone calling the API directly.
  const leave = await context.request.delete(`/api/workspace/members/${owner.userId}`, { headers: { origin: ORIGIN } });
  expect(leave.status()).toBe(400);
  expect((await leave.json()).error).toMatch(/must keep at least one owner/);
  const demote = await context.request.patch(`/api/workspace/members/${owner.userId}`, { headers: { origin: ORIGIN }, data: { role: "agent" } });
  expect(demote.status()).toBe(400);
  expect((await demote.json()).error).toMatch(/must keep at least one owner/);
  const row = (await (await db()).query(`select role from "Membership" where "userId" = $1 and "tenantId" = $2`, [owner.userId, owner.tenantId])).rows[0];
  expect(row.role).toBe("owner");
});

test("an admin sees only Agent when inviting, cannot remove the owner, and cannot change roles", async ({ browser, context }) => {
  const admin = await addTeammate(context, "admin", "team-admin");
  const ctx = await browser.newContext({ baseURL: ORIGIN });
  await apiLogin(ctx, admin.email);
  const p = await ctx.newPage();
  await p.goto(TEAM);
  await expect(p.getByRole("heading", { level: 1, name: "Team" })).toBeVisible();
  // No role pickers for admins, owner row has no remove button.
  await expect(p.getByLabel(/^Role for /)).toHaveCount(0);
  const ownerRow = p.getByRole("table", { name: "People in this workspace" }).getByRole("row", { name: new RegExp(esc(owner.email)) });
  await expect(ownerRow).toBeVisible();
  await expect(ownerRow.getByRole("button")).toHaveCount(0);
  await p.getByRole("button", { name: "Invite teammate" }).first().click();
  const dlg = p.getByRole("dialog", { name: "Invite a teammate" });
  await expect(dlg.getByLabel("Role").locator("option")).toHaveText(["Agent"]);
  await expect(dlg.getByText("Only an owner can invite admins.")).toBeVisible();
  await p.keyboard.press("Escape");

  // The server enforces the same rules, not just the screen.
  const inviteAdmin = await ctx.request.post("/api/workspace/invites", { headers: { origin: ORIGIN }, data: { email: `x+${stamp()}@example.com`, role: "admin" } });
  expect(inviteAdmin.status()).toBe(403);
  const demote = await ctx.request.patch(`/api/workspace/members/${owner.userId}`, { headers: { origin: ORIGIN }, data: { role: "agent" } });
  expect(demote.status()).toBe(403);
  const removeOwner = await ctx.request.delete(`/api/workspace/members/${owner.userId}`, { headers: { origin: ORIGIN } });
  expect(removeOwner.status()).toBe(403);
  await ctx.close();
});

test("an agent sees a read-only team page: no invite button, no invite list, no role pickers, server refuses", async ({ browser, context }) => {
  const agent = await addTeammate(context, "agent", "team-agent");
  const ctx = await browser.newContext({ baseURL: ORIGIN });
  await apiLogin(ctx, agent.email);
  const p = await ctx.newPage();
  await p.goto("/app");
  await expect(p.getByRole("link", { name: "Team", exact: true })).toHaveCount(0); // not offered in the menu
  await p.goto(TEAM);
  await expect(p.getByText(/Owners and admins manage the team/)).toBeVisible();
  await expect(p.getByRole("button", { name: "Invite teammate" })).toHaveCount(0);
  await expect(p.getByText("Invites waiting to be accepted")).toHaveCount(0);
  await expect(p.getByLabel(/^Role for /)).toHaveCount(0);
  await expect(p.getByRole("button", { name: /Remove|Leave workspace/ })).toHaveCount(0);
  // ?invite=1 must not open the dialog for an agent.
  await p.goto(`${TEAM}?invite=1`);
  await expect(p.getByRole("heading", { level: 1, name: "Team" })).toBeVisible();
  await expect(p.getByRole("dialog")).toHaveCount(0);
  expect((await ctx.request.get("/api/workspace/invites")).status()).toBe(403);
  expect((await ctx.request.post("/api/workspace/invites", { headers: { origin: ORIGIN }, data: { email: `y+${stamp()}@example.com`, role: "agent" } })).status()).toBe(403);
  expect((await ctx.request.delete(`/api/workspace/members/${owner.userId}`, { headers: { origin: ORIGIN } })).status()).toBe(403);
  await ctx.close();
});

test("tenant isolation: another workspace sees only its own team and cannot touch this one by id", async ({ browser, context }) => {
  const mate = await addTeammate(context, "agent", "iso-mate");
  const inv = await context.request.post("/api/workspace/invites", { headers: { origin: ORIGIN }, data: { email: `iso+${stamp()}@example.com`, role: "agent" } });
  const invite = await inv.json();
  const ctx = await browser.newContext({ baseURL: ORIGIN });
  await apiLogin(ctx, stranger.email);
  const p = await ctx.newPage();
  await p.goto(TEAM);
  const table = p.getByRole("table", { name: "People in this workspace" });
  await expect(table.getByRole("row", { name: new RegExp(esc(stranger.email)) })).toBeVisible();
  await expect(p.getByText(owner.email)).toHaveCount(0);
  await expect(p.getByText(mate.email)).toHaveCount(0);
  const o = { headers: { origin: ORIGIN } };
  expect((await ctx.request.patch(`/api/workspace/members/${mate.userId}`, { ...o, data: { role: "admin" } })).status()).toBe(404);
  expect((await ctx.request.delete(`/api/workspace/members/${mate.userId}`, o)).status()).toBe(404);
  expect((await ctx.request.delete(`/api/workspace/invites/${invite.id}`, o)).status()).toBe(404);
  const list = await (await ctx.request.get("/api/workspace/members")).json();
  expect(JSON.stringify(list)).not.toContain(owner.email);
  await ctx.close();
});

test("API calls from another origin and signed-out callers are refused", async ({ page, context }) => {
  const cross = await context.request.post("/api/workspace/invites", { headers: { origin: "https://evil.example" }, data: { email: `z+${stamp()}@example.com`, role: "agent" } });
  expect([400, 403]).toContain(cross.status());
  await context.clearCookies();
  const anon = await context.request.get("/api/workspace/members");
  expect(anon.status()).toBe(401);
  await page.goto(TEAM);
  await expect(page).toHaveURL(/\/login/);
});

test("app header: workspace switcher and account buttons have accessible names that include their visible text (WCAG 2.5.3)", async ({ page }) => {
  await page.goto(TEAM);
  await expect(page.getByRole("heading", { level: 1, name: "Team" })).toBeVisible();
  const violations = (await axeSerious(page, { includeShell: true })).filter((v) => v.startsWith("label-content-name-mismatch"));
  expect(violations, violations.join("\n")).toEqual([]);
});

test("accessible in light and dark themes, tables have headers, keyboard can open and close the invite dialog", async ({ page }) => {
  await page.goto(TEAM);
  await expect(page.getByRole("table", { name: "People in this workspace" })).toBeVisible();
  expect(await axeSerious(page), "light").toEqual([]);

  const invite = page.getByRole("button", { name: "Invite teammate" }).first();
  await invite.focus();
  await page.keyboard.press("Enter");
  const dlg = page.getByRole("dialog", { name: "Invite a teammate" });
  await expect(dlg).toBeVisible();
  // Focus stays inside the dialog when tabbing.
  for (let i = 0; i < 8; i++) await page.keyboard.press("Tab");
  expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dlg).toBeHidden();
  await expect(invite).toBeFocused();

  expect(await setDarkTheme(page)).toBe(true);
  expect(await isDark(page)).toBe(true);
  expect(await axeSerious(page), "dark").toEqual([]);
});

test("Add a team: an empty name puts the cursor back in the name field, so typing goes there", async ({ page }) => {
  await page.goto("/app/settings/teams");
  await page.getByRole("button", { name: "Add a team" }).click();
  const dlg = page.getByRole("dialog", { name: "Add a team" });
  await expect(dlg).toBeVisible();
  await dlg.getByRole("button", { name: "Add team" }).click();
  await expect(dlg.getByText("Give the team a name.")).toBeVisible();
  const field = dlg.getByLabel(/Team name/);
  await expect(field).toBeFocused();
  await page.keyboard.type("Sales");
  await expect(field).toHaveValue("Sales");
  await dlg.getByRole("button", { name: "Cancel" }).click();
  await expect(dlg).toBeHidden();
});

test("@mobile team page fits 360 px and the invite dialog is usable", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto(TEAM);
  await expect(page.getByRole("heading", { level: 1, name: "Team" })).toBeVisible();
  expect(await overflowsHorizontally(page)).toBe(0);
  await page.getByRole("button", { name: "Invite teammate" }).first().click();
  const dlg = page.getByRole("dialog", { name: "Invite a teammate" });
  await expect(dlg).toBeVisible();
  const box = await dlg.boundingBox();
  expect(box!.width).toBeLessThanOrEqual(360);
  await expect(dlg.getByRole("button", { name: "Create invite" })).toBeInViewport();
  expect(await overflowsHorizontally(page)).toBe(0);
});
