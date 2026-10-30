/**
 * Where Eddy's ports meet production (docs/EDDY-SPEC.md 5.2, 5.10, 5.11, 9.1, 9.4, EDDY-10, EDDY-11).
 *
 * - The model port is bound to anthropicStream() in src/lib/spend/exec/ai-stream.ts, the single gateway that checks freezes,
 *   holds credits on SpendCounter and settles them (Phase 0 I9, E1, E9). Eddy's own code only sees EddyModelPort.
 * - With EDDY_FAKE_MODEL=scripted, and never in production (env-rules refuses it there, and this file checks again), the
 *   port replays e2e/fixtures/eddy/*.json instead: the Playwright suites drive the real UI and API without Anthropic.
 *   streamScripted() is the one replay engine, shared with the unit tests' fake (tests/fixtures/eddy-fake-model.ts).
 * - defaultStatusDeps() and defaultLoopDeps() wire the persistence files, the action layer, the spend bridge and the gateway.
 *   Those modules are loaded lazily, so importing this file costs nothing until a route asks for its dependencies.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { memberDailyCreditCap, readEddyConfig, type EddyConfig } from "./contract";
import { createTurnGauge, TURN_GAUGE, type ActionsApi, type LoopDeps, type ModelErrorClasses, type TurnFactsPort } from "./loop";
import { createEddyMeter, minimumRoundCredits, type HoldPrices } from "./metering";
import type { EddyFinalMessage, EddyModelPort, EddyRequest, EddyStreamOptions, GatewayCtx, StreamEvent } from "./model";
import { authFailedRecently, eddyGate, noteAuthFailure, type StatusDeps } from "./status";

// ===== The scripted model (e2e, unit tests) =====

export type ScriptedBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "tool_use"; id?: string; name: string; input: Record<string, unknown> }
  /** A server-side fallback switch in the middle of the output: the blocks before it are the declined attempt's partial. */
  | { type: "fallback" };

export type ScriptedUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } | null;
  iterations?: Record<string, unknown>[] | null;
};

/** One scripted model round. */
export type ScriptedRound = {
  content: ScriptedBlock[];
  stop_reason?: "end_turn" | "tool_use" | "max_tokens" | "refusal" | "pause_turn" | "stop_sequence";
  stop_details?: { category: string | null } | null;
  usage?: ScriptedUsage;
  /** The model that answered (a fallback model's turn as returned). */
  model?: string;
  /** A server-side fallback switched model mid-stream: a `fallback` block starts before the content. */
  fallback?: boolean;
  /** Milliseconds to wait between stream events (e2e: lets Stop and the streaming UI be seen). */
  delayMs?: number;
};

export type ScriptedScenario = { id: string; match?: string; rounds: ScriptedRound[] };
export type ScriptedFixture = { version: 1; scenarios: ScriptedScenario[] };

const DEFAULT_USAGE: Required<Omit<ScriptedUsage, "iterations" | "cache_creation">> = { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

function abortError(): Error {
  const e = new Error("The request was aborted.");
  e.name = "AbortError";
  return e;
}

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

/** Splits text into a few deltas, so the stream looks like a stream. */
function chunks(text: string, size = 24): string[] {
  const out: string[] = [];
  const chars = Array.from(text);
  for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(""));
  return out.length > 0 ? out : [""];
}

let messageCounter = 0;

/** The full usage object of a scripted round. */
export function scriptedUsage(u: ScriptedUsage | undefined): EddyFinalMessage["usage"] {
  const base = { ...DEFAULT_USAGE, ...(u ?? {}) };
  return {
    input_tokens: base.input_tokens,
    output_tokens: base.output_tokens,
    cache_read_input_tokens: base.cache_read_input_tokens,
    cache_creation_input_tokens: base.cache_creation_input_tokens,
    cache_creation: u?.cache_creation === undefined ? { ephemeral_5m_input_tokens: base.cache_creation_input_tokens, ephemeral_1h_input_tokens: 0 } : u.cache_creation,
    iterations: u?.iterations ?? null,
    fallback_credit: null,
    inference_geo: null,
    output_tokens_details: null,
    server_tool_use: null,
    service_tier: "standard",
    speed: null,
  } as unknown as EddyFinalMessage["usage"];
}

/**
 * Replays one scripted round as a stream (message_start, content blocks with deltas, message_delta, message_stop), settles
 * it through ctx.settle like the gateway does, and returns the final message. An abort stops the stream with an AbortError;
 * a round aborted after message_start is still settled for what it reported, as the gateway does (5.9).
 */
