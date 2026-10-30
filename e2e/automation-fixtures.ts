import AxeBuilder from "@axe-core/playwright";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { db, login, signupUser, stamp, type TestUser } from "./helpers";

/** A fresh owner in a fresh workspace, already signed in inside its own browser context. */
export async function newOwner(browser: Browser, label = "auto") {
  const context = await browser.newContext({ baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3500" });
  const user = await signupUser(context, label);
  const page = await context.newPage();
  return { context, page, user };
}

/** Moves a freshly signed-up user into another workspace as a member with the given role, then signs in as them. */
export async function newMember(browser: Browser, owner: TestUser, role: "agent" | "admin", label = "agent") {
  const context = await browser.newContext({ baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3500" });
  const user = await signupUser(context, label);
  const d = await db();
  await d.query(`UPDATE "Membership" SET "tenantId" = $1, role = $2 WHERE "userId" = $3`, [owner.tenantId, role, user.userId]);
  await context.clearCookies();
  const page = await context.newPage();
  await login(page, user.email);
  return { context, page, user: { ...user, tenantId: owner.tenantId } };
}

export type AxeProblem = { id: string; impact: string | null | undefined; selector: string; summary: string };

/** Serious and critical axe violations on the current page, as short strings with the rule id and selector. */
export async function axeProblems(page: Page, scope?: string, includeShell = false): Promise<string[]> {
  let b = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]);
  // The workspace and account buttons in the top bar are shared by every screen; they are checked once in their own test.
  if (!includeShell) b = b.exclude('button[aria-label="Workspace"]').exclude('button[aria-label="Account"]');
  if (scope) b = b.include(scope);
  const r = await b.analyze();
  return r.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .flatMap((v) => v.nodes.slice(0, 4).map((n) => `${v.id} [${v.impact}] ${n.target.join(" ")} :: ${n.failureSummary?.split("\n")[1]?.trim() ?? v.help} :: ${n.html.slice(0, 200)}`));
}

/** Opens the dashboard and closes the one-time welcome dialog that every new person sees on their first visit. */
export async function enterApp(page: Page) {
  await page.goto("/app");
  await page.getByRole("heading", { level: 1 }).first().waitFor();
  const welcome = page.getByRole("dialog", { name: /welcome/i });
  try {
    await welcome.waitFor({ state: "visible", timeout: 4000 });
    await page.keyboard.press("Escape");
    await welcome.waitFor({ state: "hidden" });
  } catch {
    // no welcome dialog this time
  }
}

export async function toggleTheme(page: Page) {
  await page.getByRole("button", { name: /switch to (dark|light) theme/i }).first().click();
  // Colours fade between themes; wait for the fade to end so a contrast check does not read half-way colours.
  // Only transitions are awaited (spinners and skeletons loop for ever), and never for more than a second.
  await page.evaluate(() =>
    Promise.race([
      Promise.all(document.getAnimations().filter((a) => a instanceof CSSTransition).map((a) => a.finished.catch(() => undefined))),
      new Promise((done) => setTimeout(done, 1000)),
    ]),
  );
  await page.waitForTimeout(150);
}

/** True when the page scrolls sideways (anything wider than the viewport). */
export async function overflowsX(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
}

export async function toastText(page: Page): Promise<string> {
  return (await page.locator('[role="status"], [role="alert"]').allInnerTexts()).join(" | ");
}

export const uniq = (p: string) => `${p} ${stamp()}`;

export type { BrowserContext, TestUser };
