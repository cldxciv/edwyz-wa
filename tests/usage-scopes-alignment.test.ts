import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { META_CONNECT_SCOPES, SCOPE_PURPOSES, scopeSummary, unusedScopes } from "@/lib/meta-connect/scopes";

const SRC = path.resolve(__dirname, "../src");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (name === "generated" || name === "node_modules") continue;
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

const files = walk(SRC).map((f) => ({ file: path.relative(SRC, f).replace(/\\/g, "/"), text: readFileSync(f, "utf8") }));
const SCOPES_FILE = "lib/meta-connect/scopes.ts";

describe("requested permissions match what the code uses", () => {
  it("does not request insights permissions while no code reads Page or Instagram insights", () => {
    expect(META_CONNECT_SCOPES).not.toContain("read_insights");
    expect(META_CONNECT_SCOPES).not.toContain("instagram_manage_insights");
    expect(Object.keys(SCOPE_PURPOSES)).not.toContain("read_insights");
  });

  it("the only insights edge the app reads is the ad account's (needs ads_read)", () => {
    const readers = files.filter((f) => f.file.startsWith("lib/") && /graphFetch/.test(f.text) && /\/insights/.test(f.text));
    expect(readers.map((f) => f.file)).toEqual(["lib/ads/insights-fetch.ts"]);
    expect(readers[0].text).toMatch(/act_.*\/insights/);
  });

  it("no source file other than the scope list mentions the removed permissions", () => {
    const offenders = files.filter((f) => f.file !== SCOPES_FILE && /read_insights|instagram_manage_insights/.test(f.text)).map((f) => f.file);
    expect(offenders).toEqual([]);
  });

  it("every requested permission has a plain-language purpose and a reason in the code", () => {
    expect(Object.keys(SCOPE_PURPOSES).sort()).toEqual([...META_CONNECT_SCOPES].sort());
    const needs: Record<string, RegExp> = {
      business_management: /me\/businesses/,
      ads_management: /createCampaign/,
      ads_read: /me\/adaccounts/,
      pages_show_list: /me\/accounts/,
      pages_read_engagement: /instagram_business_account/,
      pages_manage_ads: /createAd/,
      pages_manage_metadata: /subscribed_apps/,
      leads_retrieval: /LEAD_FIELDS/,
      pages_manage_posts: /\/feed/,
      instagram_basic: /instagram_business_account/,
      instagram_content_publish: /media_publish/,
    };
    const all = files.filter((f) => f.file !== SCOPES_FILE).map((f) => f.text).join("\n");
    for (const scope of META_CONNECT_SCOPES) expect(all, scope).toMatch(needs[scope]);
  });

  it("a token that still carries the removed permissions is flagged as unused", () => {
    expect(unusedScopes([...META_CONNECT_SCOPES, "read_insights", "instagram_manage_insights", "public_profile"])).toEqual(["read_insights", "instagram_manage_insights"]);
    expect(scopeSummary(["read_insights"]).unexpected).toEqual(["read_insights"]);
  });

  it("the operator docs never tell anyone to request a permission the code does not use", () => {
    const DOCS = path.resolve(__dirname, "../docs");
    const unused = ["read_insights", "instagram_manage_insights", "pages_manage_engagement"];
    const read = (f: string) => readFileSync(path.join(DOCS, f), "utf8").replaceAll(String.fromCharCode(13), "");
    // in the dashboard checklist an unused permission may only appear in a row that says it is not requested
    const rows = read("meta-dashboard-requirements.md").split("\n").filter((l) => /^\| \d+ \|/.test(l) && unused.some((u) => l.includes("`" + u + "`")));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row).toMatch(/not requested/i);
    const posts = read("app-review/pages_manage_posts.md");
    expect(posts.split("\n")[0]).toBe("# pages_manage_posts");
    expect(posts).not.toMatch(/NOT BUILT/);
    const phaseB = read("app-review/00-overview.md").split("\n").find((l) => l.startsWith("3. **Phase B:**")) ?? "";
    expect(phaseB).toMatch(/NOT requested/i);
    expect(phaseB).not.toMatch(/\(with `pages_manage_engagement`/);
  });
});
