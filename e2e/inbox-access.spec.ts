import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { closeDb, db, ORIGIN, signupUser, tick, watchErrors } from "./helpers";
import { acceptInvite, conversationIdFor, convoButton, inviteAgent, openChat, openInbox, phoneFor, seedChat, setupOwner, sharedSession, type Fixture } from "./inbox-util";

test.afterAll(closeDb);
test.setTimeout(150_000);

const ownerSession = sharedSession();
const agentSession = sharedSession();
const otherSession = sharedSession();

let f: Fixture;
let agentId = "";
let agentName = "";
const P = { free: phoneFor(21), mine: phoneFor(22), theirs: phoneFor(23) };
const ids: Record<string, string> = {};
const post = (page: Page, url: string, data: unknown, method: "POST" | "PUT" | "PATCH" = "POST") =>
  page.request.fetch(url, { method, headers: { origin: ORIGIN }, data });

async function as(session: ReturnType<typeof sharedSession>, context: BrowserContext) {
  await session.restore(context);
}

test("setup: owner workspace with three chats, one agent invited through the real invite flow", async ({ page, context, request, browser }) => {
  f = await setupOwner(context, "acc");
  ids.free = await seedChat(request, f, P.free, "Unassigned question", "Una Free");
  ids.mine = await seedChat(request, f, P.mine, "Chat for the agent", "Mira Mine");
  ids.theirs = await seedChat(request, f, P.theirs, "Chat for the owner", "Tara Theirs");
  const inv = await inviteAgent(context, f, "ag");
  await ownerSession.save(context);
  const agentCtx = await browser.newContext();
  const accepted = await acceptInvite(agentCtx, inv);
  agentId = accepted.user.id;
  agentName = inv.name;
  expect(accepted.role).toBe("agent");
  await agentSession.save(agentCtx);
  await agentCtx.close();
  const d = await db();
  await d.query(`update "Conversation" set "assignedToId" = $1 where id = $2`, [agentId, ids.mine]);
  await d.query(`update "Conversation" set "assignedToId" = $1 where id = $2`, [f.user.userId, ids.theirs]);
  await page.goto("/app/inbox");
});

test("agent: sees the list, assignee names are plain, and cannot delete quick replies", async ({ page, context }) => {
  const errors = watchErrors(page);
  await as(agentSession, context);
  await openInbox(page);
  for (const n of ["Una Free", "Mira Mine", "Tara Theirs"]) await expect(convoButton(page, n)).toBeVisible({ timeout: 20_000 });
  await expect(convoButton(page, "Mira Mine").getByTitle(/Assigned to You/)).toBeVisible();
  await expect(convoButton(page, "Tara Theirs").getByTitle(/Assigned to /)).toBeVisible();
  await page.getByRole("button", { name: "Mine", exact: true }).click();
  await expect(convoButton(page, "Mira Mine")).toBeVisible();
  await expect(convoButton(page, "Tara Theirs")).toHaveCount(0);
  await page.getByRole("button", { name: "All", exact: true }).click();
  // quick replies: agents can add but not delete
  await page.getByRole("button", { name: "Quick replies" }).click();
  const dlg = page.getByRole("dialog", { name: "Quick replies" });
  await dlg.getByLabel("Shortcut").fill("agentqr");
  await dlg.getByLabel("Reply text").fill("Agent made reply");
  await dlg.getByRole("button", { name: "Add quick reply" }).click();
  await expect(dlg.getByText("/agentqr")).toBeVisible();
  await expect(dlg.getByRole("button", { name: "Delete" })).toHaveCount(0);
  const direct = await page.request.delete(`/api/quick-replies/nonexistent`, { headers: { origin: ORIGIN } });
  expect(direct.status()).toBe(403);
  await page.keyboard.press("Escape");
  expect(errors, errors.join("\n")).toEqual([]);
});

test("agent: can take an unassigned chat for themself but cannot reassign or change a chat owned by a teammate", async ({ page, context }) => {
  await as(agentSession, context);
  await openInbox(page);
  // take the unassigned chat using the quick action
  const li = page.locator("li").filter({ has: convoButton(page, "Una Free") });
  await li.hover();
  await li.getByRole("button", { name: /Assign conversation with Una Free to me/ }).click();
  await expect(convoButton(page, "Una Free").getByTitle(/Assigned to You/)).toBeVisible({ timeout: 15_000 });
  // no assign shortcut on the owner's chat
  const li2 = page.locator("li").filter({ has: convoButton(page, "Tara Theirs") });
  await li2.hover();
  await expect(li2.getByRole("button", { name: /Assign conversation with Tara Theirs to me/ })).toHaveCount(0);
  // the owner's chat: trying to change the status from the header gives a plain message
  await openChat(page, "Tara Theirs");
  const header = page.locator("header").filter({ has: page.getByRole("heading", { level: 2, name: /Tara Theirs/ }) });
  await header.getByRole("button", { name: /Solve/ }).click();
  const alert = page.getByRole("alert").filter({ hasText: /assigned to someone else/i });
  await expect(alert).toBeVisible({ timeout: 15_000 });
  expect(await alert.innerText()).not.toMatch(/403|undefined|Error:/);
  await alert.getByRole("button", { name: "Dismiss" }).click();
  // reassign to someone else is refused
  const res = await post(page, `/api/inbox/conversations/${ids.mine}/assign`, { userId: f.user.userId }, "PUT");
  expect(res.status()).toBe(403);
});

