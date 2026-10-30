import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { closeDb, connectFakeNumber, db, signupUser, stamp, tick, watchErrors, type TestUser } from "./helpers";
import { agentContext, axeSerious, goDark, noHorizontalOverflow, openFromNav, seedContact, seedTemplate } from "./audience-campaigns-util";

test.afterAll(closeDb);
test.beforeEach(() => {
  test.setTimeout(300_000);
});

const pad = (n: number) => String(n).padStart(2, "0");
const localInput = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const inDays = (days: number, hour = 10) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return d;
};

type World = { user: TestUser; fx: Awaited<ReturnType<typeof connectFakeNumber>>; tpl: { id: string; name: string } };

/** Owner with a connected number, an approved template and a small audience: 3 opted in (2 tagged vip), 1 not opted in, 1 opted out. */
async function world(context: BrowserContext, template: Parameters<typeof seedTemplate>[2] = {}): Promise<World> {
  const user = await signupUser(context, "bc");
  const fx = await connectFakeNumber(user.tenantId);
  const tpl = await seedTemplate(user.tenantId, fx.wabaRef, { name: "festival_offer", status: "approved", category: "MARKETING", body: "Hello {{1}}, our festival offer is live.", ...template });
  const n = stamp().slice(-6);
  await seedContact(user.tenantId, { phone: `+91700${n}1`, name: "Opt One", tags: ["vip"], optIn: true });
  await seedContact(user.tenantId, { phone: `+91700${n}2`, name: "Opt Two", tags: ["vip", "pune"], optIn: true });
  await seedContact(user.tenantId, { phone: `+91700${n}3`, name: "Opt Three", tags: ["delhi"], optIn: true });
  await seedContact(user.tenantId, { phone: `+91700${n}4`, name: "Not Opted", tags: ["vip"] });
  await seedContact(user.tenantId, { phone: `+91700${n}5`, name: "Gone Person", tags: ["vip"], optedOut: true });
  return { user, fx, tpl };
}

async function seedBroadcast(w: World, b: { name: string; status: string; at?: Date | null; tags?: string[] }) {
  const d = await db();
  const id = `bc_${stamp()}`;
  await d.query(
    `insert into "Broadcast" (id, "tenantId", "phoneNumberId", "templateId", name, status, "segmentTags", "scheduledAt") values ($1,$2,$3,$4,$5,$6::"BroadcastStatus",$7,$8)`,
    [id, w.user.tenantId, w.fx.pnRef, w.tpl.id, b.name, b.status, b.tags ?? [], b.at ?? null],
  );
  return id;
}

const nextBtn = (p: Page, label: string | RegExp) => p.getByRole("button", { name: label });
const stepHeading = (p: Page, text: string) => p.getByRole("heading", { level: 2, name: text });

/** Drives wizard step 1 and 2 (everyone opted in, the given template). */
async function toSchedule(page: Page, tplLabel = /Festival offer/, name?: string) {
  await expect(stepHeading(page, "1. Audience")).toBeVisible();
  await nextBtn(page, "Next: Message").click();
  await expect(stepHeading(page, "2. Message")).toBeFocused();
  await page.getByLabel(/^Template/).selectOption({ label: (await page.getByRole("option", { name: tplLabel }).first().textContent())!.trim() });
  if (name) await page.getByLabel(/^Broadcast name/).fill(name);
  await nextBtn(page, "Next: Schedule").click();
  await expect(stepHeading(page, "3. Schedule")).toBeFocused();
}

async function openWizard(page: Page) {
  await openFromNav(page, "Broadcasts", /\/app\/broadcasts/);
  await page.getByRole("link", { name: /New broadcast|Create your first broadcast/ }).first().click();
  await page.waitForURL(/\/app\/broadcasts\/new/);
  await expect(page.getByRole("heading", { level: 1, name: "New broadcast" })).toBeVisible();
}

