import { expect, test, type Page } from "@playwright/test";
import { skipWelcome } from "./auth-onboarding-util";
import { closeDb, connectFakeNumber, db, signupUser, stamp, tick, watchErrors, type TestUser } from "./helpers";

/**
 * Eddy and the inbox end to end (docs/EDDY-SPEC.md 6.2, 6.7, 6.14, 9.4 scenarios 9, 11 and 15 to 17, EDDY-15).
 *
 * - 11: with an Eddy button focused, e, a, p, o and x never change the highlighted chat or the chat itself; an Eddy draft
 *   appears in the open chat's composer and nothing is sent; [Explain] on a failed bubble opens Eddy with the message id
 *   only (EDDY-15 acceptance 1 to 5).
 * - 9: a seeded Phase 0 quality breaker shows the notice with the broadcasts its safety stop paused; Resume is a link in v1.
 * - 15 to 17: the demo workspace's refusal row, a workspace with no number (team members see the admins' names, admins get
 *   [Connect WhatsApp]), and a tag whose enabled rule sends a template: the v1 refusal, and no automation run.
 *
 * GET /api/eddy/status is stubbed to `ready` and, for 15 to 17, POST /api/eddy/turn answers with the events the action
 * layer sends for those refusals (tests/eddy-workspace-states.test.ts and tests/actions-automation-effects.test.ts cover
 * the server side). The inbox, the notices and the database are real.
 */

test.afterAll(closeDb);

type Ev = Record<string, unknown> & { type: string };
const sse = (events: Ev[]) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");

const statusDTO = (over: Record<string, unknown> = {}) => ({
  state: "ready",
  readOnly: false,
  canEnable: true,
  ownerNames: ["Shop Owner"],
  allowance: { usedToday: 0, limitToday: 40, usedMonth: 10, limitMonth: 500, resetsOn: "2026-11-01", memberUsedToday: 0, memberLimitToday: 40 },
  langPref: "auto",
  needsYou: 0,
  demo: false,
  whatsapp: "connected",
  phase: 1,
  firstUse: false,
  spendingStopped: false,
  ...over,
});

async function mockStatus(page: Page, over: Record<string, unknown> = {}) {
  await page.route("**/api/eddy/status", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(statusDTO(over)) }));
}

