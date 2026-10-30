/**
 * The public surface of the action layer (docs/EDDY-SPEC.md 4.1). Eddy (src/lib/eddy/**, src/components/eddy/**) and,
 * after EDDY-20, tenant-mcp import only this module: the invoke functions, the toolsets, principals and the types.
 * Definitions are registered by src/lib/actions/defs; nothing outside invoke.ts calls a definition's run().
 */
export {
  ACTION_COPY,
  PREVIEW_NOTE,
  PII_BUDGET_PER_TURN,
  RECONCILE_QUEUE,
  cancelAction,
  checkAutomation,
  compareMaterial,
  concretePath,
  confirmAction,
  defaultInvokeDeps,
  proposeAction,
  refreshAction,
  reviseAction,
  setDefaultSpendBridge,
  undoAction,
  undoLastAction,
  UNWIRED_SPEND_BRIDGE,
  type AutomationCheck,
  type AutomationContext,
  type AutomationMatch,
  type AutomationPort,
  type AutomationRuleRow,
  type CardOutcome,
  type ConfirmInput,
  type InvokeDeps,
  type InvokeOutcome,
  type ProposeOptions,
  type ReviseInput,
  type WhatsAppState,
  type WorkspacePort,
} from "./invoke";
export { EAGER_INPUT_TOOLS, roleClassOf, TOOLSET_VERSION, toolsetHash, toolsetVersion, toolsFor, type ModelTool, type ModelToolSchema, type RoleClass } from "./model-tools";
export { eddyPrincipal, keyPrincipal, refreshPrincipal, systemPrincipal, ROLE_CHANGED_MESSAGE, type PrincipalSession } from "./principal";
export { ACTIONS, actionByName, listActions, registerActions, RegistryLoadError, type ActionDefinition, type AnyActionDef, type UndoSpec } from "./registry";
export { deriveRisk, effectiveRisk, maxRisk } from "./risk";
export { argsHash, canonicalJson, hashCanonical, previewHash } from "./canonical";
export { isUntrustedText, toModelPayload, truncateGraphemes, u, uOrNull, UNTRUSTED_SOURCES } from "./untrusted";
export { failureDetail, teammateName } from "./types";
export type * from "./types";
