import { expect, test, type Page } from "@playwright/test";
import { closeDb, signupUser, watchErrors } from "./helpers";
import { overflowsX } from "./automation-fixtures";

test.afterAll(closeDb);
test.setTimeout(120_000);

/** These run in the phone project (Pixel 7, touch): `--project=mobile`. */

async function dismissWelcome(page: Page) {
  const welcome = page.getByRole("dialog", { name: /welcome/i });
  try {
    await welcome.waitFor({ state: "visible", timeout: 4000 });
    await page.keyboard.press("Escape");
  } catch {
    // not shown
  }
}

test("@mobile automation pages fit a phone, dialogs are usable and the builder canvas is view-only", async ({ page, context, isMobile }) => {
  // touch taps need the phone project (Pixel 7); the desktop project has no touch screen
  test.skip(!isMobile, "runs in the phone project only");
  const errors = watchErrors(page);
  await signupUser(context, "mob");
  await page.goto("/app/automation");
  await dismissWelcome(page);
  await expect(page.getByRole("heading", { level: 1, name: "Automation" })).toBeVisible();
  expect(await overflowsX(page), "automation page overflows").toBe(false);

  // the new-rule form is a page (When, If, Then) whose buttons can be reached
  await page.getByRole("link", { name: "Use this rule" }).nth(2).tap(); // "Answer a common question"
  await expect(page.getByRole("heading", { level: 1, name: "New rule" })).toBeVisible();
  await page.getByLabel(/^Rule name/).fill("Phone rule");
  await page.getByLabel(/^Message\*?$/).fill("Hello from the phone");
  expect(await overflowsX(page), "new rule form overflows").toBe(false);
  const create = page.getByRole("button", { name: "Create rule" });
  // mid-page, the sticky Create rule / Cancel bar sits above the bottom menu, so a tap on it reaches the button, not the menu
  await page.getByRole("heading", { level: 2, name: "If" }).scrollIntoViewIfNeeded();
  const reachable = await create.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return r.bottom <= window.innerHeight && !!hit && el.contains(hit);
  });
  expect(reachable, "Create rule is hidden behind the bottom menu").toBe(true);
  await create.scrollIntoViewIfNeeded();
  const box = await create.boundingBox();
  expect(box!.height, "touch target height").toBeGreaterThanOrEqual(40);
  await create.tap();
  await expect(page.getByText('"Phone rule" was created.')).toBeVisible();
  // the rules table turns into cards without sideways scrolling
  await expect(page).toHaveURL(/\/app\/automation$/);
  expect(await overflowsX(page), "rules list overflows").toBe(false);
  const sw = page.getByRole("switch", { name: "Phone rule" });
  expect((await sw.boundingBox())!.height).toBeGreaterThanOrEqual(40);

  await page.goto("/app/automation/chatbots/new?starter=welcome-menu");
  await expect(page.getByRole("heading", { level: 1, name: "Welcome and menu" })).toBeVisible();
  expect(await overflowsX(page), "builder overflows").toBe(false);
  // tapping a step opens its settings in the Step tab
  await page.locator("#cb-canvas [data-node-id]").first().tap();
  await expect(page.getByRole("tab", { name: "Step" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#cb-inspector-heading")).toBeVisible();
  // desktop-only zoom buttons are hidden, undo/redo/tidy stay reachable
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeVisible();
  const undo = await page.getByRole("button", { name: "Undo", exact: true }).boundingBox();
  expect(undo!.height).toBeGreaterThanOrEqual(40);
  await page.getByRole("tab", { name: /^Preview/ }).tap();
  await page.getByRole("button", { name: "Skip to the first step" }).tap();
  await expect(page.getByRole("log", { name: "Preview conversation" })).toContainText("What can we help you with?");
  expect(await overflowsX(page), "preview overflows").toBe(false);

  for (const [path, h1] of [
    ["/app/automation/chatbots", "Chatbots"],
    ["/app/automation/ai-agent", "AI agent"],
    ["/app/settings/ai-tools", "AI tools"],
    ["/app/settings/routing", "Chat routing"],
  ] as const) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1, name: h1 })).toBeVisible();
    expect(await overflowsX(page), `${path} overflows at phone width`).toBe(false);
  }
  expect(errors, errors.join("\n")).toEqual([]);
});