test("broadcasts list: empty state, limit and results panels, tabs, calendar and list toggle", async ({ page, context }) => {
  const errors = watchErrors(page);
  const w = await world(context);
  await openFromNav(page, "Broadcasts", /\/app\/broadcasts/);
  await expect(page.getByRole("heading", { level: 1, name: "Broadcasts" })).toBeVisible();
  await expect(page.getByText("No broadcasts yet")).toBeVisible();
  await expect(page.getByRole("link", { name: "Create your first broadcast" })).toBeVisible();
  // limit panel in plain words, results panel empty
  await expect(page.getByRole("heading", { name: "Daily sending limit" })).toBeVisible();
  await expect(page.getByText("+15550001")).toBeVisible();
  await expect(page.getByText("Quality: High")).toBeVisible();
  await expect(page.getByText(/0 of 250 people messaged in the last 24 hours. Room for 250 more./)).toBeVisible();
  await expect(page.getByText("No broadcast results yet")).toBeVisible();
  await expect(page.locator("main")).not.toContainText(/TIER_250|GREEN/);

  // seeded broadcasts: list, filter, search
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  await seedBroadcast(w, { name: "Alpha draft", status: "draft" });
  await seedBroadcast(w, { name: "Bravo done", status: "completed", at: new Date(today.getTime() - 3600_000) });
  await seedBroadcast(w, { name: "Charlie sched", status: "scheduled", at: new Date(today.getTime() + 60_000) });
  await seedBroadcast(w, { name: "Delta paused", status: "paused", at: new Date(today.getTime() + 120_000) });
  await seedBroadcast(w, { name: "Echo cancelled", status: "canceled", at: new Date(today.getTime() + 180_000) });
  await seedBroadcast(w, { name: "Foxtrot broke", status: "failed", at: new Date(today.getTime() + 240_000) });
  await page.reload();
  await expect(page.getByText("6 broadcasts")).toBeVisible();
  for (const [name, label] of [["Alpha draft", "Draft"], ["Bravo done", "Completed"], ["Charlie sched", "Scheduled"], ["Delta paused", "Paused"], ["Echo cancelled", "Canceled"], ["Foxtrot broke", "Failed"]]) {
    await expect(page.getByRole("row", { name: new RegExp(name) }).getByText(label, { exact: true })).toBeVisible();
  }
  await expect(page.getByRole("row", { name: /Alpha draft/ }).getByText("Not started").or(page.getByRole("row", { name: /Alpha draft/ }).getByText(/Created /)).locator("visible=true").first()).toBeVisible();
  await expect(page.getByRole("row", { name: /Charlie sched/ }).getByText(/Scheduled for /)).toBeVisible();
  await page.getByLabel("Show broadcasts with status").selectOption({ label: "Paused" });
  await expect(page.getByText("1 of 6 shown")).toBeVisible();
  await page.getByLabel("Show broadcasts with status").selectOption({ label: "All broadcasts" });
  await page.getByLabel("Search broadcasts by name").fill("zzz");
  await expect(page.getByText('No broadcasts match "zzz"')).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page.getByText("6 broadcasts")).toBeVisible();

  // calendar tab (keyboard-operable tabs)
  const calTab = page.getByRole("tab", { name: "Calendar" });
  await calTab.focus();
  await page.keyboard.press("Enter");
  await expect(calTab).toHaveAttribute("aria-selected", "true");
  const monthTitle = new Date().toLocaleString(undefined, { month: "long", year: "numeric" });
  await expect(page.getByRole("heading", { level: 2, name: monthTitle })).toBeVisible();
  await expect(page.getByRole("table", { name: new RegExp(`Broadcasts planned for ${monthTitle}`) })).toBeVisible();
  for (const label of ["Scheduled or draft", "Sending", "Completed", "Paused or failed", "Canceled"]) await expect(page.getByRole("list", { name: "Colour key" }).getByText(label, { exact: true })).toBeVisible();
  // 5 broadcasts on one day: 3 shown, rest behind "+N more"
  const cal = page.getByRole("table", { name: /Broadcasts planned for/ });
  await expect(cal.getByRole("link", { name: /Charlie sched/ })).toBeVisible();
  const more = cal.getByRole("button", { name: /\+\d+ more/ });
  await expect(more).toBeVisible();
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await more.click();
  // the same button now reads "Show fewer"
  await expect(cal.getByRole("button", { name: /Show fewer/ })).toHaveAttribute("aria-expanded", "true");
  await expect(cal.getByRole("link", { name: /Foxtrot broke/ })).toBeVisible();
  // month navigation
  await page.getByRole("button", { name: "Next month" }).click();
  const nextTitle = new Date(today.getFullYear(), today.getMonth() + 1, 1).toLocaleString(undefined, { month: "long", year: "numeric" });
  await expect(page.getByRole("heading", { level: 2, name: nextTitle })).toBeVisible();
  await expect(page.getByRole("button", { name: "This month" })).toBeEnabled();
  await page.getByRole("button", { name: "This month" }).click();
  await expect(page.getByRole("heading", { level: 2, name: monthTitle })).toBeVisible();
  // "+" plans a broadcast on that day
  const tomorrow = new Date(Date.now() + 86_400_000);
  await page.getByRole("link", { name: `Plan a broadcast on ${tomorrow.toDateString()}` }).click();
  await page.waitForURL(/\/app\/broadcasts\/new\?date=\d{4}-\d{2}-\d{2}/);
  // back to list tab and open a broadcast from its chip
  await page.goBack();
  await page.getByRole("tab", { name: "Calendar" }).click();
  await page.getByRole("table", { name: /Broadcasts planned for/ }).getByRole("link", { name: /Charlie sched/ }).click();
  await page.waitForURL(/\/app\/broadcasts\/bc_/);
  await expect(page.getByRole("heading", { level: 1, name: "Charlie sched" })).toBeVisible();
  const unexpected = errors.filter((e) => !/40[0-9]|50[0-9]/.test(e));
  expect(unexpected, unexpected.join("\n")).toEqual([]);
});

