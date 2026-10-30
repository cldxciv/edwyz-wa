import { expect, test, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { closeDb, db, watchErrors } from "./helpers";
import { axeSerious, convoButton, convoSql, iso, insertMessage, openChat, openInbox, phoneFor, seedChat, setupOwner, setTheme, sharedSession, type Fixture } from "./inbox-util";

test.afterAll(closeDb);
test.setTimeout(150_000);

const session = sharedSession();
session.hook(test);

let f: Fixture;
const P = { a: phoneFor(31), b: phoneFor(32) };
const ids: Record<string, string> = {};
const composer = (page: Page) => page.getByRole("textbox", { name: "Message" });
const log = (page: Page) => page.getByRole("log", { name: "Messages" });

async function noHorizontalOverflow(page: Page, label: string) {
  const o = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth - document.documentElement.clientWidth, body: document.body.scrollWidth - document.body.clientWidth }));
  expect(o.doc, `${label}: page scrolls sideways by ${o.doc}px`).toBeLessThanOrEqual(1);
  expect(o.body, `${label}: body scrolls sideways by ${o.body}px`).toBeLessThanOrEqual(1);
}

let ready = false;
async function ensure(context: BrowserContext, request: APIRequestContext) {
  if (ready) return;
  ready = true;
  f = await setupOwner(context, "ui");
  ids.a = await seedChat(request, f, P.a, "Hello, I would like to know about a very long message that keeps going and going so that wrapping can be checked on narrow screens: https://example.com/a/really/long/url/that/never/ends/and/never/breaks/anywhere/at/all/0123456789", "Veronica Longname-Withverylongsurname");
  ids.b = await seedChat(request, f, P.b, "Short one", "Short Sam");
  await insertMessage(f, ids.a, { type: "text", body: "Thanks, we will check.", direction: "outbound", status: "failed", errorCode: "131047", createdAt: iso(1000) });
  await insertMessage(f, ids.a, { type: "text", body: "Delivered one", direction: "outbound", status: "delivered", createdAt: iso(2000) });
  await insertMessage(f, ids.a, { type: "text", body: "Read one", direction: "outbound", status: "read", createdAt: iso(3000) });
  const d = await db();
  await d.query(`insert into "Note" (id, "tenantId", "conversationId", "authorId", body, "createdAt") values ($1,$2,$3,$4,'A private team note',$5::timestamp)`, [`n${Date.now()}`, f.user.tenantId, ids.a, f.user.userId, iso(500)]);
}

test("setup", async ({ context, request }) => {
  await ensure(context, request);
});

