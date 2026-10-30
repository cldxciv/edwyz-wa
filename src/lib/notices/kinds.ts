/**
 * The notice kinds (docs/EDDY-SPEC.md 6.7, EDDY-16) and the rules every notice obeys, whoever writes it.
 *
 * A notice is deterministic and generated on the server: no AI writes or reads it. What a row may hold:
 * - `payload`: ids, counts and codes only (6.7, 7.6). cleanPayload() keeps only the keys listed in PAYLOAD_KEYS and only
 *   values that are numbers, booleans, null or strings made of id and code characters (no spaces), so a contact name,
 *   a message body, a rejection reason or any other free text can never be stored, by mistake or otherwise.
 * - `actions`: buttons that never write and never carry text (6.7 critic): a navigation to an allowlisted /app path
 *   (safeAppPath), an intent that opens Eddy with a server-trusted reference (`{kind:'notice', noticeId}` or
 *   `{kind:'message', messageId}`), or a card the server builds fresh. cleanActions() drops anything else.
 * - The text is never stored either: the notice's kind and payload pick a catalogue key (textKeyFor), which the strip
 *   renders in the member's language (src/lib/eddy/copy/notices.ts). Names a key needs ({name}, {phone}, {names}) are
 *   resolved from the ids when the member reads the notice (service.ts), and are never written into the row.
 *
 * `eddy_handoff` is reserved for v2 (4.10a): it is listed so the store, the strip and the retention know it, and no v1
 * producer writes it.
 */
import { safeAppPath, type NoticeAction, type NoticeKind, type NoticeSeverity, type NoticeSource } from "@/lib/eddy/contract";
import type { Role } from "@/generated/prisma/client";

/** A notice expires 7 days after it starts (6.7). */
export const NOTICE_TTL_MS = 7 * 24 * 60 * 60_000;

export const NOTICE_SEVERITIES: readonly NoticeSeverity[] = ["action_needed", "heads_up", "fyi"];
export const NOTICE_SOURCES: readonly NoticeSource[] = ["eddy", "spend", "system"];

/** Every v1 kind plus the v2 hand-over, in the order the strip ranks equal-severity notices. */
export const NOTICE_KINDS: readonly NoticeKind[] = [
  "spending_stopped",
  "token_expired",
  "number_quality_dropped",
  "approvals_waiting",
  "ai_limit_100",
  "template_rejected",
  "failed_sends",
  "token_expiring",
  "ai_limit_80",
  "template_paused",
  "template_approved",
  "automation_digest",
  "setup_next_step",
  "eddy_handoff",
];

/** v2 only: no v1 producer writes these (4.10a). */
export const V2_KINDS: ReadonlySet<NoticeKind> = new Set<NoticeKind>(["eddy_handoff"]);

export type KindSpec = {
  severity: NoticeSeverity;
  /** The lowest role that sees a workspace-wide notice of this kind (per-member notices set audienceUserId instead). */
  minRole: Role;
  /** Needs a WhatsApp number: skipped for a workspace that has none (6.7 critic). */
  numberBased: boolean;
};

export const KIND_SPECS: Readonly<Record<NoticeKind, KindSpec>> = {
  template_approved: { severity: "heads_up", minRole: "admin", numberBased: false },
  template_rejected: { severity: "action_needed", minRole: "admin", numberBased: false },
  template_paused: { severity: "heads_up", minRole: "admin", numberBased: false },
  number_quality_dropped: { severity: "heads_up", minRole: "admin", numberBased: true },
  failed_sends: { severity: "heads_up", minRole: "admin", numberBased: true },
  approvals_waiting: { severity: "action_needed", minRole: "admin", numberBased: false },
  token_expiring: { severity: "heads_up", minRole: "admin", numberBased: false },
  token_expired: { severity: "action_needed", minRole: "admin", numberBased: false },
  ai_limit_80: { severity: "heads_up", minRole: "admin", numberBased: false },
  ai_limit_100: { severity: "action_needed", minRole: "admin", numberBased: false },
  spending_stopped: { severity: "heads_up", minRole: "agent", numberBased: false },
  automation_digest: { severity: "fyi", minRole: "admin", numberBased: false },
  setup_next_step: { severity: "fyi", minRole: "admin", numberBased: false },
  eddy_handoff: { severity: "action_needed", minRole: "admin", numberBased: false },
};

export const isNoticeKind = (v: unknown): v is NoticeKind => typeof v === "string" && (NOTICE_KINDS as readonly string[]).includes(v);
export const isSeverity = (v: unknown): v is NoticeSeverity => typeof v === "string" && (NOTICE_SEVERITIES as readonly string[]).includes(v);

// ===== Dedupe keys (6.7 coalescing: one notice per subject and condition) =====

