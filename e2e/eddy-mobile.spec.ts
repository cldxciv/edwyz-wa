import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { axeSerious, noHorizontalOverflow, skipWelcome } from "./auth-onboarding-util";
import { closeDb, signupUser, type TestUser } from "./helpers";

/**
 * Eddy on phones (docs/EDDY-SPEC.md 6.2, 6.13, 9.4 scenarios 10 and 18; EDDY-13 acceptance 9).
 *
 * - 360 and 390 px: the sheet opens from the top bar, axe shows no serious issues, there is no horizontal overflow, and
 *   Send is at least 44 px; in light and dark.
 * - 320 px: the sheet and a card reflow with no horizontal overflow (WCAG 1.4.10); Android Back (page.goBack()) closes
 *   the sheet, keeps the page and keeps the unsent draft.
 * - While the sheet is open, Eddy's own result rows stand in for toasts.
 *
 * Eddy's own endpoints are stubbed with page.route (status and the turn stream), so these run against any server.
 */

test.afterAll(closeDb);

function statusDTO(over: Record<string, unknown> = {}) {
  return {
    state: "ready",
    readOnly: false,
    canEnable: true,
    ownerNames: ["Owner Person"],
    allowance: { usedToday: 0, limitToday: 40, usedMonth: 10, limitMonth: 500, resetsOn: "2026-11-01", memberUsedToday: 0, memberLimitToday: 40 },
    langPref: "auto",
    needsYou: 0,
    demo: false,
    whatsapp: "connected",
    phase: 1,
    firstUse: false,
    spendingStopped: false,
    ...over,
  };
}

type Ev = Record<string, unknown> & { type: string };
const sse = (events: Ev[]) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");

async function setup(page: Page, context: BrowserContext, width: number, events: Ev[] = []): Promise<TestUser> {
  await page.setViewportSize({ width, height: width <= 360 ? 740 : 844 });
  const u = await signupUser(context, "eddyphone");
  await skipWelcome(context, u.userId);
  await page.route("**/api/eddy/status", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(statusDTO()) }));
  await page.route("**/api/eddy/turn", (route) => route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: sse(events) }));
  await page.goto("/app");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  return u;
}

async function openSheet(page: Page) {
  await page.getByRole("banner").getByRole("button", { name: /^Ask Eddy/ }).click();
  const sheet = page.getByRole("dialog", { name: "Eddy" });
  await expect(sheet).toBeVisible();
  return sheet;
}

const NOW = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();

/** A pending card as the stream carries it (its buttons are not pressed here). */
const CARD = {
  actionId: "ar_mobile_1",
  action: "send_text_reply",
  nonce: "n".repeat(43),
  previewHash: "h".repeat(64),
  lang: "en",
  state: "pending",
  createdAt: iso(NOW),
  expiresAt: iso(NOW + 15 * 60_000),
  confirmGuardMs: 600,
  preview: {
    titleKey: "card.send_text_reply.title",
    vars: { name: { $untrusted: "contact_name", text: "Ramesh Kumar Venkataraghavan Subramaniam" } },
    facts: [{ labelKey: "fact.chat", value: { $untrusted: "contact_name", text: "Ramesh Kumar Venkataraghavan Subramaniam" } }],
    message: { kind: "text", body: "Your order ships tomorrow. Tracking: https://example.invalid/averyveryverylongtrackinglinkwithoutanybreakopportunity1234567890" },
    cost: { state: "free", reason: "service_window" },
    warnings: ["contains_link_or_number"],
    editable: [{ field: "text", kind: "text" }],
    confirmLabelKey: "card.send_text_reply.confirm",
    danger: false,
    material: { targetId: "cv1" },
  },
};

