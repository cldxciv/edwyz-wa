/**
 * Eddy's agent loop (docs/EDDY-SPEC.md 5.9, with 5.3, 5.6, 5.8, 5.10, 5.11). Every dependency comes in through LoopDeps,
 * so the loop has no database, no SDK and no spend import of its own; model-binding.ts wires the production ports and the
 * tests wire the scripted fake model (tests/fixtures/eddy-fake-model.ts).
 *
 *   1 Gate        eddyGate(actor) must be ready; otherwise an `error {state}` and no model call.
 *   2 Limits      20 turns per member per 10 min, 300 per workspace per hour, the optional dailyTurnCap, the refusal pause
 *                 (5 refusals in an hour), 2,000 characters; the process-wide gauge (EDDY_MAX_CONCURRENT_TURNS, 40)
 *                 answers `busy` before any credit hold.
 *   3 Lock        the conversation (rolled over when 5.8 says so) and EddyTurn {status:'running'}; a stale running turn is
 *                 cleared inside the request; a fresh one gives 409.
 *   4 Language    detectLanguage(text, conversation.language, pref).
 *   5 Append      the user_text and the context note.
 *   6 Rounds      at most 8 model calls, 12 tool calls, 3 new cards and 120 s; 30 credits charged per turn. Each round:
 *                 a. a worst-case hold with max_tokens sized to fit (metering.ts), refused below 2,000 tokens;
 *                 b. stream: text deltas -> `delta`, thinking progress notes -> `status`, a tool_use start -> `status {key}`;
 *                 c. the final message; settlement happens in the gateway (ctx.settle), summed over usage.iterations;
 *                 d. branch on stop_reason BEFORE persisting: end_turn, tool_use, max_tokens, refusal, pause_turn;
 *                 e. wrap-up when a limit is hit: the wrap-up note, then one round with tool_choice none.
 *   7 Finish      EddyTurn stats, the conversation's lastInputTokens / turnCount / lastMessageAt, and `end {credits}`.
 *
 * Abort (Stop, tab closed, session expired, the 150 s stream cap): request.signal aborts the stream; a tool that started
 * runs to its end and is persisted with its tool_use; the tail is repaired; the turn is `aborted`. Completed rounds are
 * charged, and the gateway charges an aborted round for what the stream reported.
 *
 * Errors are matched on the SDK's typed classes (passed in as ModelErrorClasses, since only the gateway may import the
 * SDK) and on Phase 0's error codes, never on message strings.
 */
import type { InvokeOutcome, ModelTool, Principal } from "@/lib/actions";
import { mergeSubjects, subjectIdsIn, type SubjectIds } from "@/lib/actions/subjects";
import { EDDY_DEFAULTS, safeAppPath, type EddyConfig, type EddyEvent, type EddyLang, type EddyState, type PageContext, type VerifiedPageContext } from "./contract";
import { contextNoteMessage, wrapUpMessage, type ContextFacts, type NoticeFact, type TurnRef } from "./context-note";
import type { ConversationRow, EddyStore, TurnFinish, TurnLimiter } from "./conversations";
import { errorText, tr } from "./copy/runtime";
import {
  assistantText,
  CUT_OFF_TOOL_RESULT,
  echoForm,
  errorResults,
  placeholderEntry,
  repairTail,
  runToolBatch,
  STOPPED_TOOL_RESULT,
  storedForm,
  toolResultsContent,
  toolUseIds,
  toParams,
  type MessageDisplay,
  type NewEntry,
  type ToolResult,
} from "./history";
import { translateKey } from "./i18n";
import { detectLanguage } from "./language";
import { historyWarmFor, lastPromptTokens, readMostOfPrefix, usageTotals, type EddyMeter, type EddyTurnMeter, type ToolChoiceKind, type UsageTotals } from "./metering";
import type { EddyFinalMessage, EddyModelPort, StreamEvent } from "./model";
import { EDDY_PROMPT_VERSION } from "./prompt";
import { buildEddyRequest, type EddyMessageParam } from "./request";
import type { EddyGate, StatusActor } from "./status";

// ===== Dependencies =====

/** What a tool call answers (invoke.ts proposeAction's outcome, the parts the loop uses). */
export type ToolOutcome = Pick<InvokeOutcome, "model" | "isError" | "card" | "done" | "refused" | "ui" | "subjects">;

/** The member's principal for a turn (src/lib/actions/principal.ts eddyPrincipal). */
export type EddyPrincipalInput = {
  actor: StatusActor;
  emailVerified: boolean;
  conversationId: string;
  lang: EddyLang;
  turnId?: string;
  toolUseId?: string;
  page?: VerifiedPageContext;
  sessionRef?: string | null;
  roleAtStart?: StatusActor["role"] | null;
};

/** The action layer as the loop uses it: model-binding.ts binds it to @/lib/actions; tests pass a fake. */
export type ActionsApi = {
  propose(principal: Principal, name: string, input: unknown, opts: { turnId: string; toolUseId: string; signal?: AbortSignal }): Promise<ToolOutcome>;
  /** The activity label and whether the action only reads (reads run in parallel, 5.8). Null for an unknown name. */
  describe(name: string): { titleKey: string; isRead: boolean } | null;
  /** toolsFor(roleClass, 'eddy'): frozen and sorted (4.9). */
  tools(roleClass: "agent" | "admin"): readonly ModelTool[];
  toolsetVersion(): string;
  principal(input: EddyPrincipalInput): Principal;
};

