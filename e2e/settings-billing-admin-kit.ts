import AxeBuilder from "@axe-core/playwright";
import { request as pwRequest, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { ORIGIN, PASSWORD, db, signupUser, stamp, type TestUser } from "./helpers";

/** Serious and critical axe violations as "rule-id: selector" strings. */
export async function axeSerious(page: Page, opts: { includeShell?: boolean } = {}): Promise<string[]> {
  let builder = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]);
  // The workspace switcher and account buttons in the app header are reported once by a dedicated test (settings-billing-admin-team.spec.ts).
  if (!opts.includeShell) builder = builder.exclude('button[aria-label="Workspace"]').exclude('button[aria-label="Account"]');
  const results = await builder.analyze();
  return results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
}

/** Switches theme through the visible toggle if it is reachable; returns false when no toggle is reachable. */
export async function setDarkTheme(page: Page): Promise<boolean> {
  const toDark = page.getByRole("button", { name: "Switch to dark theme" }).first();
  if (await toDark.isVisible().catch(() => false)) {
    await toDark.click();
    return true;
  }
  // On small screens the toggle may sit in the menu.
  const menu = page.getByRole("button", { name: /open menu|menu/i }).first();
  if (await menu.isVisible().catch(() => false)) {
    await menu.click();
    const t = page.getByRole("button", { name: "Switch to dark theme" }).first();
    if (await t.isVisible().catch(() => false)) {
      await t.click();
      await page.keyboard.press("Escape");
      return true;
    }
  }
  return false;
}

export async function isDark(page: Page): Promise<boolean> {
  return (await page.evaluate(() => document.documentElement.dataset.theme)) === "dark";
}

/** True when the page scrolls sideways (anything wider than the viewport). */
export async function overflowsHorizontally(page: Page): Promise<number> {
  return page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth));
}

/** Raw enum-looking or stack-trace-looking text that must never be visible to a customer. */
export const RAW_LEAKS = /\b(undefined|NaN|\[object Object\]|TypeError|ReferenceError|at\s+\S+\s+\(.*:\d+:\d+\)|PrismaClient|ECONN\w+|stack trace)\b/;

/** Creates an invite as the (already signed in) owner context and returns the accept link. */
export async function createInvite(owner: BrowserContext, email: string, role: "agent" | "admin"): Promise<string> {
  const res = await owner.request.post("/api/workspace/invites", { headers: { origin: ORIGIN }, data: { email, role } });
  if (!res.ok()) throw new Error(`invite failed ${res.status()} ${await res.text()}`);
  return (await res.json()).acceptUrl as string;
}

/** A second signed-in teammate in the owner's workspace with the given role, in its own browser context. */
export async function joinAsTeammate(browser: Browser, owner: BrowserContext, role: "agent" | "admin", label = "mate") {
  const email = `${label}+${stamp()}@example.com`;
  const acceptUrl = await createInvite(owner, email, role);
  const token = new URL(acceptUrl).searchParams.get("token")!;
  const context = await browser.newContext({ baseURL: ORIGIN });
  const name = `Mate ${label}`;
  const res = await context.request.post("/api/auth/accept-invite", { headers: { origin: ORIGIN, "x-real-ip": randomIp() }, data: { token, name, password: PASSWORD } });
  if (!res.ok()) throw new Error(`accept failed ${res.status()} ${await res.text()}`);
  const d = await db();
  await d.query(`UPDATE "User" SET "emailVerifiedAt" = now() WHERE email = $1`, [email]);
  const row = (await d.query(`select id from "User" where email = $1`, [email])).rows[0];
  return { context, email, name, userId: row.id as string };
}

export async function newOwner(context: BrowserContext, label: string): Promise<TestUser> {
  return signupUser(context, label);
}

/** Collects CSP violation events (enforced and report-only) from the page. Call before navigation. */
export async function trackCsp(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as { __csp: string[] }).__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      const ev = e as SecurityPolicyViolationEvent;
      (window as unknown as { __csp: string[] }).__csp.push(`${ev.disposition} ${ev.violatedDirective} blocked=${ev.blockedURI}`);
    });
  });
  return async (): Promise<string[]> => page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []);
}

