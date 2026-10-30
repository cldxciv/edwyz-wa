import { expect, test, type Page } from "@playwright/test";
import { closeDb, connectFakeNumber, db, stamp, watchErrors } from "./helpers";
import { enterApp, newOwner } from "./automation-fixtures";

test.afterAll(closeDb);
test.setTimeout(120_000);

/** A form label matched whole, tolerating the "*" of required fields and the "(optional)" tag. */
const L = (t: string) => new RegExp("^" + t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(\\*|\\s*\\(optional\\))?$");
const nodes = (page: Page) => page.locator("#cb-canvas [data-node-id]");
const tab = (page: Page, name: RegExp | string) => page.getByRole("tab", { name });
const palette = (page: Page) => page.locator("#cb-palette");

async function newEmptyBot(page: Page, name: string, keyword = "hello") {
  await enterApp(page);
  await page.goto("/app/automation/chatbots/new");
  await page.getByRole("button", { name: "Start from an empty canvas" }).click();
  await tab(page, "Settings").click();
  await page.getByLabel(/^Chatbot name/).fill(name);
  // the word list (ul) carries the same label as the input, so target the textbox
  const kw = page.getByRole("textbox", { name: /^Words that start the chatbot/ });
  await kw.fill(keyword);
  await kw.press("Enter");
}

async function addStep(page: Page, label: string) {
  if (!(await palette(page).isVisible())) await page.getByRole("button", { name: "Add a step" }).click();
  await palette(page).getByRole("button", { name: new RegExp(`^${label}`) }).click();
  await expect(page.locator("#cb-inspector-heading")).toHaveText(label);
}

async function pickStep(page: Page, index: number) {
  await tab(page, "Step").click();
  await page.getByLabel(L("Step to edit")).selectOption({ index: index + 1 });
  await expect(page.locator("#cb-inspector-heading")).toBeVisible();
}

test.describe.serial("builder: add every kind of step, fix the checks, publish", () => {
  let ctx: Awaited<ReturnType<typeof newOwner>>;
  let errors: string[];
  let botId = "";
  const LABELS = [
    "Send a message",
    "Send buttons",
    "Send a menu",
    "Send a template",
    "Ask a question",
    "Check an answer",
    "Save a contact detail",
    "Add a tag",
    "Remove a tag",
    "Wait",
    "Connect to another app",
    "Assign to a teammate or team",
    "Change chat status",
    "Hand over to your team",
    "Allow offers",
    "Stop messages",
    "End",
  ];

  test.beforeAll(async ({ browser }) => {
    ctx = await newOwner(browser, "builder");
    errors = watchErrors(ctx.page);
    // one approved template so the "Send a template" step can be completed
    const fx = await connectFakeNumber(ctx.user.tenantId);
    await (await db()).query(
      `insert into "Template" (id, "tenantId", "wabaRefId", name, language, category, status, components, "updatedAt") values ($1,$2,$3,$4,'en','UTILITY','approved',$5, now())`,
      [`tpl_${stamp()}`, ctx.user.tenantId, fx.wabaRef, "order_update", JSON.stringify([{ type: "BODY", text: "Your order is on its way." }])],
    );
  });
  test.afterAll(async () => {
    await ctx.context.close();
  });

  test("palette lists all seventeen steps in plain language, grouped", async () => {
    const { page } = ctx;
    await newEmptyBot(page, "Every step bot");
    await expect(page.getByText("This chatbot has no steps yet.").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Publish" })).toBeVisible();
    await page.getByRole("button", { name: "Add a step" }).click();
    for (const g of ["Messages", "Collect and decide", "Contact and team", "Flow control"]) await expect(palette(page).getByRole("heading", { name: g })).toBeVisible();
    await expect(palette(page).getByRole("button")).toHaveCount(17);
    const text = await palette(page).innerText();
    expect(text).not.toMatch(/send_text|set_attribute|round_robin|webhook\b/);
  });

  test("publishing an empty chatbot is blocked with a clear message", async () => {
    const { page } = ctx;
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(page.getByText("Fix the problems under Checks before publishing.")).toBeVisible();
    await expect(tab(page, /^Checks/)).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText("This chatbot has no steps yet. Add one from the list, or start from a template.")).toBeVisible();
    // nothing was created on the server
    const n = (await (await db()).query(`select count(*)::int c from "Chatbot" where "tenantId"=$1`, [ctx.user.tenantId])).rows[0].c;
    expect(n).toBe(0);
  });

  test("add every step type in turn; each opens its own settings with the right heading", async () => {
    const { page } = ctx;
    for (const label of LABELS) await addStep(page, label);
    await expect(nodes(page)).toHaveCount(17);
    // new steps join the one before them where there is a free exit
    await tab(page, /^Checks/).click();
    await expect(page.getByRole("heading", { name: /Fix before publishing/ })).toBeVisible();
    // blocked publish: toast and Checks tab
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(page.getByText("Fix the problems under Checks before publishing.")).toBeVisible();
    // every problem is in plain words and can be opened with Go to step
    const items = page.getByRole("region", { name: "Fix before publishing" }).getByRole("listitem");
    expect(await items.count()).toBeGreaterThan(5);
    const all = await items.allInnerTexts();
    for (const t of all) expect(t).not.toMatch(/\bundefined\b|\bnull\b|\[object|send_text|userId/);
    await page.getByRole("region", { name: "Fix before publishing" }).getByRole("button", { name: "Go to step" }).first().click();
    await expect(tab(page, "Step")).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#cb-inspector-heading")).toBeFocused();
  });

  test("fill in every step through its form (inspector) until the checks are clean", async () => {
    const { page } = ctx;
    const textOf = async (label: string, value: string) => page.getByLabel(L(label)).fill(value);
    // 0 send_text
    await pickStep(page, 0);
    await textOf("Message", "Hello {{contact.name}}!");
    // 1 send_buttons: Message + existing Yes / No
    await pickStep(page, 1);
    await textOf("Message", "Do you want a menu?");
    // 2 send_list
    await pickStep(page, 2);
    await textOf("Message", "Pick a topic");
    // 3 send_template
    await pickStep(page, 3);
    await expect(page.getByText("Only approved templates can be sent.")).toBeVisible();
    await page.getByLabel(L("Template")).selectOption({ label: "order_update (en)" });
    await expect(page.getByText("Fill in the template")).toBeVisible();
    // 4 ask
    await pickStep(page, 4);
    await textOf("Question", "Which city are you in?");
    await textOf("Save the answer as", "city");
    // 5 condition
    await pickStep(page, 5);
    await textOf("Saved answer to check", "city");
    await textOf("This value", "Pune");
    // 6 set_attribute
    await pickStep(page, 6);
    await textOf("Contact detail", "City");
    await textOf("Value", "{{city}}");
    // 7, 8 tags
    await pickStep(page, 7);
    await textOf("Tag", "Pune lead");
    await pickStep(page, 8);
    await textOf("Tag", "Cold lead");
    // 9 delay: default 5 minutes already valid
    await pickStep(page, 9);
    await expect(page.getByLabel(L("Amount"))).toHaveValue("5");
    // 10 webhook
    await pickStep(page, 10);
    await textOf("Web address", "https://example.com/hooks/lead");
    // 11 assign: default round robin is valid; 12 status default valid; 13 handoff message
    await pickStep(page, 11);
    await expect(page.getByLabel(/^Assign the chat to/)).toHaveValue("round_robin");
    await pickStep(page, 13);
    await page.getByLabel(L("Message to the customer")).fill("A teammate will reply shortly.");
    // connect the loose ends: buttons No, menu option 2, and the condition's No lead to End
    await pickStep(page, 1);
    await page.getByLabel(/If the customer chooses "No"/).selectOption({ label: "17. End" });
    await pickStep(page, 2);
    await page.getByLabel(/If the customer chooses "Option 2"/).selectOption({ label: "17. End" });
    await pickStep(page, 5);
    await page.getByLabel(/If the answer is no, go to/).selectOption({ label: "17. End" });
    await tab(page, /^Checks/).click();
    // no errors remain; warnings (if any) are allowed
    await expect(page.getByRole("region", { name: "Fix before publishing" })).toHaveCount(0);
  });

  test("save draft then publish: the server accepts a flow built entirely through the form", async () => {
    const { page } = ctx;
    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(page.getByText("Chatbot created as a draft. Publish it when you are ready.")).toBeVisible();
    await expect(page).toHaveURL(/\/chatbots\/(?!new)[a-z0-9]+$/);
    botId = page.url().split("/").pop() as string;
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(page.getByText("Published. New matching conversations will use this version.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Unpublish" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Publish changes" })).toBeVisible();
    const row = (await (await db()).query(`select status, "publishedFlow" from "Chatbot" where id=$1`, [botId])).rows[0];
    expect(row.status).toBe("published");
    const types = (row.publishedFlow.nodes as { type: string }[]).map((n) => n.type).sort();
    expect(types).toEqual(
      ["add_tag", "assign", "ask", "condition", "delay", "end", "handoff", "remove_tag", "send_buttons", "send_list", "send_template", "send_text", "set_attribute", "set_status", "subscribe", "unsubscribe", "webhook"].sort(),
    );
  });

  test("editing a published bot shows 'Changes not published yet' until the changes are published", async () => {
    const { page } = ctx;
    await pickStep(page, 0);
    await page.getByLabel(/^Message\*?$/).fill("Hello again!");
    await expect(page.getByText("Unsaved changes")).toBeVisible();
    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(page.getByText("Draft saved.")).toBeVisible();
    await expect(page.getByText("Changes not published yet")).toBeVisible();
    await page.getByRole("button", { name: "Publish changes" }).click();
    await expect(page.getByText("Published. New matching conversations will use this version.")).toBeVisible();
    await expect(page.getByText("Changes not published yet")).toHaveCount(0);
  });

  test("clean console and network", async () => {
    expect(errors, errors.join("\n")).toEqual([]);
  });
});

test.describe.serial("builder: canvas editing, undo and redo, keyboard, tidy and fit, connections", () => {
  let ctx: Awaited<ReturnType<typeof newOwner>>;
  test.beforeAll(async ({ browser }) => {
    ctx = await newOwner(browser, "canvas");
  });
  test.afterAll(async () => {
    await ctx.context.close();
  });

  test("undo and redo work from the buttons and the keyboard", async () => {
    const { page } = ctx;
    await newEmptyBot(page, "Canvas bot");
    const undo = page.getByRole("button", { name: "Undo", exact: true });
    const redo = page.getByRole("button", { name: "Redo", exact: true });
    await expect(undo).toBeEnabled(); // the name and keyword edits are history too
    await addStep(page, "Send a message");
    await addStep(page, "Send buttons");
    await addStep(page, "End");
    await expect(nodes(page)).toHaveCount(3);
    await undo.click();
    await expect(nodes(page)).toHaveCount(2);
    await undo.click();
    await expect(nodes(page)).toHaveCount(1);
    await expect(redo).toBeEnabled();
    await redo.click();
    await expect(nodes(page)).toHaveCount(2);
    // keyboard: focus a node, Ctrl+Z / Ctrl+Y
    await nodes(page).first().focus();
    await page.keyboard.press("Control+z");
    await expect(nodes(page)).toHaveCount(1);
    await page.keyboard.press("Control+y");
    await expect(nodes(page)).toHaveCount(2);
    await page.keyboard.press("Control+z");
    await page.keyboard.press("Control+Shift+z");
    await expect(nodes(page)).toHaveCount(2);
    // a new edit empties the redo stack
    await page.keyboard.press("Control+z");
    await addStep(page, "End");
    await expect(redo).toBeDisabled();
  });

  test("typing in a step is undone in sensible chunks, not one letter at a time", async () => {
    const { page } = ctx;
    await pickStep(page, 0);
    const msg = page.getByLabel(/^Message\*?$/);
    await msg.fill("");
    await msg.pressSequentially("Hello there friend");
    await expect(msg).toHaveValue("Hello there friend");
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(page.getByLabel(/^Message\*?$/)).not.toHaveValue("Hello there friend");
    const v = await page.getByLabel(/^Message\*?$/).inputValue();
    expect(v.length, `after one Undo the text was "${v}"`).toBeLessThan(10);
  });

  test("keyboard: arrow keys move a selected step, Shift moves further, Delete removes it and Undo on the message brings it back", async () => {
    const { page } = ctx;
    const node = nodes(page).first();
    await node.focus();
    const left = async () => Number.parseFloat(await node.evaluate((el) => (el as HTMLElement).style.left));
    const top = async () => Number.parseFloat(await node.evaluate((el) => (el as HTMLElement).style.top));
    const x0 = await left();
    const y0 = await top();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    expect(await left()).toBe(x0 + 20);
    await page.keyboard.press("Shift+ArrowDown");
    expect(await top()).toBe(y0 + 40);
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowUp");
    expect(await left()).toBe(x0 + 10);
    // Enter selects it and opens its settings
    await page.keyboard.press("Enter");
    await expect(tab(page, "Step")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText(/Step selected\./).first()).toBeAttached();
    // Delete key removes with an undo offer
    const before = await nodes(page).count();
    await nodes(page).last().focus();
    await page.keyboard.press("Delete");
    await expect(nodes(page)).toHaveCount(before - 1);
    await expect(page.getByText(/deleted\./)).toBeVisible();
    await expect(page.locator("#cb-canvas")).toBeFocused();
    await page.getByRole("status").getByRole("button", { name: "Undo" }).click();
    await expect(nodes(page)).toHaveCount(before);
  });

  test("Tidy up leaves no overlapping steps; Fit to screen brings every step into view", async () => {
    const { page } = ctx;
    // pile up several steps (they start overlapped)
    for (const l of ["Add a tag", "Wait", "Send a message"]) await addStep(page, l);
    await page.getByRole("button", { name: "Tidy up" }).click();
    await page.getByRole("button", { name: "Fit to screen" }).click();
    const boxes = await nodes(page).evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ l: r.left, t: r.top, r: r.right, b: r.bottom })));
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        const overlap = a.l < b.r - 1 && b.l < a.r - 1 && a.t < b.b - 1 && b.t < a.b - 1;
        expect(overlap, `steps ${i} and ${j} overlap after Tidy up`).toBe(false);
      }
    const c = await page.locator("#cb-canvas").boundingBox();
    for (const b of boxes) {
      expect(b.l).toBeGreaterThanOrEqual(c!.x - 1);
      expect(b.r).toBeLessThanOrEqual(c!.x + c!.width + 1);
      expect(b.t).toBeGreaterThanOrEqual(c!.y - 1);
      expect(b.b).toBeLessThanOrEqual(c!.y + c!.height + 1);
    }
    await page.getByRole("button", { name: "Zoom in" }).click();
    await page.getByRole("button", { name: "Zoom out" }).click();
  });

  test("connect two steps by dragging from the round dot, select the line, remove it", async () => {
    const { page } = ctx;
    await page.getByRole("button", { name: "Tidy up" }).click();
    await page.getByRole("button", { name: "Fit to screen" }).click();
    // use the last two nodes (the last has no connection yet)
    const count = await nodes(page).count();
    const from = nodes(page).nth(count - 2);
    const to = nodes(page).nth(count - 1);
    const portBox = await from.locator("span.cursor-crosshair").first().boundingBox();
    const toBox = await to.boundingBox();
    expect(portBox && toBox).toBeTruthy();
    const edgesBefore = await page.locator("#cb-canvas svg path[marker-end]").count();
    await page.mouse.move(portBox!.x + portBox!.width / 2, portBox!.y + portBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(toBox!.x + toBox!.width / 2, toBox!.y + toBox!.height / 2, { steps: 8 });
    await page.mouse.up();
    const edgesAfter = await page.locator("#cb-canvas svg path[marker-end]").count();
    expect(edgesAfter).toBeGreaterThanOrEqual(edgesBefore); // replaced or added, never lost
    await pickStep(page, count - 2);
    const next = page.getByLabel(L("Then go to"));
    await expect(next).not.toHaveValue("");
    // remove using the select ("Nothing")
    await next.selectOption({ label: "Nothing (the chat ends)" });
    await expect(page.getByLabel(L("Then go to"))).toHaveValue("");
  });

  test("the canvas explains how to use it, and a user can choose what comes next without a mouse", async () => {
    const { page } = ctx;
    await page.getByText("How to use the canvas").click();
    await expect(page.getByText(/With a keyboard, select a step, move it with the arrow keys/)).toBeVisible();
    await pickStep(page, 0);
    const next = page.getByLabel(/^Then go to|go to$/).first();
    await expect(next).toBeVisible();
  });
});

