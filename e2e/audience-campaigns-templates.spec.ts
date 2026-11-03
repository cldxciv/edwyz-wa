import { expect, test, type Page } from "@playwright/test";
import { closeDb, connectFakeNumber, db, signupUser, watchErrors } from "./helpers";
import { agentContext, axeSerious, goDark, noHorizontalOverflow, openFromNav, seedTemplate } from "./audience-campaigns-util";

test.afterAll(closeDb);
test.beforeEach(() => {
  test.setTimeout(240_000);
});

const nameField = (p: Page) => p.getByRole("textbox", { name: /^Template name/ });
const bodyField = (p: Page) => p.getByRole("textbox", { name: /^Message\b/ });

async function openEditor(page: Page) {
  await openFromNav(page, "Templates", /\/app\/templates/);
  await page.getByRole("link", { name: /New template|Create a template/ }).first().click();
  await page.waitForURL(/\/app\/templates\/new/);
  await expect(page.getByRole("heading", { level: 1, name: "New template" })).toBeVisible();
}

test("templates editor: validation messages, counters, placeholders, preview, buttons", async ({ page, context }) => {
  const errors = watchErrors(page);
  await signupUser(context, "tpl");
  await openEditor(page);
  await expect(page.getByText("Fix 2 things before saving")).toHaveCount(0); // no errors before the first try

  // empty submit shows what to fix, and focus goes to the first problem
  await page.getByRole("button", { name: "Save as draft" }).click();
  await expect(page.getByText("Fix 2 things before saving")).toBeVisible();
  await expect(page.getByText("Enter a name.")).toBeVisible();
  await expect(page.getByText("Write the message your customers will receive.")).toBeVisible();
  await expect(nameField(page)).toBeFocused();

  // name is slugified as you type
  await nameField(page).fill("Order Update! 2");
  await expect(nameField(page)).toHaveValue("order_update_2");

  // counter + placeholder insert
  await expect(page.getByText("0 of 1024 characters used")).toBeVisible();
  await bodyField(page).fill("Hi ");
  await page.getByRole("button", { name: "Insert placeholder {{1}}" }).click();
  await expect(bodyField(page)).toHaveValue(/Hi \{\{1\}\}/);
  await expect(page.getByRole("button", { name: "Insert placeholder {{2}}" })).toBeVisible();
  // sample value required
  await expect(page.getByRole("group", { name: "Sample values" })).toBeVisible();
  await page.getByRole("button", { name: "Save as draft" }).click();
  await expect(page.getByText("Enter a sample value for this placeholder.")).toBeVisible();
  // preview shows the placeholder until a sample is typed
  const preview = page.getByRole("group", { name: "Preview of your message" }).last();
  await expect(preview).toContainText("Hi {{1}}");
  await page.getByLabel(/Sample for \{\{1\}\}/).fill("Asha");
  await expect(preview).toContainText("Hi Asha");

  // wrong placeholder forms
  await bodyField(page).fill("Hello {{name}}");
  await expect(page.getByText(/Number placeholders in order, starting with \{\{1\}\}/)).toBeVisible();
  await bodyField(page).fill("Hello {{2}}");
  await expect(page.getByText(/Number placeholders in order, starting with \{\{1\}\}/)).toBeVisible();
  await bodyField(page).fill("Hello {{1}} and {{2}}");
  await expect(page.getByLabel(/Sample for \{\{2\}\}/)).toBeVisible();
  await bodyField(page).fill("x".repeat(1025));
  await expect(page.getByText("Make the message shorter (1024 characters at most).")).toBeVisible();
  await bodyField(page).fill("Your order is on its way.");

  // header + footer with counts
  await page.getByRole("button", { name: "Add a header" }).click();
  await expect(page.getByRole("textbox", { name: /^Header/ })).toBeFocused();
  await page.getByRole("textbox", { name: /^Header/ }).fill("Order shipped");
  await expect(page.getByText(/13 of 60 characters used/)).toBeVisible();
  await page.getByRole("textbox", { name: /^Header/ }).fill("h".repeat(61));
  await page.getByRole("button", { name: "Save as draft" }).click();
  await expect(page.getByText("Make the header shorter (60 characters at most).")).toBeVisible();
  await page.getByRole("textbox", { name: /^Header/ }).fill("Order shipped");
  await page.getByRole("button", { name: "Add a footer" }).click();
  await page.getByRole("textbox", { name: /^Footer/ }).fill("Reply STOP to opt out {{1}}");
  await page.getByRole("button", { name: "Save as draft" }).click();
  await expect(page.getByText("A footer cannot have placeholders.")).toBeVisible();
  await page.getByRole("textbox", { name: /^Footer/ }).fill("Reply STOP to opt out");
  await expect(preview).toContainText("Order shipped");
  await expect(preview).toContainText("Reply STOP to opt out");

  // buttons
  await expect(page.getByText("0 of 10 added.")).toBeVisible();
  await page.getByRole("button", { name: "Add button" }).click();
  await expect(page.getByRole("textbox", { name: /^Button label/ })).toBeFocused();
  await page.getByRole("button", { name: "Save as draft" }).click();
  await expect(page.getByText("Give this button a label.")).toBeVisible();
  await page.getByRole("textbox", { name: /^Button label/ }).fill("Track order");
  await page.getByLabel("What it does").selectOption("URL");
  await page.getByLabel(/^Website address/).fill("http://insecure.example.com");
  await page.getByRole("button", { name: "Save as draft" }).click();
  await expect(page.getByText("The website address must start with https://")).toBeVisible();
  await page.getByLabel(/^Website address/).fill("https://example.com/orders/{{1}}");
  await page.getByRole("button", { name: "Save as draft" }).click();
  await expect(page.getByText("Enter a sample address for the placeholder.")).toBeVisible();
  await page.getByLabel(/^Sample address/).fill("https://example.com/orders/123");
  await page.getByLabel("What it does").selectOption("PHONE_NUMBER");
  await page.getByLabel(/^Phone number to call/).fill("12345");
  await page.getByRole("button", { name: "Save as draft" }).click();
  await expect(page.getByText(/Enter the phone number with \+ and the country code, like \+91 98765 43210/)).toBeVisible();
  // spaces are fine: the number is sent as +919876543210
  await page.getByLabel(/^Phone number to call/).fill("+91 98765 43210");
  await expect(page.getByText(/Enter the phone number with \+ and the country code/)).toHaveCount(0);
  await expect(preview).toContainText("Track order");
  // max 10 buttons, and Remove keeps focus on a sensible control
  for (let i = 0; i < 9; i++) await page.getByRole("button", { name: "Add button" }).click();
  await expect(page.getByText("10 of 10 added.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Add button" })).toBeDisabled();
  await page.getByRole("button", { name: "Remove button 10" }).click();
  await expect(page.getByRole("button", { name: "Remove button 9" })).toBeFocused();
  for (let i = 9; i >= 1; i--) await page.getByRole("button", { name: `Remove button ${i}` }).click();
  await expect(page.getByRole("button", { name: "Add button" })).toBeFocused();
  await expect(page.getByText("No buttons yet. Buttons are not required.")).toBeVisible();
  expect(errors, errors.join("\n")).toEqual([]);
});

