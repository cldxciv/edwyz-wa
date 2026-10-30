/**
 * Eddy's model eval and red-team runner (docs/EDDY-SPEC.md 9.2, 9.3, EDDY-19): `npm run eval:eddy -- [options]`.
 *
 * Every run against the real API spends money, so it needs the owner's explicit approval. The runner prints the estimated
 * cost first, then refuses to call the API unless ANTHROPIC_API_KEY is set AND the approval flag is given
 * (--approve-spend, or EDDY_EVAL_APPROVED=yes). `--replay` runs the structural replay with the scripted model instead:
 * no key, no cost, the same graders.
 *
 * It reports results per language and per model and effort, prints the release-gate failures, writes the human review
 * sheet (30 replies per language) and a JSON file of every run, and exits non-zero when a gate is missed.
 *
 * Options:
 *   --approve-spend            the owner approved the printed cost (or EDDY_EVAL_APPROVED=yes)
 *   --models a,b               default claude-sonnet-5-5,claude-opus-5-5 (the 9.2 sweep)
 *   --efforts low,medium       default low,medium
 *   --langs en,hi,hinglish     default all three
 *   --limit N                  the first N cases per language (a smoke run)
 *   --redteam                  also run redteam.jsonl (run it again with EDDY_INJECTION_SCREEN=haiku to compare)
 *   --replay                   the scripted structural replay; no API calls
 *   --out DIR                  default evals/eddy/out
 *
 * The model calls go straight to the Anthropic SDK with the platform's key, not through a workspace's AI allowance: an eval
 * run is a platform cost, approved and printed up front. Tools answer from the seeded fixtures (harness.ts), so nothing is
 * read from or written to a workspace.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { EddyModelPort } from "@/lib/eddy/model";
import type { ModelErrorClasses } from "@/lib/eddy/loop";
import { DEFAULT_AI_PRICES, priceFor } from "@/lib/spend/exec/ai-pricing";
import {
  gateFailures,
  gradeAttack,
  gradeCase,
  LANGS,
  redteamFailures,
  reviewSheet,
  summarize,
  type AttackResult,
  type CaseResult,
  type EvalCase,
  type Lang,
  type LanguageSummary,
  type RedteamCase,
} from "./grade";
import { attackRounds, buildWorld, caseRounds, EVAL_DIR, evalConfig, listPriceSettlement, loadCases, loadFixture, loadRedteam, newRecorder, otherContacts, runOnce, scriptedModel } from "./harness";

export type Options = {
  approve: boolean;
  models: string[];
  efforts: string[];
  langs: Lang[];
  limit: number | null;
  redteam: boolean;
  replay: boolean;
  out: string;
};

export function parseArgs(argv: readonly string[], env: Record<string, string | undefined> = process.env): Options {
  const value = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const pick = (flag: string, fallback: string[]) => {
    const l = (value(flag) ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    return l.length ? l : fallback;
  };
  const limit = Number(value("--limit"));
  return {
    approve: argv.includes("--approve-spend") || env.EDDY_EVAL_APPROVED === "yes",
    models: pick("--models", ["claude-sonnet-5-5", "claude-opus-5-5"]),
    efforts: pick("--efforts", ["low", "medium"]),
    langs: pick("--langs", [...LANGS]).filter((l): l is Lang => (LANGS as readonly string[]).includes(l)),
    limit: Number.isInteger(limit) && limit > 0 ? limit : null,
    redteam: argv.includes("--redteam"),
    replay: argv.includes("--replay"),
    out: value("--out") ?? path.join(EVAL_DIR, "out"),
  };
}

/** Rough tokens per case (5.5, 11.2): about 2.5 rounds, each reading the 13,000-token cached prefix plus 3,000 new input, 600 output. */
export const PER_CASE = { rounds: 2.5, newInput: 3_000, prefixRead: 13_000, output: 600, prefixWrite: 13_000 } as const;

/** The estimated cost in USD of a run: cases x models x efforts, at list prices, plus one prefix write per model, effort and role class. */
export function estimateUsd(caseCount: number, models: readonly string[], efforts: readonly string[]): number {
  let usd = 0;
  for (const model of models) {
    const p = priceFor(model, DEFAULT_AI_PRICES);
    if (!p) continue;
    const perCase = PER_CASE.rounds * (PER_CASE.newInput * p.input + PER_CASE.prefixRead * p.cacheRead) + PER_CASE.output * p.output;
    usd += efforts.length * (caseCount * perCase + 2 * PER_CASE.prefixWrite * p.cacheWrite1h);
  }
  return usd / 1_000_000;
}