test("wizard prerequisites: no number, no approved template, unsupported template", async ({ page, context }) => {
  const user = await signupUser(context, "bc");
  await page.goto("/app/broadcasts/new");
  await expect(page.getByText("Connect a WhatsApp number first")).toBeVisible();
  await expect(page.getByRole("link", { name: "Go to setup" })).toBeVisible();
  await page.goto("/app/broadcasts");
  await expect(page.getByText("No WhatsApp number connected")).toBeVisible();

  const fx = await connectFakeNumber(user.tenantId);
  await seedTemplate(user.tenantId, fx.wabaRef, { name: "only_draft", status: "draft" });
  await page.goto("/app/broadcasts/new");
  await expect(page.getByText("You need an approved template first")).toBeVisible();
  await page.getByRole("link", { name: "Go to templates" }).click();
  await page.waitForURL(/\/app\/templates/);

  await seedTemplate(user.tenantId, fx.wabaRef, {
    name: "location_header_tpl",
    status: "approved",
    components: [{ type: "HEADER", format: "LOCATION" }, { type: "BODY", text: "With a map pin" }],
  });
  // image headers are supported now (the value mapping handles them), so they stay selectable
  await seedTemplate(user.tenantId, fx.wabaRef, {
    name: "image_header_tpl",
    status: "approved",
    components: [{ type: "HEADER", format: "IMAGE", example: { header_handle: ["h"] } }, { type: "BODY", text: "With picture" }],
  });
  await seedContact(user.tenantId, { phone: "+917011100001", name: "Opt", optIn: true });
  await page.goto("/app/broadcasts/new");
  await page.getByRole("button", { name: "Next: Message" }).click();
  await expect(page.getByRole("option", { name: /Image header tpl/ })).toBeEnabled();
  const opt = page.getByRole("option", { name: /Location header tpl/ });
  await expect(opt).toBeDisabled();
  await expect(opt).toContainText("not available for broadcasts");
  await expect(page.getByRole("button", { name: "Next: Schedule" })).toBeDisabled();
  await expect(page.getByText("Choose a template to continue.")).toBeVisible();
});

