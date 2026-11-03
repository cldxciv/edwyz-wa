import { expect, test, type Page, type Request } from "@playwright/test";
import { closeDb, db, ORIGIN, watchErrors } from "./helpers";
import { axeProblems, enterApp, newMember, newOwner, overflowsX, toggleTheme } from "./automation-fixtures";

test.afterAll(closeDb);

const rulesRegion = (page: Page) => page.getByRole("region", { name: "Your rules" });
/** The "Try your rules" result box. */
const testResult = (page: Page) => page.locator('div[aria-live="polite"]').filter({ hasText: /These rules would run|No rule would answer/ });
const ruleName = (page: Page) => page.getByLabel(/^Rule name/);
const messageBox = (page: Page) => page.getByLabel(/^Message\*?$/);
const createRule = (page: Page) => page.getByRole("button", { name: "Create rule" });

async function openAutomation(page: Page) {
  await enterApp(page);
  await page.getByRole("link", { name: "Automation", exact: true }).first().click();
  await expect(page).toHaveURL(/\/app\/automation$/);
  await expect(page.getByRole("heading", { level: 1, name: "Automation" })).toBeVisible();
}

/** Rules are made on their own page now (When, If, Then), not in a dialog. */
async function openNewRule(page: Page) {
  await page.getByRole("link", { name: "New rule" }).first().click();
  await expect(page).toHaveURL(/\/app\/automation\/rules\/new$/);
  await expect(page.getByRole("heading", { level: 1, name: "New rule" })).toBeVisible();
}

