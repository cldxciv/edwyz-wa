import AxeBuilder from "@axe-core/playwright";
import { expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { db, signupUser, stamp, type TestUser } from "./helpers";

/** Serious and critical axe violations as readable strings (rule id + selector). */
export async function axeSerious(page: Page, label: string, exclude: string[] = []): Promise<string[]> {
  let b = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]);
  // Known app-shell finding (Workspace/Account top bar buttons: label-content-name-mismatch), reported separately; not this area's page.
  for (const e of [...exclude, 'button[aria-label="Workspace"]', 'button[aria-label="Account"]']) b = b.exclude(e);
  // Theme changes fade colours; scanning mid-fade reads blended colours and reports false contrast failures.
  await page.waitForTimeout(400);
  const res = await b.analyze();
  return res.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `[${label}] ${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => `${n.target.join(" ")} ${n.html.slice(0, 120)}`).join(" | ")} :: ${v.help}`);
}

export async function noHorizontalOverflow(page: Page, label: string) {
  const w = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  expect(w.sw, `${label}: page scrolls horizontally (${w.sw} > ${w.cw})`).toBeLessThanOrEqual(w.cw + 1);
}

/** Switches to the dark theme using the visible toggle (no-op if already dark). */
export async function goDark(page: Page) {
  const toDark = page.getByRole("button", { name: "Switch to dark theme" }).first();
  if (await toDark.isVisible().catch(() => false)) await toDark.click();
  else {
    // mobile: the toggle lives in the drawer the "More" tab opens (the first /menu/ button is the account menu, which has none)
    const more = page.getByRole("button", { name: "More", exact: true });
    if (await more.isVisible().catch(() => false)) await more.click();
    else await page.getByRole("button", { name: /menu/i }).first().click().catch(() => undefined);
    await page.getByRole("button", { name: "Switch to dark theme" }).first().click().catch(() => undefined);
    await page.keyboard.press("Escape");
  }
}

export async function isDark(page: Page) {
  return page.evaluate(() => {
    const el = document.documentElement;
    return el.classList.contains("dark") || el.dataset.theme === "dark" || getComputedStyle(el).colorScheme === "dark";
  });
}

const welcomeHandled = new WeakSet<Page>();

/**
 * The first-run welcome dialog opens on the dashboard for a brand-new person and blocks clicks behind it; close it like a user would.
 * It opens when the page hydrates, which on a slow first load can be well after the short wait below; then a one-time locator
 * handler closes it whenever it shows up before a later click or assertion.
 */
export async function dismissWelcome(page: Page) {
  const welcome = page.getByRole("dialog", { name: /^Welcome/ });
  const close = welcome.getByRole("button", { name: /I will explore first|Got it/ });
  const handled = welcomeHandled.has(page);
  if (await welcome.waitFor({ state: "visible", timeout: 4000 }).then(() => true, () => false)) {
    // A handler left by an earlier call runs before any click or assertion and closes it, so click only when there is none.
    if (!handled) await close.click();
    await expect(welcome).toBeHidden();
  } else if (!handled) {
    // not shown (already seen), or not yet
    welcomeHandled.add(page);
    await page.addLocatorHandler(welcome, () => close.click(), { times: 1 });
  }
}

/** Opens a sidebar page by clicking its link like a user would. */
export async function openFromNav(page: Page, label: string, urlPart: RegExp) {
  await page.goto("/app");
  await dismissWelcome(page);
  const link = page.getByRole("navigation").getByRole("link", { name: label, exact: true }).first();
  await link.click();
  await page.waitForURL(urlPart);
}

export async function seedContact(tenantId: string, c: { phone: string; name?: string; tags?: string[]; optIn?: boolean; source?: string; optedOut?: boolean }) {
  const d = await db();
  const id = `ct_${stamp()}`;
  await d.query(
    `insert into "Contact" (id, "tenantId", phone, name, tags, "optIn", "optInSource", "optInAt", "optedOutAt", attributes) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'{}')`,
    [id, tenantId, c.phone, c.name ?? null, c.tags ?? [], c.optIn ?? false, c.optIn ? (c.source ?? "uat fixture") : null, c.optIn ? new Date() : null, c.optedOut ? new Date() : null],
  );
  return id;
}

/** An approved template fixture on the tenant's first WABA. */
export async function seedTemplate(
  tenantId: string,
  wabaRef: string,
  t: { name?: string; status?: "approved" | "draft" | "pending" | "rejected" | "paused"; category?: string; body?: string; language?: string; rejectionReason?: string; components?: unknown[] } = {},
) {
  const d = await db();
  const id = `tpl_${stamp()}`;
  const name = t.name ?? `uat_tpl_${stamp()}`;
  const components = t.components ?? [{ type: "BODY", text: t.body ?? "Hello, this is a test offer from UAT." }];
  await d.query(
    `insert into "Template" (id, "tenantId", "wabaRefId", name, language, category, status, components, "rejectionReason", "updatedAt") values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9, now())`,
    [id, tenantId, wabaRef, name, t.language ?? "en_US", t.category ?? "MARKETING", t.status ?? "approved", JSON.stringify(components), t.rejectionReason ?? null],
  );
  return { id, name };
}

/** Adds a second user to the owner's workspace with the given role and returns a context signed in as them. */
export async function agentContext(browser: Browser, ownerTenantId: string, role: "agent" | "admin" = "agent"): Promise<{ context: BrowserContext; page: Page; user: TestUser }> {
  const context = await browser.newContext();
  const user = await signupUser(context, "agent");
  const d = await db();
  await d.query(`delete from "Membership" where "userId" = $1`, [user.userId]);
  await d.query(`insert into "Membership" (id, "tenantId", "userId", role) values ($1,$2,$3,$4::"Role")`, [`m_${stamp()}`, ownerTenantId, user.userId, role]);
  const page = await context.newPage();
  return { context, page, user };
}
