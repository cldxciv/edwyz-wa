import { expect, test, type Page } from "@playwright/test";
import { closeDb, db, stamp, watchErrors } from "./helpers";
import { appSetting, checkPromoteQuality, expectAppReadsFake, expectNoSpendViolations, fakeMark, promoteOwner, seedConsentedContacts, t, withFakeScenario } from "./promote-helpers";

/**
 * 9.4 promote-audiences: a saved audience. The customer-list card shows the count and the hashing sentence. Missing terms show
 * Opens Meta. A lookalike. Desktop Chrome and Pixel 7 (@mobile).
 *
 * Customer lists need PROMOTE_AUDIENCES=all on the app (outside production LEGAL_DPDP_AUDIENCES_OK is not needed);
 * engagement and lookalike audiences need at least `engagement`. playwright.config.ts starts the app with `all`; the flag is
 * read from what the app was started with, never from the runner's shell. With SPEND_DRY_RUN=1 a Meta-backed audience answers
 * with a fake id and is not stored, so the spec checks what the page says after each create, and the terms read still goes to
 * the fake.
 */

test.afterAll(closeDb);
test.setTimeout(180_000);
test.use({ actionTimeout: 30_000, navigationTimeout: 60_000 });

const audiencesFlag = () => appSetting("PROMOTE_AUDIENCES") || "off";
const manager = (page: Page) => page.getByTestId("audience-manager").first();

async function chooseKind(page: Page, title: RegExp): Promise<void> {
  const create = page.getByRole("button", { name: "Make an audience" });
  if (await create.isVisible().catch(() => false)) await create.click();
  const radio = manager(page).getByRole("radio", { name: title });
  await expect(radio).toBeVisible();
  await radio.check();
}

test.describe("Audiences @mobile", () => {
  test("a saved audience is kept in Edwyz and listed", async ({ page, context }, testInfo) => {
    const errors = watchErrors(page);
    const mark = await fakeMark();
    await promoteOwner(context, "prm-aud-saved");
    await expectAppReadsFake(page.request, mark);
    await page.goto("/app/ads/audiences");
    await expect(page.getByRole("heading", { name: "Audiences" }).first()).toBeVisible();
    await chooseKind(page, /^Saved audience/);
    const name = `Women in Pune ${stamp().slice(-4)}`;
    await manager(page).getByLabel("Name").fill(name);
    await manager(page).getByRole("button", { name: "Save audience" }).click();
    await expect(page.getByTestId("audience-list")).toContainText(name);
    await expect(page.getByTestId("audience-status")).toContainText(`Saved "${name}".`);
    await checkPromoteQuality(page, testInfo, "audiences-saved");
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("a customer list shows the count and the hashing sentence; missing terms open Meta", async ({ page, context }, testInfo) => {
    test.skip(audiencesFlag() !== "all", "Customer lists need PROMOTE_AUDIENCES=all on the app under test.");
    const errors = watchErrors(page);
    const mark = await fakeMark();
    const seed = await promoteOwner(context, "prm-aud-list");
    await expectAppReadsFake(page.request, mark);
    // 120 contacts agreed to marketing; 5 more opted out and are never counted.
    await seedConsentedContacts(seed.owner.tenantId, 120, 5);
    await page.goto("/app/ads/audiences");
    await chooseKind(page, /^Past customers/);
    await manager(page).getByRole("button", { name: "Check how many can be included" }).click();
    await expect(manager(page)).toContainText(t("audience.can_include", { included: "120", total: "125" }));
    await expect(manager(page)).toContainText("Only contacts who agreed to get marketing messages and haven't opted out are included.");

    await manager(page).getByRole("button", { name: "Make audience" }).click();
    const card = page.getByTestId("audience-share-card");
    await expect(card).toBeVisible();
    await expect(card).toContainText(t("audience.upload", { count: "120" }));
    await expect(card).toContainText("scrambled (hashed) before they leave Edwyz");
    await checkPromoteQuality(page, testInfo, "audiences-share-card");
    await page.getByTestId("audience-share-confirm").click();
    await expect(page.getByTestId("audience-status")).toContainText(/Made ".+"\. Meta takes a few minutes to get it ready\./);

    // Meta's Custom Audience terms not accepted: nothing is made, and the fix opens that screen in Meta.
    await withFakeScenario("audience_terms_2655", async () => {
      await page.reload();
      await chooseKind(page, /^Past customers/);
      await manager(page).getByRole("button", { name: "Make audience" }).click();
      const confirm = page.getByTestId("audience-share-confirm");
      if (await confirm.isVisible().catch(() => false)) await confirm.click();
      const terms = page.getByTestId("audience-terms");
      await expect(terms).toBeVisible();
      await expect(terms.locator('[data-opens-meta="custom_audience_tos"]')).toContainText(t("opens_meta.label"));
      await checkPromoteQuality(page, testInfo, "audiences-terms");
    });

    await expectNoSpendViolations();
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("a lookalike of a ready audience", async ({ page, context }, testInfo) => {
    test.skip(!["engagement", "all"].includes(audiencesFlag()), "Lookalikes need PROMOTE_AUDIENCES=engagement or all on the app under test.");
    const errors = watchErrors(page);
    const mark = await fakeMark();
    const seed = await promoteOwner(context, "prm-aud-lal");
    await expectAppReadsFake(page.request, mark);
    // A seed audience Meta says is ready (1,000+ people): dry-run audiences are not stored, so it is put in place directly.
    const seedName = `Past customers ${stamp().slice(-4)}`;
    await (await db()).query(
      `insert into "AdAudience" (id,"tenantId","adAccountAssetId",kind,name,"metaAudienceId",spec,status,"sizeLower","sizeUpper","consentBasis","rowsUploaded","updatedAt")
       values ($1,$2,$3,'customer_list',$4,$5,'{}','ready',1000,1200,'marketing_opt_in',1100,now())`,
      [`aud_prm_${stamp()}`, seed.owner.tenantId, seed.adAccount.id, seedName, `2385${stamp()}`],
    );
    await page.goto("/app/ads/audiences");
    await expect(page.getByTestId("audience-list")).toContainText(seedName);
    await chooseKind(page, /^People like your customers/);
    await manager(page).getByLabel("Find people like").selectOption({ label: seedName });
    await expect(manager(page)).toContainText(t("audience.lookalike_note"));
    await manager(page).getByRole("button", { name: "Make audience" }).click();
    await expect(page.getByTestId("audience-status")).toContainText(/Made ".+"\./);
    await checkPromoteQuality(page, testInfo, "audiences-lookalike");
    await expectNoSpendViolations();
    expect(errors, errors.join("\n")).toEqual([]);
  });
});
