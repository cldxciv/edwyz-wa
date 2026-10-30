/**
 * The `actions.reconcile` queue handler (docs/EDDY-SPEC.md 4.3 G19, 8.4, EDDY-08 acceptance 4 and 5).
 *
 * A confirmed action whose outcome is ambiguous (a timeout, or a 5xx after the request reached Meta) is stored as `unknown`
 * and is never retried: invoke.ts queues one job here instead. This handler reads the REAL state of what the action touched
 * and settles the record:
 *
 *   send_text_reply   the outbound message Eddy queued in that chat: a wamid and sent / delivered / read is done, failed is
 *                     failed, still queued is "check again later", no message at all (after a grace period) is failed.
 *   submit_template   the template's status: anything past draft (or a Meta template id) means Meta has it.
 *   delete_template   the template row is gone.
 *   cancel_broadcast  the broadcast's status is canceled.
 *   pause_broadcast   the broadcast's status is paused.
 *
 * Rules:
 * - It NEVER re-sends, re-submits or re-runs anything. It does not import a send path, never calls a definition's run(), and
 *   makes no Meta or model call: it only reads rows and moves `unknown` to `done` or `failed` (8.4).
 * - The move is one conditional UPDATE (status still `unknown`), so two jobs for one record settle it once.
 * - Every settlement writes auditOutcome and an ActionInvocation row (stage execute, code `reconciled`), and posts a notice
 *   to the member who confirmed it (ids and codes only, never message text).
 * - When the real state is not final yet, the job throws ReconcileRetryLater so the queue backs off and checks again. On the
 *   last attempt it gives up WITHOUT guessing: the record stays `unknown`, and the member gets a notice to check by hand.
 * - Later packages add probes for their own actions with registerReconcileProbe(); an action with no probe stays `unknown`.
 *
 * The worker module that runs Eddy's jobs (EDDY-16) consumes `reconcileQueues`.
 */
import type { JobContext, JobHandler } from "@/lib/queue";
import { auditOutcome } from "@/lib/ads/audit";
import { prisma } from "@/lib/db";
import { describeError } from "@/lib/safe-error";
import { RECONCILE_QUEUE } from "./invoke";
import { newOpId, transition, writeInvocation, type ActionRecord } from "./store";
import type { Risk } from "./types";

export { RECONCILE_QUEUE };

/** The system principal the settlement is recorded under (4.4: background jobs are `system:<job>`). */
export const RECONCILE_PRINCIPAL = `system:${RECONCILE_QUEUE}`;
/** No message row this long after the tap means the send never started (the inbox writes the row before calling Meta). */
export const NO_MESSAGE_GRACE_MS = 2 * 60_000;
/** Clock skew allowed between the tap and the message row. */
const SKEW_MS = 5_000;
/** Notices about a settled action expire after 7 days, like every notice (6.7). */
const NOTICE_TTL_MS = 7 * 24 * 60 * 60_000;

export type ReconcilePayload = { tenantId: string; actionRecordId: string; action?: string };

/** What a probe reads from the real state. */
export type ProbeVerdict =
  | { state: "done"; result?: Record<string, string | number | boolean | null> }
  | { state: "failed"; code: string }
  /** Not final yet (a message still queued, a template still draft): check again later. */
  | { state: "pending" }
  /** Nothing can be read for this action: the record stays unknown. */
  | { state: "unverifiable" };

export type ProbeContext = { now: Date; isLastAttempt: boolean };
export type ReconcileProbe = (record: ActionRecord, ctx: ProbeContext) => Promise<ProbeVerdict>;

export type ReconcileNotice = {
  tenantId: string;
  userId: string;
  actionId: string;
  action: string;
  outcome: "done" | "failed" | "unresolved";
  code: string | null;
};

export type ReconcileDeps = {
  clock: () => Date;
  auditOutcome: typeof auditOutcome;
  notify: (notice: ReconcileNotice) => Promise<void>;
};

