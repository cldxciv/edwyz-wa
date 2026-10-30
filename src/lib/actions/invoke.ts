/**
 * The single executor of the action layer (docs/EDDY-SPEC.md 4.3, 4.4, 4.5, 4.2a, 4.10a). Every call, from every surface,
 * goes through the same gates in the same order:
 *
 *   G1 definition and surface   G2 v2 phase gate          G3 schema, canonical JSON   G4 fresh principal
 *   G5 minRole                  G6 key scope              G7 verified email, paywall  G8 normalize
 *   G8a WhatsApp, demo          G9 route-equivalent guard G10 effects, automations    G11 system = lowering only
 *   G12 kill switch, freeze     G13 rate limit            G14 card or run             G15 confirm claim, re-check
 *   G16 Eddy's spend rules      G17 audit, invocation     G18 run once                G19 outcome (unknown never retried)
 *   G20 projection, PII budget
 *
 * This file is the ONLY caller of def.run() and the ONLY place that builds the member's SpendActor with
 * reasonCodes ['via_eddy'] (Phase 0 bypass rule B14, Eddy request E8). The spend controls are reached only through the
 * injected SpendBridgePort; the default port refuses anything that spends and lets lowering pass. The model never sees a
 * nonce: cards go to the browser, the model gets data-only results (4.3).
 */
import { randomBytes } from "node:crypto";
import { auditOutcome, auditStrict } from "@/lib/ads/audit";
import { audit } from "@/lib/auth/audit";
import { assertEmailVerifiedForWrite, UNVERIFIED_MESSAGE } from "@/lib/auth/verification";
import { conditionMatches, type RuleContext } from "@/lib/automation/v2/evaluate";
import { byPriority, parseDefinition, type Condition, type Group, type RuleDefinition } from "@/lib/automation/v2/model";
import { prisma } from "@/lib/db";
import { CARD_CONFIRM_GUARD_MS, CARD_TTL_MS, readEddyConfig, type CardState, type PendingCardDTO } from "@/lib/eddy/contract";
import { holdsScope, missingScopeMessage } from "@/lib/integrations/scopes";
import { enqueue } from "@/lib/queue";
import { createLimiter } from "@/lib/ratelimit";
import { describeError } from "@/lib/safe-error";
import { hasRole, HttpError } from "@/lib/tenancy";
import { canonicalClone, hashCanonical, previewHash as hashPreview, sha256Hex } from "./canonical";
import { derivePrincipal, isKeyPrincipal, PrincipalRefusal, refreshPrincipal } from "./principal";
import { actionByName, type AnyActionDef, type UndoSpec } from "./registry";
import { effectiveRisk, mergeEffects } from "./risk";
import { validate } from "./schema";
import {
  cardTarget,
  claimPending,
  contactIdsIn,
  explainMiss,
  findActionRecord,
  insertActionRecord,
  latestUndoable,
  newActionId,
  newOpId,
  redactArgs,
  reserveCardSlot,
  subjectIdsIn,
  supersedeCards,
  transition,
  writeInvocation,
  writeInvocationStrict,
  type ActionRecord,
  type InvocationRow,
  type MissReason,
} from "./store";
import {
  failureDetail,
  teammateName,
  type ActionCtx,
  type AutomationEvent,
  type Effects,
  type I18nKey,
  type InvocationOutcome,
  type ModelResult,
  type Pot,
  type Preview,
  type Principal,
  type Risk,
  type Role,
  type SpendActor,
  type SpendBridgePort,
  type UiHint,
  type UndoRecord,
} from "./types";
import { toModelPayload, u } from "./untrusted";

// ===== Copy (plain sentences; the Eddy catalogue translates by code) =====

export const ACTION_COPY = {
  unknown_action: "Eddy can't do that here.",
  not_yet: "This isn't available through Eddy yet. You can do it on its page.",
  role: "Your role can't do this. Ask someone who can.",
  scope: "This API key does not have the permission this needs.",
  email_unverified: UNVERIFIED_MESSAGE,
  workspace_locked: "Your plan has ended, so changes are paused. Renew it in Billing to carry on.",
  not_found: "That wasn't found. It may have been removed, or you may not have access to it.",
  not_connected: "WhatsApp isn't connected to this workspace yet. Connect it in Settings, then try again.",
  not_connected_agent: "WhatsApp isn't connected to this workspace yet. Ask an admin to connect it.",
  reconnect: "WhatsApp needs to be connected again. Reconnect it in Settings, then try again.",
  demo: "This is a demo workspace, so nothing is sent to Meta or to customers.",
  not_allowed: "Eddy can't do this. Do it on its page instead.",
  triggers_paid_rule: "This change would start an automation that sends a paid message or uses AI. Make the change yourself on its page, so you can see what it starts.",
  triggers_automation: "Undoing this would start an automation that messages the customer. Undo it yourself on its page.",
  kill_switch: "Eddy is paused by the Edwyz team right now. Cards that spend nothing can still be confirmed.",
  spend_frozen: "Spending is stopped in this workspace, so Eddy can't prepare anything that spends. Lowering spend still works.",
  spend_not_set_up: "Spending through Eddy isn't set up in this workspace yet. Do this on its page.",
  needs_approver: "Only the owner or a named approver can confirm spending that Eddy prepares. Start it yourself on its page, or ask them.",
  rate_limited: "That's a lot of actions in a short time. Wait a minute, then try again.",
  turn_budget: "Eddy can prepare at most 3 cards per message. Ask for the rest in your next message.",
  too_many_pending: "You have 5 cards waiting. Confirm or cancel one first.",
  pii_budget: "That's more records than Eddy can read in one message. Ask for fewer at a time.",
  internal: "Something went wrong; nothing was changed.",
  card_not_found: "This card wasn't found. It may have been used already or belong to someone else.",
  expired: "This preview expired. Refresh it to see the latest.",
  changed: "Something changed since this preview. Check the new card and confirm again.",
  already_decided: "This card was already used.",
  not_expired: "This card is still open. Confirm or cancel it.",
  invalid_edit: "That can't be changed on this card.",
  not_undoable: "This can't be undone.",
  undo_expired: "Undo is no longer available for this action.",
  undo_changed: "Someone changed it since, so it was not undone.",
  already_undone: "This was already undone.",
  nothing_to_undo: "There is nothing to undo in this chat.",
  outcome_unknown: "It isn't certain whether this went through. It's being checked, and it won't be tried again automatically.",
} as const;

export const PREVIEW_NOTE = "PREVIEW ONLY. Nothing has happened. The member must tap a button on the card. Do not say it is done.";
/** The per-turn PII budget of G20 (records). */
export const PII_BUDGET_PER_TURN = 200;
/** Writes from one member share this many calls a minute across all actions (G13). */
export const WRITES_PER_USER_PER_MIN = 60;
export const DEFAULT_ACTION_PER_MIN = 30;
/** The jobs queue that settles `unknown` outcomes (8.4). */
export const RECONCILE_QUEUE = "actions.reconcile";
/** Routes the paywall never blocks, as getActor treats them (Phase 0 adds /api/spend/). */
const PAYWALL_EXEMPT_PREFIXES = ["/api/auth/", "/api/billing/", "/api/spend/"];

// ===== Ports =====

export type AutomationRuleRow = {
  id: string;
  name: string;
  priority: number;
  createdAt: Date;
  updatedAt?: Date | string | null;
  trigger: unknown;
  filters: unknown;
  actions: unknown;
};

/** The contact and chat state an automation filter looks at (before this write). */
export type AutomationContext = { contactTags: string[]; chatTags: string[]; attributes: Record<string, unknown>; phone: string; assignedToId: string | null };

/** What the 4.2a check reads. The default reads Postgres; tests inject fixtures. Nothing here sends anything. */
export interface AutomationPort {
  enabledRules(tenantId: string): Promise<AutomationRuleRow[]>;
  chatbot(tenantId: string, id: string): Promise<{ flow: unknown; publishedFlow: unknown } | null>;
  material(tenantId: string, id: string): Promise<{ kind: string } | null>;
  context(tenantId: string, event: AutomationEvent): Promise<AutomationContext | null>;
}

export type WhatsAppState = "connected" | "none" | "reconnect";

export interface WorkspacePort {
  /** The billing paywall (assertTenantCanWrite): throws HttpError 402 or 403. */
  assertCanWrite(tenantId: string): Promise<void>;
  whatsAppState(tenantId: string): Promise<WhatsAppState>;
  /** Display names of members at or above a role, for "Ask {names}". */
  namesWithRole(tenantId: string, minRole: Role): Promise<string[]>;
  /** PlatformSetting `eddy:platform` {enabled:false}: the ops kill switch. */
  eddyPlatformDisabled(): Promise<boolean>;
}

export type AuditPort = { audit: typeof audit; auditStrict: typeof auditStrict; auditOutcome: typeof auditOutcome };
export type LimiterLike = { consume(key: string, now?: number): boolean };

export type InvokeDeps = {
  spendBridge: SpendBridgePort;
  automation: AutomationPort;
  workspace: WorkspacePort;
  audit: AuditPort;
  limiter: (name: string, perMinute: number) => LimiterLike;
  enqueue: (queue: string, payload: unknown) => Promise<unknown>;
  clock: () => Date;
  phase: () => 1 | 2;
  /** Throw on a plain string at a declared untrusted path (default: outside production). */
  strictUntrusted?: boolean;
};

export class SpendBridgeUnavailable extends HttpError {
  constructor() {
    super(503, "Spending controls are not connected to Eddy yet.");
    this.name = "SpendBridgeUnavailable";
  }
}

const unavailable = async (): Promise<never> => {
  throw new SpendBridgeUnavailable();
};

/** The demo workspace's WABA id prefix (scripts/seed-demo.mjs), until Phase 0's demo flag reaches the bridge (6.14). */
export const DEMO_WABA_PREFIX = "demo-waba-";

/**
 * The bridge used when src/lib/actions/spend-bridge.ts cannot load (or a test or ops switches the front desk off with
 * setDefaultSpendBridge): v2 is never ready, the freeze cannot be read (so anything that spends is refused at G12 with
 * spend_not_set_up), nobody is an approver, and the demo workspace is recognised by its WABA id. Lowering passes G12.
 */
