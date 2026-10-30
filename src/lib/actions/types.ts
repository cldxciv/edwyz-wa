/**
 * Load-bearing types of the shared action registry (docs/EDDY-SPEC.md 4.2, with the critic additions). Types plus two pure
 * tagging helpers, no runtime imports: every import here is `import type`, so nothing pulls in prisma, fetch or the spend book.
 *
 * One registry serves Eddy now and MCP and the public API later. invoke.ts is the ONLY caller of a definition's run(), and the
 * only file that builds the member's SpendActor (Phase 0 bypass rule B14, request E8). It talks to the spend controls only
 * through a SpendBridgePort it receives by injection (src/lib/actions/spend-bridge.ts implements it, Eddy 4.10).
 */
import type { JsonSchema } from "@/lib/tenant-mcp/schema";
import type { ApiScope } from "@/lib/integrations/scopes";
import type { AutomationEvent } from "@/lib/automation/v2/emit";
import type { Actor } from "@/lib/tenancy";
import type { EddyLang, I18nKey, VerifiedPageContext } from "@/lib/eddy/contract";
import type {
  AdsRaiseIntent,
  ApprovalDTO,
  BulkSubjectType,
  FreezeState,
  SpendActor,
  SpendSummaryDTO,
  SpendUserActor,
  StopResultDTO,
} from "@/lib/spend/types";

/** Type-only re-export, so definitions can type `o.spendActor` without importing the spend book. */
export type { SpendActor, SpendUserActor };
export type { AutomationEvent, JsonSchema, ApiScope, Actor, I18nKey, EddyLang, VerifiedPageContext };

export type Role = Actor["role"];

export type Surface = "eddy" | "mcp" | "api" | "system";
export type Risk = "instant" | "undoable" | "confirm";
export type Pot = "none" | "messaging" | "ads" | "ai"; // Phase 0 pot names (SPEND-CONTROLS-SPEC 3.2)

export type Effects = {
  writes: boolean;
  messagesCustomers?: boolean;
  spends?: Pot;
  deletes?: boolean;
  irreversible?: boolean;
  external?: boolean; // a write Meta sees: template review or delete, publishing, CAPI events
  armsAutomation?: boolean; // turns on automatic customer messaging or AI replies
  exportsPii?: boolean;
  changesAccess?: boolean;
  lowersActivity?: boolean; // pause, stop, cancel, disable: the asymmetric rule of Phase 0
  bulk?: boolean; // more than 10 subjects
  returnsSecret?: boolean; // never allowed on the 'eddy' surface
};

export type Principal = {
  via: Surface;
  actor: Actor; // eddy: getActor(request); keys: 4.4; system: {userId:'system:<job>', tenantId, role:'admin'}
  principalId: string; // 'eddy:<userId>:<conversationId>' | 'mcp:<keyId>' | 'api:<keyId>' | 'system:<job>'
  emailVerified: boolean;
  scopes?: readonly ApiScope[];
  lang: EddyLang; // 'en' on non-Eddy surfaces
  conversationId?: string;
  turnId?: string;
  toolUseId?: string;
  page?: VerifiedPageContext; // ids the server has checked the member can see (5.6)
};

export type UntrustedText = { $untrusted: UntrustedSource; text: string };
export type UntrustedSource =
  | "customer_message"
  | "contact_name"
  | "contact_attribute"
  | "lead_field"
  | "template_text"
  | "workspace_text"
  | "teammate_note"
  | "external_text"
  | "file_name";

export type CostLine =
  | { state: "free"; reason: "service_window" | "internal" }
  | { state: "estimate"; minor: string; currency: string; formatted: string; partial: boolean; worstCase: boolean }
  | { state: "unknown"; reason: "no_rate_card" | "not_computable" };

export type Warning =
  | "irreversible"
  | "external_meta"
  | "arms_automation"
  | "differs_from_open_chat"
  | "contains_link_or_number"
  | "large_audience"
  | "partial_coverage"
  | "outside_hours"
  | "no_marketing_opt_in"
  | "window_closes_soon"
  | "needs_approval"
  | "lead_conversion"
  | "changes_access"
  | "triggers_automation"; // (critic) the change starts an enabled automation that messages customers (4.2a)

