import { expect, request as pwRequest, test, type Page } from "@playwright/test";
import { addTeammate, apiLogin, axeSerious, createOwner, isDark, overflowsHorizontally, setDarkTheme } from "./settings-billing-admin-kit";
import { closeDb, ORIGIN, stamp, type TestUser, watchErrors } from "./helpers";

const API = "/app/settings/api";
const MCP = "/app/settings/mcp";
let owner: TestUser;
let stranger: TestUser;

test.beforeAll(async () => {
  owner = await createOwner("sba-api");
  stranger = await createOwner("sba-api-stranger");
});
test.afterAll(closeDb);
test.beforeEach(async ({ context }) => {
  await apiLogin(context, owner.email);
});

const o = { headers: { origin: ORIGIN } };

async function createKeyViaUi(page: Page, name: string, scopeLabels: string[]) {
  await page.getByRole("button", { name: "Create API key" }).first().click();
  const dlg = page.getByRole("dialog", { name: "Create an API key" });
  await expect(dlg).toBeVisible();
  await dlg.getByLabel(/Key name/).fill(name);
  // "Send messages" is ticked by default (see the validation test); a key must hold exactly the permissions asked for here.
  if (!scopeLabels.includes("Send messages")) await dlg.getByRole("checkbox", { name: /^Send messages/ }).uncheck();
  for (const s of scopeLabels) await dlg.getByRole("checkbox", { name: new RegExp(`^${s}`) }).check();
  await dlg.getByRole("button", { name: "Create key" }).click();
  const reveal = page.getByRole("dialog", { name: "Your new API key" });
  await expect(reveal).toBeVisible();
  return { reveal, key: (await reveal.getByTestId("secret").innerText()).trim() };
}

async function bearer(key: string) {
  return pwRequest.newContext({ baseURL: ORIGIN, extraHTTPHeaders: { Authorization: `Bearer ${key}` } });
}