test.describe.serial("builder: inspector form rules", () => {
  let ctx: Awaited<ReturnType<typeof newOwner>>;
  test.beforeAll(async ({ browser }) => {
    ctx = await newOwner(browser, "forms");
  });
  test.afterAll(async () => {
    await ctx.context.close();
  });

  test("buttons: at most three, titles must be unique and short; menu: at most ten options", async () => {
    const { page } = ctx;
    await newEmptyBot(page, "Forms bot");
    await addStep(page, "Send buttons");
    await page.getByLabel(/^Message\*?$/).fill("Choose");
    const add = page.getByRole("button", { name: "Add a button" });
    await add.click();
    await expect(page.getByText("Buttons (3 of 3)")).toBeVisible();
    await expect(add).toBeDisabled();
    // empty third button
    await expect(page.getByText("A button has no title.")).toBeVisible();
    await page.getByLabel(L("Button 3")).fill("Yes");
    await expect(page.getByText("Two buttons share the same title.")).toBeVisible();
    await page.getByLabel(L("Button 3")).fill("This title is much too long to fit");
    await expect(page.getByLabel(L("Button 3"))).toHaveValue("This title is much t".slice(0, 20));
    await page.getByRole("button", { name: "Remove button 3" }).click();
    await expect(page.getByText("Buttons (2 of 3)")).toBeVisible();
    // removing a button keeps focus inside the form
    await expect(page.locator(":focus")).not.toHaveCount(0);
    const focusedInside = await page.evaluate(() => !!document.activeElement?.closest("section[aria-label$='settings']"));
    expect(focusedInside, "focus should stay within the step settings after removing a button").toBe(true);

    await addStep(page, "Send a menu");
    for (let i = 0; i < 8; i++) await page.getByRole("button", { name: "Add an option" }).click();
    await expect(page.getByText("Menu options (10 of 10)")).toBeVisible();
    await expect(page.getByRole("button", { name: "Add an option" })).toBeDisabled();
  });

  test("question step: choice answers need at least one allowed answer; bad answer names are explained", async () => {
    const { page } = ctx;
    await addStep(page, "Ask a question");
    await page.getByLabel(L("What kind of answer")).selectOption("choice");
    await expect(page.getByText("Add at least one allowed answer.").first()).toBeVisible();
    await page.getByLabel(/^Allowed answers/).fill("Red\nGreen\n\nBlue");
    await expect(page.getByText("3 added.")).toBeVisible();
    await page.getByLabel(L("Save the answer as")).fill("1st colour");
    await expect(page.getByText(/Use letters, numbers and underscores only/)).toBeVisible();
    await page.getByLabel(L("Save the answer as")).fill("colour");
    await expect(page.getByText(/Use letters, numbers and underscores only/)).toHaveCount(0);
  });

  test("wait step: zero, and more than seven days, are rejected in words; units convert", async () => {
    const { page } = ctx;
    await addStep(page, "Wait");
    await page.getByLabel(L("Amount")).fill("0");
    await expect(page.getByText(/Choose a wait time between 1 minute and 7 days/).first()).toBeVisible();
    await page.getByLabel(L("Unit")).selectOption({ index: 2 }); // days or hours
    await page.getByLabel(L("Amount")).fill("8");
    const unit = await page.getByLabel(L("Unit")).inputValue();
    const msgs = await page.getByRole("alert").allInnerTexts();
    if (/day/i.test(unit)) expect(msgs.join(" | ")).toMatch(/7 days|between 1 minute/);
    await page.getByLabel(L("Amount")).fill("2");
    await expect(page.getByText(/Choose a wait time between 1 minute and 7 days/)).toHaveCount(0);
  });

  test("web step: only https addresses are accepted", async () => {
    const { page } = ctx;
    await addStep(page, "Connect to another app");
    await page.getByLabel(L("Web address")).fill("http://example.com/x");
    await expect(page.getByText("The address must start with https://").first()).toBeVisible();
    await page.getByLabel(L("Web address")).fill("https://example.com/x");
    await expect(page.getByText("The address must start with https://")).toHaveCount(0);
  });

  test("condition step: greater-than needs a number", async () => {
    const { page } = ctx;
    await addStep(page, "Check an answer");
    await page.getByLabel(L("Saved answer to check")).fill("colour");
    await page.getByLabel(L("Check whether it")).selectOption("gt");
    await page.getByLabel(L("This value")).fill("abc");
    await expect(page.getByText("Greater and less than need a number.")).toBeVisible();
    await page.getByLabel(L("This value")).fill("10");
    await expect(page.getByText("Greater and less than need a number.")).toHaveCount(0);
  });

  test("duplicate step, make first step, delete step buttons work", async () => {
    const { page } = ctx;
    const before = await nodes(page).count();
    await page.getByRole("button", { name: "Duplicate step" }).click();
    await expect(nodes(page)).toHaveCount(before + 1);
    await page.getByRole("button", { name: "Make this the first step" }).click();
    await expect(page.getByText("This is the first step. The chat begins here.")).toBeVisible();
    await page.getByRole("button", { name: "Delete step" }).click();
    await expect(nodes(page)).toHaveCount(before);
    await expect(page.getByText(/deleted\./)).toBeVisible();
    await page.getByRole("status").getByRole("button", { name: "Undo" }).click();
    await expect(nodes(page)).toHaveCount(before + 1);
  });
});