export type Preview = {
  titleKey: I18nKey;
  /**
   * Title variables. Anything a customer, contact or teammate wrote (a contact name in "Send this reply to {name}?") must be
   * UntrustedText, so the card renders it as quoted data and a crafted name cannot make the title read as something else.
   * Plain strings are for server-made values only (counts, ids, formatted money and dates, catalogue labels).
   */
  vars: Record<string, string | number | UntrustedText>;
  facts: { labelKey: I18nKey; value: string | UntrustedText; mono?: boolean }[];
  recipients?: { count: number; sample: { name: UntrustedText | null; phoneMasked: string }[] };
  message?: { kind: "text" | "template"; body: UntrustedText | string; templateName?: string }; // exactly what will be sent
  cost: CostLine;
  warnings: Warning[];
  editable: { field: string; kind: "text" | "select" | "datetime" | "audience"; options?: { value: string; labelKey: I18nKey }[] }[];
  confirmLabelKey: I18nKey;
  danger: boolean;
  material: Record<string, string | number>; // re-checked at confirm: count, templateId, textSha256, costMinor, targetId
};

export type UndoRecord = { kind: string; target: string; before: unknown; after: unknown };
export type ActionCtx = { p: Principal; now: Date; signal?: AbortSignal };

/** UI hints a result can carry (4.1): a navigation chip, a composer draft, an undo chip, or an intent for the panel. */
export type UiHint =
  /** `path` becomes a chip only through safeAppPath() (src/lib/eddy/contract.ts): /app paths only (decision 0). */
  | { kind: "navigate"; path: string; labelKey: I18nKey }
  | { kind: "composer_draft"; conversationId: string; text: string }
  | { kind: "undo"; actionId: string; undoUntil: string }
  | { kind: "intent"; intent: "open_templates" | "connect_whatsapp" | "connect_facebook"; payload?: Record<string, string> };

/**
 * What a v2 spending action hands to the spend bridge (4.10a): the exact Phase 0 intent and the worst-case figures the card
 * showed. Amounts are decimal strings of minor units.
 */
export type SpendIntentRef =
  | { pot: "ads"; intent: AdsRaiseIntent; adAccountAssetId: string; worstCaseMonthMinor: string; currency: string }
  | { pot: "messaging"; kind: "bulk"; subjectType: BulkSubjectType; subjectId: string; estimateMinor: string; currency: string }
  | { pot: "messaging"; kind: "single"; conversationId: string; templateName: string; estimateMinor: string; currency: string };

export type ActionDef<A extends Record<string, unknown> = Record<string, unknown>, R = unknown> = {
  name: string; // ^[a-z][a-z0-9_]{2,63}$, unique and stable: it is the tool name
  version: "v1" | "v2";
  area: "help" | "inbox" | "contacts" | "templates" | "broadcasts" | "automation" | "leads" | "team" | "reports" | "setup" | "frontdesk" | "spend" | "ads" | "content";
  surfaces: readonly Surface[];
  titleKey: I18nKey; // the activity label: "Checking your templates…"
  description: string; // English, for the model; names which result fields are untrusted
  inputSchema: JsonSchema; // additionalProperties:false, required[]
  minRole: Role;
  route: { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; path: string } | "virtual";
  scopes?: readonly ApiScope[]; // key principals need one of these
  effects: Effects | ((a: A, ctx: ActionCtx) => Promise<Effects>);
  risk?: Risk; // optional; never below deriveRisk(effects)
  untrustedPaths: readonly string[]; // result paths that must hold UntrustedText
  editable?: readonly (keyof A & string)[];
  normalize?(ctx: ActionCtx, raw: Record<string, unknown>): Promise<A>; // names to ids, phone to contact
  authorize(ctx: ActionCtx, a: A): Promise<void>; // route-equivalent guards; throws HttpError
  preview?(ctx: ActionCtx, a: A): Promise<Preview>; // required when risk can be 'confirm'
  spendIntent?(ctx: ActionCtx, a: A, p: Preview): SpendIntentRef; // v2 spending actions only (4.10)
  run(
    ctx: ActionCtx,
    a: A,
    o: { idempotencyKey: string; spendActor?: SpendActor },
  ): Promise<{ result: R; undo?: UndoRecord; auditTarget: string; contactIds?: string[] }>;
  undo?: {
    windowMs: number;
    stillApplies(ctx: ActionCtx, u: UndoRecord): Promise<boolean>;
    inverse(ctx: ActionCtx, u: UndoRecord): Promise<void>;
    inverseAction?: string; // inverseAction: the inverse is itself a card
  };
  isUndo?: true; // undo_last_action only: it creates no further undo
  forModel(r: R, ctx: ActionCtx): unknown; // JSON for the tool_result
  forUi?(r: R, ctx: ActionCtx): UiHint; // nav chip, composer draft, undo chip, intent
  rateLimit?: { perPrincipalPerMin: number };
  piiItems?(r: R): number; // counts against the per-turn PII budget
  // (critic) additions
  needsWhatsApp?: boolean; // refused with 'not_connected' (or 'reconnect' when the token is unusable) before any work (4.3 G8a)
  callsMeta?: boolean; // refused with 'demo' in the demo workspace (6.14)
  automationEvents?(ctx: ActionCtx, a: A): Promise<AutomationEvent[]>; // the automation v2 events this write would emit (4.2a)
};