test("templates editor: cancel and leave with unsaved changes ask first", async ({ page, context }) => {
  await signupUser(context, "tpl");
  await openEditor(page);
  // clean form: Cancel leaves without a prompt
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.waitForURL(/\/app\/templates$/);
  await page.getByRole("link", { name: /New template|Create a template/ }).first().click();
  await page.waitForURL(/\/app\/templates\/new/);

  await nameField(page).fill("draft_one");
  await bodyField(page).fill("Something I typed");
  await page.getByRole("button", { name: "Cancel" }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm.getByText("Discard this template?")).toBeVisible();
  await confirm.getByRole("button", { name: "Keep editing" }).click();
  await expect(confirm).toHaveCount(0);
  await expect(bodyField(page)).toHaveValue("Something I typed");
  await expect(page.getByRole("button", { name: "Cancel" })).toBeFocused();

  // sidebar navigation is guarded too
  await page.getByRole("navigation").getByRole("link", { name: "Contacts", exact: true }).first().click();
  await expect(page.getByRole("alertdialog").getByText("Leave without saving?")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/\/app\/templates\/new/);
  await page.getByRole("navigation").getByRole("link", { name: "Contacts", exact: true }).first().click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Leave page" }).click();
  await page.waitForURL(/\/app\/contacts/);
});