export async function streamScripted(round: ScriptedRound, params: EddyRequest, ctx: GatewayCtx, o: EddyStreamOptions, ids: { scenario: string; round: number }): Promise<EddyFinalMessage> {
  const signal = o.signal;
  const delay = round.delayMs ?? 0;
  const id = `msg_scripted_${++messageCounter}`;
  const model = round.model ?? String(params.model);
  const usage = scriptedUsage(round.usage);
  const send = async (event: Record<string, unknown>) => {
    if (signal.aborted) throw abortError();
    if (delay > 0) await wait(delay, signal);
    try {
      o.onEvent(event as unknown as StreamEvent);
    } catch {
      // A failing handler never breaks the stream (as in the gateway).
    }
  };
  const content = round.content.map((b, i) => {
    if (b.type === "text") return { type: "text", text: b.text, citations: null };
    if (b.type === "thinking") return { type: "thinking", thinking: b.thinking, signature: b.signature ?? `sig_${ids.scenario}_${ids.round}_${i}` };
    if (b.type === "fallback") return { type: "fallback", from: { model: String(params.model) }, to: { model }, trigger: { type: "refusal" } };
    return { type: "tool_use", id: b.id ?? `toolu_${ids.scenario}_${ids.round}_${i}`.replace(/[^A-Za-z0-9_-]/g, "_"), name: b.name, input: b.input };
  });
  const stop = round.stop_reason ?? (content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn");
  let started = false;
  try {
    if (signal.aborted) throw abortError();
    await send({ type: "message_start", message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } });
    started = true;
    let index = 0;
    if (round.fallback) {
      await send({ type: "content_block_start", index, content_block: { type: "fallback", from: { model: String(params.model) }, to: { model }, trigger: { type: "refusal" } } });
      await send({ type: "content_block_stop", index });
      index++;
    }
    for (const block of content) {
      if (block.type === "text") {
        await send({ type: "content_block_start", index, content_block: { type: "text", text: "", citations: null } });
        for (const piece of chunks(block.text as string)) await send({ type: "content_block_delta", index, delta: { type: "text_delta", text: piece } });
      } else if (block.type === "fallback") {
        await send({ type: "content_block_start", index, content_block: block });
      } else if (block.type === "thinking") {
        await send({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } });
        if (block.thinking) await send({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: block.thinking } });
        await send({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: block.signature } });
      } else {
        await send({ type: "content_block_start", index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } });
        await send({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
      }
      await send({ type: "content_block_stop", index });
      index++;
    }
    await send({ type: "message_delta", delta: { stop_reason: stop, stop_sequence: null, ...(stop === "refusal" ? { stop_details: round.stop_details ?? { category: null } } : {}) }, usage: { output_tokens: (usage as { output_tokens: number }).output_tokens } });
    await send({ type: "message_stop" });
  } catch (e) {
    if (started) {
      try {
        ctx.settle(usage);
      } catch {
        // Settlement of an aborted scripted round is best effort.
      }
    }
    throw e;
  }
  const message = {
    id,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: stop,
    stop_sequence: null,
    stop_details: stop === "refusal" ? { type: "refusal", category: round.stop_details?.category ?? null, explanation: null, fallback_credit_token: null, fallback_has_prefill_claim: null, recommended_model: null } : null,
    usage,
    container: null,
    context_management: null,
    diagnostics: null,
  } as unknown as EddyFinalMessage;
  ctx.settle(message.usage);
  return message;
}

type ParamMessage = { role: string; content: unknown };

/** The member's latest message and how many assistant turns followed it (the round within the turn). */
export function lastUserText(params: EddyRequest): { text: string; round: number } {
  const messages = (params.messages ?? []) as unknown as ParamMessage[];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    const text = typeof m.content === "string" ? m.content : Array.isArray(m.content) && m.content.every((b) => (b as { type?: string }).type === "text") ? (m.content as { text: string }[]).map((b) => b.text).join("") : null;
    if (text === null) continue;
    const round = messages.slice(i + 1).filter((x) => x.role === "assistant").length;
    return { text, round };
  }
  return { text: "", round: 0 };
}

/** The scenario for a member message: the first whose `match` appears in it (case-insensitive), else `default` or `*`. */
export function pickScenario(fixtures: readonly ScriptedFixture[], text: string): ScriptedScenario | null {
  const all = fixtures.flatMap((f) => f.scenarios ?? []);
  const lower = text.toLowerCase();
  return all.find((s) => s.match && s.match !== "*" && lower.includes(s.match.toLowerCase())) ?? all.find((s) => s.match === "*" || s.id === "default") ?? null;
}

