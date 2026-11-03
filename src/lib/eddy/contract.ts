/**
 * Eddy's shared contract (docs/EDDY-SPEC.md 5.7, 5.11, 5.12, 6.5, 6.7, 12.1a): languages, availability states, the SSE event
 * union of POST /api/eddy/turn, the card, status and notice DTOs, and the defaults. Types and pure functions only: no
 * database, no fetch, no model SDK. The UI, the API routes and the loop all build against these names, so they are stable;
 * later packages add local types instead of changing them.
 *
 * Owner decisions fixed here (Eddy 12.1a): Eddy is OFF by default (EDDY_ENABLED=false), v1 only (EDDY_PHASE=1), the model is
 * claude-sonnet-5-5 at effort low (decision 1). Replies are always richly styled (decision 0): the transcript renders
 * SafeMarkdown plus cards, status chips, preview and confirm cards with cost, undo bars and progress steps.
 */
import type { Preview } from "@/lib/actions/types";

// ===== Language (5.7) =====

/** Eddy replies in the member's language and script: English, Hindi (Devanagari) or Hinglish (Hindi in Roman script). */
export type EddyLang = "en" | "hi" | "hinglish";
export const EDDY_LANGS: readonly EddyLang[] = ["en", "hi", "hinglish"];
/** A member's saved preference; `auto` follows each message. */
export type EddyLangPref = "auto" | EddyLang;
/** The `lang` attribute of each transcript message (6.3). */
export const EDDY_HTML_LANG: Readonly<Record<EddyLang, string>> = { en: "en", hi: "hi", hinglish: "hi-Latn" };

/** A key of Eddy's i18n catalogue (src/lib/eddy/i18n.ts narrows this to its own key union). */
export type I18nKey = string;

// ===== Page context (5.6) =====

/** What the browser says the member is looking at (page-context.ts). Ids match /^[A-Za-z0-9_-]{1,64}$/. */
export type PageContext = {
  /** A stable page id such as "inbox.chat", "broadcasts.detail", "settings.spending". */
  id: string;
  conversationId?: string;
  contactId?: string;
  broadcastId?: string;
  templateId?: string;
  leadId?: string;
  /** The latest `wa:eddy-selection {type, id}` until the route changes. */
  selection?: { type: string; id: string };
};

/** A page context after verifyPageContext(): only ids the member may see survive. */
export type VerifiedPageContext = PageContext & { readonly verified: true };

// ===== Availability (5.11) =====

/** The order of 5.11: the first state that matches wins. */
export type EddyAvailability = "platform_off" | "locked" | "workspace_off" | "paused" | "allowance_used" | "user_capped" | "ready";
export const EDDY_AVAILABILITY_ORDER: readonly EddyAvailability[] = ["platform_off", "locked", "workspace_off", "paused", "allowance_used", "user_capped", "ready"];

/** Turn-level failures the loop reports in an `error` event (5.9, 5.11). */
export type EddyTurnErrorState =
  | "service_down"
  | "busy"
  | "turn_in_progress"
  | "rate_limited"
  | "message_too_long"
  | "truncated"
  | "refusal_pause"
  | "internal";

/** Every state the panel can be put in by the status call or by a turn. */
export type EddyState = EddyAvailability | EddyTurnErrorState;

/** Why Eddy is platform_off (critic): not configured yet, or paused by the Edwyz team (kill switch or an auth failure). */
export type EddyOffReason = "not_configured" | "paused";

/** WhatsApp connection as Eddy needs it (6.14). */
export type EddyWhatsAppState = "connected" | "none" | "reconnect";

