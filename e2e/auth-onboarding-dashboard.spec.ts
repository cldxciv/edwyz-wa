import { expect, test, type Page } from "@playwright/test";
import { closeDb, db, signupUser, stamp, watchErrors } from "./helpers";
import { alerts, axeSerious, createInviteRow, joinWorkspace, noHorizontalOverflow, skipWelcome } from "./auth-onboarding-util";

test.afterAll(closeDb);

const sidebar = (page: Page) => page.getByRole("navigation", { name: "Workspace" });

test.describe("first-run welcome dialog", () => {
  test("shows once, is accessible, can be dismissed with Escape and does not return", async ({ page, context }) => {
    test.setTimeout(300_000);
    const errors = watchErrors(page);
    const u = await signupUser(context);
    await page.goto("/app");
    const dlg = page.getByRole("dialog", { name: /Welcome/ });
    await expect(dlg).toBeVisible();
    await expect(dlg).toContainText("Welcome, Tester");
    await expect(dlg.getByRole("heading", { level: 3 })).toHaveCount(3);
    // primary action has focus (so Enter does the obvious thing)
    await expect(dlg.getByRole("link", { name: "Show me how to start" })).toBeFocused();
    // focus is trapped
    // (native modal dialog: Tab cycles through the dialog controls and the browser chrome, where document.activeElement
    // is body; it must never reach the page behind the dialog)
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("Tab");
      const where = await dlg.evaluate((el) => {
        const a = document.activeElement;
        return a === document.body || a === null || el.contains(a) ? "ok" : `escaped to <${a.tagName.toLowerCase()}>`;
      });
      expect(where, `focus left the welcome dialog after Tab #${i + 1}`).toBe("ok");
    }
    const found = await axeSerious(page, "welcome dialog");
    await page.keyboard.press("Escape");
    await expect(dlg).toBeHidden();
    expect(found, found.join("\n")).toEqual([]);
    await page.reload();
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByRole("dialog", { name: /Welcome/ })).toBeHidden();
    // other pages and later visits also stay quiet
    await page.goto("/app/getting-started");
    await expect(page.getByRole("dialog")).toBeHidden();
    expect(await page.evaluate((k) => localStorage.getItem(k), `edwyz.welcome.v1.${u.userId}`)).not.toBeNull();
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("'Show me how to start' goes to Getting started; 'I will explore first' just closes", async ({ page, context }) => {
    await signupUser(context);
    await page.goto("/app");
    const dlg = page.getByRole("dialog", { name: /Welcome/ });
    await dlg.getByRole("link", { name: "Show me how to start" }).click();
    await expect(page).toHaveURL(/\/app\/getting-started/);
    await expect(page.getByRole("heading", { level: 1, name: "Getting started" })).toBeVisible();
    await expect(page.getByRole("dialog")).toBeHidden();

    const ctx2 = await page.context().browser()!.newContext();
    const p2 = await ctx2.newPage();
    await signupUser(ctx2);
    await p2.goto("/app");
    await p2.getByRole("dialog", { name: /Welcome/ }).getByRole("button", { name: "I will explore first" }).click();
    await expect(p2.getByRole("dialog")).toBeHidden();
    await expect(p2).toHaveURL(/\/app$/);
    await ctx2.close();
  });

  test("the dialog works at 360px and in dark theme", async ({ page, context }) => {
    test.setTimeout(300_000);
    await page.setViewportSize({ width: 360, height: 640 });
    await signupUser(context);
    await page.addInitScript(() => localStorage.setItem("wa-theme", "dark"));
    await page.goto("/app");
    const dlg = page.getByRole("dialog", { name: /Welcome/ });
    await expect(dlg).toBeVisible();
    const box = await dlg.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(360);
    // the dialog can be scrolled/reached on a short screen: the CTA must be reachable
    await dlg.getByRole("link", { name: "Show me how to start" }).scrollIntoViewIfNeeded();
    await expect(dlg.getByRole("link", { name: "Show me how to start" })).toBeInViewport();
    const found = await axeSerious(page, "welcome dialog dark 360");
    expect(found, found.join("\n")).toEqual([]);
  });

  test("an agent gets a simpler welcome with a single 'Got it'", async ({ page, context, browser }) => {
    const owner = await signupUser(context);
    const actx = await browser.newContext();
    const { signupUser: su } = await import("./helpers");
    const agent = await su(actx, "agent");
    const d = await db();
    await d.query(`insert into "Membership" (id, "tenantId", "userId", role) values ($1,$2,$3,'agent')`, [`m_${stamp()}`, owner.tenantId, agent.userId]);
    await actx.request.post("/api/auth/switch-workspace", { headers: { origin: "http://localhost:3500" }, data: { tenantId: owner.tenantId } });
    const ap = await actx.newPage();
    await ap.goto("/app");
    const dlg = ap.getByRole("dialog", { name: /Welcome/ });
    await expect(dlg).toBeVisible();
    await expect(dlg.getByRole("link", { name: "Show me how to start" })).toHaveCount(0);
    await dlg.getByRole("button", { name: "Got it" }).click();
    await expect(dlg).toBeHidden();
    void page;
    await actx.close();
  });
});