test("agent: the status menu does not offer an option that always fails (Blocked is admin-only)", async ({ page, context }) => {
  await as(agentSession, context);
  // The header menus show when the chat column is wide; with the list and Details beside it that needs a wide screen.
  await page.setViewportSize({ width: 1920, height: 900 });
  await openInbox(page);
  await openChat(page, "Mira Mine");
  const header = page.locator("header").filter({ has: page.getByRole("heading", { level: 2, name: /Mira Mine/ }) });
  const statusSelect = header.getByRole("combobox", { name: "Conversation status" });
  await expect(statusSelect).toBeVisible();
  const options = await statusSelect.locator("option:not([disabled])").allInnerTexts();
  expect(options, "an agent is offered Blocked, but the server answers 403 'Only admins can block a conversation.'").not.toContain("Blocked");
  const panelStatus = page.getByRole("complementary", { name: "Contact details" }).getByLabel("Status");
  await expect(panelStatus).toBeVisible();
  expect(await panelStatus.locator("option").allInnerTexts(), "the Details panel offers what the header does").not.toContain("Blocked");
});

test("agent: should not be able to message, tag or write notes on a chat assigned to a teammate (same rule as status)", async ({ page, context }) => {
  await as(agentSession, context);
  await openInbox(page);
  // status is protected for teammates' chats; the other write paths should follow the same rule
  const status = await post(page, `/api/inbox/conversations/${ids.theirs}/status`, { status: "solved" }, "PATCH");
  expect(status.status(), "status is protected").toBe(403);
  const tags = await post(page, `/api/inbox/conversations/${ids.theirs}/tags`, { tags: ["sneaky"] }, "PUT");
  const note = await post(page, `/api/inbox/conversations/${ids.theirs}/notes`, { body: "agent note on teammate chat" });
  const msg = await post(page, `/api/inbox/conversations/${ids.theirs}/messages`, { type: "text", body: "agent writing on a teammate chat" });
  const results = { tags: tags.status(), note: note.status(), message: msg.status() };
  expect(results, "agent could write to a chat assigned to someone else").toEqual({ tags: 403, note: 403, message: 403 });
});

test("agent: bulk assign cannot hand chats to other people (single assign forbids it)", async ({ page, context }) => {
  await as(agentSession, context);
  await openInbox(page);
  const d = await db();
  const free = await seedChatDirect();
  async function seedChatDirect() {
    const r = await d.query(`select id from "Conversation" where id = $1`, [ids.free]);
    return r.rows[0].id as string;
  }
  await d.query(`update "Conversation" set "assignedToId" = null where id = $1`, [free]);
  const single = await post(page, `/api/inbox/conversations/${free}/assign`, { userId: f.user.userId }, "PUT");
  expect(single.status()).toBe(403);
  const bulk = await post(page, `/api/inbox/conversations/bulk`, { ids: [free], action: "assign", userId: f.user.userId });
  const body = await bulk.json().catch(() => ({}));
  expect(bulk.status() === 403 || body.updated === 0, `bulk assign by an agent moved an unassigned chat to the owner: ${JSON.stringify(body)}`).toBe(true);
});

test("agent: cannot block, cannot invite, cannot use admin APIs from the inbox", async ({ page, context }) => {
  await as(agentSession, context);
  await openInbox(page);
  const block = await post(page, `/api/inbox/conversations/${ids.mine}/status`, { status: "blocked" }, "PATCH");
  expect(block.status()).toBe(403);
  expect((await block.json()).error).toMatch(/admin/i);
  const bulk = await post(page, `/api/inbox/conversations/bulk`, { ids: [ids.mine], action: "status", status: "blocked" });
  expect(bulk.status()).toBe(403);
  const invite = await post(page, `/api/workspace/invites`, { email: "x@example.com", role: "agent" });
  expect(invite.status()).toBe(403);
});

test("owner: can block and reopen a chat, and the chat shows plain wording", async ({ page, context }) => {
  await as(ownerSession, context);
  await page.setViewportSize({ width: 1920, height: 900 });
  await openInbox(page);
  await openChat(page, "Una Free");
  const header = page.locator("header").filter({ has: page.getByRole("heading", { level: 2, name: /Una Free/ }) });
  await header.getByRole("combobox", { name: "Conversation status" }).selectOption("blocked");
  // The All list leaves blocked chats out (they are under the Blocked tab); the open chat stays on screen, so it can be reopened.
  await expect(header.getByRole("combobox", { name: "Conversation status" })).toHaveValue("blocked");
  await expect(convoButton(page, "Una Free")).toHaveCount(0, { timeout: 15_000 });
  await header.getByRole("combobox", { name: "Conversation status" }).selectOption("open");
  await expect(convoButton(page, "Una Free").getByText("Open", { exact: true })).toBeVisible({ timeout: 15_000 });
  // Owners can block from the Details panel too, not only from the header.
  await expect(page.getByRole("complementary", { name: "Contact details" }).getByLabel("Status").locator('option[value="blocked"]')).toHaveCount(1);
});