/** GET /api/eddy/status (EDDY-11 acceptance 2 and 6). No model call is made to build it. */
export type EddyStatusDTO = {
  state: EddyAvailability;
  /** Only with state platform_off. */
  reason?: EddyOffReason;
  /** True when the member's email is unverified: questions work, actions need a verified email. */
  readOnly: boolean;
  /**
   * The workspace OWNER only (Eddy 12.1a decision 6): only the owner turns Eddy on, and that tap records the AI-processing
   * consent. Admins and agents never get the enable card; PUT /api/eddy/settings answers them 403.
   */
  canEnable: boolean;
  /** The owner's name(s), for "Ask the owner: {names}" (copy off.workspace.agent). Never the admins. */
  ownerNames: string[];
  /** The workspace's AI allowance in credits (Phase 0 headroom('ai')). Null limit = not set. */
  allowance: {
    usedToday: number;
    limitToday: number | null;
    usedMonth: number;
    limitMonth: number | null;
    /** ISO date the exhausted period resets. */
    resetsOn: string | null;
    /**
     * Which period is used up for Eddy: "month" or "day" once what is left is below the smallest possible turn, null while
     * there is room. The panel's copy follows this, never its own comparison of the figures.
     */
    period?: "day" | "month" | null;
    /** The member's own Eddy credits today and their daily cap (5.10). */
    memberUsedToday: number;
    memberLimitToday: number;
  };
  langPref: EddyLangPref;
  /** Count of notices that need the member. */
  needsYou: number;
  demo: boolean;
  whatsapp: EddyWhatsAppState;
  phase: 1 | 2;
  /** No EddyUserPref first-use acknowledgement for the current LEGAL.version yet (6.11). */
  firstUse: boolean;
  /** A workspace or platform spending stop is on: Eddy chats but prepares nothing that spends. */
  spendingStopped: boolean;
};

// ===== Cards (4.5, 6.5) =====

/** What a card shows after a tap, and the critic states of 6.5. */
export type CardState =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "changed"
  | "expired"
  | "cancelled"
  | "unknown"
  | "needs_approver"
  | "awaiting_approval"
  | "spend_frozen"
  | "spend_not_set_up"
  | "spend_refused"
  | "demo"
  | "not_connected"
  | "reconnect";

/** Confirm stays aria-disabled this long after a card appears (6.5); there is no "Confirm all". */
export const CARD_CONFIRM_GUARD_MS = 600;
/** A pending card expires after 15 minutes; [Refresh preview] re-runs the preview with no AI. */
export const CARD_TTL_MS = 15 * 60_000;
/** Undo lasts 15 minutes for the member who acted, or an admin (6.6). */
export const UNDO_WINDOW_MS = 15 * 60_000;
export const MAX_NEW_CARDS_PER_TURN = 3;
export const MAX_PENDING_CARDS_PER_MEMBER = 5;

/**
 * A preview card as the browser receives it in the SSE `card` event. It carries the single-use nonce, which never enters any
 * model-visible content. Every word is rendered from the catalogue (`preview` holds keys and values), except content the
 * model drafted, which the card shows verbatim as exactly what will be sent.
 */
export type PendingCardDTO = {
  actionId: string;
  action: string;
  nonce: string;
  previewHash: string;
  preview: Preview;
  lang: EddyLang;
  state: CardState;
  createdAt: string;
  expiresAt: string;
  confirmGuardMs: number;
  /** Extra data for non-pending states: the refusal code, catalogue params, or names for needs_approver. */
  stateDetail?: { code?: string; params?: Record<string, string | number>; names?: string[] };
  /** The card this one replaces (409 changed, revise, refresh). */
  supersedes?: string;
};

// ===== Streaming events (5.12) =====

export type EddyIntentKind = "navigate" | "composer_draft" | "open_templates" | "connect_whatsapp" | "connect_facebook";

/** Events of POST /api/eddy/turn, in order of a normal turn: turn, status*, delta*, message, card*, done_action*, end. */
export type EddyEvent =
  | { type: "turn"; turnId: string; conversationId: string; lang: EddyLang }
  | { type: "status"; text?: string; key?: I18nKey }
  | { type: "delta"; text: string }
  | { type: "message"; text: string; lang: EddyLang }
  | { type: "reset" }
  | { type: "card"; card: PendingCardDTO }
  | { type: "done_action"; actionId: string; summaryKey: I18nKey; vars: Record<string, string | number>; undoUntil?: string }
  | { type: "refused_action"; action: string; code: string; who?: string[] }
  /** A `navigate` intent's payload path goes through safeAppPath() before the panel acts on it. */
  | { type: "intent"; kind: EddyIntentKind; payload: unknown }
  | { type: "end"; credits: number; truncated?: boolean }
  | { type: "error"; state: EddyState; params?: Record<string, string | number> };

