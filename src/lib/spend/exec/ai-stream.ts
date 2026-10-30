/**
 * Eddy's streaming entry point to the AI gateway (docs/EDDY-SPEC.md 5.2, 5.10; Phase 0 requests E1, E2 and E9).
 *
 * This is the ONLY file that imports the Anthropic SDK at runtime (bypass rule B2b), and the worker never imports it
 * (tests/worker-no-sdk.test.ts). It shares ai.ts's freeze check, the lock-free reserveAi() and the settlement:
 *
 *   1. checks freezes as ai.ts does (feature `eddy` keeps working under "Stop all spending": a person asked);
 *   2. builds the gateway's SpendActor ITSELF from `requestedBy` (E9), so no Eddy file builds a user actor (B14);
 *   3. holds ctx.credits through the SpendCounter conditional UPDATE plus a SpendReservation `ai_call` whose subject is
 *      ctx.subjectId (`<turnId>:<round>`, or `<turnId>:screen:<n>`), with a 3-minute ttl;
 *   4. streams with `client.beta.messages.stream()` and forwards every raw event, then awaits `finalMessage()`;
 *   5. settles `ctx.settle(usage)` credits, writing UsageLedger with refType `eddy_turn`, the tokens and the model. A
 *      settle that cannot price the call FAILS CLOSED: the whole hold is charged and `eddy.unpriced_model` is logged;
 *   6. releases the hold when the call fails. An abort (Stop, tab closed) settles what the stream reported: the input
 *      tokens of message_start plus an estimate of the output streamed so far.
 *
 * createTurnMeter() is the per-turn settlement of 5.10 that Eddy's loop passes as ctx.settle: it sums usage.iterations at
 * each model's prices, charges the shared 1-hour prefix write at the cache-read price, keeps the difference as the
 * platform's cost (EddyTurn.platformMicroUsd, 12.1a decision 13), and rounds per turn, not per call.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessage, BetaRawMessageStreamEvent } from "@anthropic-ai/sdk/resources/beta/messages";
import { EDDY_DEFAULTS, platformPrefixWriteTokens, settleCredits, UnpricedCostError } from "@/lib/eddy/contract";
import type { EddyFinalMessage, EddyModelPort, EddyRequest, EddyStreamOptions, EddyUsage, GatewayCtx } from "@/lib/eddy/model";
import { describeError } from "@/lib/safe-error";
import { HttpError } from "@/lib/tenancy";
import type { SpendActor, SpendRole } from "@/lib/spend/types";
import { AI_STREAM_TTL_MS, isAiConfigured, reserveAi, type AiHold } from "./ai";
import { priceUsage, usageEntries, type PriceTable, type UsageLike } from "./ai-pricing";

export const ANTHROPIC_MAX_RETRIES = 2;
export const ANTHROPIC_TIMEOUT_MS = 60_000;

let client: Anthropic | null = null;

/** One SDK client per process: `new Anthropic({ maxRetries: 2, timeout: 60_000 })` (5.2). */
function sdk(): Anthropic {
  client ??= new Anthropic({ maxRetries: ANTHROPIC_MAX_RETRIES, timeout: ANTHROPIC_TIMEOUT_MS });
  return client;
}

/** Test hook: the next call builds a new client. */
export function resetAnthropicClient(): void {
  client = null;
}

const ROLES: readonly SpendRole[] = ["owner", "admin", "agent"];
const SUBJECT = /^[A-Za-z0-9_-]{1,64}:(?:screen:)?\d{1,6}$/;

/** E9: the gateway, not Eddy, turns the member who asked into the SpendActor. */
function actorFor(requestedBy: GatewayCtx["requestedBy"]): SpendActor {
  if (!requestedBy || typeof requestedBy.userId !== "string" || !requestedBy.userId || !ROLES.includes(requestedBy.role as SpendRole)) {
    throw new RangeError("An Eddy call needs the member who asked for it.");
  }
  return { type: "user", userId: requestedBy.userId, role: requestedBy.role as SpendRole };
}

function checkCtx(ctx: GatewayCtx): void {
  if (ctx.feature !== "eddy") throw new RangeError("anthropicStream is for Eddy's calls.");
  if (!ctx.tenantId) throw new RangeError("An Eddy call needs a workspace.");
  if (!SUBJECT.test(ctx.subjectId ?? "")) throw new RangeError("An Eddy call needs a subject of the form <turnId>:<round> or <turnId>:screen:<n>.");
  if (ctx.ref?.type !== "eddy_turn" || !ctx.ref.id) throw new RangeError("An Eddy call needs its turn as the usage reference.");
  if (typeof ctx.settle !== "function") throw new RangeError("An Eddy call needs a settle function.");
  if (!Number.isFinite(ctx.credits) || ctx.credits < 0) throw new RangeError("An Eddy call needs a credit hold of zero or more.");
}

