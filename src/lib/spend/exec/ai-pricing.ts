/**
 * Model prices for AI metering (docs/EDDY-SPEC.md 5.1, 5.10). Pure: no database, no network.
 *
 * Prices are USD per million tokens, which is the same number as micro-USD per token, so a call's cost in micro-USD is
 * simply tokens x price. The table follows Eddy 5.1 (the claude-api model table, cached 2026-10-06):
 *
 *   model               input  output  cache read  5-min write  1-hour write
 *   claude-opus-5-5      4.00   20.00     0.20         5.00         8.00
 *   claude-sonnet-5-5    2.00   10.00     0.20         2.50         4.00
 *   claude-haiku-5-5     0.10    0.50     0.01         0.125        0.20
 *   fallback models (priced from usage.iterations when a server-side fallback runs):
 *   claude-opus-5        5.00   25.00     0.50         6.25        10.00
 *   claude-opus-4-8      5.00   25.00     0.50         6.25        10.00
 *   claude-sonnet-5      2.00   10.00     0.20         2.50         4.00
 *
 * The fallback rows' cache prices use the standard multipliers (read 0.1x, 5-minute write 1.25x, 1-hour write 2x of input),
 * because 5.1 lists only their input and output prices. Prices are configuration: EDDY_PRICES (JSON, the same shape as
 * DEFAULT_AI_PRICES, per model, every field required) overrides or adds models. An invalid override is ignored with a
 * warning, never half-applied. A model missing from the table is UNPRICED: callers fail closed (settleCredits in
 * src/lib/eddy/contract.ts charges the whole hold), so a pricing gap is never read as zero.
 */

export type ModelPrice = {
  /** Uncached input tokens. */
  input: number;
  output: number;
  cacheRead: number;
  /** Cache writes with the default 5-minute TTL. */
  cacheWrite5m: number;
  /** Cache writes with the 1-hour TTL (Eddy's shared tools-plus-system prefix). */
  cacheWrite1h: number;
};

export type PriceTable = Readonly<Record<string, Readonly<ModelPrice>>>;

const price = (input: number, output: number, cacheRead: number, cacheWrite5m: number, cacheWrite1h: number): Readonly<ModelPrice> =>
  Object.freeze({ input, output, cacheRead, cacheWrite5m, cacheWrite1h });

export const DEFAULT_AI_PRICES: PriceTable = Object.freeze({
  "claude-opus-5-5": price(4, 20, 0.2, 5, 8),
  "claude-sonnet-5-5": price(2, 10, 0.2, 2.5, 4),
  "claude-haiku-5-5": price(0.1, 0.5, 0.01, 0.125, 0.2),
  "claude-opus-5": price(5, 25, 0.5, 6.25, 10),
  "claude-opus-4-8": price(5, 25, 0.5, 6.25, 10),
  "claude-sonnet-5": price(2, 10, 0.2, 2.5, 4),
});

const FIELDS: readonly (keyof ModelPrice)[] = ["input", "output", "cacheRead", "cacheWrite5m", "cacheWrite1h"];
const MODEL_ID = /^claude-[a-z0-9.-]{3,60}$/;
/** A price above this is a typo (USD 1,000 per million tokens), not a model. */
const MAX_PRICE = 1_000;

export type PriceOverrideResult = { prices: PriceTable; problem: string | null };

/** Parses an EDDY_PRICES override. Any problem keeps the defaults and says what was wrong. */
export function parsePriceOverride(raw: string | undefined | null, base: PriceTable = DEFAULT_AI_PRICES): PriceOverrideResult {
  const text = (raw ?? "").trim();
  if (!text) return { prices: base, problem: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { prices: base, problem: "EDDY_PRICES is not valid JSON" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { prices: base, problem: "EDDY_PRICES must be an object of models" };
  const out: Record<string, Readonly<ModelPrice>> = { ...base };
  for (const [model, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!MODEL_ID.test(model)) return { prices: base, problem: `EDDY_PRICES has an invalid model id: ${model.slice(0, 80)}` };
    if (!value || typeof value !== "object" || Array.isArray(value)) return { prices: base, problem: `EDDY_PRICES.${model} must be an object` };
    const v = value as Record<string, unknown>;
    const fields: Partial<ModelPrice> = {};
    for (const f of FIELDS) {
      const n = v[f];
      if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > MAX_PRICE) return { prices: base, problem: `EDDY_PRICES.${model}.${f} must be a price from 0 to ${MAX_PRICE}` };
      fields[f] = n;
    }
    out[model] = Object.freeze(fields as ModelPrice);
  }
  return { prices: Object.freeze(out), problem: null };
}

let cached: { raw: string; prices: PriceTable } | null = null;

/** The live price table: the defaults with EDDY_PRICES applied. Warns once per distinct bad override. */
export function aiPrices(env: Record<string, string | undefined> = process.env, warn: (message: string) => void = console.warn): PriceTable {
  const raw = env.EDDY_PRICES ?? "";
  if (cached && cached.raw === raw) return cached.prices;
  const { prices, problem } = parsePriceOverride(raw);
  if (problem) warn(`[ai] ${problem}; using the built-in prices.`);
  cached = { raw, prices };
  return prices;
}

/** Test hook. */
export function resetAiPricesCache(): void {
  cached = null;
}

export function priceFor(model: string | null | undefined, prices: PriceTable = aiPrices()): Readonly<ModelPrice> | null {
  if (!model) return null;
  return Object.prototype.hasOwnProperty.call(prices, model) ? prices[model] : null;
}

// ===== Pricing one response's usage =====

/** The usage fields pricing reads (Anthropic's usage object and each usage.iterations entry). */
export type UsageLike = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_creation?: { ephemeral_5m_input_tokens?: number | null; ephemeral_1h_input_tokens?: number | null } | null;
  /** On an iteration: the model that served it (null or absent: the request's model). */
  model?: string | null;
  type?: string;
  iterations?: readonly UsageLike[] | null;
};

