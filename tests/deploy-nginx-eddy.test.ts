import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * docs/EDDY-SPEC.md 7.10 (critic) and EDDY-18 acceptance 7: every new nginx block for Eddy repeats the `location /` proxy
 * headers (nginx does not inherit proxy_set_header into another location), carries the eddy rate limit and gzip off, and the
 * exact turn block streams: no buffering, no cache, a 180 s read timeout, HTTP/1.1. The test parses the config and fails,
 * naming the block, when a directive is missing.
 */

const ROOT = path.resolve(__dirname, "..");
const SITE = readFileSync(path.join(ROOT, "deploy/nginx-wa.edwyz.com.conf"), "utf8");
const ZONES = readFileSync(path.join(ROOT, "deploy/nginx-wa-zones.conf"), "utf8");

type Block = { modifier: string; path: string; directives: string[] };

/** The location blocks of a config, with comment lines removed and each directive normalised to single spaces. */
export function locationBlocks(config: string): Block[] {
  const text = config
    .split("\n")
    .map((line) => line.replace(/#.*$/, ""))
    .join("\n");
  const blocks: Block[] = [];
  for (const m of text.matchAll(/location\s+(=|\^~|~\*?)?\s*(\S+)\s*\{([^{}]*)\}/g)) {
    const directives = m[3]
      .split(";")
      .map((d) => d.trim().replace(/\s+/g, " "))
      .filter(Boolean);
    blocks.push({ modifier: m[1] ?? "", path: m[2], directives });
  }
  return blocks;
}

const HEADERS = [
  "proxy_set_header Host $host",
  "proxy_set_header X-Real-IP $remote_addr",
  "proxy_set_header X-Forwarded-For $remote_addr",
  "proxy_set_header X-Forwarded-Proto $scheme",
  "proxy_set_header X-Request-Id $request_id",
];
const EVERY_NEW_BLOCK = ["proxy_pass http://127.0.0.1:3500", ...HEADERS, "gzip off"];
const TURN_ONLY = ["proxy_buffering off", "proxy_cache off", "proxy_read_timeout 180s", "proxy_http_version 1.1"];
export const EDDY_BLOCKS: { modifier: string; path: string }[] = [
  { modifier: "=", path: "/api/eddy/turn" },
  { modifier: "^~", path: "/api/eddy/" },
  { modifier: "^~", path: "/api/actions/" },
  // No trailing slash: nginx would answer /api/notices with a 301 to /api/notices/, and Next.js sends that back with a 308.
  { modifier: "^~", path: "/api/notices" },
];

/** Every missing directive, as "<block>: <directive>". Empty when the config is right. */
export function eddyNginxProblems(config: string): string[] {
  const blocks = locationBlocks(config);
  const problems: string[] = [];
  for (const want of EDDY_BLOCKS) {
    const name = `location ${want.modifier} ${want.path}`;
    const found = blocks.filter((b) => b.modifier === want.modifier && b.path === want.path);
    if (found.length !== 1) {
      problems.push(`${name}: ${found.length === 0 ? "missing" : "defined more than once"}`);
      continue;
    }
    const d = found[0].directives;
    const required = want.path === "/api/eddy/turn" ? [...EVERY_NEW_BLOCK, ...TURN_ONLY] : EVERY_NEW_BLOCK;
    for (const r of required) if (!d.includes(r)) problems.push(`${name}: ${r}`);
    if (!d.some((x) => /^limit_req zone=wa_eddy burst=10( nodelay)?$/.test(x))) problems.push(`${name}: limit_req zone=wa_eddy burst=10 nodelay`);
  }
  return problems;
}

describe("nginx blocks for Eddy (Eddy 7.10)", () => {
  it("the site config has every block with every directive", () => {
    expect(eddyNginxProblems(SITE)).toEqual([]);
  });

  it("the zones file defines the eddy zone at 2 requests a second per address (Eddy 7.8)", () => {
    expect(ZONES).toMatch(/^limit_req_zone \$binary_remote_addr zone=wa_eddy:10m rate=2r\/s;$/m);
    expect(ZONES.indexOf("zone=wa_eddy:")).toBeLessThan(ZONES.indexOf("limit_req_status 429"));
  });

  it("the catch-all still carries the headers the new blocks copy", () => {
    const root = locationBlocks(SITE).find((b) => b.modifier === "" && b.path === "/" && b.directives.some((d) => d.startsWith("proxy_pass")));
    for (const h of HEADERS) expect(root?.directives).toContain(h);
  });

  it("the turn block keeps no buffering and the 180 s timeout, and no block sets a buffering header nginx would strip", () => {
    const turn = locationBlocks(SITE).find((b) => b.path === "/api/eddy/turn")!;
    expect(turn.directives).toEqual(expect.arrayContaining(["proxy_buffering off", "proxy_read_timeout 180s"]));
    expect(SITE).not.toMatch(/proxy_hide_header\s+X-Accel-Buffering/);
  });

  // The test must fail when a block loses any one directive: remove each in turn from the real config.
  const removable = [...HEADERS, "gzip off", "limit_req zone=wa_eddy burst=10 nodelay", "proxy_buffering off", "proxy_read_timeout 180s"];
  it.each(EDDY_BLOCKS.flatMap((b) => removable.map((r) => [b.path, r] as const)).filter(([p, r]) => p === "/api/eddy/turn" || !["proxy_buffering off", "proxy_read_timeout 180s"].includes(r)))(
    "fails when %s loses `%s`",
    (blockPath, directive) => {
      const start = SITE.search(new RegExp(`location\\s+(=|\\^~)\\s+${blockPath.replace(/[/.]/g, "\\$&")}\\s*\\{`));
      expect(start).toBeGreaterThan(-1);
      const end = SITE.indexOf("}", start);
      const block = SITE.slice(start, end);
      const broken = SITE.slice(0, start) + block.replace(new RegExp(`\\n\\s*${directive.replace(/[$.*+?^()[\]{}|\\]/g, "\\$&")};`), "\n") + SITE.slice(end);
      expect(broken).not.toBe(SITE);
      expect(eddyNginxProblems(broken).some((p) => p.startsWith(`location ${blockPath === "/api/eddy/turn" ? "=" : "^~"} ${blockPath}:`))).toBe(true);
    },
  );

  it("fails when a block is missing, or a directive is only present in a comment", () => {
    const withoutNotices = SITE.replace(/location \^~ \/api\/notices \{[^}]*\}/, "");
    expect(withoutNotices).not.toBe(SITE);
    expect(eddyNginxProblems(withoutNotices)).toContain("location ^~ /api/notices: missing");
    const commented = SITE.replace(/(location \^~ \/api\/actions\/ \{[^}]*?)\n(\s*)gzip off;/, "$1\n$2# gzip off;");
    expect(eddyNginxProblems(commented)).toContain("location ^~ /api/actions/: gzip off");
  });
});
