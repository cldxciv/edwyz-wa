import { expect, test, type Page } from "@playwright/test";
import { watchErrors } from "./helpers";

/**
 * docs/PLAY-STORE.md, "What the web app needs first": what Chrome and the Android app (a Trusted Web Activity over this site) read
 * before treating it as an installable app. Public addresses only; no sign-in and no database.
 */

/** Width and height from a PNG's IHDR chunk. */
function pngSize(body: Buffer) {
  expect(body.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  return `${body.readUInt32BE(16)}x${body.readUInt32BE(20)}`;
}

type ManifestIcon = { src: string; sizes: string; type: string; purpose: string };

test("the manifest is linked from every page and served with the install fields", async ({ page, request }) => {
  await page.goto("/offline");
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/manifest.webmanifest");

  const res = await request.get("/manifest.webmanifest");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("application/manifest+json");
  const manifest = await res.json();
  expect(manifest).toMatchObject({
    id: "/app",
    name: "Edwyz WA",
    short_name: "Edwyz WA",
    start_url: "/app?source=twa",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    theme_color: "#047857",
    background_color: "#ffffff",
    categories: ["business", "productivity"],
  });
  const icons = manifest.icons as ManifestIcon[];
  for (const purpose of ["any", "maskable"]) {
    expect(icons.filter((i) => i.purpose === purpose).map((i) => i.sizes).sort()).toEqual(["192x192", "512x512"]);
  }
});

test("every manifest icon and the apple-touch-icon load as PNGs of their declared size", async ({ page, request }) => {
  const manifest = await (await request.get("/manifest.webmanifest")).json();
  const icons = (manifest.icons as ManifestIcon[]).map((i) => ({ src: i.src, sizes: i.sizes }));

  await page.goto("/offline");
  const apple = page.locator('link[rel="apple-touch-icon"]');
  await expect(apple).toHaveAttribute("href", "/icons/apple-touch-icon.png");
  await expect(apple).toHaveAttribute("sizes", "180x180");
  icons.push({ src: "/icons/apple-touch-icon.png", sizes: "180x180" });

  for (const icon of icons) {
    const res = await request.get(icon.src);
    expect(res.status(), icon.src).toBe(200);
    expect(res.headers()["content-type"], icon.src).toBe("image/png");
    expect(pngSize(await res.body()), icon.src).toBe(icon.sizes);
  }
});

async function expectOfflinePage(page: Page) {
  const res = await page.goto("/offline");
  expect(res?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1, name: "You are offline." })).toBeVisible();
  await expect(page.getByText("Edwyz WA needs the internet to show your chats.")).toBeVisible();
  const retry = page.getByRole("link", { name: "Try again" });
  await expect(retry).toBeVisible();
  await expect(retry).toHaveAttribute("href", "");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
  await expect(page.locator("main img")).toHaveJSProperty("complete", true);
  expect(await page.locator("main img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
}

test("/offline renders the offline message without signing in", async ({ page }) => {
  const errors = watchErrors(page);
  await expectOfflinePage(page);
  // The page is prerendered (the service worker refuses no-store pages), so in a production build its framework scripts carry no
  // CSP nonce and the strict policy reports or blocks them. That is expected: the page is complete without scripts (next test).
  const real = errors.filter((e) => !/Content Security Policy/i.test(e));
  expect(real, real.join("\n")).toEqual([]);
});

test.describe("with JavaScript off, as when the stored page's scripts cannot load", () => {
  test.use({ javaScriptEnabled: false });

  test("/offline still shows the message and the Try again link", async ({ page }) => {
    await expectOfflinePage(page);
  });
});

test("sw.js is served from the site root as JavaScript", async ({ request }) => {
  const res = await request.get("/sw.js");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toMatch(/^(application|text)\/javascript/);
  const body = await res.text();
  expect(body).toContain('const OFFLINE_URL = "/offline";');
  expect(body).toContain('self.addEventListener("fetch"');
});

test("/.well-known/assetlinks.json is a 404 while no signing fingerprint is configured", async ({ request }) => {
  test.skip(Boolean(process.env.ANDROID_ASSETLINKS_SHA256?.trim()), "ANDROID_ASSETLINKS_SHA256 is set in .env; the file is served");
  const res = await request.get("/.well-known/assetlinks.json");
  expect(res.status()).toBe(404);
  // The route's own 404 (empty, not cached), not the site's HTML not-found page, so the route exists.
  expect(res.headers()["content-type"] ?? "").not.toContain("text/html");
  expect(res.headers()["cache-control"]).toBe("no-store");
  expect(await res.text()).toBe("");
});