test("wizard: audience step counts, tags, hints; message step preview; schedule validation", async ({ page, context }) => {
  const errors = watchErrors(page);
  await world(context);
  await openWizard(page);
  // step 1
  await expect(page.getByRole("navigation", { name: "Broadcast steps" })).toBeVisible();
  await expect(page.locator("p", { hasText: /Sending from/ })).toContainText("+15550001");
  await expect(page.getByText(/3 people will get this message. Contacts who opted out are always left out./)).toBeVisible();
  await page.getByRole("radio", { name: /Only contacts with certain tags/ }).check();
  await expect(page.getByText("Add a tag to see how many people match.")).toBeVisible();
  await expect(page.getByText("Add at least one tag to continue.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Next: Message" })).toBeDisabled();
  // typed but not added
  await page.getByLabel(/^Add a tag/).fill("vip");
  await expect(page.getByText('Press Add to keep "vip", or clear the box, to continue.').first()).toBeVisible();
  await page.getByLabel(/^Add a tag/).press("Enter");
  await expect(page.getByRole("button", { name: "Remove tag vip" })).toBeVisible();
  // vip: 2 opted-in (the not-opted and opted-out vip contacts are excluded)
  await expect(page.getByText(/2 people will get this message/)).toBeVisible();
  // suggested tag chip
  await page.getByRole("button", { name: "Add tag delhi" }).click();
  await expect(page.getByText(/3 people will get this message/)).toBeVisible();
  await page.getByRole("button", { name: "Remove tag delhi" }).click();
  await expect(page.getByText(/2 people will get this message/)).toBeVisible();
  // unknown tag only -> no one matches, with a helpful way out
  await page.getByRole("button", { name: "Remove tag vip" }).click();
  await page.getByLabel(/^Add a tag/).fill("nobody");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText("No one matches yet").first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Add contacts" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Next: Message" })).toBeDisabled();
  await page.getByRole("button", { name: "Remove tag nobody" }).click();
  await page.getByRole("radio", { name: /Everyone who opted in/ }).check();
  await expect(page.getByText(/3 people will get this message/)).toBeVisible();

  // step 2
  await page.getByRole("button", { name: "Next: Message" }).click();
  await expect(stepHeading(page, "2. Message")).toBeFocused();
  await expect(page.getByRole("button", { name: "Next: Schedule" })).toBeDisabled();
  await page.getByLabel(/^Template/).selectOption({ label: "Festival offer (American English, Marketing)" });
  const bubble = page.getByRole("group", { name: "Message preview" });
  await expect(bubble).toContainText("Hello {{1}}, our festival offer is live.");
  // each placeholder is mapped to where its value comes from; the first one defaults to the contact's name
  const mapping = page.getByRole("group", { name: "Fill in the placeholders" });
  await expect(mapping).toContainText("Message placeholder {{1}}");
  await expect(mapping.getByLabel("Where it comes from")).toContainText("Their full name");
  await expect(mapping.getByRole("radio", { name: /Skip that person/ })).toBeChecked();
  await expect(page.getByText(/marketing template, so it goes only to contacts who opted in/)).toBeVisible();
  await expect(page.getByLabel(/^Broadcast name/)).toHaveAttribute("placeholder", /Festival offer, \d/);
  await page.getByRole("button", { name: "Next: Schedule" }).click();

  // step 3: validation of the schedule
  await expect(stepHeading(page, "3. Schedule")).toBeFocused();
  await page.getByRole("radio", { name: /At a date and time I choose/ }).check();
  await page.getByLabel(/^Date and time/).fill(localInput(inDays(-1)));
  await page.getByRole("button", { name: "Next: Review" }).click();
  await expect(page.getByText("Pick a time in the future.")).toBeVisible();
  await page.getByLabel(/^Date and time/).fill(localInput(inDays(100)));
  await page.getByRole("button", { name: "Next: Review" }).click();
  await expect(page.getByText("Pick a time within the next 90 days.")).toBeVisible();
  await page.getByLabel(/^Date and time/).fill("");
  await page.getByRole("button", { name: "Next: Review" }).click();
  await expect(page.getByText("Pick a date and time.")).toBeVisible();
  // going back through the stepper works and keeps choices
  await page.getByRole("button", { name: /Step 2, Message, done/ }).click();
  await expect(page.getByLabel(/^Template/)).toHaveValue(/.+/);
  expect(errors.filter((e) => !/40[0-9]/.test(e)), errors.join("\n")).toEqual([]);
});