export const UNWIRED_SPEND_BRIDGE: SpendBridgePort = {
  eddyAssistantReady: async () => false,
  freezeState: unavailable,
  isApprover: async () => false,
  approverNames: async () => [],
  isDemoWorkspace: async (tenantId) => Boolean(await prisma.waba.findFirst({ where: { tenantId, wabaId: { startsWith: DEMO_WABA_PREFIX } }, select: { id: true } })),
  aiAllowance: unavailable,
  summary: unavailable,
  stopSpending: unavailable,
  listApprovals: unavailable,
  declineApproval: unavailable,
};

/**
 * The Phase 0 bridge (src/lib/actions/spend-bridge.ts), loaded on first use so this file never imports @/lib/spend itself
 * and loading the registry stays light. G8a reads its isDemoWorkspace and G12/G16 its freeze state. If the module cannot
 * load, the unwired bridge answers instead: anything that spends is refused, lowering still passes.
 */
let phase0: Promise<SpendBridgePort> | null = null;
function loadPhase0Bridge(): Promise<SpendBridgePort> {
  phase0 ??= import("./spend-bridge")
    .then((m) => m.SPEND_BRIDGE ?? UNWIRED_SPEND_BRIDGE)
    .catch(() => UNWIRED_SPEND_BRIDGE);
  return phase0;
}

/** One method of the default bridge: the same method of the Phase 0 bridge, loaded once. */
function forward<K extends keyof SpendBridgePort>(name: K): SpendBridgePort[K] {
  return (async (...args: unknown[]) => {
    const bridge = await loadPhase0Bridge();
    return (bridge[name] as unknown as (...a: unknown[]) => Promise<unknown>)(...args);
  }) as unknown as SpendBridgePort[K];
}

/** The default bridge: each call goes to the Phase 0 bridge, loaded on first use. */
export const PHASE0_SPEND_BRIDGE: SpendBridgePort = {
  eddyAssistantReady: forward("eddyAssistantReady"),
  freezeState: forward("freezeState"),
  isApprover: forward("isApprover"),
  approverNames: forward("approverNames"),
  isDemoWorkspace: forward("isDemoWorkspace"),
  aiAllowance: forward("aiAllowance"),
  summary: forward("summary"),
  stopSpending: forward("stopSpending"),
  listApprovals: forward("listApprovals"),
  declineApproval: forward("declineApproval"),
};

let defaultBridge: SpendBridgePort = PHASE0_SPEND_BRIDGE;
/** Replaces the default bridge (tests, or UNWIRED_SPEND_BRIDGE to switch Eddy's spend front desk off). */
export function setDefaultSpendBridge(bridge: SpendBridgePort): void {
  defaultBridge = bridge;
}

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export const PRISMA_AUTOMATION: AutomationPort = {
  enabledRules: async (tenantId) =>
    (await prisma.automationRule.findMany({
      where: { tenantId, enabled: true, version: 2 },
      select: { id: true, name: true, priority: true, createdAt: true, updatedAt: true, trigger: true, filters: true, actions: true },
    })) as AutomationRuleRow[],
  chatbot: (tenantId, id) => prisma.chatbot.findFirst({ where: { id, tenantId }, select: { flow: true, publishedFlow: true } }),
  material: (tenantId, id) => prisma.replyMaterial.findFirst({ where: { id, tenantId }, select: { kind: true } }),
  async context(tenantId, event) {
    if (!event.contactId) return null;
    const contact = await prisma.contact.findFirst({ where: { id: event.contactId, tenantId }, select: { tags: true, attributes: true, phone: true } });
    if (!contact) return null;
    const conversation = event.conversationId ? await prisma.conversation.findFirst({ where: { id: event.conversationId, tenantId }, select: { tags: true, assignedToId: true } }) : null;
    return { contactTags: contact.tags ?? [], chatTags: conversation?.tags ?? [], attributes: asRecord(contact.attributes), phone: contact.phone ?? "", assignedToId: conversation?.assignedToId ?? null };
  },
};

const ROLES_AT_OR_ABOVE: Record<Role, Role[]> = { agent: ["agent", "admin", "owner"], admin: ["admin", "owner"], owner: ["owner"] };

export const PRISMA_WORKSPACE: WorkspacePort = {
  async assertCanWrite(tenantId) {
    const { assertTenantCanWrite } = await import("@/lib/billing");
    await assertTenantCanWrite(tenantId);
  },
  async whatsAppState(tenantId) {
    const numbers = await prisma.phoneNumber.count({ where: { tenantId } });
    if (numbers === 0) return "none";
    const { getWhatsAppTokenHealth } = await import("@/lib/onboarding/token-health");
    const health = await getWhatsAppTokenHealth(tenantId);
    if (health.state === "expired" || health.state === "rejected") return "reconnect";
    return health.state === "none" ? "none" : "connected";
  },
  async namesWithRole(tenantId, minRole) {
    const rows = await prisma.membership.findMany({ where: { tenantId, role: { in: ROLES_AT_OR_ABOVE[minRole] } }, select: { user: { select: { name: true } } }, take: 5 });
    return rows.map((r) => r.user?.name).filter((n): n is string => typeof n === "string" && n.length > 0);
  },
  async eddyPlatformDisabled() {
    const row = await prisma.platformSetting.findUnique({ where: { key: "eddy:platform" }, select: { value: true } });
    return asRecord(row?.value).enabled === false;
  },
};

/**
 * One shared limiter per limit value, all under the stable name "eddy-actions" (docs/ops.md section 2). The window's own
 * name (`act:<action>`, `act:writes`, `act:undo`) is part of the key, so each action and the shared write budget count
 * separately.
 */
const limiters = new Map<number, LimiterLike>();
function sharedLimiter(perMinute: number): LimiterLike {
  let limiter = limiters.get(perMinute);
  if (!limiter) {
    limiter = createLimiter(perMinute, 60_000, "eddy-actions");
    limiters.set(perMinute, limiter);
  }
  return limiter;
}

export function defaultInvokeDeps(): InvokeDeps {
  return {
    spendBridge: defaultBridge,
    automation: PRISMA_AUTOMATION,
    workspace: PRISMA_WORKSPACE,
    audit: { audit, auditStrict, auditOutcome },
    limiter: (name, perMinute) => {
      const limiter = sharedLimiter(perMinute);
      return { consume: (key, now) => limiter.consume(`${name}|${key}`, now) };
    },
    enqueue: (queue, payload) => enqueue(queue, payload, { maxAttempts: 5 }),
    clock: () => new Date(),
    phase: () => readEddyConfig(process.env, () => undefined).phase,
  };
}

const withDefaults = (deps: Partial<InvokeDeps> = {}): InvokeDeps => {
  const out = defaultInvokeDeps();
  for (const [key, value] of Object.entries(deps)) if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  return out;
};

// ===== Refusals =====

/** `spend_blocked` always carries Phase 0's own sentence (its 4.13 copy), so it has no ACTION_COPY line. */
type RefusalCode = keyof typeof ACTION_COPY | "invalid_args" | "role_changed" | "signed_out" | "forbidden" | "conflict" | "invalid" | "failed" | "spend_blocked";

class Refusal extends Error {
  constructor(
    public code: RefusalCode,
    public status: number,
    message: string,
    public extra: { requiredRole?: Role; who?: string[]; asFailure?: boolean } = {},
  ) {
    super(message);
    this.name = "Refusal";
  }
}

const refuse = (code: keyof typeof ACTION_COPY, status: number, extra: Refusal["extra"] = {}) => new Refusal(code, status, ACTION_COPY[code], extra);

/** The code of a route's HttpError sentence (G9, G19). */
function codeForStatus(status: number): RefusalCode {
  if (status === 404) return "not_found";
  if (status === 403 || status === 401) return "forbidden";
  if (status === 409) return "conflict";
  if (status === 402) return "workspace_locked";
  if (status === 429) return "rate_limited";
  if (status >= 400 && status < 500) return "invalid";
  return "internal";
}

/**
 * Phase 0 refusals (SpendBlockedError and the rest) carry a `spend.*` code. They are read by shape, so this file never
 * imports the spend book: a freeze is `spend_frozen`, the demo workspace is `demo`, anything else Phase 0 refused is
 * `spend_blocked` (the card's `spend_refused` state). The message stays Phase 0's own sentence (4.13 copy).
 */
export function spendRefusalCode(e: unknown): "spend_frozen" | "spend_blocked" | "demo" | null {
  const code = e && typeof e === "object" ? (e as { code?: unknown }).code : undefined;
  if (typeof code !== "string" || !code.startsWith("spend.")) return null;
  if (code === "spend.frozen" || code === "spend.platform_frozen") return "spend_frozen";
  if (code === "spend.demo") return "demo";
  return "spend_blocked";
}

/** The code of a refusal raised as an HttpError below 500: Phase 0's own code when it has one, else by status. */
const codeForHttpError = (e: HttpError): RefusalCode => spendRefusalCode(e) ?? codeForStatus(e.status);

/** A route guard or service refusal: the route's own sentence reaches the model as failed.detail. */
const fromHttpError = (e: HttpError) => new Refusal(codeForHttpError(e), e.status, e.message, { asFailure: true });

// ===== Outcomes =====

/** What proposeAction returns to the Eddy loop (and, after EDDY-20, to MCP). */
export type InvokeOutcome = {
  /** The data-only tool_result content (4.3). Never holds a nonce. */
  model: ModelResult;
  /** The tool_result is_error flag (invalid arguments). */
  isError: boolean;
  /** HTTP-like status of the call, for API surfaces. */
  status: number;
  opId: string;
  actionId?: string;
  risk?: Risk;
  /** Browser only (SSE `card` event): carries the nonce. */
  card?: PendingCardDTO;
  done?: { actionId: string | null; action: string; summaryKey: I18nKey; vars: Record<string, string | number>; undoUntil?: string };
  refused?: { action: string; code: string; status: number; message: string; who?: string[]; requiredRole?: Role };
  ui?: UiHint;
  /**
   * The contacts and chats this call ran on or put in front of the model (its arguments, its preview and its result), so
   * Eddy can tag the stored tool_result for contact erasure (EddyMessage.contactIds, conversationIds). Never sent to the model.
   */
  subjects?: { contactIds: string[]; conversationIds: string[] };
};

