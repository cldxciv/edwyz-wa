import { expect, test, type Page } from "@playwright/test";
import { closeDb, db, deliverInbound, tick, watchErrors } from "./helpers";
import { conversationIdFor, convoButton, deliverRaw, openChat, openInbox, phoneFor, seedChat, setupOwner, sharedSession, type Fixture } from "./inbox-util";

test.afterAll(closeDb);
test.setTimeout(120_000);

const session = sharedSession();
session.hook(test);

let f: Fixture;
const P = { priya: phoneFor(1), rahul: phoneFor(2), anita: phoneFor(3), old: phoneFor(4) };
const ids: Record<string, string> = {};

const composer = (page: Page) => page.getByRole("textbox", { name: "Message" });
const log = (page: Page) => page.getByRole("log", { name: "Messages" });

test("empty inbox shows a helpful empty state and a way forward", async ({ page, context }) => {
  const errors = watchErrors(page);
  f = await setupOwner(context);
  await openInbox(page, { viaLink: true });
  await expect(page.getByText("No conversations yet")).toBeVisible();
  await expect(page.getByRole("link", { name: "Connect a number" })).toBeVisible();
  await expect(page.getByText("Pick a conversation")).toBeVisible();
  await expect(page.getByRole("navigation").first()).toBeVisible();
  await expect(page.locator("main").first()).toBeVisible();
  expect(errors, errors.join("\n")).toEqual([]);
});

test("a signed inbound message shows up live without reloading, and opening the chat marks it read", async ({ page, request }) => {
  const errors = watchErrors(page);
  await openInbox(page);
  await expect(page.getByText("Live", { exact: true })).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(4000); // let the live stream settle so this checks the normal case
  await deliverInbound(request, f.fx, P.priya, "Hello, do you deliver on Sundays?", "Priya Sharma");
  await tick(request, 3);
  const item = convoButton(page, "Priya Sharma");
  await expect(item).toBeVisible({ timeout: 20_000 });
  await expect(item).toContainText("Hello, do you deliver on Sundays?");
  await expect(item.getByLabel("1 unread")).toBeVisible();
  await expect(page).toHaveTitle(/^\(1\) /);
  await expect(item.getByText("Open", { exact: true })).toBeVisible();
  await openChat(page, "Priya Sharma");
  await expect(log(page)).toContainText("Hello, do you deliver on Sundays?");
  expect(errors, errors.join("\n")).toEqual([]);
});

test("a customer message whose WhatsApp timestamp is a few seconds old still appears live", async ({ page, request }) => {
  // WhatsApp stamps a message with when the customer sent it; the worker may process it seconds later.
  await openInbox(page);
  await expect(page.getByText("Live", { exact: true })).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(3000);
  await deliverRaw(request, f, P.rahul, { type: "text", text: { body: "Sent a few seconds ago" } }, "Rahul Verma", 20_000);
  await tick(request, 3);
  // The 30 second safety refresh would eventually show it; a live stream should show it within a few seconds.
  await expect(convoButton(page, "Rahul Verma")).toBeVisible({ timeout: 12_000 });
});

test("seed the remaining conversations", async ({ request }) => {
  await tick(request, 3);
  ids.priya = await conversationIdFor(request, f, P.priya);
  // Rahul is normally created by the stale-timestamp test above; make sure he exists even when that test is skipped or failed.
  const have = await (await db()).query(`select 1 from "Conversation" c join "Contact" k on k.id = c."contactId" where c."tenantId" = $1 and k.phone = $2`, [f.user.tenantId, `+${P.rahul}`]);
  ids.rahul = have.rows.length ? await conversationIdFor(request, f, P.rahul) : await seedChat(request, f, P.rahul, "Sent a few seconds ago", "Rahul Verma", 20_000);
  ids.anita = await seedChat(request, f, P.anita, "Is the blue kurta in stock?", "Anita Desai");
  ids.old = await seedChat(request, f, P.old, "Old question from last week", "Zed Oldman", 30 * 3600_000);
});