/** The SDK's typed error classes (5.11). Only the gateway imports the SDK, so model-binding.ts hands them in. */
export type ErrorClass = abstract new (...args: never[]) => Error;
export type ModelErrorClasses = {
  RateLimitError?: ErrorClass;
  InternalServerError?: ErrorClass;
  APIConnectionError?: ErrorClass;
  APIConnectionTimeoutError?: ErrorClass;
  AuthenticationError?: ErrorClass;
  PermissionDeniedError?: ErrorClass;
  BadRequestError?: ErrorClass;
  APIUserAbortError?: ErrorClass;
};

/** A process-wide count of running turns (5.9 critic): above the cap a turn gets `busy` before any credit hold. */
export type TurnGauge = { tryAcquire(max: number): boolean; release(): void; readonly active: number };

export function createTurnGauge(): TurnGauge {
  let active = 0;
  return {
    tryAcquire(max) {
      if (active >= max) return false;
      active++;
      return true;
    },
    release() {
      active = Math.max(0, active - 1);
    },
    get active() {
      return active;
    },
  };
}

/** The web instance's gauge. */
export const TURN_GAUGE: TurnGauge = createTurnGauge();

/** The facts the context note and the conversation need, read on the server (5.6, 5.8). */
export type TurnFactsPort = {
  verifyPage(actor: StatusActor, page: PageContext | null): Promise<{ page: VerifiedPageContext | null; status: string | null }>;
  setup(tenantId: string): Promise<{ percent: number; nextStepId: string | null } | null>;
  recentNotices(actor: StatusActor, since: Date): Promise<NoticeFact[]>;
  /** The member's current visibilityHash (5.8 critic). */
  visibilityHash(actor: StatusActor): Promise<string>;
  /** Template names, stripped before language detection (5.7 rule 2). */
  templateNames?(tenantId: string): Promise<string[]>;
};

export type LoopDeps = {
  model: EddyModelPort;
  actions: ActionsApi;
  store: EddyStore;
  meter: EddyMeter;
  clock: () => Date;
  gate: (actor: StatusActor) => Promise<EddyGate>;
  limits: { member: TurnLimiter; tenant: TurnLimiter };
  gauge: TurnGauge;
  config: EddyConfig;
  facts: TurnFactsPort;
  errors: ModelErrorClasses;
  promptVersion?: string;
  /** The gateway's authentication failure: Eddy is platform_off (paused) for 5 minutes. Returns true the first time. */
  onAuthFailure?: (now: Date) => boolean;
  /** Cache telemetry: the response read most of the prefix from cache. */
  notePrefixWarm?: (model: string, roleClass: string) => void;
  /** Structured logs: ids, codes and counts only, never text (7.7). */
  log?: (event: string, fields: Record<string, string | number | boolean | null>) => void;
};

// ===== Limits (5.9, 7.8) =====

export const MAX_ROUNDS_PER_TURN = EDDY_DEFAULTS.maxRoundsPerTurn;
export const MAX_TOOL_CALLS_PER_TURN = EDDY_DEFAULTS.maxToolCallsPerTurn;
export const TURN_WALL_CLOCK_MS = EDDY_DEFAULTS.turnWallClockMs;
export const MAX_MESSAGE_CHARS = EDDY_DEFAULTS.maxMessageChars;
/** 5 refusals in an hour pause Eddy for that member for an hour (5.11). */
export const REFUSALS_BEFORE_PAUSE = 5;
export const REFUSAL_WINDOW_MS = 60 * 60_000;

// ===== Turn input and result =====

export type TurnInput = {
  actor: StatusActor;
  /** The access token's session reference: G4 re-checks the very session that asked. */
  sessionId: string | null;
  text: string;
  page: PageContext | null;
  /** New chat: close the active conversation first (5.8). */
  newChat?: boolean;
  /** [Fix with Eddy] / [Explain]: an id-only reference (6.7). */
  ref?: TurnRef | null;
};

export type TurnSummary = {
  turnId: string | null;
  conversationId: string | null;
  status: TurnFinish["status"] | "refused_before_start";
  state?: EddyState;
  credits: number;
  rounds: number;
  toolCalls: number;
  cardsCreated: number;
  stopReason: string | null;
  errorCode: string | null;
};

export type PreparedTurn = {
  input: TurnInput;
  deps: LoopDeps;
  gate: EddyGate;
  conversation: ConversationRow;
  turnId: string;
  lang: EddyLang;
  roleClass: "agent" | "admin";
  startedAt: Date;
  /** The stored history, the user_text and context note already appended. */
  entries: NewEntry[];
  /** How many entries existed before this turn (a conversation with history can take a 400 rollover). */
  priorCount: number;
  page: VerifiedPageContext | null;
  facts: ContextFacts;
  released: boolean;
};

export type PrepareResult =
  | { kind: "refused"; state: EddyState; params: Record<string, string | number>; httpStatus: number }
  | { kind: "conflict" }
  | { kind: "ready"; turn: PreparedTurn };

const roleClassOf = (role: StatusActor["role"]): "agent" | "admin" => (role === "agent" ? "agent" : "admin");

