import { expect, test, type Page } from "@playwright/test";
import { closeDb, db, deliverInbound, tick, watchErrors } from "./helpers";
import { conversationIdFor, convoButton, convoSql, deliverRaw, insertMessage, iso, openChat, openInbox, phoneFor, seedChat, setupOwner, sharedSession, type Fixture } from "./inbox-util";

test.afterAll(closeDb);
test.setTimeout(150_000);

const session = sharedSession();
session.hook(test);

let f: Fixture;
const P = { a: phoneFor(11), b: phoneFor(12), c: phoneFor(13), d: phoneFor(14), media: phoneFor(15), soon: phoneFor(16), gone: phoneFor(17), many: phoneFor(18) };
const ids: Record<string, string> = {};
const composer = (page: Page) => page.getByRole("textbox", { name: "Message" });
const log = (page: Page) => page.getByRole("log", { name: "Messages" });
const panel = (page: Page) => page.getByRole("complementary", { name: "Contact details" });

test("setup: owner with five chats of different kinds", async ({ page, context, request }) => {
  f = await setupOwner(context, "feat");
  ids.a = await seedChat(request, f, P.a, "Hi there, first customer", "Alice Adams");
  ids.b = await seedChat(request, f, P.b, "Second customer here", "Bob Brown");
  ids.c = await seedChat(request, f, P.c, "Third customer here", "Carol Clark");
  ids.d = await seedChat(request, f, P.d, "Fourth customer here", "Dan Davis");
  ids.soon = await seedChat(request, f, P.soon, "Closing soon customer", "Sally Soon", 23 * 3600_000);
  ids.gone = await seedChat(request, f, P.gone, "Window closed customer", "Gina Gone", 30 * 3600_000);
  await openInbox(page);
  await expect(convoButton(page, "Alice Adams")).toBeVisible({ timeout: 20_000 });
});

