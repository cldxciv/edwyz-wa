import { createHmac } from "node:crypto";
import { expect, type APIRequestContext, type BrowserContext, type Cookie, type Page, type TestType } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { connectFakeNumber, db, ORIGIN, PASSWORD, signupUser, stamp, tick, type TestUser } from "./helpers";

export type Fixture = { user: TestUser; fx: Awaited<ReturnType<typeof connectFakeNumber>> };

/** A signed-in owner with a connected fake number. */
export async function setupOwner(context: BrowserContext, label = "inbox"): Promise<Fixture> {
  const user = await signupUser(context, label);
  const fx = await connectFakeNumber(user.tenantId);
  return { user, fx };
}

export const phoneFor = (n: number) => `1555${String(Date.now()).slice(-5)}${String(n).padStart(2, "0")}`;

export const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();

type Raw = Record<string, unknown>;

/** Delivers any inbound message object through the signed webhook (timestamp defaults to now). */
export async function deliverRaw(request: APIRequestContext, f: Fixture, from: string, message: Raw, name = "UAT Customer", ageMs = 0) {
  const value = {
    messaging_product: "whatsapp",
    metadata: { display_phone_number: "15550001", phone_number_id: f.fx.phoneNumberId },
    contacts: [{ profile: { name }, wa_id: from }],
    messages: [{ from, id: `wamid.${stamp()}`, timestamp: String(Math.floor((Date.now() - ageMs) / 1000)), ...message }],
  };
  const body = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: f.fx.wabaId, changes: [{ field: "messages", value }] }] });
  const sig = `sha256=${createHmac("sha256", process.env.META_APP_SECRET ?? "").update(body).digest("hex")}`;
  const res = await request.post("/webhooks/whatsapp", { headers: { "content-type": "application/json", "x-hub-signature-256": sig }, data: body });
  if (!res.ok()) throw new Error(`webhook failed ${res.status()}`);
}

export async function conversationIdFor(request: APIRequestContext, f: Fixture, from: string): Promise<string> {
  const d = await db();
  for (let i = 0; i < 40; i++) {
    const r = await d.query(`select c.id from "Conversation" c join "Contact" k on k.id = c."contactId" where c."tenantId" = $1 and k.phone = $2`, [f.user.tenantId, `+${from}`]);
    if (r.rows[0]) return r.rows[0].id as string;
    await tick(request, 1);
    await new Promise((res) => setTimeout(res, 300));
  }
  throw new Error(`conversation for ${from} never appeared`);
}

/** Delivers an inbound text through the signed webhook, runs the worker, returns the conversation id. */
export async function seedChat(request: APIRequestContext, f: Fixture, from: string, text: string, name = "UAT Customer", ageMs = 0): Promise<string> {
  await deliverRaw(request, f, from, { type: "text", text: { body: text } }, name, ageMs);
  await tick(request, 3);
  return conversationIdFor(request, f, from);
}

/** Raw column update; timestamps must be passed as ISO strings (the columns are timestamp without time zone, stored as UTC by the app). */
export async function convoSql(id: string, set: string, params: unknown[] = []) {
  const d = await db();
  await d.query(`update "Conversation" set ${set} where id = $${params.length + 1}`, [...params, id]);
}

/** Inserts a raw message row (for media and odd types, or outbound history). */
export async function insertMessage(f: Fixture, conversationId: string, m: { type: string; body?: string | null; mediaUrl?: string | null; mediaMime?: string | null; direction?: "inbound" | "outbound"; status?: string; createdAt?: string; errorCode?: string | null }) {
  const d = await db();
  const id = `msg${stamp()}`;
  await d.query(
    `insert into "Message" (id, "tenantId", "conversationId", wamid, direction, type, body, "mediaUrl", "mediaMime", status, "errorCode", "createdAt") values ($1,$2,$3,$4,$5::"MessageDirection",$6,$7,$8,$9,$10::"MessageStatus",$11,$12::timestamp)`,
    [id, f.user.tenantId, conversationId, `wamid.${id}`, m.direction ?? "inbound", m.type, m.body ?? null, m.mediaUrl ?? null, m.mediaMime ?? null, m.status ?? "received", m.errorCode ?? null, m.createdAt ?? iso()],
  );
  return id;
}

/** Opens the inbox. With viaLink it goes through the dashboard and the sidebar like a real person (dismissing the one-time welcome). */
export async function openInbox(page: Page, opts: { viaLink?: boolean } = {}) {
  if (opts.viaLink) {
    await page.goto("/app");
    const welcome = page.getByRole("dialog", { name: /welcome/i });
    const shown = await welcome.waitFor({ state: "visible", timeout: 10_000 }).then(() => true, () => false);
    if (shown) {
      await page.keyboard.press("Escape");
      await expect(welcome).toBeHidden();
    }
    await page.getByRole("link", { name: /^inbox/i }).first().click();
  } else {
    await page.goto("/app/inbox");
  }
  await expect(page).toHaveURL(/\/app\/inbox/);
  await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();
}

export const convoButton = (page: Page, text: string | RegExp) => page.locator("[data-conversation]").filter({ hasText: text }).first();

export async function openChat(page: Page, text: string | RegExp) {
  await convoButton(page, text).click();
  await expect(page.getByRole("log", { name: "Messages" })).toBeVisible();
}

export async function axeSerious(page: Page, label: string, opts: { exclude?: string[] } = {}) {
  let b = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]);
  for (const x of opts.exclude ?? []) b = b.exclude(x);
  const r = await b.analyze();
  return r.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${label}: ${v.id} (${v.impact}) ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
}

/** Creates an agent in the owner's workspace through the real invite flow, returns a context-less login. */
export async function inviteAgent(ownerContext: BrowserContext, f: Fixture, label = "agent") {
  const email = `${label}+${stamp()}@example.com`;
  const res = await ownerContext.request.post("/api/workspace/invites", { headers: { origin: ORIGIN }, data: { email, role: "agent" } });
  if (!res.ok()) throw new Error(`invite failed ${res.status()} ${await res.text()}`);
  const { acceptUrl } = await res.json();
  const token = new URL(acceptUrl).searchParams.get("token")!;
  return { email, token, name: `Agent ${label}` };
}

export async function acceptInvite(context: BrowserContext, inv: { token: string; name: string }) {
  const res = await context.request.post("/api/auth/accept-invite", { headers: { origin: ORIGIN }, data: { token: inv.token, name: inv.name, password: PASSWORD } });
  if (!res.ok()) throw new Error(`accept failed ${res.status()} ${await res.text()}`);
  return (await res.json()) as { user: { id: string }; tenantId: string; role: string };
}

export async function setTheme(page: Page, theme: "dark" | "light") {
  const dark = await page.evaluate(() => document.documentElement.dataset.theme === "dark");
  if ((theme === "dark") !== dark) await page.getByRole("button", { name: /switch to (dark|light) theme/i }).first().click();
}

export { createHmac };

/** Playwright gives every test a fresh browser context; this carries the signed-in cookies from test to test. */
export function sharedSession() {
  const state: { cookies: Cookie[] } = { cookies: [] };
  return {
    save: async (context: BrowserContext) => {
      const c = await context.cookies();
      if (c.length) state.cookies = c;
    },
    restore: async (context: BrowserContext) => {
      if (state.cookies.length) await context.addCookies(state.cookies);
    },
    hook(t: TestType<any, any>) {
      t.beforeEach(async ({ context }) => this.restore(context));
      t.afterEach(async ({ context }) => this.save(context));
    },
  };
}
