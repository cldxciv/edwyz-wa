import { expect, test, type Page } from "@playwright/test";
import { closeDb, db, ORIGIN, watchErrors } from "./helpers";
import { axeProblems, enterApp, newMember, newOwner, overflowsX, toggleTheme } from "./automation-fixtures";

test.afterAll(closeDb);
test.setTimeout(120_000);

const RAW = /\b(undefined|null|NaN|\[object|handoffKeywords|maxRepliesPerConversation|noHumanReplyMinutes|phoneNumberId|tenantId|prisma|stack)\b/;

test.describe.serial("AI agent: create, settings, knowledge, test chat, usage", () => {
  let ctx: Awaited<ReturnType<typeof newOwner>>;
  let errors: string[];
  let agentId = "";
  // Whether this server has an AI key. Without one the page says so up front: no credit meter, the agent cannot be enabled, the test chat is off.
  let aiOn = true;

  test.beforeAll(async ({ browser }) => {
    ctx = await newOwner(browser, "ai");
    errors = watchErrors(ctx.page);
    aiOn = (await (await ctx.context.request.get("/api/ai-agent/usage")).json()).aiConfigured !== false;
  });
  test.afterAll(async () => {
    await ctx.context.close();
  });

  test("the page explains the AI agent and offers to create the first one", async () => {
    const { page } = ctx;
    await enterApp(page);
    await page.getByRole("link", { name: "AI agent", exact: true }).first().click();
    await expect(page).toHaveURL(/\/app\/automation\/ai-agent$/);
    await expect(page.getByRole("heading", { level: 1, name: "AI agent" })).toBeVisible();
    await expect(page.getByText(/hands the chat to your team when it cannot help/)).toBeVisible();
    const form = page.getByRole("form", { name: "Create AI agent" });
    await expect(form.getByLabel("Name")).toHaveValue("Support assistant");
    await expect(form.getByRole("button", { name: "Create AI agent" })).toBeVisible();
  });

  test("an agent without instructions cannot be created, and the form says so", async () => {
    const { page } = ctx;
    const form = page.getByRole("form", { name: "Create AI agent" });
    await form.getByRole("button", { name: "Create AI agent" }).click();
    // native required validation keeps the form on the page and focuses the empty field
    await expect(form.getByLabel("Instructions")).toBeFocused();
    expect(await form.getByLabel("Instructions").evaluate((e) => (e as HTMLTextAreaElement).validationMessage)).not.toBe("");
    await form.getByLabel("Name").fill("   ");
    await form.getByLabel("Instructions").fill("You answer questions for a dental clinic.");
    await form.getByRole("button", { name: "Create AI agent" }).click();
    // a blank name: either refused in words or trimmed away
    // only look inside the page content: Next.js' route announcer and the toast region also have role=alert
    const alert = page.locator('#main-content [role="alert"]').filter({ hasText: /./ });
    await expect(alert.first().or(page.getByRole("form", { name: "AI agent settings" }))).toBeVisible();
    if (await alert.count()) {
      const msg = (await alert.first().innerText()).trim();
      expect(msg, "plain language error for a blank name").not.toMatch(RAW);
      expect(msg).not.toMatch(/^name is required\.?$/);
    }
  });

  test("create the agent: settings, usage meter and knowledge appear", async () => {
    const { page } = ctx;
    if (await page.getByRole("form", { name: "Create AI agent" }).count()) {
      const form = page.getByRole("form", { name: "Create AI agent" });
      await form.getByLabel("Name").fill("Clinic assistant");
      await form.getByRole("button", { name: "Create AI agent" }).click();
    }
    await expect(page.getByRole("form", { name: "AI agent settings" })).toBeVisible();
    const row = (await (await db()).query(`select id, enabled, activation from "AiAgent" where "tenantId"=$1`, [ctx.user.tenantId])).rows;
    expect(row).toHaveLength(1);
    expect(row[0].enabled).toBe(false);
    agentId = row[0].id;
    if (aiOn) {
      // usage meter
      await expect(page.getByRole("heading", { name: "AI credits this month" })).toBeVisible();
      await expect(page.getByText(/0 used of \d+\. 0 AI replies sent\./)).toBeVisible();
      await expect(page.getByRole("progressbar", { name: "AI credits used" })).toHaveAttribute("aria-valuenow", "0");
    } else {
      // AI off on purpose: a credit budget that can never be used is hidden, and a plain notice says why and whom to ask instead.
      const notice = page.getByRole("main").getByRole("status").filter({ hasText: "AI is not switched on for this workspace yet" });
      await expect(notice).toBeVisible();
      await expect(notice).toContainText("Ask an admin to set up AI.");
      await expect(page.getByRole("heading", { name: "AI credits this month" })).toHaveCount(0);
      await expect(page.getByRole("progressbar", { name: "AI credits used" })).toHaveCount(0);
      const usage = await (await page.request.get("/api/ai-agent/usage")).json();
      expect([usage.used, usage.replies]).toEqual([0, 0]);
    }
    // knowledge empty state
    await expect(page.getByText("No knowledge yet. Without it the assistant hands every question to your team.")).toBeVisible();
  });

  test("settings: save, validation of numbers and keywords, plain-language messages", async () => {
    const { page } = ctx;
    const form = page.getByRole("form", { name: "AI agent settings" });
    await form.getByLabel("Tone").fill("Warm and brief");
    await form.getByLabel("Reply when").selectOption("no_human_reply_minutes");
    await form.getByLabel("Minutes without a teammate reply").fill("30");
    await form.getByLabel("Handoff keywords").fill("refund, Complaint, lawyer");
    if (aiOn) {
      await form.getByLabel("Enabled").check();
    } else {
      // AI off: an agent that could never reply cannot be switched on, and the checkbox says why; every other setting still saves.
      await expect(form.getByLabel("Enabled")).toBeDisabled();
      await expect(form.getByLabel("Enabled")).toHaveAccessibleDescription(/AI is not switched on for this workspace yet\. Ask an admin to set up AI\. The agent cannot be enabled until then\./);
    }
    await form.getByRole("button", { name: "Save settings" }).click();
    await expect(form.getByRole("status")).toHaveText("Saved.");
    const saved = (await (await db()).query(`select enabled, activation, "handoffKeywords", tone from "AiAgent" where id=$1`, [agentId])).rows[0];
    expect(saved.enabled).toBe(aiOn);
    expect(saved.activation).toBe("no_human_reply_minutes:30");
    expect(saved.handoffKeywords).toEqual(["refund", "complaint", "lawyer"]);
    // too many keywords: the server refuses; the message must be readable by a business owner
    await form.getByLabel("Handoff keywords").fill(Array.from({ length: 25 }, (_, i) => `word${i}`).join(", "));
    await form.getByRole("button", { name: "Save settings" }).click();
    const alert = form.getByRole("alert");
    await expect(alert).toBeVisible();
    const msg = await alert.innerText();
    expect(msg, `message shown: "${msg}"`).not.toMatch(RAW);
    // one keyword that is too long
    await form.getByLabel("Handoff keywords").fill("x".repeat(50));
    await form.getByRole("button", { name: "Save settings" }).click();
    const msg2 = await form.getByRole("alert").innerText();
    expect(msg2, `message shown: "${msg2}"`).not.toMatch(RAW);
    // values survive a reload
    await page.reload();
    await expect(page.getByLabel("Tone")).toHaveValue("Warm and brief");
    await expect(page.getByLabel("Minutes without a teammate reply")).toHaveValue("30");
  });

  test("knowledge: add text and an FAQ, see them listed with sizes, remove one", async () => {
    const { page } = ctx;
    const add = page.getByRole("form", { name: "Add knowledge" });
    await add.getByLabel("Title").fill("Opening hours");
    await add.getByLabel("Text").fill("We are open Monday to Friday from 9 am to 5 pm. Closed on public holidays.");
    await add.getByRole("button", { name: "Add knowledge" }).click();
    await expect(page.getByText("Opening hours")).toBeVisible();
    await expect(page.getByText(/\d+ characters/).first()).toBeVisible();
    await add.getByLabel("Type").selectOption("faq");
    await add.getByLabel("Title").fill("Payments");
    await add.getByLabel("Question").fill("Do you accept cards?");
    await add.getByLabel("Answer").fill("Yes, all major cards and UPI.");
    await add.getByRole("button", { name: "Add knowledge" }).click();
    await expect(page.getByText("Payments")).toBeVisible();
    await expect(page.getByText("No knowledge yet.")).toHaveCount(0);
    const rows = (await (await db()).query(`select kind, title, content from "AiKnowledgeSource" where "agentId"=$1 order by "createdAt"`, [agentId])).rows;
    expect(rows.map((r) => r.kind)).toEqual(["text", "faq"]);
    expect(rows[1].content).toBe("Q: Do you accept cards?\nA: Yes, all major cards and UPI.");
    await page.getByRole("button", { name: "Delete Payments" }).click();
    await expect(page.getByText("Payments")).toHaveCount(0);
  });

  test("knowledge from a web page: private, http and local addresses are refused with a clear message", async () => {
    const { page } = ctx;
    const add = page.getByRole("form", { name: "Add knowledge" });
    await add.getByLabel("Type").selectOption("url");
    for (const bad of ["http://example.com/faq", "https://localhost/faq", "https://10.1.2.3/faq", "https://169.254.169.254/latest/meta-data", "https://127.0.0.1:8443/x", "https://example.com:8080/faq"]) {
      await add.getByLabel("Page address").fill(bad);
      await add.getByRole("button", { name: "Add knowledge" }).click();
      const alert = add.getByRole("alert");
      await expect(alert, bad).toBeVisible();
      const msg = (await alert.innerText()).trim();
      expect(msg, `${bad} -> "${msg}"`).not.toMatch(RAW);
      expect(msg.length, bad).toBeGreaterThan(8);
    }
    const n = (await (await db()).query(`select count(*)::int c from "AiKnowledgeSource" where "agentId"=$1 and kind='url'`, [agentId])).rows[0].c;
    expect(n).toBe(0);
  });

  test("test chat: without a model key the failure is shown inside the chat in words, and no credit is used", async () => {
    const { page } = ctx;
    test.skip(aiOn, "this server has an AI key, so the no-key path cannot be shown");
    // The app now says up front, inside the test chat card, that AI is off, and turns the box and Send off,
    // instead of letting a message fail after it is sent; so nothing can be sent and no credit can be used.
    const chat = page.getByRole("form", { name: "Test message" });
    await expect(page.getByText("AI is not switched on for this workspace yet. Ask an admin to set up AI. The test chat cannot answer until then.")).toBeVisible();
    await expect(chat.getByLabel("Test message")).toBeDisabled();
    await expect(chat.getByRole("button", { name: "Send" })).toBeDisabled();
    await expect(page.getByRole("main").locator("div[aria-live=polite]"), "no message bubble was added").toBeEmpty();
    const used = (await (await db()).query(`select coalesce(sum(amount),0)::int u from "UsageLedger" where "tenantId"=$1 and meter='ai_credits'`, [ctx.user.tenantId])).rows[0].u;
    expect(used).toBe(0);
  });

  test("the test endpoint itself answers 503 with a plain message when AI is not configured", async () => {
    const { page } = ctx;
    const r = await page.request.post(`/api/ai-agent/agents/${agentId}/test`, { headers: { origin: ORIGIN }, data: { message: "hello" } });
    expect([503, 200]).toContain(r.status());
    if (r.status() === 503) {
      const body = await r.json();
      expect(JSON.stringify(body)).not.toMatch(/stack|prisma|ANTHROPIC|sk-/i);
      expect(String(body.error ?? body.message)).toMatch(/AI is not configured/);
    }
    const empty = await page.request.post(`/api/ai-agent/agents/${agentId}/test`, { headers: { origin: ORIGIN }, data: { message: "   " } });
    expect(empty.status()).toBe(400);
  });

  test("usage meter turns serious near the limit and tells people the chat goes to the team when credits run out", async () => {
    const { page } = ctx;
    const usage = await (await page.request.get("/api/ai-agent/usage")).json();
    expect(usage.limit).toBeGreaterThan(0);
    await (await db()).query(`insert into "UsageLedger" (id, "tenantId", meter, amount) values ($1,$2,'ai_credits',$3)`, [`ul_${Date.now()}`, ctx.user.tenantId, Math.ceil(usage.limit * 0.95)]);
    await page.reload();
    if (!aiOn) {
      // AI off on purpose: the server still counts credits, but the page shows the AI-off notice instead of a meter nobody can use.
      await expect(page.getByRole("form", { name: "AI agent settings" })).toBeVisible();
      const notice = page.getByRole("main").getByRole("status").filter({ hasText: "AI is not switched on for this workspace yet" });
      await expect(notice).toBeVisible();
      await expect(page.getByRole("progressbar", { name: "AI credits used" })).toHaveCount(0);
      await (await db()).query(`insert into "UsageLedger" (id, "tenantId", meter, amount) values ($1,$2,'ai_credits',$3)`, [`ul2_${Date.now()}`, ctx.user.tenantId, usage.limit]);
      const after = await (await page.request.get("/api/ai-agent/usage")).json();
      expect(after.used).toBeGreaterThanOrEqual(usage.limit);
      expect(after.remaining).toBe(0);
      await page.reload();
      await expect(notice).toBeVisible();
      await expect(page.getByRole("heading", { name: "AI credits this month" })).toHaveCount(0);
      await expect(page.getByRole("form", { name: "Test message" }).getByRole("button", { name: "Send" })).toBeDisabled();
      return;
    }
    await expect(page.getByText(new RegExp(`${Math.ceil(usage.limit * 0.95)} used of ${usage.limit}`))).toBeVisible();
    const bar = page.getByRole("progressbar", { name: "AI credits used" });
    await expect(bar).toHaveAttribute("aria-valuenow", String(Math.min(100, Math.round((Math.ceil(usage.limit * 0.95) / usage.limit) * 100))));
    await (await db()).query(`insert into "UsageLedger" (id, "tenantId", meter, amount) values ($1,$2,'ai_credits',$3)`, [`ul2_${Date.now()}`, ctx.user.tenantId, usage.limit]);
    await page.reload();
    await expect(page.getByText("Credits are used up. New chats are handed to your team.")).toBeVisible();
    // and the test chat says why it cannot answer
    const chat = page.getByRole("form", { name: "Test message" });
    await chat.getByLabel("Test message").fill("anyone there?");
    await chat.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText(/AI credits for this month are used up/)).toBeVisible();
  });

  test("delete the agent asks first", async () => {
    const { page } = ctx;
    page.once("dialog", (d) => d.dismiss());
    await page.getByRole("button", { name: "Delete agent" }).click();
    await expect(page.getByRole("form", { name: "AI agent settings" })).toBeVisible();
    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "Delete agent" }).click();
    await expect(page.getByRole("form", { name: "Create AI agent" })).toBeVisible();
    const n = (await (await db()).query(`select count(*)::int c from "AiKnowledgeSource" where "agentId"=$1`, [agentId])).rows[0].c;
    expect(n, "knowledge is removed with the agent").toBe(0);
  });

  test("clean console and network", async () => {
    // the 503 and 402 answers are expected and are logged by the browser as failed resource loads
    const unexpected = errors.filter((e) => !/status of (402|503|400)/.test(e));
    expect(unexpected, unexpected.join("\n")).toEqual([]);
  });
});