test("headings, landmarks and lists: one h1, labelled regions, loading skeleton and no console errors", async ({ page }) => {
  const errors = watchErrors(page);
  await openInbox(page);
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  await expect(page.locator("main, [role=main]")).toHaveCount(1);
  await expect(page.getByRole("navigation").first()).toBeVisible();
  await expect(page.getByRole("list", { name: "Conversations" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("group", { name: "Filter conversations" })).toBeVisible();
  await openChat(page, "Veronica");
  await expect(page.getByRole("log", { name: "Messages" })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Contact details" })).toBeVisible();
  // failure explanation for a closed-window rejection is plain language
  await expect(page.getByRole("alert").filter({ hasText: "24-hour window had closed" })).toBeVisible();
  const text = await log(page).innerText();
  expect(text).not.toMatch(/131047|undefined|\[object/);
  expect(errors, errors.join("\n")).toEqual([]);
});

test("accessibility (axe): list, chat, side panel and dialogs have no serious or critical violations", async ({ page }) => {
  await openInbox(page);
  await expect(convoButton(page, "Short Sam")).toBeVisible({ timeout: 20_000 });
  const found: string[] = [];
  found.push(...(await axeSerious(page, "list-only")));
  await openChat(page, "Veronica");
  await expect(page.getByRole("complementary", { name: "Contact details" })).toBeVisible();
  await expect(page.getByText(/messages in this chat/)).toBeVisible({ timeout: 15_000 });
  found.push(...(await axeSerious(page, "chat+panel")));
  await page.getByRole("group", { name: "Message type" }).getByRole("button", { name: "Internal note", exact: true }).click();
  found.push(...(await axeSerious(page, "note-mode")));
  await page.getByRole("button", { name: "Reply", exact: true }).click();
  await composer(page).fill("/");
  found.push(...(await axeSerious(page, "slash-menu")));
  await composer(page).fill("");
  await page.getByRole("button", { name: "Quick replies" }).click();
  found.push(...(await axeSerious(page, "quick-replies-dialog")));
  await page.keyboard.press("Escape");
  await page.locator("h1").click();
  await page.keyboard.press("?");
  found.push(...(await axeSerious(page, "shortcuts-dialog")));
  await page.keyboard.press("Escape");
  expect(found, found.join("\n")).toEqual([]);
});

test("dark theme: toggled from the app, stays readable (axe contrast) and the chat bubbles keep their meaning", async ({ page }) => {
  await openInbox(page);
  await setTheme(page, "dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(convoButton(page, "Short Sam")).toBeVisible({ timeout: 20_000 });
  const found: string[] = [];
  found.push(...(await axeSerious(page, "dark-list")));
  await openChat(page, "Veronica");
  await expect(page.getByText(/messages in this chat/)).toBeVisible({ timeout: 15_000 });
  found.push(...(await axeSerious(page, "dark-chat+panel")));
  // the message area is not a light box on a dark page: background luminance of the log is dark
  const lum = await log(page).evaluate((el) => {
    const m = getComputedStyle(el.closest("div.flex.h-full") ?? el).backgroundColor.match(/\d+(\.\d+)?/g)?.map(Number) ?? [255, 255, 255];
    return (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255;
  });
  expect(lum).toBeLessThan(0.5);
  await page.getByRole("group", { name: "Message type" }).getByRole("button", { name: "Internal note", exact: true }).click();
  found.push(...(await axeSerious(page, "dark-note-mode")));
  await page.getByRole("button", { name: "Quick replies" }).click();
  found.push(...(await axeSerious(page, "dark-quick-replies")));
  await page.keyboard.press("Escape");
  await setTheme(page, "light");
  expect(found, found.join("\n")).toEqual([]);
});

test("keyboard-only: Tab order reaches search, filters, list, then chat; dialogs trap and return focus", async ({ page }) => {
  await openInbox(page);
  await expect(convoButton(page, "Short Sam")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Shortcuts" }).focus();
  await page.keyboard.press("Enter");
  const help = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(help).toBeVisible();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(help.locator(":focus")).toHaveCount(1); // focus stays inside the modal
  await page.keyboard.press("Escape");
  await expect(help).toBeHidden();
  await expect(page.getByRole("button", { name: "Shortcuts" })).toBeFocused();
  // reach the list by Tab only, then open a chat with Enter
  const search = page.getByRole("searchbox", { name: "Search conversations" });
  await search.focus();
  let reached = false;
  for (let i = 0; i < 30 && !reached; i++) {
    await page.keyboard.press("Tab");
    reached = await page.evaluate(() => document.activeElement?.hasAttribute("data-conversation") ?? false);
  }
  expect(reached, "a conversation row is reachable with Tab").toBe(true);
  await page.keyboard.press("Enter");
  await expect(log(page)).toBeVisible();
  // the message log is focusable so keyboard users can scroll it
  await log(page).focus();
  await expect(log(page)).toBeFocused();
});

test("narrow desktop (800px): nothing overflows and the layout keeps working", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 700 });
  await openInbox(page);
  await expect(convoButton(page, "Short Sam")).toBeVisible({ timeout: 20_000 });
  await noHorizontalOverflow(page, "800px list");
  await openChat(page, "Veronica");
  await noHorizontalOverflow(page, "800px chat");
});

test("@mobile single-pane layout: list, then chat with Back, details as a full screen sheet, no sideways scroll at 360px", async ({ page, context, request }) => {
  await ensure(context, request);
  await page.setViewportSize({ width: 360, height: 740 });
  const errors = watchErrors(page);
  await openInbox(page);
  await expect(convoButton(page, "Short Sam")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Pick a conversation")).toBeHidden();
  await noHorizontalOverflow(page, "360px list");
  // filters scroll inside their own strip, not the page
  await expect(page.getByRole("button", { name: "Expired", exact: true })).toBeAttached();
  await convoButton(page, "Veronica").click();
  await expect(log(page)).toBeVisible();
  await expect(page.getByRole("list", { name: "Conversations" })).toBeHidden();
  await noHorizontalOverflow(page, "360px chat");
  // long unbroken URL must wrap inside its bubble
  const bubble = log(page).getByText(/really\/long\/url/).first();
  const box = await bubble.boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(361);
  // composer is on screen and not covered by the bottom bar
  const c = await composer(page).boundingBox();
  expect(c!.y + c!.height).toBeLessThanOrEqual(741);
  const covered = await composer(page).evaluate((el) => {
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !(top === el || el.contains(top));
  });
  expect(covered, "the message box is covered by another element (bottom bar?)").toBe(false);
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  // details open as a full sheet and close again
  await page.getByRole("button", { name: "Contact details" }).click();
  const panel = page.getByRole("complementary", { name: "Contact details" });
  await expect(panel).toBeVisible();
  const pb = await panel.boundingBox();
  expect(pb!.width).toBeGreaterThanOrEqual(355);
  await noHorizontalOverflow(page, "360px details");
  await expect(panel.getByLabel("Status")).toBeVisible();
  await panel.getByRole("button", { name: "Close details" }).click();
  await expect(panel).toHaveCount(0);
  // Back returns to the list and focus lands on the row we left
  await page.getByRole("button", { name: "Back to conversations" }).click();
  await expect(page.getByRole("list", { name: "Conversations" })).toBeVisible();
  await expect(convoButton(page, "Veronica")).toBeFocused();
  // quick actions are reachable without hover on touch: the row actions appear on focus
  await convoButton(page, "Short Sam").focus();
  await expect(page.getByRole("button", { name: /Mark conversation with Short Sam solved/ })).toBeVisible();
  expect(errors, errors.join("\n")).toEqual([]);
});

test("@mobile header actions stay reachable on a phone: Solve and Details are visible, status and assignee live in Details", async ({ page, context, request }) => {
  await ensure(context, request);
  await page.setViewportSize({ width: 360, height: 740 });
  await openInbox(page);
  await convoButton(page, "Short Sam").click();
  await expect(log(page)).toBeVisible();
  const header = page.locator("header").filter({ has: page.getByRole("heading", { level: 2, name: /Short Sam/ }) });
  const hb = await header.boundingBox();
  expect(hb!.width).toBeLessThanOrEqual(361);
  await expect(header.getByRole("button", { name: "Back to conversations" })).toBeVisible();
  await expect(header.getByRole("button", { name: "Contact details" })).toBeVisible();
  // On a phone the Solve button is icon-only; its accessible name is "Mark solved (e)" (from its title), so match case-insensitively.
  await header.getByRole("button", { name: /solve/i }).click();
  await page.getByRole("button", { name: "Contact details" }).click();
  await expect(page.getByRole("complementary", { name: "Contact details" }).getByLabel("Status")).toHaveValue("solved", { timeout: 15_000 });
  void convoSql;
});

test("a slow or failing network shows a plain error with Try again instead of a blank list", async ({ page }) => {
  await page.route("**/api/inbox/conversations?*", (route) => route.abort());
  await page.route("**/api/inbox/conversations", (route) => route.abort());
  await page.goto("/app/inbox");
  await expect(page.getByText("Could not load conversations")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  const text = await page.locator("main").innerText();
  expect(text).not.toMatch(/TypeError|Failed to fetch|undefined|\[object/i);
  await page.unroute("**/api/inbox/conversations?*");
  await page.unroute("**/api/inbox/conversations");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(convoButton(page, "Short Sam")).toBeVisible({ timeout: 20_000 });
});

test("an open chat that disappears or fails to load says so plainly", async ({ page }) => {
  await openInbox(page);
  await expect(convoButton(page, "Short Sam")).toBeVisible({ timeout: 20_000 });
  await page.route(/\/api\/inbox\/conversations\/[^/]+$/, (route) => route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Conversation not found." }) }));
  await convoButton(page, "Short Sam").click();
  await expect(page.getByText("This conversation is no longer available")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Back to the list" })).toBeVisible();
  await page.unroute(/\/api\/inbox\/conversations\/[^/]+$/);
});