/**
 * The model-facing results of a call (4.3). Data only; the card and its nonce go only to the browser.
 * Every string that can carry someone else's words is UntrustedText, like the result paths gate G20 checks: `who` holds
 * teammates' display names, and `detail` is the route's sentence, which can repeat user-entered names or Meta's error text
 * (Action 12). Both reach the model inside the $untrusted envelope the system prompt tells it to treat as data.
 */
export type ModelResult =
  | { status: "done"; result: unknown; undoAvailable: boolean }
  | { status: "preview_shown"; actionId: string; note: string }
  | { status: "refused"; code: string; requiredRole?: Role; who?: UntrustedText[] }
  | { status: "failed"; code: string; detail: UntrustedText }
  | { status: "outcome_unknown" };

/** Tags a teammate's display name for ModelResult.refused.who. */
export function teammateName(text: string): UntrustedText {
  return { $untrusted: "teammate_note", text };
}

/** Tags a failure sentence for ModelResult.failed.detail: it may quote names or outside (Meta) text. */
export function failureDetail(text: string): UntrustedText {
  return { $untrusted: "external_text", text };
}

/** ActionRecord.status (8.4 state machine). */
export type ActionStatus =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "cancelled"
  | "expired"
  | "superseded"
  | "undone"
  | "unknown"
  | "awaiting_approval"
  | "refused";

/** ActionInvocation stage and outcome (8.1). */
export type InvocationStage = "read" | "preview" | "execute" | "undo" | "refuse";
export type InvocationOutcome = "started" | "ok" | "refused" | "failed" | "unknown" | "needs_confirmation" | "awaiting_approval";

/** The AI allowance as Eddy shows it (credits; null limit = not set). */
export type AiAllowanceSummary = { usedToday: number; limitToday: number | null; usedMonth: number; limitMonth: number | null; resetsOn: string | null };

/** Result of a v2 spend execution through Phase 0 (G16). */
export type SpendExecution =
  | { status: "applied"; correlationId: string | null }
  | { status: "unconfirmed"; correlationId: string | null }
  | { status: "refused"; code: string; message: string; params?: Record<string, unknown> };

/**
 * Everything invoke.ts and the spend definitions need from the Phase 0 spend controls, injected so the action layer never
 * imports @/lib/spend/* itself. spend-bridge.ts is the one implementation; it never writes spend tables (Phase 0 B7).
 * v1 uses reads and lowering only. Every method that acts takes the member's SpendUserActor, which only invoke.ts builds.
 */
export interface SpendBridgePort {
  /** G2: v2 spending actions are offered only when Phase 0 is ready for them in this workspace (4.10a item 9). */
  eddyAssistantReady(tenantId: string): Promise<boolean>;
  /** G12 / G16: the workspace and platform freeze, read fresh for anything that spends. */
  freezeState(tenantId: string, opts?: { fresh?: boolean }): Promise<FreezeState>;
  /** G16 (4.10a): bulk and ads raises prepared by Eddy need the owner or a named approver. */
  isApprover(tenantId: string, userId: string): Promise<boolean>;
  /** Names for "Only {names} can confirm spending that Eddy prepares." */
  approverNames(tenantId: string): Promise<string[]>;
  /** 6.14: the demo workspace refuses every callsMeta action. */
  isDemoWorkspace(tenantId: string): Promise<boolean>;
  /** Status and the allowance_used state (5.11). */
  aiAllowance(tenantId: string): Promise<AiAllowanceSummary>;
  /** get_spending: the same summary GET /api/spend/summary returns for this member's role. */
  summary(actor: SpendUserActor & { tenantId: string }): Promise<SpendSummaryDTO>;
  /** stop_spending: a lowering; works while frozen and in a locked workspace. Admin or owner. */
  stopSpending(actor: SpendUserActor & { tenantId: string }, level: "assistants" | "all", reason: string): Promise<StopResultDTO>;
  /** list_approvals: the Phase 0 requests this member may decide. */
  listApprovals(actor: SpendUserActor & { tenantId: string }): Promise<ApprovalDTO[]>;
  /** decline_spend_request: Phase 0's decide path (via 'app'), with its approver re-check and conditional update. */
  declineApproval(actor: SpendUserActor & { tenantId: string }, approvalId: string): Promise<ApprovalDTO>;
  /** v2 only (G16): run a confirmed spending intent through the Phase 0 call site as this member. */
  executeSpend?(actor: SpendUserActor & { tenantId: string }, intent: SpendIntentRef, opts: { idempotencyKey: string; reason: string }): Promise<SpendExecution>;
}
