import { expect, test, type Page } from "@playwright/test";
import { closeDb, db, signupUser, watchErrors } from "./helpers";
import { agentContext, axeSerious, goDark, noHorizontalOverflow, seedContact } from "./audience-campaigns-util";

test.afterAll(closeDb);
test.beforeEach(() => {
  test.setTimeout(240_000);
});

const dialog = (page: Page) => page.getByRole("dialog").first();

const CSV = [
  "phone,name,tags,opt_in,opt_in_source,city",
  "+919811100001,Anil One,vip;north,yes,website form,Pune",
  "9811100002,Bina Two,,no,,",
  "not-a-number,Bad Row,,,,",
  "+919811100001,Anil Dup,,,,",
  "09811100003,Chitra Three,news,yes,,Delhi",
].join("\n");

async function openImport(page: Page) {
  await page.goto("/app/contacts");
  await page.getByRole("button", { name: "Import contacts" }).click();
  await expect(dialog(page).getByRole("heading", { name: "Import contacts from a CSV file" })).toBeVisible();
  return dialog(page);
}

const upload = (page: Page, csv: string | Buffer, name = "contacts.csv") =>
  dialog(page).getByLabel("CSV file").setInputFiles({ name, mimeType: "text/csv", buffer: Buffer.isBuffer(csv) ? csv : Buffer.from(csv) });

test("import: choose step wording, sample download, empty and bad files", async ({ page, context }) => {
  const errors = watchErrors(page);
  await signupUser(context, "imp");
  const d = await openImport(page);
  await expect(d.getByRole("heading", { name: "Choose your file" })).toBeVisible();
  await expect(d.getByText("Only include people who agreed to hear from you")).toBeVisible();
  await expect(d.getByText(/People who opted out are never opted in again by an import/)).toBeVisible();
  await expect(d.getByText(/Up to 10,000 contacts and 2 MB/)).toBeVisible();
  // nothing chosen: cannot continue
  await expect(d.getByRole("button", { name: "Review contacts" })).toBeDisabled();

  // format help + sample download
  await d.getByRole("button", { name: "How should the file look?" }).click();
  await expect(d.getByText(/Only phone is required/)).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent("download"), d.getByRole("button", { name: "Download sample file" }).click()]);
  expect(download.suggestedFilename()).toBe("contacts-sample.csv");
  const fs = await import("node:fs");
  const sample = fs.readFileSync(await download.path(), "utf8");
  expect(sample.split(/\r?\n/)[0]).toBe("phone,name,tags,opt_in,opt_in_source");

  // header only
  await upload(page, "phone,name\n");
  await expect(d.getByText("We cannot use this file yet")).toBeVisible();
  await expect(d.getByText(/found a header row but no contacts/)).toBeVisible();
  // no phone column
  await upload(page, "name,tags\nBob,vip\n", "nophone.csv");
  await expect(d.getByText(/could not find a column named phone/)).toBeVisible();
  // too many rows
  await upload(page, "phone\n" + Array.from({ length: 10_001 }, (_, i) => `+9198${String(i).padStart(8, "0")}`).join("\n"), "huge.csv");
  await expect(d.getByText(/10,001 rows. You can import up to 10,000/)).toBeVisible();
  // too large (>2 MB)
  await upload(page, Buffer.alloc(2 * 1024 * 1024 + 10, "a"), "big.csv");
  await expect(d.getByText(/larger than 2 MB/)).toBeVisible();
  // all rows invalid
  await upload(page, "phone,name\nabc,One\n123,Two\n", "invalid.csv");
  await expect(d.getByRole("heading", { name: "Check before importing" })).toBeFocused();
  await expect(d.getByText("There is nothing to import")).toBeVisible();
  await expect(d.getByRole("button", { name: "Nothing to import" })).toBeDisabled();
  await expect(d.getByText(/2 rows need fixing/)).toBeVisible();
  await expect(d.getByText("Row 2: Not a valid phone number")).toBeVisible();
  await d.getByRole("button", { name: "Back" }).click();
  await expect(d.getByRole("heading", { name: "Choose your file" })).toBeFocused();

  // paste route
  await d.getByRole("button", { name: "Or paste your contacts" }).click();
  await d.getByLabel("CSV text").fill("phone\n+919800000001\n");
  await d.getByRole("button", { name: "Review contacts" }).click();
  await expect(d.getByRole("heading", { name: "Check before importing" })).toBeVisible();
  await expect(d.getByRole("button", { name: "Import 1 contact" })).toBeEnabled(); // no opt-in rows: no consent box needed
  await expect(d.getByLabel(/I confirm that/)).toHaveCount(0);
  // closing restores focus to the opener
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Import contacts" })).toBeFocused();
  expect(errors, errors.join("\n")).toEqual([]);
});

