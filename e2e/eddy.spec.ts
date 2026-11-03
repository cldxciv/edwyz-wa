import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { axeSerious, joinWorkspace, noHorizontalOverflow, skipWelcome } from "./auth-onboarding-util";
import { closeDb, connectFakeNumber, db, login, ORIGIN, signupUser, watchErrors, type TestUser } from "./helpers";

/**
 * Eddy end to end on desktop (docs/EDDY-SPEC.md 9.4 scenarios 1 to 8, 12 to 14 and 19; EDDY-13, EDDY-14).
 *
 * Two kinds of test live here:
 * - Panel tests stub only Eddy's own endpoints with page.route (the status call, and the turn stream where the server
 *   side is not what is being tested), so the panel's states, streaming render, languages, palette hand-off, session
 *   expiry and layout are checked against any server.
 * - Live tests ("live, scripted model") run the real loop and action layer. They need the server started with
 *   EDDY_ENABLED=true, an AI key configured, and EDDY_FAKE_MODEL=scripted (never in production); the scripted replies are
 *   e2e/fixtures/eddy/panel-e2e.json, matched by the "e2e-eddy ..." text each test sends. Without that the live tests skip
 *   with the reason, instead of failing on a server that is not set up for them.
 */

test.afterAll(closeDb);

const LEGAL_VERSION = /version:\s*"([^"]+)"/.exec(readFileSync(path.resolve(__dirname, "../src/lib/legal.ts"), "utf8"))![1];

type Status = Record<string, unknown>;
function statusDTO(over: Status = {}): Status {
  return {
    state: "ready",
    readOnly: false,
    canEnable: true,
    ownerNames: ["Owner Person"],
    allowance: { usedToday: 0, limitToday: 40, usedMonth: 10, limitMonth: 500, resetsOn: "2026-11-01", memberUsedToday: 0, memberLimitToday: 40 },
    langPref: "auto",
    needsYou: 0,
    demo: false,
    whatsapp: "connected",
    phase: 1,
    firstUse: false,
    spendingStopped: false,
    ...over,
  };
}

/** Answers GET /api/eddy/status with a DTO (a function is asked on every call, so a test can change it). */
async function mockStatus(page: Page, dto: Status | (() => Status)) {
  await page.route("**/api/eddy/status", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(typeof dto === "function" ? dto() : dto) }));
}

type Ev = Record<string, unknown> & { type: string };
const sse = (events: Ev[]) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");

