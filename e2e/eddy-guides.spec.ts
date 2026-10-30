import { expect, test, type Page } from "@playwright/test";
import { axeSerious, joinWorkspace, noHorizontalOverflow, skipWelcome } from "./auth-onboarding-util";
import { closeDb, connectFakeNumber, db, signupUser, stamp, watchErrors, type TestUser } from "./helpers";

/**
 * Eddy's guided setup end to end (docs/EDDY-SPEC.md 6.8, 6.11, EDDY-17 acceptance 6): a new workspace in the `clinic`
 * fixture's state (nothing connected, no template, no contacts) walks the three steps with no dead end, with Eddy's chat
 * off (platform_off, the production state until the key is set): every card leads to the page that does the job by hand,
 * and the guide moves on as the setup changes.
 *
 * Only GET /api/eddy/status is stubbed (so the panel shows the off state on any server); the setup list, the onboarding
 * status and token health, and the pages are the real ones. The WhatsApp connection itself is seeded in the database, as
 * the other connect specs do: Meta's own window cannot run here.
 */

test.afterAll(closeDb);

type Status = Record<string, unknown>;
const statusDTO = (over: Status = {}): Status => ({
  state: "platform_off",
  reason: "not_configured",
  readOnly: false,
  canEnable: true,
  ownerNames: ["Clinic Owner"],
  allowance: { usedToday: 0, limitToday: null, usedMonth: 0, limitMonth: 500, resetsOn: "2026-11-01", memberUsedToday: 0, memberLimitToday: 40 },
  langPref: "auto",
  needsYou: 0,
  demo: false,
  whatsapp: "none",
  phase: 1,
  firstUse: false,
  spendingStopped: false,
  ...over,
});

async function mockStatus(page: Page, dto: Status) {
  await page.route("**/api/eddy/status", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(dto) }));
}

const launcher = (page: Page) => page.getByRole("banner").getByRole("button", { name: /^Ask Eddy/ });
const panelOf = (page: Page) => page.getByRole("complementary", { name: "Eddy" });
const guideOf = (page: Page) => panelOf(page).locator("[data-eddy-guide]");
const currentCard = (page: Page) => guideOf(page).locator("[data-guide-step]").first();

/**
 * Opens the panel unless it is open or on its way back: a panel left open in this tab reopens by itself after a page load
 * (EDDY-SPEC 6.2, sessionStorage eddy:open), a moment after the page appears, and a launcher click then would close it.
 */
async function openPanel(page: Page) {
  const remembered = await page.evaluate(() => {
    try {
      return sessionStorage.getItem("eddy:open") === "1";
    } catch {
      return false;
    }
  });
  if (!remembered && !(await panelOf(page).isVisible())) await launcher(page).click();
  await expect(panelOf(page)).toBeVisible();
  return panelOf(page);
}

async function clinic(context: Parameters<typeof signupUser>[0]): Promise<TestUser> {
  const u = await signupUser(context, "clinic");
  await skipWelcome(context, u.userId);
  return u;
}

/** The workspace finishes Embedded Signup (what the connect page does after Meta's window closes). */
async function markConnected(tenantId: string) {
  const fx = await connectFakeNumber(tenantId);
  const d = await db();
  await d.query(`update "Tenant" set "onboardingStatus" = 'live' where id = $1`, [tenantId]);
  return fx;
}

