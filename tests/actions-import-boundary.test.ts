import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * docs/EDDY-SPEC.md 4.8 test 4: Eddy's code reaches workspace data only through the action layer.
 * - src/lib/eddy/** and src/components/eddy/** may not import the domain services (@/lib/inbox, contacts, broadcasts,
 *   templates, leads, automation, chatbots, ads, teams, routing, workspace), the Graph transport, or the definitions; and
 *   @/lib/db only from the allowlisted persistence files (eddy/history.ts, eddy/conversations.ts, eddy/settings.ts).
 * - In the action layer and Eddy, only src/lib/actions/spend-bridge.ts imports @/lib/spend/* as a value, besides the
 *   streaming AI gateway (@/lib/spend/exec/ai-stream). Type-only imports are erased at build and allowed.
 */

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src");

type Source = { rel: string; code: string };
type Import = { spec: string; typeOnly: boolean };

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mts)$/.test(name)) out.push(full);
  }
  return out;
}

const stripComments = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

function importsOf(code: string): Import[] {
  const out: Import[] = [];
  for (const m of code.matchAll(/(?:^|[\s;])(?:import|export)\s+(type\s+)?(?:[\w*$\s{},]+?\s+from\s+)?["']([^"']+)["']/g)) out.push({ spec: m[2], typeOnly: Boolean(m[1]) });
  for (const m of code.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) out.push({ spec: m[1], typeOnly: false });
  for (const m of code.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g)) out.push({ spec: m[1], typeOnly: false });
  return out;
}

/** "@/lib/x" or a relative specifier as a path under src ("lib/inbox/service"); null for packages. */
function resolve(fromRel: string, spec: string): string | null {
  let p: string;
  if (spec.startsWith("@/")) p = spec.slice(2);
  else if (spec.startsWith(".")) p = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
  else return null;
  return p.replace(/\.(ts|tsx|mts|js|json)$/, "").replace(/\/index$/, "");
}

const FORBIDDEN_FOR_EDDY = ["inbox", "contacts", "broadcasts", "templates", "leads", "automation", "chatbots", "ads", "teams", "routing", "workspace", "graph"].map((m) => `lib/${m}`);
const PERSISTENCE_FILES = new Set(["lib/eddy/history.ts", "lib/eddy/conversations.ts", "lib/eddy/settings.ts"]);
const isEddy = (rel: string) => rel.startsWith("lib/eddy/") || rel.startsWith("components/eddy/");
const inSpendScope = (rel: string) => isEddy(rel) || rel.startsWith("lib/actions/");
const under = (target: string, base: string) => target === base || target.startsWith(`${base}/`);

export function boundaryViolations(files: Source[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    const imports = importsOf(stripComments(f.code));
    for (const imp of imports) {
      const target = resolve(f.rel, imp.spec);
      if (!target) continue;
      if (isEddy(f.rel)) {
        const bad = FORBIDDEN_FOR_EDDY.find((base) => under(target, base));
        if (bad) out.push(`${f.rel}: imports ${imp.spec}; Eddy reaches ${bad.slice(4)} only through @/lib/actions.`);
        if (under(target, "lib/actions/defs")) out.push(`${f.rel}: imports ${imp.spec}; definitions are reached through invoke.ts only.`);
        if (under(target, "lib/db") && !PERSISTENCE_FILES.has(f.rel)) out.push(`${f.rel}: imports ${imp.spec}; only eddy/history.ts, eddy/conversations.ts and eddy/settings.ts touch the database.`);
      }
      if (inSpendScope(f.rel) && under(target, "lib/spend") && !imp.typeOnly && f.rel !== "lib/actions/spend-bridge.ts" && target !== "lib/spend/exec/ai-stream") {
        out.push(`${f.rel}: imports ${imp.spec}; only src/lib/actions/spend-bridge.ts reaches Phase 0 (besides the AI gateway).`);
      }
    }
  }
  return out;
}

const FILES: Source[] = walk(SRC).map((full) => ({ rel: path.relative(SRC, full).split(path.sep).join("/"), code: readFileSync(full, "utf8") }));

describe("Eddy's import boundary (4.8 test 4)", () => {
  it("scans Eddy's files and the action layer", () => {
    expect(FILES.filter((f) => isEddy(f.rel)).length).toBeGreaterThan(10);
    expect(FILES.some((f) => f.rel === "lib/actions/invoke.ts")).toBe(true);
  });

  it("no Eddy file imports a domain service, the database (outside persistence), the definitions or the spend book", () => {
    expect(boundaryViolations(FILES)).toEqual([]);
  });

  it("the definitions themselves never import the spend book (B7, 4.10)", () => {
    const defs = FILES.filter((f) => f.rel.startsWith("lib/actions/defs/"));
    expect(defs.length).toBeGreaterThanOrEqual(11);
    for (const f of defs) for (const imp of importsOf(stripComments(f.code))) expect(resolve(f.rel, imp.spec)?.startsWith("lib/spend") ?? false, `${f.rel} ${imp.spec}`).toBe(false);
  });
});

describe("self-test: planted imports fail", () => {
  it("domain services, the database, the definitions and the spend book from Eddy", () => {
    const planted: Source[] = [
      { rel: "lib/eddy/planted.ts", code: 'import { sendText } from "@/lib/inbox/service";\nimport { prisma } from "@/lib/db";' },
      { rel: "components/eddy/Planted.tsx", code: 'const m = () => import("@/lib/broadcasts/service");\nexport { m };' },
      { rel: "lib/eddy/rel.ts", code: 'import "../teams/visibility";\nimport { INBOX_DEFS } from "../actions/defs/inbox";' },
      { rel: "lib/eddy/spend.ts", code: 'import { headroom } from "@/lib/spend/allowances";' },
      { rel: "lib/actions/defs/planted.ts", code: 'import { kill } from "@/lib/spend/kill";' },
    ];
    const found = boundaryViolations(planted);
    expect(found.map((v) => v.split(":")[0])).toEqual(["lib/eddy/planted.ts", "lib/eddy/planted.ts", "components/eddy/Planted.tsx", "lib/eddy/rel.ts", "lib/eddy/rel.ts", "lib/eddy/spend.ts", "lib/actions/defs/planted.ts"]);
  });

  it("allowed: the action layer's public surface, the gateway, type-only spend types, the bridge and persistence files", () => {
    const ok: Source[] = [
      { rel: "lib/eddy/loop.ts", code: 'import { proposeAction } from "@/lib/actions";\nimport type { FreezeState } from "@/lib/spend/types";\nconst g = () => import("@/lib/spend/exec/ai-stream");' },
      { rel: "lib/eddy/history.ts", code: 'import { prisma } from "@/lib/db";' },
      { rel: "lib/actions/spend-bridge.ts", code: 'import { spendState } from "@/lib/spend/kill";' },
      { rel: "components/eddy/A.tsx", code: 'import { Button } from "@/components/ui";\n// import { x } from "@/lib/inbox/service";' },
    ];
    expect(boundaryViolations(ok)).toEqual([]);
  });
});