test.describe.serial("AI agent: permissions and isolation", () => {
  let owner: Awaited<ReturnType<typeof newOwner>>;
  let agentId = "";
  test.beforeAll(async ({ browser }) => {
    owner = await newOwner(browser, "aiperm");
    const r = await owner.context.request.post("/api/ai-agent/agents", { headers: { origin: ORIGIN }, data: { name: "Perm bot", instructions: "Help customers." } });
    expect(r.status()).toBe(201);
    agentId = (await r.json()).agent.id;
  });
  test.afterAll(async () => {
    await owner.context.close();
  });

  test("an agent teammate can look but not change; direct calls are refused", async ({ browser }) => {
    const member = await newMember(browser, owner.user, "agent");
    try {
      const p = member.page;
      await p.goto("/app/automation/ai-agent");
      await expect(p.getByText("You can view the AI agent. Only admins and owners can change it.")).toBeVisible();
      await expect(p.getByRole("button", { name: "Save settings" })).toHaveCount(0);
      await expect(p.getByRole("form", { name: "Add knowledge" })).toHaveCount(0);
      await expect(p.getByRole("form", { name: "Test message" })).toHaveCount(0);
      const h = { origin: ORIGIN };
      expect((await member.context.request.patch(`/api/ai-agent/agents/${agentId}`, { headers: h, data: { enabled: true } })).status()).toBe(403);
      expect((await member.context.request.post(`/api/ai-agent/agents/${agentId}/sources`, { headers: h, data: { kind: "text", title: "x", content: "y" } })).status()).toBe(403);
      expect((await member.context.request.post(`/api/ai-agent/agents/${agentId}/test`, { headers: h, data: { message: "hi" } })).status()).toBe(403);
      expect((await member.context.request.delete(`/api/ai-agent/agents/${agentId}`, { headers: h })).status()).toBe(403);
    } finally {
      await member.context.close();
    }
  });

  test("another workspace cannot see, change or test this agent", async ({ browser }) => {
    const other = await newOwner(browser, "aiperm-other");
    try {
      await other.page.goto("/app/automation/ai-agent");
      await expect(other.page.getByRole("form", { name: "Create AI agent" })).toBeVisible();
      const h = { origin: ORIGIN };
      expect((await other.context.request.get(`/api/ai-agent/agents/${agentId}`)).status()).toBe(404);
      expect((await other.context.request.get(`/api/ai-agent/agents/${agentId}/sources`)).status()).toBe(404);
      expect((await other.context.request.post(`/api/ai-agent/agents/${agentId}/sources`, { headers: h, data: { kind: "text", title: "x", content: "y" } })).status()).toBe(404);
      expect((await other.context.request.post(`/api/ai-agent/agents/${agentId}/test`, { headers: h, data: { message: "hi" } })).status()).toBe(404);
      expect((await other.context.request.patch(`/api/ai-agent/agents/${agentId}`, { headers: h, data: { name: "hijack" } })).status()).toBe(404);
      expect((await other.context.request.delete(`/api/ai-agent/agents/${agentId}`, { headers: h })).status()).toBe(404);
      expect(((await (await db()).query(`select name from "AiAgent" where id=$1`, [agentId])).rows[0]).name).toBe("Perm bot");
    } finally {
      await other.context.close();
    }
  });
});

