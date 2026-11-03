import { expect, test, type Page } from "@playwright/test";
import { ORIGIN, closeDb, db, signupUser, stamp, watchErrors, type TestUser } from "./helpers";
import { goDark, seedContact } from "./audience-campaigns-util";

/*
 * Customers area fixes from the 2026-10-30 QA pass: "is not tagged" and contacts with no tags, a link to a missing segment,
 * segment-aware empty states, focus on the invalid field, the rule layout in the segment dialog, More as the current place on
 * phones, and the selected pill tab in dark mode.
 */
test.afterAll(closeDb);
test.beforeEach(() => {
  test.setTimeout(240_000);
});

/** A contact whose tags column is NULL, the way contacts created by an inbound message are stored. */
async function seedUntagged(u: TestUser, name: string) {
  const d = await db();
  await d.query(`insert into "Contact" (id, "tenantId", phone, name, attributes) values ($1,$2,$3,$4,'{}')`, [`ct_${stamp()}`, u.tenantId, `+9197${String(stamp()).slice(-8)}`, name]);
}

const preview = async (page: Page, filter: object) => {
  const res = await page.request.post("/api/segments/preview", { headers: { origin: ORIGIN }, data: { filter } });
  expect(res.status()).toBe(200);
  return ((await res.json()) as { count: number }).count;
};

test("segments: 'is not tagged' counts contacts with no tags at all, in the dialog and the API", async ({ page, context }) => {
  const errors = watchErrors(page);
  const u = await signupUser(context, "seg");
  await seedContact(u.tenantId, { phone: "+919000000101", name: "Tagged Vip", tags: ["vip"] });
  await seedContact(u.tenantId, { phone: "+919000000102", name: "Empty Tags", tags: [] });
  await seedUntagged(u, "Null Tags");

  const notVip = { field: "tag", op: "not_has", value: "vip" };
  expect(await preview(page, { all: [notVip] })).toBe(2);
  expect(await preview(page, { any: [notVip, { field: "name", op: "is", value: "nobody" }] })).toBe(2);
  expect(await preview(page, { all: [{ field: "tag", op: "has", value: "vip" }] })).toBe(1);
  expect(await preview(page, { all: [{ field: "name", op: "not_contains", value: "zzz" }] })).toBe(3);

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/app/contacts/segments");
  await page.getByRole("button", { name: "New segment" }).first().click();
  const d = page.getByRole("dialog", { name: "New segment" });
  await d.getByLabel("Rule 1: about").selectOption({ label: "Tag" });
  await d.getByLabel("Test").selectOption({ label: "is not tagged" });
  await d.getByLabel("Value").fill("vip");
  await expect(d.getByText("2 people match these rules.", { exact: false })).toBeVisible();
  // the selects are wide enough to read their choice at desktop width (they were cut to "is tagg")
  for (const label of ["Rule 1: about", "Test"]) expect((await d.getByLabel(label).boundingBox())!.width, label).toBeGreaterThanOrEqual(160);
  expect(errors, errors.join("\n")).toEqual([]);
});

test("contacts: a link to a missing segment shows everyone with a notice, and segment empty states fit", async ({ page, context }) => {
  const errors = watchErrors(page);
  const u = await signupUser(context, "seg");
  await seedContact(u.tenantId, { phone: "+919000000111", name: "Seg Person" });
  await page.goto("/app/contacts?segment=bogus-segment-id");
  await expect(page.getByText("That segment no longer exists")).toBeVisible();
  await expect(page.getByRole("row", { name: /Seg Person/ })).toBeVisible();
  await expect(page.getByText("We could not load your contacts")).toHaveCount(0);
  await expect(page).toHaveURL(/\/app\/contacts$/);
  await expect(page.getByLabel("Segment")).toHaveValue("");

  // a ready-made segment nobody is in yet: no "check the spelling" when nothing was typed
  await page.getByLabel("Segment").selectOption({ label: "Recently active" });
  await expect(page.getByText('No contacts in "Recently active"')).toBeVisible();
  await expect(page.getByText("No one is in this segment right now.")).toBeVisible();
  await expect(page.getByText(/Check the spelling/)).toHaveCount(0);
  await expect(page.getByText("That segment no longer exists")).toHaveCount(0);
  await page.getByRole("button", { name: "Show all contacts" }).click();
  await expect(page.getByRole("row", { name: /Seg Person/ })).toBeVisible();
  const unexpected = errors.filter((e) => !/404/.test(e)); // the 404 for the missing segment is expected
  expect(unexpected, unexpected.join("\n")).toEqual([]);
});

test("contacts: a blocked Add contact moves focus to the field to fix, and the lead stage says what it is", async ({ page, context }) => {
  const errors = watchErrors(page);
  await signupUser(context, "seg");
  await page.goto("/app/contacts");
  await page.getByRole("button", { name: "Add contact" }).first().click();
  const d = page.getByRole("dialog").first();
  await d.getByLabel(/Phone number/).fill("12");
  await d.getByRole("button", { name: "Add contact" }).click();
  await expect(d.getByText(/Enter a valid phone number with country code/)).toBeVisible();
  await expect(d.getByLabel(/Phone number/)).toBeFocused();
  await expect(d.getByText(/separate from the stages on the Leads page/)).toBeVisible();
  expect(errors, errors.join("\n")).toEqual([]);
});

test("leads: the selected pill tab stands out in dark mode, and stages are explained", async ({ page, context }) => {
  const errors = watchErrors(page);
  await signupUser(context, "seg");
  await page.goto("/app/leads");
  await goDark(page);
  await expect(page.getByText(/Moving a lead does not change the lead stage on its contact/)).toBeVisible();
  const ratio = await page.getByRole("tab", { name: "Pipeline" }).evaluate((tab) => {
    const rgb = (c: string) => (c.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number);
    const lum = ([r, g, b]: number[]) => [r, g, b].map((v) => (v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
    const edge = lum(rgb(getComputedStyle(tab).borderTopColor));
    const track = lum(rgb(getComputedStyle(tab.parentElement!).backgroundColor));
    return (Math.max(edge, track) + 0.05) / (Math.min(edge, track) + 0.05);
  });
  expect(ratio).toBeGreaterThanOrEqual(3);
  expect(errors, errors.join("\n")).toEqual([]);
});

test("mobile: More shows as the current place on Leads pages @mobile", async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors = watchErrors(page);
  await signupUser(context, "seg");
  const tabs = page.getByRole("navigation", { name: "Main" });
  for (const path of ["/app/leads", "/app/leads/sequences"]) {
    await page.goto(path);
    await expect(tabs.getByRole("button", { name: "More", exact: true }), path).toHaveAccessibleDescription("The current page is in this menu");
    await expect(tabs.locator('[aria-current="page"]'), path).toHaveCount(0);
  }
  await page.goto("/app/contacts/segments");
  await expect(tabs.getByRole("link", { name: "Contacts" })).toHaveAttribute("aria-current", "page");
  await expect(tabs.getByRole("button", { name: "More", exact: true })).not.toHaveAttribute("aria-describedby");
  expect(errors, errors.join("\n")).toEqual([]);
});