test("opening a chat clears its unread badge in the list and the tab title within a few seconds", async ({ page }) => {
  await openInbox(page);
  const item = convoButton(page, "Anita Desai");
  await expect(item.getByLabel("1 unread")).toBeVisible({ timeout: 20_000 });
  await openChat(page, "Anita Desai");
  await expect(item.getByLabel(/unread/)).toHaveCount(0, { timeout: 8_000 });
});

test("conversation list: avatars, previews, status pills including Expired, search, filters", async ({ page }) => {
  const errors = watchErrors(page);
  await openInbox(page);
  for (const n of ["Priya Sharma", "Rahul Verma", "Anita Desai", "Zed Oldman"]) await expect(convoButton(page, n)).toBeVisible({ timeout: 20_000 });
  // plain language: no raw enum values, ids or JSON anywhere in the list
  const listText = await page.getByRole("list", { name: "Conversations" }).innerText();
  expect(listText).not.toMatch(/cm[a-z0-9]{20,}|undefined|null|\[object|"status"/);
  await expect(convoButton(page, "Priya Sharma")).toContainText("PS");
  await expect(convoButton(page, "Zed Oldman").getByText("Expired", { exact: true })).toBeVisible();
  await expect(convoButton(page, "Anita Desai").getByText("Open", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Expired", exact: true }).click();
  await expect(convoButton(page, "Zed Oldman")).toBeVisible();
  await expect(convoButton(page, "Priya Sharma")).toHaveCount(0);
  // Anita was opened (and so read) by the previous test; Rahul has never been opened and is still unread.
  await page.getByRole("button", { name: /^Unread/ }).click();
  await expect(convoButton(page, "Rahul Verma")).toBeVisible();
  await expect(convoButton(page, "Anita Desai")).toHaveCount(0);
  await page.getByRole("button", { name: "Unassigned", exact: true }).click();
  await expect(convoButton(page, "Rahul Verma")).toBeVisible();
  await page.getByRole("button", { name: "Mine", exact: true }).click();
  await expect(page.getByText("No conversations match")).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(convoButton(page, "Anita Desai")).toBeVisible();
  const search = page.getByRole("searchbox", { name: "Search conversations" });
  await search.fill("anit");
  await expect(convoButton(page, "Anita Desai")).toBeVisible();
  await expect(convoButton(page, "Anita Desai").locator("mark")).toHaveText("Anit");
  await expect(convoButton(page, "Priya Sharma")).toHaveCount(0);
  await search.fill(P.rahul.slice(-6));
  await expect(convoButton(page, "Rahul Verma")).toBeVisible();
  await search.fill("zzzz-nothing");
  await expect(page.getByText("No conversations match")).toBeVisible();
  // Under three characters message text is not searched, and the box says so instead of a bare "No conversations match".
  await search.fill("zq");
  await expect(page.getByText(/Type at least 3 characters to search messages/)).toBeVisible();
  await expect(page.getByText(/Messages are searched from 3 characters/)).toBeVisible();
  await search.fill("");
  await expect(convoButton(page, "Priya Sharma")).toBeVisible();
  await search.fill("(+[*");
  await expect(page.getByText("Pick a conversation")).toBeVisible();
  await search.fill("");
  expect(errors, errors.join("\n")).toEqual([]);
});

test("a chat whose 24-hour window closed shows Expired beside its status, and the header and Details agree on the status", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 900 });
  await openInbox(page);
  await openChat(page, "Zed Oldman");
  const header = page.locator("header").filter({ has: page.getByRole("heading", { level: 2, name: /Zed Oldman/ }) });
  await expect(header.getByText("Expired", { exact: true })).toBeVisible();
  const headerStatus = header.getByRole("combobox", { name: "Conversation status" });
  await expect(headerStatus).toHaveValue("open");
  expect(await headerStatus.locator("option").allInnerTexts()).not.toContain("Expired");
  await expect(page.getByRole("complementary", { name: "Contact details" }).getByLabel("Status")).toHaveValue("open");
});