test("tenant isolation: a second workspace cannot see or reach the first workspace's chats, by list, screen or direct URL", async ({ page, context, browser }) => {
  const errors = watchErrors(page);
  const other = await signupUser(context, "iso");
  await otherSession.save(context);
  await openInbox(page);
  await expect(page.getByText("No conversations yet")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("Tara Theirs");
  // the UI has no per-chat URL, so try the natural guesses and then the API
  for (const url of [`/app/inbox?conversation=${ids.theirs}`, `/app/inbox?c=${ids.theirs}`, `/app/inbox/${ids.theirs}`, `/app/inbox#${ids.theirs}`]) {
    await page.goto(url);
    await expect(page.locator("body")).not.toContainText(/Tara Theirs|Chat for the owner/);
  }
  for (const [method, path, data] of [
    ["GET", `/api/inbox/conversations/${ids.theirs}`, undefined],
    ["GET", `/api/inbox/conversations/${ids.theirs}/notes`, undefined],
    ["GET", `/api/inbox/conversations/${ids.theirs}/context`, undefined],
    ["POST", `/api/inbox/conversations/${ids.theirs}/read`, {}],
    ["POST", `/api/inbox/conversations/${ids.theirs}/messages`, { type: "text", body: "intruder" }],
    ["POST", `/api/inbox/conversations/${ids.theirs}/notes`, { body: "intruder" }],
    ["POST", `/api/inbox/conversations/${ids.theirs}/suggest`, {}],
    ["PATCH", `/api/inbox/conversations/${ids.theirs}/status`, { status: "solved" }],
    ["PUT", `/api/inbox/conversations/${ids.theirs}/assign`, { userId: other.userId }],
    ["PUT", `/api/inbox/conversations/${ids.theirs}/tags`, { tags: ["x"] }],
  ] as const) {
    const res = await page.request.fetch(path, { method, headers: { origin: ORIGIN }, data });
    expect([404, 403, 400, 503], `${method} ${path} -> ${res.status()}`).toContain(res.status());
    if (!(path.endsWith("/suggest") && res.status() === 503)) expect(res.status(), `${method} ${path} must not succeed for another workspace`).not.toBe(200);
    expect(await res.text()).not.toMatch(/Tara Theirs|Chat for the owner|intruder/);
  }
  const bulk = await post(page, `/api/inbox/conversations/bulk`, { ids: [ids.theirs, ids.mine], action: "status", status: "solved" });
  expect((await bulk.json()).updated).toBe(0);
  const list = await (await page.request.get(`/api/inbox/conversations?q=Tara`)).json();
  expect(list.items).toHaveLength(0);
  const qr = await (await page.request.get(`/api/quick-replies`)).json();
  expect(JSON.stringify(qr)).not.toMatch(/agentqr/);
  // nothing changed for the first workspace
  const d = await db();
  const row = (await d.query(`select status, "assignedToId", tags from "Conversation" where id = $1`, [ids.theirs])).rows[0];
  expect(row.status).toBe("open");
  expect(row.tags ?? []).toEqual([]);
  expect(Number((await d.query(`select count(*) from "Message" where "conversationId" = $1 and direction = 'outbound'`, [ids.theirs])).rows[0].count)).toBe(0);
  // a message sent to the first workspace's number does not show up for the second
  await tick(page.request, 1);
  expect(errors.filter((e) => !/40[34]|Failed to load resource/.test(e)), errors.join("\n")).toEqual([]);
  void browser;
});

test("signed-out visitors are sent to sign in and see no inbox data", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("/app/inbox");
  await expect(page).toHaveURL(/login/);
  await expect(page.getByLabel(/email/i)).toBeVisible();
  for (const path of ["/api/inbox/conversations", `/api/inbox/conversations/${ids.theirs}`, "/api/inbox/stream", `/api/inbox/media/${ids.theirs}`]) {
    const res = await page.request.get(path);
    expect(res.status(), path).toBe(401);
  }
  await ctx.close();
});

test("cross-site requests cannot change chats (origin check)", async ({ page, context }) => {
  await as(ownerSession, context);
  await page.goto("/app/inbox");
  const res = await page.request.fetch(`/api/inbox/conversations/${ids.theirs}/status`, { method: "PATCH", headers: { origin: "https://evil.example" }, data: { status: "solved" } });
  expect(res.status()).toBeGreaterThanOrEqual(400);
  const row = (await (await db()).query(`select status from "Conversation" where id = $1`, [ids.theirs])).rows[0];
  expect(row.status).toBe("open");
  void conversationIdFor;
  void agentName;
});
