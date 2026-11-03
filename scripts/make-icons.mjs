// Draws the app icons and the favicon from the mark in the site header (Logo in src/components/shell.tsx), so the browser tab,
// the installed app and the Android app show the same logo as the pages. Run once after changing the mark, then commit the files:
//   node scripts/make-icons.mjs
// Uses sharp, which Next installs. Rules held by tests/pwa-manifest.test.ts: "any" icons fill the tile; maskable and Apple icons are
// opaque, and maskable ones keep every drawn pixel inside the central 80% circle on the white background colour.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ACCENT = "#047857"; // --accent, the same as PWA_THEME_COLOR
const BACKGROUND = "#ffffff"; // PWA_BACKGROUND_COLOR

// The header mark's chat bubble and tick, on a 32 x 32 grid.
const GLYPH = `
  <path d="M16 7.5a8.5 8.5 0 0 0-7.3 12.9L7.5 24.5l4.2-1.1A8.5 8.5 0 1 0 16 7.5z" fill="none" stroke="#fff" stroke-width="2" stroke-linejoin="round"/>
  <path d="m12.5 16 2.4 2.4 4.6-4.8" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;

const svg = (body, background = "") =>
  Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="1024" height="1024">${background}${body}</svg>`);

/** The rounded tile with the bubble, scaled about the centre (scale 1 fills the 32 x 32 grid like the header). */
const mark = (scale = 1) => `<g transform="translate(16 16) scale(${scale}) translate(-16 -16)"><rect width="32" height="32" rx="9" fill="${ACCENT}"/>${GLYPH}</g>`;

// The farthest point of a rounded square of half-side 16 and corner radius 9 is 7 * sqrt(2) + 9 = 18.9 units from the centre;
// at 0.64 that is 12.1, inside the 12.8 (40% of 32) a launcher never crops.
const MASKABLE_SCALE = 0.64;

const files = {
  "public/icons/icon-192.png": { size: 192, svg: svg(mark()) },
  "public/icons/icon-512.png": { size: 512, svg: svg(mark()) },
  "public/icons/maskable-192.png": { size: 192, svg: svg(mark(MASKABLE_SCALE), `<rect width="32" height="32" fill="${BACKGROUND}"/>`), opaque: true },
  "public/icons/maskable-512.png": { size: 512, svg: svg(mark(MASKABLE_SCALE), `<rect width="32" height="32" fill="${BACKGROUND}"/>`), opaque: true },
  // iOS rounds the corners itself, so the tile runs to the edges.
  "public/icons/apple-touch-icon.png": { size: 180, svg: svg(GLYPH, `<rect width="32" height="32" fill="${ACCENT}"/>`), opaque: true },
};

async function png(source, size, opaque = false) {
  let image = sharp(source).resize(size, size);
  if (opaque) image = image.flatten({ background: BACKGROUND }).removeAlpha();
  return image.png({ compressionLevel: 9 }).toBuffer();
}

for (const [file, spec] of Object.entries(files)) {
  writeFileSync(path.join(ROOT, file), await png(spec.svg, spec.size, spec.opaque));
  console.log(`wrote ${file}`);
}

// favicon.ico: 16, 32 and 48 px PNGs in one icon file (ICONDIR, one ICONDIRENTRY each, then the images).
const sizes = [16, 32, 48];
const images = await Promise.all(sizes.map((s) => png(svg(mark()), s)));
const header = Buffer.alloc(6 + 16 * sizes.length);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
sizes.forEach((s, i) => {
  const at = 6 + 16 * i;
  header.writeUInt8(s, at);
  header.writeUInt8(s, at + 1);
  header.writeUInt8(0, at + 2);
  header.writeUInt8(0, at + 3);
  header.writeUInt16LE(1, at + 4);
  header.writeUInt16LE(32, at + 6);
  header.writeUInt32LE(images[i].length, at + 8);
  header.writeUInt32LE(offset, at + 12);
  offset += images[i].length;
});
writeFileSync(path.join(ROOT, "src/app/favicon.ico"), Buffer.concat([header, ...images]));
console.log("wrote src/app/favicon.ico");