test("templates: no connected WhatsApp account explains itself; with one, draft saves and Meta failures are graceful", async ({ page, context }) => {
  const errors = watchErrors(page);
  const u = await signupUser(context, "tpl");
  await openEditor(page);
  await nameField(page).fill("welcome_note");
  await bodyField(page).fill("Welcome to our shop.");
  await page.getByRole("button", { name: "Save as draft" }).click();
  // no WABA yet: plain message, stay on the page, nothing lost
  await expect(page.getByText("We could not save the template")).toBeVisible();
  await expect(page.getByText("Connect a WhatsApp Business account first.")).toBeVisible();
  await expect(page).toHaveURL(/\/app\/templates\/new/);
  await expect(bodyField(page)).toHaveValue("Welcome to our shop.");

  await connectFakeNumber(u.tenantId);
  await page.getByRole("button", { name: "Save as draft" }).click();
  await page.waitForURL(/\/app\/templates$/);
  await expect(page.getByText("Draft saved")).toBeVisible();
  const row = page.getByRole("row", { name: /welcome_note/ });
  await expect(row).toBeVisible();
  await expect(row.getByText("Draft", { exact: true })).toBeVisible();
  await expect(row.getByText("Not sent to Meta yet.")).toBeVisible();
  await expect(row.getByText("Utility")).toBeVisible();
  await expect(row.getByText("English (US)")).toBeVisible();
  await expect(row.getByText("Welcome to our shop.")).toBeVisible();

  // duplicate name+language
  await page.getByRole("link", { name: "New template" }).click();
  await nameField(page).fill("welcome_note");
  await bodyField(page).fill("Another");
  await page.getByRole("button", { name: "Save as draft" }).click();
  await expect(page.getByText("A template with this name and language already exists.")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Discard template" }).click();
  await page.waitForURL(/\/app\/templates$/);

  // send for review without real Meta: clear failure, status unchanged
  await page.getByRole("button", { name: "Send welcome_note for review" }).click();
  await expect(page.getByText("We could not send welcome_note for review")).toBeVisible();
  await expect(page.locator("body")).not.toContainText(/Error:|stack|undefined|\bat \S+\.(ts|js)/);
  await expect(row.getByText("Draft", { exact: true })).toBeVisible();

  // save + send for review from the editor: draft kept, honest message
  await page.getByRole("link", { name: "New template" }).click();
  await nameField(page).fill("promo_note");
  await bodyField(page).fill("Our sale starts today.");
  await page.getByLabel("Type of message").selectOption("MARKETING");
  await page.getByRole("button", { name: "Save and send for review" }).click();
  await page.waitForURL(/\/app\/templates$/);
  await expect(page.getByText("Saved as a draft, but we could not send it for review")).toBeVisible();
  await expect(page.getByRole("row", { name: /promo_note/ }).getByText("Marketing")).toBeVisible();

  // Update from Meta without Meta
  await page.getByRole("button", { name: "Update from Meta" }).click();
  await expect(page.getByText("We could not update your templates from Meta")).toBeVisible();

  // delete a draft with confirmation
  await page.getByRole("button", { name: "Delete promo_note" }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm.getByText("This draft will be removed.")).toBeVisible();
  await confirm.getByRole("button", { name: "Delete template" }).click();
  await expect(page.getByText("Template deleted")).toBeVisible();
  await expect(page.getByRole("row", { name: /promo_note/ })).toHaveCount(0);
  const unexpected = errors.filter((e) => !/40[0-9]|409|50[0-9]/.test(e)); // failing Meta calls are expected here
  expect(unexpected, unexpected.join("\n")).toEqual([]);
});

test("templates list: statuses in plain words, filters, search, empty results", async ({ page, context }) => {
  const errors = watchErrors(page);
  const u = await signupUser(context, "tpl");
  const fx = await connectFakeNumber(u.tenantId);
  await seedTemplate(u.tenantId, fx.wabaRef, { name: "approved_offer", status: "approved", category: "MARKETING", body: "Big diwali offer for you" });
  await seedTemplate(u.tenantId, fx.wabaRef, { name: "pending_alert", status: "pending", category: "UTILITY", body: "Your parcel is on the way" });
  await seedTemplate(u.tenantId, fx.wabaRef, { name: "rejected_promo", status: "rejected", category: "MARKETING", body: "Cheap deals", rejectionReason: "TAG_CONTENT_MISMATCH" });
  await seedTemplate(u.tenantId, fx.wabaRef, { name: "rejected_other", status: "rejected", category: "MARKETING", body: "Odd one", rejectionReason: "SOMETHING_NEW_FROM_META" });
  await seedTemplate(u.tenantId, fx.wabaRef, { name: "paused_one", status: "paused", category: "UTILITY", body: "Paused body" });
  await seedTemplate(u.tenantId, fx.wabaRef, { name: "draft_one", status: "draft", category: "AUTHENTICATION", body: "Your code is 1234", language: "hi" });
  await openFromNav(page, "Templates", /\/app\/templates/);
  await expect(page.getByRole("heading", { level: 1, name: "Templates" })).toBeVisible();
  await expect(page.getByText("6 templates.")).toBeVisible();
  const row = (n: string) => page.getByRole("row", { name: new RegExp(n) });
  await expect(row("approved_offer").getByText("Approved", { exact: true })).toBeVisible();
  await expect(row("approved_offer").getByText("Ready to use in broadcasts.")).toBeVisible();
  await expect(row("pending_alert").getByText("Pending review")).toBeVisible();
  await expect(row("rejected_promo").getByText(/content does not match the category/)).toBeVisible();
  await expect(row("rejected_other").getByText("Meta gave this reason: something new from meta.")).toBeVisible();
  await expect(row("paused_one").getByText(/low quality ratings/)).toBeVisible();
  await expect(row("draft_one").getByText("Authentication")).toBeVisible();
  await expect(row("draft_one").getByText("Hindi")).toBeVisible();
  // raw enums never shown
  await expect(page.locator("main")).not.toContainText(/TAG_CONTENT_MISMATCH|MARKETING|UTILITY|AUTHENTICATION|en_US/);
  // rejected -> "Send again" ; approved has no send button
  await expect(row("rejected_promo").getByRole("button", { name: "Send again rejected_promo for review" })).toBeVisible();
  await expect(row("approved_offer").getByRole("button", { name: /for review/ })).toHaveCount(0);

  // filters
  const show = page.getByLabel("Show");
  await show.selectOption({ label: "Approved" });
  await expect(page.getByText("Showing 1 of 6 templates.")).toBeVisible();
  await show.selectOption({ label: "Waiting for review" });
  await expect(row("pending_alert")).toBeVisible();
  await expect(row("approved_offer")).toHaveCount(0);
  await show.selectOption({ label: "Needs attention" });
  await expect(page.getByText("Showing 3 of 6 templates.")).toBeVisible();
  await show.selectOption({ label: "Drafts" });
  await expect(page.getByText("Showing 1 of 6 templates.")).toBeVisible();
  await show.selectOption({ label: "All templates" });
  // search by name and by message text
  await page.getByRole("searchbox", { name: "Search" }).fill("diwali");
  await expect(row("approved_offer")).toBeVisible();
  await expect(page.getByText("Showing 1 of 6 templates.")).toBeVisible();
  await page.getByRole("searchbox", { name: "Search" }).fill("nothing-like-this");
  await expect(page.getByText('No templates match "nothing-like-this"')).toBeVisible();
  await page.getByRole("button", { name: "Clear search" }).click();
  await expect(page.getByText("6 templates.")).toBeVisible();

  // delete an approved template: Meta is unreachable, the user gets a plain failure and the row stays
  await page.getByRole("button", { name: "Delete approved_offer" }).click();
  await expect(page.getByRole("alertdialog").getByText(/removed from your WhatsApp Business account at Meta/)).toBeVisible();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete template" }).click();
  await expect(page.getByText("We could not delete approved_offer")).toBeVisible();
  await expect(row("approved_offer")).toBeVisible();
  const unexpected = errors.filter((e) => !/40[0-9]|409|50[0-9]/.test(e));
  expect(unexpected, unexpected.join("\n")).toEqual([]);
});

test("templates: agent view is read-only, and other workspaces cannot reach a template", async ({ page, context, browser }) => {
  const u = await signupUser(context, "tpl");
  const fx = await connectFakeNumber(u.tenantId);
  const t = await seedTemplate(u.tenantId, fx.wabaRef, { name: "owner_only_tpl", status: "draft", body: "private body" });
  const a = await agentContext(browser, u.tenantId, "agent");
  try {
    const ap = a.page;
    await ap.goto("/app/templates");
    await expect(ap.getByRole("row", { name: /owner_only_tpl/ })).toBeVisible();
    await expect(ap.getByRole("link", { name: "New template" })).toHaveCount(0);
    await expect(ap.getByRole("button", { name: "Update from Meta" })).toHaveCount(0);
    await expect(ap.getByRole("button", { name: /Delete|Send/ })).toHaveCount(0);
    await ap.goto("/app/templates/new");
    await expect(ap.getByText("Only owners and admins can create templates")).toBeVisible();
    await ap.getByRole("link", { name: "Back to templates" }).click();
    await ap.waitForURL(/\/app\/templates$/);
    const origin = new URL(ap.url()).origin;
    expect((await ap.request.post(`/api/templates/${t.id}/submit`, { headers: { origin } })).status()).toBe(403);
    expect((await ap.request.delete(`/api/templates/${t.id}`, { headers: { origin } })).status()).toBe(403);
  } finally {
    await a.context.close();
  }
  const other = await browser.newContext();
  try {
    await signupUser(other, "tpl");
    const p2 = await other.newPage();
    await p2.goto("/app/templates");
    await expect(p2.getByText("No templates yet")).toBeVisible();
    await expect(p2.getByText("owner_only_tpl")).toHaveCount(0);
    const origin = new URL(p2.url()).origin;
    expect((await p2.request.post(`/api/templates/${t.id}/submit`, { headers: { origin } })).status()).toBe(404);
    expect((await p2.request.delete(`/api/templates/${t.id}`, { headers: { origin } })).status()).toBe(404);
    const still = await (await db()).query(`select 1 from "Template" where id=$1`, [t.id]);
    expect(still.rowCount).toBe(1);
  } finally {
    await other.close();
  }
});

test("templates: open a template, copy an approved one, edit the draft, and Meta's fixed login-code format", async ({ page, context }) => {
  const errors = watchErrors(page);
  const u = await signupUser(context, "tpl");
  const fx = await connectFakeNumber(u.tenantId);
  await seedTemplate(u.tenantId, fx.wabaRef, { name: "order_ready", status: "approved", category: "UTILITY", body: "Hi there, your order is ready." });
  const rejected = await seedTemplate(u.tenantId, fx.wabaRef, { name: "sale_note", status: "rejected", rejectionReason: "PROMOTIONAL", body: "Big sale today." });
  await page.goto("/app/templates");
  // the name opens the template; an approved one is read-only with Make a copy
  await page.getByRole("link", { name: "order_ready", exact: true }).click(); // not "Download order_ready as a file"
  await expect(page.getByRole("heading", { level: 1, name: "order_ready" })).toBeVisible();
  await expect(page.getByText(/Meta approved this wording/)).toBeVisible();
  await expect(page.getByRole("group", { name: "Preview of your message" })).toContainText("Hi there, your order is ready.");
  await page.getByRole("button", { name: "Make a copy" }).click();
  // the copy opens in the editor
  await expect(page.getByRole("heading", { level: 1, name: "Edit template" })).toBeVisible();
  await expect(nameField(page)).toHaveValue("order_ready_copy");
  await expect(bodyField(page)).toHaveValue("Hi there, your order is ready.");
  await bodyField(page).fill("{{1}} your order is ready");
  await page.getByRole("button", { name: "Save as draft" }).click();
  await expect(page.getByText(/does not accept a message that starts or ends with a placeholder/)).toBeVisible();
  await bodyField(page).fill("Hi there, your order is ready to collect.");
  await page.getByRole("button", { name: "Save as draft" }).click();
  await page.waitForURL(/\/app\/templates$/);
  await expect(page.getByText("Changes saved")).toBeVisible();
  await expect(page.getByRole("row", { name: /order_ready_copy/ }).getByText("Hi there, your order is ready to collect.")).toBeVisible();

  // a rejected template opens in the editor with Meta's reason
  await page.getByRole("link", { name: "Edit sale_note" }).click();
  await page.waitForURL(new RegExp(`/app/templates/${rejected.id}$`));
  await expect(page.getByText("Meta did not approve this template")).toBeVisible();
  await expect(page.getByText(/reads like a promotion/)).toBeVisible();

  // Authentication: Meta writes the message, so only its three choices are offered
  await page.getByLabel("Type of message").selectOption("AUTHENTICATION");
  await expect(bodyField(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add a header" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add button" })).toHaveCount(0);
  await expect(page.getByRole("group", { name: "Preview of your message" }).last()).toContainText("is your verification code.");
  await page.getByLabel(/^Code expires after/).fill("120");
  await page.getByRole("button", { name: "Save as draft" }).click();
  await expect(page.getByText(/whole number of minutes from 1 to 90/)).toBeVisible();

  // an unknown template says so, with a way back
  await page.goto("/app/templates/does-not-exist");
  await expect(page.getByRole("heading", { level: 1, name: "Template not found" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to templates" })).toBeVisible();
  const unexpected = errors.filter((e) => !/404/.test(e));
  expect(unexpected, unexpected.join("\n")).toEqual([]);
});

test("templates: load error state is plain and recoverable", async ({ page, context }) => {
  await signupUser(context, "tpl");
  await page.route("**/api/templates", (r) => (r.request().method() === "GET" ? r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "prisma P1001 can't reach database" }) }) : r.continue()));
  await page.goto("/app/templates");
  await expect(page.getByText("We could not load your templates")).toBeVisible();
  await expect(page.locator("main")).not.toContainText(/prisma|P1001/);
  await page.unroute("**/api/templates");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText("No templates yet")).toBeVisible();
});