export const dedupe = {
  template: (templateId: string, status: string) => `template:${templateId}:${status}`,
  quality: (phoneId: string, rating: "YELLOW" | "RED") => `quality:${phoneId}:${rating}`,
  /** A broadcast's failures, or a day's: per member for their own sends, workspace-wide for automatic ones. */
  failures: (scope: { broadcastId: string } | { day: string; userId?: string | null }, code: string) =>
    "broadcastId" in scope ? `failures:${scope.broadcastId}:${code}` : scope.userId ? `failures:${scope.day}:${code}:u:${scope.userId}` : `failures:${scope.day}:${code}`,
  approvals: (userId: string) => `approvals:${userId}`,
  token: (state: "expiring" | "expired") => `token:${state}`,
  spending: (scope: "workspace" | "platform", level: string) => `spending:${scope}:${level}`,
  digest: (day: string) => `digest:${day}`,
  setup: (stepId: string) => `setup:${stepId}`,
} as const;

/** A dedupe key: id and code characters, at most 200. */
export const DEDUPE_KEY = /^[A-Za-z0-9_.:,*\-]{1,200}$/;

// ===== Payload: ids, counts and codes only =====

/**
 * The only payload keys a notice may store. Each holds an id, a list of ids (comma separated), a count, a code, a level or
 * a date key. There is deliberately no key for a name, a text, a reason or a body. `title`, `body` and `link` are Phase 0's
 * own in-app rows (source 'spend', written by src/lib/spend/notify), which carry Phase 0's English sentences; Eddy's
 * producers never write them.
 */
export const PAYLOAD_KEYS: ReadonlySet<string> = new Set([
  "templateId",
  "status",
  "phoneId",
  "rating",
  "breakerId",
  "broadcastIds",
  "broadcastId",
  "conversationId",
  "messageId",
  "userId",
  "byUserId",
  "byKind",
  "scope",
  "level",
  "period",
  "periodKey",
  "used",
  "limit",
  "code",
  "count",
  "day",
  "state",
  "daysLeft",
  "stepId",
  "spend",
  "client",
  "optimizer",
  "ai",
  "handoff",
  "bots",
  "rules",
  "actionId",
  "action",
  "outcome",
  "approvalId",
  "correlationId",
]);

/** An id, a code or a comma-separated id list: letters, digits and _ . : , - only. No spaces, so no sentence fits. */
export const SAFE_VALUE = /^[A-Za-z0-9_.:,\-]{0,400}$/;

export type NoticePayload = Record<string, string | number | boolean | null>;

/** The payload with every key outside PAYLOAD_KEYS and every value that is not an id, code, number or flag removed. */
export function cleanPayload(raw: unknown): NoticePayload {
  const out: NoticePayload = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!PAYLOAD_KEYS.has(key)) continue;
    if (value === null || typeof value === "boolean") out[key] = value;
    else if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    else if (typeof value === "string" && SAFE_VALUE.test(value)) out[key] = value;
  }
  return out;
}

/** True when cleanPayload would keep everything: what producers must hand to publishNotice. */
export function payloadIsClean(raw: Record<string, unknown>): boolean {
  return Object.keys(cleanPayload(raw)).length === Object.keys(raw).length;
}

// ===== Actions: navigate, open Eddy by id, or a fresh card =====

const ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Stored in place of a notice's own id before the row exists; replaced by the row id when it is read. */
export const SELF = "self";
const LABEL_KEY = /^[a-z][a-z0-9_.]{1,80}$/;
const ACTION_NAME = /^[a-z][a-z0-9_]{1,63}$/;
/** At most three buttons on one notice. */
export const MAX_NOTICE_ACTIONS = 3;

/**
 * The actions with everything unsafe removed. A navigation keeps only a path safeAppPath() accepts; an open_eddy action
 * keeps only an id reference (a notice reference always points at the notice itself: `selfId` when it is known); a card
 * keeps only an action name. Labels are catalogue keys. Anything else, including any text, is dropped.
 */
export function cleanActions(raw: unknown, selfId?: string): NoticeAction[] {
  if (!Array.isArray(raw)) return [];
  const out: NoticeAction[] = [];
  for (const item of raw) {
    if (out.length >= MAX_NOTICE_ACTIONS) break;
    if (!item || typeof item !== "object") continue;
    const a = item as Record<string, unknown>;
    if (typeof a.labelKey !== "string" || !LABEL_KEY.test(a.labelKey)) continue;
    const labelKey = a.labelKey;
    if (a.kind === "navigate") {
      const path = safeAppPath(a.path);
      if (path) out.push({ kind: "navigate", path, labelKey });
    } else if (a.kind === "open_eddy") {
      const ref = a.ref && typeof a.ref === "object" ? (a.ref as Record<string, unknown>) : null;
      if (ref?.kind === "notice") {
        // A notice button only ever refers to its own notice: whatever id was stored is replaced.
        const noticeId = selfId ?? SELF;
        if (ID.test(noticeId)) out.push({ kind: "open_eddy", ref: { kind: "notice", noticeId }, labelKey });
      } else if (ref?.kind === "message" && typeof ref.messageId === "string" && ID.test(ref.messageId)) {
        out.push({ kind: "open_eddy", ref: { kind: "message", messageId: ref.messageId }, labelKey });
      }
    } else if (a.kind === "card" && typeof a.action === "string" && ACTION_NAME.test(a.action)) {
      out.push({ kind: "card", action: a.action, labelKey });
    }
  }
  return out;
}