test.describe.serial("AI tools: connecting your own servers", () => {
  let ctx: Awaited<ReturnType<typeof newOwner>>;
  let errors: string[];
  test.beforeAll(async ({ browser }) => {
    ctx = await newOwner(browser, "tools");
    errors = watchErrors(ctx.page);
  });
  test.afterAll(async () => {
    await ctx.context.close();
  });

  test("the page explains the safety rules and starts empty", async () => {
    const { page } = ctx;
    await enterApp(page);
    await page.getByRole("link", { name: "AI tools", exact: true }).first().click();
    await expect(page).toHaveURL(/\/app\/settings\/ai-tools$/);
    await expect(page.getByRole("heading", { level: 1, name: "AI tools" })).toBeVisible();
    await expect(page.getByText(/Nothing is callable until you tick the tool/)).toBeVisible();
    await expect(page.getByText(/Only connect servers you trust/)).toBeVisible();
    await expect(page.getByText("No servers connected")).toBeVisible();
    await expect(page.getByText(/must be a public https address/)).toBeVisible();
  });

  const REFUSED: [string, string][] = [
    ["plain http", "http://tools.example.com/mcp"],
    ["localhost", "https://localhost/mcp"],
    ["loopback address", "https://127.0.0.1/mcp"],
    ["private network address", "https://10.0.0.5/mcp"],
    ["private 192.168 address", "https://192.168.1.10/mcp"],
    ["cloud metadata address", "https://169.254.169.254/latest/meta-data"],
    ["IPv6 loopback", "https://[::1]/mcp"],
    ["decimal-encoded loopback", "https://2130706433/mcp"],
    ["credentials in the address", "https://user:secret@example.com/mcp"],
    ["an unusual port", "https://example.com:8080/mcp"],
    ["internal host name", "https://metadata.google.internal/computeMetadata/v1/"],
  ];
  for (const [label, url] of REFUSED) {
    test(`add server: ${label} is refused with a message a person can act on`, async () => {
      const { page } = ctx;
      await page.getByLabel("Name", { exact: true }).fill("Orders");
      await page.getByLabel("Server URL").fill(url);
      await page.getByRole("button", { name: "Add server" }).click();
      const alert = page.locator('#main-content [role="alert"]').filter({ hasText: /./ }).first();
      await expect(alert, `${url} should be refused`).toBeVisible();
      const msg = (await alert.innerText()).trim();
      expect(msg, `${url} -> "${msg}"`).not.toMatch(RAW);
      // the message about the MCP page should not talk about "Webhook URLs"
      expect(msg, `${url} -> "${msg}" mentions webhooks on a page about AI tools`).not.toMatch(/webhook/i);
      const n = (await (await db()).query(`select count(*)::int c from "McpConnection" where "tenantId"=$1`, [ctx.user.tenantId])).rows[0].c;
      expect(n, `${url} must not be stored`).toBe(0);
    });
  }

  test("add server: the form blocks a missing name, a missing address and text that is not an address", async () => {
    const { page } = ctx;
    await page.getByLabel("Name", { exact: true }).fill("");
    await page.getByLabel("Server URL").fill("");
    await page.getByRole("button", { name: "Add server" }).click();
    await expect(page.getByLabel("Name", { exact: true })).toBeFocused();
    await page.getByLabel("Name", { exact: true }).fill("Orders");
    await page.getByLabel("Server URL").fill("not a url");
    expect(await page.getByLabel("Server URL").evaluate((e) => (e as HTMLInputElement).validity.valid)).toBe(false);
    // a host name that resolves: the address is checked (with a DNS lookup) before the token, so an unknown host would hide the token message
    await page.getByLabel("Server URL").fill("https://example.com/mcp");
    await page.getByLabel("Access token (optional)").fill("has a space");
    await page.getByRole("button", { name: "Add server" }).click();
    await expect(page.locator('#main-content [role="alert"]').filter({ hasText: /access token/i })).toBeVisible();
    await page.getByLabel("Access token (optional)").fill("");
  });

  test("a server that cannot be reached fails gracefully when tested, and can be disabled and removed", async () => {
    const { page } = ctx;
    // add a public-looking address; whether or not DNS answers, adding must not crash the page
    await page.getByLabel("Name", { exact: true }).fill("Orders server");
    await page.getByLabel("Server URL").fill("https://example.com/mcp");
    await page.getByLabel("Access token (optional)").fill("secret-token-123");
    await page.getByRole("button", { name: "Add server" }).click();
    const card = page.getByRole("heading", { name: "Orders server" });
    const refused = page.locator('#main-content [role="alert"]').filter({ hasText: /./ });
    await expect(card.or(refused.first())).toBeVisible();
    test.skip(!(await card.count()), "this machine cannot resolve a public host name, so a connection cannot be added");
    await expect(page.getByText("Token set")).toBeVisible();
    await expect(page.getByText("0 allowed")).toBeVisible();
    // the token is never shown again
    expect(await page.locator("main, #main-content, #content").first().innerText()).not.toContain("secret-token-123");
    await page.getByRole("button", { name: "Test and list tools" }).click();
    const result = page.locator('#main-content [role="alert"]');
    await expect(result).toBeVisible({ timeout: 30_000 });
    const msg = (await result.innerText()).trim();
    expect(msg, `shown: ${msg}`).not.toMatch(/stack|ECONN|ENOTFOUND|\bat [\w.]+ \(|undefined|prisma/i);
    await page.getByRole("button", { name: "Disable" }).click();
    await expect(page.getByText("Disabled", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Enable" }).click();
    await expect(page.getByText("Enabled", { exact: true })).toBeVisible();
    page.once("dialog", (d) => d.dismiss());
    await page.getByRole("button", { name: "Remove" }).click();
    await expect(card).toBeVisible();
    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "Remove" }).click();
    await expect(page.getByText("No servers connected")).toBeVisible();
  });

  test("an agent teammate sees only a notice; direct calls are refused", async ({ browser }) => {
    const member = await newMember(browser, ctx.user, "agent");
    try {
      await member.page.goto("/app/settings/ai-tools");
      await expect(member.page.getByText("Only admins and owners can manage AI tools.")).toBeVisible();
      await expect(member.page.getByRole("button", { name: "Add server" })).toHaveCount(0);
      const r = await member.context.request.post("/api/mcp-connections", { headers: { origin: ORIGIN }, data: { name: "x", url: "https://example.com/mcp" } });
      expect(r.status()).toBe(403);
      expect((await member.context.request.get("/api/mcp-connections")).status()).toBe(403);
    } finally {
      await member.context.close();
    }
  });

  test("another workspace cannot test, change or remove this workspace's connection", async ({ browser }) => {
    const id = `mcp_${Date.now()}`;
    await (await db()).query(`insert into "McpConnection" (id, "tenantId", name, url, "allowedTools") values ($1,$2,'Seeded','https://tools.example.com/mcp','{}')`, [id, ctx.user.tenantId]);
    const other = await newOwner(browser, "tools-other");
    try {
      const h = { origin: ORIGIN };
      expect((await other.context.request.post(`/api/mcp-connections/${id}/test`, { headers: h })).status()).toBe(404);
      expect((await other.context.request.patch(`/api/mcp-connections/${id}`, { headers: h, data: { enabled: false } })).status()).toBe(404);
      expect((await other.context.request.delete(`/api/mcp-connections/${id}`, { headers: h })).status()).toBe(404);
      expect(JSON.stringify(await (await other.context.request.get("/api/mcp-connections")).json())).not.toContain("Seeded");
    } finally {
      await other.context.close();
    }
  });

  test("a seeded connection lists with its state and a failed test never leaks internals", async () => {
    const { page } = ctx;
    await page.goto("/app/settings/ai-tools");
    await expect(page.getByRole("heading", { name: "Seeded" })).toBeVisible();
    await expect(page.getByText("No token")).toBeVisible();
    const seeded = page.locator("div").filter({ has: page.getByRole("heading", { name: "Seeded", exact: true }) }).filter({ has: page.getByRole("button", { name: "Test and list tools" }) }).last();
    await seeded.getByRole("button", { name: "Test and list tools" }).click();
    const alert = page.locator('#main-content [role="alert"]');
    await expect(alert).toBeVisible({ timeout: 30_000 });
    const msg = (await alert.innerText()).trim();
    expect(msg, `shown: ${msg}`).not.toMatch(/stack|ECONN|ENOTFOUND|\bat [\w.]+ \(|undefined|prisma/i);
  });

  test("clean console and network", async () => {
    const unexpected = errors.filter((e) => !/status of (400|403|404|409|422|502|503)/.test(e));
    expect(unexpected, unexpected.join("\n")).toEqual([]);
  });
});

test.describe("AI agent and AI tools: accessibility and responsive", () => {
  async function pass(page: Page, path: string, ready: string) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1, name: ready })).toBeVisible();
  }

  test("axe, dark theme and 360px on both pages", async ({ browser }) => {
    const { context, page } = await newOwner(browser, "ai-a11y");
    try {
      const errors = watchErrors(page);
      const r = await context.request.post("/api/ai-agent/agents", { headers: { origin: ORIGIN }, data: { name: "A11y bot", instructions: "Help." } });
      expect(r.status()).toBe(201);
      await pass(page, "/app/automation/ai-agent", "AI agent");
      await expect(page.getByRole("form", { name: "AI agent settings" })).toBeVisible();
      expect(await axeProblems(page), "ai agent light").toEqual([]);
      await pass(page, "/app/settings/ai-tools", "AI tools");
      await expect(page.getByText("No servers connected")).toBeVisible();
      expect(await axeProblems(page), "ai tools light").toEqual([]);
      await toggleTheme(page);
      await expect(page.locator("html")).toHaveAttribute("data-theme", /dark/);
      expect(await axeProblems(page), "ai tools dark").toEqual([]);
      await pass(page, "/app/automation/ai-agent", "AI agent");
      await expect(page.getByRole("form", { name: "AI agent settings" })).toBeVisible();
      expect(await axeProblems(page), "ai agent dark").toEqual([]);
      await page.setViewportSize({ width: 360, height: 740 });
      await page.reload();
      await expect(page.getByRole("form", { name: "AI agent settings" })).toBeVisible();
      expect(await overflowsX(page), "ai agent overflow at 360px").toBe(false);
      await pass(page, "/app/settings/ai-tools", "AI tools");
      expect(await overflowsX(page), "ai tools overflow at 360px").toBe(false);
      expect(errors, errors.join("\n")).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
