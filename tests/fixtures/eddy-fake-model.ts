/**
 * The scripted fake model of Eddy's unit tests (docs/EDDY-SPEC.md 9.1). It implements EddyModelPort and:
 * - replays scripted responses through the same engine the e2e binding uses (streamScripted in model-binding.ts): text,
 *   tool_use blocks, thinking blocks with signatures, progress-update blocks, usage with iterations (a fallback), a fallback
 *   block, and every stop reason (end_turn, tool_use, max_tokens, refusal with stop_details, pause_turn);
 * - throws the SDK's typed errors (RateLimitError, InternalServerError, APIConnectionError, AuthenticationError,
 *   PermissionDeniedError, BadRequestError, APIUserAbortError);
 * - records every request (the params object and its exact JSON) and every gateway ctx, and calls ctx.settle(usage) as the
 *   gateway does, so the per-turn settlement is the real one.
 * No network: nothing here reaches Anthropic.
 *
 * It also holds the test harness of the loop: the gate, facts, actions and meter fakes around the real store.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { InvokeOutcome, ModelTool, Principal } from "@/lib/actions";
import { EDDY_DEFAULTS, readEddyConfig, type EddyConfig, type EddyEvent, type EddyStatusDTO } from "@/lib/eddy/contract";
import type { EddyStore } from "@/lib/eddy/conversations";
import { createTurnGauge, type ActionsApi, type EddyPrincipalInput, type LoopDeps, type ModelErrorClasses, type ToolOutcome, type TurnFactsPort } from "@/lib/eddy/loop";
import { createEddyMeter, type Budget, type HoldPrices, type TurnSettlement } from "@/lib/eddy/metering";
import type { EddyFinalMessage, EddyModelPort, EddyRequest, EddyStreamOptions, GatewayCtx, StreamEvent } from "@/lib/eddy/model";
import { streamScripted, type ScriptedRound } from "@/lib/eddy/model-binding";
import type { EddyGate, StatusActor } from "@/lib/eddy/status";

// ===== Typed SDK errors =====

/** The SDK's error classes, as the loop receives them from the gateway (model-binding.ts modelErrorClasses). */
export const SDK_ERRORS: ModelErrorClasses = {
  RateLimitError: Anthropic.RateLimitError,
  InternalServerError: Anthropic.InternalServerError,
  APIConnectionError: Anthropic.APIConnectionError,
  APIConnectionTimeoutError: Anthropic.APIConnectionTimeoutError,
  AuthenticationError: Anthropic.AuthenticationError,
  PermissionDeniedError: Anthropic.PermissionDeniedError,
  BadRequestError: Anthropic.BadRequestError,
  APIUserAbortError: Anthropic.APIUserAbortError,
};

const headers = () => new Headers({ "request-id": "req_test_1" });
export const sdkError = {
  rateLimit: () => new Anthropic.RateLimitError(429, { type: "error", error: { type: "rate_limit_error", message: "rate limited" } }, "rate limited", headers()),
  overloaded: () => new Anthropic.InternalServerError(529, { type: "error", error: { type: "overloaded_error", message: "overloaded" } }, "overloaded", headers()),
  connection: () => new Anthropic.APIConnectionError({ message: "connection failed" }),
  timeout: () => new Anthropic.APIConnectionTimeoutError({ message: "timed out" }),
  auth: () => new Anthropic.AuthenticationError(401, { type: "error", error: { type: "authentication_error", message: "bad key" } }, "bad key", headers()),
  permission: () => new Anthropic.PermissionDeniedError(403, { type: "error", error: { type: "permission_error", message: "no" } }, "no", headers()),
  badRequest: () => new Anthropic.BadRequestError(400, { type: "error", error: { type: "invalid_request_error", message: "thinking block binding mismatch" } }, "invalid", headers()),
  abort: () => new Anthropic.APIUserAbortError(),
};

// ===== The fake model =====