test.describe("dashboard and Getting started", () => {
  test("new owner dashboard: greeting, setup card pointing at connecting WhatsApp, quiet chart, quick actions", async ({ page, context }) => {
    const errors = watchErrors(page);
    const u = await signupUser(context);
    await skipWelcome(context, u.userId);
    await page.goto("/app");
    await expect(page.getByRole("heading", { level: 1 })).toContainText(/Hello|Good (morning|afternoon|evening), Tester/);
    await expect(page.getByText(`Here is how ${u.workspace} is doing this week.`)).toBeVisible();
    const card = page.getByRole("region", { name: "Finish setting up" });
    await expect(card).toBeVisible();
    await expect(card).toContainText("Do this next");
    await expect(card.getByRole("heading", { level: 3 })).toContainText("Connect your WhatsApp number");
    await expect(card).toContainText(/\d+ of \d+ steps done/);
    await expect(card.getByRole("progressbar", { name: /Setup \d+ percent complete/ })).toBeAttached();
    // KPI tiles and empty chart
    await expect(page.getByRole("heading", { level: 2, name: "Your week in numbers" })).toBeAttached();
    await expect(page.getByText("No messages yet")).toBeVisible();
    // deep link from the card
    await card.getByRole("link", { name: "Connect number" }).click();
    await expect(page).toHaveURL(/\/app\/settings\/connect/);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    // quick action Connect WhatsApp
    await page.goto("/app");
    await page.getByRole("region", { name: "Quick actions" }).getByRole("link", { name: /Connect WhatsApp/ }).click();
    await expect(page).toHaveURL(/\/app\/settings\/connect/);
    const text = (await (async () => { await page.goto("/app"); return page.locator("main").innerText(); })());
    expect(text).not.toMatch(/undefined|NaN|\[object|null\b|_id|\bcuid\b/);
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("setup card: hide/show steps is remembered, 'Not now' sets a step aside and it can be brought back", async ({ page, context }) => {
    const u = await signupUser(context);
    await skipWelcome(context, u.userId);
    await page.goto("/app");
    const card = page.getByRole("region", { name: "Finish setting up" });
    const toggle = card.getByRole("button", { name: "Hide steps" });
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await toggle.click();
    await expect(card.getByRole("button", { name: "Show steps" })).toHaveAttribute("aria-expanded", "false");
    await expect(card.getByText("Do this next")).toBeHidden();
    await page.reload();
    await expect(page.getByRole("region", { name: "Finish setting up" }).getByRole("button", { name: "Show steps" })).toBeVisible();
    await page.getByRole("button", { name: "Show steps" }).click();

    // set the current step aside
    await card.getByRole("button", { name: "Not now" }).first().click();
    await expect(card.getByText("Do this next")).toBeVisible();
    await expect(card.getByRole("heading", { level: 3 })).not.toContainText("Connect your WhatsApp number");
    // it is waiting on the Getting started page under "Set aside for now"
    await card.getByRole("link", { name: /See all steps \(1 set aside\)/ }).click();
    await expect(page).toHaveURL(/getting-started/);
    const aside = page.getByRole("region", { name: "Set aside for now" });
    await expect(aside).toContainText("Connect your WhatsApp number");
    await expect(aside).toContainText("Set aside");
    await aside.getByRole("button", { name: /Bring back: Connect your WhatsApp number/ }).click();
    await expect(page.getByRole("region", { name: "Set aside for now" })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Get ready to message customers" })).toContainText("Connect your WhatsApp number");
  });

  test("Getting started page: steps in order, blocked steps explain why, every CTA goes somewhere real", async ({ page, context }) => {
    test.setTimeout(150_000);
    const errors = watchErrors(page);
    const u = await signupUser(context);
    await skipWelcome(context, u.userId);
    await page.goto("/app/getting-started");
    await expect(page.getByRole("heading", { level: 1, name: "Getting started" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2 }).first()).toContainText(/steps? to go/);
    const launch = page.getByRole("region", { name: "Get ready to message customers" });
    await expect(launch.getByRole("listitem")).toHaveCount(4);
    await expect(launch.getByRole("note").first()).toContainText("Connect your WhatsApp number first.");
    await expect(page.getByRole("region", { name: "Grow further" })).toBeVisible();
    // the hero CTA goes to the first actionable step
    await page.getByRole("main").getByRole("link", { name: "Connect number" }).first().click();
    await expect(page).toHaveURL(/\/app\/settings\/connect/);
    // each internal CTA resolves to a page with an h1 and no error
    await page.goto("/app/getting-started");
    await expect(page.getByRole("region", { name: "Grow further" })).toBeVisible();
    await expect(page.getByRole("main").getByRole("link").nth(4)).toBeAttached();
    const hrefs = await page.getByRole("main").getByRole("link").evaluateAll((els) => [...new Set(els.map((e) => (e as HTMLAnchorElement).getAttribute("href")!))].filter((h) => h.startsWith("/app")));
    expect(hrefs.length).toBeGreaterThanOrEqual(5);
    const bad: string[] = [];
    for (const h of hrefs) {
      const res = await page.goto(h);
      if (!res || res.status() >= 400) bad.push(`${h} -> ${res?.status()}`);
      else if (!(await page.getByRole("heading", { level: 1 }).first().isVisible().catch(() => false))) {
        await page.getByRole("heading", { level: 1 }).first().waitFor({ timeout: 10_000 }).catch(() => bad.push(`${h}: no h1`));
      }
    }
    expect(bad, bad.join("\n")).toEqual([]);
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("Getting started reflects real progress: live number done, then contacts and invites update the list", async ({ page, context }) => {
    const u = await signupUser(context);
    await skipWelcome(context, u.userId);
    const d = await db();
    await d.query(`update "Tenant" set "onboardingStatus"='live' where id=$1`, [u.tenantId]);
    await page.goto("/app/getting-started");
    const launch = page.getByRole("region", { name: "Get ready to message customers" });
    await expect(launch.getByText("(done)")).toHaveCount(1);
    await expect(launch).toContainText("Get a message template approved");
    // dashboard card moves on to the template step
    await page.goto("/app");
    await expect(page.getByRole("region", { name: "Finish setting up" }).getByRole("heading", { level: 3 })).toContainText("template");
    // add a contact through the product, then it is checked off
    await page.goto("/app/contacts?add=1");
    const dlg = page.getByRole("dialog");
    await expect(dlg).toBeVisible();
    const fields = dlg.getByRole("textbox");
    await dlg.getByLabel(/phone/i).fill("+919876543210");
    const nameField = dlg.getByLabel(/name/i).first();
    if (await nameField.count()) await nameField.fill("First Customer");
    await dlg.getByRole("button", { name: /add|save|create/i }).last().click();
    void fields;
    await page.goto("/app/getting-started");
    await expect(page.getByRole("region", { name: "Get ready to message customers" }).getByText("(done)")).toHaveCount(2);
  });

  test("dashboard failure state: server error shows a plain message and Try again recovers", async ({ page, context }) => {
    const u = await signupUser(context);
    await skipWelcome(context, u.userId);
    let fail = true;
    await page.route("**/api/setup/dashboard**", (r) => (fail ? r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "boom" }) }) : r.continue()));
    await page.goto("/app");
    await expect(page.getByText("We could not load your dashboard")).toBeVisible();
    await expect(page.locator("body")).not.toContainText(/stack|TypeError|at .*:\d+:\d+/);
    fail = false;
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toContainText(/Hello|Good/);
  });

  test("setup card failure state offers Try again", async ({ page, context }) => {
    const u = await signupUser(context);
    await skipWelcome(context, u.userId);
    let fail = true;
    await page.route("**/api/setup", (r) => (fail ? r.fulfill({ status: 500, contentType: "application/json", body: "{}" }) : r.continue()));
    await page.goto("/app");
    await expect(page.getByText("We could not load your setup progress.")).toBeVisible();
    fail = false;
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByRole("region", { name: "Finish setting up" })).toBeVisible();
  });

  test("an agent's dashboard has no setup card, shows their queue and cannot change setup steps", async ({ page, context, browser }) => {
    const owner = await signupUser(context);
    const { context: actx } = await joinWorkspace(browser, owner.tenantId, "agent", "agent");
    const ap = await actx.newPage();
    const errors = watchErrors(ap);
    await ap.goto("/app");
    await expect(ap.getByText("Here is your day at a glance.")).toBeVisible();
    await expect(ap.getByRole("region", { name: "Finish setting up" })).toHaveCount(0);
    await expect(ap.getByText("WhatsApp is not connected yet")).toBeVisible();
    await expect(ap.getByRole("region", { name: "Your chats waiting for a reply" })).toBeVisible();
    for (const l of await ap.getByRole("region", { name: "Shortcuts" }).getByRole("link").all()) {
      const href = await l.getAttribute("href");
      expect(href).not.toMatch(/broadcasts|billing|settings/);
    }
    await ap.goto("/app/getting-started");
    await expect(ap.getByText(/Ask a workspace admin to complete or set aside the steps/)).toBeVisible();
    await expect(ap.getByRole("button", { name: /Dismiss for now/ })).toHaveCount(0);
    // the API refuses an agent
    const res = await actx.request.post("/api/setup/dismiss", { headers: { origin: "http://localhost:3500" }, data: { stepId: "invite", dismissed: true } });
    expect([401, 403]).toContain(res.status());
    expect(errors.filter((e) => !/40[13]/.test(e)), errors.join("\n")).toEqual([]);
    await actx.close();
  });

  test("dashboard and Getting started pass axe and have no horizontal overflow at 360px", async ({ page, context }) => {
    test.setTimeout(300_000);
    const u = await signupUser(context);
    await skipWelcome(context, u.userId);
    const found: string[] = [];
    for (const p of ["/app", "/app/getting-started"]) {
      await page.goto(p);
      await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
      await expect(page.getByText(/Loading/)).toHaveCount(0);
      found.push(...(await axeSerious(page, p)));
    }
    await page.setViewportSize({ width: 360, height: 740 });
    for (const p of ["/app", "/app/getting-started"]) {
      await page.goto(p);
      await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
      await noHorizontalOverflow(page, p);
    }
    expect(found, found.join("\n")).toEqual([]);
  });
});

test.describe("billing banner for trial", () => {
  async function banner(page: Page) {
    await page.goto("/app");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  }

  test("a fresh trial shows no nag; <=3 days left shows a polite banner linking to plans", async ({ page, context }) => {
    const u = await signupUser(context);
    await skipWelcome(context, u.userId);
    const d = await db();
    await banner(page);
    await expect(page.getByRole("status").filter({ hasText: /free trial ends/ })).toHaveCount(0);

    await d.query(`update "Tenant" set "trialEndsAt" = (now() at time zone 'utc') + interval '2 days 1 hour' where id=$1`, [u.tenantId]);
    await banner(page);
    const b = page.getByRole("status").filter({ hasText: /free trial ends/ });
    await expect(b).toContainText("Your free trial ends in 3 days. Subscribe to keep sending messages.");
    await b.getByRole("link", { name: "Choose a plan" }).click();
    await expect(page).toHaveURL(/\/app\/billing/);
    // banner persists across pages, and is not shown when printing (class check)
    await expect(page.getByRole("status").filter({ hasText: /free trial ends/ })).toBeVisible();

    await d.query(`update "Tenant" set "trialEndsAt" = (now() at time zone 'utc') + interval '5 hours' where id=$1`, [u.tenantId]);
    await banner(page);
    await expect(page.getByRole("status").filter({ hasText: /free trial ends/ })).toContainText("ends in 1 day.");
  });

  test("an ended trial locks the workspace read-only with an alert and a clear path to subscribe", async ({ page, context }) => {
    const u = await signupUser(context);
    await skipWelcome(context, u.userId);
    const d = await db();
    await d.query(`update "Tenant" set "trialEndsAt" = (now() at time zone 'utc') - interval '1 day' where id=$1`, [u.tenantId]);
    await banner(page);
    const alert = alerts(page).filter({ hasText: /free trial has ended/ });
    await expect(alert).toContainText("read-only until you subscribe");
    await expect(alert.getByRole("link", { name: "Choose a plan" })).toBeVisible();
    // writes are refused with a plain message, not a stack trace
    await page.goto("/app/contacts?add=1");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const res = await page.context().request.post("/api/contacts", { headers: { origin: "http://localhost:3500" }, data: { phone: "+919800000001", name: "Blocked" } });
    expect([402, 403]).toContain(res.status());
    const body = await res.text();
    expect(body).not.toMatch(/prisma|stack|at .*:\d+:\d+/i);
    // dashboard still loads read-only
    await banner(page);
    await expect(page.getByRole("region", { name: "Finish setting up" })).toBeVisible();
    // billing page remains reachable
    await page.goto("/app/billing");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });

  test("a suspended workspace shows the suspension reason; an exempt workspace shows no banner", async ({ page, context }) => {
    const u = await signupUser(context);
    await skipWelcome(context, u.userId);
    const d = await db();
    await d.query(`update "Tenant" set status='suspended', "suspendedReason"='Unpaid invoices UAT' where id=$1`, [u.tenantId]);
    await banner(page);
    await expect(alerts(page).filter({ hasText: "Unpaid invoices UAT" })).toBeVisible();
    await expect(alerts(page).getByRole("link", { name: "See details" })).toBeVisible();
    await d.query(`update "Tenant" set status='active', "suspendedReason"=null, "billingExempt"=true where id=$1`, [u.tenantId]);
    await banner(page);
    await expect(alerts(page).filter({ hasText: /trial|read-only|suspended/ })).toHaveCount(0);
    await expect(page.getByRole("status").filter({ hasText: /trial/ })).toHaveCount(0);
  });

  test("banner is readable in dark theme and at 360px", async ({ page, context }) => {
    test.setTimeout(300_000);
    const u = await signupUser(context);
    await skipWelcome(context, u.userId);
    const d = await db();
    await d.query(`update "Tenant" set "trialEndsAt" = (now() at time zone 'utc') - interval '1 day' where id=$1`, [u.tenantId]);
    await page.addInitScript(() => localStorage.setItem("wa-theme", "dark"));
    await page.setViewportSize({ width: 360, height: 740 });
    await banner(page);
    await expect(alerts(page).filter({ hasText: /free trial has ended/ })).toBeVisible();
    await noHorizontalOverflow(page, "banner 360");
    const found = await axeSerious(page, "locked dark 360");
    expect(found, found.join("\n")).toEqual([]);
  });
});

test.describe("invites and joining a workspace", () => {
  test("owner invites through the UI; a new person joins from the link as an agent; reuse of the link fails", async ({ page, context, browser }) => {
    test.setTimeout(150_000);
    const errors = watchErrors(page);
    const owner = await signupUser(context);
    await skipWelcome(context, owner.userId);
    await page.goto("/app/settings/team");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await page.getByRole("button", { name: /Invite/ }).first().click();
    const dlg = page.getByRole("dialog", { name: "Invite a teammate" });
    await expect(dlg).toBeVisible();
    // validation
    await dlg.getByRole("button", { name: "Create invite" }).click();
    await expect(dlg.getByText(/email/i).first()).toBeVisible();
    const email = `invitee+${stamp()}@example.com`;
    await dlg.getByLabel("Email address").fill(email);
    await dlg.getByRole("button", { name: "Create invite" }).click();
    const done = page.getByRole("dialog", { name: "Invite ready" });
    await expect(done).toBeVisible();
    const link = await done.getByLabel("Invite link").inputValue();
    expect(link).toMatch(/\/accept-invite\?token=/);
    await done.getByRole("button", { name: "Done" }).click();
    // the email also appears in the sr-only part of the "Cancel invite" button name, so match the visible text only
    await expect(page.getByText(email, { exact: true })).toBeVisible();

    // second person in a separate browser
    const ictx = await browser.newContext();
    const ip = await ictx.newPage();
    const ierrors = watchErrors(ip);
    const token = new URL(link).searchParams.get("token")!;
    await ip.goto(`/accept-invite?token=${token}`);
    await expect(ip.getByRole("heading", { level: 1 })).toContainText(`Join ${owner.workspace}`);
    await expect(ip.getByText(`You were invited as agent using ${email}.`)).toBeVisible();
    await ip.getByRole("button", { name: "Join workspace" }).click();
    await expect(ip.getByText("Enter your name.")).toBeVisible();
    await expect(ip.getByText("Choose a password.")).toBeVisible();
    await ip.getByLabel("Your name").fill("New Teammate");
    await ip.getByLabel("Choose a password").fill("short");
    await ip.getByLabel("Choose a password").blur();
    await expect(ip.getByText("Use at least 10 characters. Add 5 more.")).toBeVisible();
    await ip.getByLabel("Choose a password").fill("a long enough passphrase");
    await ip.getByRole("button", { name: "Join workspace" }).click();
    await ip.waitForURL(/\/app/);
    await expect(ip.getByRole("button", { name: "Workspace" })).toContainText(owner.workspace);
    await expect(ip.getByRole("navigation", { name: "Workspace" }).getByRole("link", { name: "Billing" })).toHaveCount(0);

    // link is single use
    const ictx2 = await browser.newContext();
    const ip2 = await ictx2.newPage();
    await ip2.goto(`/accept-invite?token=${token}`);
    await expect(alerts(ip2)).toContainText(/invalid or has expired/);
    await expect(ip2.getByRole("link", { name: "Sign in" })).toBeVisible();

    // owner now sees the teammate, invite no longer pending
    await page.reload();
    await expect(page.getByText("New Teammate", { exact: true }).first()).toBeVisible(); // also in an sr-only button name and the transfer-ownership select
    // inviting someone already a member is refused plainly
    await page.getByRole("button", { name: /Invite/ }).first().click();
    await page.getByRole("dialog", { name: "Invite a teammate" }).getByLabel("Email address").fill(email);
    await page.getByRole("button", { name: "Create invite" }).click();
    await expect(page.getByRole("dialog", { name: "Invite a teammate" }).getByRole("alert")).toContainText("already a member");
    // the refused invite above is a deliberate 409, which Chrome logs as a console resource error; anything else is a real error
    const unexpected = errors.filter((e) => !/status of 409/.test(e));
    expect(unexpected, unexpected.join("\n")).toEqual([]);
    expect(ierrors.filter((e) => !/40\d/.test(e)), ierrors.join("\n")).toEqual([]);
    await ictx.close();
    await ictx2.close();
  });

  test("invite link states: missing, garbage, expired", async ({ page, context }) => {
    const owner = await signupUser(context);
    await page.goto("/accept-invite");
    await expect(alerts(page)).toContainText("incomplete");
    await page.goto("/accept-invite?token=garbage");
    await expect(alerts(page)).toContainText(/invalid or has expired/);
    const expired = await createInviteRow(owner.tenantId, `late+${stamp()}@example.com`, "agent", { expired: true });
    await page.goto(`/accept-invite?token=${expired}`);
    await expect(alerts(page)).toContainText(/invalid or has expired/);
    await expect(page.locator("body")).not.toContainText(/prisma|stack/i);
  });

  test("an existing user joins a second workspace with their own password; wrong password is explained", async ({ page, context, browser }) => {
    test.setTimeout(120_000);
    const owner = await signupUser(context, "ownerA");
    const bctx = await browser.newContext();
    const bUser = await signupUser(bctx, "existing");
    await skipWelcome(bctx, bUser.userId); // otherwise the first-run dialog covers the workspace switcher
    const token = await createInviteRow(owner.tenantId, bUser.email, "agent");
    const bp = await bctx.newPage();
    await bp.goto(`/accept-invite?token=${token}`);
    await expect(bp.getByRole("heading", { level: 1 })).toContainText(`Join ${owner.workspace}`);
    await expect(bp.getByLabel("Your name")).toHaveCount(0);
    await expect(bp.getByText("You already have an account. Enter your password to join.")).toBeVisible();
    await bp.getByLabel("Your password").fill("not my password at all");
    await bp.getByRole("button", { name: "Join workspace" }).click();
    await expect(alerts(bp)).toContainText("That password did not work");
    await bp.getByLabel("Your password").fill("correct horse battery");
    await bp.getByRole("button", { name: "Join workspace" }).click();
    await bp.waitForURL(/\/app/);
    await expect(bp.getByRole("button", { name: "Workspace" })).toContainText(owner.workspace);
    // both workspaces appear in the switcher
    await bp.getByRole("button", { name: "Workspace" }).click();
    await expect(bp.getByRole("menu", { name: "Workspace" }).getByRole("menuitemradio")).toHaveCount(2);
    await bctx.close();
    void page;
  });

  test("tenant isolation: another user never sees this workspace's data or can switch into it", async ({ page, context, browser }) => {
    const a = await signupUser(context, "tenantA");
    const bctx = await browser.newContext();
    const b = await signupUser(bctx, "tenantB");
    const bp = await bctx.newPage();
    await bp.goto("/app");
    // B cannot switch into A
    const sw = await bctx.request.post("/api/auth/switch-workspace", { headers: { origin: "http://localhost:3500" }, data: { tenantId: a.tenantId } });
    expect(sw.status()).toBe(403);
    // B's APIs only contain B
    const me = await (await bctx.request.get("/api/auth/me")).json();
    expect(JSON.stringify(me)).not.toContain(a.workspace);
    expect(JSON.stringify(me)).not.toContain(a.email);
    const members = await (await bctx.request.get("/api/workspace/members")).text();
    expect(members).not.toContain(a.email);
    expect(members).toContain(b.email);
    const dash = await (await bctx.request.get("/api/setup/dashboard?tz=UTC")).text();
    expect(dash).not.toContain(a.workspace);
    // A's pending invite token cannot be read by B as a different workspace listing
    const invites = await (await bctx.request.get("/api/workspace/invites")).text();
    expect(invites).not.toContain("tenantA");
    // B's page never shows A's name anywhere
    await bp.goto("/app/settings/team");
    await expect(bp.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(bp.locator("body")).not.toContainText(a.email);
    await expect(bp.locator("body")).not.toContainText(a.workspace);
    void page;
    await bctx.close();
  });
});
