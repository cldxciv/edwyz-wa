#!/usr/bin/env node
// Bundles the worker daemon (src/worker/index.ts) into one ES module the standalone release can run:
//   node deploy/build-worker.mjs [outfile] [--check <releaseDir>]       default outfile: worker/index.mjs
// Packages stay external (pg, @prisma/*, nodemailer, next ...): the release already carries them in node_modules from the
// standalone build, so the worker uses exactly the versions the web app uses. Only the app's own TypeScript is bundled.
// esbuild is a devDependency of this project (package.json), so `npm ci` brings it in. Run this where the sources are, then copy the
// output into the release.
//
// --check <releaseDir> proves the other half of that assumption: every package the bundle leaves external must resolve inside
// <releaseDir>/node_modules (the standalone output only traces what the web app itself imports, so a package used only by the worker
// could be missing). It exits 1 and names each missing package, so a bad release fails at deploy time, not when pm2 starts the worker.
import { build } from "esbuild";
import { existsSync, mkdirSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, resolve } from "node:path";

const args = process.argv.slice(2);
const checkAt = args.indexOf("--check");
const releaseDir = checkAt >= 0 ? resolve(args[checkAt + 1] ?? "") : null;
if (checkAt >= 0 && !args[checkAt + 1]) {
  console.error("--check needs the release directory, for example: --check /var/www/edwyz-wa");
  process.exit(2);
}
const positional = args.filter((a, i) => !a.startsWith("--") && (checkAt < 0 || i !== checkAt + 1));
const out = resolve(positional[0] ?? "worker/index.mjs");
mkdirSync(dirname(out), { recursive: true });

const result = await build({
  entryPoints: [resolve("src/worker/index.ts")],
  outfile: out,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  packages: "external",
  tsconfig: resolve("tsconfig.json"),
  sourcemap: false,
  metafile: true,
  logLevel: "warning",
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
if (result.errors.length > 0) process.exit(1);
console.log(`worker bundle written to ${out}`);

/** The external specifiers the bundle imports, for example "pg", "@prisma/client/runtime/x.mjs". */
export function externalSpecifiers(metafile) {
  const found = new Set();
  for (const output of Object.values(metafile.outputs)) {
    for (const imp of output.imports) if (imp.external && !imp.path.startsWith("node:") && !builtinModules.includes(imp.path)) found.add(imp.path);
  }
  return [...found].sort();
}

/** "@prisma/client/runtime/x.mjs" -> "@prisma/client", "pg/lib/y" -> "pg". */
export function packageOf(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

const specifiers = externalSpecifiers(result.metafile);
console.log(`external packages the worker needs in node_modules: ${[...new Set(specifiers.map(packageOf))].join(", ")}`);

if (releaseDir) {
  const modules = join(releaseDir, "node_modules");
  const missing = [...new Set(specifiers.map(packageOf))].filter((name) => !existsSync(join(modules, name, "package.json")));
  const missingFiles = specifiers.filter((s) => s !== packageOf(s) && !missing.includes(packageOf(s)) && !existsSync(join(modules, s)));
  for (const name of missing) console.error(`MISSING package in ${modules}: ${name}`);
  for (const file of missingFiles) console.warn(`warning: ${file} is not a file under ${modules} (fine if the package maps it with "exports")`);
  if (missing.length > 0) {
    console.error("The standalone release does not carry every package the worker imports. Copy them from the build host's node_modules, for example:");
    console.error(`  for p in ${missing.join(" ")}; do mkdir -p "${modules}/$(dirname $p)" && cp -a node_modules/$p "${modules}/$(dirname $p)/"; done`);
    process.exit(1);
  }
  console.log(`all external packages resolve in ${modules}`);
}