/** Builders for the three action shapes (labels are core catalogue keys). */
export const act = {
  go: (path: string, labelKey: string): NoticeAction => ({ kind: "navigate", path, labelKey }),
  /** Opens Eddy with this notice as the reference: Eddy fetches whatever text it needs through a tool (UntrustedText). */
  askEddy: (labelKey: string): NoticeAction => ({ kind: "open_eddy", ref: { kind: "notice", noticeId: SELF }, labelKey }),
  card: (action: string, labelKey: string): NoticeAction => ({ kind: "card", action, labelKey }),
};

// ===== Text keys =====

/** The 9 setup steps (src/lib/setup/checklist.ts STEP_IDS) that have their own "next step" line. */
export const SETUP_STEP_KEYS: ReadonlySet<string> = new Set(["connect", "template", "contacts", "broadcast", "invite", "routing", "automation", "facebook", "plan"]);

/** The failure codes with their own explanation (6.7). */
export const EXPLAINED_CODES: ReadonlySet<string> = new Set(["131047", "131026", "131049"]);

/**
 * The catalogue key of a notice's text, from its kind, payload and source. Keys starting with `notice.` are core keys
 * (src/lib/eddy/copy/en.ts); `notices.` keys are in src/lib/eddy/copy/notices.ts.
 */
export function textKeyFor(kind: string, payload: NoticePayload, source: string = "eddy"): string {
  if (source === "spend" && kind !== "ai_limit_80" && kind !== "ai_limit_100") return "notices.spend_fallback";
  const period = payload.period === "day" ? "day" : "month";
  switch (kind) {
    case "template_approved":
      return "notice.template_approved";
    case "template_rejected":
      return "notices.template_rejected";
    case "template_paused":
      return payload.status === "flagged" ? "notices.template_flagged" : "notices.template_paused";
    case "number_quality_dropped":
      if (payload.rating === "RED") return typeof payload.count === "number" && payload.count > 0 ? "notice.quality_low" : "notices.quality_low_none";
      return "notices.quality_medium";
    case "failed_sends": {
      const code = typeof payload.code === "string" ? payload.code : "";
      return EXPLAINED_CODES.has(code) ? `notices.failed.${code}` : "notices.failed.other";
    }
    case "approvals_waiting":
      return payload.count === 1 ? "notices.approvals_one" : "notice.approvals";
    case "token_expiring":
      return "notices.token_expiring";
    case "token_expired":
      return "notices.token_expired";
    case "ai_limit_80":
      return `notices.ai_80.${period}`;
    case "ai_limit_100":
      return `notices.ai_100.${period}`;
    case "spending_stopped":
      if (payload.scope === "platform") return "notices.spending.platform";
      if (payload.level === "assistants") return "notices.spending.assistants";
      return payload.byUserId ? "notices.spending.workspace" : "notices.spending.workspace_anon";
    case "automation_digest":
      return typeof payload.ai === "number" && payload.ai > 0 ? "notices.digest.ai" : "notices.digest.other";
    case "setup_next_step":
      return typeof payload.stepId === "string" && SETUP_STEP_KEYS.has(payload.stepId) ? `notices.setup.${payload.stepId}` : "notices.generic";
    case "eddy_handoff":
      return "notices.eddy_handoff";
    case "action_done":
      return "notice.action_done";
    case "action_failed":
      return "notice.action_failed";
    case "action_unresolved":
      return "notice.action_unresolved";
    default:
      return "notices.generic";
  }
}

// ===== Phase 0's own in-app rows that an Eddy notice covers =====

/**
 * Until Phase 0 writes through publishNotice() (request E6), it keeps writing its own in-app rows (source 'spend'). Where an
 * Eddy notice already tells the member the same thing, in their language, the strip shows only the Eddy one: a quality
 * breaker on a number (Phase 0 `breaker_tripped`, subject the phone) and waiting approvals (Phase 0 `approval_waiting`).
 * The AI 80% and 100% notices share Phase 0's dedupe key, so there is only ever one row for them.
 */
export function supersededSpendRow(row: { source: string; kind: string; subjectType: string | null; subjectId: string | null }, eddyRows: readonly { kind: string; subjectType: string | null; subjectId: string | null }[]): boolean {
  if (row.source !== "spend") return false;
  if (row.kind === "breaker_tripped" && row.subjectType === "phone") return eddyRows.some((e) => e.kind === "number_quality_dropped" && e.subjectId === row.subjectId);
  if (row.kind === "approval_waiting") return eddyRows.some((e) => e.kind === "approvals_waiting");
  return false;
}

/** Rank for the strip: action needed first, then heads-up, then for-your-information. */
export const SEVERITY_RANK: Readonly<Record<NoticeSeverity, number>> = { action_needed: 0, heads_up: 1, fyi: 2 };

export { ID as NOTICE_ID };
