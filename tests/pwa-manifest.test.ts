import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import manifest from "@/app/manifest";
import { metadata as rootMetadata } from "@/app/layout";
import OfflinePage, { dynamic as offlineDynamic, metadata as offlineMetadata } from "@/app/offline/page";
import { serviceWorkerEnabled } from "@/components/pwa/ServiceWorkerRegistration";
import { PWA_BACKGROUND_COLOR, PWA_ICONS, PWA_THEME_COLOR } from "@/lib/pwa";

/** docs/PLAY-STORE.md, "What the web app needs first": the manifest, its icons, the offline page and the worker registration. */

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const publicFile = (src: string) => path.join(ROOT, "public", src.replace(/^\//, ""));

/** Width, height and colour type from a PNG's IHDR chunk. */
function pngInfo(file: string) {
  const b = readFileSync(file);
  expect(b.subarray(0, 8).toString("hex"), file).toBe("89504e470d0a1a0a");
  expect(b.subarray(12, 16).toString("ascii"), file).toBe("IHDR");
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), colorType: b[25] };
}

/** The light theme's value of a token in the first :root block of globals.css. */
function lightToken(name: string): string {
  const css = read("src/app/globals.css");
  const root = css.slice(css.indexOf(":root {"), css.indexOf("}", css.indexOf(":root {")));
  const m = new RegExp(`${name}:\\s*([^;]+);`).exec(root);
  return m ? m[1].trim().toLowerCase() : "";
}

type Sharp = (input: string) => { raw(): { toBuffer(o: { resolveWithObject: true }): Promise<{ data: Buffer; info: { width: number; height: number; channels: number } }> } };
let sharp: Sharp | null = null;
try {
  sharp = createRequire(path.join(ROOT, "package.json"))("sharp") as Sharp;
} catch {
  sharp = null; // Next ships sharp as an optional dependency; without it only the pixel checks are skipped.
}

describe("web app manifest (/manifest.webmanifest)", () => {
  const m = manifest();

  it("names the app and opens the signed-in app full screen, marked as coming from the Android app", () => {
    expect(m).toMatchObject({
      id: "/app",
      name: "Edwyz WA",
      short_name: "Edwyz WA",
      start_url: "/app?source=twa",
      scope: "/",
      display: "standalone",
      orientation: "portrait",
      categories: ["business", "productivity"],
    });
    expect(m.description).toBeTruthy();
    expect(m.short_name!.length).toBeLessThanOrEqual(12); // launchers truncate longer labels
  });

  it("uses the light theme's brand tokens from globals.css", () => {
    expect(PWA_THEME_COLOR).toBe(lightToken("--accent"));
    expect(PWA_BACKGROUND_COLOR).toBe(lightToken("--background"));
    expect(m.theme_color).toBe(PWA_THEME_COLOR);
    expect(m.background_color).toBe(PWA_BACKGROUND_COLOR);
  });

  it("lists 192 and 512 px icons, each as 'any' and as 'maskable', and every file is a PNG of its declared size", () => {
    const icons = m.icons ?? [];
    const by = (purpose: string) => icons.filter((i) => i.purpose === purpose).map((i) => i.sizes).sort();
    expect(by("any")).toEqual(["192x192", "512x512"]);
    expect(by("maskable")).toEqual(["192x192", "512x512"]);
    for (const icon of icons) {
      expect(icon.type).toBe("image/png");
      expect(existsSync(publicFile(icon.src)), icon.src).toBe(true);
      const { width, height } = pngInfo(publicFile(icon.src));
      expect(`${width}x${height}`, icon.src).toBe(icon.sizes);
    }
  });

  it("keeps maskable and Apple icons opaque (launchers and iOS would fill transparency with black)", () => {
    for (const src of [PWA_ICONS.maskable192, PWA_ICONS.maskable512, PWA_ICONS.apple]) {
      expect(pngInfo(publicFile(src)).colorType, src).toBe(2); // truecolour, no alpha channel
    }
  });

  it.skipIf(!sharp)("draws the maskable logo only inside the 80% safe zone, on the background colour", async () => {
    for (const src of [PWA_ICONS.maskable192, PWA_ICONS.maskable512]) {
      const { data, info } = await sharp!(publicFile(src)).raw().toBuffer({ resolveWithObject: true });
      const size = info.width;
      const centre = size / 2;
      let inked = 0;
      // One expect for the farthest inked pixel: one per pixel takes seconds now that the mark is a filled tile.
      let farthest = { distance: 0, at: "" };
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const i = (y * size + x) * info.channels;
          const isBackground = data[i] >= 250 && data[i + 1] >= 250 && data[i + 2] >= 250;
          if (isBackground) continue;
          inked += 1;
          const distance = Math.hypot(x + 0.5 - centre, y + 0.5 - centre);
          if (distance > farthest.distance) farthest = { distance, at: `${x},${y}` };
        }
      }
      expect(farthest.distance, `${src} pixel ${farthest.at}`).toBeLessThanOrEqual(0.4 * size);
      expect(inked, src).toBeGreaterThan(size * size * 0.05); // the logo is there, not just a blank tile
      const corner = [data[0], data[1], data[2]].map((v) => v.toString(16).padStart(2, "0")).join("");
      expect(`#${corner}`).toBe(PWA_BACKGROUND_COLOR);
    }
  });
});