/** What the card routes (confirm, revise, refresh, cancel, undo) answer. */
export type CardOutcome = {
  status: number;
  state: CardState | "undone" | "refused";
  code?: string;
  message?: string;
  card?: PendingCardDTO;
  actionId?: string;
  result?: unknown;
  undoUntil?: string;
  note?: "cost_lower";
  who?: string[];
  /** On a `role` refusal: the role the action needs. */
  requiredRole?: Role;
  ui?: UiHint;
};

const CARD_STATE_FOR: Partial<Record<string, CardState>> = {
  spend_frozen: "spend_frozen",
  spend_not_set_up: "spend_not_set_up",
  spend_blocked: "spend_refused",
  needs_approver: "needs_approver",
  demo: "demo",
  not_connected: "not_connected",
  reconnect: "reconnect",
  changed: "changed",
  expired: "expired",
};

// ===== Helpers =====

const isId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_:-]{1,64}$/.test(v);
const staticEffects = (def: AnyActionDef): Effects | null => (typeof def.effects === "function" ? null : (def.effects as Effects));
/** G7 applies before effects are resolved: dynamic effects and confirm-class actions count as writes. */
const mayWrite = (def: AnyActionDef) => {
  const e = staticEffects(def);
  return e === null || e.writes || def.risk === "confirm" || effectiveRisk(def.risk, e) === "confirm";
};
const staticLowers = (def: AnyActionDef) => staticEffects(def)?.lowersActivity === true;

function fillRoute(def: AnyActionDef, args: Record<string, unknown>): { path: string; params: string[] } {
  if (def.route === "virtual") return { path: `/api/actions/virtual/${def.name}`, params: [] };
  const segments = def.route.path.split("/");
  const params: string[] = [];
  const path = segments
    .map((segment, i) => {
      const m = /^\[(?:\.\.\.)?([A-Za-z0-9_]+)\]$/.exec(segment);
      if (!m) return segment;
      const key = m[1];
      const previous = (segments[i - 1] ?? "").replace(/s$/, "");
      for (const candidate of [key, `${previous}Id`, "id"]) {
        const v = args[candidate];
        if (isId(v)) {
          params.push(v);
          return encodeURIComponent(v);
        }
      }
      return "_";
    })
    .join("/");
  return { path, params };
}

/** The concrete route path with its arguments filled in, as getActor would see it (G7). Unknown parameters become "_". */
export function concretePath(def: AnyActionDef, args: Record<string, unknown>): string {
  return fillRoute(def, args).path;
}

/** The ids filled into the route, in order (the audit target). */
const routeParams = (def: AnyActionDef, args: Record<string, unknown>) => fillRoute(def, args).params;

function buildSpendActor(p: Principal): SpendActor {
  if (p.via === "eddy") return { type: "user", userId: p.actor.userId, role: p.actor.role, reasonCodes: ["via_eddy"] };
  if (p.via === "system") return { type: "system", job: p.principalId.slice("system:".length) };
  return { type: "api", keyId: p.principalId.slice(p.principalId.indexOf(":") + 1), userId: p.actor.userId };
}

const auditName = (p: Principal, name: string) => `${p.via === "eddy" ? "eddy" : p.via}.${name}`;

function isAmbiguous(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const err = e as { name?: string; ambiguous?: boolean; status?: number; outcomeUnknown?: boolean };
  if (err.ambiguous === true || err.outcomeUnknown === true) return true;
  if (err.name === "TimeoutError" || err.name === "AbortError") return true;
  return err.name === "GraphError" && typeof err.status === "number" && err.status >= 500;
}

const piiUsed = new Map<string, { n: number; at: number }>();
function addPii(turnId: string | undefined, n: number, now: number): boolean {
  if (!turnId || n <= 0) return true;
  const entry = piiUsed.get(turnId) ?? { n: 0, at: now };
  if (entry.n + n > PII_BUDGET_PER_TURN) return false;
  entry.n += n;
  entry.at = now;
  piiUsed.set(turnId, entry);
  if (piiUsed.size > 10_000) for (const [k, v] of piiUsed) if (now - v.at > 30 * 60_000) piiUsed.delete(k);
  return true;
}

/** Clears in-process state (PII budgets, limiters). For tests. */
export function resetInvokeState(): void {
  piiUsed.clear();
  limiters.clear();
}

// ===== Automations started by a write (4.2a) =====

export type AutomationSend = "text" | "material" | "chatbot" | "template" | "ai_agent" | "lead_sequence";
export type AutomationMatch = { ruleId: string; name: string; updatedAt: string; sends: AutomationSend; spends: "none" | "messaging" | "ai" };
export type AutomationCheck = { matches: AutomationMatch[]; spends: "none" | "messaging" | "ai" };

const SEND_STRENGTH: AutomationSend[] = ["text", "material", "chatbot", "ai_agent", "lead_sequence", "template"];

function triggerAccepts(def: RuleDefinition, event: AutomationEvent): boolean {
  const t = def.trigger;
  if (t.type !== event.type) return false;
  switch (t.type) {
    case "tag_added":
    case "tag_removed":
      return t.tag === null || (event.tags ?? []).some((x) => x.toLowerCase() === t.tag!.toLowerCase());
    case "attribute_changed":
      return (event.attribute ?? "").toLowerCase() === t.attribute.toLowerCase();
    case "status_changed":
      return t.to === null || event.to === t.to;
    default:
      return true;
  }
}

type Tri = boolean | null;

/** The engine's own condition check, with "unknown" where the outcome depends on state the dry run cannot see (counts as a match). */
function conditionTri(c: Condition, ctx: RuleContext | null, changedAttributes: ReadonlySet<string>): Tri {
  if (c.type === "segment") return null;
  if (c.type === "attribute" && changedAttributes.has(c.name.toLowerCase())) return null;
  if (!ctx && (c.type === "attribute" || c.type === "tag" || c.type === "phone" || c.type === "assignment")) return null;
  return conditionMatches(c, ctx ?? emptyContext(new Date()));
}

function groupTri(g: Group, ctx: RuleContext | null, changed: ReadonlySet<string>): Tri {
  if (g.items.length === 0) return true;
  const results = g.items.map((item) => (item.type === "group" ? groupTri(item, ctx, changed) : conditionTri(item, ctx, changed)));
  if (g.op === "and") return results.includes(false) ? false : results.includes(null) ? null : true;
  return results.includes(true) ? true : results.includes(null) ? null : false;
}

function emptyContext(now: Date): RuleContext {
  return { now, text: "", messageType: "text", newChat: false, silentMinutes: null, phone: "", contactTags: [], chatTags: [], attributes: {}, assignedToId: null, segments: new Set() };
}

/** The state the rule would see after this write: the event's tags applied. */
function contextAfter(base: AutomationContext, event: AutomationEvent, now: Date): RuleContext {
  let contactTags = [...base.contactTags];
  let chatTags = [...base.chatTags];
  const tags = event.tags ?? [];
  const lower = new Set(tags.map((t) => t.toLowerCase()));
  if (event.type === "tag_added") {
    if (event.conversationId) chatTags = [...chatTags, ...tags];
    else contactTags = [...contactTags, ...tags];
  } else if (event.type === "tag_removed") {
    if (event.conversationId) chatTags = chatTags.filter((t) => !lower.has(t.toLowerCase()));
    else contactTags = contactTags.filter((t) => !lower.has(t.toLowerCase()));
  }
  return { now, text: "", messageType: "text", newChat: false, silentMinutes: null, phone: base.phone, contactTags, chatTags, attributes: base.attributes, assignedToId: base.assignedToId, segments: new Set() };
}

function escalationUsesAi(flow: Record<string, unknown>): boolean {
  // chatbots/flow.ts: escalation is on by default, the AI check is off by default.
  const escalation = asRecord(asRecord(flow.settings).escalation);
  return escalation.enabled !== false && escalation.useAi === true;
}

async function classifyRule(tenantId: string, def: RuleDefinition, port: AutomationPort): Promise<{ sends: AutomationSend; spends: "none" | "messaging" | "ai" } | null> {
  let sends: AutomationSend | null = null;
  let spends: "none" | "messaging" | "ai" = "none";
  const note = (s: AutomationSend, pot: "none" | "messaging" | "ai") => {
    if (sends === null || SEND_STRENGTH.indexOf(s) > SEND_STRENGTH.indexOf(sends)) sends = s;
    if (pot === "messaging" || (pot === "ai" && spends === "none")) spends = pot;
  };
  for (const action of def.actions) {
    switch (action.type) {
      case "send_text":
        note("text", "none");
        break;
      case "send_material": {
        const material = await port.material(tenantId, action.materialId);
        if (material?.kind === "template") note("template", "messaging");
        else note("material", "none");
        break;
      }
      case "send_template":
        note("template", "messaging");
        break;
      case "start_lead_sequence":
        note("lead_sequence", "messaging");
        break;
      case "start_ai_agent":
        note("ai_agent", "ai");
        break;
      case "start_chatbot": {
        // Transitive: the bot's own flow decides what it sends (4.2a).
        const bot = await port.chatbot(tenantId, action.chatbotId);
        const flow = asRecord(bot?.publishedFlow ?? bot?.flow);
        const nodes = Array.isArray(flow.nodes) ? (flow.nodes as unknown[]) : [];
        if (nodes.some((n) => asRecord(n).type === "send_template")) note("chatbot", "messaging");
        else if (escalationUsesAi(flow)) note("chatbot", "ai");
        else note("chatbot", "none");
        break;
      }
      default:
        break;
    }
  }
  return sends === null ? null : { sends, spends };
}

/**
 * The 4.2a dry run: which enabled v2 rules the events would start, and what they would send. Nothing is sent. A condition
 * the dry run cannot evaluate (segments, a value this write changes, a contact it cannot load) counts as matching.
 */
