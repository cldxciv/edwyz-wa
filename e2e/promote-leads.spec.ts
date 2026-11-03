import { expect, test } from "@playwright/test";
import { FAKE_FORM_ID, FAKE_PAGE_ID } from "../tests/helpers/fake-meta-promote";
import { closeDb, db, tick, watchErrors } from "./helpers";
import {
  api,
  checkPromoteQuality,
  chooseGoal,
  expectAppReadsFake,
  expectAppUsedFake,
  expectNoSpendViolations,
  expectStarted,
  fakeMark,
  fakeMetaTestLead,
  ids,
  instagramOnly,
  next,
  promoteOwner,
  t,
  tapStart,
  toReview,
  uploadAdImage,
  waitForCampaignStatus,
  deliverLeadgen,
} from "./promote-helpers";

/**
 * 9.4 promote-leads: make a form from presets → Instagram only → Start → a test lead appears tagged Test, and no WhatsApp
 * message is sent. Desktop Chrome and Pixel 7 (@mobile).
 *
 * With SPEND_DRY_RUN=1 the app sends nothing to Meta for the form or the test lead (promote/meta.ts answers with fake ids), so
 * the spec plays Meta's part: it posts a test lead to the fake Meta server's own Graph surface (the edge Edwyz would call,
 * with the Page token; fakeMetaTestLead, never counted as the app's call), records its id as the Page's test lead (what
 * sendTestLead stores), and delivers the leadgen webhook. Every workspace that has the fake Page receives it, as for a Page
 * shared by an agency and its client; each marks it Test. The app then reads the lead from the fake with the Page token.
 */

test.afterAll(closeDb);
test.setTimeout(240_000);
test.use({ actionTimeout: 30_000, navigationTimeout: 60_000 });

const TEST_LEAD_PHONE = "+12025550142";

/** What sendTestLead stores after Meta answers: the lead id, for the Page (src/lib/promote/test-leads.ts). */
async function rememberTestLead(leadId: string): Promise<void> {
  const key = `promote:test-leads:${FAKE_PAGE_ID}`;
  const d = await db();
  const row = (await d.query(`select value from "PlatformSetting" where key = $1`, [key])).rows[0] as { value?: { leads?: { id: string; at: string }[] } } | undefined;
  const leads = [...(row?.value?.leads ?? []), { id: leadId, at: new Date().toISOString() }];
  await d.query(`insert into "PlatformSetting" (key,value,"updatedAt") values ($1,$2,now()) on conflict (key) do update set value = excluded.value, "updatedAt" = now()`, [key, JSON.stringify({ leads })]);
}