export type EddyEventType = EddyEvent["type"];
export const EDDY_EVENT_TYPES: readonly EddyEventType[] = ["turn", "status", "delta", "message", "reset", "card", "done_action", "refused_action", "intent", "end", "error"];

// ===== Notices (6.7) =====

export type NoticeSeverity = "action_needed" | "heads_up" | "fyi";
export type NoticeSource = "eddy" | "spend" | "system";
export type NoticeKind =
  | "template_approved"
  | "template_rejected"
  | "template_paused"
  | "number_quality_dropped"
  | "failed_sends"
  | "approvals_waiting"
  | "token_expiring"
  | "token_expired"
  | "ai_limit_80"
  | "ai_limit_100"
  | "spending_stopped"
  | "automation_digest"
  | "setup_next_step"
  | "eddy_handoff"
  // Meta's ad review (docs/IG-PAGE-ADS-SPEC.md 3.9, PRM-08).
  | "ad_approved"
  | "ad_rejected";

// ===== In-app links (decision 0) =====

/**
 * The only places a button or a rendered link may lead: a path inside the signed-in app. Decision 0 allows links to
 * allowlisted /app paths only, so the renderer, notices and ui hints all pass every path through safeAppPath() before they
 * turn it into a button or an <a>. Anything else (another origin, javascript:, //host, backslashes, encoded tricks) is null.
 */
export const APP_LINK_PREFIXES: readonly string[] = ["/app"];

