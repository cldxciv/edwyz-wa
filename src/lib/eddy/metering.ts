/**
 * Eddy's AI metering on top of Phase 0 (docs/EDDY-SPEC.md 5.10). No database and no SDK here: the figures come in through
 * MeterDeps (model-binding.ts wires Phase 0's AI headroom through the spend bridge, the measured prefix through settings.ts,
 * and the gateway's per-turn settlement, createTurnMeter() in src/lib/spend/exec/ai-stream.ts).
 *
 * Worst case for one call, in micro-USD (prices P from 5.1, USD per million tokens = micro-USD per token):
 *
 *   hold = prefixTokens   x P_read                                   the shared prefix write is the platform's (12.1a d13)
 *        + historyTokens  x (historyWarm ? P_read : P_write)          P_write is the tail's TTL price (5 min, or 1 h)
 *        + newTokensUpper x P_write                                    newTokensUpper = ceil(utf8 bytes of the new content / 2)
 *        + max_tokens     x P_out
 *
 *   holdCredits = ceil(hold / EDDY_MICROUSD_PER_CREDIT)
 *
 * historyWarm means the conversation's last call was under 5 minutes ago AND this round sends the same tool_choice as the
 * previous one: the wrap-up and max_tokens recovery rounds (tool_choice none) are always held cold.
 *
 * max_tokens is EDDY_MAX_TOKENS (8,000) reduced so the hold fits the smaller of the AI headroom left today and this month
 * and the member's daily cap. Below the floor of 2,000 the round is refused with allowance.needs {need, left}.
 *
 * Settlement is per turn, not per call (the gateway calls ctx.settle, the TurnMeter rounds once per turn). On top of
 * Phase 0's limits: 40 credits per member a day (10 with an unverified email where verification is required) and 30 credits
 * charged per turn, after which the turn wraps up instead of starting another round.
 */
import { EDDY_DEFAULTS, microUsdToCredits, type EddyConfig } from "./contract";
import { eddyRoundSubjectId, type EddyUsage, type GatewayCtx } from "./model";

/** Prices of one model, USD per million tokens (the same numbers as micro-USD per token). */
export type HoldPrices = { input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number };

/** Until count_tokens has measured the prefix (5.5), the hold assumes this many prefix tokens (above both role classes). */
export const FALLBACK_PREFIX_TOKENS = 20_000;
/** A conversation's cache is warm when its last call was this recent (5-minute tail). */
export const HISTORY_WARM_MS = 5 * 60_000;

export type ToolChoiceKind = "auto" | "none";

export type HoldInput = {
  prefixTokens: number | null;
  historyTokens: number;
  historyWarm: boolean;
  newTokensUpper: number;
  maxTokens: number;
  prices: HoldPrices;
  tailCacheTtl?: "5m" | "1h";
};

const whole = (n: number | null | undefined) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

/** The worst case of one call in micro-USD (5.10). */
export function holdMicroUsd(h: HoldInput): number {
  const write = (h.tailCacheTtl ?? EDDY_DEFAULTS.tailCacheTtl) === "1h" ? h.prices.cacheWrite1h : h.prices.cacheWrite5m;
  const prefix = h.prefixTokens === null || !Number.isFinite(h.prefixTokens) || h.prefixTokens <= 0 ? FALLBACK_PREFIX_TOKENS : Math.floor(h.prefixTokens);
  return prefix * h.prices.cacheRead + whole(h.historyTokens) * (h.historyWarm ? h.prices.cacheRead : write) + whole(h.newTokensUpper) * write + whole(h.maxTokens) * h.prices.output;
}

/** holdCredits = ceil(hold / perCredit), with the float sums of prices rounded to a thousandth of a micro-USD first. */
export function holdCreditsFor(h: HoldInput, microUsdPerCredit: number = EDDY_DEFAULTS.microUsdPerCredit): number {
  const micro = Math.round(holdMicroUsd(h) * 1000) / 1000;
  return microUsdToCredits(Math.ceil(micro - 1e-9), microUsdPerCredit);
}