function startOfLocalDay(now: Date, timeZone: string): Date {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(now);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
    const elapsed = ((get("hour") * 60 + get("minute")) * 60 + get("second")) * 1000 + now.getMilliseconds();
    return new Date(now.getTime() - elapsed);
  } catch {
    return new Date(now.getTime() - (now.getTime() % 86_400_000));
  }
}

/**
 * Steps 1 to 5: the gate, the limits, the gauge, the conversation and the turn lock, the language, and the user_text and
 * context note. A `ready` result holds a gauge slot until runPrepared() finishes (or release() is called).
 */
export async function prepareTurn(input: TurnInput, deps: LoopDeps): Promise<PrepareResult> {
  const actor = input.actor;
  const now = deps.clock();
  const refused = (state: EddyState, httpStatus = 200, params: Record<string, string | number> = {}): PrepareResult => ({ kind: "refused", state, params, httpStatus });

  // 1. Gate
  const gate = await deps.gate(actor);
  if (gate.status.state !== "ready") return refused(gate.status.state, 200, gate.status.reason ? { reason: gate.status.reason } : {});

  // 2. Limits
  const text = String(input.text ?? "").trim();
  if (!text) return refused("internal", 400, { reason: "empty" });
  if (Array.from(text).length > MAX_MESSAGE_CHARS) return refused("message_too_long");
  if ((await deps.store.refusalsSince(actor.tenantId, actor.userId, new Date(now.getTime() - REFUSAL_WINDOW_MS))) >= REFUSALS_BEFORE_PAUSE) return refused("refusal_pause");
  if (!(await deps.limits.member.consumeShared(`${actor.tenantId}:${actor.userId}`))) return refused("rate_limited", 429);
  if (!(await deps.limits.tenant.consumeShared(actor.tenantId))) return refused("rate_limited", 429);
  const cap = gate.setting.dailyTurnCap;
  if (cap && (await deps.store.tenantTurnsSince(actor.tenantId, startOfLocalDay(now, gate.allowance.timezone))) >= cap) return refused("rate_limited", 429, { reason: "daily_turn_cap" });
  if (!deps.gauge.tryAcquire(deps.config.maxConcurrentTurns)) return refused("busy", 503);

  let held = true;
  const release = () => {
    if (held) deps.gauge.release();
    held = false;
  };
  let lockedTurn: string | null = null;
  try {
    // 3. Conversation and lock
    const roleClass = roleClassOf(actor.role);
    const visibilityHash = await deps.facts.visibilityHash(actor);
    const { conversation } = await deps.store.openConversation({
      tenantId: actor.tenantId,
      userId: actor.userId,
      role: actor.role,
      roleClass,
      model: deps.config.model,
      toolsetVersion: deps.actions.toolsetVersion(),
      promptVersion: deps.promptVersion ?? EDDY_PROMPT_VERSION,
      visibilityHash,
      language: "en",
      now,
      newChat: input.newChat === true,
    });

    // 4. Language
    const pref = gate.status.langPref;
    const templateNames = deps.facts.templateNames ? await deps.facts.templateNames(actor.tenantId).catch(() => []) : [];
    const detected = detectLanguage(text, conversation.turnCount > 0 ? conversation.language : null, pref, { templateNames });
    const lang = detected.lang;

    const started = await deps.store.startTurn({ conversation, userId: actor.userId, model: deps.config.model, language: lang, now });
    if (!started.ok) {
      release();
      return { kind: "conflict" };
    }
    lockedTurn = started.turnId;

    // 5. The user_text and the context note
    const history = await deps.store.loadHistory(conversation);
    const [verified, setup, since] = await Promise.all([
      deps.facts.verifyPage(actor, input.page).catch(() => ({ page: null, status: null })),
      deps.facts.setup(actor.tenantId).catch(() => null),
      deps.store.previousTurnStart(conversation, started.turnId).catch(() => null),
    ]);
    const [notices, outcomes] = await Promise.all([
      deps.facts.recentNotices(actor, since ?? new Date(now.getTime() - 24 * 60 * 60_000)).catch(() => []),
      deps.store.cardOutcomesSince({ tenantId: actor.tenantId, userId: actor.userId, conversationId: conversation.id, since }).catch(() => []),
    ]);
    const facts: ContextFacts = {
      lang,
      unsupported: detected.unsupported,
      member: { firstName: gate.member.name, role: actor.role, emailVerified: gate.member.emailVerified, readOnly: gate.status.readOnly },
      page: verified.page,
      pageStatus: verified.status,
      setup,
      spending: { freeze: gate.freeze.effective, eddySpend: deps.config.phase >= 2 ? "on" : "off" },
      recentNotices: notices,
      cardOutcomes: outcomes,
      now,
      timezone: gate.allowance.timezone,
      phase: deps.config.phase,
      firstTurn: conversation.turnCount === 0 && history.length === 0,
      focus: input.ref ?? null,
    };
    const fresh: NewEntry[] = [
      { role: "user", kind: "user_text", content: text, display: { text, lang } },
      { role: "system", kind: "context_note", content: storedForm(contextNoteMessage(facts).content), display: null },
    ];
    await deps.store.append(conversation, started.turnId, fresh, now);
    return {
      kind: "ready",
      turn: {
        input: { ...input, text },
        deps,
        gate,
        conversation,
        turnId: started.turnId,
        lang,
        roleClass,
        startedAt: now,
        entries: [...history.map((h) => ({ role: h.role, kind: h.kind, content: h.content })), ...fresh],
        priorCount: history.length,
        page: verified.page,
        facts,
        get released() {
          return !held;
        },
        set released(v: boolean) {
          if (v) release();
        },
      },
    };
  } catch (e) {
    release();
    // Never leave the lock taken: a failure after it would otherwise refuse the member's next turns for 3 minutes.
    if (lockedTurn) {
      const at = deps.clock();
      await deps.store
        .finishTurn(lockedTurn, actor.tenantId, {
          status: "error",
          rounds: 0,
          toolCalls: 0,
          cardsCreated: 0,
          inputTokens: 0,
          cacheWriteTokens: 0,
          cacheReadTokens: 0,
          outputTokens: 0,
          costMicroUsd: 0,
          platformMicroUsd: 0,
          creditsCharged: 0,
          stopReason: null,
          refusalCategory: null,
          errorCode: "prepare_failed",
          requestIds: [],
          firstTokenMs: null,
          durationMs: at.getTime() - now.getTime(),
          endedAt: at,
        })
        .catch(() => undefined);
    }
    throw e;
  }
}