/** The path when it is a plain same-origin /app path (with an optional query or #fragment); otherwise null. */
export function safeAppPath(path: unknown): string | null {
  if (typeof path !== "string" || path.length === 0 || path.length > 512) return null;
  // Plain printable ASCII path characters only: no scheme, no backslash, no whitespace or control characters, no %-escapes
  // (an escaped "/" or "." could be decoded into another route later), no "//" (protocol-relative) and no dot segments.
  if (!/^\/[A-Za-z0-9\-._~/?#=&+:@!$'()*,;]*$/.test(path)) return null;
  const pathname = path.split(/[?#]/, 1)[0];
  if (pathname.includes("//") || /(^|\/)\.\.?(\/|$)/.test(pathname)) return null;
  return APP_LINK_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`)) ? path : null;
}

// ===== "Opens Meta" (E-R2, decision 10 extended to IG-PAGE-ADS-SPEC 8.4) =====

/**
 * The screens an "Opens Meta" button may name: Eddy's own three no-API screens (src/lib/eddy/meta-links.ts) and the ads screens
 * of IG-PAGE-ADS-SPEC 8.4 (src/lib/meta-connect/meta-screens.ts, the only allowlist of their addresses). Nothing else is ever
 * rendered as a Meta link (tests/eddy-meta-links.test.ts keeps this list equal to the union of the two files' keys).
 */
export const META_SCREEN_HINT_KEYS = [
  "payment_method",
  "business_verification",
  "display_name",
  "leadgen_tos",
  "custom_audience_tos",
  "link_whatsapp_to_page",
  "link_instagram_to_page",
  "page_advertise_task",
  "lead_access_manager",
  "appeal_ad",
  "account_quality",
] as const;
export type MetaScreenHintKey = (typeof META_SCREEN_HINT_KEYS)[number];

export const isMetaScreenHintKey = (v: unknown): v is MetaScreenHintKey => typeof v === "string" && (META_SCREEN_HINT_KEYS as readonly string[]).includes(v);

/**
 * The E-R2 UI hint: a labelled "Opens Meta" button. It is resolved on the server (meta-links.ts metaScreenHint) from a screen key
 * and validated ids, never from model text, and the card renders it only for an allowlisted key (ActionCard safeMetaScreenHint).
 * `labelKey` is a catalogue key: Eddy's `meta.screen.*` or a `promote.*` key (E-R5).
 */
export type MetaScreenHint = { kind: "meta_screen"; key: MetaScreenHintKey; href: string; labelKey: I18nKey };

/** Notice buttons never write and never carry text (critic): a navigation, an Eddy reference by id, or a fresh card. */
export type NoticeAction =
  /** `path` is rendered only through safeAppPath(); a path it refuses shows no button. */
  | { kind: "navigate"; path: string; labelKey: I18nKey }
  | { kind: "open_eddy"; ref: { kind: "notice"; noticeId: string } | { kind: "message"; messageId: string }; labelKey: I18nKey }
  | { kind: "card"; action: string; labelKey: I18nKey };

/** A notice for the "Needs you" strip and toasts. `payload` holds ids, counts and codes only, never customer text. */
export type NoticeDTO = {
  id: string;
  kind: NoticeKind | string;
  severity: NoticeSeverity;
  source: NoticeSource;
  textKey: I18nKey;
  payload: Record<string, string | number | boolean | null>;
  actions: NoticeAction[];
  subjectType: string | null;
  subjectId: string | null;
  count: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  resolvedAt: string | null;
  seenAt: string | null;
  dismissedAt: string | null;
  toastedAt: string | null;
};

// ===== Defaults and configuration (5.1, 5.9, 5.10, 12.1a) =====

export type EddyEffort = "low" | "medium" | "high" | "xhigh" | "max";

export const EDDY_DEFAULTS = {
  /** Off until ops sets EDDY_ENABLED=true; a key in .env alone never switches Eddy on (5.11). */
  enabled: false,
  /** v1 only. v2 spending actions need EDDY_PHASE=2 and the Phase 0 gates (4.10a). */
  phase: 1 as 1 | 2,
  /** Eddy 12.1a decision 1: Sonnet 5.5 at effort low; Opus 5.5 stays a one-env switch. */
  model: "claude-sonnet-5-5",
  effort: "low" as EddyEffort,
  maxTokens: 8000,
  minTokens: 2000,
  maxCreditsPerUserDay: 40,
  maxCreditsPerUnverifiedUserDay: 10,
  maxCreditsPerTurn: 30,
  maxConcurrentTurns: 40,
  /** 1 credit = 10,000 micro-USD (about USD 0.01). */
  microUsdPerCredit: 10_000,
  maxMessageChars: 2000,
  maxRoundsPerTurn: 8,
  maxToolCallsPerTurn: 12,
  turnWallClockMs: 120_000,
  streamLifetimeMs: 150_000,
  heartbeatMs: 15_000,
  tailCacheTtl: "5m" as "5m" | "1h",
  fallbacks: true,
  /** Eddy 12.1a decision 2: new and probation workspaces get 500 AI credits a month (inside the Phase 0 probation AI ceiling). */
  probationCreditsMonthly: 500,
  /** Eddy 12.1a decision 2: paid plans default to 1,500 AI credits a month, adjustable per plan. */
  paidPlanCreditsMonthly: 1500,
} as const;

export type EddyConfig = {
  enabled: boolean;
  phase: 1 | 2;
  model: string;
  effort: EddyEffort;
  maxTokens: number;
  maxCreditsPerUserDay: number;
  maxCreditsPerUnverifiedUserDay: number;
  maxCreditsPerTurn: number;
  maxConcurrentTurns: number;
  microUsdPerCredit: number;
  tailCacheTtl: "5m" | "1h";
  fallbacks: boolean;
};

const EFFORTS: readonly EddyEffort[] = ["low", "medium", "high", "xhigh", "max"];

/** The shape of a model id (Eddy 7.10): dots allowed, so a typo such as "claude-opus-5.5" is caught as unsupported, not as a shape error. */
export const EDDY_MODEL_ID = /^claude-[a-z0-9.-]{3,60}$/;

/**
 * Models Eddy's request shape works on (5.1, 5.3, 5.6): a mid-conversation `role: system` context note, adaptive thinking with
 * `output_config.effort`, `display: 'updates'` and `fallbacks: 'default'`. Sonnet 5 rejects the system note and Haiku 4.5
 * rejects adaptive thinking and effort, so they are refused here instead of failing every turn with a 400.
 */
export const EDDY_SUPPORTED_MODELS: readonly string[] = ["claude-sonnet-5-5", "claude-opus-5-5"];

export type EddyModelCheck = { ok: true; model: string } | { ok: false; reason: "shape" | "unsupported" | "not_allowed" };

/**
 * Checks an EDDY_MODEL value: the id shape, Eddy's supported list, and AI_ALLOWED_MODELS when that list is set (5.1: the
 * deploy adds EDDY_MODEL to it). src/lib/env-rules.mjs applies the same rule at startup.
 */
export function checkEddyModel(model: string, env: Record<string, string | undefined> = process.env): EddyModelCheck {
  if (!EDDY_MODEL_ID.test(model)) return { ok: false, reason: "shape" };
  if (!EDDY_SUPPORTED_MODELS.includes(model)) return { ok: false, reason: "unsupported" };
  const allowed = (env.AI_ALLOWED_MODELS ?? "").split(",").map((m) => m.trim()).filter(Boolean);
  if (allowed.length > 0 && !allowed.includes(model)) return { ok: false, reason: "not_allowed" };
  return { ok: true, model };
}

function positiveInt(raw: string | undefined, fallback: number, max = 1_000_000_000): number {
  const v = (raw ?? "").trim();
  if (!/^\d{1,10}$/.test(v)) return fallback;
  const n = Number(v);
  return n >= 1 && n <= max ? n : fallback;
}

/**
 * Eddy's configuration from the environment, every value falling back to EDDY_DEFAULTS. src/lib/env-rules.mjs refuses a bad
 * EDDY_MODEL at startup; if one gets here anyway it falls back to the default and `warn` says so (never silently).
 */
export function readEddyConfig(env: Record<string, string | undefined> = process.env, warn: (message: string) => void = console.warn): EddyConfig {
  const effort = (env.EDDY_EFFORT ?? "").trim().toLowerCase() as EddyEffort;
  const rawModel = (env.EDDY_MODEL ?? "").trim();
  const modelCheck = rawModel ? checkEddyModel(rawModel, env) : null;
  if (modelCheck && !modelCheck.ok) warn(`[eddy] EDDY_MODEL is ${modelCheck.reason === "shape" ? "not a model id" : modelCheck.reason === "unsupported" ? "not a model Eddy supports" : "not on AI_ALLOWED_MODELS"}; using ${EDDY_DEFAULTS.model}.`);
  return {
    enabled: (env.EDDY_ENABLED ?? "").trim() === "true",
    phase: (env.EDDY_PHASE ?? "").trim() === "2" ? 2 : 1,
    model: modelCheck?.ok ? modelCheck.model : EDDY_DEFAULTS.model,
    effort: EFFORTS.includes(effort) ? effort : EDDY_DEFAULTS.effort,
    maxTokens: Math.max(EDDY_DEFAULTS.minTokens, positiveInt(env.EDDY_MAX_TOKENS, EDDY_DEFAULTS.maxTokens, 128_000)),
    maxCreditsPerUserDay: positiveInt(env.EDDY_MAX_CREDITS_PER_USER_DAY, EDDY_DEFAULTS.maxCreditsPerUserDay),
    maxCreditsPerUnverifiedUserDay: EDDY_DEFAULTS.maxCreditsPerUnverifiedUserDay,
    maxCreditsPerTurn: positiveInt(env.EDDY_MAX_CREDITS_PER_TURN, EDDY_DEFAULTS.maxCreditsPerTurn),
    maxConcurrentTurns: positiveInt(env.EDDY_MAX_CONCURRENT_TURNS, EDDY_DEFAULTS.maxConcurrentTurns, 10_000),
    microUsdPerCredit: positiveInt(env.EDDY_MICROUSD_PER_CREDIT, EDDY_DEFAULTS.microUsdPerCredit),
    tailCacheTtl: (env.EDDY_TAIL_CACHE_TTL ?? "").trim() === "1h" ? "1h" : EDDY_DEFAULTS.tailCacheTtl,
    fallbacks: (env.EDDY_FALLBACKS ?? "").trim().toLowerCase() !== "off",
  };
}

/** The member's daily Eddy credit cap: 40, or 10 with an unverified email (5.10). */
export function memberDailyCreditCap(config: Pick<EddyConfig, "maxCreditsPerUserDay" | "maxCreditsPerUnverifiedUserDay">, emailVerified: boolean): number {
  return emailVerified ? config.maxCreditsPerUserDay : Math.min(config.maxCreditsPerUnverifiedUserDay, config.maxCreditsPerUserDay);
}

/** The cost could not be priced (NaN, Infinity, undefined: a model missing from the price table). */
export class UnpricedCostError extends RangeError {
  constructor() {
    super("The AI call's cost is not a finite number; settle it with settleCredits(), which charges the hold.");
    this.name = "UnpricedCostError";
  }
}

/**
 * Credits for a cost in micro-USD, rounded up (5.10 holdCredits). Throws UnpricedCostError on a cost that is not a finite
 * number, so a pricing gap is never read as 0 credits. Settlement uses settleCredits(), which fails closed instead.
 */
export function microUsdToCredits(microUsd: number | bigint, microUsdPerCredit: number = EDDY_DEFAULTS.microUsdPerCredit): number {
  if (typeof microUsd !== "bigint" && (typeof microUsd !== "number" || !Number.isFinite(microUsd))) throw new UnpricedCostError();
  if (!Number.isSafeInteger(microUsdPerCredit) || microUsdPerCredit < 1) throw new RangeError("microUsdPerCredit must be a positive whole number.");
  const micro = typeof microUsd === "bigint" ? microUsd : BigInt(Math.max(0, Math.ceil(microUsd)));
  if (micro <= 0n) return 0;
  const per = BigInt(microUsdPerCredit);
  return Number((micro + per - 1n) / per);
}

export type CreditSettlement = { credits: number; priced: true } | { credits: number; priced: false; reason: "unpriced" };

/**
 * Settles one AI call (5.10) and FAILS CLOSED: Anthropic has already billed the call, so a cost that cannot be priced
 * (NaN, Infinity, undefined, null: for example a fallback model missing from ai-pricing) charges the whole hold and reports
 * `priced: false` for the caller to alert on (`eddy.unpriced_model`). It never releases the reservation as 0 credits.
 */
export function settleCredits(callMicroUsd: number | bigint | null | undefined, holdCredits: number, microUsdPerCredit: number = EDDY_DEFAULTS.microUsdPerCredit): CreditSettlement {
  const hold = Number.isFinite(holdCredits) && holdCredits > 0 ? Math.ceil(holdCredits) : 0;
  if (callMicroUsd === null || callMicroUsd === undefined || (typeof callMicroUsd === "number" && !Number.isFinite(callMicroUsd))) {
    return { credits: hold, priced: false, reason: "unpriced" };
  }
  return { credits: microUsdToCredits(callMicroUsd, microUsdPerCredit), priced: true };
}

/** The cache-write figures of one response (usage.cache_creation) that settlement needs. */
export type CacheWriteUsage = { ephemeral1hInputTokens: number; cacheReadInputTokens: number };

/**
 * How many of a call's 1-hour cache-write tokens are the shared tools-plus-system prefix, which the platform absorbs (5.10).
 * The workspace pays those at the cache-read price; every other write is its own history and is charged in full.
 * - With the default 5-minute tail, only the prefix uses the 1-hour TTL, so all 1-hour writes are the prefix (capped at
 *   prefixTokens when that is known).
 * - With EDDY_TAIL_CACHE_TTL=1h the member's own history writes land in the same bucket. Then only the part of the prefix
 *   that was not read from cache counts, and with prefixTokens unknown nothing does: the workspace is never under-metered.
 */
export function platformPrefixWriteTokens(usage: CacheWriteUsage, o: { tailCacheTtl: "5m" | "1h"; prefixTokens: number | null }): number {
  const written = Math.max(0, Math.floor(usage.ephemeral1hInputTokens || 0));
  const prefix = o.prefixTokens !== null && Number.isFinite(o.prefixTokens) && o.prefixTokens > 0 ? Math.floor(o.prefixTokens) : null;
  if (o.tailCacheTtl === "5m") return prefix === null ? written : Math.min(written, prefix);
  if (prefix === null) return 0;
  const read = Math.max(0, Math.floor(usage.cacheReadInputTokens || 0));
  return Math.min(written, Math.max(0, prefix - read));
}