/** UTF-8 bytes of new content (conservative for Devanagari, 3 bytes a character). */
export function utf8Bytes(content: unknown): number {
  const text = typeof content === "string" ? content : JSON.stringify(content ?? "");
  return Buffer.byteLength(text ?? "", "utf8");
}

/** newTokensUpper = ceil(utf8Bytes(new content) / 2). */
export function newTokensUpper(content: unknown): number {
  return Math.ceil(utf8Bytes(content) / 2);
}

/** historyWarm: the last call under 5 minutes ago, and the same tool_choice as that call (5.10 repair). */
export function historyWarmFor(o: { lastCallAt: Date | null; now: Date; previousToolChoice: ToolChoiceKind | null; toolChoice: ToolChoiceKind }): boolean {
  if (!o.lastCallAt) return false;
  if (o.previousToolChoice !== null && o.previousToolChoice !== o.toolChoice) return false;
  if (o.previousToolChoice === null && o.toolChoice !== "auto") return false;
  const age = o.now.getTime() - o.lastCallAt.getTime();
  return age >= 0 && age < HISTORY_WARM_MS;
}

/** What one round may use: AI headroom (null: no limit set) and the member's daily cap, all in credits. */
export type Budget = { leftToday: number | null; leftMonth: number | null; memberLeft: number };

export type BudgetLimit = { credits: number | null; binding: "today" | "month" | "member" | null };

/** The smallest of the headroom left today, this month, and the member's cap, after what this turn has charged. */
export function roundBudget(b: Budget, chargedThisTurn: number): BudgetLimit {
  const charged = Math.max(0, Math.floor(chargedThisTurn));
  const candidates: [number, BudgetLimit["binding"]][] = [];
  if (b.leftToday !== null) candidates.push([b.leftToday - charged, "today"]);
  if (b.leftMonth !== null) candidates.push([b.leftMonth - charged, "month"]);
  candidates.push([b.memberLeft - charged, "member"]);
  let best: BudgetLimit = { credits: null, binding: null };
  for (const [credits, binding] of candidates) if (best.credits === null || credits < best.credits) best = { credits: Math.max(0, Math.floor(credits)), binding };
  return best;
}

export type RoundPlan =
  | { ok: true; maxTokens: number; holdCredits: number; holdMicroUsd: number }
  | { ok: false; need: number; left: number; binding: BudgetLimit["binding"] };

/**
 * Sizes max_tokens down so the hold fits the budget (5.10), never above EDDY_MAX_TOKENS and never below the floor of 2,000.
 * `budget` null means no limit applies (the gateway still enforces Phase 0's limits).
 */
export function sizeMaxTokens(h: Omit<HoldInput, "maxTokens">, budget: BudgetLimit, o: { maxTokens?: number; minTokens?: number; microUsdPerCredit?: number } = {}): RoundPlan {
  const max = Math.max(o.minTokens ?? EDDY_DEFAULTS.minTokens, Math.floor(o.maxTokens ?? EDDY_DEFAULTS.maxTokens));
  const min = o.minTokens ?? EDDY_DEFAULTS.minTokens;
  const per = o.microUsdPerCredit ?? EDDY_DEFAULTS.microUsdPerCredit;
  const credits = (maxTokens: number) => holdCreditsFor({ ...h, maxTokens }, per);
  if (budget.credits === null) return { ok: true, maxTokens: max, holdCredits: credits(max), holdMicroUsd: holdMicroUsd({ ...h, maxTokens: max }) };
  const room = budget.credits;
  if (credits(max) <= room) return { ok: true, maxTokens: max, holdCredits: credits(max), holdMicroUsd: holdMicroUsd({ ...h, maxTokens: max }) };
  // Largest max_tokens whose hold fits: solve, then step down past any float rounding.
  const fixed = holdMicroUsd({ ...h, maxTokens: 0 });
  let tokens = h.prices.output > 0 ? Math.floor((room * per - fixed) / h.prices.output) : max;
  tokens = Math.min(max, tokens);
  while (tokens >= min && credits(tokens) > room) tokens--;
  if (tokens < min) return { ok: false, need: credits(min), left: room, binding: budget.binding };
  return { ok: true, maxTokens: tokens, holdCredits: credits(tokens), holdMicroUsd: holdMicroUsd({ ...h, maxTokens: tokens }) };
}