/** Gives a prepared turn's gauge slot back without running it (the client went away before the stream started). */
export function releasePrepared(turn: PreparedTurn): void {
  turn.released = true;
}

// ===== Errors =====

export type ModelErrorKind =
  | { kind: "abort" }
  | { kind: "service_down"; errorCode: "rate_limited" | "overloaded" | "connection" }
  | { kind: "auth" }
  | { kind: "bad_request"; requestId: string | null }
  | { kind: "state"; state: EddyState; errorCode: string; params?: Record<string, string | number> }
  | { kind: "internal" };

const isA = (e: unknown, cls: ErrorClass | undefined): boolean => typeof cls === "function" && e instanceof cls;

function formatResetDate(value: unknown, timeZone: string): string | null {
  const d = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  try {
    return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone }).format(d);
  } catch {
    return null;
  }
}

/**
 * The kind of a failed model call (5.11): the SDK's typed classes first, then Phase 0's codes by shape. Never message text.
 */
export function classifyModelError(e: unknown, classes: ModelErrorClasses, signal?: AbortSignal, timeZone = "Asia/Kolkata"): ModelErrorKind {
  if (signal?.aborted || isA(e, classes.APIUserAbortError) || (e as { name?: unknown } | null)?.name === "AbortError") return { kind: "abort" };
  if (isA(e, classes.RateLimitError)) return { kind: "service_down", errorCode: "rate_limited" };
  if (isA(e, classes.InternalServerError)) return { kind: "service_down", errorCode: "overloaded" };
  if (isA(e, classes.APIConnectionTimeoutError) || isA(e, classes.APIConnectionError)) return { kind: "service_down", errorCode: "connection" };
  if (isA(e, classes.AuthenticationError) || isA(e, classes.PermissionDeniedError)) return { kind: "auth" };
  if (isA(e, classes.BadRequestError)) {
    const id = (e as { requestID?: unknown }).requestID;
    return { kind: "bad_request", requestId: typeof id === "string" ? id : null };
  }
  const code = e && typeof e === "object" ? (e as { code?: unknown }).code : undefined;
  const status = e && typeof e === "object" ? (e as { status?: unknown }).status : undefined;
  if (code === "ai_quota") {
    const params = ((e as { params?: Record<string, unknown> }).params ?? {}) as Record<string, unknown>;
    const date = formatResetDate(params.resetsOn, typeof params.timezone === "string" ? params.timezone : timeZone);
    return { kind: "state", state: "allowance_used", errorCode: "ai_quota", params: { period: params.period === "day" ? "day" : "month", ...(date ? { date } : {}) } };
  }
  if (code === "spend.busy") return { kind: "state", state: "busy", errorCode: "spend_busy" };
  if (code === "spend.frozen" || code === "spend.platform_frozen") return { kind: "state", state: "paused", errorCode: String(code) };
  if (code === undefined && status === 503) return { kind: "state", state: "platform_off", errorCode: "not_configured", params: { reason: "not_configured" } };
  return { kind: "internal" };
}

// ===== Running the rounds =====

type Totals = UsageTotals & { requestIds: string[] };

const HTTP_ERROR_STATUS = (e: unknown): number | null => {
  const s = e && typeof e === "object" ? (e as { status?: unknown }).status : undefined;
  return typeof s === "number" ? s : null;
};

/** A thrown error from an action becomes a data-only failure (5.9 d): an HttpError sentence below 500, or the generic line. */
function failureFromThrow(e: unknown): ToolOutcome {
  const status = HTTP_ERROR_STATUS(e);
  const message = e instanceof Error ? e.message : "";
  if (status !== null && status < 500 && message) {
    return { model: { status: "failed", code: "error", detail: { $untrusted: "external_text", text: message.slice(0, 500) } }, isError: false };
  }
  return { model: { status: "failed", code: "internal", detail: { $untrusted: "external_text", text: "Something went wrong; nothing was changed." } }, isError: false };
}

const invalidInput = (detail: string): ToolOutcome => ({ model: { status: "failed", code: "INVALID_INPUT", detail: { $untrusted: "external_text", text: detail } }, isError: true });
const turnBudget = (): ToolOutcome => ({ model: { status: "refused", code: "turn_budget" }, isError: true });

type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: unknown };