const tokens = (n: number | null | undefined): number => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

export type IterationTokens = {
  model: string | null;
  input: number;
  output: number;
  cacheRead: number;
  write5m: number;
  write1h: number;
  /** Cache writes whose TTL the response did not break down. Priced at the dearer of the two write prices (fail closed). */
  writeUnknown: number;
};

/**
 * One entry's tokens. Cache writes the response does not break down by TTL (no `cache_creation`, or a total above the
 * breakdown) are priced at the dearer write price, so a missing field never makes a call look cheaper than it was. They
 * never count as the shared prefix write, which is always a 1-hour write the response names.
 */
export function iterationTokens(u: UsageLike, requestModel: string | null): IterationTokens {
  const breakdown = u.cache_creation ?? null;
  const write5m = breakdown ? tokens(breakdown.ephemeral_5m_input_tokens) : 0;
  const write1h = breakdown ? tokens(breakdown.ephemeral_1h_input_tokens) : 0;
  const writeUnknown = Math.max(0, tokens(u.cache_creation_input_tokens) - write5m - write1h);
  return { model: u.model || requestModel, input: tokens(u.input_tokens), output: tokens(u.output_tokens), cacheRead: tokens(u.cache_read_input_tokens), write5m, write1h, writeUnknown };
}

/**
 * The entries to price: usage.iterations when present (each at its own model's prices; a compaction entry is billed but not
 * in the top-level figures), otherwise the top-level usage at the request's model.
 */
export function usageEntries(usage: UsageLike | null | undefined, requestModel: string | null): IterationTokens[] {
  if (!usage) return [];
  const its = Array.isArray(usage.iterations) ? usage.iterations : null;
  if (its && its.length > 0) return its.map((it) => iterationTokens(it, requestModel));
  return [iterationTokens(usage, requestModel)];
}

export type PricedUsage = {
  /** Everything the call cost at list prices, micro-USD. NaN when a model is unpriced. */
  totalMicroUsd: number;
  /** What the workspace pays: the total minus the platform's share of the shared prefix write. */
  workspaceMicroUsd: number;
  /** The shared 1-hour prefix write charged at the cache-read price instead (Eddy 5.10, 12.1a decision 13). */
  platformMicroUsd: number;
  /** Prefix-write tokens the platform absorbed. */
  platformPrefixTokens: number;
  priced: boolean;
  unpricedModels: string[];
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

/**
 * Prices one response. `platformPrefixWriteTokens` is how many of the 1-hour cache writes are the shared tools-plus-system
 * prefix (platformPrefixWriteTokens() in src/lib/eddy/contract.ts decides it); those tokens are charged to the workspace at
 * the cache-read price and the difference is the platform's. The share is taken from the entries in order.
 */
export function priceUsage(
  usage: UsageLike | null | undefined,
  requestModel: string | null,
  opts: { platformPrefixWriteTokens?: number; prices?: PriceTable } = {},
): PricedUsage {
  const prices = opts.prices ?? aiPrices();
  let prefixLeft = tokens(opts.platformPrefixWriteTokens);
  let total = 0;
  let platform = 0;
  let platformTokens = 0;
  const unpriced: string[] = [];
  const sums = { input: 0, output: 0, read: 0, write: 0 };
  for (const e of usageEntries(usage, requestModel)) {
    sums.input += e.input;
    sums.output += e.output;
    sums.read += e.cacheRead;
    sums.write += e.write5m + e.write1h + e.writeUnknown;
    const p = priceFor(e.model, prices);
    if (!p) {
      unpriced.push(e.model ?? "(unknown model)");
      continue;
    }
    total +=
      e.input * p.input +
      e.output * p.output +
      e.cacheRead * p.cacheRead +
      e.write5m * p.cacheWrite5m +
      e.write1h * p.cacheWrite1h +
      e.writeUnknown * Math.max(p.cacheWrite5m, p.cacheWrite1h);
    const shared = Math.min(prefixLeft, e.write1h);
    if (shared > 0) {
      prefixLeft -= shared;
      platformTokens += shared;
      platform += shared * Math.max(0, p.cacheWrite1h - p.cacheRead);
    }
  }
  const priced = unpriced.length === 0;
  return {
    totalMicroUsd: priced ? total : Number.NaN,
    workspaceMicroUsd: priced ? Math.max(0, total - platform) : Number.NaN,
    platformMicroUsd: priced ? platform : 0,
    platformPrefixTokens: priced ? platformTokens : 0,
    priced,
    unpricedModels: unpriced,
    inputTokens: sums.input,
    outputTokens: sums.output,
    cacheReadTokens: sums.read,
    cacheWriteTokens: sums.write,
  };
}
