import { expect, test, type Page } from "@playwright/test";
import { watchErrors } from "./helpers";
import { axeSerious, noHorizontalOverflow } from "./auth-onboarding-util";

// The in-page sections of the landing page (SECTION in src/components/site/content.ts).
const SECTIONS = ["how-it-works", "features", "eddy", "spending", "coming-soon", "developers", "security", "faq"];
const HEADLINE = "Run customer chats on WhatsApp as a team, and automate the rest";

/** Opens the landing page in the given colour scheme. The root layout's theme script follows the OS setting when nothing is stored. */
async function openHome(page: Page, scheme: "light" | "dark") {
  await page.emulateMedia({ colorScheme: scheme });
  await page.goto("/");
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(scheme);
}

test.describe("landing page", () => {
  test("one h1, every Start free trial goes to /signup, See how it works scrolls to the steps", async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto("/");
    const h1 = page.getByRole("heading", { level: 1 });
    await expect(h1).toHaveCount(1);
    await expect(h1).toHaveText(HEADLINE);
    await expect(page.getByRole("banner")).toBeVisible();
    await expect(page.getByRole("main")).toBeVisible();
    await expect(page.getByRole("contentinfo")).toBeVisible();

    const trial = page.getByRole("link", { name: "Start free trial" });
    expect(await trial.count()).toBeGreaterThanOrEqual(3); // header, hero, closing call to action
    expect(new Set(await trial.evaluateAll((as) => as.map((a) => new URL((a as HTMLAnchorElement).href).pathname)))).toEqual(new Set(["/signup"]));

    await page.getByRole("main").getByRole("link", { name: "See how it works" }).click();
    await expect(page).toHaveURL(/#how-it-works$/);
    await expect(page.locator("#how-it-works")).toBeInViewport();

    await page.getByRole("main").getByRole("link", { name: "Start free trial" }).first().click();
    await expect(page).toHaveURL(/\/signup$/);
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("every in-page anchor resolves, and the footer's Questions link lands on the FAQ", async ({ page }) => {
    await page.goto("/");
    for (const id of SECTIONS) await expect(page.locator(`[id="${id}"]`), id).toHaveCount(1);
    const broken = await page.evaluate(() => {
      const out: string[] = [];
      for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"))) {
        const url = new URL(a.href, location.href);
        if (url.origin !== location.origin || url.pathname !== location.pathname || !url.hash) continue;
        if (!document.getElementById(decodeURIComponent(url.hash.slice(1)))) out.push(a.getAttribute("href") ?? "");
      }
      return out;
    });
    expect(broken, broken.join(", ")).toEqual([]);

    await page.getByRole("contentinfo").getByRole("link", { name: "Questions" }).click();
    await expect(page).toHaveURL(/#faq$/);
    await expect(page.locator("#faq")).toBeInViewport();
  });

  test("New and Coming soon are labelled where they belong, and coming-soon items cannot be started", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#eddy").getByText("New", { exact: true })).toBeVisible();
    await expect(page.locator("#spending").getByText("New", { exact: true })).toBeVisible();
    await expect(page.locator("#eddy").getByText(/Illustrations only/)).toBeVisible();

    const soon = page.locator("#coming-soon");
    await expect(soon.getByText("Coming soon", { exact: true })).toHaveCount(5); // the section and its four cards
    await expect(soon.getByText(/not available yet/)).toBeVisible();
    await expect(soon.getByRole("link")).toHaveCount(0);
    await expect(page.locator("main").getByText("Coming soon", { exact: true })).toHaveCount(5);
  });

  test("anchor jumps land just below the sticky header, not a second header height lower", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" }); // no smooth scroll to wait for
    await page.goto("/");
    const header = await page.getByRole("banner").boundingBox();
    for (const [link, id] of [
      [page.getByRole("main").getByRole("link", { name: "See how it works" }), "how-it-works"],
      [page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Features" }), "features"],
    ] as const) {
      await link.click();
      await expect(page).toHaveURL(new RegExp(`#${id}$`));
      // html { scroll-padding-top: 5rem } alone: the section starts about 80px down, just under the 64px header.
      await expect.poll(() => page.locator(`#${id}`).evaluate((el) => Math.round(el.getBoundingClientRect().top)), id).toBeLessThanOrEqual(96);
      const top = await page.locator(`#${id}`).evaluate((el) => el.getBoundingClientRect().top);
      expect(top, id).toBeGreaterThanOrEqual(header!.height);
      await page.evaluate(() => window.scrollTo(0, 0));
    }
  });

  test("the skip link shows above the sticky header while it has focus", async ({ page }) => {
    await page.goto("/");
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "Skip to content" });
    await expect(skip).toBeFocused();
    const box = await skip.boundingBox();
    expect(box && box.width).toBeGreaterThan(20);
    const onTop = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("a")?.textContent?.trim() ?? "", { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 });
    expect(onTop).toBe("Skip to content");
  });

  test("the header marks the page being read, and the docs menu marks the docs page", async ({ page }) => {
    await page.goto("/pricing");
    const main = page.getByRole("navigation", { name: "Main" });
    await expect(main.getByRole("link", { name: "Pricing" })).toHaveAttribute("aria-current", "page");
    await expect(main.getByRole("link", { name: "Docs" })).not.toHaveAttribute("aria-current", /.+/);
    await page.goto("/docs/endpoints");
    await expect(main.getByRole("link", { name: "Docs" })).toHaveAttribute("aria-current", "true");
    const docs = page.getByRole("navigation", { name: "API documentation" });
    await expect(docs.getByRole("link", { name: "Endpoints" })).toHaveAttribute("aria-current", "page");
    await expect(docs.locator("[aria-current]")).toHaveCount(1);
  });

  test("the header stays on one line at 320px @mobile", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto("/");
    await noHorizontalOverflow(page, "/ (320px)");
    const banner = page.getByRole("banner");
    const logo = await banner.getByRole("link", { name: "Edwyz WA home" }).boundingBox();
    const cta = banner.getByRole("link", { name: "Free trial" });
    await expect(cta).toBeVisible();
    const ctaBox = await cta.boundingBox();
    // One line of text each: the logo is no taller than its 28px mark, the button no taller than one line plus its padding.
    expect(logo!.height).toBeLessThanOrEqual(30);
    expect(ctaBox!.height).toBeLessThanOrEqual(40);
    expect(ctaBox!.x + ctaBox!.width).toBeLessThanOrEqual(320);
  });

  test("FAQ answers open from the keyboard", async ({ page }) => {
    await page.goto("/");
    const first = page.locator("#faq summary").first();
    await first.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#faq details").first()).toHaveAttribute("open", "");
  });

  test("no horizontal overflow at 360px in light and dark @mobile", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    for (const scheme of ["light", "dark"] as const) {
      await openHome(page, scheme);
      await noHorizontalOverflow(page, `/ (${scheme}, 360px)`);
    }
    // The API example scrolls inside its own box instead of widening the page.
    const example = page.getByRole("region", { name: "Example API request" });
    await example.scrollIntoViewIfNeeded();
    const box = await example.boundingBox();
    expect(box, "API example box").not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(360);
  });

  test("axe: no serious or critical issues in light and dark", async ({ page }) => {
    test.setTimeout(180_000);
    const found: string[] = [];
    for (const scheme of ["light", "dark"] as const) {
      await openHome(page, scheme);
      // Open every answer so its text is checked as well.
      await page.locator("#faq details").evaluateAll((els) => els.forEach((el) => ((el as HTMLDetailsElement).open = true)));
      found.push(...(await axeSerious(page, `/ ${scheme}`)));
    }
    expect(found, found.join("\n")).toEqual([]);
  });
});