describe("apple-touch-icon", () => {
  it("is a 180 px PNG linked from the root layout's metadata", () => {
    const icons = rootMetadata.icons as { apple: { url: string; sizes: string; type: string }[] };
    expect(icons.apple).toEqual([{ url: PWA_ICONS.apple, sizes: "180x180", type: "image/png" }]);
    const { width, height } = pngInfo(publicFile(PWA_ICONS.apple));
    expect([width, height]).toEqual([180, 180]);
  });
});

describe("offline page (/offline)", () => {
  it("says what happened and offers to try again with a link that works without scripts", () => {
    const html = renderToStaticMarkup(OfflinePage());
    expect(html).toContain("You are offline.");
    expect(html).toContain("Edwyz WA needs the internet to show your chats.");
    expect(html).toMatch(/<a href=""[^>]*>Try again<\/a>/);
    expect(html).toContain(`src="${PWA_ICONS.any192}"`);
  });

  it("is static (the worker refuses no-store pages), reads no data and stays out of search results", () => {
    expect(offlineDynamic).toBe("force-static");
    expect(offlineMetadata.robots).toEqual({ index: false, follow: false });
    const src = read("src/app/offline/page.tsx");
    for (const forbidden of ["next/headers", "@/lib/db", "fetch(", "cookies(", "\"use client\""]) expect(src).not.toContain(forbidden);
  });
});

describe("service worker registration", () => {
  it("is on in production builds only, never in next dev or tests", () => {
    expect(serviceWorkerEnabled("production")).toBe(true);
    for (const env of ["development", "test", undefined, ""]) expect(serviceWorkerEnabled(env)).toBe(false);
    expect(serviceWorkerEnabled()).toBe(false); // vitest runs with NODE_ENV=test
  });

  it("is mounted once from the root layout and registers /sw.js for the whole site", () => {
    expect(read("src/app/layout.tsx").match(/<ServiceWorkerRegistration \/>/g)).toHaveLength(1);
    const component = read("src/components/pwa/ServiceWorkerRegistration.tsx");
    expect(component.startsWith('"use client";')).toBe(true);
    expect(component).toContain('register(SERVICE_WORKER_PATH, { scope: "/"');
    expect(read("src/lib/pwa.ts")).toContain('export const SERVICE_WORKER_PATH = "/sw.js";');
    expect(existsSync(path.join(ROOT, "public/sw.js"))).toBe(true);
  });
});