/** Answers POST /api/eddy/turn with an SSE body; `reply` sees the request body. */
async function mockTurn(page: Page, reply: (body: { text: string; page: unknown; ref?: unknown }) => Ev[]) {
  await page.route("**/api/eddy/turn", async (route) => {
    const body = route.request().postDataJSON() as { text: string; page: unknown };
    await route.fulfill({ status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-store, no-transform" }, body: sse(reply(body)) });
  });
}

async function owner(page: Page, context: BrowserContext, label = "eddy"): Promise<TestUser> {
  const u = await signupUser(context, label);
  await skipWelcome(context, u.userId);
  return u;
}

const launcher = (page: Page) => page.getByRole("banner").getByRole("button", { name: /^Ask Eddy/ });
const panelOf = (page: Page) => page.getByRole("complementary", { name: "Eddy" });

async function openPanel(page: Page) {
  await launcher(page).click();
  const panel = panelOf(page);
  await expect(panel).toBeVisible();
  return panel;
}

// =====================================================================================================================
// Panel tests (Eddy's endpoints stubbed)
// =====================================================================================================================

test.describe("Eddy panel states", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  test("1: with no key, the honest platform_off state, the setup list, Go to buttons and no input box", async ({ page, context }) => {
    const errors = watchErrors(page);
    await owner(page, context);
    await mockStatus(page, statusDTO({ state: "platform_off", reason: "not_configured", canEnable: true }));
    await page.goto("/app");
    const panel = await openPanel(page);
    await expect(panel).toContainText("Eddy is not switched on yet. The Edwyz team is still setting it up.");
    await expect(panel.getByRole("heading", { name: "Your setup list" })).toBeVisible();
    await expect(panel.getByRole("link", { name: "Go to Inbox" })).toBeVisible();
    await expect(panel.getByRole("textbox")).toHaveCount(0);
    await expect(panel).toContainText("Not switched on");
    // The kill switch says paused, never "still setting it up".
    await page.unroute("**/api/eddy/status");
    await mockStatus(page, statusDTO({ state: "platform_off", reason: "paused" }));
    await page.reload();
    // The panel was open, so it comes back by itself (6.2: remembered per tab); a launcher click now would close it.
    const again = panelOf(page);
    await expect(again).toBeVisible();
    await expect(again).toContainText("Eddy is paused by the Edwyz team for now.");
    await expect(again).not.toContainText("still setting it up");
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("3: a Hinglish look-up renders styled and carries lang hi-Latn; a Devanagari reply carries lang hi", async ({ page, context }) => {
    await owner(page, context);
    await mockStatus(page, statusDTO());
    await mockTurn(page, (body) =>
      /[ऀ-ॿ]/.test(body.text)
        ? [
            { type: "turn", turnId: "t2", conversationId: "c1", lang: "hi" },
            { type: "delta", text: "आपके " },
            { type: "message", text: "आपके **तीन टेम्पलेट** अप्रूव हैं।", lang: "hi" },
            { type: "end", credits: 1 },
          ]
        : [
            { type: "turn", turnId: "t1", conversationId: "c1", lang: "hinglish" },
            { type: "status", key: "status.list_templates" },
            { type: "delta", text: "Aapke " },
            { type: "delta", text: "3 templates" },
            { type: "message", text: "Aapke **3 templates** approved hain:\n\n- order_update\n- diwali_offer", lang: "hinglish" },
            { type: "end", credits: 2 },
          ],
    );
    await page.goto("/app/templates");
    const panel = await openPanel(page);
    const box = panel.getByRole("textbox", { name: "Message to Eddy" });
    await box.fill("Mere templates dikhaiye");
    await box.press("Enter");
    const hinglish = panel.locator('[data-eddy-item="eddy"] [lang="hi-Latn"]').last();
    await expect(hinglish).toContainText("Aapke 3 templates approved hain");
    await expect(hinglish.locator("strong")).toHaveText("3 templates");
    await expect(hinglish.locator("li")).toHaveCount(2);
    // The announcement is in the reply's language (a11y.eddy_replied in the catalogue; 5.7: the chrome follows the turn).
    await expect(panel.locator("[data-eddy-announce]")).toContainText("Eddy ka jawab: Aapke 3 templates approved hain");
    // The composer is chrome too, so its label is now in Hinglish (panel.composer.label).
    await expect(box).toHaveCount(0);
    const hinglishBox = panel.getByRole("textbox", { name: "Eddy ke liye message" });
    await hinglishBox.fill("मेरे टेम्पलेट दिखाइए");
    await hinglishBox.press("Enter");
    await expect(panel.locator('[data-eddy-item="eddy"] [lang="hi"]').last()).toContainText("आपके तीन टेम्पलेट अप्रूव हैं।");
    await expect(panel.locator('[data-eddy-item="member"] [lang="hi"]').last()).toContainText("मेरे टेम्पलेट दिखाइए");
  });

  test("12: a session that expires mid-turn keeps the draft, and after signing in the transcript shows the interrupted reply", async ({ page, context }) => {
    const u = await owner(page, context);
    await mockStatus(page, statusDTO());
    await page.route("**/api/eddy/turn", (route) => route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "Sign in again." }) }));
    await page.route("**/api/eddy/conversations", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ conversations: [{ id: "conv_e2e", status: "active", active: true, language: "en", lastMessageAt: new Date().toISOString() }], historyDays: 90 }) }));
    await page.route("**/api/eddy/conversations/conv_e2e", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          conversation: { id: "conv_e2e", language: "en", status: "active" },
          messages: [
            { id: "m1", seq: 0, role: "user", kind: "user_text", display: { text: "Which templates were rejected?", lang: "en" } },
            { id: "m2", seq: 3, role: "assistant", kind: "placeholder", display: { interrupted: true } },
          ],
        }),
      }),
    );
    await page.goto("/app");
    const panel = await openPanel(page);
    const box = panel.getByRole("textbox", { name: "Message to Eddy" });
    await box.fill("Tag everyone from Pune as vip");
    await box.press("Enter");
    await page.waitForURL(/\/login/);
    await login(page, u.email);
    // After sign-in Eddy opens again with the unsent text back in the box, and the stored transcript.
    const back = panelOf(page);
    await expect(back).toBeVisible();
    await expect(back.getByRole("textbox", { name: "Message to Eddy" })).toHaveValue("Tag everyone from Pune as vip");
    await expect(back).toContainText("Your unsent message is back in the box.");
    await expect(back).toContainText("Which templates were rejected?");
    await expect(back).toContainText("This reply was interrupted.");
  });

  test("13: the palette's no-results row, Ask Eddy: \"q\", opens Eddy and sends q", async ({ page, context }) => {
    await owner(page, context);
    await mockStatus(page, statusDTO());
    const sent: string[] = [];
    await mockTurn(page, (body) => {
      sent.push(body.text);
      return [
        { type: "turn", turnId: "t1", conversationId: "c1", lang: "en" },
        { type: "message", text: "You asked: **how much is left this month**.", lang: "en" },
        { type: "end", credits: 1 },
      ];
    });
    await page.goto("/app");
    await page.getByRole("heading", { level: 1 }).click();
    await page.keyboard.press("Control+k");
    const dlg = page.getByRole("dialog", { name: "Command palette" });
    await dlg.getByRole("combobox").fill("how much is left this month");
    await expect(dlg.getByText(/Nothing matches/)).toBeVisible();
    await expect(dlg.getByRole("option", { name: 'Ask Eddy: "how much is left this month"' })).toBeVisible();
    await page.keyboard.press("Enter");
    const panel = panelOf(page);
    await expect(panel).toBeVisible();
    await expect(panel.locator('[data-eddy-item="member"]')).toContainText("how much is left this month");
    await expect(panel).toContainText("You asked: how much is left this month.");
    expect(sent).toEqual(["how much is left this month"]);
  });

  test("14: on /app/inbox at 1280 px, opening Eddy leaves the chat column's width unchanged (overlay below 2xl)", async ({ page, context }) => {
    await owner(page, context);
    await mockStatus(page, statusDTO());
    await page.goto("/app/inbox");
    const column = page.getByText("Pick a conversation").locator("xpath=../..");
    await expect(column).toBeVisible();
    const before = (await column.boundingBox())!;
    const mainBefore = (await page.locator("main").boundingBox())!;
    const panel = await openPanel(page);
    const after = (await column.boundingBox())!;
    expect(after.width).toBe(before.width);
    expect((await page.locator("main").boundingBox())!.width).toBe(mainBefore.width);
    const p = (await panel.boundingBox())!;
    expect(p.width).toBe(384);
    await noHorizontalOverflow(page, "inbox with Eddy open at 1280");
    // The palette stays above the panel.
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
    await page.keyboard.press("Escape");
  });

  test("19: the first open by a member shows the first-use notice; Got it hides it for good", async ({ page, context }) => {
    const u = await owner(page, context);
    let acked = false;
    await mockStatus(page, () => statusDTO({ firstUse: !acked }));
    page.on("request", (r) => {
      if (r.url().endsWith("/api/eddy/prefs") && r.method() === "PUT" && (r.postDataJSON() as { firstUseAck?: boolean })?.firstUseAck === true) acked = true;
    });
    await page.goto("/app");
    const panel = await openPanel(page);
    const notice = panel.locator("[data-eddy-first-use]");
    await expect(notice).toContainText("is sent to Anthropic to write the replies");
    await expect(notice).toContainText("kept for 90 days");
    const put = page.waitForResponse((r) => r.url().endsWith("/api/eddy/prefs") && r.request().method() === "PUT");
    await notice.getByRole("button", { name: "Got it" }).click();
    await expect(notice).toBeHidden();
    const res = await put;
    // The real route records firstUseAckAt and firstUseVersion = LEGAL.version.
    if (res.ok()) {
      const row = (await (await db()).query(`select "firstUseAckAt", "firstUseVersion" from "EddyUserPref" where "userId" = $1`, [u.userId])).rows[0];
      expect(row?.firstUseAckAt).toBeTruthy();
      expect(row?.firstUseVersion).toBe(LEGAL_VERSION);
    }
    await page.reload();
    // The panel was open, so it comes back by itself (6.2), now without the notice.
    const again = panelOf(page);
    await expect(again).toBeVisible();
    await expect(again.locator("[data-eddy-first-use]")).toHaveCount(0);
  });

  test("axe and dark theme with Eddy open, cards and replies on screen", async ({ page, context }) => {
    await owner(page, context);
    await mockStatus(page, statusDTO());
    await mockTurn(page, () => [
      { type: "turn", turnId: "t1", conversationId: "c1", lang: "en" },
      { type: "message", text: "Here is what needs you:\n\n| Item | Count |\n|---|---|\n| Unread chats | 3 |", lang: "en" },
      { type: "done_action", actionId: "ar_x", summaryKey: "done.tag_contacts", vars: {}, undoUntil: new Date(Date.now() + 10 * 60_000).toISOString() },
      { type: "end", credits: 1 },
    ]);
    await page.goto("/app");
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    const panel = await openPanel(page);
    await panel.getByRole("button", { name: "What needs my attention?" }).click();
    await expect(panel.getByRole("table")).toBeVisible();
    await expect(panel.getByRole("button", { name: /^Undo/ })).toBeVisible();
    const found = await axeSerious(page, "Eddy open in dark");
    expect(found, found.join("\n")).toEqual([]);
  });
});