function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true;
  const AbortClass = (Anthropic as unknown as { APIUserAbortError?: new (...args: never[]) => Error }).APIUserAbortError;
  if (typeof AbortClass === "function" && error instanceof AbortClass) return true;
  return (error as { name?: unknown } | null)?.name === "APIUserAbortError" || (error as { name?: unknown } | null)?.name === "AbortError";
}

const utf8 = (s: string) => Buffer.byteLength(s, "utf8");

/**
 * Output tokens a stream produced before it was cut off: what the stream reported, or, when more text arrived than that,
 * about one token per 3 bytes of the streamed text, thinking notes and tool input (conservative for Devanagari).
 */
export function estimateStreamedOutputTokens(snapshot: Pick<BetaMessage, "content" | "usage"> | null | undefined): number {
  if (!snapshot) return 0;
  let bytes = 0;
  for (const block of (snapshot.content ?? []) as unknown as Record<string, unknown>[]) {
    if (typeof block.text === "string") bytes += utf8(block.text);
    if (typeof block.thinking === "string") bytes += utf8(block.thinking);
    if (block.input !== undefined && block.input !== null) bytes += utf8(JSON.stringify(block.input));
  }
  const reported = Math.max(0, Math.floor(snapshot.usage?.output_tokens ?? 0));
  return Math.max(reported, Math.ceil(bytes / 3));
}

/** The usage an aborted stream is charged for: the reported usage with the output estimate. */
export function abortedUsage(snapshot: BetaMessage): EddyUsage {
  return { ...snapshot.usage, output_tokens: estimateStreamedOutputTokens(snapshot) } as EddyUsage;
}

async function settleRound(hold: AiHold, ctx: GatewayCtx, usage: EddyUsage, model: string | null): Promise<number> {
  let credits: number;
  try {
    const c = ctx.settle(usage);
    if (typeof c !== "number" || !Number.isFinite(c) || c < 0) throw new UnpricedCostError();
    credits = Math.ceil(c);
  } catch (error) {
    // Anthropic has already billed this call: never release it as 0 credits (5.10 repair).
    credits = settleCredits(null, ctx.credits).credits;
    console.error(`[eddy] eddy.unpriced_model model=${model ?? "unknown"} subject=${ctx.subjectId}: ${describeError(error)}`);
  }
  await hold.settle({ credits, ref: ctx.ref, usage: { inputTokens: usage?.input_tokens ?? null, outputTokens: usage?.output_tokens ?? null, model } });
  return credits;
}

/**
 * One streamed model round for Eddy through the gateway. Throws the SDK's typed errors unchanged (Eddy's loop matches
 * on the classes, 5.11), 402 ai_quota when the AI limit is used up, and 503 when no API key is configured.
 */
export async function anthropicStream(ctx: GatewayCtx, params: EddyRequest, opts: EddyStreamOptions): Promise<EddyFinalMessage> {
  checkCtx(ctx);
  if (!isAiConfigured()) throw new HttpError(503, "AI is not configured.");
  const actor = actorFor(ctx.requestedBy);
  const hold = await reserveAi({ tenantId: ctx.tenantId, feature: "eddy", actor, credits: ctx.credits, ref: ctx.ref, subjectId: ctx.subjectId }, { ttlMs: AI_STREAM_TTL_MS });
  let stream: ReturnType<Anthropic["beta"]["messages"]["stream"]>;
  try {
    stream = sdk().beta.messages.stream(params, { signal: opts.signal });
  } catch (error) {
    await hold.release().catch((e) => console.warn(`[eddy] hold release failed: ${describeError(e)}`));
    throw error;
  }
  stream.on("streamEvent", (event: BetaRawMessageStreamEvent) => {
    try {
      opts.onEvent(event);
    } catch (error) {
      console.warn(`[eddy] stream event handler failed: ${describeError(error)}`);
    }
  });
  let message: EddyFinalMessage;
  try {
    message = (await stream.finalMessage()) as EddyFinalMessage;
  } catch (error) {
    const snapshot = (stream as { currentMessage?: BetaMessage }).currentMessage;
    if (isAbort(error, opts.signal) && snapshot?.usage) await settleRound(hold, ctx, abortedUsage(snapshot), snapshot.model ?? String(params.model));
    else await hold.release().catch((e) => console.warn(`[eddy] hold release failed: ${describeError(e)}`));
    throw error;
  }
  await settleRound(hold, ctx, message.usage, message.model ?? String(params.model));
  return message;
}

/** The production binding of Eddy's model port (src/lib/eddy/model.ts). */
export const anthropicStreamPort: EddyModelPort = {
  stream: (params, ctx, o) => anthropicStream(ctx, params, o),
};

/** A constructor of one of the SDK's error classes. */
export type SdkErrorClass = abstract new (...args: never[]) => Error;

/**
 * The SDK's typed error classes, so Eddy's loop can match on classes (5.11: never on message strings) without importing the
 * SDK itself (bypass rule B2b). Read lazily, so a test that mocks the SDK only pays for the classes it provides.
 */