/** One scripted step: a round to replay, an error to throw, or a function that decides from the request. */
export type FakeStep =
  | ScriptedRound
  | { throws: Error; settleUsage?: ScriptedRound["usage"] }
  | { run: (params: EddyRequest, ctx: GatewayCtx, o: EddyStreamOptions) => Promise<EddyFinalMessage> };

export type FakeModel = EddyModelPort & {
  /** Every request, deep-copied, in order. */
  requests: EddyRequest[];
  /** The exact JSON of every request's messages (byte-prefix checks). */
  messageJson: string[];
  /** The exact JSON of every request. */
  rawRequests: string[];
  ctxs: GatewayCtx[];
  /** Credits ctx.settle returned per round. */
  settled: number[];
  queue(...steps: FakeStep[]): void;
  readonly pending: number;
};

let fakeIds = 0;

export function createFakeModel(steps: FakeStep[] = [], o: { fallback?: ScriptedRound } = {}): FakeModel {
  const queue: FakeStep[] = [...steps];
  const model: FakeModel = {
    requests: [],
    messageJson: [],
    rawRequests: [],
    ctxs: [],
    settled: [],
    queue: (...more) => queue.push(...more),
    get pending() {
      return queue.length;
    },
    async stream(params, ctx, opts) {
      const raw = JSON.stringify(params);
      model.rawRequests.push(raw);
      model.messageJson.push(JSON.stringify(params.messages));
      model.requests.push(JSON.parse(raw) as EddyRequest);
      const recorded: GatewayCtx = { ...ctx, settle: (usage) => {
        const credits = ctx.settle(usage);
        model.settled.push(credits);
        return credits;
      } };
      model.ctxs.push(recorded);
      const step = queue.shift() ?? o.fallback ?? { content: [{ type: "text", text: "Done." }], stop_reason: "end_turn" };
      if ("throws" in step) {
        if (step.settleUsage) recorded.settle(step.settleUsage as never);
        throw step.throws;
      }
      if ("run" in step) return step.run(params, recorded, opts);
      return streamScripted(step, params, recorded, opts, { scenario: `fake${++fakeIds}`, round: model.requests.length - 1 });
    },
  };
  return model;
}

// ===== Rounds =====

export const text = (t: string, extra: Partial<ScriptedRound> = {}): ScriptedRound => ({ content: [{ type: "text", text: t }], stop_reason: "end_turn", ...extra });
export const toolUse = (calls: { name: string; input: Record<string, unknown>; id?: string }[], extra: Partial<ScriptedRound> = {}): ScriptedRound => ({
  content: [{ type: "thinking", thinking: "", signature: `sig_${++fakeIds}` }, { type: "text", text: "Let me check." }, ...calls.map((c) => ({ type: "tool_use" as const, name: c.name, input: c.input, ...(c.id ? { id: c.id } : {}) }))],
  stop_reason: "tool_use",
  ...extra,
});

// ===== Actions =====

export type FakeHandler = (input: Record<string, unknown>, ctx: { principal: Principal; turnId: string; toolUseId: string; signal?: AbortSignal }) => ToolOutcome | Promise<ToolOutcome>;

const TOOL_LIST: ModelTool[] = [
    { name: "get_conversation", description: "Reads one chat.", input_schema: { type: "object", properties: { conversationId: { type: "string" } }, required: ["conversationId"], additionalProperties: false }, strict: true },
    { name: "list_templates", description: "Lists templates.", input_schema: { type: "object", properties: {}, required: [], additionalProperties: false }, strict: true },
    { name: "send_text_reply", description: "Prepares a reply card.", input_schema: { type: "object", properties: { conversationId: { type: "string" }, text: { type: "string" } }, required: ["conversationId", "text"], additionalProperties: false }, strict: true, eager_input_streaming: true },
    { name: "tag_contacts", description: "Tags contacts.", input_schema: { type: "object", properties: { contactIds: { type: "array", items: { type: "string" } }, add: { type: "array", items: { type: "string" } } }, required: ["contactIds", "add"], additionalProperties: false }, strict: true },
];
export const TEST_TOOLS: readonly ModelTool[] = Object.freeze(TOOL_LIST.map((t) => Object.freeze(t)));