// =====================================================================================================================
// 2: only the owner switches Eddy on, with one tap that records consent (12.1a decision 6)
// =====================================================================================================================

test.describe("2: switching Eddy on", () => {
  test("the owner's one tap records consent bound to LEGAL.version; admins and team members see the owner's name", async ({ page, context, browser }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1280, height: 800 });
    const u = await owner(page, context);
    let enabled = false;
    await mockStatus(page, () => statusDTO(enabled ? { state: "ready" } : { state: "workspace_off", canEnable: true }));
    page.on("response", (r) => {
      if (r.url().endsWith("/api/eddy/settings") && r.request().method() === "PUT" && r.ok()) enabled = true;
    });
    await page.goto("/app");
    const panel = await openPanel(page);
    await expect(panel.getByRole("heading", { name: "Turn on Eddy" })).toBeVisible();
    await expect(panel).toContainText("is sent to Anthropic to write the replies");
    await expect(panel).toContainText("Chats with Eddy are kept for 90 days.");
    await expect(panel).toContainText("One message uses at most 30 credits");
    const put = page.waitForResponse((r) => r.url().endsWith("/api/eddy/settings") && r.request().method() === "PUT");
    await panel.getByRole("button", { name: "Turn on Eddy" }).click();
    expect((await put).status()).toBe(200);
    const row = (await (await db()).query(`select enabled, "enabledById", "consentVersion" from "EddyWorkspaceSetting" where "tenantId" = $1`, [u.tenantId])).rows[0];
    expect(row).toMatchObject({ enabled: true, enabledById: u.userId, consentVersion: LEGAL_VERSION });
    await expect(panel.getByRole("textbox", { name: "Message to Eddy" })).toBeVisible();

    // Settings > AI tools: the owner's switch.
    await page.goto("/app/settings/ai-tools");
    await expect(page.getByRole("switch", { name: "Eddy for this workspace" })).toHaveAttribute("aria-checked", "true");

    // An admin: no button, the owner's name; the API answers 403.
    for (const role of ["admin", "agent"] as const) {
      const { context: other } = await joinWorkspace(browser, u.tenantId, role, role);
      const op = await other.newPage();
      await op.setViewportSize({ width: 1280, height: 800 });
      await mockStatus(op, statusDTO({ state: "workspace_off", canEnable: false, ownerNames: [u.name] }));
      await op.goto("/app");
      const p = await openPanel(op);
      await expect(p).toContainText(`Only the owner can turn on Eddy. Ask the owner: ${u.name}.`);
      await expect(p.getByRole("button", { name: "Turn on Eddy" })).toHaveCount(0);
      const res = await other.request.put("/api/eddy/settings", { headers: { origin: ORIGIN }, data: { enabled: true } });
      expect(res.status(), role).toBe(403);
      await op.unroute("**/api/eddy/status");
      await op.goto("/app/settings/ai-tools");
      await expect(op.getByRole("switch", { name: "Eddy for this workspace" })).toHaveCount(0);
      await other.close();
    }
  });
});