export type ReconcileResult =
  | { outcome: "done" | "failed"; actionId: string; code: string | null }
  | { outcome: "unresolved"; actionId: string }
  | { outcome: "skipped"; reason: "invalid_payload" | "not_found" | "not_unknown" | "settled_elsewhere" | "no_probe" };

/** Thrown when the real state is not final yet, so the queue backs off and runs the job again. Nothing is sent. */
export class ReconcileRetryLater extends Error {
  constructor(action: string) {
    super(`The outcome of ${action} is not final yet; checking again later.`);
    this.name = "ReconcileRetryLater";
  }
}

// ===== Reading the real state =====

const ID = /^[A-Za-z0-9_:-]{1,64}$/;
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const argOf = (record: ActionRecord, ...keys: string[]): string | null => {
  const args = isRecord(record.args) ? record.args : {};
  for (const key of keys) {
    const v = args[key];
    if (typeof v === "string" && ID.test(v)) return v;
  }
  return null;
};
const tappedAt = (record: ActionRecord) => record.decidedAt ?? record.updatedAt ?? record.createdAt;

/** send_text_reply: the outbound message Eddy queued in that chat for this member, after the tap. */
async function probeSendText(record: ActionRecord, ctx: ProbeContext): Promise<ProbeVerdict> {
  const conversationId = argOf(record, "conversationId");
  if (!conversationId) return { state: "unverifiable" };
  const args = isRecord(record.args) ? record.args : {};
  const text = typeof args.text === "string" ? args.text : null;
  const since = new Date(tappedAt(record).getTime() - SKEW_MS);
  const message = await prisma.message.findFirst({
    where: {
      tenantId: record.tenantId,
      conversationId,
      direction: "outbound",
      origin: "eddy",
      sentByUserId: record.userId,
      createdAt: { gte: since },
      ...(text !== null ? { body: text } : {}),
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, wamid: true, status: true, errorCode: true },
  });
  if (!message) {
    // The inbox writes the message row before it calls Meta, so no row means nothing reached Meta. Wait out a grace period
    // first, in case the run is still finishing.
    return ctx.now.getTime() - tappedAt(record).getTime() >= NO_MESSAGE_GRACE_MS || ctx.isLastAttempt ? { state: "failed", code: "not_sent" } : { state: "pending" };
  }
  if (message.status === "failed") return { state: "failed", code: message.errorCode ? `wa_${String(message.errorCode).slice(0, 40)}` : "send_failed" };
  if (message.wamid && (message.status === "sent" || message.status === "delivered" || message.status === "read")) {
    return { state: "done", result: { messageId: message.id, status: message.status } };
  }
  // Still queued (the send job has not finished): the send worker settles it; this job only looks again.
  return { state: "pending" };
}

/** submit_template: anything past draft, or a Meta template id, means Meta has it. */
async function probeSubmitTemplate(record: ActionRecord): Promise<ProbeVerdict> {
  const templateId = argOf(record, "templateId", "id");
  if (!templateId) return { state: "unverifiable" };
  const template = await prisma.template.findFirst({ where: { id: templateId, tenantId: record.tenantId }, select: { id: true, status: true, metaTemplateId: true } });
  if (!template) return { state: "failed", code: "not_found" };
  if (template.status !== "draft" || template.metaTemplateId) return { state: "done", result: { templateId: template.id, status: template.status } };
  return { state: "pending" };
}

/** delete_template: the template row is gone. */
async function probeDeleteTemplate(record: ActionRecord): Promise<ProbeVerdict> {
  const templateId = argOf(record, "templateId", "id");
  if (!templateId) return { state: "unverifiable" };
  const template = await prisma.template.findFirst({ where: { id: templateId, tenantId: record.tenantId }, select: { id: true } });
  return template ? { state: "pending" } : { state: "done", result: { templateId, deleted: true } };
}

const FINISHED_BROADCAST = new Set(["completed", "failed", "canceled"]);

