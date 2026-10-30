import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/** docs/ops.md section 2: every in-memory limiter moves to the shared limiter in src/lib/ratelimit, each with a unique stable name. */
const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}
const rel = (full: string) => path.relative(ROOT, full).split(path.sep).join("/");
/**
 * The tests that walk src read every source file, generated client included. Under the full suite's parallel load that can
 * pass vitest's 5 s default although nothing is wrong, so they get a realistic budget. The checks themselves are unchanged.
 */
const SCAN_TIMEOUT = 30_000;

/** Files from the migration guide, with the limiter names they must register. */
const MIGRATED: Record<string, string[]> = {
  "src/lib/auth/ratelimit.ts": ["login-ip", "login-pair", "login-email"],
  "src/lib/admin/security.ts": ["admin-totp"],
  "src/lib/approvals/guards.ts": ["approval-decide-ip", "approval-decide-token", "approval-view-ip", "approval-resend-user"],
  "src/lib/email/limits.ts": ["forgot-ip", "forgot-email", "verify-ip", "reset-ip", "resend-user"],
  "src/lib/compat/runtime.ts": ["compat-token"],
  "src/lib/integrations/apikeys.ts": ["apikey"],
  "src/lib/tenant-mcp/server.ts": ["tenant-mcp"],
  "src/lib/inbox/suggest.ts": ["inbox-suggest"],
  "src/lib/byo-mcp/index.ts": ["byo-mcp"],
  "src/app/api/inbox/conversations/[id]/attachments/route.ts": ["inbox-upload"],
  "src/app/api/inbox/media/[messageId]/route.ts": ["inbox-media"],
  "src/app/api/csp-report/route.ts": ["csp-report"],
};

/** Shapes a hand-rolled limiter takes: a Map of timestamps, or of {count, resetAt} buckets. */
const OWN_LIMITER_PATTERNS: RegExp[] = [
  /new Map<string,\s*number\[\]>/,
  /new Map<string,\s*\{\s*(count|hits|n)\b[^}]*\}>/,
  /new Map<string,\s*\{[^}]*resetAt[^}]*\}>/,
  /\bhits\s*=\s*new Map\b/,
  /\bresetAt\s*:\s*now\s*\+/,
  /export function createLimiter/,
];

describe("rate limiter migration", () => {
  it.each(Object.keys(MIGRATED))("%s no longer defines its own limiter", (file) => {
    const source = read(file);
    for (const pattern of OWN_LIMITER_PATTERNS) expect(source, `${file} matches ${pattern}`).not.toMatch(pattern);
    expect(source).not.toMatch(/from "@\/lib\/auth\/ratelimit"[^\n]*createLimiter|createLimiter[^\n]*from "@\/lib\/auth\/ratelimit"/);
  });

  it.each(Object.entries(MIGRATED))("%s registers its named shared limiters", (file, names) => {
    const source = read(file);
    expect(source).toMatch(/import \{[^}]*\bcreateLimiter\b[^}]*\} from "@\/lib\/ratelimit"/);
    for (const name of names) expect(source, `${file} is missing limiter "${name}"`).toContain(`"${name}"`);
  });

  it("every limiter in src has a unique stable name", { timeout: SCAN_TIMEOUT }, () => {
    const seen = new Map<string, string>();
    for (const full of walk(path.join(ROOT, "src"))) {
      const file = rel(full);
      if (file === "src/lib/ratelimit/index.ts") continue;
      const source = readFileSync(full, "utf8");
      const calls = [...source.matchAll(/\bcreateLimiter\(([^;]*?)\)(?:;|\n)/g)];
      for (const call of calls) {
        const name = call[1].match(/"([a-z][a-z0-9-]*)"/)?.[1];
        expect(name, `${file}: createLimiter(${call[1]}) needs a stable name`).toBeTruthy();
        expect(seen.has(name!), `${file} reuses limiter name "${name}" from ${seen.get(name!)}`).toBe(false);
        seen.set(name!, file);
      }
    }
    for (const names of Object.values(MIGRATED)) for (const name of names) expect(seen.has(name), `limiter "${name}" not created`).toBe(true);
  });

  it("the Eddy card routes use the limiter EDDY-SPEC 4.3 names, and the exported name matches the call", () => {
    const source = read("src/lib/actions/card-http.ts");
    expect(source).toMatch(/export const CARD_ROUTE_LIMITER = "actions-confirm";/);
    expect(source).toMatch(/createLimiter\(CARD_ROUTE_PER_MIN, 60_000, "actions-confirm"\)/);
  });

  it("nothing in src imports the old in-memory createLimiter", { timeout: SCAN_TIMEOUT }, () => {
    const offenders = walk(path.join(ROOT, "src"))
      .filter((full) => /import \{[^}]*\bcreateLimiter\b[^}]*\} from "@\/lib\/auth\/ratelimit"/.test(readFileSync(full, "utf8")))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it("the only timestamp-list reservation left in a listed area is the MCP send guard, which is backed by a durable ledger", { timeout: SCAN_TIMEOUT }, () => {
    const hits: string[] = [];
    for (const dir of ["src/lib", "src/app"]) {
      for (const full of walk(path.join(ROOT, dir))) {
        if (/new Map<string,\s*number\[\]>/.test(readFileSync(full, "utf8"))) hits.push(rel(full));
      }
    }
    expect(hits).toEqual(["src/lib/tenant-mcp/send-guard.ts"]);
    expect(read("src/lib/tenant-mcp/send-guard.ts")).toContain("SEND_LEDGER_PREFIX");
  });

  it("login limits are checked with the shared count in both routes", () => {
    for (const file of ["src/app/api/auth/login/route.ts", "src/app/api/auth/accept-invite/route.ts"]) {
      expect(read(file)).toMatch(/await checkLoginLimits\(/);
    }
    expect(read("src/lib/auth/ratelimit.ts")).toContain("consumeShared");
  });
});