export async function checkAutomation(tenantId: string, events: readonly AutomationEvent[], port: AutomationPort, now: Date = new Date()): Promise<AutomationCheck> {
  const out: AutomationCheck = { matches: [], spends: "none" };
  if (events.length === 0) return out;
  const rules = [...(await port.enabledRules(tenantId))].sort(byPriority);
  if (rules.length === 0) return out;
  const contexts = new Map<AutomationEvent, AutomationContext | null>();
  for (const rule of rules) {
    const parsed = parseDefinition({ trigger: rule.trigger, filters: rule.filters, actions: rule.actions });
    if (!parsed.ok) continue;
    let hit = false;
    for (const event of events) {
      if (!triggerAccepts(parsed.value, event)) continue;
      if (!contexts.has(event)) contexts.set(event, await port.context(tenantId, event).catch(() => null));
      const base = contexts.get(event) ?? null;
      const changed = new Set(event.type === "attribute_changed" && event.attribute ? [event.attribute.toLowerCase()] : []);
      if (groupTri(parsed.value.filters.root, base ? contextAfter(base, event, now) : null, changed) !== false) {
        hit = true;
        break;
      }
    }
    if (!hit) continue;
    const kind = await classifyRule(tenantId, parsed.value, port);
    if (!kind) continue;
    const updatedAt = rule.updatedAt instanceof Date ? rule.updatedAt.toISOString() : typeof rule.updatedAt === "string" ? rule.updatedAt : "-";
    out.matches.push({ ruleId: rule.id, name: rule.name, updatedAt, sends: kind.sends, spends: kind.spends });
    if (kind.spends === "messaging" || (kind.spends === "ai" && out.spends === "none")) out.spends = kind.spends;
  }
  return out;
}

/** The effects an automation check adds: free text makes it a card; a paid step makes it a spend (4.2a). */
function automationEffects(check: AutomationCheck | null): Partial<Effects> {
  if (!check || check.matches.length === 0) return {};
  return { writes: true, messagesCustomers: true, armsAutomation: true, ...(check.spends !== "none" ? { spends: check.spends as Pot } : {}) };
}

/** Adds the 4.2a warning, a fact per rule (its name as workspace text) and the rule ids with their updatedAt to `material`. */
function withAutomation(preview: Preview, check: AutomationCheck | null): Preview {
  if (!check || check.matches.length === 0) return preview;
  const warnings = preview.warnings.includes("triggers_automation") ? preview.warnings : [...preview.warnings, "triggers_automation" as const];
  const facts = [...preview.facts, ...check.matches.map((m) => ({ labelKey: `card.fact.automation.${m.sends}`, value: u("workspace_text", m.name, 80) }))];
  const material = { ...preview.material };
  for (const m of check.matches) material[`rule:${m.ruleId}`] = m.updatedAt;
  return { ...preview, warnings, facts, material };
}

/** Re-scrubs every UntrustedText on a preview and makes it plain JSON, so its hash survives storage. */
const normalizePreview = (preview: Preview): Preview => toModelPayload(preview, [], { maxBytes: Number.MAX_SAFE_INTEGER, strict: false }).payload as Preview;

// ===== The gates =====

type Phase = "propose" | "confirm" | "revise" | "refresh" | "undo-card";

type Checked = {
  def: AnyActionDef;
  principal: Principal;
  ctx: ActionCtx;
  args: Record<string, unknown>;
  argsHash: string;
  a: Record<string, unknown>;
  effects: Effects;
  risk: Risk;
  automation: AutomationCheck | null;
  phase: Phase;
  now: Date;
};

/** G1 to G13. Throws Refusal; returns everything G14 onwards needs. */
async function runChecks(def: AnyActionDef | undefined, principal: Principal, rawArgs: unknown, phase: Phase, deps: InvokeDeps, now: Date, signal?: AbortSignal): Promise<Checked> {
  // G1
  if (!def || !def.surfaces.includes(principal.via)) throw refuse("unknown_action", 404);
  const tenantId = principal.actor.tenantId;
  // G2
  if (def.version === "v2") {
    const ready = deps.phase() >= 2 && (await deps.spendBridge.eddyAssistantReady(tenantId).catch(() => false));
    if (!ready) throw refuse("not_yet", 409);
  }
  // G3
  const raw = rawArgs === undefined || rawArgs === null ? {} : rawArgs;
  const invalid = validate(def.inputSchema, raw);
  if (invalid) throw new Refusal("invalid_args", 400, invalid);
  let args: Record<string, unknown>;
  try {
    args = canonicalClone<Record<string, unknown>>(raw);
  } catch (e) {
    throw new Refusal("invalid_args", 400, e instanceof Error ? e.message : "arguments could not be read.");
  }
  const argsHashValue = hashCanonical(args);
  // G4: always fresh for anything that may write and for card decisions; reads may reuse the 5 s memo.
  let p: Principal;
  try {
    p = await refreshPrincipal(principal, { fresh: phase !== "propose" || mayWrite(def), now });
  } catch (e) {
    if (e instanceof PrincipalRefusal) throw new Refusal(e.code, e.status, e.message);
    throw e;
  }
  // G5
  if (!hasRole(p.actor, def.minRole)) {
    const who = await deps.workspace.namesWithRole(tenantId, def.minRole).catch(() => []);
    throw refuse("role", 403, { requiredRole: def.minRole, who });
  }
  // G6
  if (isKeyPrincipal(p)) {
    if (!def.scopes || def.scopes.length === 0 || !holdsScope(p.scopes ?? [], def.scopes)) {
      throw new Refusal("scope", 403, def.scopes?.length ? missingScopeMessage(def.scopes) : ACTION_COPY.scope);
    }
  }
  // G7: writes and confirm-class actions, with the semantics getActor applies to the concrete route.
  if (mayWrite(def)) {
    const path = concretePath(def, args);
    try {
      assertEmailVerifiedForWrite(p.emailVerified ? new Date(0) : null, path);
    } catch {
      throw refuse("email_unverified", 403);
    }
    // Lowering (pause, stop, cancel, disable) skips the paywall, as Phase 0 does for /api/spend/.
    if (!staticLowers(def) && !PAYWALL_EXEMPT_PREFIXES.some((prefix) => path.startsWith(prefix))) {
      try {
        await deps.workspace.assertCanWrite(tenantId);
      } catch (e) {
        if (e instanceof HttpError) throw new Refusal("workspace_locked", e.status, e.message);
        throw e;
      }
    }
  }
  const ctx: ActionCtx = { p, now, ...(signal ? { signal } : {}) };
  // G8
  let a: Record<string, unknown>;
  try {
    a = def.normalize ? await def.normalize(ctx, args) : args;
  } catch (e) {
    if (e instanceof HttpError) throw e.status === 404 ? new Refusal("not_found", 404, e.message, { asFailure: true }) : fromHttpError(e);
    throw e;
  }
  // G8a: demo first (a demo number has no token), then the connected number.
  if (def.callsMeta && (await deps.spendBridge.isDemoWorkspace(tenantId).catch(() => false))) throw refuse("demo", 409);
  if (def.needsWhatsApp) {
    const demo = def.callsMeta ? false : await deps.spendBridge.isDemoWorkspace(tenantId).catch(() => false);
    if (!demo) {
      const state = await deps.workspace.whatsAppState(tenantId);
      if (state === "reconnect") throw refuse("reconnect", 409);
      if (state === "none") {
        if (hasRole(p.actor, "admin")) throw refuse("not_connected", 409);
        const who = await deps.workspace.namesWithRole(tenantId, "admin").catch(() => []);
        throw new Refusal("not_connected", 409, ACTION_COPY.not_connected_agent, { who });
      }
    }
  }
  // G9
  try {
    await def.authorize(ctx, a);
  } catch (e) {
    if (e instanceof HttpError) throw fromHttpError(e);
    throw e;
  }
  // G10: effects, with the automations this write would start.
  let effects: Effects = typeof def.effects === "function" ? await def.effects(a, ctx) : (def.effects as Effects);
  let automation: AutomationCheck | null = null;
  if (def.automationEvents) {
    const events = await def.automationEvents(ctx, a);
    automation = await checkAutomation(tenantId, events, deps.automation, now);
    effects = mergeEffects(effects, automationEffects(automation));
  }
  if (effects.returnsSecret && p.via === "eddy") throw refuse("not_allowed", 403);
  if (def.version === "v1" && automation && automation.spends !== "none") throw refuse("triggers_paid_rule", 409);
  if (def.version === "v1" && (effects.spends === "messaging" || effects.spends === "ads")) throw refuse("not_yet", 409);
  // (EDDY-05 acceptance 8, 15) v1 never arms an automation that spends: an AI agent or AI escalation is v2 too (4.6).
  if (def.version === "v1" && effects.armsAutomation && (effects.spends ?? "none") !== "none") throw refuse("not_yet", 409);
  let risk = effectiveRisk(def.risk, effects);
  if (phase === "revise" || phase === "refresh" || phase === "undo-card") risk = "confirm";
  // G11
  if (p.via === "system" && !effects.lowersActivity) throw refuse("role", 403, { requiredRole: def.minRole });
  // G12: the ops kill switch stops new Eddy work; cards that spend nothing can still be confirmed. Lowering always passes.
  const spends = (effects.spends ?? "none") !== "none";
  if (!effects.lowersActivity) {
    if (p.via === "eddy" && (phase === "propose" || spends) && (await deps.workspace.eddyPlatformDisabled().catch(() => false))) throw refuse("kill_switch", 503);
    if (spends) {
      let effective: string;
      try {
        effective = (await deps.spendBridge.freezeState(tenantId, { fresh: true })).effective;
      } catch {
        throw refuse("spend_not_set_up", 409);
      }
      if (effective !== "none") throw refuse("spend_frozen", 409);
    }
  }
  // G13
  const perAction = deps.limiter(`act:${def.name}`, def.rateLimit?.perPrincipalPerMin ?? DEFAULT_ACTION_PER_MIN);
  if (!perAction.consume(p.principalId, now.getTime())) throw refuse("rate_limited", 429);
  if (effects.writes || risk !== "instant") {
    const writes = deps.limiter("act:writes", WRITES_PER_USER_PER_MIN);
    if (!writes.consume(`${tenantId}:${p.actor.userId}`, now.getTime())) throw refuse("rate_limited", 429);
  }
  return { def, principal: p, ctx, args, argsHash: argsHashValue, a, effects, risk, automation, phase, now };
}

// ===== Invocation records =====