const toolUsesOf = (content: unknown): ToolUseBlock[] =>
  (Array.isArray(content) ? content : []).filter((b): b is ToolUseBlock => !!b && typeof b === "object" && (b as { type?: unknown }).type === "tool_use" && typeof (b as { id?: unknown }).id === "string");

/** Steps 6 and 7 for a prepared turn. Never throws: every failure becomes an `error` event and a finished turn. */
export async function runPrepared(turn: PreparedTurn, emitRaw: (e: EddyEvent) => void, signal: AbortSignal): Promise<TurnSummary> {
  const { deps, input, gate } = turn;
  const actor = input.actor;
  const config = deps.config;
  const clock = deps.clock;
  let conversation = turn.conversation;
  const lang = turn.lang;
  const tools = deps.actions.tools(turn.roleClass);
  const toolNames = new Set(tools.map((t) => t.name));
  const emit = (e: EddyEvent) => {
    try {
      emitRaw(e);
    } catch {
      // The stream is gone; the turn carries on to a clean end.
    }
  };
  const log = (event: string, fields: Record<string, string | number | boolean | null>) => {
    try {
      deps.log?.(event, { turnId: turn.turnId, tenantId: actor.tenantId, ...fields });
    } catch {
      // Logging never breaks a turn.
    }
  };

  emit({ type: "turn", turnId: turn.turnId, conversationId: conversation.id, lang });

  const entries: NewEntry[] = [...turn.entries];
  let history: EddyMessageParam[] = toParams(entries);
  const lastAssistant = (() => {
    for (let i = entries.length - 1; i >= 0; i--) if (entries[i].role === "assistant") return i;
    return -1;
  })();
  let boundary = Math.max(0, lastAssistant);
  let historyTokens = conversation.lastInputTokens;
  let lastCallAt: Date | null = conversation.lastCallAt;
  let previousToolChoice: ToolChoiceKind | null = null;

  const totals: Totals = { inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0, requestIds: [] };
  let rounds = 0;
  let toolCalls = 0;
  let cards = 0;
  let wrapping = false;
  let toolChoiceNone = false;
  let maxTokensHits = 0;
  let status: TurnFinish["status"] = "done";
  let stopReason: string | null = null;
  let refusalCategory: string | null = null;
  let errorCode: string | null = null;
  let endTruncated = false;
  let firstTokenMs: number | null = null;
  let retried400 = false;
  let errorEmitted: EddyState | null = null;

  const append = async (fresh: NewEntry[]) => {
    if (fresh.length === 0) return;
    const stored = fresh.map((e) => ({ ...e, content: storedForm(e.content) }));
    await deps.store.append(conversation, turn.turnId, stored, clock());
    entries.push(...stored);
    history = [...history, ...toParams(stored)];
  };
  const fail = (state: EddyState, code: string, params?: Record<string, string | number>) => {
    status = "error";
    errorCode = code;
    errorEmitted = state;
    emit({ type: "error", state, ...(params ? { params } : {}) });
  };
  const elapsed = () => clock().getTime() - turn.startedAt.getTime();
  const startWrapUp = async () => {
    wrapping = true;
    toolChoiceNone = true;
    await append([{ role: "system", kind: "wrapup_note", content: wrapUpMessage().content, display: null }]);
  };

  let meter: EddyTurnMeter | null = null;
  try {
    meter = await deps.meter.forTurn({
      tenantId: actor.tenantId,
      userId: actor.userId,
      role: actor.role,
      emailVerified: gate.member.emailVerified || !gate.verificationRequired,
      turnId: turn.turnId,
      model: config.model,
      roleClass: turn.roleClass,
      now: turn.startedAt,
    });

    const principalFor = (toolUseId?: string) =>
      deps.actions.principal({
        actor,
        emailVerified: gate.member.emailVerified,
        conversationId: conversation.id,
        lang,
        turnId: turn.turnId,
        ...(toolUseId ? { toolUseId } : {}),
        ...(turn.page ? { page: turn.page } : {}),
        sessionRef: input.sessionId,
        roleAtStart: conversation.roleAtStart,
      });

    for (;;) {
      if (signal.aborted) {
        status = "aborted";
        break;
      }
      if (rounds >= MAX_ROUNDS_PER_TURN) {
        status = "limit";
        break;
      }
      // 30 credits charged or 120 s: wrap up instead of another full round (5.10).
      if (!wrapping && rounds > 0 && (meter.overTurnCap() || elapsed() >= TURN_WALL_CLOCK_MS)) await startWrapUp();

      // a. The hold, with max_tokens sized to fit.
      const toolChoice: ToolChoiceKind = toolChoiceNone ? "none" : "auto";
      const now = clock();
      const plan = meter.plan({
        historyTokens,
        historyWarm: historyWarmFor({ lastCallAt, now, previousToolChoice, toolChoice }),
        newContent: history.slice(boundary),
      });
      if (!plan.ok) {
        fail(plan.binding === "member" ? "user_capped" : "allowance_used", "allowance", { need: plan.need, left: plan.left });
        break;
      }
      const params = buildEddyRequest({
        model: config.model,
        maxTokens: plan.maxTokens,
        effort: config.effort,
        fallbacks: config.fallbacks,
        tools,
        messages: history,
        toolChoiceNone,
        tailCacheTtl: config.tailCacheTtl,
      });

      // b. Stream. Each round's deltas are replaced by that round's `message`; a fallback switch resets them.
      const thinking = new Map<number, string>();
      const onEvent = (ev: StreamEvent) => {
        const e = ev as unknown as { type: string; index?: number; content_block?: { type?: string; name?: string }; delta?: { type?: string; text?: string; thinking?: string } };
        if (e.type === "content_block_start") {
          const block = e.content_block ?? {};
          if (block.type === "fallback") {
            emit({ type: "reset" });
          } else if (block.type === "tool_use" && typeof block.name === "string") {
            const key = deps.actions.describe(block.name)?.titleKey;
            if (key) emit({ type: "status", key, text: translateKey(lang, key, {}, tr(lang, "working")) });
          } else if (block.type === "thinking" && typeof e.index === "number") thinking.set(e.index, "");
        } else if (e.type === "content_block_delta") {
          const d = e.delta ?? {};
          if (d.type === "text_delta" && typeof d.text === "string" && d.text.length > 0) {
            if (firstTokenMs === null) firstTokenMs = elapsed();
            emit({ type: "delta", text: d.text });
          } else if (d.type === "thinking_delta" && typeof d.thinking === "string" && typeof e.index === "number") {
            thinking.set(e.index, (thinking.get(e.index) ?? "") + d.thinking);
          }
        } else if (e.type === "content_block_stop" && typeof e.index === "number" && thinking.has(e.index)) {
          const note = (thinking.get(e.index) ?? "").trim();
          thinking.delete(e.index);
          if (note) emit({ type: "status", text: note.length > 200 ? `${note.slice(0, 199)}…` : note });
        }
      };

      let msg: EddyFinalMessage;
      try {
        msg = await deps.model.stream(params, meter.gatewayCtx(rounds, plan.holdCredits), { signal, onEvent });
      } catch (err) {
        rounds++;
        const kind = classifyModelError(err, deps.errors, signal, gate.allowance.timezone);
        if (kind.kind === "abort") {
          status = "aborted";
          break;
        }
        if (kind.kind === "bad_request") {
          log("eddy.api_400", { requestId: kind.requestId });
          // A 400 in a conversation with history is treated as a history or thinking-binding problem (5.11): close it and
          // retry the same member text once in a fresh conversation. A fresh conversation's 400 is a plain error, and so is a
          // 400 after a tool already ran in this turn: the fresh conversation would not know about it, and the model would
          // run the same writes again (a second contact, a second draft).
          if (!retried400 && turn.priorCount > 0 && toolCalls === 0) {
            retried400 = true;
            const old = conversation;
            await append(repairTail(entries));
            await deps.store.closeConversation(old, "api_400");
            const { conversation: next } = await deps.store.openConversation({
              tenantId: actor.tenantId,
              userId: actor.userId,
              role: actor.role,
              roleClass: turn.roleClass,
              model: config.model,
              toolsetVersion: deps.actions.toolsetVersion(),
              promptVersion: deps.promptVersion ?? EDDY_PROMPT_VERSION,
              visibilityHash: old.visibilityHash,
              language: lang,
              now: clock(),
            });
            await deps.store.moveTurn(turn.turnId, actor.tenantId, next.id);
            conversation = next;
            entries.length = 0;
            history = [];
            const facts: ContextFacts = { ...turn.facts, firstTurn: true, cardOutcomes: [] };
            await append([
              { role: "user", kind: "user_text", content: input.text, display: { text: input.text, lang } },
              { role: "system", kind: "context_note", content: contextNoteMessage(facts).content, display: null },
            ]);
            boundary = 0;
            historyTokens = 0;
            lastCallAt = null;
            previousToolChoice = null;
            emit({ type: "reset" });
            emit({ type: "turn", turnId: turn.turnId, conversationId: conversation.id, lang });
            emit({ type: "status", text: tr(lang, "runtime.new_chat") });
            continue;
          }
          fail("internal", "api_400");
          break;
        }
        if (kind.kind === "service_down") {
          fail("service_down", kind.errorCode);
          break;
        }
        if (kind.kind === "auth") {
          const first = deps.onAuthFailure ? deps.onAuthFailure(clock()) : true;
          if (first) log("eddy.auth_failed", {});
          fail("platform_off", "auth_failed", { reason: "paused" });
          break;
        }
        if (kind.kind === "state") {
          fail(kind.state, kind.errorCode, kind.params);
          break;
        }
        log("eddy.model_error", { error: err instanceof Error ? err.name : "unknown" });
        fail("internal", "model_error");
        break;
      }

      // c. The final message. Settlement already happened in the gateway (ctx.settle).
      rounds++;
      lastCallAt = clock();
      previousToolChoice = toolChoice;
      if (typeof msg.id === "string") totals.requestIds.push(msg.id);
      const used = usageTotals(msg.usage);
      totals.inputTokens += used.inputTokens;
      totals.cacheWriteTokens += used.cacheWriteTokens;
      totals.cacheReadTokens += used.cacheReadTokens;
      totals.outputTokens += used.outputTokens;
      historyTokens = lastPromptTokens(msg.usage);
      if (readMostOfPrefix(msg.usage, meter.prefixTokens)) deps.notePrefixWarm?.(config.model, turn.roleClass);
      stopReason = msg.stop_reason ?? null;
      boundary = history.length;

      // d. Branch on stop_reason before persisting anything.
      if (msg.stop_reason === "refusal") {
        refusalCategory = msg.stop_details?.category ?? null;
        status = "refused";
        const copy = tr(lang, "refusal");
        emit({ type: "reset" });
        emit({ type: "message", text: copy, lang });
        // The refusal's content is not appended; the tail is always repaired with the placeholder (5.9 repair).
        await append([placeholderEntry({ text: copy, lang, refusal: true })]);
        log("eddy.refusal", { category: refusalCategory });
        break;
      }

      // After a mid-stream server-side fallback, the declined attempt's thinking and tool_use blocks before the last fallback
      // block are dropped (the API's echo rule): they are never run and never sent back.
      const content = echoForm(storedForm(msg.content));
      const text = assistantText(content);
      // The contacts and chats this round names (tool inputs, and below what the tools answered), for contact erasure.
      let subjects: SubjectIds = subjectIdsIn(toolUsesOf(content).map((b) => b.input));
      // The round's final text replaces its streamed deltas (a mid-stream fallback switch never leaves stale text).
      if (text) emit({ type: "message", text, lang });
      const display: MessageDisplay = { ...(text ? { text } : {}), lang };

      if (msg.stop_reason === "tool_use" && !wrapping) {
        const uses = toolUsesOf(content);
        const room = Math.max(0, MAX_TOOL_CALLS_PER_TURN - toolCalls);
        let budgetHit = uses.length > room;
        const cardIds: string[] = [];
        const outcomes = await runToolBatch(
          uses.map((block, i) => ({
            isRead: deps.actions.describe(block.name)?.isRead === true,
            start: async (): Promise<ToolResult> => {
              if (i >= room) return toResult(block.id, turnBudget());
              toolCalls++;
              let outcome: ToolOutcome;
              if (!toolNames.has(block.name)) outcome = invalidInput(`There is no tool named ${block.name.slice(0, 64)}.`);
              else if (!block.input || typeof block.input !== "object" || Array.isArray(block.input)) outcome = invalidInput("The input must be an object.");
              else {
                try {
                  outcome = await deps.actions.propose(principalFor(block.id), block.name, block.input, { turnId: turn.turnId, toolUseId: block.id, signal });
                } catch (e) {
                  outcome = failureFromThrow(e);
                }
              }
              if (outcome.model.status === "refused" && outcome.model.code === "turn_budget") {
                budgetHit = true;
                outcome = { ...outcome, isError: true };
              } else if (outcome.isError && outcome.model.status === "failed" && outcome.model.code !== "INVALID_INPUT") {
                outcome = invalidInput(outcome.model.detail.text);
              }
              if (outcome.card) {
                cards++;
                cardIds.push(outcome.card.actionId);
                emit({ type: "card", card: outcome.card });
              }
              if (outcome.done) emit({ type: "done_action", actionId: outcome.done.actionId ?? "", summaryKey: outcome.done.summaryKey, vars: outcome.done.vars, ...(outcome.done.undoUntil ? { undoUntil: outcome.done.undoUntil } : {}) });
              if (outcome.refused && !(outcome.model.status === "refused" && outcome.model.code === "turn_budget")) {
                emit({ type: "refused_action", action: outcome.refused.action, code: outcome.refused.code, ...(outcome.refused.who?.length ? { who: outcome.refused.who } : {}) });
              }
              const intent = intentOf(outcome.ui);
              if (intent) emit(intent);
              if (outcome.subjects) subjects = mergeSubjects(subjects, outcome.subjects);
              return toResult(block.id, outcome);
            },
          })),
          { shouldStop: () => signal.aborted },
        );
        const results: ToolResult[] = outcomes.map((r, i) => r ?? { toolUseId: uses[i].id, content: STOPPED_TOOL_RESULT, isError: true });
        // Every tool_use pairs with a result; ids the model gave twice (or no id) still get one each.
        const covered = new Set(results.map((r) => r.toolUseId));
        for (const id of toolUseIds(content)) if (!covered.has(id)) results.push({ toolUseId: id, content: STOPPED_TOOL_RESULT, isError: true });
        await append([
          { role: "assistant", kind: "assistant", content, display: { ...display, ...(cardIds.length ? { cardIds } : {}) }, ...subjects },
          { role: "user", kind: "tool_results", content: toolResultsContent(results), display: null, ...subjects },
        ]);
        if (signal.aborted) {
          status = "aborted";
          break;
        }
        // e. Wrap up when a limit is reached; the last of the 8 calls is always the wrap-up.
        if (budgetHit || toolCalls >= MAX_TOOL_CALLS_PER_TURN || rounds >= MAX_ROUNDS_PER_TURN - 1 || meter.overTurnCap() || elapsed() >= TURN_WALL_CLOCK_MS) await startWrapUp();
        continue;
      }

      if (msg.stop_reason === "max_tokens") {
        maxTokensHits++;
        const pending = toolUseIds(content);
        await append([
          { role: "assistant", kind: "assistant", content, display, ...subjects },
          ...(pending.length > 0 ? [{ role: "user" as const, kind: "tool_results" as const, content: toolResultsContent(errorResults(pending, CUT_OFF_TOOL_RESULT)), display: null }] : []),
        ]);
        if (maxTokensHits >= 2 || wrapping) {
          status = "truncated";
          fail("truncated", "max_tokens");
          status = "truncated";
          break;
        }
        if (pending.length === 0) {
          // The reply was cut off with nothing to recover from: no request may end on an assistant turn (no prefill).
          status = "truncated";
          endTruncated = true;
          break;
        }
        toolChoiceNone = true;
        continue;
      }

      if (msg.stop_reason === "pause_turn") {
        await append([{ role: "assistant", kind: "assistant", content, display, ...subjects }]);
        continue;
      }

      // end_turn (and anything else, including a tool_use the wrap-up round produced anyway).
      const pending = toolUseIds(content);
      await append([
        { role: "assistant", kind: "assistant", content, display, ...subjects },
        ...(pending.length > 0 ? [{ role: "user" as const, kind: "tool_results" as const, content: toolResultsContent(errorResults(pending, CUT_OFF_TOOL_RESULT)), display: null }] : []),
      ]);
      status = wrapping ? "limit" : "done";
      break;
    }
  } catch (err) {
    log("eddy.turn_failed", { error: err instanceof Error ? err.name : "unknown" });
    if (!errorEmitted) fail("internal", "turn_failed");
    status = signal.aborted ? "aborted" : "error";
  }

  // Tail repair: every note followed by an assistant turn, every tool_use paired with a result (5.8).
  try {
    const fixes = repairTail(entries);
    if (fixes.length > 0) await append(fixes);
  } catch (err) {
    log("eddy.tail_repair_failed", { error: err instanceof Error ? err.name : "unknown" });
  }

  const ended = clock();
  const credits = meter?.creditsCharged ?? 0;
  const finish: TurnFinish = {
    status,
    rounds,
    toolCalls,
    cardsCreated: cards,
    inputTokens: totals.inputTokens,
    cacheWriteTokens: totals.cacheWriteTokens,
    cacheReadTokens: totals.cacheReadTokens,
    outputTokens: totals.outputTokens,
    costMicroUsd: (meter?.workspaceMicroUsd ?? 0) + (meter?.platformMicroUsd ?? 0),
    platformMicroUsd: meter?.platformMicroUsd ?? 0,
    creditsCharged: credits,
    stopReason,
    refusalCategory,
    errorCode,
    requestIds: totals.requestIds,
    firstTokenMs,
    durationMs: ended.getTime() - turn.startedAt.getTime(),
    endedAt: ended,
  };
  try {
    await deps.store.finishTurn(turn.turnId, actor.tenantId, finish);
    await deps.store.touchConversation(conversation, {
      ...(rounds > 0 ? { lastInputTokens: historyTokens } : {}),
      ...(lastCallAt ? { lastCallAt } : {}),
      language: lang,
      turnCountDelta: 1,
      title: input.text.slice(0, 120),
      now: ended,
    });
  } catch (err) {
    log("eddy.finish_failed", { error: err instanceof Error ? err.name : "unknown" });
  } finally {
    releasePrepared(turn);
  }
  emit({ type: "end", credits, ...(endTruncated ? { truncated: true } : {}) });
  return {
    turnId: turn.turnId,
    conversationId: conversation.id,
    status,
    ...(errorEmitted ? { state: errorEmitted } : {}),
    credits,
    rounds,
    toolCalls,
    cardsCreated: cards,
    stopReason,
    errorCode,
  };
}