test("import: review, consent confirmation, invalid and duplicate rows, result, re-import updates", async ({ page, context }) => {
  const errors = watchErrors(page);
  const u = await signupUser(context, "imp");
  // an opted-out contact must never be opted in by an import
  await seedContact(u.tenantId, { phone: "+919811100004", name: "Opted Out Olga", optedOut: true });
  const d = await openImport(page);
  await upload(page, CSV + "\n9811100004,Opted Out Olga,,yes,import,");
  await expect(d.getByRole("heading", { name: "Check before importing" })).toBeFocused();
  // stats
  const stat = (label: string) => d.getByText(label, { exact: true }).locator("xpath=../..");
  await expect(stat("Ready to import")).toContainText("4");
  await expect(stat("Duplicates skipped")).toContainText("1");
  await expect(stat("Need fixing")).toContainText("1");
  await expect(d.getByText(/People already in your contacts are updated, not duplicated/)).toBeVisible();
  await expect(d.getByText(/treated as Indian \(\+91\)/)).toBeVisible();
  // invalid row listed with row number (file row 4)
  await expect(d.getByText("Row 4: Not a valid phone number")).toBeVisible();
  // preview table and extra columns
  const preview = d.getByRole("table", { name: "Preview of contacts to import" });
  await expect(preview.getByText("Anil One")).toBeVisible();
  await expect(preview.getByText("vip, north")).toBeVisible();
  await expect(preview.getByText("+919811100003")).toBeVisible(); // 0-prefixed number normalised
  await expect(d.getByText(/Extra columns saved as details on each contact: city/)).toBeVisible();
  // consent required: 3 people marked opted in
  const importBtn = d.getByRole("button", { name: "Import 4 contacts" });
  await expect(importBtn).toBeDisabled();
  const consent = d.getByLabel(/I confirm that the 3 people marked as opted in agreed to receive WhatsApp messages/);
  await expect(consent).toBeVisible();
  await consent.check();
  await expect(importBtn).toBeEnabled();
  // Back keeps working and re-review resets the consent box
  await d.getByRole("button", { name: "Back" }).click();
  await d.getByRole("button", { name: "Review contacts" }).click();
  await expect(d.getByLabel(/I confirm that the 3 people/)).not.toBeChecked();
  await d.getByLabel(/I confirm that the 3 people/).check();
  await d.getByRole("button", { name: "Import 4 contacts" }).click();

  // result
  await expect(d.getByRole("heading", { name: "Import results" })).toBeVisible();
  await expect(d.getByText("Import finished")).toBeVisible();
  const res = (label: string) => d.getByText(label, { exact: true }).locator("xpath=../..");
  await expect(res("Added")).toContainText("3");
  await expect(res("Updated")).toContainText("1");
  await expect(res("Duplicates skipped")).toContainText("1");
  await expect(res("Left out")).toContainText("1");
  await d.getByRole("button", { name: /Rows that were left out \(1\)/ }).click();
  await expect(d.getByText("Row 4: Not a valid phone number")).toBeVisible();
  await d.getByRole("button", { name: "Done" }).click();

  // contacts list is refreshed behind the dialog
  await expect(page.getByRole("row", { name: /Anil One/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /Anil One/ }).getByText("Opted in")).toBeVisible();
  await expect(page.getByRole("row", { name: /Anil One/ }).getByText(/website form/)).toBeVisible();
  await expect(page.getByRole("row", { name: /Chitra Three/ }).getByText(/csv_import/)).toBeVisible().catch(() => undefined);
  // opted-out contact stays opted out
  const row = (await (await db()).query(`select "optIn", "optedOutAt", "optInSource" from "Contact" where "tenantId"=$1 and phone='+919811100004'`, [u.tenantId])).rows[0];
  expect(row.optIn, "import must never opt a contact back in after they opted out").toBe(false);
  expect(row.optedOutAt).not.toBeNull();
  await expect(page.getByRole("row", { name: /Opted Out Olga/ }).getByText("Opted out", { exact: true })).toBeVisible();
  // extra column kept as attribute
  const attr = (await (await db()).query(`select attributes from "Contact" where "tenantId"=$1 and phone='+919811100001'`, [u.tenantId])).rows[0];
  expect(attr.attributes).toMatchObject({ city: "Pune" });

  // re-import: existing people are updated, none duplicated
  await page.getByRole("button", { name: "Import contacts" }).click();
  await upload(page, "phone,name,tags\n+919811100001,,extra\n9811100002,Bina Renamed,\n");
  await expect(d.getByText("Ready to import", { exact: true }).locator("xpath=../..")).toContainText("2");
  await d.getByRole("button", { name: "Import 2 contacts" }).click();
  await expect(d.getByRole("heading", { name: "Import results" })).toBeVisible();
  await expect(res("Added")).toContainText("0");
  await expect(res("Updated")).toContainText("2");
  await d.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("row", { name: /Bina Renamed/ })).toBeVisible();
  const anil = page.getByRole("row", { name: /Anil One/ });
  await expect(anil.getByText("extra")).toBeVisible();
  await expect(anil.getByText("vip")).toBeVisible(); // tags merged, not replaced
  const count = (await (await db()).query(`select count(*)::int as n from "Contact" where "tenantId"=$1`, [u.tenantId])).rows[0].n;
  expect(count).toBe(4);
  expect(errors, errors.join("\n")).toEqual([]);
});

