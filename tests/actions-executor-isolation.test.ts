import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * docs/EDDY-SPEC.md 4.8 test 3: src/lib/actions/invoke.ts is the only caller of a definition's run(), and nothing reaches a
 * definition except through the registry. Fails when:
 * - any file other than invoke.ts calls `.run(` inside the action layer (src/lib/actions), or calls run() on a definition
 *   anywhere in src (`def.run(`, `actionByName(..).run(`, `ACTIONS[i].run(`); Eddy's loop running its own tool thunks is fine;
 * - any file imports src/lib/actions/defs/* directly, other than the registry (which registers them once), invoke.ts (allowed
 *   by the spec) and the definition files themselves.
 */

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src");

type Source = { rel: string; code: string };

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "generated" || name === "node_modules") continue;
      walk(full, out);
    } else if (/\.(ts|tsx|mts)$/.test(name)) out.push(full);
  }
  return out;
}

/** Drops comments but keeps strings and template literals (a URL's "//" is not a comment). */
export function stripComments(code: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < code.length) {
    const c = code[i];
    const next = code[i + 1];
    if (quote) {
      out += c;
      if (c === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = code.indexOf("*/", i + 2);
      const chunk = code.slice(i, end < 0 ? code.length : end + 2);
      out += chunk.replace(/[^\n]/g, " ");
      i = end < 0 ? code.length : end + 2;
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < code.length && code[i] !== "\n") i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Blanks the inside of string and template literals, for checks that look at code only. */
export const blankStrings = (code: string): string => code.replace(/(["'`])(?:\\.|(?!\1)[^\\\n])*\1/g, (m) => m[0] + " ".repeat(Math.max(0, m.length - 2)) + m[0]);

export type Import = { spec: string; typeOnly: boolean };

export function importsOf(code: string): Import[] {
  const out: Import[] = [];
  for (const m of code.matchAll(/(?:^|[\s;])(import|export)\s+(type\s+)?(?:[\w*$\s{},]+?\s+from\s+)?["']([^"']+)["']/g)) out.push({ spec: m[3], typeOnly: Boolean(m[2]) });
  for (const m of code.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) out.push({ spec: m[1], typeOnly: false });
  for (const m of code.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g)) out.push({ spec: m[1], typeOnly: false });
  return out;
}

/** "@/lib/x" or a relative specifier, as a path under src without extension or /index ("lib/actions/defs"). */
export function resolve(fromRel: string, spec: string): string | null {
  let p: string;
  if (spec.startsWith("@/")) p = spec.slice(2);
  else if (spec.startsWith(".")) p = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
  else return null;
  return p.replace(/\.(ts|tsx|mts|js|json)$/, "").replace(/\/index$/, "");
}

/** Inside the action layer every `.run(` counts (invoke.ts aside). Elsewhere (Eddy's loop runs its own tool thunks) only a
 * run() whose receiver is a definition does: `def.run(`, `definition.run(`, `actionDef.run(`, `actionByName(..).run(`,
 * `ACTIONS[i].run(`, `listActions()[i].run(`. */
const IN_ACTIONS = (rel: string) => rel.startsWith("lib/actions/");
const DEF_RUN = /(\b(?:def|definition|actionDef|defs\[[^\]]*\]|definitions\[[^\]]*\])|actionByName\([^)]*\)|ACTIONS\[[^\]]*\]|listActions\(\)\[[^\]]*\])!?\??\.run\s*\(/;
const DEFS_IMPORTERS_ALLOWED = new Set(["lib/actions/registry.ts", "lib/actions/invoke.ts"]);

export function violations(files: Source[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    const code = stripComments(f.code);
    const bare = blankStrings(code);
    if (f.rel !== "lib/actions/invoke.ts") {
      if (IN_ACTIONS(f.rel) && /\.run\s*\(/.test(bare)) out.push(`${f.rel}: calls .run( inside the action layer; only src/lib/actions/invoke.ts runs a definition.`);
      else if (DEF_RUN.test(bare)) out.push(`${f.rel}: calls run() on an action definition; go through invoke.ts.`);
    }
    if (!f.rel.startsWith("lib/actions/defs/") && !DEFS_IMPORTERS_ALLOWED.has(f.rel)) {
      for (const imp of importsOf(code)) {
        const target = resolve(f.rel, imp.spec);
        if (target && (target === "lib/actions/defs" || target.startsWith("lib/actions/defs/"))) out.push(`${f.rel}: imports ${imp.spec}; definitions are reached only through the registry and invoke.ts.`);
      }
    }
  }
  return out;
}

const FILES: Source[] = walk(SRC).map((full) => ({ rel: path.relative(SRC, full).split(path.sep).join("/"), code: readFileSync(full, "utf8") }));

describe("executor isolation (4.8 test 3)", () => {
  it("found the source tree, the executor and the definitions", () => {
    const rels = FILES.map((f) => f.rel);
    expect(rels).toContain("lib/actions/invoke.ts");
    expect(rels).toContain("lib/actions/defs/index.ts");
    expect(FILES.find((f) => f.rel === "lib/actions/invoke.ts")!.code).toMatch(/def\.run\(/);
  });

  it("only invoke.ts calls run(), and only the registry and invoke.ts import the definitions", () => {
    expect(violations(FILES)).toEqual([]);
  });

  it("the registry imports the definitions in one place", () => {
    const registry = FILES.find((f) => f.rel === "lib/actions/registry.ts")!.code;
    expect(importsOf(stripComments(registry)).filter((i) => resolve("lib/actions/registry.ts", i.spec) === "lib/actions/defs")).toHaveLength(1);
  });
});

describe("self-test: planted files fail", () => {
  it("a .run( call in the action layer or Eddy, and run() on a looked-up definition elsewhere", () => {
    const planted: Source[] = [
      { rel: "lib/eddy/planted.ts", code: 'import { actionByName } from "@/lib/actions";\nexport const x = (def: { run: () => void }) => def.run();' },
      { rel: "lib/actions/defs/planted.ts", code: "export const y = (o: { run: () => void }) => o.run();" },
      { rel: "app/api/planted/route.ts", code: 'import { actionByName } from "@/lib/actions";\nexport const z = () => actionByName("tag_contacts")!.run({} as never, {}, { idempotencyKey: "k" });' },
      { rel: "lib/somewhere/else.ts", code: "export const w = (def: { run: () => void }) => def.run();" },
    ];
    expect(violations(planted).map((v) => v.split(":")[0])).toEqual(["lib/eddy/planted.ts", "lib/actions/defs/planted.ts", "app/api/planted/route.ts", "lib/somewhere/else.ts"]);
  });

  it("a direct import of a definition file, static or dynamic, from outside the registry", () => {
    const planted: Source[] = [
      { rel: "lib/eddy/loop2.ts", code: 'import { INBOX_DEFS } from "@/lib/actions/defs/inbox";' },
      { rel: "lib/actions/sneaky.ts", code: 'export const load = () => import("./defs");' },
      { rel: "components/eddy/X.tsx", code: 'export { V1_DEFINITIONS } from "@/lib/actions/defs";' },
    ];
    expect(violations(planted)).toHaveLength(3);
  });

  it("comments and strings do not count", () => {
    const ok: Source[] = [
      { rel: "lib/eddy/ok.ts", code: '// def.run(ctx)\n/* actionByName("x").run() */\nexport const s = "def.run(";\nexport const u = "https://example.com//x";' },
      // Eddy's loop runs its own tool thunks; that is not a definition.
      { rel: "lib/eddy/loop-ok.ts", code: "export const go = async (calls: { run: () => Promise<void> }[]) => { for (const c of calls) await c.run(); await calls[0].run(); };" },
    ];
    expect(violations(ok)).toEqual([]);
  });
});