// =====================================================================================================================
// Live tests: the real loop, action layer and card routes, with the scripted model
// =====================================================================================================================

/** Signs up an owner, switches Eddy on and acknowledges first use through the real API; skips if the server is not set up. */
async function liveOwner(page: Page, context: BrowserContext): Promise<TestUser> {
  const u = await owner(page, context, "eddylive");
  await context.request.put("/api/eddy/settings", { headers: { origin: ORIGIN }, data: { enabled: true } });
  await context.request.put("/api/eddy/prefs", { headers: { origin: ORIGIN }, data: { firstUseAck: true } });
  const status = (await (await context.request.get("/api/eddy/status")).json().catch(() => ({}))) as { state?: string };
  test.skip(status.state !== "ready", `Eddy is "${status.state ?? "unreachable"}" on this server. Start it with EDDY_ENABLED=true, an AI key and EDDY_FAKE_MODEL=scripted (docs/EDDY-SPEC.md 9.4).`);
  return u;
}

const CT_TAG = "e2e_eddy_ct_tag";
const CT_SEND = "e2e_eddy_ct_send";
const CV_SEND = "e2e_eddy_cv_send";

/** A contact with a fixed id (the scripted replies name it), re-created for each run. */
async function seedContact(tenantId: string, id: string, name: string, phone: string) {
  const d = await db();
  await d.query(`delete from "Contact" where id = $1`, [id]);
  await d.query(`insert into "Contact" (id, "tenantId", phone, name, tags, "optIn") values ($1,$2,$3,$4,'{}',true)`, [id, tenantId, phone, name]);
}