function invocationRow(c: { principal: Principal; name: string; risk: Risk; argsHash: string; args?: unknown; def?: AnyActionDef }, opId: string, stage: InvocationRow["stage"], outcome: InvocationOutcome, extra: Partial<InvocationRow> = {}): InvocationRow {
  const p = c.principal;
  return {
    tenantId: p.actor.tenantId,
    userId: p.actor.userId,
    via: p.via,
    principalId: p.principalId,
    opId,
    action: c.name,
    risk: c.risk,
    stage,
    outcome,
    argsHash: c.argsHash,
    argsRedacted: (c.args !== undefined ? (redactArgs(c.args, c.def?.inputSchema) as Record<string, unknown>) : {}) ?? {},
    conversationId: p.conversationId ?? null,
    turnId: p.turnId ?? null,
    ...extra,
  };
}

const safeArgsHash = (raw: unknown) => {
  try {
    return hashCanonical(raw ?? {});
  } catch {
    return sha256Hex("unhashable");
  }
};

// ===== Cards =====

function cardDto(record: ActionRecord, nonce: string, preview: Preview, lang: Principal["lang"], supersedes?: string): PendingCardDTO {
  return {
    actionId: record.id,
    action: record.action,
    nonce,
    previewHash: record.previewHash ?? "",
    preview,
    lang,
    state: "pending",
    createdAt: record.createdAt.toISOString(),
    expiresAt: (record.expiresAt ?? new Date(record.createdAt.getTime() + CARD_TTL_MS)).toISOString(),
    confirmGuardMs: CARD_CONFIRM_GUARD_MS,
    ...(supersedes ? { supersedes } : {}),
  };
}

async function buildPreview(c: Checked): Promise<Preview> {
  if (typeof c.def.preview !== "function") throw refuse("internal", 500);
  let preview: Preview;
  try {
    preview = await c.def.preview(c.ctx, c.a);
  } catch (e) {
    if (e instanceof HttpError) throw fromHttpError(e);
    throw e;
  }
  return normalizePreview(withAutomation(preview, c.automation));
}

/** G14 for confirm class: preview, limits, a pending ActionRecord with nonceHash and a 15-minute expiry. */
async function createCard(c: Checked, preview: Preview, opId: string, supersedes?: string): Promise<{ record: ActionRecord; card: PendingCardDTO; subjects: { contactIds: string[]; conversationIds: string[] } }> {
  const p = c.principal;
  // The preview holds names, numbers and text of the contacts it is about: tag the record with them for erasure.
  const subjects = await subjectsOf(p.actor.tenantId, c.a, preview);
  const pHash = hashPreview(preview);
  const target = cardTarget(preview, c.argsHash);
  const slots = await reserveCardSlot({ tenantId: p.actor.tenantId, userId: p.actor.userId, turnId: p.turnId ?? null, action: c.def.name, target, now: c.now });
  if (!slots.ok) throw refuse(slots.code, 429);
  const nonce = randomBytes(32).toString("base64url");
  const spends = c.effects.spends ?? "none";
  const record = await insertActionRecord({
    id: newActionId(),
    tenantId: p.actor.tenantId,
    userId: p.actor.userId,
    via: p.via,
    principalId: p.principalId,
    conversationId: p.conversationId ?? null,
    turnId: p.turnId ?? null,
    toolUseId: p.toolUseId ?? null,
    action: c.def.name,
    risk: "confirm",
    status: "pending",
    args: c.args,
    argsHash: c.argsHash,
    preview,
    previewHash: pHash,
    nonceHash: sha256Hex(nonce),
    expiresAt: new Date(c.now.getTime() + CARD_TTL_MS),
    spendPot: spends === "none" ? null : spends,
    contactIds: subjects.contactIds,
  });
  await supersedeCards(p.actor.tenantId, [...slots.supersede, ...(supersedes ? [supersedes] : [])], record.id, c.now);
  await writeInvocation(invocationRow({ principal: p, name: c.def.name, risk: "confirm", argsHash: c.argsHash, args: c.args, def: c.def }, opId, "preview", "needs_confirmation", { actionRecordId: record.id, resultRef: record.id }));
  return { record, card: cardDto(record, nonce, preview, p.lang, supersedes), subjects };
}

/**
 * The contacts and chats a call names (subjectIdsIn over its values), with the contact of every named chat added: a reply
 * card's arguments name only the chat, yet its preview holds the customer's name and number. Never throws.
 */
async function subjectsOf(tenantId: string, ...values: unknown[]): Promise<{ contactIds: string[]; conversationIds: string[] }> {
  const found = subjectIdsIn(...values);
  if (found.conversationIds.length === 0) return found;
  try {
    const chats = (await prisma.conversation.findMany({ where: { tenantId, id: { in: found.conversationIds } }, select: { contactId: true } })) as { contactId?: string | null }[];
    const contactIds = new Set(found.contactIds);
    for (const chat of chats ?? []) if (typeof chat?.contactId === "string" && contactIds.size < 200) contactIds.add(chat.contactId);
    return { contactIds: [...contactIds], conversationIds: found.conversationIds };
  } catch (e) {
    console.error("[actions] could not read the contacts of the chats a call names:", describeError(e));
    return found;
  }
}

// ===== Execution (G16 to G20) =====

type ExecResult =
  | { kind: "done"; actionId: string | null; payload: unknown; undoUntil: Date | null; ui?: UiHint; piiRefused: boolean; subjects: { contactIds: string[]; conversationIds: string[] } }
  | { kind: "failed"; actionId: string | null; code: RefusalCode; status: number; message: string }
  | { kind: "unknown"; actionId: string | null };

async function execute(c: Checked, o: { opId: string; deps: InvokeDeps; record: ActionRecord | null }): Promise<ExecResult> {
  const { def, principal: p, effects, now } = c;
  const tenantId = p.actor.tenantId;
  const spends = (effects.spends ?? "none") !== "none";
  // G16: Eddy's own rules before anything that spends (4.10a). Lowering never waits.
  if (spends && !effects.lowersActivity) {
    let effective: string;
    try {
      effective = (await o.deps.spendBridge.freezeState(tenantId, { fresh: true })).effective;
    } catch {
      throw refuse("spend_not_set_up", 409);
    }
    if (effective !== "none") throw refuse("spend_frozen", 409);
    if (effects.bulk || effects.spends === "ads") {
      const approver = p.actor.role === "owner" || (await o.deps.spendBridge.isApprover(tenantId, p.actor.userId).catch(() => false));
      if (!approver) throw refuse("needs_approver", 409, { who: await o.deps.spendBridge.approverNames(tenantId).catch(() => []) });
    }
  }
  const spendActor = buildSpendActor(p);
  const writes = effects.writes || c.risk !== "instant";
  const actionId = o.record?.id ?? (writes ? newActionId() : null);
  const idempotencyKey = actionId ?? o.opId;
  const strictAudit = Boolean(effects.messagesCustomers || effects.deletes || effects.external || spends);
  const name = auditName(p, def.name);
  const meta = { via: p.via, principalId: p.principalId, turnId: p.turnId ?? null, actionId, confirmedBy: o.record ? p.actor.userId : null };
  const base = { principal: p, name: def.name, risk: c.risk, argsHash: c.argsHash, args: c.args, def };
  const targetHint = routeParams(def, c.args).pop() ?? def.name;

  // G17: the request is on record before anything runs; if that write fails, nothing runs.
  try {
    if (strictAudit) await o.deps.audit.auditStrict({ tenantId, userId: p.actor.userId, action: name, target: targetHint, meta: { ...meta, stage: "requested" } });
    if (writes) await writeInvocationStrict(invocationRow(base, o.opId, "execute", "started", { actionRecordId: actionId, resultRef: actionId }));
  } catch (e) {
    console.error("[actions] could not record the request, so nothing ran:", describeError(e));
    if (o.record) await transition(tenantId, o.record.id, ["running"], { status: "failed", error: "internal" }, now);
    return { kind: "failed", actionId, code: "internal", status: 500, message: ACTION_COPY.internal };
  }

  // G18: run once. Once it has started it runs to the end, even if the member goes away (no abort signal is passed).
  const started = Date.now();
  let out: Awaited<ReturnType<AnyActionDef["run"]>>;
  try {
    out = await def.run({ p, now }, c.a, { idempotencyKey, spendActor });
  } catch (e) {
    // G19 for failures.
    const durationMs = Date.now() - started;
    if (e instanceof HttpError && e.status < 500) {
      const code = codeForHttpError(e);
      if (o.record) await transition(tenantId, o.record.id, ["running"], { status: "failed", error: e.message.slice(0, 500) }, now);
      if (strictAudit) await o.deps.audit.auditOutcome({ tenantId, userId: p.actor.userId, action: name, target: targetHint, meta: { ...meta, stage: "failed" } });
      await writeInvocation(invocationRow(base, o.opId, writes ? "execute" : "read", "failed", { code, actionRecordId: actionId, durationMs }));
      return { kind: "failed", actionId, code, status: e.status, message: e.message };
    }
    if (writes && isAmbiguous(e)) {
      // Never retried: the reconcile job reads the real state and settles the record.
      if (o.record) await transition(tenantId, o.record.id, ["running"], { status: "unknown" }, now);
      else if (actionId) {
        await insertActionRecord({ id: actionId, tenantId, userId: p.actor.userId, via: p.via, principalId: p.principalId, conversationId: p.conversationId ?? null, turnId: p.turnId ?? null, toolUseId: p.toolUseId ?? null, action: def.name, risk: c.risk, status: "unknown", args: c.args, argsHash: c.argsHash, decidedAt: now, contactIds: contactIdsIn(c.a) });
      }
      if (strictAudit) await o.deps.audit.auditOutcome({ tenantId, userId: p.actor.userId, action: name, target: targetHint, meta: { ...meta, stage: "unknown" } });
      await writeInvocation(invocationRow(base, o.opId, "execute", "unknown", { code: "outcome_unknown", actionRecordId: actionId, durationMs }));
      if (actionId) await o.deps.enqueue(RECONCILE_QUEUE, { tenantId, actionRecordId: actionId, action: def.name }).catch((err) => console.error("[actions] could not queue reconcile:", describeError(err)));
      return { kind: "unknown", actionId };
    }
    console.error(`[actions] ${def.name} failed:`, describeError(e));
    if (o.record) await transition(tenantId, o.record.id, ["running"], { status: "failed", error: "internal" }, now);
    if (strictAudit) await o.deps.audit.auditOutcome({ tenantId, userId: p.actor.userId, action: name, target: targetHint, meta: { ...meta, stage: "failed" } });
    await writeInvocation(invocationRow(base, o.opId, writes ? "execute" : "read", "failed", { code: "internal", actionRecordId: actionId, durationMs }));
    return { kind: "failed", actionId, code: "internal", status: 500, message: ACTION_COPY.internal };
  }

  // G19 for success: the outcome is audited (auditOutcome after a strict request, audit for other writes).
  const durationMs = Date.now() - started;
  const undoSpec = def.undo as UndoSpec | undefined;
  const undoable = Boolean(undoSpec && !def.isUndo && out.undo);
  const undoUntil = undoable && undoSpec ? new Date(now.getTime() + undoSpec.windowMs) : null;
  const outcomeMeta = { ...meta, stage: "done" };
  if (strictAudit) await o.deps.audit.auditOutcome({ tenantId, userId: p.actor.userId, action: name, target: out.auditTarget, meta: outcomeMeta });
  else if (writes) await o.deps.audit.audit({ tenantId, userId: p.actor.userId, action: name, target: out.auditTarget, meta: outcomeMeta });

  // G20: the model-facing projection, the 16 KB cap and the per-turn PII budget.
  let projected: ReturnType<typeof toModelPayload>;
  let projectionError: unknown = null;
  try {
    projected = toModelPayload(def.forModel(out.result, { p, now }), def.untrustedPaths, { strict: o.deps.strictUntrusted });
  } catch (e) {
    projectionError = e;
    projected = { payload: { note: "The result could not be shown." }, bytes: 0, truncated: false, wrapped: [] };
  }
  const pii = Math.max(0, Math.floor(def.piiItems?.(out.result) ?? 0));
  const piiOk = addPii(p.turnId, pii, now.getTime());
  const payload = piiOk ? projected.payload : { omitted: "pii_budget", note: ACTION_COPY.pii_budget };
  // Who the call ran on and who its result names (a chat read names the customer): the record and Eddy's stored
  // tool_result are tagged with them, so erasing the contact finds both.
  const items = (out.result as { items?: unknown } | null)?.items;
  const listed = def.area === "contacts" && Array.isArray(items) ? { contacts: items } : null;
  const subjects = await subjectsOf(tenantId, c.a, out.result, listed, { contactIds: out.contactIds ?? [] });

  // The record and the outcome row, written even when the projection failed (the action has run).
  if (o.record) {
    await transition(
      tenantId,
      o.record.id,
      ["running"],
      { status: "done", result: payload, contactIds: [...new Set([...(o.record.contactIds ?? []), ...subjects.contactIds])], ...(undoable ? { undo: out.undo, undoUntil } : {}) },
      now,
    );
  } else if (writes && actionId) {
    await insertActionRecord({
      id: actionId,
      tenantId,
      userId: p.actor.userId,
      via: p.via,
      principalId: p.principalId,
      conversationId: p.conversationId ?? null,
      turnId: p.turnId ?? null,
      toolUseId: p.toolUseId ?? null,
      action: def.name,
      risk: c.risk,
      status: "done",
      args: c.args,
      argsHash: c.argsHash,
      decidedAt: now,
      result: payload,
      undo: undoable ? out.undo : null,
      undoUntil,
      contactIds: contactIdsIn(c.a, subjects.contactIds),
    });
  }
  const readRefused = !writes && !piiOk;
  await writeInvocation(
    invocationRow(base, o.opId, writes ? "execute" : "read", readRefused ? "refused" : "ok", {
      code: piiOk ? null : "pii_budget",
      actionRecordId: actionId,
      resultRef: actionId,
      piiItems: pii,
      durationMs,
    }),
  );
  // A definition that puts plain text on an untrusted path fails loudly outside production (the write is already recorded).
  if (projectionError && (o.deps.strictUntrusted ?? process.env.NODE_ENV !== "production")) throw projectionError;
  const ui = def.forUi ? def.forUi(out.result, { p, now }) : undefined;
  return { kind: "done", actionId, payload, undoUntil, ...(ui ? { ui } : {}), piiRefused: readRefused, subjects };
}

