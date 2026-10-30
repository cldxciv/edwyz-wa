import { expect, test, type Page } from "@playwright/test";
import { PASSWORD, closeDb, db, signupUser, stamp, watchErrors } from "./helpers";
import { alerts, axeSerious, createEmailTokenRow, freshIp, noHorizontalOverflow } from "./auth-onboarding-util";

test.afterAll(closeDb);

const ORIGIN = "http://localhost:3500";

test.describe("landing and pricing", () => {
  test("landing page has landmarks, a single h1, working CTAs and no console errors", async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.getByRole("banner")).toBeVisible();
    await expect(page.getByRole("main")).toBeVisible();
    await expect(page.getByRole("contentinfo")).toBeVisible();
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Pricing" }).click();
    await expect(page).toHaveURL(/\/pricing/);
    await expect(page.getByRole("heading", { level: 1, name: "Pricing" })).toBeVisible();
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Start free trial" }).click();
    await expect(page).toHaveURL(/\/signup/);
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("landing: Sign in link and footer links work", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/login/);
    await page.goto("/");
    for (const [name, url] of [
      ["Privacy policy", /\/privacy/],
      ["Terms of service", /\/terms/],
      ["Data deletion", /\/data-deletion/],
    ] as const) {
      await page.getByRole("contentinfo").getByRole("link", { name }).click();
      await expect(page).toHaveURL(url);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await page.goBack();
    }
  });

  test("landing: in-page anchor (See how it works) scrolls to a real section", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "See how it works" }).click();
    await expect(page).toHaveURL(/#how-it-works/);
    await expect(page.locator("#how-it-works")).toBeInViewport();
  });

  test("landing and pricing: axe serious/critical", async ({ page }) => {
    test.setTimeout(300_000);
    const found: string[] = [];
    for (const p of ["/", "/pricing"]) {
      await page.goto(p);
      found.push(...(await axeSerious(page, p)));
    }
    expect(found, found.join("\n")).toEqual([]);
  });

  test("pricing: loads, billing toggle works, CTA goes to signup, no errors", async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto("/pricing");
    await expect(page.getByRole("heading", { level: 1, name: "Pricing" })).toBeVisible();
    const yearly = page.getByRole("link", { name: "Yearly" });
    if (await yearly.count()) {
      await yearly.click();
      await expect(page).toHaveURL(/billing=yearly/);
      await expect(page.getByRole("link", { name: "Yearly" })).toHaveAttribute("aria-current", "true");
    }
    const text = await page.locator("main").innerText();
    expect(text).not.toMatch(/undefined|NaN|\[object|\bnull\b/);
    await page.getByRole("main").getByRole("link", { name: /start free trial/i }).first().click();
    await expect(page).toHaveURL(/\/signup/);
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("public pages do not overflow at 360px and the mobile menu opens @mobile", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    for (const p of ["/", "/pricing", "/signup", "/login", "/forgot-password"]) {
      await page.goto(p);
      await noHorizontalOverflow(page, p);
    }
    await page.goto("/");
    const menu = page.getByRole("button", { name: /menu/i });
    await expect(menu).toBeVisible();
    await menu.click();
    await expect(page.getByRole("link", { name: "Sign in" }).first()).toBeVisible();
    await page.keyboard.press("Escape");
  });
});

