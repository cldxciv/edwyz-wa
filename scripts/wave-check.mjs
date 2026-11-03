// Fails when a build wave changed nothing. Usage: node scripts/wave-check.mjs [git-ref]
import { execSync } from "node:child_process";
const ref = process.argv[2] ?? "HEAD";
let out = "";
try {
  out = execSync(`git status --porcelain && git diff --name-only ${ref}`, { encoding: "utf8" }).trim();
} catch (e) {
  console.error("wave-check: could not read git state:", e.message);
  process.exit(2);
}
const files = [...new Set(out.split("\n").map((l) => l.replace(/^..\s/, "").trim()).filter(Boolean))];
if (files.length === 0) {
  console.error("wave-check FAILED: no files changed. A green test run on an unchanged tree proves nothing.");
  process.exit(1);
}
console.log(`wave-check ok: ${files.length} changed paths`);