test.describe("Eddy on phones @mobile", () => {
  for (const width of [360, 390]) {
    for (const theme of ["light", "dark"] as const) {
      test(`10: ${width} px ${theme}: the sheet opens from the top bar; axe, no overflow, Send and Close are 44 px`, async ({ page, context }) => {
        await setup(page, context, width);
        if (theme === "dark") await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
        const sheet = await openSheet(page);
        const send = sheet.getByRole("button", { name: "Send to Eddy" });
        await expect(send).toBeVisible();
        const box = (await send.boundingBox())!;
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.height).toBeGreaterThanOrEqual(44);
        const close = sheet.getByRole("button", { name: "Close Eddy" });
        expect((await close.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        // The input is 16 px, so iOS does not zoom.
        expect(await sheet.getByRole("textbox", { name: "Message to Eddy" }).evaluate((el) => getComputedStyle(el).fontSize)).toBe("16px");
        await noHorizontalOverflow(page, `Eddy sheet at ${width} ${theme}`);
        const found = await axeSerious(page, `Eddy sheet at ${width} ${theme}`);
        expect(found, found.join("\n")).toEqual([]);
      });
    }
  }

  test("18: at 320 px the sheet and a card reflow without sideways scrolling; Back closes the sheet and keeps the draft", async ({ page, context }) => {
    await setup(page, context, 320, [
      { type: "turn", turnId: "t1", conversationId: "c1", lang: "en" },
      { type: "message", text: "Here is the preview. Nothing is sent until you tap **Send reply**.", lang: "en" },
      { type: "card", card: CARD },
      { type: "end", credits: 1 },
    ]);
    const before = page.url();
    let sheet = await openSheet(page);
    const box = sheet.getByRole("textbox", { name: "Message to Eddy" });
    await box.fill("Draft a reply to Ramesh");
    await box.press("Enter");
    await expect(sheet.locator("[data-eddy-card]")).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Send reply" })).toBeVisible();
    await noHorizontalOverflow(page, "Eddy sheet with a card at 320");
    const card = (await sheet.locator("[data-eddy-card]").boundingBox())!;
    expect(card.x).toBeGreaterThanOrEqual(0);
    expect(card.x + card.width).toBeLessThanOrEqual(320);

    // An unsent draft survives Android Back.
    await sheet.getByRole("textbox", { name: "Message to Eddy" }).fill("Still thinking about this one");
    await page.goBack();
    await expect(sheet).toBeHidden();
    expect(page.url()).toBe(before);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    sheet = await openSheet(page);
    await expect(sheet.getByRole("textbox", { name: "Message to Eddy" })).toHaveValue("Still thinking about this one");
    // The card is still on screen, so it can still be confirmed.
    await expect(sheet.locator("[data-eddy-card]")).toBeVisible();
  });

  test("while the sheet is open, Eddy's result rows stand in for toasts", async ({ page, context }) => {
    await setup(page, context, 390, [
      { type: "turn", turnId: "t1", conversationId: "c1", lang: "en" },
      { type: "done_action", actionId: "ar_row_1", summaryKey: "done.tag_contacts", vars: {}, undoUntil: iso(Date.now() + 10 * 60_000) },
      { type: "message", text: "Done.", lang: "en" },
      { type: "end", credits: 1 },
    ]);
    const sheet = await openSheet(page);
    const input = sheet.getByRole("textbox", { name: "Message to Eddy" });
    await input.fill("Tag the Pune contacts as vip");
    await input.press("Enter");
    await expect(sheet.locator("[data-eddy-result]")).toBeVisible();
    await expect(sheet.locator("[data-eddy-result]").getByRole("button", { name: /^Undo/ })).toBeVisible();
    await expect(page.getByRole("region", { name: "Notifications" }).getByText("Tags updated.")).toHaveCount(0);
  });

  test("Escape and the Close button close the sheet and leave the page where it was", async ({ page, context }) => {
    await setup(page, context, 390);
    const before = page.url();
    let sheet = await openSheet(page);
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    sheet = await openSheet(page);
    await sheet.getByRole("button", { name: "Close Eddy" }).click();
    await expect(sheet).toBeHidden();
    expect(page.url()).toBe(before);
    // Closing popped the sheet's history entry: one Back leaves /app as usual instead of re-opening Eddy.
    await expect(page.getByRole("dialog", { name: "Eddy" })).toHaveCount(0);
  });
});