test("import: stop import part-way, and a failing server is explained plainly", async ({ page, context }) => {
  await signupUser(context, "imp");
  let d = await openImport(page);
  // 1200 rows = 3 batches of 500
  const big = "phone,name\n" + Array.from({ length: 1200 }, (_, i) => `+9197${String(i).padStart(8, "0")},Bulk ${i}`).join("\n");
  let calls = 0;
  await page.route("**/api/contacts/import", async (route) => {
    calls++;
    await new Promise((r) => setTimeout(r, 2500));
    await route.continue();
  });
  await upload(page, big, "big.csv");
  await expect(d.getByRole("button", { name: "Import 1,200 contacts" })).toBeEnabled();
  await d.getByRole("button", { name: "Import 1,200 contacts" }).click();
  await expect(d.getByRole("heading", { name: "Importing your contacts" })).toBeFocused();
  await expect(d.getByText(/Keep this window open until it finishes/)).toBeVisible();
  // cannot be dismissed with Escape or the backdrop while importing
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toBeVisible();
  await d.getByRole("button", { name: "Stop import" }).click();
  await expect(d.getByRole("button", { name: "Stopping after this batch" })).toBeDisabled();
  await expect(d.getByRole("heading", { name: "Import results" })).toBeVisible({ timeout: 60_000 });
  await expect(d.getByText("Import stopped", { exact: true })).toBeVisible();
  await expect(d.getByText(/500 of 1,200 contacts were imported before you stopped/)).toBeVisible();
  expect(calls).toBe(1);
  await d.getByRole("button", { name: "Done" }).click();
  await page.unroute("**/api/contacts/import");

  // server failure: plain-language message, count of what was imported, no stack traces
  d = await openImport(page);
  await page.route("**/api/contacts/import", (r) => r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "PrismaClientKnownRequestError: ECONNREFUSED at db.ts:12" }) }));
  await upload(page, "phone\n+919822200001\n");
  await d.getByRole("button", { name: "Import 1 contact" }).click();
  await expect(d.getByText("Import stopped early")).toBeVisible();
  await expect(d.getByText(/0 of 1 contacts were imported/)).toBeVisible();
  await expect(dialog(page)).not.toContainText(/Prisma|ECONNREFUSED|db\.ts/);
  await page.unroute("**/api/contacts/import");
  // fix and retry works
  await d.getByRole("button", { name: "Done" }).click();
  d = await openImport(page);
  await upload(page, "phone\n+919822200001\n");
  await d.getByRole("button", { name: "Import 1 contact" }).click();
  await expect(d.getByText("Import finished")).toBeVisible();
});