test("wizard: schedule in the future with retries, review (cost note, limits, consent box), then manage the scheduled broadcast", async ({ page, context }) => {
  const errors = watchErrors(page);
  const w = await world(context);
  await openWizard(page);
  await toSchedule(page, /Festival offer/, "Spring promo");
  const when = inDays(3, 14);
  await page.getByRole("radio", { name: /At a date and time I choose/ }).check();
  await page.getByLabel(/^Date and time/).fill(localInput(when));
  await page.getByText("More options").click();
  await page.getByLabel(/^Try again for people WhatsApp held back/).selectOption({ label: "For up to 3 days" });
  await page.getByRole("button", { name: "Next: Review" }).click();

  await expect(stepHeading(page, "4. Review")).toBeFocused();
  await expect(page.getByText(/3 people will get Festival offer on /)).toBeVisible();
  const summary = page.getByRole("definition").or(page.locator("dd"));
  await expect(page.getByText("Spring promo").first()).toBeVisible();
  await expect(page.getByText("Held-back messages are retried daily for up to 3 days")).toBeVisible();
  // cost: never a made-up number
  const cost = page.getByTestId("cost-estimate");
  await expect(cost).toBeVisible();
  const costText = (await cost.textContent())!;
  if (/Not available yet/.test(costText)) await expect(page.getByText(/No price list is set up/)).toBeVisible();
  else await expect(page.getByText(/This is an estimate/)).toBeVisible();
  await expect(page.getByText("Sending limits")).toBeVisible();
  await expect(page.getByText(/Your WhatsApp account can message up to 250 different people in any 24 hours, shared by all your numbers./)).toBeVisible();
  void summary;
  // cannot send until the consent box is ticked, and the hint says why
  const send = page.getByRole("button", { name: "Schedule broadcast" });
  await expect(send).toBeDisabled();
  await expect(page.getByText("Tick the box above to send.")).toBeVisible();
  await page.getByLabel(/I confirm that everyone in this audience agreed/).check();
  await expect(send).toBeEnabled();
  // Change links return to the right step
  await page.getByRole("button", { name: "Change when it goes out" }).click();
  await expect(stepHeading(page, "3. Schedule")).toBeFocused();
  await page.getByRole("button", { name: "Next: Review" }).click();
  await expect(page.getByLabel(/I confirm that everyone/)).not.toBeChecked(); // re-confirm after a change
  await page.getByLabel(/I confirm that everyone/).check();
  await send.click();

  // detail page
  await page.waitForURL(/\/app\/broadcasts\/bc_|\/app\/broadcasts\/c[a-z0-9]{20,}/);
  await expect(page.getByRole("heading", { level: 1, name: "Spring promo" })).toBeVisible();
  await expect(page.getByText("Broadcast scheduled")).toBeVisible();
  await expect(page.getByText("Scheduled", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/Everyone who opted in/)).toBeVisible();
  await expect(page.getByText(/Scheduled for /).first()).toBeVisible();
  await expect(page.getByText("No one has been queued yet.").or(page.getByText(/% handled, out of 3 people/))).toBeVisible();

  // funnel panel with retry note
  await expect(page.getByRole("heading", { name: "Results" })).toBeVisible();
  await expect(page.getByText("Retries are on.")).toBeVisible();
  await expect(page.getByText(/tried again daily for up to 3 days/)).toBeVisible();

  // reschedule validation and success
  await page.getByLabel(/^New date and time/).fill(localInput(inDays(-1)));
  await page.getByRole("button", { name: "Change schedule" }).click();
  await expect(page.getByText("Pick a time in the future.")).toBeVisible();
  await page.getByLabel(/^New date and time/).fill(localInput(inDays(5, 9)));
  await page.getByRole("button", { name: "Change schedule" }).click();
  await expect(page.getByText("Schedule updated")).toBeVisible();

  // it is on the calendar
  await page.getByRole("link", { name: "Broadcasts", exact: true }).first().click();
  await page.waitForURL(/\/app\/broadcasts$/);
  await expect(page.getByRole("row", { name: /Spring promo/ }).getByText("Scheduled", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Calendar" }).click();
  const five = inDays(5, 9);
  if (five.getMonth() !== new Date().getMonth()) await page.getByRole("button", { name: "Next month" }).click();
  await expect(page.getByRole("table", { name: /Broadcasts planned for/ }).getByRole("link", { name: /Spring promo/ })).toBeVisible();

  // cancel with confirm: Keep first, then cancel for real
  await page.getByRole("tab", { name: "List" }).click();
  await page.getByRole("link", { name: /Spring promo/ }).click();
  await page.getByRole("button", { name: "Cancel broadcast" }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm.getByText('Cancel "Spring promo"?')).toBeVisible();
  await expect(confirm.getByText(/cannot be restarted/)).toBeVisible();
  await confirm.getByRole("button", { name: "Keep broadcast" }).click();
  await expect(page.getByRole("button", { name: "Cancel broadcast" })).toBeFocused();
  await page.getByRole("button", { name: "Cancel broadcast" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Cancel broadcast" }).click();
  await expect(page.getByText("Broadcast canceled")).toBeVisible();
  await expect(page.getByText("Canceled", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel broadcast" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send broadcast" })).toHaveCount(0);
  const status = (await (await db()).query(`select status from "Broadcast" where "tenantId"=$1 and name='Spring promo'`, [w.user.tenantId])).rows[0].status;
  expect(status).toBe("canceled");
  expect(errors.filter((e) => !/40[0-9]/.test(e)), errors.join("\n")).toEqual([]);
});

test("wizard: send now, confirm, sending without Meta fails per person in plain words, funnel and limits update", async ({ page, context }) => {
  const errors = watchErrors(page);
  const w = await world(context);
  await openWizard(page);
  await toSchedule(page, /Festival offer/, "Now blast");
  await page.getByRole("button", { name: "Next: Review" }).click();
  await expect(stepHeading(page, "4. Review")).toBeFocused();
  await expect(page.getByText(/right after you press Send/).first()).toBeVisible();
  await expect(page.getByText("Held-back messages are not retried")).toBeVisible();
  await page.getByLabel(/I confirm that everyone/).check();
  await page.getByRole("button", { name: "Send broadcast" }).click();
  const confirm = page.getByRole("alertdialog").or(page.getByRole("dialog"));
  await expect(confirm.getByText("Send to 3 people now?")).toBeVisible();
  await expect(confirm.getByText(/cannot be taken back/)).toBeVisible();
  await confirm.getByRole("button", { name: "Cancel" }).click(); // cancel first
  await expect(page.getByRole("button", { name: "Send broadcast" })).toBeEnabled();
  await page.getByRole("button", { name: "Send broadcast" }).click();
  await confirm.getByRole("button", { name: "Send broadcast" }).click();
  await page.waitForURL(/\/app\/broadcasts\/[a-z0-9_]{10,}$/);
  await expect(page.getByRole("heading", { level: 1, name: "Now blast" })).toBeVisible();
  await expect(page.getByText("Broadcast started")).toBeVisible();

  // worker runs; the fake number can't really send, so each person ends up failed with a readable reason
  await tick(page.request, 4);
  await expect(page.getByText(/% handled, out of 3 people/)).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => (await page.getByRole("row", { name: /Opt (One|Two|Three)/ }).count()), { timeout: 60_000 }).toBe(3);
  const people = page.getByRole("table", { name: "People in this broadcast" });
  await expect(people.getByText("Opt One")).toBeVisible();
  await expect(people).not.toContainText(/undefined|\[object|Error:/);
  await expect(page.getByText("Not opted")).toHaveCount(0);
  await expect(page.getByText("Gone Person")).toHaveCount(0);
  const failedCount = await people.getByText("Failed", { exact: true }).count();
  if (failedCount > 0) {
    // reason is a sentence; the raw code is tucked in Details
    await expect(people.getByText(/could not be sent|could not receive|WhatsApp|did not confirm|Meta/i).first()).toBeVisible();
    await expect(people.getByText("Details").first()).toBeVisible();
  }
  // controls match the status
  const status = (await (await db()).query(`select status from "Broadcast" where "tenantId"=$1 and name='Now blast'`, [w.user.tenantId])).rows[0].status;
  if (["completed", "failed", "canceled"].includes(status)) await expect(page.getByRole("button", { name: "Cancel broadcast" })).toHaveCount(0);
  // list page: row + results panel
  await page.getByRole("link", { name: "Broadcasts", exact: true }).first().click();
  await page.waitForURL(/\/app\/broadcasts$/);
  await expect(page.getByRole("row", { name: /Now blast/ })).toBeVisible();
  expect(errors.filter((e) => !/40[0-9]|50[0-9]/.test(e)), errors.join("\n")).toEqual([]);
});

test("wizard: leaving a prepared review discards the draft on Cancel; Save as draft keeps it and it can be started later", async ({ page, context }) => {
  const w = await world(context);
  await openWizard(page);
  await toSchedule(page, /Festival offer/, "Draft keeper");
  await page.getByRole("button", { name: "Next: Review" }).click();
  await expect(stepHeading(page, "4. Review")).toBeFocused();
  const count = async () => (await (await db()).query(`select count(*)::int n from "Broadcast" where "tenantId"=$1 and name='Draft keeper' and status <> 'canceled'`, [w.user.tenantId])).rows[0].n;
  expect(await count()).toBe(1);
  // Back to step 1 and use Cancel there: draft is discarded
  await page.getByRole("button", { name: /Step 1, Audience, done/ }).click();
  await page.getByRole("link", { name: "Cancel" }).click();
  await page.waitForURL(/\/app\/broadcasts$/);
  await expect.poll(count).toBe(0);

  // Save as draft
  await page.getByRole("link", { name: "New broadcast" }).click();
  await toSchedule(page, /Festival offer/, "Draft keeper");
  await page.getByRole("button", { name: "Next: Review" }).click();
  await page.getByRole("button", { name: "Save as draft" }).click();
  await page.waitForURL(/\/app\/broadcasts\/[a-z0-9_]{10,}$/);
  await expect(page.getByText("Saved as a draft")).toBeVisible();
  await expect(page.getByText("Draft", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Not scheduled yet")).toBeVisible();
  await expect(page.getByRole("button", { name: "Send broadcast" })).toBeVisible();
  // start from the detail page: confirm wording
  await page.getByRole("button", { name: "Send broadcast" }).click();
  const confirm = page.getByRole("dialog").or(page.getByRole("alertdialog"));
  await expect(confirm.getByText('Send "Draft keeper" now?')).toBeVisible();
  await expect(confirm.getByText(/who opted in/)).toBeVisible();
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm).toHaveCount(0);
});

test("broadcast detail: pause and resume are explained when the broadcast is live", async ({ page, context }) => {
  const w = await world(context);
  const id = await seedBroadcast(w, { name: "Live one", status: "paused" });
  await page.goto(`/app/broadcasts/${id}`);
  await expect(page.getByRole("heading", { level: 1, name: "Live one" })).toBeVisible();
  await expect(page.getByText("This broadcast is paused")).toBeVisible();
  await expect(page.getByText(/Nothing has been sent yet, so resuming starts sending right away/)).toBeVisible();
  await page.getByRole("button", { name: "Resume sending" }).click();
  const confirm = page.getByRole("dialog").or(page.getByRole("alertdialog"));
  await expect(confirm.getByText('Resume "Live one"?')).toBeVisible();
  await expect(confirm.getByText(/starts sending to 3 people|starts sending to everyone in the audience/).or(confirm.getByText(/right now, not at the time it was scheduled for/))).toBeVisible();
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator("main")).toContainText("Paused");
});

test("broadcasts: agent sees a read-only view; direct creation and actions are refused; other workspaces cannot reach it", async ({ page, context, browser }) => {
  const w = await world(context);
  const id = await seedBroadcast(w, { name: "Owner secret broadcast", status: "draft" });
  const a = await agentContext(browser, w.user.tenantId, "agent");
  try {
    const ap = a.page;
    await ap.goto("/app");
    await expect(ap.getByRole("navigation").getByRole("link", { name: "Broadcasts", exact: true })).toHaveCount(0);
    await ap.goto("/app/broadcasts");
    await expect(ap.getByRole("heading", { level: 1 }).first()).toBeVisible();
    await expect(ap.getByRole("link", { name: "New broadcast" })).toHaveCount(0);
    await ap.goto("/app/broadcasts/new");
    await expect(ap.getByText("Only owners and admins can create broadcasts")).toBeVisible();
    await ap.goto(`/app/broadcasts/${id}`);
    await expect(ap.getByRole("heading", { level: 1, name: "Owner secret broadcast" })).toBeVisible();
    await expect(ap.getByRole("button", { name: /Send broadcast|Cancel broadcast|Resume|Pause/ })).toHaveCount(0);
    await expect(ap.getByLabel(/^New date and time/)).toHaveCount(0);
    const origin = new URL(ap.url()).origin;
    expect((await ap.request.post(`/api/broadcasts/${id}/start`, { headers: { origin } })).status()).toBe(403);
    expect((await ap.request.post(`/api/broadcasts/${id}/cancel`, { headers: { origin } })).status()).toBe(403);
    expect((await ap.request.post(`/api/broadcasts`, { headers: { origin }, data: { name: "x", phoneNumberId: w.fx.pnRef, templateId: w.tpl.id } })).status()).toBe(403);
  } finally {
    await a.context.close();
  }
  const other = await browser.newContext();
  try {
    await signupUser(other, "bc");
    const p2 = await other.newPage();
    await p2.goto(`/app/broadcasts/${id}`);
    await expect(p2.getByText("We could not load this broadcast")).toBeVisible();
    await expect(p2.getByText("Owner secret broadcast")).toHaveCount(0);
    await p2.goto("/app/broadcasts");
    await expect(p2.getByText("Owner secret broadcast")).toHaveCount(0);
    const origin = new URL(p2.url()).origin;
    expect((await p2.request.get(`/api/broadcasts/${id}`)).status()).toBe(404);
    expect((await p2.request.post(`/api/broadcasts/${id}/cancel`, { headers: { origin } })).status()).toBe(404);
    expect((await p2.request.get(`/api/broadcasts/${id}/funnel`)).status()).toBe(404);
    const row = (await (await db()).query(`select status from "Broadcast" where id=$1`, [id])).rows[0];
    expect(row.status).toBe("draft");
    // creating with another tenant's template/number is refused
    expect((await p2.request.post(`/api/broadcasts`, { headers: { origin }, data: { name: "steal", phoneNumberId: w.fx.pnRef, templateId: w.tpl.id } })).status()).toBe(404);
  } finally {
    await other.close();
  }
});

test("broadcasts: api guards (past, too far ahead, unapproved template) and list error state", async ({ page, context }) => {
  const w = await world(context);
  const draftTpl = await seedTemplate(w.user.tenantId, w.fx.wabaRef, { name: "not_approved_yet", status: "pending" });
  await page.goto("/app/broadcasts");
  const origin = new URL(page.url()).origin;
  const post = (data: object) => page.request.post("/api/broadcasts", { headers: { origin }, data });
  const base = { name: "t", phoneNumberId: w.fx.pnRef, templateId: w.tpl.id };
  const past = await post({ ...base, scheduledAt: new Date(Date.now() - 3600_000).toISOString() });
  expect(past.status()).toBe(400);
  const far = await post({ ...base, scheduledAt: new Date(Date.now() + 120 * 86_400_000).toISOString() });
  expect(far.status()).toBe(400);
  expect((await post({ ...base, retryDays: 9 })).status()).toBe(400);
  expect((await post({ ...base, templateId: draftTpl.id })).status()).toBe(400);
  expect((await post({ ...base, name: "" })).status()).toBe(400);

  // list failure: friendly, with retry
  await page.route("**/api/broadcasts", (r) => (r.request().method() === "GET" ? r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "PrismaClientInitializationError at x.ts" }) }) : r.continue()));
  await page.reload();
  await expect(page.getByText("We could not load your broadcasts")).toBeVisible();
  await expect(page.locator("main")).not.toContainText(/Prisma|x\.ts/);
  await page.unroute("**/api/broadcasts");
  await page.getByRole("button", { name: "Try again" }).first().click();
  await expect(page.getByText("No broadcasts yet")).toBeVisible();
});