/** A model port that replays fixtures (EDDY_FAKE_MODEL=scripted). */
export function scriptedModelPort(fixtures: readonly ScriptedFixture[]): EddyModelPort {
  return {
    async stream(params, ctx, o) {
      const { text, round } = lastUserText(params);
      const scenario = pickScenario(fixtures, text);
      if (!scenario || scenario.rounds.length === 0) return streamScripted({ content: [{ type: "text", text: "No scripted reply matches this message." }] }, params, ctx, o, { scenario: "none", round });
      const step = scenario.rounds[Math.min(round, scenario.rounds.length - 1)];
      return streamScripted(step, params, ctx, o, { scenario: scenario.id, round });
    },
  };
}

/** The scripted fake is on: EDDY_FAKE_MODEL=scripted, never in production. */
export function fakeModelActive(env: Record<string, string | undefined> = process.env): boolean {
  return (env.EDDY_FAKE_MODEL ?? "").trim() === "scripted" && env.NODE_ENV !== "production";
}

/** Loads every e2e/fixtures/eddy/*.json, in name order. */
export function loadScriptedFixtures(dir: string = path.join(process.cwd(), "e2e", "fixtures", "eddy")): ScriptedFixture[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json")).sort();
  } catch {
    return [];
  }
  return names.map((n) => JSON.parse(readFileSync(path.join(dir, n), "utf8")) as ScriptedFixture).filter((f) => f && Array.isArray(f.scenarios));
}

// ===== Production binding =====

let override: EddyModelPort | null = null;

/** Test hook: binds a model port (the unit tests' fake) for the routes, or null to go back to the default. */
export function overrideEddyModelPort(port: EddyModelPort | null): void {
  override = port;
}

let scripted: EddyModelPort | null = null;

/** The model port Eddy uses: the gateway, or the scripted replay outside production. */
export function eddyModelPort(env: Record<string, string | undefined> = process.env): EddyModelPort {
  if (override) return override;
  if (fakeModelActive(env)) {
    scripted ??= scriptedModelPort(loadScriptedFixtures());
    return scripted;
  }
  return {
    async stream(params, ctx, o) {
      return (await loadModules()).gateway.anthropicStream(ctx, params, o);
    },
  };
}

/** The SDK's typed error classes, from the gateway (only it may import the SDK). */
export async function modelErrorClasses(): Promise<ModelErrorClasses> {
  try {
    return (await loadModules()).gateway.sdkErrorClasses();
  } catch {
    return {};
  }
}

/** The action layer as the loop uses it. */
export async function eddyActionsApi(): Promise<ActionsApi> {
  const { actions } = await loadModules();
  return {
    propose: (principal, name, input, opts) => actions.proposeAction(principal, name, input, opts),
    describe(name) {
      const def = actions.actionByName(name);
      if (!def) return null;
      const effects = typeof def.effects === "function" ? null : def.effects;
      const isRead = !!effects && !effects.writes && actions.effectiveRisk(def.risk, effects) === "instant";
      return { titleKey: def.titleKey, isRead };
    },
    tools: (roleClass) => actions.toolsFor(roleClass, "eddy"),
    toolsetVersion: () => actions.TOOLSET_VERSION,
    principal: (input) => actions.eddyPrincipal(input),
  };
}

const toHoldPrices = (p: { input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number } | null): HoldPrices | null =>
  p ? { input: p.input, output: p.output, cacheRead: p.cacheRead, cacheWrite5m: p.cacheWrite5m, cacheWrite1h: p.cacheWrite1h } : null;

/** The modules the production dependencies use, each loaded once (lazily, so importing this file stays cheap). */
type Modules = {
  spend: typeof import("@/lib/actions/spend-bridge");
  settings: typeof import("./settings");
  conversations: typeof import("./conversations");
  actions: typeof import("@/lib/actions");
  verification: typeof import("@/lib/auth/verification");
  legal: typeof import("@/lib/legal");
  gateway: typeof import("@/lib/spend/exec/ai-stream");
  log: typeof import("@/lib/log");
};

let modules: Promise<Modules> | null = null;

