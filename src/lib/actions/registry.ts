/**
 * The one action registry (docs/EDDY-SPEC.md 4.1, 4.2). ACTIONS is frozen and sorted by name. It starts empty: the v1
 * definitions package (src/lib/actions/defs) registers its definitions once at load with registerActions(), and the
 * registry refuses to load when any rule of 4.2 is broken:
 * - a static risk below deriveRisk(effects);
 * - an action that can be `undoable` without `undo` (unless it is the undo action itself);
 * - an action that can be `confirm` without `preview` (dynamic effects and automation-starting writes can become cards);
 * - a `returnsSecret` action on the `eddy` surface;
 * - a v1 action that can spend from `messaging` or `ads`;
 * - names that are duplicated, not sorted or not tool names;
 * plus the structural checks every tool needs (a strict input schema, known editable fields, a sane undo window).
 * Nothing here calls a definition's run: invoke.ts is the only caller.
 *
 * The v1 definitions (src/lib/actions/defs, EDDY-05) are imported here and registered once, at the end of this module, so
 * every importer of the registry sees the same frozen list. The definition files load their services lazily, so this pulls
 * in no service module, prisma or the Graph transport.
 */
import { UNDO_WINDOW_MS } from "@/lib/eddy/contract";
import { V1_DEFINITIONS } from "./defs";
import { RiskFloorError, assertRiskFloor, deriveRisk } from "./risk";
import { strictSchemaProblems } from "./schema";
import type { ActionCtx, ActionDef, AutomationEvent, Effects, Risk, Surface, UndoRecord } from "./types";

/**
 * Undo as invoke.ts reads it: the ActionDef undo plus three optional hooks (4.2a, 4.5). `automationEvents` lists the
 * automation events the inverse would emit (an undo that starts a rule becomes a card or is refused); `inverseArgs` gives
 * the arguments of `inverseAction` when the inverse is itself a card (resume a broadcast, turn an automation back on);
 * `authorize` is the route-equivalent guard of the inverse (gate G9 of the undo), throwing the route's HttpError.
 */
export type UndoSpec = NonNullable<ActionDef["undo"]> & {
  automationEvents?(ctx: ActionCtx, u: UndoRecord): Promise<AutomationEvent[]>;
  inverseArgs?(u: UndoRecord): Record<string, unknown>;
  authorize?(ctx: ActionCtx, u: UndoRecord): Promise<void>;
};

/** A definition as definitions packages write it: an ActionDef whose undo may carry the UndoSpec hooks. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ActionDefinition<A extends Record<string, unknown> = any, R = any> = Omit<ActionDef<A, R>, "undo"> & { undo?: UndoSpec };

/** The registry's own view of a definition: argument and result types erased. */
export type AnyActionDef = ActionDefinition;

export const ACTION_NAME = /^[a-z][a-z0-9_]{2,63}$/;
const SURFACES: readonly Surface[] = ["eddy", "mcp", "api", "system"];
const RISKS: readonly Risk[] = ["instant", "undoable", "confirm"];

export class RegistryLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryLoadError";
  }
}

const isDynamic = (def: AnyActionDef) => typeof def.effects === "function";

/** What a definition can run at: its static risk, or "confirm" when its effects can change at run time. */
function possibleRisks(def: AnyActionDef): Set<Risk> {
  if (isDynamic(def)) {
    const floor = def.risk ?? "instant";
    // Dynamic effects can raise the risk to anything at or above the declared floor.
    return new Set(RISKS.slice(RISKS.indexOf(floor)));
  }
  const fixed = assertRiskFloor(def.name, def.risk, def.effects as Effects);
  const out = new Set<Risk>([fixed]);
  // A write that can start an automation becomes a card when an enabled rule would message customers (4.2a).
  if (def.automationEvents) out.add("confirm");
  return out;
}

