/**
 * The model's toolsets (docs/EDDY-SPEC.md 4.9). toolsFor(roleClass, 'eddy') turns the registry into Anthropic tool
 * definitions `{name, description, input_schema, strict: true}`, sorted by name:
 * - only actions on the surface whose minRole the role class meets (the owner uses the admin set; there are no owner-only
 *   v1 tools), and v2 actions only in phase 2, so Eddy never offers what the member cannot do;
 * - strict tool use rejects string, number and array-size constraints (minLength, maxLength, minimum, maximum, maxItems)
 *   and this layer does not rely on pattern support, so those move into the property's description; invoke.ts still
 *   validates the full schema before anything runs (G3);
 * - `eager_input_streaming: true` only on the four long-text tools;
 * - the output depends on nothing but the registry and the phase, so it is byte-identical for every tenant and member of a
 *   role class and the cached prefix is shared across the platform.
 * TOOLSET_VERSION hashes both sets; it is stored on each conversation and a change starts a new one.
 *
 * The wire shape is declared here instead of imported from @anthropic-ai/sdk: only the AI gateway may import the SDK
 * (Phase 0 bypass rule B2b).
 */
import { readEddyConfig } from "@/lib/eddy/contract";
import { canonicalJson, sha256Hex } from "./canonical";
import { listActions, onRegistryChange, registryGeneration, type AnyActionDef } from "./registry";
import type { JsonSchema } from "./schema";
import type { Role, Surface } from "./types";

export type RoleClass = "agent" | "admin";

/** The JSON Schema subset strict tool use accepts. */
export type ModelToolSchema = {
  type: JsonSchema["type"];
  description?: string;
  enum?: readonly string[];
  properties?: Record<string, ModelToolSchema>;
  required?: string[];
  additionalProperties?: false;
  items?: ModelToolSchema;
};

/** One tool definition as the Messages API takes it. */
export type ModelTool = {
  name: string;
  description: string;
  input_schema: ModelToolSchema;
  strict: true;
  eager_input_streaming?: true;
};

/** The four tools whose input is long text, streamed as it is written (4.9). */
export const EAGER_INPUT_TOOLS: readonly string[] = ["add_internal_note", "create_template_draft", "draft_reply", "send_text_reply"];

const RANK: Record<Role, number> = { agent: 1, admin: 2, owner: 3 };
const CLASS_RANK: Record<RoleClass, number> = { agent: 1, admin: 2 };

/** Owners and admins share the admin toolset (4.9). */
export function roleClassOf(role: Role): RoleClass {
  return RANK[role] >= RANK.admin ? "admin" : "agent";
}

/** The constraints strict mode does not take, as a sentence for the description. */
function constraintNote(s: JsonSchema): string | null {
  const parts: string[] = [];
  if (s.type === "string") {
    if (s.minLength !== undefined && s.maxLength !== undefined) parts.push(`${s.minLength} to ${s.maxLength} characters`);
    else if (s.minLength !== undefined) parts.push(`at least ${s.minLength} characters`);
    else if (s.maxLength !== undefined) parts.push(`at most ${s.maxLength} characters`);
    if (s.pattern) parts.push(`must match ${s.pattern}`);
  }
  if (s.type === "integer") {
    if (s.minimum !== undefined && s.maximum !== undefined) parts.push(`${s.minimum} to ${s.maximum}`);
    else if (s.minimum !== undefined) parts.push(`at least ${s.minimum}`);
    else if (s.maximum !== undefined) parts.push(`at most ${s.maximum}`);
  }
  if (s.type === "array" && s.maxItems !== undefined) parts.push(`at most ${s.maxItems} items`);
  return parts.length > 0 ? `(${parts.join("; ")})` : null;
}

/** A strict-mode schema with the unsupported constraints moved into descriptions. Keys are written in a fixed order. */
export function toStrictSchema(s: JsonSchema): ModelToolSchema {
  const note = constraintNote(s);
  const description = [s.description?.trim(), note].filter(Boolean).join(" ");
  const out: ModelToolSchema = { type: s.type };
  if (description) out.description = description;
  if (s.enum) out.enum = [...s.enum];
  if (s.type === "object") {
    const props: Record<string, ModelToolSchema> = {};
    for (const [key, child] of Object.entries(s.properties ?? {})) props[key] = toStrictSchema(child);
    out.properties = props;
    out.required = [...(s.required ?? [])];
    out.additionalProperties = false;
  }
  if (s.type === "array" && s.items) out.items = toStrictSchema(s.items);
  return out;
}

function toTool(def: AnyActionDef): ModelTool {
  const tool: ModelTool = { name: def.name, description: def.description.trim(), input_schema: toStrictSchema(def.inputSchema), strict: true };
  if (EAGER_INPUT_TOOLS.includes(def.name)) tool.eager_input_streaming = true;
  return tool;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
  }
  return value;
}

export type ToolsetOptions = {
  /** EDDY_PHASE; v2 actions are offered only in phase 2. Defaults to the platform configuration. */
  phase?: 1 | 2;
  /** Definitions to build from instead of the registry (tests). */
  defs?: readonly AnyActionDef[];
};

const memo = new Map<string, readonly ModelTool[]>();
let memoGeneration = -1;

const currentPhase = (): 1 | 2 => readEddyConfig(process.env, () => undefined).phase;

/** The toolset of a role class on a surface, sorted by name, strict, frozen. Byte-identical for every tenant. */
export function toolsFor(roleClass: RoleClass, surface: Surface = "eddy", options: ToolsetOptions = {}): readonly ModelTool[] {
  const phase = options.phase ?? currentPhase();
  const build = () =>
    deepFreeze(
      [...(options.defs ?? listActions())]
        .filter((d) => d.surfaces.includes(surface))
        .filter((d) => RANK[d.minRole] <= CLASS_RANK[roleClass])
        .filter((d) => d.version === "v1" || phase >= 2)
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .map(toTool),
    );
  if (options.defs) return build();
  if (memoGeneration !== registryGeneration()) {
    memo.clear();
    memoGeneration = registryGeneration();
  }
  const key = `${roleClass}:${surface}:${phase}`;
  let tools = memo.get(key);
  if (!tools) {
    tools = build();
    memo.set(key, tools);
  }
  return tools;
}

/** sha256 of a toolset's canonical JSON. */
export function toolsetHash(tools: readonly ModelTool[]): string {
  return sha256Hex(canonicalJson(tools));
}

/** The version stored on each Eddy conversation: a hash over the agent and admin sets of the eddy surface. */
export function toolsetVersion(options: ToolsetOptions = {}): string {
  const both = { agent: toolsFor("agent", "eddy", options), admin: toolsFor("admin", "eddy", options) };
  return `ts_${sha256Hex(JSON.stringify(both)).slice(0, 24)}`;
}

/** Live binding: always the toolsetVersion() of the current registry and phase. */
export let TOOLSET_VERSION: string = toolsetVersion();
onRegistryChange(() => {
  TOOLSET_VERSION = toolsetVersion();
});
