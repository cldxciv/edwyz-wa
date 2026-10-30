import { build } from "esbuild";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The worker daemon never reaches Eddy's streaming gateway or the Anthropic SDK (docs/EDDY-SPEC.md 5.2, Phase 0 request E2,
 * rule B2b). The SDK is imported only by src/lib/spend/exec/ai-stream.ts, which only the web process uses; the worker keeps
 * the non-streaming gateway (src/lib/spend/exec/ai.ts, plain fetch). So `deploy/build-worker.mjs --check` never needs the SDK
 * in the release's node_modules, and a worker job can never stream a model call.
 *
 * The import graph is built by esbuild, the bundler build-worker.mjs uses, with the same options (bundle, packages external,
 * tsconfig paths). It follows static imports and literal dynamic imports and erases type-only imports, exactly as the real
 * worker bundle does. Every file under src/worker/** is an entry point, a superset of build-worker.mjs's single entry.
 */

const ROOT = process.cwd();
const WORKER_DIR = path.join(ROOT, "src", "worker");
const STREAM_GATEWAY = "src/lib/spend/exec/ai-stream.ts";
const SDK = /^@anthropic-ai\/sdk(\/|$)/;

function workerEntries(dir: string = WORKER_DIR): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...workerEntries(full));
    else if (/\.(ts|tsx|mts)$/.test(entry) && !/\.d\.m?ts$/.test(entry)) out.push(full);
  }
  return out;
}

type Graph = { inputs: string[]; externals: string[] };

const BASE = {
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  target: "node20",
  packages: "external",
  tsconfig: path.join(ROOT, "tsconfig.json"),
  metafile: true,
  logLevel: "silent",
  absWorkingDir: ROOT,
} as const;

function toGraph(metafile: { inputs: Record<string, unknown>; outputs: Record<string, { imports: { path: string; external?: boolean }[] }> }): Graph {
  const inputs = Object.keys(metafile.inputs).map((p) => p.split(path.sep).join("/"));
  const externals = new Set<string>();
  for (const output of Object.values(metafile.outputs)) for (const imp of output.imports) if (imp.external) externals.add(imp.path);
  return { inputs, externals: [...externals].sort() };
}

/** The import graph of these entry files, as the worker bundle would see it. */
async function graphOf(entryPoints: string[]): Promise<Graph> {
  const result = await build({ ...BASE, entryPoints, outdir: path.join(ROOT, ".worker-no-sdk-graph") });
  return toGraph(result.metafile!);
}

/** The import graph of a planted worker file (never written to disk). */
async function graphOfPlanted(contents: string): Promise<Graph> {
  const result = await build({
    ...BASE,
    stdin: { contents, resolveDir: WORKER_DIR, sourcefile: "src/worker/planted.ts", loader: "ts" },
    outfile: path.join(ROOT, ".worker-no-sdk-graph", "planted.mjs"),
  });
  return toGraph(result.metafile!);
}

const sdkImports = (g: Graph) => g.externals.filter((e) => SDK.test(e));

describe("the worker never reaches the Anthropic SDK (Eddy 5.2, E2)", () => {
  it("finds the worker sources, including the entry build-worker.mjs bundles", () => {
    const entries = workerEntries().map((f) => path.relative(ROOT, f).split(path.sep).join("/"));
    expect(entries).toContain("src/worker/index.ts");
    expect(readFileSync(path.join(ROOT, "deploy", "build-worker.mjs"), "utf8")).toContain('entryPoints: [resolve("src/worker/index.ts")]');
  });

  it("nothing under src/worker/** imports ai-stream.ts or the SDK, directly or through any module it loads", async () => {
    const g = await graphOf(workerEntries());
    expect(g.inputs.length).toBeGreaterThan(50);
    expect(g.inputs).toContain("src/worker/index.ts");
    expect(g.inputs.filter((p) => p.endsWith("exec/ai-stream.ts"))).toEqual([]);
    expect(sdkImports(g)).toEqual([]);
  }, 60_000);

  it("the streaming gateway itself does import the SDK, so the check above would see it", async () => {
    const g = await graphOf([path.join(ROOT, STREAM_GATEWAY)]);
    expect(sdkImports(g)).toEqual(["@anthropic-ai/sdk"]);
  }, 60_000);

  it("self-test: a worker file that reaches ai-stream.ts through another module is caught", async () => {
    const g = await graphOfPlanted('import { anthropicStreamPort } from "@/lib/spend/exec/ai-stream";\nexport const port = anthropicStreamPort;\n');
    expect(g.inputs).toContain(STREAM_GATEWAY);
    expect(sdkImports(g)).toEqual(["@anthropic-ai/sdk"]);
    const lazy = await graphOfPlanted('export const later = () => import("@/lib/spend/exec/ai-stream");\n');
    expect(lazy.inputs).toContain(STREAM_GATEWAY);
  }, 60_000);

  it("self-test: Eddy's model port imports the SDK for types only, which the build erases", async () => {
    const g = await graphOfPlanted('import { eddyRoundSubjectId } from "@/lib/eddy/model";\nexport const s = eddyRoundSubjectId("turn_1", 0);\n');
    expect(g.inputs).toContain("src/lib/eddy/model.ts");
    expect(sdkImports(g)).toEqual([]);
  }, 60_000);
});