// ===== Propose (from a model turn, a key, or a job) =====

export type ProposeOptions = { turnId?: string; toolUseId?: string; signal?: AbortSignal };

function refusalOutcome(e: Refusal, name: string, opId: string): InvokeOutcome {
  if (e.code === "invalid_args") {
    return { model: { status: "failed", code: "invalid_args", detail: failureDetail(e.message) }, isError: true, status: e.status, opId };
  }
  if (e.extra.asFailure) {
    return {
      model: { status: "failed", code: e.code, detail: failureDetail(e.message) },
      isError: false,
      status: e.status,
      opId,
      refused: { action: name, code: e.code, status: e.status, message: e.message },
    };
  }
  const model: ModelResult = {
    status: "refused",
    code: e.code,
    ...(e.extra.requiredRole ? { requiredRole: e.extra.requiredRole } : {}),
    ...(e.extra.who && e.extra.who.length > 0 ? { who: e.extra.who.map(teammateName) } : {}),
  };
  return {
    model,
    isError: false,
    status: e.status,
    opId,
    refused: { action: name, code: e.code, status: e.status, message: e.message, ...(e.extra.who?.length ? { who: e.extra.who } : {}), ...(e.extra.requiredRole ? { requiredRole: e.extra.requiredRole } : {}) },
  };
}

async function recordRefusal(principal: Principal, name: string, def: AnyActionDef | undefined, rawArgs: unknown, opId: string, e: Refusal): Promise<void> {
  const args = e.code === "invalid_args" || e.code === "unknown_action" ? undefined : rawArgs;
  await writeInvocation(
    invocationRow({ principal, name, risk: def ? effectiveRisk(def.risk, staticEffects(def) ?? { writes: true }) : "instant", argsHash: safeArgsHash(rawArgs), args, def }, opId, "refuse", "refused", {
      code: e.code,
    }),
  );
}

async function proposeInternal(principal: Principal, name: string, rawArgs: unknown, phase: Phase, deps: InvokeDeps, opts: ProposeOptions & { supersedes?: string } = {}): Promise<InvokeOutcome> {
  const now = deps.clock();
  const opId = newOpId();
  const p = opts.turnId || opts.toolUseId ? derivePrincipal(principal, { ...(opts.turnId ? { turnId: opts.turnId } : {}), ...(opts.toolUseId ? { toolUseId: opts.toolUseId } : {}) }) : principal;
  const def = actionByName(name);
  let c: Checked;
  try {
    c = await runChecks(def, p, rawArgs, phase, deps, now, opts.signal);
    if (c.risk === "confirm") {
      const preview = await buildPreview(c);
      const { record, card, subjects } = await createCard(c, preview, opId, opts.supersedes);
      return { model: { status: "preview_shown", actionId: record.id, note: PREVIEW_NOTE }, isError: false, status: 200, opId, actionId: record.id, risk: "confirm", card, subjects };
    }
  } catch (e) {
    if (e instanceof Refusal) {
      await recordRefusal(p, name, def, rawArgs, opId, e);
      return refusalOutcome(e, name, opId);
    }
    throw e;
  }
  let result: ExecResult;
  try {
    result = await execute(c, { opId, deps, record: null });
  } catch (e) {
    if (e instanceof Refusal) {
      await recordRefusal(c.principal, name, c.def, rawArgs, opId, e);
      return refusalOutcome(e, name, opId);
    }
    throw e;
  }
  return execOutcome(c, result, opId);
}

function execOutcome(c: Checked, result: ExecResult, opId: string): InvokeOutcome {
  const name = c.def.name;
  if (result.kind === "unknown") {
    return { model: { status: "outcome_unknown" }, isError: false, status: 202, opId, ...(result.actionId ? { actionId: result.actionId } : {}), risk: c.risk };
  }
  if (result.kind === "failed") {
    return {
      model: { status: "failed", code: result.code, detail: failureDetail(result.message) },
      isError: false,
      status: result.status,
      opId,
      ...(result.actionId ? { actionId: result.actionId } : {}),
      risk: c.risk,
      refused: { action: name, code: result.code, status: result.status, message: result.message },
    };
  }
  if (result.piiRefused) {
    return {
      model: { status: "refused", code: "pii_budget" },
      isError: false,
      status: 429,
      opId,
      risk: c.risk,
      refused: { action: name, code: "pii_budget", status: 429, message: ACTION_COPY.pii_budget },
      subjects: subjectIdsIn(c.a),
    };
  }
  const undoUntil = result.undoUntil?.toISOString();
  return {
    model: { status: "done", result: result.payload, undoAvailable: Boolean(result.undoUntil) },
    isError: false,
    status: 200,
    opId,
    ...(result.actionId ? { actionId: result.actionId } : {}),
    risk: c.risk,
    done: { actionId: result.actionId, action: name, summaryKey: `done.${name}`, vars: {}, ...(undoUntil ? { undoUntil } : {}) },
    ...(result.ui ? { ui: result.ui } : {}),
    subjects: result.subjects,
  };
}

/**
 * A tool call from the model (or a key, or a job). Reads and undoable writes run now; confirm-class actions return
 * `preview_shown` with a card for the browser and never call run().
 */
export async function proposeAction(principal: Principal, name: string, rawArgs: unknown, opts: ProposeOptions = {}, deps: Partial<InvokeDeps> = {}): Promise<InvokeOutcome> {
  return proposeInternal(principal, name, rawArgs, "propose", withDefaults(deps), opts);
}

// ===== Card routes (4.5): confirm, revise, refresh, cancel =====

/** The card's principal: the confirming member, in the card's conversation, outside any turn. */
function principalForRecord(principal: Principal, record: ActionRecord): Principal {
  const conversationId = record.conversationId ?? principal.conversationId;
  return derivePrincipal(principal, {
    turnId: undefined,
    toolUseId: undefined,
    conversationId: conversationId ?? undefined,
    principalId: principal.via === "eddy" ? `eddy:${principal.actor.userId}:${conversationId ?? "-"}` : principal.principalId,
  });
}

