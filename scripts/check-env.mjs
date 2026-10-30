// Validates the environment before a deploy. Prints variable names and problems, never values.
//   node scripts/check-env.mjs                          checks process.env
//   node scripts/check-env.mjs /var/www/edwyz-wa/.env   checks that file only
// Exit code 1 when a required variable is missing or malformed, 0 otherwise (warnings do not fail).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { checkEnv } from "../src/lib/env-rules.mjs";

const file = process.argv[2];
let env = process.env;
if (file) {
  try {
    // A file given on the command line is the production env file being checked before a deploy.
    env = { NODE_ENV: "production", ...parseEnv(readFileSync(file, "utf8")) };
  } catch {
    console.error(`Cannot read ${file}`);
    process.exit(2);
  }
}

const { errors, warnings, disabled } = checkEnv(env);

// In-memory rate limiters and replay guards are per process: more than one pm2 instance of the web app multiplies every limit.
function pm2Instances() {
  try {
    const list = JSON.parse(execFileSync("pm2", ["jlist"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }));
    const counts = new Map();
    for (const p of list) if (p.pm2_env?.status === "online") counts.set(p.name, (counts.get(p.name) ?? 0) + 1);
    return [...counts].filter(([name, n]) => n > 1 && !/worker/i.test(name));
  } catch {
    return [];
  }
}
for (const [name, n] of pm2Instances()) {
  warnings.push(`pm2 app ${name} runs ${n} instances; the web app must run as a single instance until the shared rate limiter exists (docs/ops.md)`);
}
for (const line of errors) console.log(`ERROR  ${line}`);
for (const line of warnings) console.log(`WARN   ${line}`);
for (const line of disabled) console.log(`OFF    ${line}`);
console.log(`${errors.length} error(s), ${warnings.length} warning(s), ${disabled.length} optional feature(s) off.`);
process.exit(errors.length > 0 ? 1 : 0);