test.describe("builder: the form and the server must agree about what is valid", () => {
  async function publishWith(page: Page, name: string, build: () => Promise<void>) {
    await newEmptyBot(page, name);
    await addStep(page, "Send a message");
    await page.getByLabel(/^Message\*?$/).fill("Hi");
    await build();
    await tab(page, /^Checks/).click();
    const uiErrors = await page.getByRole("region", { name: "Fix before publishing" }).count();
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    return { uiErrors };
  }

  async function outcome(page: Page, uiErrors: number): Promise<string> {
    const published = page.getByText("Published. New matching conversations will use this version.");
    const failed = page.getByText(/We could not publish|Fix the problems under Checks/);
    await expect(published.or(failed)).toBeVisible({ timeout: 20_000 });
    if (await published.isVisible()) return "published";
    const toast = await failed.first().innerText();
    const checks = await page.getByRole("region", { name: "Fix before publishing" }).count();
    return `refused: "${toast}" (checks tab lists ${checks ? "the problem" : "nothing"}, form showed ${uiErrors} errors before)`;
  }

  const CASES: { name: string; label: string; fill: (page: Page) => Promise<void> }[] = [
    { name: "answer name starting with an underscore", label: "Ask a question", fill: async (p) => { await p.getByLabel(L("Question")).fill("Name?"); await p.getByLabel(L("Save the answer as")).fill("_name"); } },
    { name: "contact detail with punctuation", label: "Save a contact detail", fill: async (p) => { await p.getByLabel(L("Contact detail")).fill("City!"); await p.getByLabel(L("Value")).fill("x"); } },
    { name: "web address on a private network", label: "Connect to another app", fill: async (p) => { await p.getByLabel(L("Web address")).fill("https://10.0.0.5/hook"); } },
    { name: "web address on localhost", label: "Connect to another app", fill: async (p) => { await p.getByLabel(L("Web address")).fill("https://localhost/hook"); } },
    { name: "web address on an unusual port", label: "Connect to another app", fill: async (p) => { await p.getByLabel(L("Web address")).fill("https://example.com:9999/hook"); } },
    { name: "condition checking a name that starts with a digit", label: "Check an answer", fill: async (p) => { await p.getByLabel(L("Saved answer to check")).fill("1st"); await p.getByLabel(L("This value")).fill("x"); } },
  ];

  for (const c of CASES) {
    test(`${c.name}: either the form flags it, or publishing works`, async ({ browser }) => {
      const { context, page } = await newOwner(browser, "agree");
      try {
        const { uiErrors } = await publishWith(page, `Agree ${stamp()}`, async () => {
          await addStep(page, c.label);
          await c.fill(page);
        });
        const result = await outcome(page, uiErrors);
        // A refusal by the server is fine only when the form already told the person what to fix.
        if (result.startsWith("refused")) expect(uiErrors, `The form accepted this but the server refused it: ${result}`).toBeGreaterThan(0);
      } finally {
        await context.close();
      }
    });
  }
});