test("window bar: closing soon warning, and template-only mode after 24 hours", async ({ page, request }) => {
  await openInbox(page);
  await openChat(page, "Sally Soon");
  const soon = page.getByRole("status").filter({ hasText: "Reply window closing soon" });
  await expect(soon).toBeVisible();
  await expect(soon).toContainText(/\d+h \d+m left|\d+m left/);
  await openChat(page, "Gina Gone");
  const closed = page.getByRole("status").filter({ hasText: "Template-only mode" });
  await expect(closed).toBeVisible();
  await expect(closed).toContainText(/closed \d+ h ago/);
  await expect(composer(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Suggest reply" })).toHaveCount(0);
  // the way forward is explained: templates list or empty-state, and notes still work
  await expect(page.getByText(/No approved templates yet|Search templates/).first()).toBeVisible();
  await page.getByRole("button", { name: "Internal note", exact: true }).first().click();
  await expect(page.getByRole("textbox", { name: "Internal note", exact: true })).toBeVisible();
  // the server refuses a free-form send outside the window, with plain wording
  const res = await page.request.post(`/api/inbox/conversations/${ids.gone}/messages`, { headers: { origin: new URL(page.url()).origin }, data: { type: "text", body: "hello" } });
  expect(res.status()).toBe(409);
  expect((await res.json()).error).toMatch(/24-hour/);
});

test("keyboard: j/k move, Enter opens, e solves, a assigns, p/o change status, ? shows help and Esc closes it", async ({ page }) => {
  const errors = watchErrors(page);
  await openInbox(page);
  await expect(convoButton(page, "Dan Davis")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("heading", { level: 1, name: "Inbox" }).click();
  await page.keyboard.press("j");
  const rows = page.locator("[data-conversation]");
  const ring = page.locator("li.ring-2");
  await expect(ring).toHaveCount(1);
  // Compare rows by position: innerText keeps line breaks that toHaveText's textContent matching does not.
  const first = (await ring.getAttribute("aria-posinset")) ?? "";
  expect(first).not.toBe("");
  await page.keyboard.press("j");
  await expect(ring).not.toHaveAttribute("aria-posinset", first);
  await page.keyboard.press("k");
  await expect(ring).toHaveAttribute("aria-posinset", first);
  // help dialog
  await page.keyboard.press("?");
  const help = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(help).toBeVisible();
  for (const k of ["j / k", "Enter", "e", "a", "p", "o", "x", "/", "f", "Esc", "?"]) await expect(help.locator("kbd", { hasText: new RegExp(`^${k.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$`) }).first()).toBeVisible();
  await expect(help.getByRole("button", { name: "Close" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(help).toBeHidden();
  // pressing keys inside the dialog does not act on the list
  // act on the highlighted row: Dan Davis is the most recently active only if first; find him explicitly
  const dan = convoButton(page, "Dan Davis");
  await dan.focus();
  await page.keyboard.press("Tab"); // move off the button so shortcut keys apply (buttons ignore Enter only)
  await dan.focus();
  await page.keyboard.press("e");
  await expect(dan.getByText("Solved", { exact: true })).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("o");
  await expect(dan.getByText("Open", { exact: true })).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("p");
  await expect(dan.getByText("Pending", { exact: true })).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("o");
  await expect(dan.getByText("Open", { exact: true })).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("a");
  await expect(dan.getByTitle(/Assigned to You/)).toBeVisible({ timeout: 15_000 });
  // f focuses search, and shortcuts are off while typing
  await page.keyboard.press("f");
  const search = page.getByRole("searchbox", { name: "Search conversations" });
  await expect(search).toBeFocused();
  await page.keyboard.type("jk?ea");
  await expect(search).toHaveValue("jk?ea");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await search.fill("");
  // Enter on a highlighted row opens it, "/" jumps to the composer
  await page.getByRole("heading", { level: 1, name: "Inbox" }).click();
  await dan.focus();
  await page.keyboard.press("Enter");
  await expect(log(page)).toBeVisible();
  await expect(composer(page)).toBeFocused();
  await composer(page).blur();
  await page.getByRole("heading", { level: 1, name: "Inbox" }).click();
  await page.keyboard.press("/");
  await expect(composer(page)).toBeFocused();
  expect(errors, errors.join("\n")).toEqual([]);
  void rows;
});

test("bulk actions: select with x and the checkboxes, set status, assign, tag, and a clear result message", async ({ page }) => {
  await openInbox(page);
  await expect(convoButton(page, "Alice Adams")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("checkbox", { name: "Select conversation with Alice Adams" }).check();
  await page.getByRole("checkbox", { name: "Select conversation with Bob Brown" }).check();
  const bar = page.getByRole("toolbar", { name: "Bulk actions" });
  await expect(bar).toContainText("2 selected");
  await bar.getByRole("button", { name: "Select all loaded" }).click();
  await expect(bar).toContainText(/\d+ selected/);
  await bar.getByRole("button", { name: "Clear" }).click();
  await expect(bar).toHaveCount(0);
  await page.getByRole("checkbox", { name: "Select conversation with Alice Adams" }).check();
  await page.getByRole("checkbox", { name: "Select conversation with Bob Brown" }).check();
  await bar.getByLabel("Tag to add to selected").fill("vip");
  await bar.getByRole("button", { name: "Tag", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "2 updated." })).toBeVisible({ timeout: 15_000 });
  await expect(convoButton(page, "Alice Adams")).toContainText("vip");
  await expect(convoButton(page, "Bob Brown")).toContainText("vip");
  await expect(bar).toHaveCount(0);
  await page.getByRole("checkbox", { name: "Select conversation with Alice Adams" }).check();
  await page.getByRole("checkbox", { name: "Select conversation with Bob Brown" }).check();
  await bar.getByLabel("Set status for selected").selectOption("solved");
  await expect(page.getByRole("status").filter({ hasText: "2 updated." })).toBeVisible({ timeout: 15_000 });
  await expect(convoButton(page, "Alice Adams").getByText("Solved", { exact: true })).toBeVisible();
  await page.getByRole("checkbox", { name: "Select conversation with Alice Adams" }).check();
  await bar.getByLabel("Assign selected").selectOption({ label: f.user.name });
  await expect(page.getByRole("status").filter({ hasText: "1 updated." })).toBeVisible({ timeout: 15_000 });
  await expect(convoButton(page, "Alice Adams").getByTitle(/Assigned to You/)).toBeVisible();
  await page.getByRole("checkbox", { name: "Select conversation with Alice Adams" }).check();
  await bar.getByLabel("Assign selected").selectOption("__none");
  await expect(convoButton(page, "Alice Adams").getByTitle(/Assigned to/)).toHaveCount(0, { timeout: 15_000 });
  // tag filter
  await page.getByLabel("Filter by tag").fill("vip");
  await expect(convoButton(page, "Alice Adams")).toBeVisible();
  await expect(convoButton(page, "Carol Clark")).toHaveCount(0);
  await page.getByLabel("Filter by tag").fill("");
  // The list reloads when a filter changes; wait for the rows to come back before using the keyboard on one.
  await expect(convoButton(page, "Carol Clark")).toBeVisible();
  // x toggles selection, Esc clears it
  await page.getByRole("heading", { level: 1, name: "Inbox" }).click();
  await convoButton(page, "Carol Clark").focus();
  await page.keyboard.press("x");
  await expect(page.getByRole("checkbox", { name: "Select conversation with Carol Clark" })).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("checkbox", { name: "Select conversation with Carol Clark" })).not.toBeChecked();
  // quick actions on a row
  const li = page.locator("li").filter({ has: convoButton(page, "Carol Clark") });
  await li.hover();
  await li.getByRole("button", { name: /Assign conversation with Carol Clark to me/ }).click();
  await expect(convoButton(page, "Carol Clark").getByTitle(/Assigned to You/)).toBeVisible({ timeout: 15_000 });
  await li.hover();
  await li.getByRole("button", { name: /Mark conversation with Carol Clark solved/ }).click();
  await expect(convoButton(page, "Carol Clark").getByText("Solved", { exact: true })).toBeVisible({ timeout: 15_000 });
});

test("contact side panel: tags, attributes, name, opt-in, history, lead and ad source", async ({ page }) => {
  const d = await db();
  const conv = (await d.query(`select "contactId" from "Conversation" where id = $1`, [ids.b])).rows[0];
  // The bulk-actions test above tags Bob "vip"; this test starts from an untagged chat.
  await d.query(`update "Conversation" set tags = '{}' where id = $1`, [ids.b]);
  await d.query(`update "Contact" set tags = '{}' where id = $1`, [conv.contactId]);
  await d.query(`insert into "LeadForm" (id, "tenantId", "pageAssetId", "metaFormId", name) values ($1,$2,'page1',$3,'Spring offer form')`, [`lf${Date.now()}`, f.user.tenantId, `mf${Date.now()}`]);
  const form = (await d.query(`select id from "LeadForm" where "tenantId" = $1`, [f.user.tenantId])).rows[0];
  await d.query(
    `insert into "Lead" (id, "tenantId", "leadFormId", "leadgenId", "contactId", fields, status, "consentAt", "createdAt") values ($1,$2,$3,$4,$5,$6::jsonb,'qualified',$7::timestamp,$7::timestamp)`,
    [`lead${Date.now()}`, f.user.tenantId, form.id, `lg${Date.now()}`, conv.contactId, JSON.stringify({ full_name: "Bob Brown", city: "Pune", budget_range: "10-20k" }), iso(86_400_000)],
  );
  await convoSql(ids.b, `referral = $1::jsonb`, [JSON.stringify({ sourceType: "ad", sourceId: "120001", sourceUrl: "https://fb.me/ad-120001", headline: "Spring sale 30% off", ctwaClid: "SECRETCLICKID" })]);
  await openInbox(page);
  await openChat(page, "Bob Brown");
  const p = panel(page);
  await expect(p.getByRole("heading", { name: "Contact" })).toBeVisible();
  await expect(p.getByText("Bob Brown").first()).toBeVisible();
  await expect(p.getByText("No opt-in recorded")).toBeVisible();
  // ad source
  await expect(p.getByText("Came from an ad")).toBeVisible();
  await expect(p.getByText("Spring sale 30% off")).toBeVisible();
  await expect(p.getByRole("link", { name: /Open the ad/ })).toHaveAttribute("href", "https://fb.me/ad-120001");
  await expect(p.getByRole("link", { name: /Open the ad/ })).toHaveAttribute("rel", /noopener/);
  await expect(p).not.toContainText("SECRETCLICKID");
  // lead
  await expect(p.getByText("Lead", { exact: true })).toBeVisible();
  await expect(p.getByText("Qualified")).toBeVisible();
  await expect(p.getByText("Spring offer form")).toBeVisible();
  await expect(p.getByText("Pune")).toBeVisible();
  await expect(p.getByText("budget range")).toBeVisible();
  await expect(p.getByRole("link", { name: "Open in Leads" })).toHaveAttribute("href", "/app/leads");
  // history
  await expect(p.getByText(/messages in this chat, \d+ from the customer/)).toBeVisible({ timeout: 15_000 });
  // tags
  await expect(p.getByText("No tags yet")).toBeVisible();
  await p.getByLabel("New tag").fill("hot lead");
  await p.getByRole("button", { name: "Add", exact: true }).click();
  await expect(p.getByText("hot lead")).toBeVisible();
  await expect(convoButton(page, "Bob Brown")).toContainText("hot lead");
  await p.getByLabel("New tag").fill("hot lead");
  await p.getByRole("button", { name: "Add", exact: true }).click();
  await expect(p.getByText("hot lead")).toHaveCount(1);
  await p.getByRole("button", { name: "Remove tag hot lead" }).click();
  await expect(p.getByText("No tags yet")).toBeVisible();
  // attributes
  await expect(p.getByText("No details saved")).toBeVisible();
  await expect(p.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await p.getByLabel("Attribute name").fill("city");
  await p.getByLabel("Attribute value").fill("Mumbai");
  await p.getByRole("button", { name: "Save", exact: true }).click();
  await expect(p.getByRole("term").filter({ hasText: "city" })).toBeVisible();
  await expect(p.getByText("Mumbai")).toBeVisible();
  await page.reload();
  await openChat(page, "Bob Brown");
  await expect(p.getByText("Mumbai")).toBeVisible({ timeout: 15_000 });
  await p.getByRole("button", { name: "Remove city" }).click();
  await expect(p.getByText("No details saved")).toBeVisible();
  // name
  await p.getByRole("button", { name: "Edit" }).click();
  await p.getByLabel("Contact name").fill("Robert Brown");
  await p.getByRole("button", { name: "Save", exact: true }).first().click();
  await expect(convoButton(page, "Robert Brown")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("heading", { level: 2, name: /Robert Brown/ })).toBeVisible();
  // panel can be closed and reopened and remembers the choice
  await p.getByRole("button", { name: "Close details" }).click();
  await expect(p).toHaveCount(0);
  await page.reload();
  await openChat(page, "Robert Brown");
  await expect(p).toHaveCount(0);
  await page.getByRole("button", { name: "Contact details" }).click();
  await expect(p).toBeVisible();
});

test("inbound media: no real file gives a clear failed state with Try again; placeholders for other types", async ({ page }) => {
  const errors = watchErrors(page);
  const request = page.request;
  await deliverRaw(request, f, P.media, { type: "image", image: { id: "NOSUCHMEDIA1", mime_type: "image/jpeg", caption: "Look at this" } }, "Mia Media");
  await tick(request, 3);
  ids.media = await conversationIdFor(request, f, P.media);
  await insertMessage(f, ids.media, { type: "document", body: "[document: invoice.pdf] please check", mediaUrl: "meta-media:NOSUCHDOC1", mediaMime: "application/pdf", createdAt: iso(5000) });
  await insertMessage(f, ids.media, { type: "audio", body: "[audio]", mediaUrl: "meta-media:NOSUCHAUD1", mediaMime: "audio/ogg", createdAt: iso(4000) });
  await insertMessage(f, ids.media, { type: "image", body: "[image]", mediaUrl: null, mediaMime: "image/jpeg", createdAt: iso(3000) });
  await insertMessage(f, ids.media, { type: "location", body: "[location] 18.52,73.85 Shop", createdAt: iso(2000) });
  await insertMessage(f, ids.media, { type: "reaction", body: "[reaction] \u{1F44D}", createdAt: iso(1000) });
  await openInbox(page);
  await expect(convoButton(page, "Mia Media")).toBeVisible({ timeout: 20_000 });
  await expect(convoButton(page, "Mia Media")).toContainText(/Reaction|\[reaction\]/);
  await openChat(page, "Mia Media");
  await expect(log(page).getByText("Look at this")).toBeVisible();
  await expect(log(page).getByText("Could not load this file.").first()).toBeVisible({ timeout: 20_000 });
  await expect(log(page).getByRole("button", { name: "Try again" }).first()).toBeVisible();
  await expect(log(page).getByText("Image received. Preview is not available.")).toBeVisible();
  const text = await log(page).innerText();
  expect(text, "no raw tokens in the chat").not.toMatch(/meta-media:|NOSUCH|undefined|\[object/);
  // try again does not crash
  await log(page).getByRole("button", { name: "Try again" }).first().click();
  await expect(log(page).getByText("Could not load this file.").first()).toBeVisible({ timeout: 20_000 });
  // direct request for the media gives a plain error, never a stack trace or a token
  const msg = (await (await db()).query(`select id from "Message" where "conversationId" = $1 and type = 'image' and "mediaUrl" like 'meta-media:%'`, [ids.media])).rows[0];
  const r = await page.request.get(`/api/inbox/media/${msg.id}`);
  expect(r.status()).toBeGreaterThanOrEqual(400);
  expect(await r.text()).not.toMatch(/EAA[A-Za-z0-9]{10,}|access_token|at \w+ \(|node_modules/);
  expect(errors.filter((e) => !/Failed to load resource/.test(e)), errors.join("\n")).toEqual([]);
});

test("a long history loads newest first with a Load older messages button, in order", async ({ page, request }) => {
  const id = await seedChat(request, f, P.many, "message number 1", "Hist Orian", 3 * 3600_000);
  for (let i = 2; i <= 70; i++) await insertMessage(f, id, { type: "text", body: `message number ${i}`, direction: i % 2 ? "inbound" : "outbound", status: i % 2 ? "received" : "delivered", createdAt: iso((75 - i) * 60_000) });
  await convoSql(id, `"lastMessageAt" = $1::timestamp, "lastInboundAt" = $1::timestamp`, [iso(5 * 60_000)]);
  await openInbox(page);
  await openChat(page, "Hist Orian");
  await expect(log(page).getByText("message number 70", { exact: true })).toBeVisible({ timeout: 15_000 });
  const older = page.getByRole("button", { name: "Load older messages" });
  await expect(older).toBeVisible();
  await expect(log(page).getByText("message number 1", { exact: true })).toHaveCount(0);
  await older.click();
  await expect(log(page).getByText("message number 1", { exact: true })).toHaveCount(1, { timeout: 15_000 });
  await expect(older).toHaveCount(0);
  const all = await log(page).locator("p.whitespace-pre-wrap").allInnerTexts();
  const nums = all.map((t) => Number(/message number (\d+)/.exec(t)?.[1])).filter((n) => !Number.isNaN(n));
  expect(nums).toEqual([...nums].sort((a, b) => a - b));
  expect(new Set(nums).size).toBe(nums.length);
});

test("attachments: wrong type and empty file get plain messages", async ({ page }) => {
  await openInbox(page);
  await openChat(page, "Dan Davis");
  const input = page.locator('input[type="file"]');
  // Plain text is a supported document type now; a zip archive is not.
  await input.setInputFiles({ name: "archive.zip", mimeType: "application/zip", buffer: Buffer.from("PK") });
  await expect(page.getByRole("alert").filter({ hasText: /WhatsApp accepts JPEG or PNG photos/ })).toBeVisible();
  await input.setInputFiles({ name: "empty.png", mimeType: "image/png", buffer: Buffer.alloc(0) });
  await expect(page.getByRole("alert").filter({ hasText: /empty/i })).toBeVisible();
  // a tiny but invalid png is rejected by the server with a readable message
  await input.setInputFiles({ name: "broken.png", mimeType: "image/png", buffer: Buffer.from("not really a png") });
  const alert = page.getByRole("alert").filter({ hasText: /./ }).last();
  await expect(alert).toBeVisible({ timeout: 15_000 });
  expect(await alert.innerText()).not.toMatch(/undefined|Error:|\bat \w+/);
});

test("deleting nothing leaks between a chat and the next: switching chats shows only that chat's messages", async ({ page }) => {
  await openInbox(page);
  await openChat(page, "Dan Davis");
  await expect(log(page)).toContainText("Fourth customer here");
  await expect(log(page)).not.toContainText("Third customer here");
  await openChat(page, "Carol Clark");
  await expect(log(page)).toContainText("Third customer here");
  await expect(log(page)).not.toContainText("Fourth customer here");
});