/** The first problem with one definition, or null. */
export function definitionProblem(def: AnyActionDef): string | null {
  const name = typeof def?.name === "string" ? def.name : "(unnamed)";
  if (!ACTION_NAME.test(name)) return `Action name "${name}" must match ${ACTION_NAME} (it is the tool name).`;
  if (def.version !== "v1" && def.version !== "v2") return `Action ${name} needs version v1 or v2.`;
  if (!Array.isArray(def.surfaces) || def.surfaces.length === 0) return `Action ${name} must list at least one surface.`;
  if (def.surfaces.some((s) => !SURFACES.includes(s))) return `Action ${name} lists an unknown surface.`;
  if (new Set(def.surfaces).size !== def.surfaces.length) return `Action ${name} lists a surface twice.`;
  if (!def.titleKey) return `Action ${name} needs a titleKey (its activity label).`;
  if (!def.description || !def.description.trim()) return `Action ${name} needs a description for the model.`;
  if (!def.minRole) return `Action ${name} needs a minRole.`;
  if (def.route !== "virtual" && (!def.route || typeof def.route.path !== "string" || !def.route.path.startsWith("/api/"))) {
    return `Action ${name} needs a route under /api/ or "virtual".`;
  }
  if (def.risk !== undefined && !RISKS.includes(def.risk)) return `Action ${name} declares an unknown risk.`;
  const schemaProblems = strictSchemaProblems(def.inputSchema);
  if (schemaProblems.length > 0) return `Action ${name}: ${schemaProblems[0]}`;
  if (!Array.isArray(def.untrustedPaths)) return `Action ${name} must list its untrusted result paths (an empty list is fine).`;
  for (const field of def.editable ?? []) {
    if (!(field in (def.inputSchema.properties ?? {}))) return `Action ${name} lists editable field "${field}", which is not an argument.`;
  }
  if (typeof def.authorize !== "function" || typeof def.run !== "function" || typeof def.forModel !== "function") {
    return `Action ${name} needs authorize, run and forModel.`;
  }
  if (def.rateLimit && !(Number.isInteger(def.rateLimit.perPrincipalPerMin) && def.rateLimit.perPrincipalPerMin > 0)) {
    return `Action ${name} has a rate limit that is not a positive whole number.`;
  }

  let risks: Set<Risk>;
  try {
    risks = possibleRisks(def);
  } catch (e) {
    if (e instanceof RiskFloorError) return e.message;
    throw e;
  }
  if (risks.has("undoable") && !def.undo && !def.isUndo) return `Action ${name} can be undoable but declares no undo.`;
  if (risks.has("confirm") && typeof def.preview !== "function") return `Action ${name} can need a card but has no preview.`;
  if (def.isUndo && def.undo) return `Action ${name} is the undo action, so it must not declare an undo of its own.`;
  if (def.undo) {
    const w = def.undo.windowMs;
    if (!(Number.isInteger(w) && w > 0 && w <= UNDO_WINDOW_MS)) return `Action ${name} has an undo window outside 1 ms to 15 minutes.`;
    if (typeof def.undo.stillApplies !== "function" || typeof def.undo.inverse !== "function") return `Action ${name} needs undo.stillApplies and undo.inverse.`;
    if (def.undo.inverseAction !== undefined && !ACTION_NAME.test(def.undo.inverseAction)) return `Action ${name} names an invalid inverseAction.`;
    for (const hook of ["automationEvents", "inverseArgs", "authorize"] as const) {
      if (def.undo[hook] !== undefined && typeof def.undo[hook] !== "function") return `Action ${name} has an undo.${hook} that is not a function.`;
    }
    if (def.undo.inverseAction !== undefined && def.undo.inverseArgs === undefined) return `Action ${name} undoes through ${def.undo.inverseAction} but gives no inverseArgs for its card.`;
  }

  if (!isDynamic(def)) {
    const e = def.effects as Effects;
    if (e.returnsSecret && def.surfaces.includes("eddy")) return `Action ${name} returns a secret, so it cannot be on the eddy surface.`;
    if (def.version === "v1" && (e.spends === "messaging" || e.spends === "ads")) return `Action ${name} is v1 but spends from ${e.spends}; spending actions are v2 only.`;
    if (deriveRisk(e) === "confirm" && typeof def.preview !== "function") return `Action ${name} needs a preview.`;
  }
  if (def.version === "v1" && typeof def.spendIntent === "function") return `Action ${name} is v1 but has a spendIntent; spending actions are v2 only.`;
  return null;
}

/** Throws RegistryLoadError on the first broken rule: per definition, then sorted and unique names. */
export function validateDefinitions(defs: readonly AnyActionDef[]): void {
  for (const def of defs) {
    const problem = definitionProblem(def);
    if (problem) throw new RegistryLoadError(problem);
  }
  for (let i = 1; i < defs.length; i++) {
    const a = defs[i - 1].name;
    const b = defs[i].name;
    if (a === b) throw new RegistryLoadError(`Action ${b} is registered twice.`);
    if (a > b) throw new RegistryLoadError(`Actions must be registered sorted by name: ${b} comes after ${a}.`);
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value as Record<string, unknown>)) if (typeof item !== "function") deepFreeze(item);
  }
  return value;
}

/** The registered actions, frozen and sorted by name. Empty until the definitions package registers. */
export let ACTIONS: readonly AnyActionDef[] = Object.freeze([]);
let byName = new Map<string, AnyActionDef>();
let generation = 0;
const listeners = new Set<() => void>();

/**
 * Registers definitions (sorted by name). The registry stays one frozen, sorted list; registering a name that is already
 * there throws. Returns the whole list.
 */
export function registerActions(defs: readonly AnyActionDef[]): readonly AnyActionDef[] {
  validateDefinitions(defs);
  for (const def of defs) if (byName.has(def.name)) throw new RegistryLoadError(`Action ${def.name} is registered twice.`);
  const all = [...ACTIONS, ...defs].sort((a, b) => (a.name < b.name ? -1 : 1));
  // An inverse that is itself a card must be able to show one (4.5).
  const names = new Map(all.map((d) => [d.name, d]));
  for (const def of all) {
    const inverse = def.undo?.inverseAction ? names.get(def.undo.inverseAction) : undefined;
    if (inverse && typeof inverse.preview !== "function") throw new RegistryLoadError(`Action ${def.name} undoes through ${inverse.name}, which has no preview to show as a card.`);
  }
  for (const def of defs) {
    deepFreeze(def.inputSchema);
    if (!isDynamic(def)) deepFreeze(def.effects);
    Object.freeze(def.surfaces);
    Object.freeze(def.untrustedPaths);
    if (def.editable) Object.freeze(def.editable);
    Object.freeze(def);
  }
  ACTIONS = Object.freeze(all);
  byName = new Map(all.map((d) => [d.name, d]));
  generation += 1;
  for (const listener of listeners) listener();
  return ACTIONS;
}

/** Empties the registry. For tests that register their own fixture definitions. */
export function resetRegistry(): void {
  ACTIONS = Object.freeze([]);
  byName = new Map();
  generation += 1;
  for (const listener of listeners) listener();
}

export function actionByName(name: string): AnyActionDef | undefined {
  return typeof name === "string" ? byName.get(name) : undefined;
}

export function listActions(): readonly AnyActionDef[] {
  return ACTIONS;
}

/** Bumped on every change, so derived data (toolsets, TOOLSET_VERSION) can memoise per registry state. */
export function registryGeneration(): number {
  return generation;
}

export function onRegistryChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// The v1 definitions register once at load (after every binding above is initialised).
registerActions(V1_DEFINITIONS);