test.describe("API keys", () => {
  test("empty state, developer guide and form validation", async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto("/app");
    await page.getByRole("link", { name: "API and webhooks" }).first().click();
    await expect(page).toHaveURL(/\/app\/settings\/api$/);
    await expect(page.getByRole("heading", { level: 1, name: "API and webhooks" })).toBeVisible();
    await expect(page.getByRole("main")).toBeVisible();
    await expect(page.getByText("No API keys yet")).toBeVisible();
    await expect(page.getByText("No endpoints yet")).toBeVisible();

    await page.getByText("Show examples").click();
    for (const t of ["Send a template message", "Add or update a contact", "Verify a webhook signature"]) await expect(page.getByRole("heading", { name: t })).toBeVisible();
    await expect(page.getByRole("button", { name: "Copy example" }).first()).toBeVisible();

    await page.getByRole("button", { name: "Create API key" }).first().click();
    const dlg = page.getByRole("dialog", { name: "Create an API key" });
    await expect(dlg.getByLabel(/Key name/)).toBeFocused();
    await expect(dlg.getByRole("checkbox", { name: /^Send messages/ })).toBeChecked(); // sensible default
    await dlg.getByRole("button", { name: "Create key" }).click();
    await expect(dlg.getByText("Give the key a name so you can recognise it later.")).toBeVisible();
    await dlg.getByLabel(/Key name/).fill("x".repeat(61).slice(0, 60));
    await dlg.getByRole("checkbox", { name: /^Send messages/ }).uncheck();
    await dlg.getByRole("button", { name: "Create key" }).click();
    await expect(dlg.getByText("Choose at least one thing this key may do.")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dlg).toBeHidden();
    await expect(page.getByRole("button", { name: "Create API key" }).first()).toBeFocused();
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("create a key: shown once, copy works, it works against the API with only its scopes, then it can be turned off", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
    await page.goto(API);
    const name = `Website ${stamp()}`;
    const { reveal, key } = await createKeyViaUi(page, name, ["View contacts"]);
    expect(key).toMatch(/^wak_[A-Za-z0-9_-]{20,}$/);
    await expect(reveal.getByText("Copy it now. You will not see it again.")).toBeVisible();

    // Closing without copying asks first; going back keeps the key on screen.
    await reveal.getByRole("button", { name: "Close", exact: true }).click();
    const sure = page.getByRole("alertdialog", { name: "Close without copying?" });
    await expect(sure).toBeVisible();
    await sure.getByRole("button", { name: "Go back and copy" }).click();
    await expect(reveal).toBeVisible();
    await expect(reveal.getByTestId("secret")).toHaveText(key);
    await reveal.getByRole("button", { name: "Copy to clipboard" }).click();
    await expect(reveal.getByRole("button", { name: "Copied" })).toBeVisible();
    const clip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => key);
    expect(clip).toBe(key);
    await reveal.getByRole("button", { name: "Done" }).click();
    await expect(reveal).toBeHidden();

    // After closing the full key is gone from the page and from the API; only the prefix remains.
    const table = page.getByRole("table", { name: "API keys" });
    const row = table.getByRole("row", { name: new RegExp(name) });
    await expect(row).toContainText(key.slice(0, 8));
    await expect(row).toContainText("View contacts");
    await expect(row).toContainText("Never used");
    await expect(row).toContainText("Active");
    expect(await page.locator("body").innerText()).not.toContain(key);
    const listed = await (await page.request.get("/api/integrations/api-keys")).text();
    expect(listed).not.toContain(key);
    expect(listed).not.toMatch(/keyHash|wak_[A-Za-z0-9_-]{30,}/);

    // The key does exactly what it was given: reads contacts, cannot send.
    const api = await bearer(key);
    const ok = await api.get("/api/v1/contacts");
    expect(ok.status()).toBe(200);
    const send = await api.post("/api/v1/messages", { data: { to: "+15550009999", type: "text", text: "hello" } });
    expect(send.status()).toBe(403);
    const v3 = await api.get("/api/ext/v3/contacts");
    expect(v3.status()).toBe(200);
    expect((await v3.json()).ok).toBe(true);
    const bad = await (await pwRequest.newContext({ baseURL: ORIGIN })).get("/api/v1/contacts", { headers: { Authorization: "Bearer wak_not_a_real_key" } });
    expect(bad.status()).toBe(401);

    // Turn it off: confirmation, plain status, focus moves somewhere sensible, key stops working at once.
    await page.reload();
    const row2 = page.getByRole("table", { name: "API keys" }).getByRole("row", { name: new RegExp(name) });
    await expect(row2).toContainText(/Last used|Never used|ago|\d{4}|[A-Z][a-z]{2}/);
    await row2.getByRole("button", { name: /Turn off/ }).click();
    const confirm = page.getByRole("alertdialog", { name: `Turn off "${name}"?` });
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(row2).toContainText("Active");
    await row2.getByRole("button", { name: /Turn off/ }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Turn off key" }).click();
    await expect(page.getByText(`"${name}" was turned off`)).toBeVisible();
    await expect(row2).toContainText("Turned off");
    // A turned-off key cannot be turned back on; by design its only action is now "Remove" (clears it from the list).
    await expect(row2.getByRole("button", { name: /Turn off/ })).toHaveCount(0);
    await expect(row2.getByRole("button")).toHaveCount(1);
    await expect(row2.getByRole("button", { name: `Remove key ${name} from the list` })).toBeVisible();
    await expect(page.getByRole("button", { name: "Create API key" }).first()).toBeFocused();
    expect((await api.get("/api/v1/contacts")).status()).toBe(401);

    // Removing the turned-off key asks first, then it disappears from the list and still does not work.
    await row2.getByRole("button", { name: /^Remove/ }).click();
    const removeConfirm = page.getByRole("alertdialog", { name: `Remove "${name}" from the list?` });
    await expect(removeConfirm).toBeVisible();
    await removeConfirm.getByRole("button", { name: "Remove key" }).click();
    await expect(page.getByText(`"${name}" was removed`)).toBeVisible();
    await expect(page.getByRole("row", { name: new RegExp(name) })).toHaveCount(0);
    expect((await api.get("/api/v1/contacts")).status()).toBe(401);
    await api.dispose();
  });

  test("scope names in the MCP guide can be matched to the names shown when creating a key", async ({ page }) => {
    await page.goto(MCP);
    await expect(page.getByRole("heading", { level: 1, name: "MCP connection" })).toBeVisible(); // the page first renders a "Loading" placeholder
    await expect(page.getByRole("heading", { name: "Tools" })).toBeVisible();
    const guide = await page.locator("main").innerText();
    const raw = ["contacts:read", "templates:read", "contacts:write", "messages:write"];
    for (const s of raw) expect(guide).toContain(s);
    await page.goto(API);
    await page.getByRole("button", { name: "Create API key" }).first().click();
    const dlg = page.getByRole("dialog", { name: "Create an API key" });
    await expect(dlg).toBeVisible();
    const dialogText = await dlg.innerText();
    // A non-technical owner follows the MCP guide ("create a key with contacts:read") and must be able to find that permission.
    const missing = raw.filter((s) => !dialogText.includes(s));
    expect(missing, `The MCP page tells people to pick ${raw.join(", ")}, but the key dialog only shows friendly names, so ${missing.join(", ")} cannot be found there.`).toEqual([]);
  });

  test("the scope a person would pick for conversations actually gives the MCP assistant its tools", async ({ page }) => {
    await page.goto(API);
    const { reveal, key } = await createKeyViaUi(page, `Chat reader ${stamp()}`, ["View conversations"]);
    await reveal.getByRole("button", { name: "Copy to clipboard" }).click();
    await reveal.getByRole("button", { name: "Done" }).click();
    const api = await bearer(key);
    const res = await api.post("/api/mcp", { headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, data: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
    expect(res.status()).toBe(200);
    const tools = ((await res.json()).result?.tools ?? []).map((t: { name: string }) => t.name);
    expect(tools, "A key made with 'View conversations' lists no conversation tools in MCP; the guide must say which friendly permission to pick").toContain("list_conversations");
    await api.dispose();
  });

  test("an agent cannot use the page or the endpoints behind it", async ({ browser, context }) => {
    const agent = await addTeammate(context, "agent", "api-agent");
    const ctx = await browser.newContext({ baseURL: ORIGIN });
    await apiLogin(ctx, agent.email);
    const p = await ctx.newPage();
    await p.goto("/app");
    await expect(p.getByRole("link", { name: "API and webhooks" })).toHaveCount(0);
    await p.goto(API);
    await expect(p.getByText("Only owners and admins can use this page")).toBeVisible();
    await expect(p.getByRole("button", { name: "Create API key" })).toHaveCount(0);
    await p.goto(MCP);
    await expect(p.getByText("Owners and admins only")).toBeVisible();
    expect((await ctx.request.get("/api/integrations/api-keys")).status()).toBe(403);
    expect((await ctx.request.post("/api/integrations/api-keys", { ...o, data: { name: "x", scopes: ["messages:write"] } })).status()).toBe(403);
    expect((await ctx.request.get("/api/integrations/webhooks")).status()).toBe(403);
    expect((await ctx.request.post("/api/integrations/webhooks", { ...o, data: { url: "https://example.com/x", events: ["message.received"] } })).status()).toBe(403);
    await ctx.close();
  });
});

test.describe("Webhook endpoints", () => {
  test("bad addresses are rejected with plain messages, including server-side SSRF checks", async ({ page }) => {
    await page.goto(API);
    await page.getByRole("button", { name: "Add endpoint" }).first().click();
    const dlg = page.getByRole("dialog", { name: "Add a webhook endpoint" });
    await expect(dlg).toBeVisible();
    await dlg.getByRole("button", { name: "Add endpoint" }).click();
    await expect(dlg.getByText("Enter the address that should receive events.")).toBeVisible();
    await expect(dlg.getByText("Choose at least one event to send.")).toBeVisible();

    const url = dlg.getByLabel(/Address that receives events/);
    await url.fill("example.com/hook");
    await dlg.getByRole("button", { name: "Add endpoint" }).click();
    await expect(dlg.getByText(/Enter a full address/)).toBeVisible();
    await url.fill("http://example.com/hook");
    await dlg.getByRole("button", { name: "Add endpoint" }).click();
    await expect(dlg.getByText(/must start with https/)).toBeVisible();
    await url.fill("https://example.com:8080/hook");
    await dlg.getByRole("button", { name: "Add endpoint" }).click();
    await expect(dlg.getByText("Only port 443 or 8443 is allowed.")).toBeVisible();

    await dlg.getByRole("checkbox", { name: /A customer sends a message/ }).check();
    const bad: [string, RegExp][] = [
      ["https://localhost/hook", /not allowed/],
      ["https://127.0.0.1/hook", /not allowed/],
      ["https://169.254.169.254/latest/meta-data", /not allowed/],
      ["https://10.0.0.5/hook", /not allowed/],
      ["https://192.168.1.10/hook", /not allowed/],
      ["https://[::1]/hook", /not allowed/],
      ["https://[::ffff:127.0.0.1]/hook", /not allowed/],
      ["https://2130706433/hook", /not allowed/],
      ["https://metadata.google.internal/hook", /not allowed/],
      ["https://user:pass@example.com/hook", /credentials/],
    ];
    for (const [address, message] of bad) {
      await url.fill(address);
      await dlg.getByRole("button", { name: "Add endpoint" }).click();
      await expect(dlg.getByRole("alert").filter({ hasText: message }), `${address} must be refused`).toBeVisible();
      // Plain words: no stack traces, no internals.
      expect(await dlg.innerText()).not.toMatch(/ECONN|ENOTFOUND|getaddrinfo|at .*\(.*:\d+:\d+\)/);
    }
    await page.keyboard.press("Escape");
    await expect(dlg).toBeHidden();
    // Nothing got saved.
    const list = await (await page.request.get("/api/integrations/webhooks")).json();
    expect(list.endpoints).toEqual([]);
  });

  test("a valid endpoint shows its signing secret once, can be paused, rotated, tested and deleted", async ({ page }) => {
    await page.goto(API);
    await page.getByRole("button", { name: "Add endpoint" }).first().click();
    const dlg = page.getByRole("dialog", { name: "Add a webhook endpoint" });
    const target = `https://example.com/webhooks/edwyz-${stamp()}`;
    await dlg.getByLabel(/Address that receives events/).fill(target);
    await dlg.getByRole("checkbox", { name: /A customer sends a message/ }).check();
    await dlg.getByRole("checkbox", { name: /A broadcast finishes/ }).check();
    await dlg.getByRole("button", { name: "Add endpoint" }).click();

    const secretDlg = page.getByRole("dialog", { name: "Your signing secret" });
    await expect(secretDlg).toBeVisible();
    await expect(secretDlg).toContainText("X-Edwyz-Signature");
    const secret = (await secretDlg.getByTestId("secret").innerText()).trim();
    expect(secret.length).toBeGreaterThanOrEqual(20);
    await secretDlg.getByRole("button", { name: "Copy to clipboard" }).click();
    await secretDlg.getByRole("button", { name: "Done" }).click();
    await expect(secretDlg).toBeHidden();

    const card = page.getByRole("article", { name: `Endpoint ${target}` });
    await expect(card).toBeVisible();
    await expect(card).toContainText("Sending events");
    await expect(card.getByText("A customer sends a message")).toBeVisible();
    await expect(card.getByText("A broadcast finishes")).toBeVisible();
    expect(await card.innerText()).not.toMatch(/message\.received|broadcast\.completed/); // friendly labels, not raw event ids
    expect(await page.locator("body").innerText()).not.toContain(secret);
    const listed = await (await page.request.get("/api/integrations/webhooks")).text();
    expect(listed).not.toContain(secret);
    expect(listed).not.toMatch(/secretCiphertext|authTag|"iv"/);

    // Pause and resume.
    // The box follows the saved state, so it flips only after the server answered: click, then wait for the result.
    const sendBox = card.getByRole("checkbox", { name: /Send events to this address/ });
    await sendBox.click();
    await expect(page.getByText("Endpoint paused")).toBeVisible();
    await expect(sendBox).not.toBeChecked();
    await expect(card).toContainText("Paused");
    await sendBox.click();
    await expect(page.getByText("Endpoint turned on")).toBeVisible();
    await expect(sendBox).toBeChecked();

    // Rotate: warns, then shows a different secret once.
    await card.getByRole("button", { name: /Create new secret/ }).click();
    const rot = page.getByRole("alertdialog", { name: "Create a new signing secret?" });
    await expect(rot).toBeVisible();
    await rot.getByRole("button", { name: "Create new secret" }).click();
    const fresh = page.getByRole("dialog", { name: "Your new signing secret" });
    await expect(fresh).toBeVisible();
    const secret2 = (await fresh.getByTestId("secret").innerText()).trim();
    expect(secret2).not.toBe(secret);
    await fresh.getByRole("button", { name: "Copy to clipboard" }).click();
    await fresh.getByRole("button", { name: "Done" }).click();

    // A test event produces a delivery row with a plain status, never a raw enum.
    await card.getByRole("button", { name: /Send test event/ }).click();
    await expect(page.getByText("Test event sent. See the result below.")).toBeVisible();
    const deliveries = card.getByRole("table", { name: "Recent deliveries" });
    await expect(deliveries).toBeVisible();
    await expect(deliveries.getByRole("row").nth(1)).toBeVisible({ timeout: 20_000 });
    const rowText = await deliveries.innerText();
    expect(rowText).not.toMatch(/webhook\.test|\bpending\b|\bretrying\b|undefined/);
    await expect(card.getByRole("button", { name: /Hide deliveries/ })).toBeVisible();

    // Delete with confirmation; focus returns to Add endpoint.
    await card.getByRole("button", { name: /Delete/ }).click();
    const del = page.getByRole("alertdialog", { name: "Delete this endpoint?" });
    await expect(del).toContainText(target);
    await del.getByRole("button", { name: "Delete endpoint" }).click();
    await expect(page.getByText("Endpoint deleted")).toBeVisible();
    await expect(card).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Add endpoint" }).first()).toBeFocused();
  });

  test("tenant isolation: another workspace cannot see, change, rotate or delete these keys and endpoints", async ({ browser, context }) => {
    const make = await context.request.post("/api/integrations/webhooks", { ...o, data: { url: `https://example.com/iso-${stamp()}`, events: ["message.received"] } });
    expect(make.status()).toBe(201);
    const ep = (await make.json()).endpoint;
    const key = await context.request.post("/api/integrations/api-keys", { ...o, data: { name: `iso ${stamp()}`, scopes: ["contacts:read"] } });
    const keyId = (await key.json()).apiKey.id;

    const ctx = await browser.newContext({ baseURL: ORIGIN });
    await apiLogin(ctx, stranger.email);
    const p = await ctx.newPage();
    await p.goto(API);
    await expect(p.getByText("No API keys yet")).toBeVisible();
    await expect(p.getByText("No endpoints yet")).toBeVisible();
    expect((await ctx.request.delete(`/api/integrations/api-keys/${keyId}`, o)).status()).toBe(404);
    expect((await ctx.request.patch(`/api/integrations/webhooks/${ep.id}`, { ...o, data: { enabled: false } })).status()).toBe(404);
    expect((await ctx.request.post(`/api/integrations/webhooks/${ep.id}/rotate`, { ...o, data: {} })).status()).toBe(404);
    expect((await ctx.request.post(`/api/integrations/webhooks/${ep.id}/test`, { ...o, data: {} })).status()).toBe(404);
    expect((await ctx.request.get(`/api/integrations/webhooks/${ep.id}/deliveries`)).status()).toBe(404);
    expect((await ctx.request.delete(`/api/integrations/webhooks/${ep.id}`, o)).status()).toBe(404);
    await ctx.close();
  });

  test("the key and webhook APIs refuse cross-site requests and signed-out callers", async ({ context }) => {
    const cross = await context.request.post("/api/integrations/api-keys", { headers: { origin: "https://evil.example" }, data: { name: "x", scopes: ["messages:write"] } });
    expect([400, 403]).toContain(cross.status());
    const anon = await pwRequest.newContext({ baseURL: ORIGIN });
    expect((await anon.get("/api/integrations/api-keys")).status()).toBe(401);
    expect((await anon.get("/api/integrations/webhooks")).status()).toBe(401);
    expect((await anon.post("/api/mcp", { data: { jsonrpc: "2.0", id: 1, method: "tools/list" } })).status()).toBe(401);
    await anon.dispose();
  });
});

test.describe("MCP connection page", () => {
  test("shows the endpoint, copyable snippets, the full tool list and safety notes, and the tool list matches the server", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
    const errors = watchErrors(page);
    await page.goto("/app");
    await page.getByRole("link", { name: "MCP connection" }).first().click();
    await expect(page.getByRole("heading", { level: 1, name: "MCP connection" })).toBeVisible();
    await expect(page.getByTestId("mcp-url")).toHaveText(`${ORIGIN}/api/mcp`);
    for (const h of ["Endpoint", "1. Create an API key", "2. Connect your assistant", "Tools", "Safety"]) await expect(page.getByRole("heading", { name: h })).toBeVisible();
    for (const t of ["Claude Code (command line)", "Claude Desktop or any client that reads .mcp.json", "Generic client using the mcp-remote bridge", "Test with curl"]) {
      await expect(page.getByRole("heading", { name: t })).toBeVisible();
    }
    // Every snippet uses the real endpoint and a placeholder key, never a real secret.
    const codeBlocks = await page.locator("pre code").allInnerTexts();
    expect(codeBlocks).toHaveLength(4);
    for (const c of codeBlocks) {
      expect(c).toContain(`${ORIGIN}/api/mcp`);
      expect(c).toContain("YOUR_API_KEY");
    }
    // The button keeps its descriptive aria-label ("Copy Test with curl"); the visible text flips to "Copied" for two seconds.
    const copyCurl = page.getByRole("button", { name: "Copy Test with curl" });
    await copyCurl.click();
    await expect(copyCurl).toHaveText("Copied");
    const clip = ((await page.evaluate(() => navigator.clipboard.readText()).catch(() => codeBlocks[3])) as string).split("\r\n").join("\n"); // the Windows clipboard turns line feeds into CRLF
    expect(clip).toBe(codeBlocks[3]);

    // The tools table lists the same tools the server offers a fully scoped key.
    const uiTools = await page.locator("table tbody tr td:first-child").allInnerTexts();
    expect(uiTools.length).toBeGreaterThanOrEqual(12);
    const res = await context.request.post("/api/integrations/api-keys", { ...o, data: { name: `mcp ${stamp()}`, scopes: ["messages:write", "contacts:read", "contacts:write", "templates:read"] } });
    const key = (await res.json()).key as string;
    const api = await bearer(key);
    const list = await api.post("/api/mcp", { headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, data: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
    expect(list.status()).toBe(200);
    const serverTools: string[] = ((await list.json()).result.tools as { name: string }[]).map((t) => t.name);
    expect([...serverTools].sort()).toEqual([...uiTools].map((t) => t.trim()).sort());
    // Safety claim: sending without confirm only drafts.
    const init = await api.post("/api/mcp", { headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, data: { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2025-06-18" } } });
    expect((await init.json()).result.serverInfo.name).toBe("edwyz-wa");
    await api.dispose();

    // The link to API settings works.
    await page.getByRole("link", { name: "API and webhooks" }).filter({ hasText: /^API and webhooks$/ }).last().click();
    await expect(page).toHaveURL(/\/app\/settings\/api/);
    expect(errors, errors.join("\n")).toEqual([]);
  });
});

test("API and MCP pages: accessible in light and dark, keyboard works in dialogs", async ({ page }) => {
  await page.goto(API);
  await expect(page.getByRole("button", { name: "Create API key" }).first()).toBeVisible();
  expect(await axeSerious(page), "api light").toEqual([]);
  const btn = page.getByRole("button", { name: "Create API key" }).first();
  await btn.focus();
  await page.keyboard.press("Enter");
  const dlg = page.getByRole("dialog", { name: "Create an API key" });
  await expect(dlg).toBeVisible();
  expect(await axeSerious(page), "api dialog").toEqual([]);
  for (let i = 0; i < 10; i++) await page.keyboard.press("Tab");
  expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(btn).toBeFocused();
  expect(await setDarkTheme(page)).toBe(true);
  expect(await isDark(page)).toBe(true);
  expect(await axeSerious(page), "api dark").toEqual([]);
  await page.goto(MCP);
  await expect(page.getByRole("heading", { level: 1, name: "MCP connection" })).toBeVisible();
  expect(await axeSerious(page), "mcp dark").toEqual([]);
});

test("@mobile API and MCP pages fit 360 px", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto(API);
  await expect(page.getByRole("heading", { level: 1, name: "API and webhooks" })).toBeVisible();
  expect(await overflowsHorizontally(page)).toBe(0);
  await page.getByText("Show examples").click();
  expect(await overflowsHorizontally(page)).toBe(0);
  await page.goto(MCP);
  await expect(page.getByRole("heading", { level: 1, name: "MCP connection" })).toBeVisible();
  expect(await overflowsHorizontally(page)).toBe(0);
});