async function mockTurn(page: Page, reply: (body: { text: string; ref?: unknown }) => Ev[], seen?: { text: string; ref?: unknown }[]) {
  await page.route("**/api/eddy/turn", async (route) => {
    const body = route.request().postDataJSON() as { text: string; ref?: unknown };
    seen?.push(body);
    await route.fulfill({ status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-store, no-transform" }, body: sse(reply(body)) });
  });
}

const launcher = (page: Page) => page.getByRole("banner").getByRole("button", { name: /^Ask Eddy/ });
const panelOf = (page: Page) => page.getByRole("complementary", { name: "Eddy" });

async function openPanel(page: Page) {
  if (!(await panelOf(page).isVisible())) await launcher(page).click();
  await expect(panelOf(page)).toBeVisible();
  return panelOf(page);
}

async function owner(context: Parameters<typeof signupUser>[0], label = "inboxeddy"): Promise<TestUser> {
  const u = await signupUser(context, label);
  await skipWelcome(context, u.userId);
  return u;
}

/** A chat inside the 24-hour window with one inbound message, inserted directly. */
async function chat(tenantId: string, pnRef: string, name: string, body: string) {
  const d = await db();
  const ct = `ct_${stamp()}`;
  const cv = `cv_${stamp()}`;
  await d.query(`insert into "Contact" (id, "tenantId", phone, name, tags, "optIn") values ($1,$2,$3,$4,'{}',true)`, [ct, tenantId, `+9197${String(Date.now()).slice(-8)}`, name]);
  await d.query(`insert into "Conversation" (id, "tenantId", "phoneNumberId", "contactId", status, "lastInboundAt", "lastMessageAt") values ($1,$2,$3,$4,'open',now(),now())`, [cv, tenantId, pnRef, ct]);
  await d.query(`insert into "Message" (id, "tenantId", "conversationId", direction, type, body, status) values ($1,$2,$3,'inbound','text',$4,'received')`, [`m_${stamp()}`, tenantId, cv, body]);
  return { contactId: ct, conversationId: cv };
}

const chatRow = (page: Page, id: string) => page.locator(`[data-conversation="${id}"]`);
const highlighted = (page: Page) => page.locator("li.ring-2 [data-conversation]");

async function chatState(id: string) {
  const d = await db();
  const r = await d.query(`select status, "assignedToId" from "Conversation" where id = $1`, [id]);
  return r.rows[0] as { status: string; assignedToId: string | null };
}

async function outboundCount(tenantId: string) {
  const d = await db();
  return Number((await d.query(`select count(*)::int as n from "Message" where "tenantId" = $1 and direction = 'outbound'`, [tenantId])).rows[0].n);
}

test.describe("scenario 11: keys typed in Eddy never reach the inbox list; drafts never send", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  test("with an Eddy button focused, e, a, p, o and x leave the highlighted chat and the chat itself as they were", async ({ page, context }) => {
    const errors = watchErrors(page);
    const u = await owner(context);
    const fx = await connectFakeNumber(u.tenantId);
    const first = await chat(u.tenantId, fx.pnRef, "Asha Customer", "Is the shop open?");
    const second = await chat(u.tenantId, fx.pnRef, "Bharat Customer", "Price of rice?");
    await mockStatus(page);
    await page.goto("/app/inbox");
    await expect(chatRow(page, first.conversationId)).toBeVisible();
    await expect(chatRow(page, second.conversationId)).toBeVisible();
    // Move the list cursor with the keyboard, as a member would.
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("j");
    const before = await highlighted(page).getAttribute("data-conversation");
    expect(before).toBeTruthy();
    const stateBefore = await chatState(before!);

    const panel = await openPanel(page);
    const button = panel.getByRole("button", { name: "Close Eddy" });
    await button.focus();
    for (const key of ["e", "a", "p", "o", "x", "j", "k"]) await page.keyboard.press(key);
    await expect(panel).toBeVisible();
    expect(await highlighted(page).getAttribute("data-conversation")).toBe(before);
    expect(await chatState(before!)).toEqual(stateBefore);
    await expect(page.getByRole("checkbox", { checked: true })).toHaveCount(0);
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("an Eddy draft goes into the open chat's composer only, and nothing is sent; the template picker opens on request", async ({ page, context }) => {
    const u = await owner(context);
    const fx = await connectFakeNumber(u.tenantId);
    const open = await chat(u.tenantId, fx.pnRef, "Chitra Customer", "When will my order come?");
    const other = await chat(u.tenantId, fx.pnRef, "Deepak Customer", "Hello");
    await mockStatus(page);
    await page.goto(`/app/inbox?c=${open.conversationId}`);
    const composer = page.getByRole("textbox", { name: "Message" });
    await expect(composer).toBeVisible();
    const sentBefore = await outboundCount(u.tenantId);

    // A draft for another chat is ignored; a draft for this one fills the box.
    await page.evaluate((id) => window.dispatchEvent(new CustomEvent("wa:eddy-draft", { detail: { conversationId: id, text: "Not for this chat" } })), other.conversationId);
    await expect(composer).toHaveValue("");
    await page.evaluate((id) => window.dispatchEvent(new CustomEvent("wa:eddy-draft", { detail: { conversationId: id, text: "Your order reaches tomorrow." } })), open.conversationId);
    await expect(composer).toHaveValue("Your order reaches tomorrow.");
    await page.waitForTimeout(1_000);
    expect(await outboundCount(u.tenantId)).toBe(sentBefore);

    await page.evaluate((id) => window.dispatchEvent(new CustomEvent("wa:eddy-open-templates", { detail: { conversationId: id } })), open.conversationId);
    await expect(page.getByRole("button", { name: /Template/ }).first()).toHaveAttribute("aria-expanded", "true");
    expect(await outboundCount(u.tenantId)).toBe(sentBefore);
  });

  test("[Explain] on a failed bubble opens Eddy with the message id only", async ({ page, context }) => {
    const u = await owner(context);
    const fx = await connectFakeNumber(u.tenantId);
    const c = await chat(u.tenantId, fx.pnRef, "Esha Customer", "Please send the bill");
    const d = await db();
    const failedId = `msg_${stamp()}`;
    await d.query(`insert into "Message" (id, "tenantId", "conversationId", direction, type, body, status, "errorCode") values ($1,$2,$3,'outbound','text','Your bill is attached','failed','131047')`, [failedId, u.tenantId, c.conversationId]);
    await mockStatus(page);
    const seen: { text: string; ref?: unknown }[] = [];
    await mockTurn(page, () => [{ type: "turn", turnId: "t1", conversationId: "ec1", lang: "en" }, { type: "message", text: "It didn't go because the 24-hour chat window had closed.", lang: "en" }, { type: "end", credits: 1 }], seen);
    await page.goto(`/app/inbox?c=${c.conversationId}`);
    await page.getByRole("button", { name: "Explain why this message failed" }).click();
    await expect(panelOf(page)).toBeVisible();
    await expect.poll(() => seen.length).toBeGreaterThan(0);
    expect(seen[0].ref).toEqual({ kind: "message", messageId: failedId });
    expect(seen[0].text).not.toContain("bill");
    await expect(panelOf(page)).toContainText("the 24-hour chat window had closed");
  });

  test("wa:eddy-did refetches the open chat and the list", async ({ page, context }) => {
    const u = await owner(context);
    const fx = await connectFakeNumber(u.tenantId);
    const c = await chat(u.tenantId, fx.pnRef, "Farhan Customer", "Hi");
    await mockStatus(page);
    await page.goto(`/app/inbox?c=${c.conversationId}`);
    await expect(chatRow(page, c.conversationId)).toBeVisible();
    const d = await db();
    // Eddy changed the chat (as set_conversation_status does); the page learns it from wa:eddy-did, not from a poll.
    await d.query(`update "Conversation" set status = 'pending' where id = $1`, [c.conversationId]);
    await page.evaluate((id) => window.dispatchEvent(new CustomEvent("wa:eddy-did", { detail: { entity: "conversation", ids: [id] } })), c.conversationId);
    await expect(chatRow(page, c.conversationId)).toContainText("Pending");
  });
});

/**
 * Makes the next tick's notice scan start at this workspace. The scan runs every 120 s over the next 100 workspaces in
 * rotation (src/lib/notices/scan.ts), so in a test database with many workspaces a new one can wait several runs.
 */
async function scanWorkspaceNext(tenantId: string) {
  const d = await db();
  const before = ((await d.query(`select max(id) as id from "Tenant" where id < $1`, [tenantId])).rows[0]?.id as string | null) ?? "";
  await d.query(`insert into "NoticeScanState" ("tenantId", scanner, cursor, "updatedAt") values ('*', 'rotation', $1, now()) on conflict ("tenantId", scanner) do update set cursor = excluded.cursor, "updatedAt" = now()`, [JSON.stringify({ after: before })]);
  await d.query(`update "PlatformSetting" set "updatedAt" = now() - interval '1 hour' where key = 'periodic:notices.scan'`);
}

test.describe("scenario 9: a quality safety stop, as a notice", () => {
  test("the notice names the paused broadcasts; Resume is a link to the broadcast page in v1", async ({ page, context, request }) => {
    test.skip(!process.env.WORKER_SECRET, "The notice scan runs on the worker tick, which needs WORKER_SECRET.");
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1280, height: 800 });
    const u = await owner(context, "quality");
    const fx = await connectFakeNumber(u.tenantId);
    const d = await db();
    const tpl = `tpl_${stamp()}`;
    await d.query(`insert into "Template" (id, "tenantId", "wabaRefId", name, language, category, status, components, "updatedAt") values ($1,$2,$3,$4,'en','MARKETING','approved',$5,now())`, [tpl, u.tenantId, fx.wabaRef, `festive_${stamp()}`, JSON.stringify([{ type: "BODY", text: "Festive offer" }])]);
    const b = `bc_${stamp()}`;
    await d.query(`insert into "Broadcast" (id, "tenantId", "phoneNumberId", "templateId", name, status, "segmentTags") values ($1,$2,$3,$4,'Festive offer','paused','{}')`, [b, u.tenantId, fx.pnRef, tpl]);
    await d.query(`insert into "PlatformSetting" (key, value, "updatedAt") values ($1,$2,now()) on conflict (key) do update set value = excluded.value`, [`broadcast.pause_reason.${b}`, JSON.stringify({ reason: "number_quality", at: new Date().toISOString() })]);
    await d.query(`insert into "SpendBreaker" (id, "tenantId", kind, "scopeType", "scopeId", state, effect, reason) values ($1,$2,'wa_quality_red','phone',$3,'tripped','block_automated','Quality dropped to Low')`, [`br_${stamp()}`, u.tenantId, fx.pnRef]);
    await mockStatus(page);
    await page.goto("/app");
    const panel = await openPanel(page);
    await expect
      .poll(async () => {
        await scanWorkspaceNext(u.tenantId);
        await tick(request, 1);
        // Browsers fire visibilitychange at the document, where the notices poller listens (one sent to window never reaches it).
        await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
        return panel.locator("[data-eddy-notices]").count();
      }, { timeout: 60_000 })
      .toBeGreaterThan(0);
    await expect(panel).toContainText(/dropped to Low quality/);
    await expect(panel).toContainText("Festive offer");
    await expect(panel.getByRole("link", { name: /Review/ }).first()).toHaveAttribute("href", "/app/broadcasts");
    await expect(panel.getByRole("button", { name: /Resume/ })).toHaveCount(0);
  });
});

test.describe("scenarios 15 to 17: workspace states as Eddy shows them", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  test("15: in the demo workspace a send is refused with the demo line, and the chat is unchanged", async ({ page, context }) => {
    const u = await owner(context, "demo");
    const fx = await connectFakeNumber(u.tenantId);
    const c = await chat(u.tenantId, fx.pnRef, "Sample Customer", "Hello");
    await mockStatus(page, { demo: true });
    await mockTurn(page, () => [
      { type: "turn", turnId: "t1", conversationId: "ec1", lang: "en" },
      { type: "refused_action", action: "send_text_reply", code: "demo" },
      { type: "message", text: "Here are your sample chats. **Sample data**", lang: "en" },
      { type: "end", credits: 1 },
    ]);
    const sentBefore = await outboundCount(u.tenantId);
    await page.goto(`/app/inbox?c=${c.conversationId}`);
    const panel = await openPanel(page);
    const box = panel.getByRole("textbox", { name: "Message to Eddy" });
    await box.fill("Reply to this customer that we are open today");
    await box.press("Enter");
    await expect(panel).toContainText("This is a demo workspace, so nothing is sent to Meta or to customers.");
    expect(await outboundCount(u.tenantId)).toBe(sentBefore);
  });

  test("16: with no number, a team member sees the admins' names; an admin gets [Connect WhatsApp], which opens the connect page", async ({ page, context }) => {
    await owner(context, "nonumber");
    await mockStatus(page, { whatsapp: "none" });
    await mockTurn(page, (body) =>
      body.text.includes("agent")
        ? [{ type: "turn", turnId: "t1", conversationId: "ec1", lang: "en" }, { type: "refused_action", action: "send_text_reply", code: "not_connected", who: ["Asha Admin", "Ravi Owner"] }, { type: "end", credits: 1 }]
        : [{ type: "turn", turnId: "t2", conversationId: "ec1", lang: "en" }, { type: "intent", kind: "connect_whatsapp", payload: {} }, { type: "end", credits: 1 }],
    );
    await page.goto("/app");
    const panel = await openPanel(page);
    const box = panel.getByRole("textbox", { name: "Message to Eddy" });
    await box.fill("agent: send a reply");
    await box.press("Enter");
    await expect(panel).toContainText("Asha Admin, Ravi Owner");
    await box.fill("send a reply");
    await box.press("Enter");
    await panel.getByRole("link", { name: "Connect WhatsApp" }).click();
    await expect(page).toHaveURL(/\/app\/settings\/connect\?from=eddy$/);
  });

  test("17: a tag whose enabled rule sends a template is refused in v1, and no automation run is created", async ({ page, context }) => {
    const u = await owner(context, "paidrule");
    const fx = await connectFakeNumber(u.tenantId);
    const c = await chat(u.tenantId, fx.pnRef, "Gita Customer", "Hi");
    await mockStatus(page);
    await mockTurn(page, () => [
      { type: "turn", turnId: "t1", conversationId: "ec1", lang: "en" },
      { type: "refused_action", action: "tag_contacts", code: "triggers_paid_rule" },
      { type: "end", credits: 1 },
    ]);
    const d = await db();
    const runs = async () => Number((await d.query(`select count(*)::int as n from "AutomationRun" where "tenantId" = $1`, [u.tenantId]).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n);
    const before = await runs();
    await page.goto(`/app/inbox?c=${c.conversationId}`);
    const panel = await openPanel(page);
    const box = panel.getByRole("textbox", { name: "Message to Eddy" });
    await box.fill("Tag this customer diwali-vip");
    await box.press("Enter");
    await expect(panel).toContainText("This would start an automation that sends a paid template, and Eddy doesn't start paid messages yet.");
    const tags = (await d.query(`select tags from "Contact" where id = $1`, [c.contactId])).rows[0].tags as string[];
    expect(tags).not.toContain("diwali-vip");
    expect(await runs()).toBe(before);
  });
});