function broadcastProbe(target: "canceled" | "paused"): ReconcileProbe {
  return async (record) => {
    const broadcastId = argOf(record, "broadcastId", "id");
    if (!broadcastId) return { state: "unverifiable" };
    const broadcast = await prisma.broadcast.findFirst({ where: { id: broadcastId, tenantId: record.tenantId }, select: { id: true, status: true } });
    if (!broadcast) return { state: "failed", code: "not_found" };
    if (broadcast.status === target) return { state: "done", result: { broadcastId: broadcast.id, status: broadcast.status } };
    // A broadcast that finished another way can no longer be paused or cancelled.
    if (FINISHED_BROADCAST.has(broadcast.status)) return { state: "failed", code: `broadcast_${broadcast.status}` };
    return { state: "pending" };
  };
}

const BUILT_IN: Readonly<Record<string, ReconcileProbe>> = {
  send_text_reply: probeSendText,
  submit_template: probeSubmitTemplate,
  delete_template: probeDeleteTemplate,
  cancel_broadcast: broadcastProbe("canceled"),
  pause_broadcast: broadcastProbe("paused"),
};

const probes = new Map<string, ReconcileProbe>(Object.entries(BUILT_IN));

/** Adds or replaces the probe for an action (v2 definitions: start_broadcast, activate_campaign, and others). */
export function registerReconcileProbe(action: string, probe: ReconcileProbe): void {
  if (!/^[a-z][a-z0-9_]{2,63}$/.test(action)) throw new Error(`Invalid action name "${action}".`);
  probes.set(action, probe);
}

/** Back to the built-in probes (tests). */
export function resetReconcileProbes(): void {
  probes.clear();
  for (const [name, probe] of Object.entries(BUILT_IN)) probes.set(name, probe);
}

export function probeFor(action: string): ReconcileProbe | undefined {
  return probes.get(action);
}

// ===== Notices =====

/**
 * The default notifier: one Notice per action (dedupeKey `action:<id>`) for the member who confirmed it. The payload holds
 * ids and codes only (6.7). A notice that cannot be written never undoes the settlement.
 */
export async function postReconcileNotice(n: ReconcileNotice, now: Date = new Date()): Promise<void> {
  const dedupeKey = `action:${n.actionId}`;
  const data = {
    kind: `action_${n.outcome}`,
    severity: n.outcome === "done" ? "fyi" : "heads_up",
    audienceUserId: n.userId,
    subjectType: "action",
    subjectId: n.actionId,
    payload: { actionId: n.actionId, action: n.action, outcome: n.outcome, code: n.code },
    source: "eddy",
    expiresAt: new Date(now.getTime() + NOTICE_TTL_MS),
  };
  const existing = await prisma.notice.findFirst({ where: { tenantId: n.tenantId, dedupeKey }, select: { id: true } });
  if (existing) {
    await prisma.notice.updateMany({ where: { id: existing.id, tenantId: n.tenantId }, data: { ...data, resolvedAt: null, updatedAt: now } });
    return;
  }
  await prisma.notice.create({ data: { tenantId: n.tenantId, dedupeKey, ...data } });
}

function defaultDeps(): ReconcileDeps {
  return { clock: () => new Date(), auditOutcome, notify: (n) => postReconcileNotice(n) };
}

// ===== The handler =====

export function parseReconcilePayload(payload: unknown): ReconcilePayload | null {
  if (!isRecord(payload)) return null;
  const { tenantId, actionRecordId, action } = payload;
  if (typeof tenantId !== "string" || !tenantId || tenantId.length > 64) return null;
  if (typeof actionRecordId !== "string" || !ID.test(actionRecordId)) return null;
  return { tenantId, actionRecordId, ...(typeof action === "string" ? { action } : {}) };
}

const auditName = (record: ActionRecord) => `${record.via === "eddy" ? "eddy" : record.via}.${record.action}`;