test.describe("Lead form ads @mobile", () => {
  test("a form from presets, Instagram only, Start; a test lead shows as Test and gets no WhatsApp message", async ({ page, context }, testInfo) => {
    const errors = watchErrors(page);
    const mark = await fakeMark();
    const seed = await promoteOwner(context, "prm-leads");
    await expectAppReadsFake(page.request, mark);

    await page.goto("/app/ads/create?goal=lead_form");
    await expect(page.getByTestId(ids.shell)).toBeVisible();
    await chooseGoal(page, "lead_form");
    await next(page);

    // The form, from a preset, with the business's own privacy link (Edwyz hosts none, 11.1a decision 2).
    await expect(page.getByTestId("form-step")).toBeVisible();
    await page.getByTestId("form-preset-salon").click();
    await expect(page.getByTestId("form-preset-salon")).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("form-privacy").fill("https://example.com/privacy");
    // The consent box is offered, never pre-ticked in the form people see (D35).
    await expect(page.getByTestId("form-consent")).toBeVisible();
    await checkPromoteQuality(page, testInfo, "leads-form");
    await next(page);

    await uploadAdImage(page);
    await page.getByTestId("copy-primary").first().fill("Book your Diwali glow-up. Leave your number and we'll call you back.");
    await next(page);

    await instagramOnly(page);
    await checkPromoteQuality(page, testInfo, "leads-audience");
    const review = await toReview(page);
    await expect(review).toContainText(t("card.where.instagram"));
    await expect(page.getByTestId(ids.primary)).toHaveText(/Create form and start ads · up to ₹[\d,]+/);
    await checkPromoteQuality(page, testInfo, "leads-review");

    await tapStart(page);
    await expectStarted(page);
    await waitForCampaignStatus(seed.owner.tenantId, "active");
    const form = (await (await db()).query(`select id, name from "LeadForm" where "tenantId" = $1 and origin = 'created' order by "createdAt" desc limit 1`, [seed.owner.tenantId])).rows[0] as { id: string; name: string | null } | undefined;
    expect(form, "the form made in Edwyz is saved").toBeTruthy();

    // Send a test lead from Leads > Forms (the confirm says it shows as Test and sends no WhatsApp message).
    await page.goto("/app/leads/forms");
    await page.getByTestId(`form-test-lead-${form!.id}`).click();
    const dialog = page.locator('[role="dialog"], [role="alertdialog"]').filter({ hasText: t("form.test_lead_note") });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: t("form.test_lead") }).click();
    await expect(page.getByTestId(`form-actions-${form!.id}`).getByTestId("form-test-sent")).toContainText(t("form.test_sent"));
    await checkPromoteQuality(page, testInfo, "leads-forms");

    // Meta delivers the test lead: the webhook, then the lead read from the fake with the Page token.
    const code = `PRM${Date.now().toString(36).toUpperCase()}`;
    const leadMark = await fakeMark();
    const leadId = await fakeMetaTestLead(FAKE_FORM_ID, [
      { name: "full_name", values: [`Edwyz test lead ${code}`] },
      { name: "phone_number", values: [TEST_LEAD_PHONE] },
    ]);
    await rememberTestLead(leadId);
    const outboundBefore = Number((await (await db()).query(`select count(*)::int as n from "Message" where "tenantId" = $1 and direction = 'outbound'`, [seed.owner.tenantId])).rows[0].n);
    await deliverLeadgen(page.request, { leadgenId: leadId, formId: FAKE_FORM_ID });
    await expect
      .poll(
        async () => {
          await tick(page.request, 1);
          return (await (await db()).query(`select "isTest" from "Lead" where "tenantId" = $1 and "leadgenId" = $2`, [seed.owner.tenantId, leadId])).rows[0]?.isTest ?? null;
        },
        { timeout: 60_000, message: "the test lead arrives, marked Test" },
      )
      .toBe(true);
    // The lead was read from the fake by the app (the spec's own test_leads post is not counted).
    await expectAppUsedFake(leadMark);

    // The Leads hub lists it tagged Test, and the API says so too.
    const listed = await api<{ items: { leadgenId?: string; isTest: boolean }[] }>(page.request, "GET", "/api/leads?test=true");
    expect(listed.status).toBe(200);
    expect(listed.body.items.some((l) => l.isTest)).toBe(true);
    await page.goto("/app/leads");
    const row = page.getByRole("row").filter({ hasText: code }).or(page.getByRole("listitem").filter({ hasText: code })).first();
    await expect(row).toBeVisible();
    await expect(row.getByText("Test", { exact: true })).toBeVisible();
    await checkPromoteQuality(page, testInfo, "leads-hub");

    // No WhatsApp welcome, and no sequence, for a test lead (D33).
    await tick(page.request, 1);
    const outboundAfter = Number((await (await db()).query(`select count(*)::int as n from "Message" where "tenantId" = $1 and direction = 'outbound'`, [seed.owner.tenantId])).rows[0].n);
    expect(outboundAfter, "no WhatsApp message for a test lead").toBe(outboundBefore);

    await expectNoSpendViolations();
    expect(errors, errors.join("\n")).toEqual([]);
  });
});