test.describe.serial("automation rules (owner)", () => {
  let ctx: Awaited<ReturnType<typeof newOwner>>;
  let errors: string[];

  test.beforeAll(async ({ browser }) => {
    ctx = await newOwner(browser, "rules");
    errors = watchErrors(ctx.page);
  });
  test.afterAll(async () => {
    await ctx.context.close();
  });

  test("empty state explains what rules are and offers ready-made starting points", async () => {
    const { page } = ctx;
    await openAutomation(page);
    await expect(page.getByText("No rules yet")).toBeVisible();
    for (const t of ["Welcome message", "Reply when you are closed", "Answer a common question", "Follow up when nobody replies", "Tag interested customers", "Send sales questions to your team"]) {
      await expect(page.getByRole("heading", { level: 2, name: t })).toBeVisible();
    }
    await expect(page.getByRole("link", { name: "Use this rule" })).toHaveCount(6);
    await expect(page.getByRole("link", { name: "Chatbots" }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "New rule" }).first()).toBeVisible();
    // no raw enum values in plain view
    const body = await page.locator("main, #main-content, #content").first().innerText();
    expect(body).not.toMatch(/\bno_human_reply_minutes\b|\bfirst_message\b|\bmessage_received\b|undefined|\[object/);
  });

  test("new rule: validation errors in words, then create a rule that answers every message", async () => {
    const { page } = ctx;
    await openNewRule(page);
    await expect(page.getByRole("heading", { level: 2, name: "When" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "If" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Then" })).toBeVisible();
    await createRule(page).click();
    await expect(page.getByText(/Give the rule a name/)).toBeVisible();
    await expect(page.getByText("Write the message to send.")).toBeVisible();
    await ruleName(page).fill("Hello greeting");
    await messageBox(page).fill("Hi there, welcome to our shop!");
    await expect(page.getByText("In plain words")).toBeVisible();
    await expect(page.getByText(/When a customer sends a message, send a text reply\./)).toBeVisible();
    await createRule(page).click();
    await expect(page.getByText('"Hello greeting" was created.')).toBeVisible();
    await expect(page).toHaveURL(/\/app\/automation$/);
    await expect(rulesRegion(page).getByRole("table")).toContainText("Hello greeting");
    await expect(rulesRegion(page).getByRole("table")).toContainText("When a customer sends a message, send a text reply.");
  });

  test("Cancel asks before throwing a filled-in rule away and saves nothing; the form opens by keyboard", async () => {
    const { page } = ctx;
    const opener = page.getByRole("link", { name: "New rule" }).first();
    await opener.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/app\/automation\/rules\/new$/);
    await ruleName(page).fill("Never saved");
    await page.getByRole("link", { name: "Cancel" }).click();
    const ask = page.getByRole("alertdialog");
    await expect(ask).toContainText("Leave without saving?");
    await ask.getByRole("button", { name: "Keep editing" }).click();
    await expect(page).toHaveURL(/\/app\/automation\/rules\/new$/);
    await expect(ruleName(page)).toHaveValue("Never saved");
    await page.getByRole("link", { name: "All rules" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Leave without saving" }).click();
    await expect(page).toHaveURL(/\/app\/automation$/);
    await expect(rulesRegion(page).getByRole("table")).not.toContainText("Never saved");
    // an untouched form has nothing to lose, so Cancel just goes back
    await openNewRule(page);
    await page.getByRole("link", { name: "Cancel" }).click();
    await expect(page).toHaveURL(/\/app\/automation$/);
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
  });

  test("Create material in the new-material dialog checks and saves only the material, never the rule behind it", async () => {
    const { page } = ctx;
    // every rule write the page makes (create, change, delete); the material's own save goes to /api/automation/materials
    const ruleWrites: string[] = [];
    const watch = (r: Request) => {
      const { pathname } = new URL(r.url());
      if (r.method() !== "GET" && (pathname === "/api/automation" || /^\/api\/automation\/(?!materials(\/|$))[^/]+$/.test(pathname))) ruleWrites.push(`${r.method()} ${pathname}`);
    };
    page.on("request", watch);
    try {
      await page.goto("/app/automation/rules/new");
      await expect(page.getByRole("heading", { level: 1, name: "New rule" })).toBeVisible();
      // a rule that would be valid as soon as a material is chosen
      await ruleName(page).fill("Material rule");
      await page.getByLabel("Step 1", { exact: true }).selectOption("send_material");
      await page.getByRole("button", { name: "Add a new reply material" }).click();
      const dialog = page.getByRole("dialog", { name: "New reply material" });
      await dialog.getByRole("button", { name: "Create material" }).click();
      // only the dialog checks its fields: the rule form behind it shows no problems
      await expect(dialog.getByText(/Give the material a name/)).toBeVisible();
      await expect(dialog.getByText("Write the message customers will receive.")).toBeVisible();
      await expect(page.locator("#main-content [role=alert]")).toHaveCount(0);
      await expect(page.locator('#main-content [aria-invalid="true"]')).toHaveCount(0);
      // saving the material picks it in the step and leaves the rule unsaved
      await dialog.getByLabel(/^Name/).fill("Opening hours");
      await dialog.getByLabel(/^Message/).fill("We are open 9 to 5, Monday to Saturday.");
      await dialog.getByRole("button", { name: "Create material" }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page).toHaveURL(/\/app\/automation\/rules\/new$/);
      const material = page.getByLabel(/^Reply material/);
      await expect(material).not.toHaveValue("");
      await expect(page.locator("#main-content [role=alert]")).toHaveCount(0);
      expect(ruleWrites).toEqual([]);
      // the rule is now complete: another new material (this time sent with Enter in its name) must still not save the rule
      const first = await material.inputValue();
      await page.getByRole("button", { name: "Add a new reply material" }).click();
      await dialog.getByLabel(/^Message/).fill("Our price list is on the way.");
      await dialog.getByLabel(/^Name/).fill("Price list");
      await dialog.getByLabel(/^Name/).press("Enter");
      await expect(dialog).toHaveCount(0);
      await expect(material).not.toHaveValue(first);
      await expect(page).toHaveURL(/\/app\/automation\/rules\/new$/);
      await expect(page.getByRole("heading", { level: 1, name: "New rule" })).toBeVisible();
      expect(ruleWrites).toEqual([]);
      const saved = (await (await db()).query(`select count(*)::int c from "AutomationRule" where "tenantId"=$1 and name='Material rule'`, [ctx.user.tenantId])).rows[0].c;
      expect(saved).toBe(0);
      await page.getByRole("link", { name: "Cancel" }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: "Leave without saving" }).click();
      await expect(page).toHaveURL(/\/app\/automation$/);
      expect(ruleWrites).toEqual([]);
    } finally {
      page.off("request", watch);
    }
  });

  test("keyword rule: needs a keyword, accepts words with Enter and comma, can remove a word", async () => {
    const { page } = ctx;
    await openNewRule(page);
    await ruleName(page).fill("Price question");
    await page.getByRole("button", { name: "Add a condition" }).click();
    await messageBox(page).fill("Our prices start at 10 dollars.");
    await createRule(page).click();
    await expect(page.getByText(/Add between 1 and \d+ keywords/)).toBeVisible();
    const kw = page.getByLabel("Add a word or phrase");
    await kw.fill("price");
    await kw.press("Enter");
    await kw.fill("cost, rate");
    await kw.press("Enter");
    await kw.fill("PRICE"); // duplicate, different case
    await kw.press("Enter");
    await expect(page.getByRole("button", { name: "Remove the word price" })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Remove the word cost" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Remove the word rate" })).toBeVisible();
    await page.getByRole("button", { name: "Remove the word rate" }).click();
    await expect(page.getByRole("button", { name: "Remove the word rate" })).toHaveCount(0);
    await createRule(page).click();
    await expect(page.getByText('"Price question" was created.')).toBeVisible();
    await expect(rulesRegion(page).getByRole("table")).toContainText('the message contains "price" or "cost"');
  });

  test("closed-hours rule from a recommended starter: choosing no open day is refused with a clear message", async () => {
    const { page } = ctx;
    await page.getByText("Recommended rules").click();
    await page.getByRole("link", { name: "Use this rule" }).nth(1).click(); // "Reply when you are closed"
    await expect(page).toHaveURL(/starter=after-hours/);
    await expect(ruleName(page)).toHaveValue("Closed for now");
    await ruleName(page).fill("Closed at night");
    const days = page.getByRole("group", { name: "Days" });
    for (const day of ["Mon", "Tue", "Wed", "Thu", "Fri"]) await days.getByRole("checkbox", { name: day }).uncheck();
    await createRule(page).click();
    await expect(page.getByText("Choose at least one day for the time window.")).toBeVisible();
    await days.getByRole("checkbox", { name: "Sat" }).check();
    await page.getByLabel("From").fill("22:00");
    await page.getByLabel("To", { exact: true }).fill("06:00");
    await createRule(page).click();
    await expect(page.getByText('"Closed at night" was created.')).toBeVisible();
    await expect(rulesRegion(page).getByRole("table")).toContainText("22:00 to 06:00");
  });

  test("try-it box shows which rules would answer a sample message, in order", async () => {
    const { page } = ctx;
    await page.getByLabel("Sample message").fill("Hello, what is the price of this?");
    await page.getByRole("button", { name: "Test message" }).click();
    await expect(testResult(page)).toContainText("These rules would run, in this order:");
    await expect(testResult(page).getByRole("listitem").filter({ hasText: "Price question" })).toContainText("send a text reply");
    await expect(testResult(page).getByRole("listitem").filter({ hasText: "Hello greeting" })).toBeVisible();
    await page.getByLabel("Sample message").fill("good morning");
    await page.getByLabel(/first message/i).check();
    await page.getByRole("button", { name: "Test message" }).click();
    await expect(testResult(page).getByRole("listitem").filter({ hasText: "Hello greeting" })).toBeVisible();
    await expect(testResult(page).getByRole("listitem").filter({ hasText: "Price question" })).toHaveCount(0);
  });

  test("edit a rule, then switch it off and confirm the test no longer matches it", async () => {
    const { page } = ctx;
    await page.getByRole("link", { name: "Edit Price question" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Edit rule" })).toBeVisible();
    await expect(ruleName(page)).toHaveValue("Price question");
    await ruleName(page).fill("Pricing question");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText('"Pricing question" was updated.')).toBeVisible();
    await expect(page).toHaveURL(/\/app\/automation$/);
    await expect(rulesRegion(page).getByRole("table")).toContainText("Pricing question");

    const sw = page.getByRole("switch", { name: "Pricing question" });
    await expect(sw).toHaveAttribute("aria-checked", "true");
    await sw.click();
    await expect(page.getByText(/"Pricing question" is off/)).toBeVisible();
    await expect(sw).toHaveAttribute("aria-checked", "false");
    await page.getByLabel("Sample message").fill("price please");
    await page.getByLabel(/first message/i).uncheck();
    await page.getByRole("button", { name: "Test message" }).click();
    // other rules may still answer; the point is that the switched-off keyword rule does not
    await expect(testResult(page)).toBeVisible();
    await expect(testResult(page)).not.toContainText("Pricing question");
    await sw.click();
    await expect(sw).toHaveAttribute("aria-checked", "true");
    // persisted
    await page.reload();
    await expect(page.getByRole("switch", { name: "Pricing question" })).toHaveAttribute("aria-checked", "true");
  });

  test("a whitespace-only name is rejected, and Cancel keeps the rule as it was", async () => {
    const { page } = ctx;
    await page.getByRole("link", { name: "Edit Hello greeting" }).click();
    await ruleName(page).fill("   ");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText(/Give the rule a name/)).toBeVisible();
    await expect(ruleName(page)).toHaveAttribute("aria-invalid", "true");
    await page.getByRole("link", { name: "Cancel" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Leave without saving" }).click();
    await expect(page).toHaveURL(/\/app\/automation$/);
    await expect(rulesRegion(page).getByRole("table")).toContainText("Hello greeting");
  });

  test("delete asks first, cancel keeps it, confirm removes it and keeps keyboard focus on the list", async () => {
    const { page } = ctx;
    await page.getByRole("button", { name: "Delete Closed at night" }).click();
    const confirmBox = page.getByRole("alertdialog");
    await expect(confirmBox).toContainText('Delete "Closed at night"?');
    await confirmBox.getByRole("button", { name: "Cancel" }).click();
    await expect(rulesRegion(page).getByRole("table")).toContainText("Closed at night");
    await page.getByRole("button", { name: "Delete Closed at night" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete rule" }).click();
    await expect(page.getByText('"Closed at night" was deleted.')).toBeVisible();
    await expect(rulesRegion(page).getByRole("table")).not.toContainText("Closed at night");
    await expect(rulesRegion(page)).toBeFocused();
  });

  test("rule data is saved correctly in the database (new format, cooldown default, keywords lower-cased and unique)", async () => {
    const d = await db();
    const rows = (await d.query(`select name, version, trigger, filters, actions, "cooldownMinutes", enabled from "AutomationRule" where "tenantId"=$1 order by "createdAt"`, [ctx.user.tenantId])).rows;
    expect(rows.map((r) => r.name)).toEqual(["Hello greeting", "Pricing question"]);
    expect(rows.every((r) => r.version === 2)).toBe(true);
    expect(rows[0].trigger).toMatchObject({ type: "message_received" });
    expect(rows[0].cooldownMinutes).toBe(5);
    expect(rows[1].filters.root.items[0]).toMatchObject({ type: "keyword", mode: "contains", keywords: ["price", "cost"] });
    expect(rows[1].actions[0]).toMatchObject({ type: "send_text", text: "Our prices start at 10 dollars." });
  });

  test("exact match mode only answers a message that is exactly the word", async () => {
    const { page } = ctx;
    await openNewRule(page);
    await ruleName(page).fill("Menu word");
    await page.getByRole("button", { name: "Add a condition" }).click();
    await page.getByLabel("The message").selectOption("exact");
    await page.getByLabel("Add a word or phrase").fill("menu");
    await page.getByLabel("Add a word or phrase").press("Enter");
    await messageBox(page).fill("Here is the menu.");
    await createRule(page).click();
    await expect(page.getByText('"Menu word" was created.')).toBeVisible();
    await page.getByLabel("Sample message").fill("menu");
    await page.getByRole("button", { name: "Test message" }).click();
    await expect(testResult(page).getByRole("listitem").filter({ hasText: "Menu word" })).toBeVisible();
    await page.getByLabel("Sample message").fill("show me the menu please");
    await page.getByRole("button", { name: "Test message" }).click();
    await expect(testResult(page)).toBeVisible();
    await expect(testResult(page)).not.toContainText("Menu word");
  });

  test("no console errors or failed requests during the whole journey", async () => {
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("tenant isolation: another workspace sees nothing and cannot change these rules", async ({ browser }) => {
    const other = await newOwner(browser, "rules-other");
    try {
      await other.page.goto("/app/automation");
      await expect(other.page.getByText("No rules yet")).toBeVisible();
      const d = await db();
      const id = (await d.query(`select id from "AutomationRule" where "tenantId"=$1 limit 1`, [ctx.user.tenantId])).rows[0].id as string;
      const patch = await other.context.request.patch(`/api/automation/${id}`, { headers: { origin: ORIGIN }, data: { enabled: false } });
      expect([403, 404]).toContain(patch.status());
      const del = await other.context.request.delete(`/api/automation/${id}`, { headers: { origin: ORIGIN } });
      expect([403, 404]).toContain(del.status());
      const still = (await d.query(`select count(*)::int as c from "AutomationRule" where id=$1`, [id])).rows[0].c;
      expect(still).toBe(1);
      const list = await other.context.request.get("/api/automation");
      expect(JSON.stringify(await list.json())).not.toContain("Hello greeting");
      // the edit page of another workspace's rule does not show it either
      await other.page.goto(`/app/automation/rules/${id}`);
      await expect(other.page.getByText("This rule no longer exists")).toBeVisible();
      await expect(other.page.getByText("Hello greeting")).toHaveCount(0);
      await expect(other.page.locator("input[value='Hello greeting']")).toHaveCount(0);
      // a rule that does not exist says so and leads back, instead of blaming the connection
      await other.page.goto("/app/automation/rules/qa-nonexistent-id");
      await expect(other.page.getByText("This rule no longer exists")).toBeVisible();
      await expect(other.page.getByText(/Check your connection/)).toHaveCount(0);
      await other.page.getByRole("link", { name: "Back to rules" }).click();
      await expect(other.page).toHaveURL(/\/app\/automation$/);
    } finally {
      await other.context.close();
    }
  });

  test("an agent can look but not change", async ({ browser }) => {
    const member = await newMember(browser, ctx.user, "agent");
    try {
      const p = member.page;
      await p.goto("/app/automation");
      await expect(p.getByText(/Only admins and owners can change them/)).toBeVisible();
      await expect(p.getByRole("link", { name: "New rule" })).toHaveCount(0);
      await expect(rulesRegion(p).getByRole("table")).toContainText("Hello greeting");
      await expect(rulesRegion(p).getByRole("switch")).toHaveCount(0);
      await expect(p.getByRole("link", { name: /^Edit / })).toHaveCount(0);
      await expect(p.getByRole("button", { name: /^Delete / })).toHaveCount(0);
      // direct API write is refused
      const id = (await (await db()).query(`select id from "AutomationRule" where "tenantId"=$1 limit 1`, [ctx.user.tenantId])).rows[0].id as string;
      const res = await member.context.request.patch(`/api/automation/${id}`, { headers: { origin: ORIGIN }, data: { enabled: false } });
      expect(res.status()).toBe(403);
    } finally {
      await member.context.close();
    }
  });
});

test.describe("automation rules: accessibility and responsive", () => {
  test("top bar: workspace and account buttons have an accessible name that contains their visible text", async ({ browser }) => {
    const { context, page } = await newOwner(browser, "shell-a11y");
    try {
      await page.goto("/app/automation");
      await expect(page.getByRole("heading", { level: 1, name: "Automation" })).toBeVisible();
      expect(await axeProblems(page, "header", true)).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test("axe, dark theme and 360px layout", async ({ browser }) => {
    const { context, page } = await newOwner(browser, "rules-a11y");
    try {
      const errors = watchErrors(page);
      await page.goto("/app/automation");
      await expect(page.getByRole("heading", { level: 1, name: "Automation" })).toBeVisible();
      expect(await axeProblems(page), "empty state").toEqual([]);
      await page.getByRole("link", { name: "New rule" }).first().click();
      await expect(page.getByRole("heading", { level: 1, name: "New rule" })).toBeVisible();
      await page.getByRole("button", { name: "Add a condition" }).click();
      expect(await axeProblems(page), "new rule form").toEqual([]);
      await toggleTheme(page);
      await expect(page.locator("html")).toHaveAttribute("data-theme", /dark/);
      expect(await axeProblems(page), "dark theme").toEqual([]);
      await page.setViewportSize({ width: 360, height: 740 });
      await page.reload();
      await expect(page.getByRole("heading", { level: 1, name: "New rule" })).toBeVisible();
      expect(await overflowsX(page), "new rule form at 360px").toBe(false);
      await page.goto("/app/automation");
      await expect(page.getByRole("heading", { level: 1, name: "Automation" })).toBeVisible();
      expect(await overflowsX(page), "list at 360px").toBe(false);
      expect(errors, errors.join("\n")).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
