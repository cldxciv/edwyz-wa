import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Owner decision 6 (2026-10-31): every module is on every plan. Plans differ in limits (seats, contacts, broadcast messages, AI
 * credits, AI replies an hour, ...), never in which modules a workspace has. This pins it:
 * - Plan.features holds allowances only, read by name in a reviewed list of files, and an allowance of 0 (which would switch a
 *   module off for a plan) is ignored;
 * - the navigation is filtered by role alone, and neither the request proxy nor the app layout hands the plan to the shell.
 * A new reader of Plan.features fails here: make it an allowance (a number), never a switch, and add the file to the list.
 */

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "generated" || name === "node_modules") continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

const rel = (full: string) => path.relative(ROOT, full).split(path.sep).join("/");
const stripComments = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

/** Files that read a `features` property or select it from the database. The marketing site's feature lists are another thing. */
const READS_FEATURES = /\bfeatures\s*:\s*true\b|\.features\b|\[["']features["']\]/;
const MARKETING = /^src\/(app\/\(site\)|components\/site)\//;

const REVIEWED_READERS = new Set([
  "src/lib/billing/ai-allowance.ts", // aiRepliesPerHour: an allowance, 1 or more
  "src/lib/billing/ai-hourly.ts", // selects features for the allowance above
  "src/lib/automation/v2/metering.ts", // automationTriggersMonthly: an allowance, 1 or more
  "src/lib/billing/service.ts", // lists the plans for the billing page
  "src/lib/admin/plans.ts", // the plan editor (writes, and copies a plan)
  "src/components/admin/PlanForm.tsx", // the plan editor's form
  "src/app/(admin)/admin/plans/page.tsx", // the plan editor's page
]);

describe("no module is gated by plan (owner decision 6)", () => {
  it("only the reviewed files read Plan.features, and they read allowances", () => {
    const readers = walk(SRC)
      .map((f) => ({ rel: rel(f), code: stripComments(readFileSync(f, "utf8")) }))
      .filter((f) => !MARKETING.test(f.rel) && READS_FEATURES.test(f.code))
      .map((f) => f.rel);
    const unreviewed = readers.filter((r) => !REVIEWED_READERS.has(r));
    expect(unreviewed, `New readers of features: ${unreviewed.join(", ")}. Plan.features may hold allowances only (numbers), never a switch that turns a module off.`).toEqual([]);
  });

  it("the allowances read from Plan.features are numbers, and 0 never switches a module off", async () => {
    const { featureRepliesPerHour } = await import("@/lib/billing/ai-allowance");
    const { readLimit } = await import("@/lib/automation/v2/metering");
    expect(featureRepliesPerHour({ aiRepliesPerHour: 0 })).toBeNull();
    expect(readLimit({ automationTriggersMonthly: 0 })).toBeNull();
    expect(featureRepliesPerHour({ aiRepliesPerHour: true })).toBeNull();
    expect(readLimit({ automationTriggersMonthly: true })).toBeNull();
    expect(featureRepliesPerHour({ aiRepliesPerHour: 5 })).toBe(5);
    expect(readLimit({ automationTriggersMonthly: 5 })).toBe(5);
    // The two readers name their keys; nothing reads a module switch such as {"ads": false}.
    expect(read("src/lib/billing/ai-allowance.ts")).toContain('AI_REPLIES_PER_HOUR_FEATURE = "aiRepliesPerHour"');
    expect(read("src/lib/automation/v2/metering.ts")).toContain('LIMIT_FEATURE = "automationTriggersMonthly"');
  });

  it("the navigation is filtered by role alone: every module for an owner, whatever the plan", async () => {
    const { NAV_ITEMS, navFor } = await import("@/components/app/nav");
    expect(navFor.length).toBe(1);
    const keys = new Set(NAV_ITEMS.flatMap((i) => Object.keys(i)));
    for (const k of keys) expect(["href", "label", "minRole", "section", "icon", "keywords", "group"]).toContain(k);
    const hrefs = navFor("owner").map((i) => i.href);
    for (const module of ["/app/inbox", "/app/contacts", "/app/broadcasts", "/app/templates", "/app/ads", "/app/creative", "/app/content", "/app/automation", "/app/automation/chatbots", "/app/automation/ai-agent", "/app/commerce", "/app/reports", "/app/conversions"]) {
      expect(hrefs, module).toContain(module);
    }
    expect(stripComments(read("src/components/app/nav.ts"))).not.toMatch(/billing\/|getBillingStatus|planId|planName|features/);
  });

  it("the request proxy and the app shell never look at the plan", () => {
    expect(stripComments(read("src/proxy.ts"))).not.toMatch(/\bplan|features|getBillingStatus/i);
    const layout = stripComments(read("src/app/(app)/app/layout.tsx"));
    // The billing state only feeds the billing banner; the shell gets the role.
    const shell = layout.match(/<AppShell[^>]*>/)?.[0] ?? "";
    expect(shell).toContain("role={actor.role}");
    expect(shell).not.toMatch(/plan|features/i);
  });

  it("the plan editor says so, and its example is an allowance, not a switch", () => {
    const form = read("src/components/admin/PlanForm.tsx");
    expect(form).toContain("Every module is on every plan");
    expect(form).not.toContain('{"api": true}');
    expect(read("src/lib/admin/plans.ts")).not.toContain('{\\"api\\": true}');
  });
});