test("templates: accessibility light and dark, list and editor", async ({ page, context }) => {
  const u = await signupUser(context, "tpl");
  const fx = await connectFakeNumber(u.tenantId);
  await seedTemplate(u.tenantId, fx.wabaRef, { name: "axe_approved", status: "approved" });
  await seedTemplate(u.tenantId, fx.wabaRef, { name: "axe_rejected", status: "rejected", rejectionReason: "SCAM" });
  await seedTemplate(u.tenantId, fx.wabaRef, { name: "axe_paused", status: "paused" });
  const found: string[] = [];
  await page.goto("/app/templates");
  await expect(page.getByRole("row", { name: /axe_approved/ })).toBeVisible();
  found.push(...(await axeSerious(page, "templates list")));
  await page.goto("/app/templates/new");
  await page.getByRole("button", { name: "Add button" }).click();
  await page.getByRole("button", { name: "Save as draft" }).click(); // show error states
  found.push(...(await axeSerious(page, "template editor with errors")));
  await goDark(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  found.push(...(await axeSerious(page, "template editor dark")));
  await page.goto("/app/templates");
  await expect(page.getByRole("row", { name: /axe_rejected/ })).toBeVisible();
  found.push(...(await axeSerious(page, "templates list dark")));
  expect(found, found.join("\n")).toEqual([]);
});

test("templates: 360px layout for list and editor @mobile", async ({ page, context }) => {
  const u = await signupUser(context, "tpl");
  const fx = await connectFakeNumber(u.tenantId);
  await seedTemplate(u.tenantId, fx.wabaRef, { name: "a_really_long_template_name_that_could_overflow_the_screen_width_on_phones", status: "rejected", rejectionReason: "INVALID_FORMAT", body: "A long long message ".repeat(20) });
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto("/app/templates");
  await expect(page.getByRole("heading", { level: 1, name: "Templates" })).toBeVisible();
  await noHorizontalOverflow(page, "templates list");
  await page.goto("/app/templates/new");
  await page.getByRole("button", { name: "Add button" }).click();
  await page.getByLabel("What it does").selectOption("URL");
  await noHorizontalOverflow(page, "template editor");
  // the preview is available on phones inside a disclosure
  await page.getByText("Preview your message").click();
  await bodyField(page).fill("Hello on a phone");
  await expect(page.getByRole("group", { name: "Preview of your message" }).first()).toContainText("Hello on a phone");
});