test("window bar, sending a reply ends in a clear failed state with Send again", async ({ page, request }) => {
  await openInbox(page);
  await openChat(page, "Priya Sharma");
  const bar = page.getByRole("status").filter({ hasText: "Reply window open" });
  await expect(bar).toBeVisible();
  await expect(bar).toContainText(/\d+h \d+m left|\d+m left/);
  await expect(composer(page)).toBeFocused();
  await composer(page).fill("Yes, we deliver every day including Sunday.");
  await composer(page).press("Enter");
  await expect(log(page)).toContainText("Yes, we deliver every day including Sunday.");
  await tick(request, 3);
  // The failure text is now specific to the cause (here the fake number's expired connection), so find the alert by its Send again action.
  const alert = page.getByRole("alert").filter({ has: page.getByRole("button", { name: /send again|retry/i }) });
  await expect(alert).toBeVisible({ timeout: 30_000 });
  const again = alert.getByRole("button", { name: /send again|retry/i });
  await expect(again).toBeVisible();
  const text = await alert.innerText();
  expect(text, "failure message should be plain language").not.toMatch(/tenant_blocked|send_error|undefined|stack|ECONN|\bat \w+\.\w+/i);
  await again.click();
  await expect(log(page).getByText("Yes, we deliver every day including Sunday.")).toHaveCount(2, { timeout: 15_000 });
  await composer(page).fill("   ");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
});

test("Shift+Enter adds a line, the send key can be switched, and emoji shortcodes expand", async ({ page }) => {
  await openInbox(page);
  await openChat(page, "Priya Sharma");
  await composer(page).fill("line one");
  await composer(page).press("Shift+Enter");
  await composer(page).pressSequentially("line two :tada:");
  await expect(composer(page)).toHaveValue(/line one\nline two .*\u{1F389}/u);
  await page.getByRole("button", { name: /^Use (Ctrl\+Enter|Enter) to send$/ }).click();
  await expect(page.getByText("Ctrl+Enter sends, Enter adds a line.")).toBeVisible();
  await composer(page).press("Enter");
  await expect(composer(page)).toHaveValue(/\n$/);
  await page.getByRole("button", { name: /^Use (Ctrl\+Enter|Enter) to send$/ }).click();
  await composer(page).fill("");
});

test("drafts are kept per conversation and shown in the list", async ({ page }) => {
  await openInbox(page);
  await openChat(page, "Priya Sharma");
  await composer(page).fill("Half written reply for Priya");
  await openChat(page, "Anita Desai");
  await expect(composer(page)).toHaveValue("");
  await expect(convoButton(page, "Priya Sharma")).toContainText("Draft: Half written reply for Priya");
  await composer(page).fill("Draft for Anita");
  await openChat(page, "Priya Sharma");
  await expect(composer(page)).toHaveValue("Half written reply for Priya");
  await page.reload();
  await openChat(page, "Priya Sharma");
  await expect(composer(page)).toHaveValue("Half written reply for Priya");
  await composer(page).fill("");
  await openChat(page, "Anita Desai");
  await composer(page).fill("");
});

test("internal notes: a pending note can be undone, then saved, and shows in the chat and the side panel", async ({ page }) => {
  await openInbox(page);
  await openChat(page, "Anita Desai");
  await page.getByRole("group", { name: "Message type" }).getByRole("button", { name: "Internal note", exact: true }).click();
  await expect(composer(page)).toHaveCount(0);
  const noteBox = page.getByRole("textbox", { name: "Internal note", exact: true });
  await expect(noteBox).toHaveAttribute("placeholder", /Only your team sees it/);
  await noteBox.fill("Customer prefers evening calls");
  await noteBox.press("Enter");
  const bubble = log(page).getByText("Customer prefers evening calls");
  await expect(bubble).toBeVisible();
  await expect(log(page).getByText("Saving...")).toBeVisible();
  await log(page).getByRole("button", { name: "Undo" }).click();
  await expect(bubble).toHaveCount(0);
  await expect(noteBox).toHaveValue("Customer prefers evening calls");
  await noteBox.press("Enter");
  await expect(log(page).getByText("Saving...")).toBeVisible();
  await expect(log(page).getByText("Saving...")).toHaveCount(0, { timeout: 15_000 });
  await expect(log(page).getByText("Customer prefers evening calls")).toHaveCount(1);
  await expect(log(page).getByText(/Internal note, only your team sees this/)).toBeVisible();
  const panel = page.getByRole("complementary", { name: "Contact details" });
  await expect(panel.getByText("Customer prefers evening calls")).toBeVisible({ timeout: 15_000 });
  const d = await db();
  const sent = await d.query(`select count(*)::int n from "Message" where "conversationId" = $1 and direction = 'outbound'`, [ids.anita]);
  expect(sent.rows[0].n).toBe(0);
  await page.getByRole("button", { name: "Reply", exact: true }).click();
});

