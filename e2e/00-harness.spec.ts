import { expect, test } from "@playwright/test";
import { closeDb, signupUser, watchErrors } from "./helpers";

test.afterAll(closeDb);

test("harness: public landing renders and a user can sign up and reach the app", async ({ page, context }) => {
  const errors = watchErrors(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await signupUser(context);
  await page.goto("/app");
  await expect(page).toHaveURL(/\/app/);
  await expect(page.locator("main, #main-content, #content").first()).toBeVisible();
  expect(errors, errors.join("\n")).toEqual([]);
});