const READS = new Set(["get_conversation", "list_templates"]);

export const done = (result: unknown, extra: Partial<InvokeOutcome> = {}): ToolOutcome => ({ model: { status: "done", result, undoAvailable: false }, isError: false, ...extra });

export type FakeActions = ActionsApi & { calls: { name: string; input: unknown; turnId: string; toolUseId: string }[]; handlers: Record<string, FakeHandler> };

export function createFakeActions(handlers: Record<string, FakeHandler> = {}, o: { tools?: readonly ModelTool[]; toolsetVersion?: string } = {}): FakeActions {
  const api: FakeActions = {
    calls: [],
    handlers: { ...handlers },
    async propose(principal, name, input, opts) {
      api.calls.push({ name, input, turnId: opts.turnId, toolUseId: opts.toolUseId });
      const h = api.handlers[name];
      if (!h) return { model: { status: "done", result: { ok: true }, undoAvailable: false }, isError: false };
      return h(input as Record<string, unknown>, { principal, turnId: opts.turnId, toolUseId: opts.toolUseId, signal: opts.signal });
    },
    describe: (name) => ((o.tools ?? TEST_TOOLS).some((t) => t.name === name) ? { titleKey: `status.${name}`, isRead: READS.has(name) } : null),
    tools: () => o.tools ?? TEST_TOOLS,
    toolsetVersion: () => o.toolsetVersion ?? "ts_test",
    principal: (input: EddyPrincipalInput) =>
      ({
        via: "eddy",
        actor: { userId: input.actor.userId, tenantId: input.actor.tenantId, role: input.actor.role },
        principalId: `eddy:${input.actor.userId}:${input.conversationId}`,
        emailVerified: input.emailVerified,
        lang: input.lang,
        conversationId: input.conversationId,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        ...(input.toolUseId ? { toolUseId: input.toolUseId } : {}),
        ...(input.page ? { page: input.page } : {}),
      }) as Principal,
  };
  return api;
}

// ===== Gate, facts, meter =====

export function readyStatus(over: Partial<EddyStatusDTO> = {}): EddyStatusDTO {
  return {
    state: "ready",
    readOnly: false,
    canEnable: false,
    ownerNames: ["Omar"],
    allowance: { usedToday: 0, limitToday: null, usedMonth: 0, limitMonth: 500, resetsOn: null, memberUsedToday: 0, memberLimitToday: 40 },
    langPref: "auto",
    needsYou: 0,
    demo: false,
    whatsapp: "connected",
    phase: 1,
    firstUse: false,
    spendingStopped: false,
    ...over,
  };
}

export function readyGate(over: Partial<EddyGate> = {}, status: Partial<EddyStatusDTO> = {}): EddyGate {
  return {
    status: readyStatus(status),
    setting: { enabled: true, enabledById: "u_owner", enabledAt: new Date("2026-10-01T00:00:00Z"), consentVersion: "1.1", proactiveNotices: true, dailyTurnCap: null },
    member: { name: "Asha Verma", emailVerified: true },
    memberCap: 40,
    memberUsedToday: 0,
    allowance: { usedToday: 0, limitToday: null, usedMonth: 0, limitMonth: 500, leftToday: null, leftMonth: 500, todayResetsOn: "2026-10-30", monthResetsOn: "2026-11-01", timezone: "Asia/Kolkata" },
    freeze: { workspace: "none", platform: "none", effective: "none" },
    pref: null,
    verificationRequired: false,
    ...over,
  };
}

export function fakeFacts(over: Partial<TurnFactsPort> = {}): TurnFactsPort {
  return {
    verifyPage: async (_actor, page) => ({ page: page ? { ...page, verified: true } : null, status: null }),
    setup: async () => ({ percent: 67, nextStepId: "broadcast" }),
    recentNotices: async () => [],
    visibilityHash: async () => "vh_test",
    ...over,
  };
}