/** A chat with a fixed id, inside the 24-hour window, with one inbound message. */
async function seedChat(tenantId: string) {
  const fx = await connectFakeNumber(tenantId);
  await seedContact(tenantId, CT_SEND, "Ramesh K", `91999${Date.now() % 10_000_000}`);
  const d = await db();
  await d.query(`insert into "Conversation" (id, "tenantId", "phoneNumberId", "contactId", status, "lastInboundAt", "lastMessageAt") values ($1,$2,$3,$4,'open',now(),now())`, [CV_SEND, tenantId, fx.pnRef, CT_SEND]);
  await d.query(`insert into "Message" (id, "tenantId", "conversationId", direction, type, body, status) values ($1,$2,$3,'inbound','text','When does my order ship?','received')`, [`m_${CV_SEND}`, tenantId, CV_SEND]);
  return fx;
}

test.describe("Eddy live (scripted model)", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  test("3 (live): a Hinglish look-up streams and finalises with lang hi-Latn", async ({ page, context }) => {
    await liveOwner(page, context);
    await page.goto("/app/templates");
    const panel = await openPanel(page);
    const box = panel.getByRole("textbox", { name: "Message to Eddy" });
    await box.fill("e2e-eddy hinglish: mere templates dikhaiye");
    await box.press("Enter");
    await expect(panel.locator('[data-eddy-item="eddy"] [lang="hi-Latn"]').last()).toContainText("Aapke 3 templates approved hain");
    await expect(panel.locator("[data-eddy-announce]")).toContainText("Eddy ka jawab:");
  });

  test("4: tag, then Undo, then the Undone. row", async ({ page, context }) => {
    const u = await liveOwner(page, context);
    await seedContact(u.tenantId, CT_TAG, "Tag Target", `91888${Date.now() % 10_000_000}`);
    await page.goto("/app/contacts");
    const panel = await openPanel(page);
    const box = panel.getByRole("textbox", { name: "Message to Eddy" });
    await box.fill("e2e-eddy tag vip on the new contact");
    await box.press("Enter");
    const row = panel.locator("[data-eddy-result]").last();
    await expect(row).toBeVisible();
    expect((await (await db()).query(`select tags from "Contact" where id = $1`, [CT_TAG])).rows[0].tags).toContain("vip");
    await row.getByRole("button", { name: /^Undo/ }).click();
    await expect(row).toContainText("Undone.");
    await expect.poll(async () => (await (await db()).query(`select tags from "Contact" where id = $1`, [CT_TAG])).rows[0].tags).not.toContain("vip");
  });

  test("5 and 6: the send_text_reply card; Edit, then Confirm sends it to the inbox thread; Cancel sends nothing", async ({ page, context }) => {
    test.setTimeout(120_000);
    const u = await liveOwner(page, context);
    await seedChat(u.tenantId);
    await page.goto(`/app/inbox?c=${CV_SEND}`);
    const panel = await openPanel(page);
    const box = panel.getByRole("textbox", { name: "Message to Eddy" });

    // Cancel first: nothing is sent.
    await box.fill("e2e-eddy send reply to Ramesh");
    await box.press("Enter");
    let card = panel.locator("[data-eddy-card]").last();
    await expect(card).toContainText("Your order ships tomorrow.");
    await card.getByRole("button", { name: /^Cancel/ }).click();
    await expect(card).toContainText("Cancelled. Nothing was sent.");

    // Then Edit and Confirm.
    await box.fill("e2e-eddy send reply to Ramesh");
    await box.press("Enter");
    card = panel.locator("[data-eddy-card]").last();
    await expect(card).toContainText("Your order ships tomorrow.");
    await card.getByRole("button", { name: "Edit" }).click();
    const edit = card.getByRole("textbox").first();
    await edit.fill("Your order ships tomorrow by noon.");
    await card.getByRole("button", { name: "Save" }).click();
    card = panel.locator("[data-eddy-card]").last();
    await expect(card).toContainText("Your order ships tomorrow by noon.");
    await page.waitForTimeout(700); // the 600 ms tap guard
    await card.getByRole("button", { name: "Send reply" }).click();
    await expect(card.locator("[data-eddy-card-status]")).not.toBeEmpty();
    await expect(page.locator("main")).toContainText("Your order ships tomorrow by noon.", { timeout: 20_000 });
    const sent = await (await db()).query(`select body, origin from "Message" where "conversationId" = $1 and direction = 'outbound'`, [CV_SEND]);
    expect(sent.rows.map((r) => r.body)).toEqual(["Your order ships tomorrow by noon."]);
  });

  test("7: an expired card offers Refresh preview, which makes a new card with no AI", async ({ page, context }) => {
    const u = await liveOwner(page, context);
    await seedChat(u.tenantId);
    await page.clock.install();
    await page.goto(`/app/inbox?c=${CV_SEND}`);
    const panel = await openPanel(page);
    const box = panel.getByRole("textbox", { name: "Message to Eddy" });
    await box.fill("e2e-eddy send reply to Ramesh");
    await box.press("Enter");
    const card = panel.locator("[data-eddy-card]").last();
    await expect(card).toContainText("Your order ships tomorrow.");
    await (await db()).query(`update "ActionRecord" set "expiresAt" = now() - interval '1 minute' where "tenantId" = $1 and action = 'send_text_reply' and status = 'pending'`, [u.tenantId]);
    await page.clock.fastForward("16:00");
    await expect(card).toContainText("This preview expired.");
    await card.getByRole("button", { name: "Refresh preview" }).click();
    await expect(panel.locator("[data-eddy-card]").last().getByRole("button", { name: "Send reply" })).toBeVisible();
  });

  test("8: a team member asking to delete a template gets the permission reply and no card", async ({ page, context, browser }) => {
    const u = await liveOwner(page, context);
    const { context: actx } = await joinWorkspace(browser, u.tenantId, "agent", "agent");
    await actx.request.put("/api/eddy/prefs", { headers: { origin: ORIGIN }, data: { firstUseAck: true } });
    const ap = await actx.newPage();
    await ap.setViewportSize({ width: 1280, height: 800 });
    await ap.goto("/app/templates");
    const panel = await openPanel(ap);
    const box = panel.getByRole("textbox", { name: "Message to Eddy" });
    await box.fill("e2e-eddy delete template old_offer");
    await box.press("Enter");
    await expect(panel.locator('[data-eddy-item="eddy"]').last()).toContainText("needs an admin");
    await expect(panel.locator("[data-eddy-card]")).toHaveCount(0);
    await actx.close();
  });
});
