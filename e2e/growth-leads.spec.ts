import { expect as baseExpect, test, type Page } from "@playwright/test";
import { ORIGIN, closeDb, connectFakeNumber, db, signupUser, stamp, watchErrors, type TestUser } from "./helpers";
import { askDialog, axeSerious, createAgent, loginFresh, overflowsX, seedMeta, toggleTheme } from "./growth-helpers";

// The shared machine is busy with other testers: generous timeouts keep real defects apart from slowness.
const expect = baseExpect.configure({ timeout: 25_000 });
test.setTimeout(240_000);
test.use({ actionTimeout: 30_000, navigationTimeout: 60_000 });

test.afterAll(closeDb);

type Seed = { formId: string; leads: { id: string; name: string }[]; templateId: string };

/** A lead form, an approved template and three leads: opted in, no consent on record, and already contacted. */
async function seedLeads(u: TestUser, withTemplate = true): Promise<Seed> {
  const d = await db();
  const m = await seedMeta(u);
  const formId = `form_${stamp()}`;
  await d.query(`insert into "LeadForm" (id,"tenantId","pageAssetId","metaFormId",name,"consentText") values ($1,$2,$3,$4,'Pune 2 BHK enquiry','I agree to get WhatsApp messages about my enquiry.')`, [formId, u.tenantId, m.page!.id, `mf_${stamp()}`]);
  let templateId = "";
  if (withTemplate) {
    const fx = await connectFakeNumber(u.tenantId);
    templateId = `tpl_${stamp()}`;
    await d.query(`insert into "Template" (id,"tenantId","wabaRefId",name,language,category,status,components,"updatedAt") values ($1,$2,$3,'welcome_new_lead','en','MARKETING','approved',$4,now())`, [templateId, u.tenantId, fx.wabaRef, JSON.stringify([{ type: "BODY", text: "Hi, thanks for your enquiry." }])]);
  }
  const contactId = `ct_${stamp()}`;
  await d.query(`insert into "Contact" (id,"tenantId",phone,name,"optIn","optInSource","optInAt") values ($1,$2,$3,'Asha Kulkarni',true,'lead_form',now())`, [contactId, u.tenantId, `9198${String(stamp()).slice(-8)}`]);
  const mk = async (name: string, status: string, extra: { contactId?: string | null; consent?: boolean; fields?: object } = {}) => {
    const id = `lead_${stamp()}`;
    await d.query(
      `insert into "Lead" (id,"tenantId","leadFormId","leadgenId","contactId",fields,"consentText","consentAt",status,"firstResponseAt") values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, u.tenantId, formId, `lg_${stamp()}`, extra.contactId ?? null, JSON.stringify(extra.fields ?? { full_name: name, email: `${name.split(" ")[0].toLowerCase()}@example.com`, budget_range: "50-70 lakh" }), extra.consent ? "I agree to get WhatsApp messages about my enquiry." : null, extra.consent ? new Date() : null, status, status === "contacted" ? new Date() : null],
    );
    return { id, name };
  };
  const a = await mk("Asha Kulkarni", "new", { contactId, consent: true });
  const b = await mk("Ravi Menon", "new");
  const c = await mk("Sunita Rao", "contacted");
  return { formId, leads: [a, b, c], templateId };
}

/** In the pipeline a card's button also reads out the form and date after the name; in the table it is the name alone. */
const leadButton = (page: Page, name: string) => page.getByRole("button", { name: new RegExp(`^${name}( |$)`) });

const openLead = async (page: Page, name: string) => {
  await leadButton(page, name).first().click();
  const dlg = page.getByRole("dialog", { name });
  await expect(dlg).toBeVisible();
  return dlg;
};

test.describe("Leads", () => {
  test("empty states on all three tabs explain what to do next", async ({ page, context }) => {
    const errors = watchErrors(page);
    await signupUser(context, "lead");
    await page.goto("/app/leads");
    await expect(page.getByRole("heading", { level: 1, name: "Leads" })).toBeVisible();
    await expect(page.getByText("No leads yet")).toBeVisible();
    await expect(page.getByRole("link", { name: "Connect your Facebook page" })).toHaveAttribute("href", "/app/settings/connections");
    expect(await axeSerious(page), "axe leads").toEqual([]);
    await page.getByRole("link", { name: "Forms" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Lead forms" })).toBeVisible();
    await expect(page.getByText("No lead forms yet")).toBeVisible();
    await page.getByRole("link", { name: "Follow-ups" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Follow-up sequences" })).toBeVisible();
    await expect(page.getByText("No follow-up sequences yet")).toBeVisible();
    expect(await axeSerious(page), "axe sequences").toEqual([]);
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("pipeline: stages, consent badges, moving a lead with undo, and the table view with a stage filter", async ({ page, context }) => {
    const errors = watchErrors(page);
    const u = await signupUser(context, "lead");
    await seedLeads(u);
    await page.goto("/app/leads");
    await expect(page.getByRole("tab", { name: "Pipeline" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("region", { name: "Reply speed" })).toBeVisible();
    await expect(page.getByText("Waiting for a first reply", { exact: true })).toBeVisible();
    for (const stage of ["New", "Contacted", "Qualified", "Won", "Lost", "Not a real lead"]) {
      await expect(page.getByRole("heading", { name: stage, exact: true })).toBeVisible();
    }
    // Raw enum values must never be visible.
    const text = await page.locator("main").innerText();
    expect(text).not.toMatch(/\b(invalid|qualified_|leadgen|meta_lead_form)\b/);
    // Cards only carry a badge when something is missing: the lead with no consent on record is flagged, the opted-in one is not.
    await expect(page.getByRole("listitem").filter({ hasText: "Ravi Menon" }).getByText("Needs opt-in")).toBeVisible();
    await expect(page.getByRole("listitem").filter({ hasText: "Asha Kulkarni" }).getByText("Needs opt-in")).toHaveCount(0);
    expect(await axeSerious(page), "axe pipeline").toEqual([]);

    // Moving a card needs an explicit button, then offers Undo.
    const move = page.getByRole("button", { name: /^Move Ravi Menon to/ });
    await expect(move).toBeDisabled();
    await page.getByLabel("Stage for Ravi Menon").selectOption("qualified");
    await expect(page.getByRole("button", { name: "Move Ravi Menon to qualified" })).toBeEnabled();
    await page.getByRole("button", { name: "Move Ravi Menon to qualified" }).click();
    await expect(page.getByText("Ravi Menon is now qualified")).toBeVisible();
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(page.getByText("Ravi Menon is now new")).toBeVisible();

    // Table view remembers itself and filters by stage.
    await page.getByRole("tab", { name: "Table" }).click();
    await expect(page.getByRole("table", { name: "Leads" })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("tab", { name: "Table" })).toHaveAttribute("aria-selected", "true");
    await page.getByLabel("Show stage").selectOption("won");
    await expect(page.getByText("No won leads")).toBeVisible();
    await page.getByRole("button", { name: "Show all stages" }).click();
    await expect(page.getByRole("button", { name: "Asha Kulkarni", exact: true })).toBeVisible();
    expect(await axeSerious(page), "axe table").toEqual([]);
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("lead drawer: answers in words, consent proof or its absence, stage change, Escape returns focus", async ({ page, context }) => {
    const errors = watchErrors(page);
    const u = await signupUser(context, "lead");
    await seedLeads(u);
    await page.goto("/app/leads");
    await page.getByRole("tab", { name: "Table" }).click();
    const opener = page.getByRole("button", { name: "Asha Kulkarni", exact: true });
    await opener.click();
    const dlg = page.getByRole("dialog", { name: "Asha Kulkarni" });
    await expect(dlg).toBeVisible();
    await expect(dlg.getByText("Budget range")).toBeVisible();
    await expect(dlg.getByText("50-70 lakh")).toBeVisible();
    await expect(dlg.getByText("budget_range")).toHaveCount(0);
    await expect(dlg.getByText("Agreed")).toBeVisible();
    await expect(dlg.getByText(/I agree to get WhatsApp messages about my enquiry/)).toBeVisible();
    await expect(dlg.getByRole("link", { name: /^Call / })).toBeVisible();
    expect(await axeSerious(page), "axe drawer").toEqual([]);

    await dlg.getByLabel("Stage").selectOption("qualified");
    await dlg.getByRole("button", { name: "Save stage" }).click();
    await expect(page.getByText("Moved to qualified")).toBeVisible();
    await expect(dlg.getByText("A good fit, worth pursuing")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dlg).toBeHidden();
    await expect(page.getByRole("button", { name: "Asha Kulkarni", exact: true })).toBeFocused();

    // No consent on record: the drawer says what that means in plain words.
    const d2 = await openLead(page, "Ravi Menon");
    await expect(d2.getByText(/No proof that this lead agreed to marketing messages was saved/)).toBeVisible();
    await expect(d2.getByText("Needs opt-in")).toBeVisible();
    await expect(d2.getByText("No phone number saved")).toBeVisible();
    await page.keyboard.press("Escape");
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("CSV export: downloads, keeps columns for real people, and neutralises spreadsheet formulas", async ({ page, context }) => {
    const u = await signupUser(context, "lead");
    const seed = await seedLeads(u);
    const d = await db();
    await d.query(`update "Lead" set fields = $1 where id = $2`, [JSON.stringify({ full_name: "=HYPERLINK(\"http://evil.example\",\"click\")", email: "+cmd@example.com" }), seed.leads[1].id]);
    await page.goto("/app/leads");
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Download as CSV" }).click()]);
    expect(download.suggestedFilename()).toBe("leads.csv");
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(c as Buffer);
    const csv = Buffer.concat(chunks).toString("utf8");
    expect(csv).toContain("created_at,status,name,email,phone,form");
    expect(csv).toContain("Asha Kulkarni");
    expect(csv).not.toMatch(/(^|,)"?=HYPERLINK/m);
    expect(csv).not.toMatch(/,\+cmd@example\.com/);
    // Filter is honoured.
    const won = await context.request.get("/api/leads/export?status=won");
    expect(await won.text()).not.toContain("Asha Kulkarni");
    // Another workspace's export never includes these rows.
  });

  test("forms: consent wording is editable by owners and the blanket opt-in asks for confirmation", async ({ page, context }) => {
    const errors = watchErrors(page);
    const u = await signupUser(context, "lead");
    await seedLeads(u);
    await page.goto("/app/leads/forms");
    await expect(page.getByRole("heading", { name: "Pune 2 BHK enquiry" })).toBeVisible();
    const save = page.getByRole("button", { name: "Save consent wording" });
    await expect(save).toBeDisabled();
    await page.getByLabel("Consent wording").fill("I agree to receive WhatsApp messages from Sunrise Realty.");
    await page.getByLabel("Count every lead from this form as having agreed").check();
    await save.click();
    const ask = askDialog(page, "Count every lead from this form as having agreed?");
    await expect(ask).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(ask).toBeHidden();
    await save.click();
    await askDialog(page, "Count every lead").getByRole("button", { name: "Yes, record consent" }).click();
    await expect(page.getByText("Saved consent wording for Pune 2 BHK enquiry")).toBeVisible();
    // The Meta form id is kept inside a closed "Details" section, so it is in the page text but not on screen.
    await expect(page.getByText(/mf_\d+/)).toBeHidden();
    expect(await axeSerious(page), "axe forms").toEqual([]);
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("sequence builder: validation, timeline in words, create, turn off and delete", async ({ page, context }) => {
    const errors = watchErrors(page);
    const u = await signupUser(context, "lead");
    await seedLeads(u);
    await page.goto("/app/leads/sequences");
    await page.getByRole("button", { name: "Create your first sequence" }).click();
    await expect(page.getByText("New follow-up sequence")).toBeVisible();
    await expect(page.getByText("As soon as the lead arrives")).toBeVisible();
    await page.getByRole("button", { name: "Save sequence" }).click();
    await expect(page.getByText("Give the sequence a name so you can find it later.")).toBeVisible();
    // getByLabel would also read the decorative "*" of the required marker, so use the accessible name.
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("Welcome new leads");
    await page.getByRole("button", { name: "Save sequence" }).click();
    await expect(page.getByText("Choose a message or a chatbot for this step.")).toBeVisible();
    await page.getByLabel("Message to send").first().selectOption({ label: "welcome_new_lead" });
    await expect(page.getByText(/Send the message "welcome_new_lead"/)).toBeVisible();
    await page.getByRole("button", { name: "Add another step" }).click();
    await page.getByLabel("Step 2 wait amount").fill("1");
    await page.getByLabel("Step 2 wait unit").selectOption("days");
    await expect(page.getByText("1 day after the lead arrives")).toBeVisible();
    await expect(page.getByText("Wait 1 day")).toBeVisible();
    await page.getByLabel("Message to send").nth(1).selectOption({ label: "welcome_new_lead" });
    expect(await axeSerious(page), "axe builder").toEqual([]);
    await page.getByRole("button", { name: "Save sequence" }).click();
    await expect(page.getByText("Follow-up sequence created")).toBeVisible();
    await expect(page.getByText("Welcome new leads")).toBeVisible();
    await expect(page.getByText(/2 steps over 1 day/)).toBeVisible();
    await expect(page.getByText("Runs for every new lead")).toBeVisible();

    await page.getByRole("button", { name: "Turn off Welcome new leads" }).click();
    await expect(page.getByRole("button", { name: "Turn on Welcome new leads" })).toBeVisible();
    await page.getByRole("button", { name: "Delete Welcome new leads" }).click();
    const ask = askDialog(page, /Delete/);
    await expect(ask).toBeVisible();
    await ask.getByRole("button", { name: "Delete sequence" }).click();
    await expect(page.getByText("No follow-up sequences yet")).toBeVisible();
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("sequence API refuses a template from another workspace and an unknown form", async ({ context, browser }) => {
    const owner = await signupUser(context, "lead");
    const seed = await seedLeads(owner);
    const bctx = await browser.newContext();
    await signupUser(bctx, "lead");
    const r = await bctx.request.post("/api/leads/sequences", { headers: { origin: ORIGIN }, data: { name: "Steal", steps: [{ delayMinutes: 0, templateId: seed.templateId, stopOnReply: true }], appliesTo: null } });
    expect(r.status(), await r.text()).toBeGreaterThanOrEqual(400);
    const r2 = await context.request.post("/api/leads/sequences", { headers: { origin: ORIGIN }, data: { name: "Bad form", steps: [{ delayMinutes: 0, templateId: seed.templateId, stopOnReply: true }], appliesTo: { leadFormId: "nope" } } });
    expect(r2.status()).toBeGreaterThanOrEqual(400);
    expect((await r2.text())).not.toMatch(/prisma|stack|undefined/i);
    // The first step always runs at once, so the oversized wait has to be on a later step.
    const r3 = await context.request.post("/api/leads/sequences", { headers: { origin: ORIGIN }, data: { name: "Too long", steps: [{ delayMinutes: 0, templateId: seed.templateId }, { delayMinutes: 999999999, templateId: seed.templateId }], appliesTo: null } });
    expect(r3.status()).toBeGreaterThanOrEqual(400);
    await bctx.close();
  });

  test("agents see leads but cannot export, reassign or manage follow-ups; other workspaces see nothing", async ({ context, browser }) => {
    const owner = await signupUser(context, "lead");
    const seed = await seedLeads(owner);
    const agent = await createAgent(browser, owner);
    const a = await loginFresh(browser, agent.email);
    await a.page.goto("/app/leads");
    await expect(leadButton(a.page, "Asha Kulkarni").first()).toBeVisible();
    await expect(a.page.getByRole("link", { name: "Download as CSV" })).toHaveCount(0);
    const dlg = await openLead(a.page, "Asha Kulkarni");
    await expect(dlg.getByLabel("Assigned to")).toBeDisabled();
    await expect(dlg.getByText("Only owners and admins can reassign leads.")).toBeVisible();
    await a.page.keyboard.press("Escape");
    expect((await a.context.request.get("/api/leads/export")).status()).toBe(403);
    await a.page.goto("/app/leads/sequences");
    await expect(a.page.getByText("Only owners and admins manage follow-ups")).toBeVisible();
    await a.page.goto("/app/leads/forms");
    await expect(a.page.getByText(/only owners and admins can change it/)).toBeVisible();
    await expect(a.page.getByLabel("Consent wording")).toBeDisabled();
    await a.context.close();

    const bctx = await browser.newContext();
    const bpage = await bctx.newPage();
    await signupUser(bctx, "lead");
    await bpage.goto("/app/leads");
    await expect(bpage.getByText("No leads yet")).toBeVisible();
    const id = seed.leads[0].id;
    expect((await bctx.request.get(`/api/leads/${id}`)).status()).toBe(404);
    const patch = await bctx.request.patch(`/api/leads/${id}`, { headers: { origin: ORIGIN }, data: { status: "won" } });
    expect([403, 404]).toContain(patch.status());
    expect(await (await bctx.request.get("/api/leads/export")).text()).not.toContain("Asha Kulkarni");
    const d = await db();
    expect((await d.query(`select status from "Lead" where id = $1`, [id])).rows[0].status).toBe("new");
    await bctx.close();
  });

  test("API rejects an unknown stage with plain words", async ({ context }) => {
    const u = await signupUser(context, "lead");
    const seed = await seedLeads(u);
    const r = await context.request.patch(`/api/leads/${seed.leads[0].id}`, { headers: { origin: ORIGIN }, data: { status: "hot" } });
    expect(r.status()).toBe(400);
    expect(await r.text()).not.toMatch(/prisma|stack|undefined/i);
  });

  test("leads fit a phone in dark theme @mobile", async ({ page, context }) => {
    const u = await signupUser(context, "lead");
    await seedLeads(u);
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto("/app/leads");
    await expect(leadButton(page, "Asha Kulkarni").first()).toBeVisible();
    expect(await overflowsX(page), "pipeline at 360px").toBe(false);
    await page.getByRole("tab", { name: "Table" }).click();
    await expect(page.getByRole("button", { name: "Asha Kulkarni", exact: true })).toBeVisible();
    expect(await overflowsX(page), "table at 360px").toBe(false);
    const dlg = await openLead(page, "Asha Kulkarni");
    expect(await overflowsX(page), "drawer at 360px").toBe(false);
    await page.keyboard.press("Escape");
    await expect(dlg).toBeHidden();
    await page.goto("/app/leads/sequences");
    expect(await overflowsX(page), "sequences at 360px").toBe(false);
    await toggleTheme(page).catch(async () => {
      await page.getByRole("button", { name: /^more$/i }).first().click();
      await toggleTheme(page);
    });
    expect(await axeSerious(page), "axe dark").toEqual([]);
  });
});