/** Sonnet 5.5 list prices (5.1). */
export const SONNET_PRICES: HoldPrices = { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 };

export type MeterOptions = {
  budget?: Budget;
  prefixTokens?: number | null;
  prices?: HoldPrices | null;
  /** The per-turn settlement; the real gateway's createTurnMeter by default (passed in by the test). */
  settlement: (o: { model: string; prefixTokens: number | null; tailCacheTtl: "5m" | "1h"; microUsdPerCredit: number }) => TurnSettlement;
  config?: EddyConfig;
};

export function fakeMeter(o: MeterOptions) {
  const forTurn: unknown[] = [];
  const meter = createEddyMeter({
    prices: () => (o.prices === undefined ? SONNET_PRICES : o.prices),
    prefixTokens: async () => (o.prefixTokens === undefined ? 13_000 : o.prefixTokens),
    budget: async () => o.budget ?? { leftToday: null, leftMonth: 500, memberLeft: 40 },
    settlement: o.settlement,
    config: o.config ?? testConfig(),
  });
  return {
    forTurn,
    meter: {
      async forTurn(t: Parameters<typeof meter.forTurn>[0]) {
        forTurn.push(t);
        return meter.forTurn(t);
      },
    },
  };
}

export function testConfig(over: Partial<EddyConfig> = {}): EddyConfig {
  return { ...readEddyConfig({ EDDY_ENABLED: "true" }, () => undefined), ...over };
}

/** A limiter that always allows, or refuses after `max` calls. */
export function fakeLimiter(max = Number.POSITIVE_INFINITY) {
  let n = 0;
  return { consumeShared: async () => ++n <= max, get used() {
    return n;
  } };
}

export type HarnessOptions = {
  model: FakeModel;
  actions?: FakeActions;
  store: EddyStore;
  gate?: EddyGate | ((actor: StatusActor) => Promise<EddyGate>);
  facts?: TurnFactsPort;
  meter?: LoopDeps["meter"];
  settlement?: MeterOptions["settlement"];
  clock?: () => Date;
  config?: EddyConfig;
  limits?: LoopDeps["limits"];
  gauge?: LoopDeps["gauge"];
  onAuthFailure?: LoopDeps["onAuthFailure"];
};

export function harnessDeps(o: HarnessOptions): LoopDeps {
  const config = o.config ?? testConfig();
  const gate = o.gate ?? readyGate();
  return {
    model: o.model,
    actions: o.actions ?? createFakeActions(),
    store: o.store,
    meter: o.meter ?? fakeMeter({ settlement: o.settlement ?? (() => zeroSettlement()), config }).meter,
    clock: o.clock ?? (() => new Date()),
    gate: typeof gate === "function" ? gate : async () => gate,
    limits: o.limits ?? { member: fakeLimiter(), tenant: fakeLimiter() },
    gauge: o.gauge ?? createTurnGauge(),
    config,
    facts: o.facts ?? fakeFacts(),
    errors: SDK_ERRORS,
    promptVersion: "p_test",
    ...(o.onAuthFailure ? { onAuthFailure: o.onAuthFailure } : {}),
  };
}

/** A settlement that charges nothing (tests that do not look at credits). */
export function zeroSettlement(): TurnSettlement {
  return { settle: () => 0, creditsCharged: 0, workspaceMicroUsd: 0, platformMicroUsd: 0 };
}

/** Collects the events of a turn. */
export function collector() {
  const events: EddyEvent[] = [];
  return { events, emit: (e: EddyEvent) => void events.push(e), of: <T extends EddyEvent["type"]>(type: T) => events.filter((e): e is Extract<EddyEvent, { type: T }> => e.type === type) };
}

export { EDDY_DEFAULTS };
export type { StreamEvent };