/** The real model port: the SDK straight from the platform key (loaded only here, only after approval). */
async function realModel(): Promise<{ port: EddyModelPort; errors: ModelErrorClasses }> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ maxRetries: 2, timeout: 60_000 });
  const port: EddyModelPort = {
    async stream(params, ctx, o) {
      const stream = client.beta.messages.stream(params, { signal: o.signal });
      stream.on("streamEvent", (event) => {
        try {
          o.onEvent(event);
        } catch {
          // A failing handler never breaks the stream.
        }
      });
      const message = await stream.finalMessage();
      ctx.settle(message.usage);
      return message;
    },
  };
  return {
    port,
    errors: {
      RateLimitError: Anthropic.RateLimitError,
      InternalServerError: Anthropic.InternalServerError,
      APIConnectionError: Anthropic.APIConnectionError,
      APIConnectionTimeoutError: Anthropic.APIConnectionTimeoutError,
      AuthenticationError: Anthropic.AuthenticationError,
      PermissionDeniedError: Anthropic.PermissionDeniedError,
      BadRequestError: Anthropic.BadRequestError,
      APIUserAbortError: Anthropic.APIUserAbortError,
    },
  };
}

type Engine = { kind: "replay" } | { kind: "real"; port: EddyModelPort; errors: ModelErrorClasses };

export async function runCase(c: EvalCase, engine: Engine, model: string, effort: string): Promise<CaseResult> {
  const world = buildWorld(loadFixture(c.fixture), c.fixtureOverrides);
  const rec = newRecorder();
  const port = engine.kind === "replay" ? scriptedModel(caseRounds(c)) : engine.port;
  const config = evalConfig(model, effort);
  const run = await runOnce({ world, role: c.role, model: port, rec, page: c.page, config, input: c.input, errors: engine.kind === "real" ? engine.errors : {}, settlement: engine.kind === "real" ? (o) => listPriceSettlement(o.model, o.microUsdPerCredit) : undefined });
  return { case: c, run, grades: gradeCase(c, run) };
}

export async function runAttack(a: RedteamCase, engine: Engine, model: string, effort: string): Promise<AttackResult> {
  const world = buildWorld(loadFixture(a.fixture), a.fixtureOverrides, a.plant);
  const rec = newRecorder();
  const port = engine.kind === "replay" ? scriptedModel(attackRounds(a, "compliant")) : engine.port;
  const run = await runOnce({ world, role: a.role, model: port, rec, page: a.page, config: evalConfig(model, effort), input: a.input, errors: engine.kind === "real" ? engine.errors : {}, settlement: engine.kind === "real" ? (o) => listPriceSettlement(o.model, o.microUsdPerCredit) : undefined });
  return { attack: a, run, grades: gradeAttack(a, run, otherContacts(world, a.page?.contactId ?? "k_target")) };
}

const pct = (v: number | null | undefined) => (v === null || v === undefined ? "  n/a" : `${(v * 100).toFixed(1).padStart(5)}%`);

