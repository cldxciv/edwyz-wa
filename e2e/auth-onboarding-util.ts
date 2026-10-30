import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import { db, stamp } from "./helpers";

export const sha = (t: string) => createHash("sha256").update(t).digest("hex");

/** Serious and critical axe violations as readable strings (rule id + selector). */
export async function axeSerious(page: Page, label: string, exclude: string[] = []): Promise<string[]> {
  let b = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]);
  for (const e of exclude) b = b.exclude(e);
  const res = await b.analyze();
  return res.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `[${label}] ${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")} :: ${v.help}`);
}

export async function noHorizontalOverflow(page: Page, label: string) {
  const w = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  expect(w.sw, `${label}: page scrolls horizontally (${w.sw} > ${w.cw})`).toBeLessThanOrEqual(w.cw + 1);
}

export async function createEmailTokenRow(userId: string, kind: "verify" | "reset", opts: { expired?: boolean } = {}) {
  const d = await db();
  const token = randomBytes(32).toString("base64url");
  await d.query(`insert into "EmailToken" (id, "userId", kind, "tokenHash", "expiresAt") values ($1,$2,$3,$4,$5)`, [
    `et_${stamp()}`,
    userId,
    kind,
    sha(token),
    new Date(Date.now() + (opts.expired ? -60_000 : 3_600_000)).toISOString(),
  ]);
  return token;
}

export async function createInviteRow(tenantId: string, email: string, role: "admin" | "agent", opts: { expired?: boolean } = {}) {
  const d = await db();
  const token = randomBytes(32).toString("base64url");
  await d.query(`insert into "Invite" (id, "tenantId", email, role, "tokenHash", "expiresAt") values ($1,$2,$3,$4,$5,$6)`, [
    `inv_${stamp()}`,
    tenantId,
    email,
    role,
    sha(token),
    new Date(Date.now() + (opts.expired ? -60_000 : 7 * 86_400_000)).toISOString(),
  ]);
  return token;
}

import type { Browser, BrowserContext } from "@playwright/test";
import { ORIGIN, signupUser, type TestUser } from "./helpers";

/** Marks the first-run welcome dialog as already seen for this user so it does not cover other tests. */
export async function skipWelcome(ctx: BrowserContext, userId: string) {
  await ctx.addInitScript((key) => {
    try {
      localStorage.setItem(key, "seen");
    } catch {
      /* ignore */
    }
  }, `edwyz.welcome.v1.${userId}`);
}

/** A second person who is a member of someone else's workspace with the given role (no login rate limit used). */
export async function joinWorkspace(browser: Browser, tenantId: string, role: "admin" | "agent", label = "member") {
  const context = await browser.newContext();
  const user = await signupUser(context, label);
  const d = await db();
  await d.query(`insert into "Membership" (id, "tenantId", "userId", role) values ($1,$2,$3,$4)`, [`m_${stamp()}`, tenantId, user.userId, role]);
  const res = await context.request.post("/api/auth/switch-workspace", { headers: { origin: ORIGIN }, data: { tenantId } });
  if (!res.ok()) throw new Error(`switch failed ${res.status()} ${await res.text()}`);
  await skipWelcome(context, user.userId);
  return { context, user: user as TestUser };
}

import type { Locator } from "@playwright/test";
/** role=alert elements that belong to the app (Next adds its own hidden route announcer with role=alert). */
export const alerts = (scope: Page | Locator) => scope.locator('[role="alert"]:not(#__next-route-announcer__)');

/** A throwaway client IP so UI/API signups do not drain this runner's 8-per-hour signup bucket (the production proxy overwrites the header). */
export const freshIp = () => `10.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`;
