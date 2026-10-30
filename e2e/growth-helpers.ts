import { createCipheriv, randomBytes } from "node:crypto";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { PASSWORD, db, login, signupUser, stamp, type TestUser } from "./helpers";

/** Same envelope as src/lib/crypto/secrets sealSecret (AES-256-GCM, tenant id as AAD). */
export function seal(tenantId: string, plaintext: string): string {
  const key = Buffer.from(process.env.ENCRYPTION_KEY ?? "", "base64");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  c.setAAD(Buffer.from(tenantId, "utf8"));
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return JSON.stringify({ ciphertext: ct.toString("base64"), iv: iv.toString("base64"), authTag: c.getAuthTag().toString("base64"), keyVersion: 2 });
}

/** A Meta connection with the assets the growth screens need. Tokens are fake; no real Meta call is ever made. */
export async function seedMeta(tenant: TestUser, opts: { currency?: string; withPage?: boolean; withDataset?: boolean; status?: string; ig?: boolean } = {}) {
  const d = await db();
  const tag = stamp();
  const connId = `conn_${tag}`;
  await d.query(
    `insert into "MetaConnection" (id,"tenantId","metaUserId",scopes,"tokenEnc",status,"connectedByUserId","updatedAt") values ($1,$2,$3,$4,$5,$6,$7,now())`,
    [connId, tenant.tenantId, `meta_user_${tag}`, ["ads_management", "pages_show_list"], seal(tenant.tenantId, "fake-token"), opts.status ?? "active", tenant.userId],
  );
  const asset = async (type: string, externalId: string, name: string, meta: object = {}) => {
    const id = `asset_${type}_${tag}`;
    await d.query(`insert into "MetaAsset" (id,"tenantId","connectionId",type,"externalId",name,"tokenEnc",status,meta,"updatedAt") values ($1,$2,$3,$4,$5,$6,$7,'active',$8,now())`, [id, tenant.tenantId, connId, type, externalId, name, seal(tenant.tenantId, "fake-token"), JSON.stringify(meta)]);
    return { id, externalId, name };
  };
  const adAccount = await asset("ad_account", `act_${tag}`, `Sunrise Realty Ads ${tag.slice(-4)}`, { currency: opts.currency ?? "INR" });
  const page = opts.withPage === false ? null : await asset("page", `page_${tag}`, `Sunrise Realty Page ${tag.slice(-4)}`);
  const ig = opts.ig ? await asset("instagram", `ig_${tag}`, `sunrise_realty_${tag.slice(-4)}`) : null;
  const dataset = opts.withDataset ? await asset("dataset", `ds_${tag}`, `Sunrise pixel ${tag.slice(-4)}`) : null;
  return { connId, adAccount, page, ig, dataset };
}

/** Creates a second user who is an agent (lowest role) in the given workspace, and returns their login details. */
export async function createAgent(browser: Browser, owner: TestUser): Promise<TestUser> {
  const ctx = await browser.newContext();
  const agent = await signupUser(ctx, "agent");
  await ctx.close();
  const d = await db();
  await d.query(`delete from "Membership" where "userId" = $1`, [agent.userId]);
  await d.query(`insert into "Membership" (id,"tenantId","userId",role) values ($1,$2,$3,'agent')`, [`m_${stamp()}`, owner.tenantId, agent.userId]);
  return { ...agent, tenantId: owner.tenantId };
}

export async function loginFresh(browser: Browser, email: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await login(page, email, PASSWORD);
  return { context, page };
}

/** ceil(1.75 x C) in whole minor units: the ads daily limit for daily budgets adding up to C (docs/SPEND-CONTROLS-SPEC.md 4.5, 4.8). */
export const ceil175 = (c: number) => Math.floor((7 * c + 3) / 4);

/**
 * The CapPanel's number C ("the most your daily budgets may add up to"), stored the way PUT /api/ads/caps stores it: the ads
 * daily limit ceil175(C) in SpendAllowance (GET answers floor(4L/7) = C again), plus the legacy key the previous build reads.
 * A monthly limit below the new daily limit is cleared, as the database requires daily <= monthly.
 */
export async function setCap(tenant: TestUser, max: number, currency = "INR") {
  const d = await db();
  const value = { maxDailyBudgetMinor: max, currency, exponent: 2 };
  await d.query(
    `insert into "SpendAllowance" (id,"tenantId",pot,currency,"dailyLimitMinor","monthlyLimitMinor",version,"createdAt","updatedAt")
     values ($1,$2,'ads',$3,$4,null,1,now(),now())
     on conflict ("tenantId",pot) do update set currency = excluded.currency, "dailyLimitMinor" = excluded."dailyLimitMinor",
       "monthlyLimitMinor" = case when "SpendAllowance".currency = excluded.currency and ("SpendAllowance"."monthlyLimitMinor" is null or "SpendAllowance"."monthlyLimitMinor" >= excluded."dailyLimitMinor") then "SpendAllowance"."monthlyLimitMinor" else null end,
       version = "SpendAllowance".version + 1, "updatedAt" = now()`,
    [`sa_${stamp()}`, tenant.tenantId, currency, String(ceil175(max))],
  );
  await d.query(`insert into "PlatformSetting" (key,value,"updatedAt") values ($1,$2,now()) on conflict (key) do update set value = excluded.value`, [`ads:caps:${tenant.tenantId}`, JSON.stringify(value)]);
}

/** Serious and critical axe violations on the current page, formatted for an assertion message. */
export async function axeSerious(page: Page, include?: string): Promise<string[]> {
  let b = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]);
  if (include) b = b.include(include);
  const res = await b.analyze();
  // The workspace switcher in the app shell fails label-content-name-mismatch on every page; it is covered by one dedicated test
  // (growth-connections: "app shell") so it does not drown out page-level findings.
  // axe reports a CSS selector (".px-2"), so the match has to be made on the node's own HTML, not on its target.
  // The account menu button has the same defect (aria-label "Account" while the visible text is the user's initials).
  const shell = (html: string) => /aria-label="(Workspace|Account)"/.test(html);
  return res.violations
    .map((v) => ({ v, nodes: v.nodes.filter((n) => !(v.id === "label-content-name-mismatch" && shell(n.html))) }))
    .filter(({ v, nodes }) => (v.impact === "serious" || v.impact === "critical") && nodes.length > 0)
    .map(({ v, nodes }) => `${v.id} (${v.impact}): ${nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
}

/** True when the page scrolls sideways. */
export async function overflowsX(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
}

export async function toggleTheme(page: Page) {
  await page.getByRole("button", { name: /switch to (dark|light) theme/i }).first().click();
}

/** A confirmation question. Destructive ones are exposed as role=alertdialog, the rest as role=dialog. */
export function askDialog(page: Page, hasText?: string | RegExp) {
  const any = page.locator('[role="dialog"], [role="alertdialog"]');
  return hasText ? any.filter({ hasText }) : any;
}
