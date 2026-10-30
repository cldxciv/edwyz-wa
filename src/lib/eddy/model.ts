/**
 * The port through which Eddy's loop calls the model (docs/EDDY-SPEC.md 5.2, 5.10; Phase 0 requests E1 and E9).
 *
 * Interface only. Production binds it to anthropicStream() in src/lib/spend/exec/ai-stream.ts, the single gateway that checks
 * freezes, reserves AI credits on SpendCounter and settles them (bypass rules I9, B2, B2b). Tests and e2e bind the scripted
 * fake model (tests/fixtures/eddy-fake-model.ts), which env-rules refuses in production.
 *
 * The SDK import below is TYPE-ONLY (`import type`): TypeScript erases it, so no runtime code, and nothing in the worker
 * bundle, reaches @anthropic-ai/sdk through this file. ai-stream.ts stays its only runtime importer.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages";
import type { Actor } from "@/lib/tenancy";

/** One round's request body (built in src/lib/eddy/request.ts, 5.3): beta messages stream params. */
export type EddyRequest = BetaMessageStreamParams;
/** A raw stream event as the gateway forwards it. */
export type StreamEvent = Anthropic.Beta.Messages.BetaRawMessageStreamEvent;
/** The final message of a round (stream.finalMessage()). */
export type EddyFinalMessage = Anthropic.Beta.Messages.BetaMessage;
/** Usage of a round, summed over usage.iterations when a server-side fallback ran. */
export type EddyUsage = Anthropic.Beta.Messages.BetaUsage;

/**
 * What the gateway needs for one call (5.10). There is no SpendActor here: the gateway builds it from `requestedBy`, so no
 * Eddy file builds a user actor (Phase 0 B14, request E9).
 */
export type GatewayCtx = {
  tenantId: string;
  feature: "eddy";
  requestedBy: { userId: string; role: Actor["role"] };
  /** Worst-case credits to hold for this call (5.10). */
  credits: number;
  /** Becomes UsageLedger refType / refId. */
  ref: { type: "eddy_turn"; id: string };
  /** Unique per open ai_call reservation: `<turnId>:<round>`, or `<turnId>:screen:<n>` for the optional Haiku screen. */
  subjectId: string;
  /** Returns the credits to charge for this call's actual usage (per-turn settlement, 5.10). */
  settle: (usage: EddyUsage) => number;
};

export type EddyStreamOptions = { signal: AbortSignal; onEvent: (e: StreamEvent) => void };

export interface EddyModelPort {
  stream(params: EddyRequest, ctx: GatewayCtx, o: EddyStreamOptions): Promise<EddyFinalMessage>;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The ai_call reservation subject of a model round: `<turnId>:<round>` (E9). */
export function eddyRoundSubjectId(turnId: string, round: number): string {
  if (!ID.test(turnId) || !Number.isInteger(round) || round < 0) throw new RangeError("Invalid turn id or round.");
  return `${turnId}:${round}`;
}

/** The ai_call reservation subject of the n-th injection screen call of a turn: `<turnId>:screen:<n>` (E9). */
export function eddyScreenSubjectId(turnId: string, n: number): string {
  if (!ID.test(turnId) || !Number.isInteger(n) || n < 0) throw new RangeError("Invalid turn id or screen number.");
  return `${turnId}:screen:${n}`;
}