/** The smallest hold of any round (status allowance_used, 5.11): the prefix read, a short message and 2,000 output tokens. */
export function minimumRoundCredits(prices: HoldPrices, prefixTokens: number | null, o: { microUsdPerCredit?: number; tailCacheTtl?: "5m" | "1h" } = {}): number {
  return holdCreditsFor({ prefixTokens, historyTokens: 0, historyWarm: false, newTokensUpper: 1_000, maxTokens: EDDY_DEFAULTS.minTokens, prices, tailCacheTtl: o.tailCacheTtl }, o.microUsdPerCredit);
}

// ===== Usage totals for EddyTurn =====

export type UsageTotals = { inputTokens: number; cacheWriteTokens: number; cacheReadTokens: number; outputTokens: number };

type UsageEntry = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_creation?: { ephemeral_5m_input_tokens?: number | null; ephemeral_1h_input_tokens?: number | null } | null;
};

/** One response's tokens, summed over usage.iterations when a server-side fallback ran (each entry was billed). */
export function usageTotals(usage: EddyUsage | null | undefined): UsageTotals {
  const u = usage as unknown as (UsageEntry & { iterations?: UsageEntry[] | null }) | null | undefined;
  if (!u) return { inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 };
  const entries: UsageEntry[] = Array.isArray(u.iterations) && u.iterations.length > 0 ? u.iterations : [u];
  const out: UsageTotals = { inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 };
  for (const e of entries) {
    out.inputTokens += whole(e.input_tokens);
    out.outputTokens += whole(e.output_tokens);
    out.cacheReadTokens += whole(e.cache_read_input_tokens);
    const breakdown = whole(e.cache_creation?.ephemeral_5m_input_tokens) + whole(e.cache_creation?.ephemeral_1h_input_tokens);
    out.cacheWriteTokens += Math.max(whole(e.cache_creation_input_tokens), breakdown);
  }
  return out;
}

/** The prompt size of the last entry (the call that produced the reply): what the conversation's history now costs. */
export function lastPromptTokens(usage: EddyUsage | null | undefined): number {
  const u = usage as unknown as (UsageEntry & { iterations?: UsageEntry[] | null }) | null | undefined;
  if (!u) return 0;
  const last: UsageEntry = Array.isArray(u.iterations) && u.iterations.length > 0 ? u.iterations[u.iterations.length - 1] : u;
  const write = Math.max(whole(last.cache_creation_input_tokens), whole(last.cache_creation?.ephemeral_5m_input_tokens) + whole(last.cache_creation?.ephemeral_1h_input_tokens));
  return whole(last.input_tokens) + whole(last.cache_read_input_tokens) + write;
}

/** True when the response read at least 90% of the prefix from cache (refreshes eddy:prefix-warm, telemetry only). */
export function readMostOfPrefix(usage: EddyUsage | null | undefined, prefixTokens: number | null): boolean {
  if (prefixTokens === null || prefixTokens <= 0) return false;
  return usageTotals(usage).cacheReadTokens >= prefixTokens * 0.9;
}

// ===== The per-turn meter =====

/** The gateway's per-turn settlement (createTurnMeter in ai-stream.ts) as Eddy sees it. */
export type TurnSettlement = {
  settle: (usage: EddyUsage) => number;
  /** Records a round the gateway charged its whole hold for (an unpriced model), so the caps count it. */
  chargeUnpriced?: (credits: number) => void;
  readonly creditsCharged: number;
  readonly workspaceMicroUsd: number;
  readonly platformMicroUsd: number;
};

export type MeterDeps = {
  /** Model prices (Phase 0 ai-pricing through the spend bridge); null when the model is unpriced. */
  prices(model: string): HoldPrices | null;
  /** The measured prefix (`eddy:prefix-tokens:<model>:<roleClass>`), null until measured. */
  prefixTokens(model: string, roleClass: string): Promise<number | null>;
  /** AI headroom today and this month (Phase 0 headroom('ai')) and the member's cap left today. */
  budget(t: { tenantId: string; userId: string; emailVerified: boolean; now: Date }): Promise<Budget>;
  /** The gateway's per-turn settlement. */
  settlement(o: { model: string; prefixTokens: number | null; tailCacheTtl: "5m" | "1h"; microUsdPerCredit: number }): TurnSettlement;
  config: Pick<EddyConfig, "maxTokens" | "microUsdPerCredit" | "tailCacheTtl" | "maxCreditsPerTurn">;
};