export function sdkErrorClasses(): Record<"RateLimitError" | "InternalServerError" | "APIConnectionError" | "APIConnectionTimeoutError" | "AuthenticationError" | "PermissionDeniedError" | "BadRequestError" | "APIUserAbortError", SdkErrorClass | undefined> {
  const sdkClasses = Anthropic as unknown as Record<string, SdkErrorClass | undefined>;
  const pick = (name: string): SdkErrorClass | undefined => (typeof sdkClasses[name] === "function" ? sdkClasses[name] : undefined);
  return {
    RateLimitError: pick("RateLimitError"),
    InternalServerError: pick("InternalServerError"),
    APIConnectionError: pick("APIConnectionError"),
    APIConnectionTimeoutError: pick("APIConnectionTimeoutError"),
    AuthenticationError: pick("AuthenticationError"),
    PermissionDeniedError: pick("PermissionDeniedError"),
    BadRequestError: pick("BadRequestError"),
    APIUserAbortError: pick("APIUserAbortError"),
  };
}

// ===== Per-turn settlement (5.10) =====

export type TurnMeterOptions = {
  /** The conversation's model (EDDY_MODEL); a call on another model uses settleFor(model). */
  model: string;
  /** Measured tools-plus-system prefix (`eddy:prefix-tokens:<model>:<roleClass>`), or null when unknown. */
  prefixTokens: number | null;
  tailCacheTtl?: "5m" | "1h";
  microUsdPerCredit?: number;
  prices?: PriceTable;
};

export type TurnMeter = {
  /** ctx.settle for a round on the turn's model: the credits to charge now (at least 0). Throws UnpricedCostError. */
  settle: (usage: EddyUsage | UsageLike) => number;
  /** ctx.settle for a call on another model inside the same turn (the optional Haiku screen). */
  settleFor: (model: string) => (usage: EddyUsage | UsageLike) => number;
  /**
   * A round whose model has no price (a server-side fallback to a model missing from ai-pricing) is charged its whole hold by
   * the gateway; this records that charge too, so the turn's and the member's caps count it (EddyTurn.creditsCharged).
   */
  chargeUnpriced: (credits: number) => void;
  readonly creditsCharged: number;
  /** What the workspace's calls cost this turn, micro-USD (rounded). */
  readonly workspaceMicroUsd: number;
  /** The shared prefix writes the platform absorbed this turn, micro-USD (rounded): EddyTurn.platformMicroUsd. */
  readonly platformMicroUsd: number;
};

/**
 * callMicro = sum over usage.iterations (or the top-level usage) of input x P_in + 5-min writes x P_write5m
 *             + 1-hour writes x P_write1h + cache reads x P_read + output x P_out, each entry at its own model's prices,
 *             with the shared prefix's 1-hour write charged at P_read (the rest is the platform's);
 * credits    = ceil((turnMicroSoFar + callMicro) / perCredit) - creditsChargedSoFar, at least 0.
 */
export function createTurnMeter(o: TurnMeterOptions): TurnMeter {
  const per = o.microUsdPerCredit ?? EDDY_DEFAULTS.microUsdPerCredit;
  if (!Number.isSafeInteger(per) || per < 1) throw new RangeError("microUsdPerCredit must be a positive whole number.");
  const tailCacheTtl = o.tailCacheTtl ?? EDDY_DEFAULTS.tailCacheTtl;
  let workspace = 0;
  let platform = 0;
  let charged = 0;
  const settleAt = (model: string) => (usage: EddyUsage | UsageLike): number => {
    const u = usage as UsageLike;
    const entries = usageEntries(u, model);
    const write1h = entries.reduce((n, e) => n + e.write1h, 0);
    const read = entries.reduce((n, e) => n + e.cacheRead, 0);
    const shared = platformPrefixWriteTokens({ ephemeral1hInputTokens: write1h, cacheReadInputTokens: read }, { tailCacheTtl, prefixTokens: o.prefixTokens });
    const priced = priceUsage(u, model, { platformPrefixWriteTokens: shared, prices: o.prices });
    if (!priced.priced) throw new UnpricedCostError();
    workspace += priced.workspaceMicroUsd;
    platform += priced.platformMicroUsd;
    // Float sums of prices are rounded to a thousandth of a micro-USD before the credit rounding.
    const micro = Math.round(workspace * 1000) / 1000;
    const total = Math.max(0, Math.ceil(micro / per - 1e-9));
    const credits = Math.max(0, total - charged);
    charged += credits;
    return credits;
  };
  return {
    settle: settleAt(o.model),
    settleFor: (model: string) => settleAt(model),
    chargeUnpriced(credits: number) {
      const c = Number.isFinite(credits) && credits > 0 ? Math.ceil(credits) : 0;
      charged += c;
      workspace += c * per;
    },
    get creditsCharged() {
      return charged;
    },
    get workspaceMicroUsd() {
      return Math.round(workspace);
    },
    get platformMicroUsd() {
      return Math.round(platform);
    },
  };
}