function missOutcome(reason: MissReason): CardOutcome {
  if (reason === "expired") return { status: 410, state: "expired", code: "expired", message: ACTION_COPY.expired };
  if (reason === "decided") return { status: 409, state: "refused", code: "already_decided", message: ACTION_COPY.already_decided };
  return { status: 404, state: "refused", code: "not_found", message: ACTION_COPY.card_not_found };
}

function refusalCard(e: Refusal): CardOutcome {
  return {
    status: e.status,
    state: CARD_STATE_FOR[e.code] ?? (e.extra.asFailure ? "failed" : "refused"),
    code: e.code,
    message: e.message,
    ...(e.extra.who?.length ? { who: e.extra.who } : {}),
    ...(e.extra.requiredRole ? { requiredRole: e.extra.requiredRole } : {}),
  };
}

function toBig(v: unknown): bigint | null {
  if (typeof v === "number" && Number.isInteger(v)) return BigInt(v);
  if (typeof v === "string" && /^-?\d{1,30}$/.test(v)) return BigInt(v);
  return null;
}

/**
 * Compares the material of the card the member saw with a fresh preview (4.5 step 4): any change in recipients, count,
 * template, text, target or matched automations is a change; a cost more than 0.5% higher is a change; a lower cost
 * proceeds with a note.
 */
export function compareMaterial(before: Record<string, unknown> | undefined | null, after: Record<string, unknown>): { changed: boolean; lower: boolean } {
  const a = before ?? {};
  const keys = new Set([...Object.keys(a), ...Object.keys(after)]);
  let lower = false;
  for (const key of keys) {
    if (!(key in a) || !(key in after)) return { changed: true, lower: false };
    if (key === "costMinor") {
      const x = toBig(a[key]);
      const y = toBig(after[key]);
      if (x === null || y === null) {
        if (String(a[key]) !== String(after[key])) return { changed: true, lower: false };
        continue;
      }
      if (y * 1000n > x * 1005n) return { changed: true, lower: false };
      if (y < x) lower = true;
      continue;
    }
    if (String(a[key]) !== String(after[key])) return { changed: true, lower: false };
  }
  return { changed: false, lower };
}

/**
 * The route builds `principal` from getActor(request) (eddyPrincipal with the session's sid); its conversationId may be
 * empty, because the card's own conversation is used. Only the card button calls this, with the nonce from the SSE card.
 */
export type ConfirmInput = { principal: Principal; actionId: string; nonce: string; previewHash: string };

/**
 * POST /api/actions/[id]/confirm (called only by the card button). The claim is atomic, so two confirms with one nonce run
 * once; G3 to G13 run again with the fresh actor; a changed preview supersedes the card and returns 409 with a new one.
 * No model call is made.
 */
export async function confirmAction(input: ConfirmInput, depsIn: Partial<InvokeDeps> = {}): Promise<CardOutcome> {
  const deps = withDefaults(depsIn);
  const now = deps.clock();
  const { principal } = input;
  if (!isId(input.actionId) || typeof input.nonce !== "string" || !input.nonce || input.nonce.length > 128 || typeof input.previewHash !== "string" || input.previewHash.length > 128) {
    return missOutcome("not_found");
  }
  const tenantId = principal.actor.tenantId;
  const userId = principal.actor.userId;
  const nonceHash = sha256Hex(input.nonce);
  const claimed = await claimPending({ id: input.actionId, tenantId, userId, nonceHash, previewHash: input.previewHash, now });
  if (!claimed) return missOutcome((await explainMiss({ id: input.actionId, tenantId, userId, nonceHash, previewHash: input.previewHash, now })).reason);

  const opId = newOpId();
  const def = actionByName(claimed.action);
  const p = principalForRecord(principal, claimed);
  if (!def) {
    await transition(tenantId, claimed.id, ["running"], { status: "failed", error: "unknown_action" }, now);
    return { status: 404, state: "failed", code: "unknown_action", message: ACTION_COPY.unknown_action };
  }

  let c: Checked;
  let fresh: Preview;
  try {
    c = await runChecks(def, p, claimed.args, "confirm", deps, now);
    fresh = await buildPreview(c);
  } catch (e) {
    if (!(e instanceof Refusal)) {
      await transition(tenantId, claimed.id, ["running"], { status: "failed", error: "internal" }, now);
      throw e;
    }
    await transition(tenantId, claimed.id, ["running"], { status: "refused", error: e.code }, now);
    await recordRefusal(p, def.name, def, claimed.args, opId, e);
    return refusalCard(e);
  }

  const material = (claimed.preview as { material?: Record<string, unknown> } | null)?.material;
  const cmp = compareMaterial(material, fresh.material);
  if (cmp.changed) {
    await transition(tenantId, claimed.id, ["running"], { status: "superseded" }, now);
    try {
      const { card, record } = await createCard(c, fresh, opId, claimed.id);
      await transition(tenantId, claimed.id, ["superseded"], { supersededById: record.id }, now);
      return { status: 409, state: "changed", code: "changed", message: ACTION_COPY.changed, card };
    } catch (e) {
      if (e instanceof Refusal) return refusalCard(e);
      throw e;
    }
  }

  let result: ExecResult;
  try {
    result = await execute(c, { opId, deps, record: claimed });
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    // needs_approver keeps the card open so it can be handed to an approver (4.10a); other refusals close it.
    if (e.code === "needs_approver") await transition(tenantId, claimed.id, ["running"], { status: "pending", decidedAt: null }, now);
    else await transition(tenantId, claimed.id, ["running"], { status: "refused", error: e.code }, now);
    await recordRefusal(c.principal, def.name, def, claimed.args, opId, e);
    return refusalCard(e);
  }
  if (result.kind === "unknown") return { status: 202, state: "unknown", code: "outcome_unknown", message: ACTION_COPY.outcome_unknown, actionId: claimed.id };
  if (result.kind === "failed") return { status: result.status, state: CARD_STATE_FOR[result.code] ?? "failed", code: result.code, message: result.message, actionId: claimed.id };
  return {
    status: 200,
    state: "done",
    actionId: claimed.id,
    result: result.payload,
    ...(result.undoUntil ? { undoUntil: result.undoUntil.toISOString() } : {}),
    ...(cmp.lower ? { note: "cost_lower" as const } : {}),
    ...(result.ui ? { ui: result.ui } : {}),
  };
}

export type ReviseInput = { principal: Principal; actionId: string; nonce: string; edits: Record<string, unknown> };

function cardFromOutcome(outcome: InvokeOutcome): CardOutcome {
  if (outcome.card) return { status: 200, state: "pending", card: outcome.card, actionId: outcome.card.actionId };
  const r = outcome.refused;
  const code = r?.code ?? (outcome.model.status === "failed" || outcome.model.status === "refused" ? outcome.model.code : "internal");
  const message = r?.message ?? (outcome.model.status === "failed" ? outcome.model.detail.text : ACTION_COPY.internal);
  return { status: outcome.status >= 400 ? outcome.status : 500, state: CARD_STATE_FOR[code] ?? "refused", code, message, ...(r?.who?.length ? { who: r.who } : {}) };
}

/**
 * POST /api/actions/[id]/revise {nonce, edits}: only the definition's editable fields; the merged arguments go through
 * G3 to G14 again with no model call, the old card is superseded and a new one returned. A refused edit leaves the old
 * card open.
 */
export async function reviseAction(input: ReviseInput, depsIn: Partial<InvokeDeps> = {}): Promise<CardOutcome> {
  const deps = withDefaults(depsIn);
  const now = deps.clock();
  const { principal } = input;
  const tenantId = principal.actor.tenantId;
  const userId = principal.actor.userId;
  if (!isId(input.actionId) || typeof input.nonce !== "string" || !input.nonce || input.nonce.length > 128) return missOutcome("not_found");
  const nonceHash = sha256Hex(input.nonce);
  const record = await findActionRecord(tenantId, input.actionId);
  if (!record || record.userId !== userId || record.nonceHash !== nonceHash) return missOutcome("not_found");
  const def = actionByName(record.action);
  if (!def) return missOutcome("not_found");
  const edits = input.edits && typeof input.edits === "object" && !Array.isArray(input.edits) ? input.edits : null;
  const allowed = (def.editable ?? []) as readonly string[];
  const keys = edits ? Object.keys(edits) : [];
  if (!edits || keys.length === 0 || keys.some((k) => !allowed.includes(k))) {
    return { status: 400, state: "refused", code: "invalid_edit", message: allowed.length ? `${ACTION_COPY.invalid_edit} You can change: ${allowed.join(", ")}.` : ACTION_COPY.invalid_edit };
  }
  // Claim the old card first, so it cannot be confirmed while it is being replaced.
  const claimed = await transition(tenantId, record.id, ["pending"], { status: "superseded", decidedAt: now }, now, { userId, nonceHash, expiresAt: { gt: now } });
  if (claimed !== 1) return missOutcome((await explainMiss({ id: record.id, tenantId, userId, nonceHash, now })).reason);
  const merged = { ...asRecord(record.args), ...edits };
  const outcome = await proposeInternal(principalForRecord(principal, record), def.name, merged, "revise", deps, { supersedes: record.id });
  if (!outcome.card) {
    await transition(tenantId, record.id, ["superseded"], { status: "pending", decidedAt: null }, now, { supersededById: null });
    return cardFromOutcome(outcome);
  }
  await transition(tenantId, record.id, ["superseded"], { supersededById: outcome.card.actionId }, now);
  return cardFromOutcome(outcome);
}