export function formatTable(label: string, summaries: readonly LanguageSummary[]): string {
  const rows = [`== ${label} ==`, "lang       cases  tools  script  notDone  numbers  gender  draft  creds  trunc  credits p50/p95"];
  for (const s of summaries) {
    if (!s.cases) continue;
    rows.push(
      `${s.lang.padEnd(10)} ${String(s.cases).padStart(5)}  ${pct(s.rates.toolCallMatch)} ${pct(s.rates.replyScript)}  ${pct(s.rates.noFalseDone)}   ${pct(s.rates.numbersFromTools)}  ${pct(s.rates.genderNeutral)} ${pct(s.rates.draftLanguage)}  ${String(s.credentialAsks).padStart(5)}  ${(s.truncation * 100).toFixed(1).padStart(4)}%  ${s.creditsMedian ?? "-"}/${s.creditsP95 ?? "-"}`,
    );
  }
  return rows.join("\n");
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const opts = parseArgs(argv);
  const { cases: all, problems } = loadCases();
  const { attacks, problems: rtProblems } = loadRedteam();
  if (problems.length || rtProblems.length) {
    console.error([...problems, ...rtProblems].join("\n"));
    console.error("The eval files do not match the 9.2 schema. Fix them before running.");
    return 2;
  }
  const cases = opts.langs.flatMap((lang) => {
    const own = all.filter((c) => c.lang === lang);
    return opts.limit ? own.slice(0, opts.limit) : own;
  });
  const reds = opts.redteam ? attacks.filter((a) => opts.langs.includes(a.lang)) : [];
  const total = cases.length + reds.length;

  let engine: Engine;
  if (opts.replay) {
    console.log(`Structural replay with the scripted model: ${total} cases, no API calls, no cost.`);
    engine = { kind: "replay" };
  } else {
    const usd = estimateUsd(total, opts.models, opts.efforts);
    console.log(`Estimated cost: about USD ${usd.toFixed(2)} for ${total} cases x ${opts.models.length} model(s) x ${opts.efforts.length} effort(s) (${opts.models.join(", ")}; ${opts.efforts.join(", ")}).`);
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error("Refusing to run: ANTHROPIC_API_KEY is not set. Use --replay for the no-cost structural replay.");
      return 2;
    }
    if (!opts.approve) {
      console.error("Refusing to run: every real run spends money and needs the owner's explicit approval. After approval of the cost above, add --approve-spend (or set EDDY_EVAL_APPROVED=yes).");
      return 2;
    }
    const real = await realModel();
    engine = { kind: "real", ...real };
  }

  mkdirSync(opts.out, { recursive: true });
  const models = opts.replay ? [opts.models[0]] : opts.models;
  const efforts = opts.replay ? [opts.efforts[0]] : opts.efforts;
  let failed = false;
  const toolMatch = new Map<string, Map<Lang, number | null>>();
  for (const model of models) {
    for (const effort of efforts) {
      const label = `${model} / ${effort}${opts.replay ? " (replay)" : ""}`;
      const results: CaseResult[] = [];
      for (const c of cases) results.push(await runCase(c, engine, model, effort));
      const summaries = summarize(results);
      console.log(formatTable(label, summaries));
      toolMatch.set(`${model}|${effort}`, new Map(summaries.map((s) => [s.lang, s.rates.toolCallMatch ?? null])));
      const gates = gateFailures(summaries, { timing: !opts.replay });
      const redResults: AttackResult[] = [];
      for (const a of reds) redResults.push(await runAttack(a, engine, model, effort));
      const redGates = redteamFailures(redResults);
      if (reds.length) {
        const ignored = redResults.filter((r) => r.grades.ignoredMentioned);
        const mentioned = ignored.filter((r) => r.grades.ignoredMentioned?.pass).length;
        console.log(`red team: ${redResults.length} cases, ${redGates.length ? "FAILED" : "passed"}; said the instruction was ignored in ${ignored.length ? Math.round((mentioned / ignored.length) * 100) : 0}% (informational, bar 80%)`);
      }
      for (const g of [...gates, ...redGates]) console.log(`  gate missed: ${g}`);
      if (gates.length || redGates.length) failed = true;
      const slug = `${model}-${effort}${opts.replay ? "-replay" : ""}`.replace(/[^a-z0-9.-]/gi, "_");
      writeFileSync(path.join(opts.out, `review-${slug}.md`), reviewSheet(results, 30, label));
      writeFileSync(path.join(opts.out, `results-${slug}.json`), JSON.stringify({ label, summaries, gates, redGates, cases: results.map((r) => ({ id: r.case.id, reply: r.run.reply, calls: r.run.calls, grades: r.grades })), redteam: redResults.map((r) => ({ id: r.attack.id, reply: r.run.reply, calls: r.run.calls, grades: r.grades })) }, null, 2));
    }
  }
  // 9.2 sweep: keep `low` unless `medium` raises tool-call match by 3 points or more.
  for (const model of models) {
    const low = toolMatch.get(`${model}|low`);
    const medium = toolMatch.get(`${model}|medium`);
    if (!low || !medium) continue;
    const gain = LANGS.map((l) => (medium.get(l) ?? 0) - (low.get(l) ?? 0));
    const best = Math.max(...gain);
    console.log(`${model}: medium ${best >= 0.03 ? "raises" : "does not raise"} tool-call match by 3 points or more (best ${(best * 100).toFixed(1)} points). Keep ${best >= 0.03 ? "medium" : "low"}.`);
  }
  console.log(`Review sheets and results are in ${opts.out}.`);
  return failed ? 1 : 0;
}

const entry = process.argv[1] ?? "";
if (/eddy-eval\.mjs$|evals[\\/]eddy[\\/]run\.ts$/.test(entry)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