export type TurnMeterStart = {
  tenantId: string;
  userId: string;
  role: GatewayCtx["requestedBy"]["role"];
  emailVerified: boolean;
  turnId: string;
  model: string;
  roleClass: string;
  now: Date;
};

export type PlanInput = { historyTokens: number; historyWarm: boolean; newContent: unknown };

export type EddyTurnMeter = {
  readonly prefixTokens: number | null;
  readonly budget: Budget;
  /** Sizes the next round (5.10). */
  plan(r: PlanInput): RoundPlan;
  /** The gateway ctx of a round: requestedBy (never a SpendActor, B14), ref eddy_turn, subject <turnId>:<round>. */
  gatewayCtx(round: number, holdCredits: number): GatewayCtx;
  /** The turn has been charged EDDY_MAX_CREDITS_PER_TURN or more: wrap up instead of another round. */
  overTurnCap(): boolean;
  readonly creditsCharged: number;
  readonly workspaceMicroUsd: number;
  readonly platformMicroUsd: number;
};

export type EddyMeter = { forTurn(t: TurnMeterStart): Promise<EddyTurnMeter> };

export class UnpricedModelError extends Error {
  constructor(public model: string) {
    super("The Eddy model has no price, so no hold can be computed.");
    this.name = "UnpricedModelError";
  }
}

export function createEddyMeter(deps: MeterDeps): EddyMeter {
  const config = deps.config;
  return {
    async forTurn(t) {
      const prices = deps.prices(t.model);
      if (!prices) throw new UnpricedModelError(t.model);
      const [prefixTokens, budget] = await Promise.all([deps.prefixTokens(t.model, t.roleClass).catch(() => null), deps.budget({ tenantId: t.tenantId, userId: t.userId, emailVerified: t.emailVerified, now: t.now })]);
      const settlement = deps.settlement({ model: t.model, prefixTokens, tailCacheTtl: config.tailCacheTtl, microUsdPerCredit: config.microUsdPerCredit });
      return {
        prefixTokens,
        budget,
        plan(r) {
          const limit = roundBudget(budget, settlement.creditsCharged);
          // The loop passes the last prompt's size, which includes the tools-plus-system prefix the hold already prices on
          // its own: only what follows the prefix is history. Unmeasured, nothing is taken off (the conservative side).
          const historyTokens = prefixTokens !== null && prefixTokens > 0 ? Math.max(0, r.historyTokens - prefixTokens) : r.historyTokens;
          return sizeMaxTokens(
            { prefixTokens, historyTokens, historyWarm: r.historyWarm, newTokensUpper: newTokensUpper(r.newContent), prices, tailCacheTtl: config.tailCacheTtl },
            limit,
            { maxTokens: config.maxTokens, microUsdPerCredit: config.microUsdPerCredit },
          );
        },
        gatewayCtx(round, holdCredits) {
          return {
            tenantId: t.tenantId,
            feature: "eddy",
            requestedBy: { userId: t.userId, role: t.role },
            credits: holdCredits,
            ref: { type: "eddy_turn", id: t.turnId },
            subjectId: eddyRoundSubjectId(t.turnId, round),
            settle: (usage) => {
              try {
                return settlement.settle(usage);
              } catch (error) {
                // The gateway charges the whole hold for an unpriced round (5.10 repair): the turn meter counts it too.
                settlement.chargeUnpriced?.(holdCredits);
                throw error;
              }
            },
          };
        },
        overTurnCap: () => settlement.creditsCharged >= config.maxCreditsPerTurn,
        get creditsCharged() {
          return settlement.creditsCharged;
        },
        get workspaceMicroUsd() {
          return settlement.workspaceMicroUsd;
        },
        get platformMicroUsd() {
          return settlement.platformMicroUsd;
        },
      };
    },
  };
}