/** POST /api/actions/[id]/refresh: an expired card gets a fresh preview and a new card, with no model call. */
export async function refreshAction(input: { principal: Principal; actionId: string }, depsIn: Partial<InvokeDeps> = {}): Promise<CardOutcome> {
  const deps = withDefaults(depsIn);
  const now = deps.clock();
  const { principal } = input;
  const tenantId = principal.actor.tenantId;
  const record = isId(input.actionId) ? await findActionRecord(tenantId, input.actionId) : null;
  if (!record || record.userId !== principal.actor.userId) return missOutcome("not_found");
  if (record.status === "pending") {
    if (record.expiresAt && record.expiresAt.getTime() > now.getTime()) return { status: 409, state: "pending", code: "not_expired", message: ACTION_COPY.not_expired };
    await transition(tenantId, record.id, ["pending"], { status: "expired" }, now);
  } else if (record.status !== "expired") {
    return missOutcome("decided");
  }
  if (record.supersededById) return missOutcome("decided");
  const def = actionByName(record.action);
  if (!def) return missOutcome("not_found");
  const outcome = await proposeInternal(principalForRecord(principal, record), def.name, record.args, "refresh", deps, { supersedes: record.id });
  if (outcome.card) await transition(tenantId, record.id, ["expired"], { supersededById: outcome.card.actionId }, now);
  return cardFromOutcome(outcome);
}

/** POST /api/actions/[id]/cancel {nonce}: pending -> cancelled. */
export async function cancelAction(input: { principal: Principal; actionId: string; nonce: string }, depsIn: Partial<InvokeDeps> = {}): Promise<CardOutcome> {
  const deps = withDefaults(depsIn);
  const now = deps.clock();
  const tenantId = input.principal.actor.tenantId;
  const userId = input.principal.actor.userId;
  if (!isId(input.actionId) || typeof input.nonce !== "string" || !input.nonce || input.nonce.length > 128) return missOutcome("not_found");
  const nonceHash = sha256Hex(input.nonce);
  const n = await transition(tenantId, input.actionId, ["pending"], { status: "cancelled", decidedAt: now }, now, { userId, nonceHash, expiresAt: { gt: now } });
  if (n === 1) return { status: 200, state: "cancelled", actionId: input.actionId };
  return missOutcome((await explainMiss({ id: input.actionId, tenantId, userId, nonceHash, now })).reason);
}

// ===== Undo (4.5) =====

/**
 * POST /api/actions/[id]/undo, and undo_last_action. Allowed for the member who acted or an admin, inside the 15-minute
 * window, while stillApplies() holds. The inverse goes through the gates (fresh principal, surface, the action's minRole,
 * key scope, verified email and paywall, the definition's undo guard, rate limit, the 4.2a automation check) and is audited
 * as eddy.undo. When the inverse is itself a card (it would message customers or spend), a card for inverseAction is
 * returned instead.
 */
export async function undoAction(input: { principal: Principal; actionId: string }, depsIn: Partial<InvokeDeps> = {}): Promise<CardOutcome> {
  const deps = withDefaults(depsIn);
  const now = deps.clock();
  const opId = newOpId();
  const tenantId = input.principal.actor.tenantId;
  const record = isId(input.actionId) ? await findActionRecord(tenantId, input.actionId) : null;
  if (!record) return missOutcome("not_found");

  let p: Principal;
  try {
    p = await refreshPrincipal(principalForRecord(input.principal, record), { fresh: true, now });
  } catch (e) {
    if (e instanceof PrincipalRefusal) return { status: e.status, state: "refused", code: e.code, message: e.message };
    throw e;
  }
  if (record.userId !== p.actor.userId && !hasRole(p.actor, "admin")) return missOutcome("not_found");
  if (record.status === "undone" || record.undoneAt) return { status: 409, state: "refused", code: "already_undone", message: ACTION_COPY.already_undone };
  const def = actionByName(record.action);
  const spec = def?.undo as UndoSpec | undefined;
  if (!def || !spec || record.status !== "done" || !record.undo || !record.undoUntil) return { status: 409, state: "refused", code: "not_undoable", message: ACTION_COPY.not_undoable };
  if (record.undoUntil.getTime() <= now.getTime()) return { status: 410, state: "refused", code: "undo_expired", message: ACTION_COPY.undo_expired };
  const undo = record.undo as unknown as UndoRecord;
  const ctx: ActionCtx = { p, now };
  const base = { principal: p, name: def.name, risk: "undoable" as Risk, argsHash: record.argsHash, args: record.args, def };
  const fail = async (code: keyof typeof ACTION_COPY, status: number, extra: { requiredRole?: Role } = {}): Promise<CardOutcome> => {
    await writeInvocation(invocationRow(base, opId, "undo", "refused", { code, actionRecordId: record.id }));
    return { status, state: "refused", code, message: ACTION_COPY[code], ...extra };
  };

  // The inverse runs through the same gates as the action (4.5): G1 surface, G5 the action's minRole with the fresh role,
  // G6 a key's scope. A member demoted since cannot undo what their old role allowed.
  if (!def.surfaces.includes(p.via)) return fail("unknown_action", 404);
  if (!hasRole(p.actor, def.minRole)) return fail("role", 403, { requiredRole: def.minRole });
  if (isKeyPrincipal(p) && (!def.scopes || def.scopes.length === 0 || !holdsScope(p.scopes ?? [], def.scopes))) return fail("scope", 403);
  // G11: background jobs only lower activity, and undoing a lowering is a raise, so a job never undoes.
  if (p.via === "system") return fail("role", 403, { requiredRole: def.minRole });

  // The inverse is itself a card: resume a broadcast, turn an automation back on, restart a bot. It still needs the change
  // to stand (nobody resumed the broadcast since); the card then runs every gate for inverseAction.
  if (spec.inverseAction) {
    if (!(await spec.stillApplies(ctx, undo))) return fail("undo_changed", 409);
    const outcome = await proposeInternal(p, spec.inverseAction, spec.inverseArgs ? spec.inverseArgs(undo) : {}, "undo-card", deps);
    return cardFromOutcome(outcome);
  }

  // G7 for the inverse: it is a write, and undoing a lowering is a raise, so the paywall always applies.
  const path = concretePath(def, asRecord(record.args));
  try {
    assertEmailVerifiedForWrite(p.emailVerified ? new Date(0) : null, path);
  } catch {
    return fail("email_unverified", 403);
  }
  if (!PAYWALL_EXEMPT_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    try {
      await deps.workspace.assertCanWrite(tenantId);
    } catch (e) {
      if (e instanceof HttpError) {
        await writeInvocation(invocationRow(base, opId, "undo", "refused", { code: "workspace_locked", actionRecordId: record.id }));
        return { status: e.status, state: "refused", code: "workspace_locked", message: e.message };
      }
      throw e;
    }
  }
  // G9 for the inverse: the definition's route-equivalent guard for undoing, when it has one. inverse() itself uses the
  // actor-aware operations (assignAsActor, setTagsAsActor, updateContact(actor)), like run().
  if (spec.authorize) {
    try {
      await spec.authorize(ctx, undo);
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      const code = codeForHttpError(e);
      await writeInvocation(invocationRow(base, opId, "undo", "refused", { code, actionRecordId: record.id }));
      return { status: e.status, state: "refused", code, message: e.message };
    }
  }
  if (!deps.limiter("act:undo", DEFAULT_ACTION_PER_MIN).consume(p.principalId, now.getTime())) return fail("rate_limited", 429);
  if (!deps.limiter("act:writes", WRITES_PER_USER_PER_MIN).consume(`${tenantId}:${p.actor.userId}`, now.getTime())) return fail("rate_limited", 429);

  // 4.2a: an undo that would start a rule is not done in one tap.
  if (spec.automationEvents) {
    const check = await checkAutomation(tenantId, await spec.automationEvents(ctx, undo), deps.automation, now);
    if (check.matches.length > 0) return fail(check.spends !== "none" ? "triggers_paid_rule" : "triggers_automation", 409);
  }
  if (!(await spec.stillApplies(ctx, undo))) return fail("undo_changed", 409);

  // Claim: only one undo runs, even with two taps.
  const claimed = await transition(tenantId, record.id, ["done"], { undoneAt: now }, now, { undoneAt: null });
  if (claimed !== 1) return { status: 409, state: "refused", code: "already_undone", message: ACTION_COPY.already_undone };
  const meta = { via: p.via, principalId: p.principalId, turnId: null, actionId: record.id, action: def.name, undoneBy: p.actor.userId };
  try {
    await writeInvocationStrict(invocationRow(base, opId, "undo", "started", { actionRecordId: record.id }));
  } catch (e) {
    console.error("[actions] could not record the undo, so nothing ran:", describeError(e));
    await transition(tenantId, record.id, ["done"], { undoneAt: null }, now);
    return { status: 500, state: "failed", code: "internal", message: ACTION_COPY.internal };
  }
  const started = Date.now();
  try {
    await spec.inverse(ctx, undo);
  } catch (e) {
    await transition(tenantId, record.id, ["done"], { undoneAt: null }, now);
    const status = e instanceof HttpError && e.status < 500 ? e.status : 500;
    const code = e instanceof HttpError && e.status < 500 ? codeForHttpError(e) : "internal";
    if (status === 500) console.error(`[actions] undo of ${def.name} failed:`, describeError(e));
    await writeInvocation(invocationRow(base, opId, "undo", "failed", { code, actionRecordId: record.id, durationMs: Date.now() - started }));
    return { status, state: "failed", code, message: status === 500 ? ACTION_COPY.internal : (e as Error).message };
  }
  await transition(tenantId, record.id, ["done"], { status: "undone" }, now);
  await deps.audit.audit({ tenantId, userId: p.actor.userId, action: p.via === "eddy" ? "eddy.undo" : `${p.via}.undo`, target: record.id, meta });
  await writeInvocation(invocationRow(base, opId, "undo", "ok", { actionRecordId: record.id, durationMs: Date.now() - started }));
  return { status: 200, state: "undone", actionId: record.id };
}

/** undo_last_action: the member's own newest undoable action in this conversation. */
export async function undoLastAction(principal: Principal, depsIn: Partial<InvokeDeps> = {}): Promise<CardOutcome> {
  const deps = withDefaults(depsIn);
  if (!principal.conversationId) return { status: 404, state: "refused", code: "nothing_to_undo", message: ACTION_COPY.nothing_to_undo };
  const latest = await latestUndoable({ tenantId: principal.actor.tenantId, userId: principal.actor.userId, conversationId: principal.conversationId, now: deps.clock() });
  if (!latest) return { status: 404, state: "refused", code: "nothing_to_undo", message: ACTION_COPY.nothing_to_undo };
  return undoAction({ principal, actionId: latest.id }, deps);
}
