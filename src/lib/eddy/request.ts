/**
 * One round's request body (docs/EDDY-SPEC.md 5.3, 5.5). Pure: the loop builds every request here, so the shape is tested
 * in one place (tests/eddy-loop.test.ts, tests/eddy-prompt-cache.test.ts):
 *
 *   model           EDDY_MODEL, default claude-sonnet-5-5 (12.1a decision 1)
 *   max_tokens      sized by metering.ts (EDDY_MAX_TOKENS 8,000, down to what the AI headroom allows, floor 2,000)
 *   betas           server-side-fallback-2026-07-01, thinking-display-updates-2026-08-18, thinking-binding-controls-2026-08-01
 *   fallbacks       'default' (EDDY_FALLBACKS=off removes it and its beta)
 *   thinking        {type:'adaptive', display:'updates', block_binding:{prefix_mismatch_behavior:'drop_block'}}
 *   output_config   {effort: EDDY_EFFORT, default 'low'}
 *   tools           toolsFor(roleClass, 'eddy'): frozen per role class and sorted by name (4.9)
 *   system          one text block, the frozen prompt, cache_control {ephemeral, ttl 1h} (breakpoint 1: tools + system)
 *   cache_control   top-level automatic breakpoint on the growing tail (5 minutes; 1 hour with EDDY_TAIL_CACHE_TTL=1h)
 *   messages        the append-only history, verbatim (history.ts)
 *
 * tool_choice is omitted (auto); only the wrap-up and max_tokens recovery rounds send {type:'none'}. A forced tool_choice
 * (any, tool) is a 400 on these models and is never sent. No temperature, top_p or top_k (API 2026-10-21), and no
 * assistant prefill.
 */
import type { ModelTool } from "@/lib/actions";
import { EDDY_DEFAULTS, type EddyEffort } from "./contract";
import type { EddyRequest } from "./model";
import { EDDY_SYSTEM_PROMPT } from "./prompt";

export const BETA_SERVER_SIDE_FALLBACK = "server-side-fallback-2026-07-01";
export const BETA_THINKING_DISPLAY = "thinking-display-updates-2026-08-18";
export const BETA_THINKING_BINDING = "thinking-binding-controls-2026-08-01";
/** The betas every Eddy request carries, in this order. */
export const EDDY_BETAS: readonly string[] = [BETA_SERVER_SIDE_FALLBACK, BETA_THINKING_DISPLAY, BETA_THINKING_BINDING];

/** One message of the history, as the API takes it (user, assistant, or a mid-conversation system note). */
export type EddyMessageParam = EddyRequest["messages"][number];

export type BuildRequestInput = {
  model: string;
  maxTokens: number;
  effort?: EddyEffort;
  /** EDDY_FALLBACKS: false removes `fallbacks` and its beta. */
  fallbacks?: boolean;
  tools: readonly ModelTool[];
  messages: readonly EddyMessageParam[];
  /** The wrap-up round and the max_tokens recovery round: tool_choice {type:'none'}. */
  toolChoiceNone?: boolean;
  /** EDDY_TAIL_CACHE_TTL. */
  tailCacheTtl?: "5m" | "1h";
  /** The system prompt; defaults to the frozen EDDY_SYSTEM_PROMPT (tests pass their own only to check placement). */
  system?: string;
};

/** The system blocks: the frozen prompt with the 1-hour breakpoint on the last (only) block. */
export function systemBlocks(system: string = EDDY_SYSTEM_PROMPT): NonNullable<EddyRequest["system"]> {
  return [{ type: "text", text: system, cache_control: { type: "ephemeral", ttl: "1h" } }];
}

/** Builds one round's request (5.3). The history array is passed through as is: never copied out of order or edited. */
export function buildEddyRequest(input: BuildRequestInput): EddyRequest {
  const fallbacks = input.fallbacks ?? EDDY_DEFAULTS.fallbacks;
  const betas = fallbacks ? [...EDDY_BETAS] : EDDY_BETAS.filter((b) => b !== BETA_SERVER_SIDE_FALLBACK);
  const tail = input.tailCacheTtl ?? EDDY_DEFAULTS.tailCacheTtl;
  const params: EddyRequest = {
    model: input.model,
    max_tokens: Math.floor(input.maxTokens),
    betas,
    ...(fallbacks ? { fallbacks: "default" as const } : {}),
    thinking: { type: "adaptive", display: "updates", block_binding: { prefix_mismatch_behavior: "drop_block" } },
    output_config: { effort: input.effort ?? EDDY_DEFAULTS.effort },
    // The registry's strict tool definitions are the API's tool shape; they are declared in the action layer because only
    // the gateway may import the SDK's types (bypass rule B2b).
    tools: input.tools as unknown as NonNullable<EddyRequest["tools"]>,
    system: systemBlocks(input.system),
    cache_control: tail === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" },
    messages: input.messages as EddyMessageParam[],
    ...(input.toolChoiceNone ? { tool_choice: { type: "none" as const } } : {}),
  };
  return params;
}

/** The fields that must never be sent (5.1: API 2026-10-21 refuses them, and forced tool_choice is a 400). */
export const FORBIDDEN_REQUEST_FIELDS: readonly string[] = ["temperature", "top_p", "top_k"];

/** Problems with a built request, as sentences (empty when it follows 5.3); used by tests and by the fake model. */
export function requestProblems(params: EddyRequest): string[] {
  const p = params as unknown as Record<string, unknown>;
  const problems: string[] = [];
  for (const f of FORBIDDEN_REQUEST_FIELDS) if (f in p) problems.push(`${f} must not be sent`);
  const choice = p.tool_choice as { type?: string } | undefined;
  if (choice && choice.type !== "none") problems.push(`tool_choice ${String(choice.type)} is forced`);
  const system = p.system as { cache_control?: { ttl?: string } }[] | undefined;
  if (!Array.isArray(system) || system.length === 0 || system[system.length - 1]?.cache_control?.ttl !== "1h") problems.push("the last system block needs cache_control ttl 1h");
  if (!p.cache_control) problems.push("the top-level cache_control is missing");
  const messages = (p.messages ?? []) as { role?: string }[];
  if (messages.length > 0 && messages[0].role === "system") problems.push("messages[0] is a system note");
  messages.forEach((m, i) => {
    if (m.role !== "system") return;
    const before = messages[i - 1];
    const after = messages[i + 1];
    if (!before || before.role !== "user") problems.push(`system note ${i} does not follow a user message`);
    if (after && after.role !== "assistant") problems.push(`system note ${i} is followed by ${after.role}, not an assistant turn`);
  });
  return problems;
}