/** Creates a verified owner without a browser (fast). Pair with apiLogin to get a signed-in page with test artifacts. */
export async function createOwner(label: string): Promise<TestUser> {
  const api = await pwRequest.newContext({ baseURL: ORIGIN });
  try {
    const id = stamp();
    const email = `${label}+${id}@example.com`;
    const name = `Tester ${label}`;
    const workspace = `${label} workspace ${id}`;
    // A distinct client IP per signup keeps the per-IP signup limit (8 per hour) from throttling the suite.
    const ip = `10.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`;
    const res = await api.post("/api/auth/signup", { headers: { origin: ORIGIN, "x-real-ip": ip }, data: { name, email, password: PASSWORD, workspaceName: workspace } });
    if (!res.ok()) throw new Error(`signup failed: ${res.status()} ${await res.text()}`);
    const d = await db();
    await d.query(`UPDATE "User" SET "emailVerifiedAt" = now() WHERE email = $1`, [email]);
    const row = (await d.query(`select u.id as "userId", m."tenantId" from "User" u join "Membership" m on m."userId" = u.id where u.email = $1`, [email])).rows[0];
    return { email, name, workspace, tenantId: row.tenantId, userId: row.userId };
  } finally {
    await api.dispose();
  }
}

/** Signs a browser context in through the real login API. */
export async function apiLogin(context: BrowserContext, email: string, password = PASSWORD) {
  // A distinct client IP per login keeps the per-IP login limit (30 per 15 minutes) from throttling a long serial run; login limits are not what these specs test.
  const ip = `10.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`;
  const res = await context.request.post("/api/auth/login", { headers: { origin: ORIGIN, "x-real-ip": ip }, data: { email, password } });
  if (!res.ok()) throw new Error(`login failed: ${res.status()} ${await res.text()}`);
  // The one-time first-visit welcome dialog (a modal) is not under test here; mark it as seen so it never covers the page.
  const row = (await (await db()).query(`select id from "User" where email = $1`, [email])).rows[0];
  if (row) await skipWelcome(context, row.id as string);
}

/** Marks the first-run welcome dialog as already seen for this user (same key the app uses). */
async function skipWelcome(ctx: BrowserContext, userId: string) {
  await ctx.addInitScript((key) => {
    try {
      localStorage.setItem(key, "seen");
    } catch {
      /* ignore */
    }
  }, `edwyz.welcome.v1.${userId}`);
}

/** A teammate user created through the invite flow, returned as credentials (log in with apiLogin). */
export async function addTeammate(owner: BrowserContext, role: "agent" | "admin", label = "mate") {
  const email = `${label}+${stamp()}@example.com`;
  const acceptUrl = await createInvite(owner, email, role);
  const token = new URL(acceptUrl).searchParams.get("token")!;
  const api = await pwRequest.newContext({ baseURL: ORIGIN });
  const name = `Mate ${label}`;
  const res = await api.post("/api/auth/accept-invite", { headers: { origin: ORIGIN, "x-real-ip": randomIp() }, data: { token, name, password: PASSWORD } });
  if (!res.ok()) throw new Error(`accept failed ${res.status()} ${await res.text()}`);
  await api.dispose();
  const d = await db();
  await d.query(`UPDATE "User" SET "emailVerifiedAt" = now() WHERE email = $1`, [email]);
  const row = (await d.query(`select id from "User" where email = $1`, [email])).rows[0];
  return { email, name, userId: row.id as string };
}

/** Escapes text for use inside new RegExp(...) (emails contain "+"). */
export const esc = (s: string) => s.split("").map((ch) => (".*+?^${}()|[]\\".includes(ch) ? `\\${ch}` : ch)).join("");

/** A throwaway client IP so per-IP limits (login, sign-up, invite acceptance) are not shared between tests or with other runners. */
export const randomIp = () => `10.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`;
