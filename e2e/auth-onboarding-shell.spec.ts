import { expect, test, type Page } from "@playwright/test";
import { closeDb, db, signupUser, stamp, watchErrors, type TestUser } from "./helpers";
import { alerts, axeSerious, joinWorkspace, noHorizontalOverflow, skipWelcome } from "./auth-onboarding-util";

test.afterAll(closeDb);

const SECTIONS = ["Conversations", "Customers", "Campaigns", "Automation", "Insights", "Settings"];

async function ownerPage(page: Page, context: import("@playwright/test").BrowserContext): Promise<TestUser> {
  const u = await signupUser(context);
  await skipWelcome(context, u.userId);
  await page.goto("/app");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  return u;
}

const sidebar = (page: Page) => page.getByRole("navigation", { name: "Workspace" });

test.describe("signed-in shell (desktop)", () => {
  test("shell landmarks, skip link, grouped sidebar and top bar", async ({ page, context }) => {
    const errors = watchErrors(page);
    const u = await ownerPage(page, context);
    // skip link is the first tab stop and moves focus to main
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Skip to main content" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#main-content")).toBeFocused();

    await expect(page.getByRole("main")).toBeVisible();
    await expect(page.getByRole("banner")).toBeVisible();
    await expect(sidebar(page)).toBeVisible();
    for (const s of SECTIONS) await expect(sidebar(page).getByRole("button", { name: s })).toBeVisible();
    await expect(sidebar(page).getByRole("link", { name: "Home" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("button", { name: "Workspace" })).toContainText(u.workspace);
    await expect(page.getByRole("button", { name: "Help" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Switch to (dark|light) theme/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Account" })).toBeVisible();
    // page title follows the template
    await expect(page).toHaveTitle(/Dashboard/);
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("every sidebar link opens a real page with an h1, no 404 and no console errors; active link is marked", async ({ page, context }) => {
    test.setTimeout(240_000);
    const errors = watchErrors(page);
    await ownerPage(page, context);
    const hrefs = await sidebar(page).getByRole("link").evaluateAll((els) => els.map((e) => ({ href: (e as HTMLAnchorElement).getAttribute("href")!, name: (e.textContent ?? "").trim() })));
    expect(hrefs.length).toBeGreaterThanOrEqual(20);
    const problems: string[] = [];
    for (const l of hrefs) {
      if (l.href === "/app") continue;
      await sidebar(page).getByRole("link", { name: l.name, exact: true }).click();
      await page.waitForURL((u) => u.pathname === l.href, { timeout: 20_000 });
      const h1 = page.getByRole("heading", { level: 1 });
      try {
        await expect(h1.first()).toBeVisible({ timeout: 15_000 });
      } catch {
        problems.push(`${l.href}: no visible h1`);
      }
      const body = await page.locator("body").innerText();
      if (/This page could not be found|404|Application error|Unhandled/i.test(body.slice(0, 600))) problems.push(`${l.href}: looks like an error page`);
      const active = await sidebar(page).getByRole("link", { name: l.name, exact: true }).getAttribute("aria-current");
      if (active !== "page") problems.push(`${l.href}: nav link not marked current`);
    }
    expect(problems, problems.join("\n")).toEqual([]);
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("sidebar sections collapse, the choice is remembered, and visiting a collapsed section re-opens it", async ({ page, context }) => {
    await ownerPage(page, context);
    const conv = sidebar(page).getByRole("button", { name: "Conversations" });
    await expect(conv).toHaveAttribute("aria-expanded", "true");
    await expect(sidebar(page).getByRole("link", { name: "Inbox" })).toBeVisible();
    await conv.click();
    await expect(conv).toHaveAttribute("aria-expanded", "false");
    await expect(sidebar(page).getByRole("link", { name: "Inbox" })).toBeHidden();
    await page.reload();
    await expect(sidebar(page).getByRole("button", { name: "Conversations" })).toHaveAttribute("aria-expanded", "false");
    // keyboard toggle
    await sidebar(page).getByRole("button", { name: "Conversations" }).focus();
    await page.keyboard.press("Enter");
    await expect(sidebar(page).getByRole("button", { name: "Conversations" })).toHaveAttribute("aria-expanded", "true");
    // collapse then navigate into it with a shortcut
    await sidebar(page).getByRole("button", { name: "Conversations" }).click();
    await page.goto("/app/inbox");
    await expect(sidebar(page).getByRole("button", { name: "Conversations" })).toHaveAttribute("aria-expanded", "true");
    await expect(sidebar(page).getByRole("link", { name: "Inbox" })).toHaveAttribute("aria-current", "page");
  });

  test("theme toggle switches, persists across reload and navigation, and the app stays readable in dark", async ({ page, context }) => {
    test.setTimeout(420_000);
    await ownerPage(page, context);
    const html = page.locator("html");
    await page.getByRole("button", { name: "Switch to dark theme" }).click();
    await expect(html).toHaveAttribute("data-theme", "dark");
    await expect(page.getByRole("button", { name: "Switch to light theme" })).toBeVisible();
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg).not.toBe("rgb(255, 255, 255)");
    await page.reload();
    await expect(html).toHaveAttribute("data-theme", "dark");
    await page.goto("/app/getting-started");
    await expect(html).toHaveAttribute("data-theme", "dark");
    const found: string[] = [];
    for (const p of ["/app", "/app/getting-started", "/app/contacts", "/app/settings/team"]) {
      await page.goto(p);
      await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
      found.push(...(await axeSerious(page, `dark ${p}`)));
    }
    expect(found, found.join("\n")).toEqual([]);
    await page.getByRole("button", { name: "Switch to light theme" }).click();
    await expect(html).toHaveAttribute("data-theme", "light");
  });

  test("light theme axe on shell pages", async ({ page, context }) => {
    test.setTimeout(420_000);
    await ownerPage(page, context);
    const found: string[] = [];
    for (const p of ["/app", "/app/getting-started", "/app/contacts", "/app/settings/team", "/app/billing"]) {
      await page.goto(p);
      await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
      found.push(...(await axeSerious(page, `light ${p}`)));
    }
    expect(found, found.join("\n")).toEqual([]);
  });

  test("user menu: identity, role, keyboard use, focus return, sign out", async ({ page, context }) => {
    const u = await ownerPage(page, context);
    const btn = page.getByRole("button", { name: "Account" });
    await btn.focus();
    await page.keyboard.press("Enter");
    const menu = page.getByRole("menu", { name: "Account" });
    await expect(menu).toBeVisible();
    await expect(menu).toContainText(u.name);
    await expect(menu).toContainText(u.email);
    await expect(menu).toContainText(/owner/i);
    await expect(menu.getByRole("menuitem", { name: "Your account" })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(menu.getByRole("menuitem", { name: "Team and roles" })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(menu.getByRole("menuitem", { name: "Billing" })).toBeFocused();
    await page.keyboard.press("End");
    await expect(menu.getByRole("menuitem", { name: "Sign out" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(btn).toBeFocused();
    // click outside closes
    await btn.click();
    await expect(menu).toBeVisible();
    await page.getByRole("main").click({ position: { x: 5, y: 300 } });
    await expect(menu).toBeHidden();
    // navigate via menu
    await btn.click();
    await menu.getByRole("menuitem", { name: "Billing" }).click();
    await expect(page).toHaveURL(/\/app\/billing/);
    await btn.click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await page.waitForURL(/\/login/);
  });

  test("help menu offers Getting started, docs, support and shortcuts", async ({ page, context }) => {
    await ownerPage(page, context);
    await page.getByRole("button", { name: "Help" }).click();
    const menu = page.getByRole("menu", { name: "Help" });
    await expect(menu.getByRole("menuitem", { name: /Getting started/ })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: /Help and docs/ })).toHaveAttribute("href", "/docs");
    await expect(menu.getByRole("menuitem", { name: /Email support/ })).toHaveAttribute("href", /^mailto:/);
    await menu.getByRole("menuitem", { name: /Keyboard shortcuts/ }).click();
    await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Help" }).click();
    await page.getByRole("menuitem", { name: /Getting started/ }).click();
    await expect(page).toHaveURL(/getting-started/);
  });

  test("workspace switcher lists every workspace and switches to another", async ({ page, context, browser }) => {
    const u = await ownerPage(page, context);
    const btn = page.getByRole("button", { name: "Workspace" });
    await btn.click();
    await expect(page.getByRole("menu", { name: "Workspace" }).getByRole("menuitemradio")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(btn).toBeFocused();

    // give the same user a second workspace
    const d = await db();
    const id = stamp();
    const t = await d.query(`insert into "Tenant" (id, name, slug) values ($1,$2,$3) returning id`, [`t_${id}`, `Second Shop ${id}`, `second-shop-${id}`]);
    await d.query(`insert into "Membership" (id, "tenantId", "userId", role) values ($1,$2,$3,'agent')`, [`m_${id}`, t.rows[0].id, u.userId]);
    await page.reload();
    await btn.click();
    const menu = page.getByRole("menu", { name: "Workspace" });
    await expect(menu.getByRole("menuitemradio")).toHaveCount(2);
    await expect(menu.getByRole("menuitemradio", { name: new RegExp(u.workspace) })).toHaveAttribute("aria-checked", "true");
    await menu.getByRole("menuitemradio", { name: /Second Shop/ }).click();
    await page.waitForURL(/\/app$/);
    await expect(page.getByRole("button", { name: "Workspace" })).toContainText(`Second Shop ${id}`);
    // role differs per workspace: agent there, so no Billing in the sidebar
    await expect(sidebar(page).getByRole("link", { name: "Billing" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Account" })).toBeVisible();
    // direct billing URL as agent must not show billing data or crash
    await page.goto("/app/billing");
    await expect(page.locator("body")).not.toContainText(/Application error|Unhandled|stack/i);
    void browser;
  });
});

test.describe("command palette, shortcuts help and g-chords", () => {
  const open = async (page: Page) => {
    await page.keyboard.press("Control+k");
    const dlg = page.getByRole("dialog", { name: "Command palette" });
    await expect(dlg).toBeVisible();
    return dlg;
  };

  test("Ctrl+K opens with focus in the search, lists groups, toggles and Escape returns focus", async ({ page, context }) => {
    await ownerPage(page, context);
    await page.getByRole("heading", { level: 1 }).click();
    const dlg = await open(page);
    await expect(dlg.getByRole("combobox", { name: "Search pages and actions" })).toBeFocused();
    await expect(dlg.getByText("Quick actions")).toBeVisible();
    await expect(dlg.getByText("Pages", { exact: true })).toBeVisible();
    for (const label of ["New broadcast", "New template", "Add contact", "New chatbot", "Invite teammate", "Go to inbox", "Toggle theme", "Keyboard shortcuts", "Open help and docs", "Sign out"]) {
      await expect(dlg.getByRole("option", { name: new RegExp(label) }).first(), label).toBeVisible();
    }
    await page.keyboard.press("Escape");
    await expect(dlg).toBeHidden();
    await dlg.waitFor({ state: "detached" });
    // Ctrl+K toggles
    await open(page);
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("dialog", { name: "Command palette" })).toBeHidden();
    // focus returned to something in the app (not lost on body)
    const tag = await page.evaluate(() => document.activeElement?.tagName);
    expect(tag, "focus is lost on <body> after closing the palette").not.toBe("BODY");
  });

  test("palette: search filters, empty state, arrow keys and Enter", async ({ page, context }) => {
    await ownerPage(page, context);
    const dlg = await open(page);
    const input = dlg.getByRole("combobox");
    await input.fill("zzzzqq");
    await expect(dlg.getByText(/Nothing matches/)).toBeVisible();
    await input.fill("bill");
    await expect(dlg.getByRole("option", { name: /Billing/ }).first()).toBeVisible();
    await input.fill("inbox");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowUp");
    await expect(dlg.getByRole("option", { selected: true })).toHaveCount(1);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/app\/inbox/);
    await expect(page.getByRole("dialog", { name: "Command palette" })).toBeHidden();
  });

  test("palette: every quick action works", async ({ page, context }) => {
    test.setTimeout(240_000);
    await ownerPage(page, context);
    const run = async (label: string) => {
      await page.goto("/app");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      const dlg = await open(page);
      await dlg.getByRole("combobox").fill(label);
      await page.keyboard.press("Enter");
    };
    await run("New broadcast");
    await expect(page).toHaveURL(/\/app\/broadcasts\/new/);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    await run("New template");
    await expect(page).toHaveURL(/\/app\/templates\/new/);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    await run("Add contact");
    await expect(page).toHaveURL(/\/app\/contacts\?add=1/);
    await expect(page.getByRole("dialog")).toBeVisible();

    await run("New chatbot");
    await expect(page).toHaveURL(/\/app\/automation\/chatbots\/new/);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    await run("Invite teammate");
    await expect(page).toHaveURL(/\/app\/settings\/team\?invite=1/);
    await expect(page.getByRole("dialog", { name: "Invite a teammate" })).toBeVisible();

    await run("Go to inbox");
    await expect(page).toHaveURL(/\/app\/inbox/);

    // toggle theme
    await page.goto("/app");
    const before = await page.locator("html").getAttribute("data-theme");
    let dlg = await open(page);
    await dlg.getByRole("combobox").fill("Toggle theme");
    await page.keyboard.press("Enter");
    await expect.poll(() => page.locator("html").getAttribute("data-theme")).not.toBe(before);

    // keyboard shortcuts
    dlg = await open(page);
    await dlg.getByRole("combobox").fill("Keyboard shortcuts");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
    await page.keyboard.press("Escape");

    // docs
    await run("Open help and docs");
    await expect(page).toHaveURL(/\/docs/);

    // sign out
    await page.goto("/app");
    dlg = await open(page);
    await dlg.getByRole("combobox").fill("Sign out");
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/login/);
  });

  test("palette with the mouse: click a result, click the backdrop closes", async ({ page, context }) => {
    await ownerPage(page, context);
    await page.locator("aside").getByRole("button", { name: /Search or jump to/ }).click();
    const dlg = page.getByRole("dialog", { name: "Command palette" });
    await expect(dlg).toBeVisible();
    await page.mouse.click(5, 5);
    await expect(dlg).toBeHidden();
    await page.getByRole("button", { name: /Search or jump to/ }).first().click();
    await page.getByRole("option", { name: /Contacts/ }).first().click();
    await expect(page).toHaveURL(/\/app\/contacts/);
  });

  test("? opens the shortcuts dialog with every g-chord, Escape closes and returns focus; ignored while typing", async ({ page, context }) => {
    await ownerPage(page, context);
    await page.getByRole("heading", { level: 1 }).click();
    await page.keyboard.press("?");
    const dlg = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await expect(dlg).toBeVisible();
    for (const k of ["inbox", "contacts", "broadcasts", "automation", "reports", "templates", "home"]) await expect(dlg.getByText(new RegExp(`^${k}$`, "i"))).toBeVisible();
    await expect(dlg.getByRole("button", { name: "Close shortcuts" })).toBeFocused();
    // Tab stays inside the dialog
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    expect(await dlg.evaluate((el) => el.contains(document.activeElement))).toBeTruthy();
    await page.keyboard.press("Escape");
    await expect(dlg).toBeHidden();

    // typing "?" in a field does not open the dialog
    await page.goto("/app/contacts");
    const search = page.getByRole("searchbox").first();
    if (await search.count()) {
      await search.fill("?");
      await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeHidden();
    }
  });

  test("g then a key navigates to every destination; a stale or wrong chord does not", async ({ page, context }) => {
    test.setTimeout(180_000);
    await ownerPage(page, context);
    const map: [string, RegExp][] = [
      ["i", /\/app\/inbox$/],
      ["c", /\/app\/contacts$/],
      ["b", /\/app\/broadcasts$/],
      ["a", /\/app\/automation$/],
      ["r", /\/app\/reports$/],
      ["t", /\/app\/templates$/],
      ["h", /\/app$/],
    ];
    for (const [key, url] of map) {
      if (key !== "i") {
        await page.goto("/app/settings/team");
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      }
      await page.getByRole("heading", { level: 1 }).first().click();
      await page.keyboard.press("g");
      await page.keyboard.press(key);
      await expect(page, `g ${key}`).toHaveURL(url);
    }
    // wrong follow-up key cancels the chord
    await page.goto("/app/settings/team");
    await page.getByRole("heading", { level: 1 }).click();
    await page.keyboard.press("g");
    await page.keyboard.press("z");
    await page.keyboard.press("i");
    await page.waitForTimeout(500);
    expect(page.url()).toMatch(/settings\/team/);
    // stale chord (> 1.5 s)
    await page.keyboard.press("g");
    await page.waitForTimeout(1800);
    await page.keyboard.press("i");
    await page.waitForTimeout(500);
    expect(page.url()).toMatch(/settings\/team/);
    // not while typing in a field
    await page.goto("/app/contacts");
    const field = page.getByRole("searchbox").first();
    if (await field.count()) {
      await field.click();
      await page.keyboard.type("gi");
      expect(page.url()).toMatch(/\/app\/contacts/);
    }
  });

  test("shortcuts pause while a dialog is open", async ({ page, context }) => {
    await ownerPage(page, context);
    await page.goto("/app/settings/team?invite=1");
    await expect(page.getByRole("dialog", { name: "Invite a teammate" })).toBeVisible();
    await page.getByRole("heading", { level: 2, name: "Invite a teammate" }).click();
    await page.keyboard.press("g");
    await page.keyboard.press("i");
    await page.waitForTimeout(400);
    expect(page.url()).toMatch(/settings\/team/);
  });
});

test.describe("agent role in the shell", () => {
  test("an agent sees only agent pages in the sidebar, palette and shortcuts, and cannot open admin pages by URL", async ({ page, context, browser }) => {
    test.setTimeout(180_000);
    const owner = await ownerPage(page, context);
    const { context: actx, user } = await joinWorkspace(browser, owner.tenantId, "agent", "agent");
    const ap = await actx.newPage();
    const errors = watchErrors(ap);
    await ap.goto("/app");
    await expect(ap.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(ap.getByRole("button", { name: "Workspace" })).toContainText(owner.workspace);
    const nav = ap.getByRole("navigation", { name: "Workspace" });
    for (const hidden of ["Broadcasts", "Ad campaigns", "Optimiser", "Team", "Billing", "Chat routing", "Connect WhatsApp", "API and webhooks"]) {
      await expect(nav.getByRole("link", { name: hidden, exact: true }), hidden).toHaveCount(0);
    }
    for (const shown of ["Inbox", "Contacts", "Templates", "Reports"]) await expect(nav.getByRole("link", { name: shown, exact: true })).toBeVisible();
    // user menu
    await ap.getByRole("button", { name: "Account" }).click();
    const menu = ap.getByRole("menu", { name: "Account" });
    await expect(menu).toContainText(/agent/i);
    await expect(menu.getByRole("menuitem", { name: "Billing" })).toHaveCount(0);
    await ap.keyboard.press("Escape");
    // palette hides admin actions
    await ap.getByRole("heading", { level: 1 }).click();
    await ap.keyboard.press("Control+k");
    const dlg = ap.getByRole("dialog", { name: "Command palette" });
    await expect(dlg.getByRole("option", { name: /New broadcast/ })).toHaveCount(0);
    await expect(dlg.getByRole("option", { name: /Invite teammate/ })).toHaveCount(0);
    await expect(dlg.getByRole("option", { name: /New template/ })).toBeVisible();
    await ap.keyboard.press("Escape");
    // g b is not available to agents
    await ap.getByRole("heading", { level: 1 }).click();
    await ap.keyboard.press("g");
    await ap.keyboard.press("b");
    await ap.waitForTimeout(500);
    expect(ap.url()).not.toMatch(/broadcasts/);
    // shortcuts dialog omits broadcasts
    await ap.keyboard.press("?");
    await expect(ap.getByRole("dialog", { name: "Keyboard shortcuts" })).not.toContainText("Broadcasts");
    await ap.keyboard.press("Escape");
    // direct URLs to admin pages
    for (const p of ["/app/billing", "/app/settings/team", "/app/broadcasts", "/app/settings/connect"]) {
      await ap.goto(p);
      const body = await ap.locator("body").innerText();
      expect(body, p).not.toMatch(/Application error|Unhandled|Cannot read|at .*\.tsx?:\d+/);
      await expect(ap.getByRole("heading", { level: 1 }).first(), p).toBeVisible();
    }
    // the same person cannot read the owner's members API as agent
    const res = await actx.request.get("/api/billing");
    expect([401, 403]).toContain(res.status());
    expect(errors.filter((e) => !/40[13]/.test(e)), errors.join("\n")).toEqual([]);
    void user;
    await actx.close();
  });
});

test.describe("mobile shell (390px) @mobile", () => {
  test("bottom tab bar, More drawer, navigation, focus and no horizontal scroll", async ({ page, context }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const errors = watchErrors(page);
    await ownerPage(page, context);
    await noHorizontalOverflow(page, "/app at 390");
    // desktop sidebar is not shown
    await expect(page.getByRole("navigation", { name: "Workspace" })).toBeHidden();
    const tabs = page.getByRole("navigation", { name: "Main" });
    await expect(tabs).toBeVisible();
    for (const t of ["Inbox", "Contacts", "Broadcasts", "Automation", "Reports", "More"]) await expect(tabs.getByRole("link", { name: t }).or(tabs.getByRole("button", { name: t }))).toBeVisible();
    // tab targets are big enough
    const box = await tabs.getByRole("link", { name: "Inbox" }).boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    await tabs.getByRole("link", { name: "Contacts" }).click();
    await expect(page).toHaveURL(/\/app\/contacts/);
    await expect(tabs.getByRole("link", { name: "Contacts" })).toHaveAttribute("aria-current", "page");
    await noHorizontalOverflow(page, "/app/contacts at 390");

    const more = tabs.getByRole("button", { name: "More" });
    await more.click();
    const drawer = page.getByRole("dialog", { name: "Menu" });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole("button", { name: "Close menu" })).toBeFocused();
    for (const s of SECTIONS) await expect(drawer.getByRole("heading", { name: s })).toBeVisible();
    await expect(drawer.getByRole("button", { name: /Switch to (dark|light) theme/ })).toBeVisible();
    await expect(drawer.getByRole("button", { name: "Sign out" })).toBeVisible();
    await expect(drawer.getByRole("link", { name: "Help and docs" })).toBeVisible();
    // Escape closes and returns focus to More
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(more).toBeFocused();
    // navigate from the drawer
    await more.click();
    await drawer.getByRole("link", { name: "Templates" }).click();
    await expect(page).toHaveURL(/\/app\/templates/);
    await expect(drawer).toBeHidden();
    // theme toggle in drawer
    await more.click();
    await drawer.getByRole("button", { name: /Switch to dark theme/ }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await drawer.getByRole("button", { name: "Close menu" }).click();
    await noHorizontalOverflow(page, "dark /app/templates 390");
    // search from the drawer opens the palette
    await more.click();
    await drawer.getByRole("button", { name: /Search or jump to/ }).click();
    await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
    await page.keyboard.press("Escape");
    // top-bar search icon
    await page.getByRole("button", { name: /Search or jump to/ }).first().click();
    await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
    await page.keyboard.press("Escape");
    // sign out from the drawer
    await more.click();
    await drawer.getByRole("button", { name: "Sign out" }).click();
    await page.waitForURL(/\/login/);
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("shell and dashboard at 360px do not scroll sideways; page axe on mobile", async ({ page, context }) => {
    test.setTimeout(420_000);
    await page.setViewportSize({ width: 360, height: 740 });
    await ownerPage(page, context);
    const found: string[] = [];
    for (const p of ["/app", "/app/getting-started", "/app/inbox", "/app/contacts", "/app/templates", "/app/settings/team", "/app/billing", "/app/reports"]) {
      await page.goto(p);
      await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
      await noHorizontalOverflow(page, `${p} at 360`);
    }
    for (const p of ["/app", "/app/getting-started"]) {
      await page.goto(p);
      await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
      found.push(...(await axeSerious(page, `mobile ${p}`)));
    }
    expect(found, found.join("\n")).toEqual([]);
  });

  test("workspace name and user menu usable at 360px", async ({ page, context }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await ownerPage(page, context);
    await page.getByRole("button", { name: "Account" }).click();
    const menu = page.getByRole("menu", { name: "Account" });
    await expect(menu).toBeVisible();
    const box = await menu.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(360);
    await expect(menu.getByRole("menuitem", { name: "Sign out" })).toBeVisible();
  });
});

// ===== Eddy in the shell (docs/EDDY-SPEC.md 6.1, 6.2, 6.13, 9.4, EDDY-14) =====
// The launcher is in the top bar at every width: after the search icon on phones, before Help on desktop. There is no
// floating button and no seventh tab (the tab-bar assertions above stay exactly as they were).

test.describe("Ask Eddy in the shell", () => {
  test("1280 px: Ask Eddy sits before Help, opens the panel beside the page, Esc returns focus; axe and no overflow", async ({ page, context }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const errors = watchErrors(page);
    await ownerPage(page, context);
    const banner = page.getByRole("banner");
    const ask = banner.getByRole("button", { name: /^Ask Eddy/ });
    await expect(ask).toBeVisible();
    await expect(ask).toHaveCount(1);
    const askBox = (await ask.boundingBox())!;
    const helpBox = (await banner.getByRole("button", { name: "Help" }).boundingBox())!;
    expect(askBox.x).toBeLessThan(helpBox.x);
    // DOM order: the skip link is still the first Tab stop, the launcher comes after it.
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Skip to main content" })).toBeFocused();

    await ask.click();
    const panel = page.getByRole("complementary", { name: "Eddy" });
    await expect(panel).toBeVisible();
    await expect(ask).toHaveAttribute("aria-expanded", "true");
    await noHorizontalOverflow(page, "/app at 1280 with Eddy open");
    const found = await axeSerious(page, "Eddy open at 1280");
    expect(found, found.join("\n")).toEqual([]);
    await panel.focus();
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(ask).toBeFocused();
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("the Help menu has Ask Eddy, and the palette lists it", async ({ page, context }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await ownerPage(page, context);
    await page.getByRole("button", { name: "Help" }).click();
    await page.getByRole("menu", { name: "Help" }).getByRole("menuitem", { name: /Ask Eddy/ }).click();
    await expect(page.getByRole("complementary", { name: "Eddy" })).toBeVisible();
    await page.getByRole("button", { name: "Close Eddy" }).click();
    await page.getByRole("heading", { level: 1 }).click();
    await page.keyboard.press("Control+k");
    const dlg = page.getByRole("dialog", { name: "Command palette" });
    await expect(dlg.getByRole("option", { name: /Ask Eddy/ }).first()).toBeVisible();
    await page.keyboard.press("Escape");
  });

  for (const width of [390, 360]) {
    test(`${width} px: Ask Eddy sits after search, opens the bottom sheet; axe, no overflow, 44 px Close @mobile`, async ({ page, context }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 740 });
      await ownerPage(page, context);
      const banner = page.getByRole("banner");
      const ask = banner.getByRole("button", { name: /^Ask Eddy/ });
      await expect(ask).toBeVisible();
      await expect(ask).toHaveCount(1);
      const searchBox = (await banner.getByRole("button", { name: /Search or jump to/ }).boundingBox())!;
      const askBox = (await ask.boundingBox())!;
      expect(askBox.x).toBeGreaterThan(searchBox.x);
      await noHorizontalOverflow(page, `/app at ${width}`);
      // The tab bar is unchanged: still six tabs, no Eddy tab.
      await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: /Eddy/ })).toHaveCount(0);

      await ask.click();
      const sheet = page.getByRole("dialog", { name: "Eddy" });
      await expect(sheet).toBeVisible();
      const close = sheet.getByRole("button", { name: "Close Eddy" });
      const closeBox = (await close.boundingBox())!;
      // Rounded: the sheet's transform can report 43.99999 for a 44 px button.
      expect(Math.round(closeBox.height)).toBeGreaterThanOrEqual(44);
      expect(Math.round(closeBox.width)).toBeGreaterThanOrEqual(44);
      await noHorizontalOverflow(page, `Eddy sheet at ${width}`);
      const found = await axeSerious(page, `Eddy sheet at ${width}`);
      expect(found, found.join("\n")).toEqual([]);
      await close.click();
      await expect(sheet).toBeHidden();
    });
  }

  test("the phone More drawer has an Ask Eddy row @mobile", async ({ page, context }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await ownerPage(page, context);
    await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "More" }).click();
    const drawer = page.getByRole("dialog", { name: "Menu" });
    await drawer.getByRole("button", { name: /Ask Eddy/ }).click();
    await expect(drawer).toBeHidden();
    await expect(page.getByRole("dialog", { name: "Eddy" })).toBeVisible();
  });
});