test("quick replies: create, validate, use with the / key, edit and delete", async ({ page }) => {
  await openInbox(page);
  await page.getByRole("button", { name: "Quick replies" }).click();
  const dlg = page.getByRole("dialog", { name: "Quick replies" });
  await expect(dlg).toBeVisible();
  await expect(dlg.getByText("No quick replies yet.")).toBeVisible();
  await dlg.getByRole("button", { name: "Add quick reply" }).click();
  await expect(dlg.getByText("No quick replies yet.")).toBeVisible();
  await dlg.getByLabel("Shortcut").fill("not valid!");
  await dlg.getByLabel("Reply text").fill("Whatever");
  await dlg.getByRole("button", { name: "Add quick reply" }).click();
  await expect(dlg.getByRole("alert")).toContainText(/shortcut must be/i);
  await dlg.getByLabel("Shortcut").fill("hours");
  await dlg.getByLabel("Reply text").fill("We are open 9am to 6pm, Monday to Saturday.");
  await dlg.getByRole("button", { name: "Add quick reply" }).click();
  await expect(dlg.getByText("/hours")).toBeVisible();
  await dlg.getByLabel("Shortcut").fill("hours");
  await dlg.getByLabel("Reply text").fill("dup");
  await dlg.getByRole("button", { name: "Add quick reply" }).click();
  await expect(dlg.getByRole("alert")).toContainText(/already exists/i);
  await dlg.getByLabel("Shortcut").fill("/Thanks");
  await dlg.getByLabel("Reply text").fill("Thank you for contacting us!");
  await dlg.getByRole("button", { name: "Add quick reply" }).click();
  await expect(dlg.getByText("/thanks")).toBeVisible();
  await dlg.getByRole("listitem").filter({ hasText: "/thanks" }).getByRole("button", { name: "Edit" }).click();
  await dlg.getByLabel("Reply text").fill("Thank you so much for contacting us!");
  await dlg.getByRole("button", { name: "Save changes" }).click();
  await expect(dlg.getByText("Thank you so much for contacting us!")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dlg).toBeHidden();
  await expect(page.getByRole("button", { name: "Quick replies" })).toBeFocused();
  await openChat(page, "Anita Desai");
  await composer(page).fill("/ho");
  const menu = page.getByRole("listbox", { name: "Quick replies and templates" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("option")).toHaveCount(1);
  await composer(page).press("Enter");
  await expect(composer(page)).toHaveValue("We are open 9am to 6pm, Monday to Saturday.");
  await composer(page).fill("/");
  await expect(menu).toBeVisible();
  await composer(page).press("Escape");
  await expect(composer(page)).toHaveValue("");
  await composer(page).fill("/zzzz");
  await expect(menu).toHaveCount(0);
  await composer(page).fill("");
  await page.getByRole("button", { name: "Quick replies" }).click();
  await dlg.getByRole("listitem").filter({ hasText: "/thanks" }).getByRole("button", { name: "Delete" }).click();
  await expect(dlg.getByText("/thanks")).toHaveCount(0);
  await page.keyboard.press("Escape");
});

test("templates: none approved explains what to do; an approved one is found with / and sent", async ({ page, request }) => {
  await openInbox(page);
  await openChat(page, "Priya Sharma");
  await page.getByRole("button", { name: "Template" }).click();
  await expect(page.getByText("No approved templates yet.")).toBeVisible();
  await page.getByRole("button", { name: "Template" }).click();
  const d = await db();
  await d.query(
    `insert into "Template" (id, "tenantId", "wabaRefId", name, language, category, status, components, "updatedAt") values ($1,$2,$3,'order_ready','en','UTILITY','approved',$4::jsonb, now())`,
    [`tpl${Date.now()}`, f.user.tenantId, f.fx.wabaRef, JSON.stringify([{ type: "BODY", text: "Hi {{1}}, your order is ready for pickup." }])],
  );
  await page.reload();
  await openChat(page, "Priya Sharma");
  await composer(page).fill("/order");
  const menu = page.getByRole("listbox", { name: "Quick replies and templates" });
  await expect(menu.getByRole("option", { name: /order ready/i })).toBeVisible({ timeout: 15_000 });
  await composer(page).press("Enter");
  const preview = page.getByLabel("Template preview");
  await expect(preview).toContainText("Hi Priya, your order is ready for pickup.");
  const sendBtn = page.getByRole("button", { name: "Send template" });
  await page.getByLabel("Value for {{1}}").fill("");
  await expect(sendBtn).toBeDisabled();
  await page.getByLabel("Value for {{1}}").fill("Priya");
  await sendBtn.click();
  await expect(log(page).getByText("Hi Priya, your order is ready for pickup.")).toBeVisible({ timeout: 15_000 });
  await tick(request, 3);
  await expect(log(page).getByText(/Template: order ready/)).toBeVisible();
});

test("suggest reply explains plainly that AI is not set up (503)", async ({ page }) => {
  await openInbox(page);
  await openChat(page, "Rahul Verma");
  const res = page.waitForResponse((r) => r.url().includes("/suggest") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Suggest reply" }).click();
  expect((await res).status()).toBe(503);
  const msg = page.getByText(/AI suggestions are not switched on/i).first();
  await expect(msg).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Dismiss" }).first().click();
});

test("status changes and assign to me from the chat header and the side panel; a new message reopens a solved chat", async ({ page, request }) => {
  // The header menus show when the chat column is wide; with the list and Details beside it that needs a wide screen.
  await page.setViewportSize({ width: 1920, height: 900 });
  await openInbox(page);
  await openChat(page, "Rahul Verma");
  const header = page.locator("header").filter({ has: page.getByRole("heading", { level: 2, name: /Rahul Verma/ }) });
  await header.getByRole("combobox", { name: "Assignee" }).selectOption({ label: f.user.name });
  const panel = page.getByRole("complementary", { name: "Contact details" });
  await expect(panel.getByLabel("Assigned to")).toHaveValue(f.user.userId, { timeout: 15_000 });
  await expect(convoButton(page, "Rahul Verma").getByTitle(/Assigned to You/)).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Mine", exact: true }).click();
  await expect(convoButton(page, "Rahul Verma")).toBeVisible();
  await expect(convoButton(page, "Priya Sharma")).toHaveCount(0);
  await page.getByRole("button", { name: "All", exact: true }).click();
  await header.getByRole("combobox", { name: "Conversation status" }).selectOption("pending");
  await expect(convoButton(page, "Rahul Verma").getByText("Pending", { exact: true })).toBeVisible({ timeout: 15_000 });
  await panel.getByLabel("Status").selectOption("open");
  await expect(convoButton(page, "Rahul Verma").getByText("Open", { exact: true })).toBeVisible({ timeout: 15_000 });
  await header.getByRole("button", { name: /Solve/ }).click();
  await expect(convoButton(page, "Rahul Verma").getByText("Solved", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(header.getByRole("button", { name: /Solve/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Solved", exact: true }).click();
  await expect(convoButton(page, "Rahul Verma")).toBeVisible();
  await page.getByRole("button", { name: "All", exact: true }).click();
  await deliverInbound(request, f.fx, P.rahul, "Actually one more question", "Rahul Verma");
  await tick(request, 3);
  await expect(convoButton(page, "Rahul Verma").getByText("Open", { exact: true })).toBeVisible({ timeout: 20_000 });
});