function toResult(toolUseId: string, outcome: ToolOutcome): ToolResult {
  return { toolUseId, content: JSON.stringify(outcome.model), ...(outcome.isError ? { isError: true } : {}) };
}

/** A UI hint as an `intent` event; navigation only to allowlisted /app paths (12.1a decision 0). */
function intentOf(ui: ToolOutcome["ui"]): EddyEvent | null {
  if (!ui) return null;
  if (ui.kind === "navigate") {
    const path = safeAppPath(ui.path);
    return path ? { type: "intent", kind: "navigate", payload: { path, labelKey: ui.labelKey } } : null;
  }
  if (ui.kind === "composer_draft") return { type: "intent", kind: "composer_draft", payload: { conversationId: ui.conversationId, text: ui.text } };
  if (ui.kind === "intent") return { type: "intent", kind: ui.intent, payload: ui.payload ?? {} };
  return null;
}

/** The whole turn (5.9): prepare, then run. Refusals before the turn are an `error` event and an `end`. */
export async function runTurn(input: TurnInput & { signal: AbortSignal; emit: (e: EddyEvent) => void }, deps: LoopDeps): Promise<TurnSummary> {
  const prepared = await prepareTurn(input, deps);
  if (prepared.kind !== "ready") {
    const state: EddyState = prepared.kind === "conflict" ? "turn_in_progress" : prepared.state;
    const params = prepared.kind === "refused" ? prepared.params : {};
    try {
      input.emit({ type: "error", state, ...(Object.keys(params).length ? { params } : {}) });
      input.emit({ type: "end", credits: 0 });
    } catch {
      // The stream is gone.
    }
    return { turnId: null, conversationId: null, status: "refused_before_start", state, credits: 0, rounds: 0, toolCalls: 0, cardsCreated: 0, stopReason: null, errorCode: state };
  }
  return runPrepared(prepared.turn, input.emit, input.signal);
}

/** The sentence for a refusal before the turn, in the member's language (the route's JSON answers). */
export function refusalText(lang: EddyLang, state: EddyState, params: Record<string, string | number> = {}): string {
  return errorText(lang, state, params);
}