async function recordSettlement(record: ActionRecord, deps: RunDeps, outcome: ReconcileNotice["outcome"], code: string | null): Promise<void> {
  const { now } = deps;
  await writeInvocation({
    tenantId: record.tenantId,
    userId: record.userId,
    via: "system",
    principalId: RECONCILE_PRINCIPAL,
    opId: newOpId(),
    action: record.action,
    risk: (record.risk as Risk) ?? "confirm",
    stage: "execute",
    outcome: outcome === "done" ? "ok" : outcome === "failed" ? "failed" : "unknown",
    code: outcome === "unresolved" ? "reconcile_gave_up" : code ? `reconciled:${code}`.slice(0, 64) : "reconciled",
    argsHash: record.argsHash,
    actionRecordId: record.id,
    resultRef: record.id,
    conversationId: record.conversationId ?? null,
  });
  await deps.auditOutcome({
    tenantId: record.tenantId,
    userId: record.userId,
    action: auditName(record),
    target: record.id,
    meta: { stage: outcome === "unresolved" ? "unknown" : outcome, reconciledBy: RECONCILE_PRINCIPAL, actionId: record.id, code, at: now.toISOString() },
  });
  try {
    await deps.notify({ tenantId: record.tenantId, userId: record.userId, actionId: record.id, action: record.action, outcome, code });
  } catch (e) {
    console.error("[actions] reconcile notice failed:", describeError(e));
  }
}

type RunDeps = ReconcileDeps & { now: Date };

/**
 * Settles one `unknown` ActionRecord from the real state. Never re-sends. Throws ReconcileRetryLater while the state is not
 * final (the queue backs off and runs it again); on the last attempt it leaves the record unknown and tells the member.
 */
export async function handleActionsReconcile(payload: unknown, context: JobContext = { attempt: 1, maxAttempts: 1, isLastAttempt: true }, depsIn: Partial<ReconcileDeps> = {}): Promise<ReconcileResult> {
  const base = defaultDeps();
  const clock = depsIn.clock ?? base.clock;
  const deps: RunDeps = { clock, auditOutcome: depsIn.auditOutcome ?? base.auditOutcome, notify: depsIn.notify ?? base.notify, now: clock() };
  const job = parseReconcilePayload(payload);
  if (!job) return { outcome: "skipped", reason: "invalid_payload" };
  const row = await prisma.actionRecord.findFirst({ where: { id: job.actionRecordId, tenantId: job.tenantId } });
  if (!row) return { outcome: "skipped", reason: "not_found" };
  if (row.status !== "unknown") return { outcome: "skipped", reason: "not_unknown" };

  const probe = probeFor(row.action);
  if (!probe) {
    console.warn(`[actions] no reconcile probe for ${row.action}; the record stays unknown.`);
    return { outcome: "skipped", reason: "no_probe" };
  }
  const verdict = await probe(row, { now: deps.now, isLastAttempt: context.isLastAttempt });

  if (verdict.state === "done" || verdict.state === "failed") {
    const patch = verdict.state === "done" ? { status: "done" as const, result: { reconciled: true, ...(verdict.result ?? {}) }, error: null } : { status: "failed" as const, error: verdict.code };
    const moved = await transition(row.tenantId, row.id, ["unknown"], patch, deps.now);
    if (moved !== 1) return { outcome: "skipped", reason: "settled_elsewhere" };
    const code = verdict.state === "failed" ? verdict.code : null;
    await recordSettlement(row, deps, verdict.state, code);
    return { outcome: verdict.state, actionId: row.id, code };
  }

  if (!context.isLastAttempt) throw new ReconcileRetryLater(row.action);
  // Out of attempts: never guess and never re-send. The card keeps saying it is being checked; the member is told to look.
  await recordSettlement(row, deps, "unresolved", verdict.state);
  return { outcome: "unresolved", actionId: row.id };
}

/** The queue handler as the worker registry wants it (JobHandler resolves to void). */
export const actionsReconcileJob: JobHandler = async (payload, context) => {
  await handleActionsReconcile(payload, context);
};

/** For the worker module that runs Eddy's jobs (EDDY-16): `queues: { ...reconcileQueues }`. */
export const reconcileQueues: Readonly<Record<string, JobHandler>> = Object.freeze({ [RECONCILE_QUEUE]: actionsReconcileJob });