test.describe("guided setup with Eddy off: the clinic walks connect, template and broadcast with no dead end", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  test("step 1 Connect WhatsApp, step 2 the first template, step 3 the first broadcast", async ({ page, context }) => {
    const errors = watchErrors(page);
    const u = await clinic(context);
    await mockStatus(page, statusDTO());
    await page.goto("/app");
    const panel = await openPanel(page);
    await expect(panel).toContainText("Eddy is not switched on yet.");
    await expect(panel.getByRole("textbox")).toHaveCount(0);

    // ----- 1. Connect WhatsApp: Meta's screens, the checklist with coexistence, then the connect page -----
    const guide = guideOf(page);
    await expect(guide.getByRole("heading", { name: "Your setup list" })).toBeVisible();
    const connect = currentCard(page);
    await expect(connect).toHaveAttribute("data-guide-step", "connect");
    await expect(connect.getByRole("heading", { name: "Connect WhatsApp" })).toBeVisible();
    await expect(connect).toContainText("If your number is already on the WhatsApp Business app, choose coexistence.");
    await connect.getByText("What Meta's window asks, screen by screen").click();
    await expect(connect).toContainText("Choose or create a business portfolio");
    // Every card has its parts; none links to a Meta domain.
    for (const part of ["title", "reason", "minutes", "ask", "skip"]) await expect(connect.locator(`[data-guide-part="${part}"]`)).toHaveCount(1);
    const hrefs = await guide.locator("a[href]").evaluateAll((as) => as.map((a) => a.getAttribute("href") ?? ""));
    expect(hrefs.filter((h) => /facebook\.com|meta\.com|fb\.me/i.test(h) || !(h.startsWith("/app") || h.startsWith("mailto:")))).toEqual([]);
    // With the chat off, Ask Eddy says so instead of pretending.
    await connect.locator('[data-guide-part="ask"]').click();
    await expect(connect).toContainText("Eddy can't chat right now. The buttons on this card still work.");

    await connect.getByRole("link", { name: "Connect WhatsApp" }).click();
    await expect(page).toHaveURL(/\/app\/settings\/connect\?from=eddy$/);
    // On desktop the panel stays open beside the page, and the step is waiting for the connection.
    const waiting = currentCard(page);
    await expect(waiting).toContainText("Waiting for WhatsApp to connect.");

    await markConnected(u.tenantId);
    await waiting.getByRole("button", { name: "Check again" }).click();
    await expect(guide).toContainText(/WhatsApp is connected: .*Next: your first template\./);

    // ----- 2. The first template: with the chat off, the card leads to the templates page -----
    await expect(currentCard(page)).toHaveAttribute("data-guide-step", "template");
    await expect(currentCard(page)).toContainText("Eddy can't chat right now, so create the template on the templates page.");
    await currentCard(page).getByRole("link", { name: "Create a template" }).click();
    await expect(page).toHaveURL(/\/app\/templates\/new$/);

    // Meta approves a template (seeded), and the contacts step comes next; then the broadcast.
    const d = await db();
    const waba = (await d.query(`select id from "Waba" where "tenantId" = $1 limit 1`, [u.tenantId])).rows[0].id as string;
    await d.query(`insert into "Template" (id, "tenantId", "wabaRefId", name, language, category, status, components, "updatedAt") values ($1,$2,$3,$4,'en','UTILITY','approved',$5,now())`, [`tpl_${stamp()}`, u.tenantId, waba, `appointment_reminder_${stamp()}`, JSON.stringify([{ type: "BODY", text: "Hi {{1}}, your appointment is on {{2}}." }])]);
    await page.goto("/app");
    await openPanel(page);
    await expect(currentCard(page)).toHaveAttribute("data-guide-step", "contacts");
    await currentCard(page).getByRole("link", { name: "Add contacts" }).click();
    await expect(page).toHaveURL(/\/app\/contacts$/);
    await d.query(`insert into "Contact" (id, "tenantId", phone, name, tags, "optIn") values ($1,$2,$3,'Patient One','{}',true)`, [`ct_${stamp()}`, u.tenantId, `+9198${String(Date.now()).slice(-8)}`]);

    // ----- 3. The first broadcast: the card leads to the broadcast page, where a person starts it -----
    await page.goto("/app");
    await openPanel(page);
    const broadcast = currentCard(page);
    await expect(broadcast).toHaveAttribute("data-guide-step", "broadcast");
    await expect(broadcast).toContainText("Marketing messages go only to contacts who opted in.");
    await broadcast.getByRole("link", { name: "Start a broadcast" }).click();
    await expect(page).toHaveURL(/\/app\/broadcasts\/new$/);
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("Skip for now takes a step out of the guide and says where it still is", async ({ page, context }) => {
    await clinic(context);
    await mockStatus(page, statusDTO());
    await page.goto("/app");
    await openPanel(page);
    const card = currentCard(page);
    await expect(card).toHaveAttribute("data-guide-step", "connect");
    await card.getByRole("button", { name: "Skip for now: Connect WhatsApp" }).click();
    await expect(guideOf(page).locator('[data-guide-step="connect"]')).toHaveCount(0);
    await expect(panelOf(page)).toContainText("Skipped for now.");
  });

  test("a team member sees that an admin is needed, with no connect button and no Skip", async ({ browser, context }) => {
    const owner = await clinic(context);
    const { context: memberContext } = await joinWorkspace(browser, owner.tenantId, "agent", "clinicagent");
    const mp = await memberContext.newPage();
    await mp.setViewportSize({ width: 1280, height: 800 });
    await mockStatus(mp, statusDTO({ canEnable: false }));
    await mp.goto("/app");
    await openPanel(mp);
    const card = guideOf(mp).locator('[data-guide-step="connect"]');
    await expect(card).toContainText("An admin needs to connect WhatsApp.");
    await expect(card.getByRole("link", { name: "Connect WhatsApp" })).toHaveCount(0);
    await expect(guideOf(mp).locator('[data-guide-part="skip"]')).toHaveCount(0);
    await memberContext.close();
  });

  test("the guide is accessible, has no horizontal overflow at 360 px and reads in the dark theme", async ({ page, context }) => {
    await clinic(context);
    await mockStatus(page, statusDTO());
    await page.goto("/app");
    await openPanel(page);
    await expect(guideOf(page)).toBeVisible();
    expect(await axeSerious(page, "guide 1280")).toEqual([]);
    await page.emulateMedia({ colorScheme: "dark" });
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    expect(await axeSerious(page, "guide dark")).toEqual([]);
  });

  test("@mobile the guide in the phone sheet at 360 px", async ({ page, context }) => {
    await page.setViewportSize({ width: 360, height: 780 });
    await clinic(context);
    await mockStatus(page, statusDTO());
    await page.goto("/app");
    await launcher(page).click();
    const sheet = page.getByRole("dialog", { name: "Eddy" });
    await expect(sheet).toBeVisible();
    await expect(sheet.locator("[data-eddy-guide]")).toBeVisible();
    await noHorizontalOverflow(page, "guide 360");
    const link = sheet.getByRole("link", { name: "Connect WhatsApp" });
    expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  });
});
