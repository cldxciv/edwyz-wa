import { expect, test, type Page } from "@playwright/test";
import { closeDb, db, ORIGIN, watchErrors } from "./helpers";
import { axeProblems, enterApp, newMember, newOwner, overflowsX, toggleTheme } from "./automation-fixtures";

test.afterAll(closeDb);

const nodes = (page: Page) => page.locator("#cb-canvas [data-node-id]");
const tab = (page: Page, name: RegExp | string) => page.getByRole("tab", { name });
const list = (page: Page) => page.getByRole("region", { name: "Your chatbots" });

async function openChatbots(page: Page) {
  await enterApp(page);
  await page.getByRole("link", { name: "Chatbots", exact: true }).first().click();
  await expect(page).toHaveURL(/\/app\/automation\/chatbots$/);
  await expect(page.getByRole("heading", { level: 1, name: "Chatbots" })).toBeVisible();
}

test.describe.serial("chatbots: list, templates, preview, save, publish", () => {
  let ctx: Awaited<ReturnType<typeof newOwner>>;
  let errors: string[];
  let welcomeId = "";

  test.beforeAll(async ({ browser }) => {
    ctx = await newOwner(browser, "bots");
    errors = watchErrors(ctx.page);
  });
  test.afterAll(async () => {
    await ctx.context.close();
  });

  test("empty list explains chatbots and offers the three ready-made templates", async () => {
    const { page } = ctx;
    await openChatbots(page);
    await expect(page.getByText("No chatbots yet")).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Start from a template" })).toBeVisible();
    for (const n of ["Welcome and menu", "Collect lead details", "Business hours reply"]) {
      await expect(page.getByRole("link", { name: `Use this template: ${n}` })).toBeVisible();
    }
    await expect(page.getByRole("link", { name: "Rules", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "New chatbot" })).toBeVisible();
  });

  test("template from the list opens the builder with every step and nothing wrong", async () => {
    const { page } = ctx;
    await page.getByRole("link", { name: "Use this template: Welcome and menu" }).click();
    await expect(page).toHaveURL(/\/chatbots\/new\?starter=welcome-menu/);
    await expect(page.getByRole("heading", { level: 1, name: "Welcome and menu" })).toBeVisible();
    await expect(page.getByText('Started from the "Welcome and menu" template')).toBeVisible();
    await expect(nodes(page)).toHaveCount(5);
    // the template is a sample: settings are prefilled in plain words
    await expect(page.getByLabel(/Chatbot name/)).toHaveValue("Welcome and menu");
    await expect(page.getByLabel("When should this chatbot start?")).toHaveValue("first_message");
    await expect(page.getByText(/Unsaved changes/)).toBeVisible();
    await tab(page, /^Checks/).click();
    await expect(page.getByText("No problems found")).toBeVisible();
    // no internal ids or enum values leak into the visible canvas text
    const text = await page.locator("#cb-canvas").innerText();
    expect(text).not.toMatch(/\bb1\b|\bn1\b|first_message|undefined/);
  });

  test("preview: a customer picks a button and the chat ends", async () => {
    const { page } = ctx;
    await tab(page, /^Preview/).click();
    await expect(page.getByText(/Nothing is sent to anyone and nothing is saved/)).toBeVisible();
    await page.getByLabel("What does the customer write first?").fill("Hi");
    await page.getByRole("button", { name: "Start preview" }).click();
    const log = page.getByRole("log", { name: "Preview conversation" });
    await expect(log).toContainText("What can we help you with?");
    const group = page.getByRole("group", { name: "Reply buttons" });
    await expect(group.getByRole("button")).toHaveCount(3);
    await group.getByRole("button", { name: "Opening hours" }).click();
    await expect(log).toContainText("We are open Monday to Saturday");
    await expect(page.getByText(/The chat has ended/)).toBeVisible();
    await page.getByRole("button", { name: "Restart preview" }).click();
    await page.getByRole("button", { name: "Skip to the first step" }).click();
    await page.getByRole("group", { name: "Reply buttons" }).getByRole("button", { name: "Talk to a person" }).click();
    await expect(page.getByText("The bot handed the chat over to your team.")).toBeVisible();
  });

  test("preview: a wrong word gets the fallback, typing an option's title picks it", async () => {
    const { page } = ctx;
    await page.getByRole("button", { name: "Restart preview" }).click();
    await page.getByRole("button", { name: "Skip to the first step" }).click();
    await page.getByLabel("Reply as the customer").fill("banana");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByRole("log", { name: "Preview conversation" })).toContainText(/Please reply with one of the options|What can we help you with/);
    await page.getByLabel("Reply as the customer").fill("opening hours");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByRole("log", { name: "Preview conversation" })).toContainText("We are open Monday to Saturday");
  });

  test("leaving with unsaved changes asks first; keep editing stays; Ctrl+S saves the draft", async () => {
    const { page } = ctx;
    await page.getByRole("link", { name: "Chatbots", exact: true }).first().click();
    const ask = page.getByRole("alertdialog");
    await expect(ask).toContainText("Leave without saving?");
    await ask.getByRole("button", { name: "Keep editing" }).click();
    await expect(page).toHaveURL(/\/chatbots\/new/);
    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(page.getByText("Chatbot created as a draft. Publish it when you are ready.")).toBeVisible();
    await expect(page).toHaveURL(/\/app\/automation\/chatbots\/(?!new)[a-z0-9]+$/);
    welcomeId = page.url().split("/").pop() as string;
    await expect(page.getByText("Unsaved changes")).toHaveCount(0);
    await expect(page.getByText("Draft", { exact: true }).first()).toBeVisible();
    await expect(nodes(page)).toHaveCount(5);
    // Save draft is inactive until something changes
    await expect(page.getByRole("button", { name: "Save draft" })).toBeDisabled();
    // leaving now does not ask
    await page.getByRole("link", { name: "Chatbots", exact: true }).first().click();
    await expect(page).toHaveURL(/\/app\/automation\/chatbots$/);
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
  });

  test("the saved bot is listed as a draft with its start condition in plain words", async () => {
    const { page } = ctx;
    const table = list(page).getByRole("table");
    await expect(table).toContainText("Welcome and menu");
    await expect(table).toContainText("Draft");
    await expect(table).toContainText("When a customer writes for the first time");
    await expect(page.getByRole("link", { name: "Edit Welcome and menu" })).toBeVisible();
  });

  test("templates inside the builder: collect lead and business hours (keyword trigger)", async () => {
    const { page } = ctx;
    await page.getByRole("link", { name: "New chatbot" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Start with a template" })).toBeVisible();
    await page.getByRole("button", { name: "Use this template: Collect lead details" }).click();
    await expect(nodes(page)).toHaveCount(7);
    await expect(page.getByRole("status").filter({ hasText: /template added with 7 steps/ })).toBeAttached();
    await expect(page.getByLabel("Chatbot name")).toHaveValue("Collect lead details");
    await expect(page.getByRole("list", { name: "Words that start the chatbot" })).toContainText("quote");
    await tab(page, /^Checks/).click();
    await expect(page.getByText("No problems found")).toBeVisible();
    // preview: the email question retries on a bad address
    await tab(page, /^Preview/).click();
    await page.getByLabel("What does the customer write first?").fill("I want a quote");
    await page.getByRole("button", { name: "Start preview" }).click();
    const log = page.getByRole("log", { name: "Preview conversation" });
    await expect(log).toContainText("What is your name?");
    await page.getByLabel("Reply as the customer").fill("Asha");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(log).toContainText("Thanks Asha. What is your email address?");
    await page.getByLabel("Reply as the customer").fill("not-an-email");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(log).toContainText("That does not look like an email address");
    await page.getByLabel("Reply as the customer").fill("asha@example.com");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(log).toContainText("what do you need help with");
    await page.getByLabel("Reply as the customer").fill("A website");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByText("The bot handed the chat over to your team.")).toBeVisible();
    await page.getByText("Answers saved so far").click();
    await expect(page.getByText("asha@example.com", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(page.getByText("Chatbot created as a draft. Publish it when you are ready.")).toBeVisible();
    // The toast shows before the builder moves to the new bot's own address; wait for that (as the Ctrl+S test does) so the next step does not click mid-redirect.
    await expect(page).toHaveURL(/\/app\/automation\/chatbots\/(?!new$)[^/?#]+$/);
    await expect(page.getByText("Unsaved changes")).toHaveCount(0);
  });

  test("preview refuses to start when the first message has none of the trigger words, and offers Start anyway", async () => {
    const { page } = ctx;
    await page.getByRole("link", { name: "Chatbots", exact: true }).first().click();
    await page.getByRole("link", { name: "New chatbot" }).click();
    await page.getByRole("button", { name: "Use this template: Business hours reply" }).click();
    await tab(page, /^Preview/).click();
    await page.getByLabel("What does the customer write first?").fill("banana");
    await page.getByRole("button", { name: "Start preview" }).click();
    await expect(page.getByText(/none of your trigger words/)).toBeVisible();
    await page.getByRole("button", { name: "Start anyway" }).click();
    await expect(page.getByRole("log", { name: "Preview conversation" })).toContainText("Our hours are Monday to Saturday");
    await page.getByRole("button", { name: "Save draft" }).click();
    // the toast of the previous test's save can still be on screen, so also wait for the new chatbot's own address
    await expect(page).toHaveURL(/\/app\/automation\/chatbots\/(?!new$)[^/?#]+$/);
    await expect(page.getByText("Chatbot created as a draft. Publish it when you are ready.").last()).toBeVisible();
  });

  test("publish from the list: the bot goes live and unpublish asks before stopping it", async () => {
    const { page } = ctx;
    await page.getByRole("link", { name: "Chatbots", exact: true }).first().click();
    const table = list(page).getByRole("table");
    await expect(table.getByRole("row")).toHaveCount(4); // header + 3 bots
    await page.getByRole("button", { name: "Publish Welcome and menu" }).click();
    await expect(page.getByText('"Welcome and menu" is live. New matching conversations will use it.')).toBeVisible();
    await expect(table.getByRole("row").filter({ hasText: "Welcome and menu" })).toContainText("Published");
    await page.getByRole("button", { name: "Unpublish Welcome and menu" }).click();
    const ask = page.getByRole("dialog");
    await expect(ask).toContainText('Unpublish "Welcome and menu"?');
    await ask.getByRole("button", { name: "Cancel" }).click();
    await expect(table.getByRole("row").filter({ hasText: "Welcome and menu" })).toContainText("Published");
    await page.getByRole("button", { name: "Unpublish Welcome and menu" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Unpublish chatbot" }).click();
    await expect(page.getByText('"Welcome and menu" is unpublished.')).toBeVisible();
    await expect(table.getByRole("row").filter({ hasText: "Welcome and menu" })).toContainText("Draft");
  });

  test("duplicate makes an independent draft copy; delete asks first and keeps focus on the list", async () => {
    const { page } = ctx;
    await page.getByRole("button", { name: "Duplicate Welcome and menu" }).click();
    await expect(page.getByText('A copy of "Welcome and menu" was created as a draft.')).toBeVisible();
    const table = list(page).getByRole("table");
    await expect(table).toContainText("Welcome and menu (copy)");
    await page.getByRole("button", { name: "Delete Welcome and menu (copy)" }).click();
    const ask = page.getByRole("alertdialog");
    await expect(ask).toContainText('Delete "Welcome and menu (copy)"?');
    await ask.getByRole("button", { name: "Cancel" }).click();
    await expect(table).toContainText("Welcome and menu (copy)");
    await page.getByRole("button", { name: "Delete Welcome and menu (copy)" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete chatbot" }).click();
    await expect(page.getByText('"Welcome and menu (copy)" was deleted.')).toBeVisible();
    await expect(table).not.toContainText("(copy)");
    await expect(list(page)).toBeFocused();
  });

  test("clean console and network for the whole journey", async () => {
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("tenant isolation: another workspace cannot open, change, publish or delete this chatbot", async ({ browser }) => {
    const other = await newOwner(browser, "bots-other");
    try {
      await other.page.goto("/app/automation/chatbots");
      await expect(other.page.getByText("No chatbots yet")).toBeVisible();
      await other.page.goto(`/app/automation/chatbots/${welcomeId}`);
      await expect(other.page.getByText("We could not open this chatbot")).toBeVisible();
      await expect(other.page.getByText("Welcome and menu")).toHaveCount(0);
      const h = { origin: ORIGIN };
      for (const [method, url] of [
        ["get", `/api/chatbots/${welcomeId}`],
        ["post", `/api/chatbots/${welcomeId}/publish`],
        ["post", `/api/chatbots/${welcomeId}/duplicate`],
        ["get", `/api/chatbots/${welcomeId}/sessions`],
      ] as const) {
        const r = await other.context.request.fetch(url, { method, headers: h, data: method === "post" ? {} : undefined });
        expect([403, 404], `${method} ${url}`).toContain(r.status());
      }
      const patch = await other.context.request.patch(`/api/chatbots/${welcomeId}`, { headers: h, data: { name: "hijacked" } });
      expect([403, 404]).toContain(patch.status());
      const del = await other.context.request.delete(`/api/chatbots/${welcomeId}`, { headers: h });
      expect([403, 404]).toContain(del.status());
      const row = (await (await db()).query(`select name from "Chatbot" where id=$1`, [welcomeId])).rows[0];
      expect(row.name).toBe("Welcome and menu");
    } finally {
      await other.context.close();
    }
  });

  test("an agent can look at chatbots but not change them", async ({ browser }) => {
    const member = await newMember(browser, ctx.user, "agent");
    try {
      const p = member.page;
      await p.goto("/app/automation/chatbots");
      await expect(p.getByText("You can look at chatbots. Only admins and owners can change them.")).toBeVisible();
      await expect(p.getByRole("link", { name: "New chatbot" })).toHaveCount(0);
      await expect(p.getByRole("button", { name: /^(Publish|Delete|Duplicate|Unpublish) / })).toHaveCount(0);
      await p.getByRole("link", { name: "View Welcome and menu" }).click();
      await expect(p.getByText("You can look at this chatbot. Only admins and owners can change it.")).toBeVisible();
      await expect(p.getByRole("button", { name: "Save draft" })).toHaveCount(0);
      await expect(p.getByRole("button", { name: "Add a step" })).toHaveCount(0);
      const r = await member.context.request.post(`/api/chatbots/${welcomeId}/publish`, { headers: { origin: ORIGIN }, data: {} });
      expect(r.status()).toBe(403);
      const r2 = await member.context.request.post(`/api/chatbots`, { headers: { origin: ORIGIN }, data: { name: "agent bot", triggerType: "manual" } });
      expect(r2.status()).toBe(403);
    } finally {
      await member.context.close();
    }
  });
});

test("preview behaves like the real bot: typing an option's number picks that option", async ({ browser }) => {
  // The live bot accepts "2" for the second option (see the numbered options it sends). The preview must agree, or owners will
  // think their bot is broken when it is not (or the other way round).
  const { context, page } = await newOwner(browser, "bots-num");
  try {
    await page.goto("/app/automation/chatbots/new?starter=welcome-menu");
    await tab(page, /^Preview/).click();
    await page.getByRole("button", { name: "Skip to the first step" }).click();
    await page.getByLabel("Reply as the customer").fill("2");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByRole("log", { name: "Preview conversation" })).toContainText("We are open Monday to Saturday");
  } finally {
    await context.close();
  }
});

test.describe("chatbots: accessibility and responsive", () => {
  test("list and builder: axe, dark theme, 360px", async ({ browser }) => {
    const { context, page } = await newOwner(browser, "bots-a11y");
    try {
      const errors = watchErrors(page);
      await page.goto("/app/automation/chatbots");
      await expect(page.getByRole("heading", { level: 1, name: "Chatbots" })).toBeVisible();
      expect(await axeProblems(page), "list empty state").toEqual([]);
      await page.goto("/app/automation/chatbots/new?starter=welcome-menu");
      await expect(nodes(page)).toHaveCount(5);
      expect(await axeProblems(page), "builder light").toEqual([]);
      await tab(page, /^Preview/).click();
      expect(await axeProblems(page), "builder preview").toEqual([]);
      await toggleTheme(page);
      await expect(page.locator("html")).toHaveAttribute("data-theme", /dark/);
      expect(await axeProblems(page), "builder dark").toEqual([]);
      await page.setViewportSize({ width: 360, height: 740 });
      await page.reload();
      await expect(page.getByRole("heading", { level: 1, name: "Welcome and menu" })).toBeVisible();
      expect(await overflowsX(page), "builder overflows at 360px").toBe(false);
      await page.goto("/app/automation/chatbots");
      expect(await overflowsX(page), "list overflows at 360px").toBe(false);
      expect(errors, errors.join("\n")).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
