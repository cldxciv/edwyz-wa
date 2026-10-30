import { expect, test, type Page } from "@playwright/test";
import { closeDb, db, signupUser, watchErrors } from "./helpers";
import { agentContext, axeSerious, goDark, noHorizontalOverflow, openFromNav, seedContact } from "./audience-campaigns-util";

test.afterAll(closeDb);
test.beforeEach(() => { test.setTimeout(240_000); });

const dialog = (page: Page) => page.getByRole("dialog").first();

async function addContact(page: Page, phone: string, name = "", tags = "") {
  await page.getByRole("button", { name: "Add contact" }).first().click();
  const d = dialog(page);
  await d.getByLabel(/Phone number/).fill(phone);
  if (name) await d.getByLabel("Name").fill(name);
  if (tags) await d.getByLabel("Tags").fill(tags);
  return d;
}

test("contacts: empty state, add, validation, duplicates, edit, search, tags, delete", async ({ page, context }) => {
  const errors = watchErrors(page);
  await signupUser(context, "ct");
  await openFromNav(page, "Contacts", /\/app\/contacts/);
  await expect(page.getByRole("heading", { level: 1, name: "Contacts" })).toBeVisible();
  await expect(page.getByText("No contacts yet")).toBeVisible();
  await expect(page.getByText(/agreed to receive them/).first()).toBeVisible();

  // validation: empty phone
  let d = await addContact(page, "");
  await d.getByRole("button", { name: "Add contact" }).click();
  await expect(d.getByText(/Enter a valid phone number with country code/)).toBeVisible();
  // invalid phone
  await d.getByLabel(/Phone number/).fill("abc123");
  await d.getByRole("button", { name: "Add contact" }).click();
  await expect(d.getByText(/Enter a valid phone number/)).toBeVisible();
  // valid
  await d.getByLabel(/Phone number/).fill("+91 98765 43210");
  await d.getByLabel("Name").fill("Asha Verma");
  await d.getByLabel("Tags").fill("vip, north, vip");
  await d.getByRole("button", { name: "Add contact" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const row = page.getByRole("row", { name: /Asha Verma/ });
  await expect(row).toBeVisible();
  await expect(row.getByText("vip", { exact: true })).toHaveCount(1); // de-duplicated tags
  await expect(row.getByText("north")).toBeVisible();
  await expect(row.getByText("Not opted in")).toBeVisible();
  // no raw enum values
  await expect(page.locator("main")).not.toContainText(/inactive|opted_out|undefined|\[object/);

  // duplicate
  d = await addContact(page, "+919876543210", "Dup");
  await d.getByRole("button", { name: "Add contact" }).click();
  await expect(d.getByText(/already exists/i)).toBeVisible();
  await d.getByRole("button", { name: "Cancel" }).click();

  // a second contact for search
  d = await addContact(page, "9123456789", "Ravi Kumar", "newsletter");
  await d.getByRole("button", { name: "Add contact" }).click();
  await expect(page.getByRole("row", { name: /Ravi Kumar/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /\+919123456789/ })).toBeVisible(); // default country code applied

  // search by name
  await page.getByRole("searchbox", { name: "Search" }).fill("ravi");
  await expect(page.getByRole("row", { name: /Asha Verma/ })).toHaveCount(0);
  await expect(page.getByRole("row", { name: /Ravi Kumar/ })).toBeVisible();
  // search no match
  await page.getByRole("searchbox", { name: "Search" }).fill("zzzz");
  await expect(page.getByText('No contacts match "zzzz"')).toBeVisible();
  await page.getByRole("button", { name: "Clear search" }).first().click();
  await expect(page.getByRole("row", { name: /Asha Verma/ })).toBeVisible();
  // search by phone digits
  await page.getByRole("searchbox", { name: "Search" }).fill("98765");
  await expect(page.getByRole("row", { name: /Asha Verma/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /Ravi Kumar/ })).toHaveCount(0);
  await page.getByRole("searchbox", { name: "Search" }).fill("");
  // tag filter
  await page.getByLabel("Tag", { exact: true }).fill("newsletter");
  await expect(page.getByRole("row", { name: /Asha Verma/ })).toHaveCount(0);
  await expect(page.getByRole("row", { name: /Ravi Kumar/ })).toBeVisible();
  await page.getByLabel("Tag", { exact: true }).fill("nonexistent");
  await expect(page.getByText('No contacts tagged "nonexistent"')).toBeVisible();
  await page.getByRole("button", { name: "Clear search" }).first().click();

  // edit: phone locked
  await page.getByRole("button", { name: "Edit Asha Verma" }).click();
  d = dialog(page);
  await expect(d.getByRole("heading", { name: "Edit contact" })).toBeVisible();
  await expect(d.getByLabel(/Phone number/)).toBeDisabled();
  await d.getByLabel("Name").fill("Asha V. Sharma");
  await d.getByLabel("Tags").fill("vip, west");
  await d.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("row", { name: /Asha V\. Sharma/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /Asha V\. Sharma/ }).getByText("west")).toBeVisible();

  // delete: cancel first
  await page.getByRole("button", { name: "Delete Ravi Kumar" }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm.getByText("Delete Ravi Kumar?")).toBeVisible();
  await expect(confirm.getByText(/cannot be undone/)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(confirm).toHaveCount(0);
  await expect(page.getByRole("row", { name: /Ravi Kumar/ })).toBeVisible();
  // focus returns to the delete button
  await expect(page.getByRole("button", { name: "Delete Ravi Kumar" })).toBeFocused();
  // delete confirm
  await page.getByRole("button", { name: "Delete Ravi Kumar" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete contact" }).click();
  await expect(page.getByRole("row", { name: /Ravi Kumar/ })).toHaveCount(0);
  await expect(page.getByText("Contact deleted")).toBeVisible();
  const unexpected = errors.filter((e) => !/409/.test(e)); // the 409 is the deliberate duplicate attempt above
  expect(unexpected, unexpected.join("\n")).toEqual([]);
});

test("contacts: ?add=1 deep link opens add dialog, then cleans the URL", async ({ page, context }) => {
  const errors = watchErrors(page);
  await signupUser(context, "ct");
  await page.goto("/app/contacts?add=1");
  await expect(page.getByRole("dialog").getByRole("heading", { name: "Add contact" })).toBeVisible();
  await expect(page).toHaveURL(/\/app\/contacts$/);
  // phone field is focused for fast entry
  await expect(page.getByRole("dialog").getByLabel(/Phone number/)).toBeFocused();
  // Escape closes and focus is not lost into <body>
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const active = await page.evaluate(() => document.activeElement?.tagName);
  expect(active, "focus should return somewhere sensible after the dialog closes").not.toBe("BODY");
  expect(errors, errors.join("\n")).toEqual([]);
});

test("contacts: consent wording and rules for owners", async ({ page, context }) => {
  const errors = watchErrors(page);
  const u = await signupUser(context, "ct");
  await seedContact(u.tenantId, { phone: "+919000000001", name: "Out Person", optedOut: true });
  await seedContact(u.tenantId, { phone: "+919000000002", name: "In Person", optIn: true, source: "shop sign-up" });
  await page.goto("/app/contacts");
  const outRow = page.getByRole("row", { name: /Out Person/ });
  await expect(outRow.getByText("Opted out")).toBeVisible();
  const inRow = page.getByRole("row", { name: /In Person/ });
  await expect(inRow.getByText("Opted in")).toBeVisible();
  await expect(inRow.getByText(/shop sign-up/)).toBeVisible();

  // new contact with consent: source required
  let d = await addContact(page, "+919000000003", "Consent Carl");
  await expect(d.getByRole("group", { name: "Permission to message" })).toBeVisible();
  await d.getByLabel(/This person agreed to receive WhatsApp messages/).check();
  await expect(d.getByLabel(/Where did they agree/)).toBeVisible();
  await d.getByRole("button", { name: "Add contact" }).click();
  await expect(d.getByText(/Say where this person gave consent/)).toBeVisible();
  await d.getByLabel(/Where did they agree/).fill("website form");
  await d.getByRole("button", { name: "Add contact" }).click();
  const carl = page.getByRole("row", { name: /Consent Carl/ });
  await expect(carl.getByText("Opted in")).toBeVisible();
  await expect(carl.getByText(/website form/)).toBeVisible();

  // withdrawing consent warns
  await page.getByRole("button", { name: "Edit Consent Carl" }).click();
  d = dialog(page);
  await d.getByLabel(/This person agreed/).uncheck();
  await expect(d.getByText(/mark this person as opted out/i)).toBeVisible();
  await d.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("row", { name: /Consent Carl/ }).getByText("Opted out")).toBeVisible();

  // opted out contact: cannot be re-opted from here
  await page.getByRole("button", { name: "Edit Out Person" }).click();
  d = dialog(page);
  await expect(d.getByText("This person opted out")).toBeVisible();
  await expect(d.getByLabel(/This person agreed/)).toHaveCount(0);
  await d.getByRole("button", { name: "Cancel" }).click();
  expect(errors, errors.join("\n")).toEqual([]);
});

test("contacts: agent can add and edit but cannot import, delete or record consent", async ({ page, context, browser }) => {
  const u = await signupUser(context, "ct");
  await seedContact(u.tenantId, { phone: "+919000000010", name: "Owner Contact" });
  const a = await agentContext(browser, u.tenantId, "agent");
  try {
    const ap = a.page;
    const errors = watchErrors(ap);
    await ap.goto("/app/contacts");
    await expect(ap.getByRole("heading", { level: 1, name: "Contacts" })).toBeVisible();
    await expect(ap.getByRole("row", { name: /Owner Contact/ })).toBeVisible();
    await expect(ap.getByRole("button", { name: "Import contacts" })).toHaveCount(0);
    await expect(ap.getByRole("button", { name: /^Delete / })).toHaveCount(0);
    await ap.getByRole("button", { name: "Add contact" }).first().click();
    const d = dialog(ap);
    await expect(d.getByText(/Only owners and admins can record that someone agreed/)).toBeVisible();
    await expect(d.getByLabel(/This person agreed/)).toHaveCount(0);
    await d.getByLabel(/Phone number/).fill("+919000000011");
    await d.getByLabel("Name").fill("Agent Added");
    await d.getByRole("button", { name: "Add contact" }).click();
    await expect(ap.getByRole("row", { name: /Agent Added/ })).toBeVisible();
    // the API refuses a direct consent write by an agent with a clear message
    const res = await ap.request.post("/api/contacts", { headers: { origin: new URL(ap.url()).origin }, data: { phone: "+919000000012", optIn: true, optInSource: "x" } });
    expect(res.status()).toBe(403);
    expect(errors, errors.join("\n")).toEqual([]);
  } finally {
    await a.context.close();
  }
});

test("contacts: tenant isolation (second workspace cannot see or touch the first one's contacts)", async ({ page, context, browser }) => {
  const u = await signupUser(context, "ct");
  const id = await seedContact(u.tenantId, { phone: "+919000000020", name: "Private Pat", tags: ["secret"] });
  const other = await browser.newContext();
  try {
    await signupUser(other, "ct");
    const p2 = await other.newPage();
    await p2.goto("/app/contacts");
    await expect(p2.getByText("No contacts yet")).toBeVisible();
    await expect(p2.getByText("Private Pat")).toHaveCount(0);
    const origin = new URL(p2.url()).origin;
    expect((await p2.request.get(`/api/contacts?q=Private`)).status()).toBe(200);
    expect(JSON.stringify(await (await p2.request.get(`/api/contacts?q=Private`)).json())).not.toContain("Private Pat");
    expect((await p2.request.patch(`/api/contacts/${id}`, { headers: { origin }, data: { name: "Hacked" } })).status()).toBe(404);
    expect((await p2.request.delete(`/api/contacts/${id}`, { headers: { origin } })).status()).toBe(404);
    const d = await db();
    const still = await d.query(`select name from "Contact" where id = $1`, [id]);
    expect(still.rows[0]?.name).toBe("Private Pat");
    // export is scoped
    const csv = await p2.request.get("/api/export/contacts.csv");
    expect(await csv.text()).not.toContain("Private Pat");
  } finally {
    await other.close();
  }
});

test("contacts: keyboard, load error state and pagination", async ({ page, context }) => {
  const u = await signupUser(context, "ct");
  const d = await db();
  // 60 contacts so "Show more" appears (page size 50)
  for (let i = 0; i < 60; i++) await seedContact(u.tenantId, { phone: `+9190001${String(i).padStart(5, "0")}`, name: `Bulk ${String(i).padStart(2, "0")}` });
  await page.goto("/app/contacts");
  await expect(page.getByText(/Showing 50 contacts. More are available./)).toBeVisible();
  await page.getByRole("button", { name: "Show more contacts" }).click();
  await expect(page.getByText(/Showing 60 contacts\./)).toBeVisible();
  void d;

  // keyboard: open add dialog with Enter on the button, Tab stays trapped, Escape closes and restores focus
  const add = page.getByRole("button", { name: "Add contact" }).first();
  await add.focus();
  await page.keyboard.press("Enter");
  const dlg = dialog(page);
  await expect(dlg).toBeVisible();
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    const inside = await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'));
    expect(inside, "focus escaped the dialog").toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(dlg).toHaveCount(0);
  await expect(add).toBeFocused();

  // load failure shows a friendly error with retry
  await page.route("**/api/contacts?*", (r) => r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Unexpected token < in JSON at position 0 prisma ECONNREFUSED" }) }));
  await page.getByRole("searchbox", { name: "Search" }).fill("x");
  await expect(page.getByText("We could not load your contacts").first()).toBeVisible();
  await expect(page.locator("main")).not.toContainText(/prisma|ECONNREFUSED|Unexpected token/);
  await page.unroute("**/api/contacts?*");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText("We could not load your contacts")).toHaveCount(0);
});

test("contacts: accessibility (axe) light and dark, with and without dialog", async ({ page, context }) => {
  const u = await signupUser(context, "ct");
  await seedContact(u.tenantId, { phone: "+919000000030", name: "Axe Person", tags: ["a", "b"], optIn: true });
  await seedContact(u.tenantId, { phone: "+919000000031", name: "Axe Out", optedOut: true });
  await page.goto("/app/contacts");
  await expect(page.getByRole("row", { name: /Axe Person/ })).toBeVisible();
  const found: string[] = [];
  expect(await page.locator("main, [role=main], #main-content").count()).toBeGreaterThan(0);
  found.push(...(await axeSerious(page, "contacts light")));
  await page.getByRole("button", { name: "Add contact" }).first().click();
  found.push(...(await axeSerious(page, "contacts add dialog light")));
  await page.keyboard.press("Escape");
  await goDark(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  found.push(...(await axeSerious(page, "contacts dark")));
  await page.getByRole("button", { name: "Add contact" }).first().click();
  await dialog(page).getByLabel(/This person agreed/).check();
  found.push(...(await axeSerious(page, "contacts add dialog dark")));
  expect(found, found.join("\n")).toEqual([]);
});

test("contacts: no overflow at 360px and row actions reachable @mobile", async ({ page, context }) => {
  const u = await signupUser(context, "ct");
  await seedContact(u.tenantId, { phone: "+919000000040", name: "A very long contact name that should wrap nicely on a narrow phone screen", tags: ["long-tag-number-one", "long-tag-number-two"], optIn: true, source: "a long consent source description" });
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto("/app/contacts");
  await expect(page.getByRole("heading", { level: 1, name: "Contacts" })).toBeVisible();
  await noHorizontalOverflow(page, "contacts list");
  await page.getByRole("button", { name: "Add contact" }).first().click();
  await noHorizontalOverflow(page, "contacts dialog");
  const box = await dialog(page).boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(361);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /^Edit / }).first().click();
  await expect(dialog(page).getByRole("button", { name: "Save changes" })).toBeVisible();
});