function loadModules(): Promise<Modules> {
  modules ??= (async () => ({
    spend: await import("@/lib/actions/spend-bridge"),
    settings: await import("./settings"),
    conversations: await import("./conversations"),
    actions: await import("@/lib/actions"),
    verification: await import("@/lib/auth/verification"),
    legal: await import("@/lib/legal"),
    gateway: await import("@/lib/spend/exec/ai-stream"),
    log: await import("@/lib/log"),
  }))();
  modules.catch(() => {
    modules = null;
  });
  return modules;
}

/** Production status dependencies (5.11). */
export async function defaultStatusDeps(config: EddyConfig = readEddyConfig(process.env)): Promise<StatusDeps> {
  const { spend, settings, conversations, actions, verification, legal } = await loadModules();
  const workspace = actions.defaultInvokeDeps().workspace;
  return {
    config: () => config,
    aiConfigured: () => spend.isAiConfigured() || fakeModelActive(),
    platformSwitchOff: () => settings.platformSwitchOff(),
    authFailed: (now) => authFailedRecently(now),
    assertCanWrite: (tenantId) => workspace.assertCanWrite(tenantId),
    workspaceSetting: (tenantId) => settings.workspaceSetting(tenantId),
    legalVersion: legal.LEGAL.version,
    freeze: async (tenantId) => {
      const f = await spend.freezeState(tenantId);
      return { workspace: f.workspace, platform: f.platform, effective: f.effective };
    },
    gatewayFreezeCode: (tenantId) => spend.eddyGatewayFreezeCode(tenantId),
    allowance: (tenantId, now) => spend.aiHeadroom(tenantId, { now }),
    minimumRoundCredits: async (model, roleClass) => {
      const prices = toHoldPrices(spend.modelPrice(model));
      if (!prices) return 1;
      return minimumRoundCredits(prices, await settings.measuredPrefixTokens(model, roleClass), { microUsdPerCredit: config.microUsdPerCredit, tailCacheTtl: config.tailCacheTtl });
    },
    memberCreditsToday: (tenantId, userId, now, timezone) => conversations.memberCreditsSince(tenantId, userId, spend.localDayStart(now, timezone)),
    member: (userId) => settings.memberFacts(userId),
    verificationRequired: () => verification.emailVerificationRequired(),
    ownerNames: (tenantId) => workspace.namesWithRole(tenantId, "owner"),
    userPref: (tenantId, userId) => settings.userPref(tenantId, userId),
    needsYou: (actor, now) => settings.needsYouCount(actor, now),
    demo: (tenantId) => spend.isDemoWorkspace(tenantId),
    whatsapp: (tenantId) => workspace.whatsAppState(tenantId),
    clock: () => new Date(),
  };
}

/** Production loop dependencies (5.9). `facts` comes from the turn route, which may read teams, setup and visibility. */
export async function defaultLoopDeps(facts: TurnFactsPort, config: EddyConfig = readEddyConfig(process.env)): Promise<LoopDeps> {
  const { spend, settings, conversations, gateway, log: logModule } = await loadModules();
  const statusDeps = await defaultStatusDeps(config);
  const actionsApi = await eddyActionsApi();
  const errors = await modelErrorClasses();
  const log = logModule.log;
  return {
    model: eddyModelPort(),
    actions: actionsApi,
    store: conversations.PRISMA_EDDY_STORE,
    meter: createEddyMeter({
      prices: (model) => toHoldPrices(spend.modelPrice(model)),
      prefixTokens: (model, roleClass) => settings.measuredPrefixTokens(model, roleClass),
      budget: async ({ tenantId, userId, emailVerified, now }) => {
        const h = await spend.aiHeadroom(tenantId, { now });
        const used = await conversations.memberCreditsSince(tenantId, userId, spend.localDayStart(now, h.timezone));
        return { leftToday: h.leftToday, leftMonth: h.leftMonth, memberLeft: memberDailyCreditCap(config, emailVerified) - used };
      },
      settlement: (o) => gateway.createTurnMeter(o),
      config,
    }),
    clock: () => new Date(),
    gate: (actor) => eddyGate(actor, statusDeps),
    limits: conversations.TURN_LIMITERS,
    gauge: TURN_GAUGE,
    config,
    facts,
    errors,
    onAuthFailure: (now) => noteAuthFailure(now),
    notePrefixWarm: (model, roleClass) => void settings.notePrefixWarm(model, roleClass),
    log: (event, fields) => log.warn(event, fields),
  };
}

/** A fresh gauge (tests that need their own concurrency count). */
export { createTurnGauge };
