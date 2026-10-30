/**
 * The WhatsApp cost gate for broadcasts (docs/SPEND-CONTROLS-SPEC.md 4.9 "Bulk gates", WP-10), in the browser: with a price
 * list and a small WhatsApp limit, the review step warns, pressing Send is refused with the plain 409 sentence, and nothing is
 * queued, frozen or held. Also axe (light and dark) and the 360px layout of the review step with the warning on screen.
 *
 * The limit only refuses when the app under test runs with SPEND_ENFORCE=enforce (in observe mode, the default before train 4,
 * nothing new may block anyone), so the spec skips otherwise. It reads the same .env as the app.
 */
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { closeDb, connectFakeNumber, db, signupUser, stamp, watchErrors, type TestUser } from "./helpers";
import { axeSerious, goDark, noHorizontalOverflow, openFromNav, seedContact, seedTemplate } from "./audience-campaigns-util";
import { ledgerRows, resetSpend, setAllowance, useRateCard } from "./spend-kit";

const enforced = (env: Record<string, string | undefined> = process.env) => (env.SPEND_ENFORCE ?? "").trim().toLowerCase() === "enforce";

test.afterAll(closeDb);
test.beforeEach(() => {
  test.setTimeout(240_000);
});
test.skip(!enforced(), "The WhatsApp limit only refuses with SPEND_ENFORCE=enforce on the app under test.");

type World = { user: TestUser; fx: Awaited<ReturnType<typeof connectFakeNumber>>; tpl: { id: string; name: string } };

/** An owner with a connected number, an approved marketing template and 3 opted-in Indian contacts. */
async function world(context: BrowserContext): Promise<World> {
  const user = await signupUser(context, "gate");
  const fx = await connectFakeNumber(user.tenantId);
  const tpl = await seedTemplate(user.tenantId, fx.wabaRef, { name: "festival_offer", status: "approved", category: "MARKETING", body: "Our festival offer is live." });
  const n = stamp().slice(-6);
  for (let i = 1; i <= 3; i++) await seedContact(user.tenantId, { phone: `+91701${n}${i}`, name: `Gate ${i}`, optIn: true });
  return { user, fx, tpl };
}

const stepHeading = (p: Page, text: string) => p.getByRole("heading", { level: 2, name: text });

async function toReview(page: Page, name: string) {
  await openFromNav(page, "Broadcasts", /\/app\/broadcasts/);
  await page.getByRole("link", { name: /New broadcast|Create your first broadcast/ }).first().click();
  await page.waitForURL(/\/app\/broadcasts\/new/);
  await expect(stepHeading(page, "1. Audience")).toBeVisible();
  await page.getByRole("button", { name: "Next: Message" }).click();
  await expect(stepHeading(page, "2. Message")).toBeFocused();
  await page.getByLabel(/^Template/).selectOption({ label: (await page.getByRole("option", { name: /Festival offer/ }).first().textContent())!.trim() });
  await page.getByLabel(/^Broadcast name/).fill(name);
  await page.getByRole("button", { name: "Next: Schedule" }).click();
  await expect(stepHeading(page, "3. Schedule")).toBeFocused();
  await page.getByRole("button", { name: "Next: Review" }).click();
  await expect(stepHeading(page, "4. Review")).toBeFocused();
}

/** 3 people at ₹1 each against a ₹1 limit (4.13 spend.broadcast; the month is named first). */
const REFUSAL_TEXT = /This broadcast could cost about ₹3, but only ₹1 is left in your WhatsApp limit (this month|today)\. Send to fewer people or raise the limit\./;
const REFUSAL = new RegExp(`^${REFUSAL_TEXT.source}$`);