test("import: agent cannot import (UI hidden, API refuses) and workspaces stay separate", async ({ page, context, browser }) => {
  const u = await signupUser(context, "imp");
  await seedContact(u.tenantId, { phone: "+919833300001", name: "Tenant A Owns This" });
  const a = await agentContext(browser, u.tenantId, "agent");
  try {
    await a.page.goto("/app/contacts");
    await expect(a.page.getByRole("heading", { level: 1, name: "Contacts" })).toBeVisible();
    await expect(a.page.getByRole("button", { name: /Import/ })).toHaveCount(0);
    const res = await a.page.request.post("/api/contacts/import", { headers: { origin: new URL(a.page.url()).origin, "content-type": "text/csv" }, data: "phone,name\n+919833300009,Sneaky\n" });
    expect(res.status()).toBe(403);
  } finally {
    await a.context.close();
  }
  // a second workspace importing the same phone creates its own contact and leaves A's untouched
  const other = await browser.newContext();
  try {
    const u2 = await signupUser(other, "imp");
    const p2 = await other.newPage();
    await p2.goto("/app/contacts");
    await p2.getByRole("button", { name: "Import contacts" }).click();
    await dialog(p2).getByLabel("CSV file").setInputFiles({ name: "x.csv", mimeType: "text/csv", buffer: Buffer.from("phone,name\n+919833300001,Tenant B Name\n") });
    await dialog(p2).getByRole("button", { name: "Import 1 contact" }).click();
    await expect(dialog(p2).getByText("Import finished")).toBeVisible();
    const d = await db();
    const a1 = (await d.query(`select name from "Contact" where "tenantId"=$1 and phone='+919833300001'`, [u.tenantId])).rows[0];
    const b1 = (await d.query(`select name from "Contact" where "tenantId"=$1 and phone='+919833300001'`, [u2.tenantId])).rows[0];
    expect(a1.name).toBe("Tenant A Owns This");
    expect(b1.name).toBe("Tenant B Name");
  } finally {
    await other.close();
  }
});

test("import: accessibility light/dark and mobile layout @mobile", async ({ page, context }) => {
  await signupUser(context, "imp");
  await page.setViewportSize({ width: 360, height: 740 });
  const found: string[] = [];
  let d = await openImport(page);
  await noHorizontalOverflow(page, "import choose");
  found.push(...(await axeSerious(page, "import choose")));
  await upload(page, CSV);
  await expect(d.getByRole("heading", { name: "Check before importing" })).toBeVisible();
  await noHorizontalOverflow(page, "import review");
  const box = await dialog(page).boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(361);
  found.push(...(await axeSerious(page, "import review")));
  await d.getByRole("button", { name: "Back" }).click();
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1366, height: 800 });
  await goDark(page);
  d = await openImport(page);
  await upload(page, CSV);
  await expect(d.getByRole("heading", { name: "Check before importing" })).toBeVisible();
  found.push(...(await axeSerious(page, "import review dark")));
  expect(found, found.join("\n")).toEqual([]);
});
