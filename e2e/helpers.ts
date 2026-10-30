import { createHmac } from "node:crypto";
import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";
import pg from "pg";

process.loadEnvFile?.(".env");

export const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3500";
export const ORIGIN = new URL(BASE).origin;
export const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;
export const PASSWORD = "correct horse battery";

let client: pg.Client | null = null;
/** Direct database access for fixtures. Only valid against a local instance (localhost). */
export async function db(): Promise<pg.Client> {
  if (!/localhost|127\.0\.0\.1/.test(BASE)) throw new Error("db fixtures are only allowed against a local instance");
  if (!client) {
    client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
  }
  return client;
}

export type TestUser = { email: string; name: string; workspace: string; tenantId: string; userId: string };

/** Signs up through the real API (cookies land in the browser context), marks the email verified, returns ids. */
export async function signupUser(context: BrowserContext, label = "uat"): Promise<TestUser> {
  const id = stamp();
  const email = `${label}+${id}@example.com`.toLowerCase(); // the API normalises emails to lower case
  const name = `Tester ${label}`;
  const workspace = `${label} workspace ${id}`;
  // A distinct client IP per signup keeps the 8-per-hour signup limit from throttling the suite (the production proxy overwrites this header).
  const ip = `10.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`;
  const res = await context.request.post("/api/auth/signup", { headers: { origin: ORIGIN, "x-real-ip": ip }, data: { name, email, password: PASSWORD, workspaceName: workspace } });
  if (!res.ok()) throw new Error(`signup failed: ${res.status()} ${await res.text()}`);
  const d = await db();
  await d.query(`UPDATE "User" SET "emailVerifiedAt" = now() WHERE email = $1`, [email]);
  const row = (await d.query(`select u.id as "userId", m."tenantId" from "User" u join "Membership" m on m."userId" = u.id where u.email = $1`, [email])).rows[0];
  return { email, name, workspace, tenantId: row.tenantId, userId: row.userId };
}

export async function login(page: Page, email: string, password = PASSWORD) {
  await page.goto("/login");
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/^password/i).fill(password);
  await page.getByRole("button", { name: /sign in|log in/i }).click();
  await page.waitForURL(/\/app/);
}

/** A connected WhatsApp number fixture (no real Meta account; sends end as failed, which is expected). */
export async function connectFakeNumber(tenantId: string) {
  const d = await db();
  const tag = stamp();
  const wabaRef = `waba_${tag}`;
  const pnRef = `pn_${tag}`;
  await d.query(`insert into "Waba" (id, "tenantId", "wabaId") values ($1,$2,$3)`, [wabaRef, tenantId, `WABA_${tag}`]);
  await d.query(
    `insert into "PhoneNumber" (id, "tenantId", "wabaRefId", "phoneNumberId", "displayPhone", status, "qualityRating", "messagingLimitTier") values ($1,$2,$3,$4,$5,'connected','GREEN','TIER_250')`,
    [pnRef, tenantId, wabaRef, `PN_${tag}`, "+15550001"],
  );
  return { wabaRef, pnRef, wabaId: `WABA_${tag}`, phoneNumberId: `PN_${tag}` };
}

export async function deliverInbound(request: APIRequestContext, fx: { wabaId: string; phoneNumberId: string }, from: string, text: string, name = "UAT Customer") {
  const value = {
    messaging_product: "whatsapp",
    metadata: { display_phone_number: "15550001", phone_number_id: fx.phoneNumberId },
    contacts: [{ profile: { name }, wa_id: from }],
    messages: [{ from, id: `wamid.${stamp()}`, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text } }],
  };
  const body = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: fx.wabaId, changes: [{ field: "messages", value }] }] });
  const sig = `sha256=${createHmac("sha256", process.env.META_APP_SECRET ?? "").update(body).digest("hex")}`;
  const res = await request.post("/webhooks/whatsapp", { headers: { "content-type": "application/json", "x-hub-signature-256": sig }, data: body });
  if (!res.ok()) throw new Error(`webhook failed ${res.status()}`);
}

export async function tick(request: APIRequestContext, times = 2) {
  // A pass that finds the scheduled sweeps due (usage alerts walk 100 workspaces, quality alerts 500 numbers) takes 3-13 s here and 21 s under suite load, so the 15 s action timeout is too tight.
  for (let i = 0; i < times; i++) await request.post("/api/internal/tick", { headers: { "x-worker-secret": process.env.WORKER_SECRET ?? "" }, timeout: 60_000 });
}

/** Collects console errors and failed requests so every test can assert a clean page. */
export function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/favicon|Failed to load resource.*(401|403|404|503)/i.test(m.text())) errors.push(`console: ${m.text()}`);
  });
  page.on("requestfailed", (r) => {
    const reason = r.failure()?.errorText ?? "";
    if (/ERR_ABORTED/.test(reason) || /[?&]_rsc=/.test(r.url())) return;
    if (!/\/_next\/|analytics|connect\.facebook\.net/.test(r.url())) errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`);
  });
  return errors;
}

export async function closeDb() {
  if (client) await client.end();
  client = null;
}