test("broadcasts: accessibility light and dark across list, calendar, wizard steps and detail", async ({ page, context }) => {
  const w = await world(context);
  await seedBroadcast(w, { name: "Axe broadcast", status: "scheduled", at: new Date(Date.now() + 3600_000) });
  const found: string[] = [];
  await page.goto("/app/broadcasts");
  await expect(page.getByRole("row", { name: /Axe broadcast/ })).toBeVisible();
  found.push(...(await axeSerious(page, "broadcasts list")));
  await page.getByRole("tab", { name: "Calendar" }).click();
  await expect(page.getByRole("table", { name: /Broadcasts planned for/ })).toBeVisible();
  found.push(...(await axeSerious(page, "broadcasts calendar")));
  await page.goto("/app/broadcasts/new");
  await expect(stepHeading(page, "1. Audience")).toBeVisible();
  await page.getByRole("radio", { name: /Only contacts with certain tags/ }).check();
  found.push(...(await axeSerious(page, "wizard audience")));
  await page.getByRole("radio", { name: /Everyone who opted in/ }).check();
  await toSchedule(page, /Festival offer/);
  found.push(...(await axeSerious(page, "wizard schedule")));
  await page.getByRole("button", { name: "Next: Review" }).click();
  await expect(stepHeading(page, "4. Review")).toBeVisible();
  found.push(...(await axeSerious(page, "wizard review")));
  await goDark(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  found.push(...(await axeSerious(page, "wizard review dark")));
  await page.goto("/app/broadcasts");
  await expect(page.getByRole("row", { name: /Axe broadcast/ })).toBeVisible();
  found.push(...(await axeSerious(page, "broadcasts list dark")));
  await page.getByRole("tab", { name: "Calendar" }).click();
  found.push(...(await axeSerious(page, "broadcasts calendar dark")));
  await page.getByRole("tab", { name: "List" }).click();
  await page.getByRole("link", { name: /Axe broadcast/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Axe broadcast" })).toBeVisible();
  found.push(...(await axeSerious(page, "broadcast detail dark")));
  expect(found, found.join("\n")).toEqual([]);
});

test("broadcasts: 360px layouts for list, calendar agenda, wizard and detail @mobile", async ({ page, context }) => {
  const w = await world(context);
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const id = await seedBroadcast(w, { name: "A broadcast with a quite long name that must wrap on a phone screen", status: "scheduled", at: new Date(today.getTime() + 60_000) });
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto("/app/broadcasts");
  await expect(page.getByRole("heading", { level: 1, name: "Broadcasts" })).toBeVisible();
  await noHorizontalOverflow(page, "broadcasts list");
  await page.getByRole("tab", { name: "Calendar" }).click();
  await expect(page.getByRole("list", { name: /Broadcasts in / })).toBeVisible();
  await noHorizontalOverflow(page, "calendar agenda");
  await page.goto("/app/broadcasts/new");
  await noHorizontalOverflow(page, "wizard step 1");
  await page.getByRole("button", { name: "Next: Message" }).click();
  await page.getByLabel(/^Template/).selectOption({ label: "Festival offer (American English, Marketing)" });
  await noHorizontalOverflow(page, "wizard step 2");
  await page.getByRole("button", { name: "Next: Schedule" }).click();
  await page.getByRole("radio", { name: /At a date and time I choose/ }).check();
  await noHorizontalOverflow(page, "wizard step 3");
  await page.getByLabel(/^Date and time/).fill(localInput(inDays(2)));
  await page.getByRole("button", { name: "Next: Review" }).click();
  await expect(stepHeading(page, "4. Review")).toBeVisible();
  await noHorizontalOverflow(page, "wizard review");
  await page.goto(`/app/broadcasts/${id}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await noHorizontalOverflow(page, "broadcast detail");
});