test.describe("signup", () => {
  test("BUG-PROBE one mouse click on an empty form shows every error (layout shift on blur can swallow the click)", async ({ page }) => {
    await page.goto("/signup");
    await expect(page.getByRole("heading", { level: 1, name: "Start your free trial" })).toBeVisible();
    await page.getByRole("button", { name: "Create workspace" }).click();
    await expect(page.getByText("Enter your email address.")).toBeVisible({ timeout: 3000 });
  });

  test("empty submit (keyboard) shows plain-language errors and focuses the first bad field", async ({ page }) => {
    await page.goto("/signup");
    await expect(page.getByRole("heading", { level: 1, name: "Start your free trial" })).toBeVisible();
    await page.getByRole("button", { name: "Create workspace" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByText("Enter your name.")).toBeVisible();
    await expect(page.getByText("Enter your email address.")).toBeVisible();
    await expect(page.getByText(/Enter a workspace name/)).toBeVisible();
    await expect(page.getByText("Choose a password.")).toBeVisible();
    await expect(page.getByLabel("Your name")).toBeFocused();
    await expect(page.getByLabel("Your name")).toHaveAttribute("aria-invalid", "true");
  });

  test("email format, short password, strength hint and show password", async ({ page }) => {
    await page.goto("/signup");
    await page.getByLabel("Your name").fill("Asha Rao");
    await page.getByLabel("Work email").fill("not-an-email");
    await page.getByLabel("Work email").blur();
    await expect(page.getByText(/Enter a valid email address/)).toBeVisible();
    const pw = page.getByLabel("Password", { exact: true });
    await pw.fill("abc");
    await expect(page.getByText("Too short.")).toBeVisible();
    await pw.blur();
    await expect(page.getByText("Use at least 10 characters. Add 7 more.")).toBeVisible();
    await pw.fill("correct horse battery staple");
    await expect(page.getByText(/Strong\.|Good\./).first()).toBeVisible();
    await pw.fill("password12345");
    await expect(page.getByText("Weak.")).toBeVisible();
    await expect(pw).toHaveAttribute("type", "password");
    await page.getByRole("button", { name: "Show password" }).click();
    await expect(pw).toHaveAttribute("type", "text");
    await expect(page.getByRole("button", { name: "Hide password" })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Hide password" }).click();
    await expect(pw).toHaveAttribute("type", "password");
  });

  test("personal info in the password is flagged weak", async ({ page }) => {
    await page.goto("/signup");
    await page.getByLabel("Your name").fill("Priyanka Sharma");
    await page.getByLabel("Work email").fill("priyanka@example.com");
    await page.getByLabel("Password", { exact: true }).fill("priyanka-2026-xyz");
    await expect(page.getByText("Weak.")).toBeVisible();
  });

  test("a new user can sign up, lands in the app and sees their workspace", async ({ page }) => {
    const errors = watchErrors(page);
    const id = stamp();
    await page.setExtraHTTPHeaders({ "x-real-ip": freshIp() }); // own signup bucket
    await page.goto("/signup");
    await page.getByLabel("Your name").fill("Meera Iyer");
    await page.getByLabel("Work email").fill(`meera+${id}@example.com`);
    await page.getByLabel("Workspace name").fill(`Meera Bakery ${id}`);
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Create workspace" }).click();
    await page.waitForURL(/\/app/);
    await expect(page.getByRole("button", { name: "Workspace" })).toContainText(`Meera Bakery ${id}`);
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("duplicate email shows a friendly message and keeps what was typed", async ({ page, context }) => {
    const id = stamp();
    const email = `dup+${id}@example.com`;
    const r = await context.request.post("/api/auth/signup", { headers: { origin: ORIGIN, "x-real-ip": freshIp() }, data: { name: "Dup", email, password: PASSWORD, workspaceName: `Dup ${id}` } });
    expect(r.ok()).toBeTruthy();
    await context.clearCookies();
    await page.setExtraHTTPHeaders({ "x-real-ip": freshIp() });
    await page.goto("/signup");
    await page.getByLabel("Your name").fill("Dup Again");
    await page.getByLabel("Work email").fill(email);
    await page.getByLabel("Workspace name").fill("Another");
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Create workspace" }).click();
    await expect(alerts(page)).toContainText("An account with this email already exists");
    await expect(alerts(page)).not.toContainText(/prisma|stack|P20/i);
    await expect(page.getByLabel("Work email")).toHaveValue(email);
  });

  test("signup is keyboard operable in a logical Tab order", async ({ page }) => {
    await page.goto("/signup");
    await expect(page.getByLabel("Your name")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("Work email")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("Workspace name")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("Password", { exact: true })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Show password" })).toBeFocused();
    await expect(page.getByRole("link", { name: "Terms of Service" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Privacy Policy" })).toBeVisible();
    await page.getByRole("link", { name: "Sign in" }).last().click();
    await expect(page).toHaveURL(/\/login/);
  });

  test("auth pages: landmarks, one h1, axe", async ({ page }) => {
    test.setTimeout(300_000);
    const found: string[] = [];
    for (const p of ["/signup", "/login", "/forgot-password", "/reset-password", "/verify-email", "/accept-invite"]) {
      await page.goto(p);
      await expect(page.getByRole("heading", { level: 1 }), p).toHaveCount(1);
      await expect(page.getByRole("main"), p).toBeVisible();
      found.push(...(await axeSerious(page, p)));
    }
    expect(found, found.join("\n")).toEqual([]);
  });
});

test.describe("login", () => {
  test("validation, then identical message for wrong password and unknown email", async ({ page, context }) => {
    const id = stamp();
    const email = `login+${id}@example.com`;
    await context.request.post("/api/auth/signup", { headers: { origin: ORIGIN, "x-real-ip": freshIp() }, data: { name: "Login T", email, password: PASSWORD, workspaceName: `Login ${id}` } });
    await context.clearCookies();
    await page.goto("/login");
    await expect(page.getByRole("heading", { level: 1, name: "Welcome back" })).toBeVisible();
    await page.getByLabel("Email").press("Enter");
    await expect(page.getByText("Enter your email address.")).toBeVisible();
    await expect(page.getByText("Enter your password.")).toBeVisible();

    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill("wrong password here");
    await page.getByRole("button", { name: "Sign in" }).click();
    const a = alerts(page);
    await expect(a).toBeVisible();
    const msgKnown = (await a.innerText()).trim();

    await page.getByLabel("Email").fill(`nobody+${id}@example.com`);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("button", { name: "Sign in" })).toBeEnabled();
    await expect(alerts(page)).toBeVisible();
    const msgUnknown = (await alerts(page).innerText()).trim();
    expect(msgUnknown).toBe(msgKnown);
    expect(msgKnown).toMatch(/email and password combination did not work/);
  });

  test("login reaches the app, honours the deep link, then logout ends the session", async ({ page, context }) => {
    const id = stamp();
    const email = `login2+${id}@example.com`;
    await context.request.post("/api/auth/signup", { headers: { origin: ORIGIN, "x-real-ip": freshIp() }, data: { name: "Login Two", email, password: PASSWORD, workspaceName: `Login Two ${id}` } });
    await context.clearCookies();
    await page.goto("/app/contacts");
    await expect(page).toHaveURL(/\/login/);
    expect(page.url()).toMatch(/next=/);
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/\/app\/contacts/);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    await page.getByRole("button", { name: "Account" }).click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await page.waitForURL(/\/login/);
    await page.goto("/app");
    await expect(page).toHaveURL(/\/login/);
    await page.goto("/app/contacts");
    await expect(page).toHaveURL(/\/login/);
  });

  test("open redirect in ?next is ignored", async ({ page, context }) => {
    const id = stamp();
    const email = `login3+${id}@example.com`;
    await context.request.post("/api/auth/signup", { headers: { origin: ORIGIN, "x-real-ip": freshIp() }, data: { name: "Login Three", email, password: PASSWORD, workspaceName: `Login Three ${id}` } });
    await context.clearCookies();
    await page.goto("/login?next=https://evil.example.com/x");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/localhost:3500\/app/);
    expect(new URL(page.url()).hostname).toBe("localhost");
  });

  test("login: forgot password link, signup link, show password", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByLabel("Email")).toBeFocused();
    await page.getByRole("button", { name: "Show password" }).click();
    await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute("type", "text");
    await page.getByRole("link", { name: "Forgot password?" }).click();
    await expect(page).toHaveURL(/\/forgot-password/);
    await page.getByRole("link", { name: "Back to sign in" }).focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/login/);
    await page.getByRole("link", { name: "Start your free trial" }).focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/signup/);
  });

  test("BUG-PROBE first mouse click on 'Back to sign in' (forgot password) navigates", async ({ page }) => {
    await page.goto("/forgot-password");
    // Without email delivery the page shows a notice instead of the form, so there is no field to focus.
    if (await resetFormShown(page)) await expect(page.getByLabel("Email")).toBeFocused();
    await page.getByRole("link", { name: "Back to sign in" }).click();
    await expect(page).toHaveURL(/\/login/, { timeout: 4000 });
  });

  test("BUG-PROBE first mouse click on 'Sign in' link at the bottom of signup navigates", async ({ page }) => {
    await page.goto("/signup");
    await expect(page.getByLabel("Your name")).toBeFocused();
    await page.getByRole("link", { name: "Sign in" }).last().click();
    await expect(page).toHaveURL(/\/login/, { timeout: 4000 });
  });

  test("login when the server is unreachable shows a clear message", async ({ page }) => {
    await page.goto("/login");
    await page.route("**/api/auth/login", (r) => r.abort("failed"));
    await page.getByLabel("Email").fill("someone@example.com");
    await page.getByLabel("Password", { exact: true }).fill("whatever1234");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(alerts(page)).toContainText("could not reach the server");
    await expect(page.getByRole("button", { name: "Sign in" })).toBeEnabled();
  });

  test("login server 500 shows a friendly message, no stack trace", async ({ page }) => {
    await page.goto("/login");
    await page.route("**/api/auth/login", (r) => r.fulfill({ status: 500, contentType: "text/html", body: "<html>Internal Server Error</html>" }));
    await page.getByLabel("Email").fill("someone@example.com");
    await page.getByLabel("Password", { exact: true }).fill("whatever1234");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(alerts(page)).toContainText("Something went wrong");
  });

  test("a signed-in user visiting /login or /signup is not left on a dead end", async ({ page, context }) => {
    await signupUser(context);
    await page.goto("/login");
    await page.waitForLoadState("networkidle");
    const url = page.url();
    const hasForm = await page.getByRole("button", { name: "Sign in" }).count();
    expect(url.includes("/app") || hasForm > 0).toBeTruthy();
  });
});

/** True when this server can send email, so /forgot-password shows the form; false when it shows the "not available yet" notice. */
async function resetFormShown(page: Page): Promise<boolean> {
  await expect(page.getByRole("heading", { level: 1, name: "Reset your password" })).toBeVisible();
  return (await page.getByText("Password reset by email is not available yet.").count()) === 0;
}

test.describe("forgot and reset password", () => {
  test("without email delivery, forgot password says so plainly and offers a way to get help", async ({ page }) => {
    await page.goto("/forgot-password");
    test.skip(await resetFormShown(page), "this server can send email; the form path is covered below");
    await expect(page.getByText("Password reset by email is not available yet.")).toBeVisible();
    await expect(page.getByRole("link", { name: /@/ }).first()).toHaveAttribute("href", /^mailto:.+subject=Password%20reset/);
    await expect(page.getByRole("button", { name: "Send reset link" })).toHaveCount(0);
    await page.getByRole("link", { name: "Back to sign in" }).click();
    await expect(page).toHaveURL(/\/login/);
  });

  test("forgot password shows the same generic confirmation for known and unknown emails", async ({ page, context }) => {
    await page.goto("/forgot-password");
    test.skip(!(await resetFormShown(page)), "email delivery is off on this server, so the form is replaced by a notice");
    const id = stamp();
    const email = `forgot+${id}@example.com`;
    await context.request.post("/api/auth/signup", { headers: { origin: ORIGIN, "x-real-ip": freshIp() }, data: { name: "Forgot T", email, password: PASSWORD, workspaceName: `Forgot ${id}` } });
    await context.clearCookies();
    const texts: string[] = [];
    for (const e of [email, `ghost+${id}@example.com`]) {
      await page.goto("/forgot-password");
      await expect(page.getByRole("heading", { level: 1, name: "Reset your password" })).toBeVisible();
      await page.getByLabel("Email").fill(e);
      await page.getByRole("button", { name: "Send reset link" }).click();
      const s = page.getByRole("status");
      await expect(s).toContainText("Check your email");
      texts.push((await s.innerText()).trim());
    }
    expect(texts[0]).toBe(texts[1]);
  });

  test("forgot password validates the email", async ({ page }) => {
    await page.goto("/forgot-password");
    test.skip(!(await resetFormShown(page)), "email delivery is off on this server, so the form is replaced by a notice");
    await page.getByLabel("Email").press("Enter");
    await expect(page.getByText("Enter your email address.")).toBeVisible();
    await page.getByLabel("Email").fill("bad@");
    await page.getByLabel("Email").press("Enter");
    await expect(page.getByText(/valid email/)).toBeVisible();
  });

  test("reset password: missing token shows guidance with a link to request a new one", async ({ page }) => {
    await page.goto("/reset-password");
    await expect(alerts(page)).toContainText("incomplete");
    await page.getByRole("link", { name: "request a new one" }).click();
    await expect(page).toHaveURL(/\/forgot-password/);
  });

  test("reset password: bad and expired tokens fail clearly; valid token changes the password and ends old sessions", async ({ page, context }) => {
    const u = await signupUser(context);
    await page.setExtraHTTPHeaders({ "x-real-ip": freshIp() }); // reset-password allows 10 attempts per 15 min per IP; this test makes 4
    await page.goto("/app");
    await expect(page).toHaveURL(/\/app/);

    await page.goto("/reset-password?token=garbage");
    await page.getByLabel("New password").fill("a brand new password");
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(alerts(page)).toBeVisible();
    await expect(alerts(page)).not.toContainText(/prisma|undefined|Error:/);

    await page.goto("/reset-password?token=garbage");
    await page.getByLabel("New password").fill("short");
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(page.getByText("Use at least 10 characters. Add 5 more.")).toBeVisible();

    const expired = await createEmailTokenRow(u.userId, "reset", { expired: true });
    await page.goto(`/reset-password?token=${expired}`);
    await page.getByLabel("New password").fill("a brand new password");
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(alerts(page)).toBeVisible();

    const token = await createEmailTokenRow(u.userId, "reset");
    await page.goto(`/reset-password?token=${token}`);
    await page.getByLabel("New password").fill("a brand new password");
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(page.getByRole("status")).toContainText("Your password was changed");

    await page.goto(`/reset-password?token=${token}`);
    await page.getByLabel("New password").fill("another new password");
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(alerts(page)).toBeVisible();

    await page.goto("/app");
    await expect(page).toHaveURL(/\/login/);

    await page.getByLabel("Email").fill(u.email);
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(alerts(page)).toBeVisible();
    await page.getByLabel("Password", { exact: true }).fill("a brand new password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/\/app/);
  });
});

test.describe("verify email", () => {
  test("missing token, bad token, then a valid token confirms once", async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto("/verify-email");
    await expect(alerts(page)).toContainText("incomplete");
    await page.goto("/verify-email?token=nope");
    await expect(alerts(page)).toContainText(/invalid or has expired/);
    await page.getByRole("link", { name: "Back to sign in" }).click();
    await expect(page).toHaveURL(/\/login/);

    const id = stamp();
    const email = `verify+${id}@example.com`;
    const r = await page.context().request.post("/api/auth/signup", { headers: { origin: ORIGIN, "x-real-ip": freshIp() }, data: { name: "Verify T", email, password: PASSWORD, workspaceName: `Verify ${id}` } });
    expect(r.ok()).toBeTruthy();
    const d = await db();
    const userId = (await d.query(`select id from "User" where email=$1`, [email])).rows[0].id;
    expect((await d.query(`select "emailVerifiedAt" from "User" where id=$1`, [userId])).rows[0].emailVerifiedAt).toBeNull();
    const token = await createEmailTokenRow(userId, "verify");
    await page.goto(`/verify-email?token=${token}`);
    await expect(page.getByRole("status")).toContainText("Your email address is confirmed");
    await page.getByRole("link", { name: "Continue to your workspace" }).click();
    await expect(page).toHaveURL(/\/app/);
    expect((await d.query(`select "emailVerifiedAt" from "User" where id=$1`, [userId])).rows[0].emailVerifiedAt).not.toBeNull();
    await page.goto(`/verify-email?token=${token}`);
    await expect(alerts(page)).toContainText(/invalid or has expired/);
    expect(errors.filter((e) => !/status of 400/.test(e))).toEqual([]);
  });

  test("an unverified user can use the app; informational check for any verify prompt", async ({ page, context }) => {
    const id = stamp();
    const email = `unver+${id}@example.com`;
    await context.request.post("/api/auth/signup", { headers: { origin: ORIGIN, "x-real-ip": freshIp() }, data: { name: "Unver T", email, password: PASSWORD, workspaceName: `Unver ${id}` } });
    await page.goto("/app");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const body = await page.locator("body").innerText();
    test.info().annotations.push({ type: "info", description: `verify prompt in UI: ${/verify|confirm your email/i.test(body)}` });
  });
});