test("a broadcast that won't fit the WhatsApp limit is refused in plain words, and nothing is queued", async ({ page, context }) => {
  const errors = watchErrors(page);
  const w = await world(context);
  const restoreCard = await useRateCard({ IN: { MARKETING: 100, UTILITY: 20, SERVICE: 10 }, "*": { MARKETING: 300, UTILITY: 50 } });
  try {
    await setAllowance(w.user.tenantId, "messaging", { currency: "INR", dailyMinor: 100, monthlyMinor: 100 });
    const name = `Limit gate ${stamp().slice(-5)}`;
    await toReview(page, name);

    // The review step already says it will not fit.
    const warning = page.getByTestId("limit-warning");
    await expect(warning).toHaveText(REFUSAL);
    await expect(page.getByText("WhatsApp spending limit")).toBeVisible();

    // Pressing Send is refused with the same sentence.
    await page.getByLabel(/I confirm that everyone/).check();
    await page.getByRole("button", { name: "Send broadcast" }).click();
    const confirm = page.getByRole("alertdialog").or(page.getByRole("dialog"));
    await expect(confirm.getByText("Send to 3 people now?")).toBeVisible();
    await confirm.getByRole("button", { name: "Send broadcast" }).click();
    await expect(page.getByText(REFUSAL_TEXT)).toHaveCount(2);
    await expect(page).toHaveURL(/\/app\/broadcasts\/new/);
    await expect(page.getByRole("button", { name: "Send broadcast" })).toBeEnabled();

    // Nothing was queued, frozen or held, and the refusal is in the spending activity.
    const d = await db();
    const draft = (await d.query(`SELECT id, status FROM "Broadcast" WHERE "tenantId" = $1 AND name = $2`, [w.user.tenantId, name])).rows[0];
    expect(draft.status).toBe("draft");
    expect(Number((await d.query(`SELECT count(*) FROM "BroadcastRecipient" WHERE "broadcastId" = $1`, [draft.id])).rows[0].count)).toBe(0);
    expect(Number((await d.query(`SELECT count(*) FROM "Job" WHERE queue = 'broadcast' AND payload->>'broadcastId' = $1`, [draft.id])).rows[0].count)).toBe(0);
    expect(Number((await d.query(`SELECT count(*) FROM "SpendReservation" WHERE "tenantId" = $1 AND status = 'held'`, [w.user.tenantId])).rows[0].count)).toBe(0);
    const refused = (await ledgerRows(w.user.tenantId, "messaging.bulk_hold")).filter((r) => r.phase === "refused");
    expect(refused.length).toBeGreaterThan(0);
    expect(refused[0].reasonCodes).toContain("spend.broadcast");

    // Accessible in light and dark, with the warning and the refusal on screen.
    const found: string[] = [];
    found.push(...(await axeSerious(page, "review with limit warning")));
    await goDark(page);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(warning).toBeVisible();
    found.push(...(await axeSerious(page, "review with limit warning, dark")));
    expect(found, found.join("\n")).toEqual([]);

    // At 360px the warning wraps and nothing scrolls sideways.
    await page.setViewportSize({ width: 360, height: 740 });
    await expect(warning).toBeVisible();
    await noHorizontalOverflow(page, "review with limit warning at 360px");

    // A limit that fits lets the same broadcast start.
    await setAllowance(w.user.tenantId, "messaging", { currency: "INR", dailyMinor: 10_000, monthlyMinor: 10_000 });
    await page.getByRole("button", { name: "Send broadcast" }).click();
    await confirm.getByRole("button", { name: "Send broadcast" }).click();
    await page.waitForURL(/\/app\/broadcasts\/[a-z0-9_]{10,}$/);
    const hold = (await d.query(`SELECT "amountMinor"::text AS amount, "expiresAt" FROM "SpendReservation" WHERE "tenantId" = $1 AND "subjectType" = 'broadcast' AND status = 'held'`, [w.user.tenantId])).rows[0];
    expect(hold.amount).toBe("300");
    expect(new Date(hold.expiresAt).getTime() - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
    expect(errors.filter((e) => !/40[0-9]/.test(e)), errors.join("\n")).toEqual([]);
  } finally {
    await restoreCard();
    await resetSpend(w.user.tenantId);
  }
});
