import { getRateCard } from "@/lib/admin/ratecard";
import { prisma } from "@/lib/db";
import { emitBroadcastCompleted } from "@/lib/integrations/emitters";
import { sendTemplateMessage } from "@/lib/inbox/service";
import { runDueJobs } from "@/lib/queue";
import { describeError } from "@/lib/safe-error";
import { listBreakers } from "@/lib/spend/breakers/state";
import { SpendBlockedError } from "@/lib/spend/errors";
import { spendState } from "@/lib/spend/kill";
import { normalizeCategory } from "@/lib/spend/messaging/origin";
import { openReservationFor } from "@/lib/spend/reservations";
import type { SpendActor } from "@/lib/spend/types";
import { backgroundGate } from "@/lib/tenant-lifecycle-state";
import { TEMPLATE_BLOCK_CODES, TENANT_BLOCKED, isTemplateBlockCode, pauseForBlockedTemplate, pauseWithReason } from "./blocked";
import { estimateBroadcastHold, holdBroadcastFor, openBulkHold, releaseBulkFor, releaseBulkHold } from "./cost";
import { acquireRunLease, enqueueBroadcastRun, releaseRunLease } from "./jobs";
import { type MissingValuePolicy, type VariableMap, buildRecipientComponents } from "./mapping";
import { notifyBroadcastPaused } from "./notify";
import { type PauseReasonCode, storePauseReason } from "./pause";
import { portfolioUsage } from "./portfolio";
import { type RetryContext, RETRYABLE_ERROR_CODE, failedRecipientData, retryWindowOpen } from "./retry";
import { BROADCAST_QUEUE } from "./service";
import { WINDOW_MS, allowedNow } from "./throttle";

export const BATCH_SIZE = 20;
const BAD_QUALITY = new Set(["RED", "LOW"]);

export { TEMPLATE_BLOCK_CODES, isTemplateBlockCode };
const TEMPLATE_BLOCKED_STATUSES = new Set(["paused", "disabled", "rejected"]);

const requeue = (broadcastId: string, runAt: Date) => enqueueBroadcastRun(broadcastId, runAt);

/** The window is rolling, so when the limit is used up the next slot opens when the oldest recipient in the window ages out. */
function nextRunWhenExhausted(oldest: Date | null, now: Date) {
  return oldest ? new Date(oldest.getTime() + WINDOW_MS) : new Date(now.getTime() + 60 * 60 * 1000);
}

const countPending = (b: { id: string; tenantId: string }) =>
  prisma.broadcastRecipient.count({ where: { tenantId: b.tenantId, broadcastId: b.id, status: "pending" } });

/** The worker's actor on spend ledger rows about broadcasts. */
const WORKER: SpendActor = { type: "system", job: "broadcast" };

const complete = async (b: { id: string; tenantId: string }) => {
  const completedAt = new Date();
  const done = await prisma.broadcast.update({ where: { id: b.id, tenantId: b.tenantId }, data: { status: "completed", completedAt } });
  // Every queued message has settled, so what the hold did not use goes back to the WhatsApp limit now (4.9).
  await releaseBulkFor(b.tenantId, { type: "broadcast", id: b.id }, `Broadcast "${done?.name ?? ""}" finished, so what it did not use went back to your WhatsApp limit.`, WORKER);
  await emitBroadcastCompleted(b.tenantId, { id: b.id, name: done?.name, templateId: done?.templateId }, completedAt).catch(() => console.error("[broadcast] could not emit completion event"));
  return done;
};

export { TENANT_BLOCKED };
const pauseForBlockedTenant = (b: { id: string; tenantId: string }) => pauseWithReason(b, TENANT_BLOCKED, false);

function errorCodeOf(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" || typeof code === "number" ? String(code).slice(0, 100) : "send_failed";
}

type Recipient = {
  id: string;
  attempts?: number;
  contact: { id: string; name: string | null; phone?: string | null; bsuid?: string | null; attributes: unknown; optIn: boolean; optedOutAt: Date | null };
};

const policyOf = (raw: unknown): MissingValuePolicy => (raw === "fallback" || raw === "fail" ? raw : "skip");
const mapOf = (raw: unknown): VariableMap | null => (raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as VariableMap) : null);

/**
 * Returns "blocked" (the workspace is confirmed suspended, deleted or locked), "retry" (the state could not be confirmed, for
 * example a database read failed) or "missing" (a value is missing and the broadcast is set to stop) without sending anything.
 * Only "blocked" may pause the broadcast for the workspace: pausing needs a person to resume it, so a transient read error must never cause it.
 */
export async function sendOne(
  b: {
    id: string;
    tenantId: string;
    phoneNumberId: string;
    retryDays?: number;
    startedAt?: Date | null;
    variableMap?: unknown;
    missingValuePolicy?: string;
    template: { name: string; language: string; components: unknown; category?: string | null };
  },
  r: Recipient,
  /** The broadcast's bulk hold: the send gate takes this message's estimate from it (4.9). */
  reservationId?: string | null,
): Promise<"blocked" | "retry" | "missing" | void> {
  const gate = await backgroundGate(b.tenantId);
  if (gate !== "ok") return gate === "blocked" ? "blocked" : "retry";
  const retry: RetryContext = { attempts: r.attempts ?? 0, retryDays: b.retryDays ?? 0, startedAt: b.startedAt ?? null };
  const claimed = await prisma.broadcastRecipient.updateMany({
    where: { id: r.id, tenantId: b.tenantId, status: "pending" },
    data: { status: "queued" },
  });
  if (claimed.count === 0) return;
  const finish = (data: Record<string, unknown>) => prisma.broadcastRecipient.update({ where: { id: r.id, tenantId: b.tenantId }, data });

  if (!r.contact.optIn || r.contact.optedOutAt) return void (await finish({ status: "skipped" }));
  // A contact known only by BSUID (no phone) can get any template except authentication (login code) ones, which Meta sends to phone numbers only.
  if (r.contact.phone === null && (!r.contact.bsuid || b.template.category?.toUpperCase() === "AUTHENTICATION")) {
    return void (await finish({ status: "skipped", errorCode: r.contact.bsuid ? "bsuid_auth_template" : "no_recipient" }));
  }
  try {
    const policy = policyOf(b.missingValuePolicy);
    const built = buildRecipientComponents(b.template.components, r.contact, mapOf(b.variableMap), policy);
    if (!built.ok) {
      if (policy === "fail") {
        await finish({ status: "pending" });
        return "missing";
      }
      return void (await finish({ status: "skipped", errorCode: "missing_variable" }));
    }
    const message: unknown = await sendTemplateMessage({
      tenantId: b.tenantId,
      phoneNumberId: b.phoneNumberId,
      contactId: r.contact.id,
      templateName: b.template.name,
      language: b.template.language,
      components: built.components,
      origin: "broadcast",
      ...(reservationId ? { reservationId } : {}),
    });
    const messageId = (message as { id?: unknown } | null)?.id;
    if (typeof messageId !== "string") return void (await finish({ status: "failed", errorCode: "no_message_id" }));
    await finish({ messageId });
  } catch (error) {
    await finish(failedRecipientData(errorCodeOf(error), retry));
  }
}

const SYNC_LIMIT = 200;

type SyncMessage = { status: string; wamid: string | null; errorCode: string | null; statusTimeline: unknown };

function timelineAt(timeline: unknown, status: string): Date | null {
  const entry = (Array.isArray(timeline) ? timeline : []).find((e) => (e as { status?: string })?.status === status) as { at?: string } | undefined;
  const at = entry?.at ? new Date(entry.at) : null;
  return at && !Number.isNaN(at.getTime()) ? at : null;
}

/**
 * Maps a Message outcome onto recipient columns. Returns null while the message is still queued or has no wamid yet.
 * A message WhatsApp refused because the template is paused or disabled puts the recipient back to pending, so the person is
 * not lost: they are messaged when the template works again, or by another template (see followup.ts).
 */
export function recipientUpdateFromMessage(m: SyncMessage, now = new Date(), retry?: RetryContext): Record<string, unknown> | null {
  if (m.status === "failed" && isTemplateBlockCode(m.errorCode)) return { status: "pending", messageId: null, errorCode: null };
  if (m.status === "failed") return failedRecipientData(m.errorCode ?? "send_failed", retry, now);
  if (!m.wamid || !["sent", "delivered", "read"].includes(m.status)) return null;
  const sentAt = timelineAt(m.statusTimeline, "sent") ?? now;
  return {
    status: m.status,
    wamid: m.wamid,
    sentAt,
    ...(m.status !== "sent" ? { deliveredAt: timelineAt(m.statusTimeline, "delivered") ?? now } : {}),
    ...(m.status === "read" ? { readAt: timelineAt(m.statusTimeline, "read") ?? now } : {}),
  };
}

const blockedMessage = (m: SyncMessage | undefined) => !!m && m.status === "failed" && isTemplateBlockCode(m.errorCode);

/** Copies the outcome of the recipient's queued Message onto the recipient. Tenant-scoped through the recipient row. */
export async function syncRecipientFromMessage(messageId: string): Promise<boolean> {
  const recipient = await prisma.broadcastRecipient.findUnique({
    where: { messageId },
    select: { id: true, tenantId: true, status: true, attempts: true, broadcast: { select: { id: true, name: true, templateId: true, retryDays: true, startedAt: true } } },
  });
  if (!recipient || recipient.status !== "queued") return false;
  const message = await prisma.message.findFirst({
    where: { id: messageId, tenantId: recipient.tenantId },
    select: { status: true, wamid: true, errorCode: true, statusTimeline: true },
  });
  const data = message ? recipientUpdateFromMessage(message, new Date(), { attempts: recipient.attempts, ...recipient.broadcast }) : null;
  if (!data) return false;
  const { count } = await prisma.broadcastRecipient.updateMany({ where: { id: recipient.id, tenantId: recipient.tenantId, status: "queued" }, data });
  if (count > 0 && blockedMessage(message ?? undefined) && recipient.broadcast?.id) {
    await pauseForBlockedTemplate({ id: recipient.broadcast.id, tenantId: recipient.tenantId, templateId: recipient.broadcast.templateId, name: recipient.broadcast.name }, true);
  }
  return count > 0;
}

/** Settles queued recipients from their messages. Returns how many were refused because the template is paused or disabled. */
async function reconcileRecipients(b: { id: string; tenantId: string; retryDays?: number; startedAt?: Date | null }): Promise<number> {
  const queued = await prisma.broadcastRecipient.findMany({
    where: { tenantId: b.tenantId, broadcastId: b.id, status: "queued", messageId: { not: null } },
    orderBy: { id: "asc" },
    take: SYNC_LIMIT,
    select: { id: true, messageId: true, attempts: true },
  });
  if (queued.length === 0) return 0;
  const messages = await prisma.message.findMany({
    where: { tenantId: b.tenantId, id: { in: queued.map((r) => r.messageId as string) } },
    select: { id: true, status: true, wamid: true, errorCode: true, statusTimeline: true },
  });
  const byId = new Map(messages.map((m) => [m.id, m]));
  let blocked = 0;
  for (const r of queued) {
    const m = byId.get(r.messageId as string);
    const data = m ? recipientUpdateFromMessage(m, new Date(), { attempts: r.attempts, retryDays: b.retryDays ?? 0, startedAt: b.startedAt ?? null }) : null;
    if (!data) continue;
    const { count } = await prisma.broadcastRecipient.updateMany({ where: { id: r.id, tenantId: b.tenantId, status: "queued" }, data });
    if (count > 0 && blockedMessage(m)) blocked++;
  }
  return blocked;
}

const countInFlight = (b: { id: string; tenantId: string }) =>
  prisma.broadcastRecipient.count({ where: { tenantId: b.tenantId, broadcastId: b.id, status: "queued", messageId: { not: null } } });

const WAIT_MS = 30_000;

type RetryBroadcast = { id: string; tenantId: string; retryDays?: number; startedAt?: Date | null };

/** Moves recipients that failed on the per-user marketing cap back to pending once their retryAfter has passed and the window is open. */
export async function requeueDueRetries(b: RetryBroadcast, now: Date): Promise<number> {
  const days = b.retryDays ?? 0;
  if (days <= 0) return 0;
  const base = { tenantId: b.tenantId, broadcastId: b.id, status: "failed" as const, errorCode: RETRYABLE_ERROR_CODE, retryAfter: { not: null } };
  const optedOut = { OR: [{ contact: { optIn: false } }, { contact: { optedOutAt: { not: null } } }] };
  await prisma.broadcastRecipient.updateMany({ where: { ...base, ...optedOut }, data: { retryAfter: null } });
  if (!retryWindowOpen(b.startedAt, days, now)) {
    await prisma.broadcastRecipient.updateMany({ where: base, data: { retryAfter: null } });
    return 0;
  }
  const { count } = await prisma.broadcastRecipient.updateMany({
    where: { ...base, retryAfter: { lte: now }, contact: { optIn: true, optedOutAt: null } },
    data: { status: "pending", errorCode: null, retryAfter: null },
  });
  return count;
}

async function nextRetryAt(b: RetryBroadcast): Promise<Date | null> {
  if ((b.retryDays ?? 0) <= 0) return null;
  const row = await prisma.broadcastRecipient.findFirst({
    where: { tenantId: b.tenantId, broadcastId: b.id, status: "failed", errorCode: RETRYABLE_ERROR_CODE, retryAfter: { not: null } },
    orderBy: { retryAfter: "asc" },
    select: { retryAfter: true },
  });
  return row?.retryAfter ?? null;
}

/** Completes only when nothing is pending, nothing awaits a retry, and every queued message has settled; otherwise checks again later. */
async function completeOrWait(b: RetryBroadcast, now: Date) {
  if ((await countInFlight(b)) > 0) return void (await requeue(b.id, new Date(now.getTime() + WAIT_MS)));
  const retryAt = await nextRetryAt(b);
  if (retryAt) return void (await requeue(b.id, retryAt.getTime() > now.getTime() ? retryAt : new Date(now.getTime() + WAIT_MS)));
  await complete(b);
}

export { BROADCAST_QUEUE };

export async function processBroadcast(broadcastId: string, now = new Date()): Promise<void> {
  // One run at a time per broadcast: a resume, a pause and the worker's own follow-up can each leave a job behind, and two runs that
  // both read the rolling 24 hour usage would each send a full batch past the limit. A run that finds another one working tries again later.
  if (!(await acquireRunLease(broadcastId, now))) return void (await requeue(broadcastId, new Date(now.getTime() + WAIT_MS)));
  try {
    await processLocked(broadcastId, now);
  } finally {
    await releaseRunLease(broadcastId);
  }
}

const FINISHED = new Set(["completed", "canceled", "failed"]);
const QUALITY_KINDS = ["wa_quality_red", "wa_quality_yellow"];
let spendReadWarned = false;

function warnSpendRead(error: unknown): void {
  if (spendReadWarned) return;
  spendReadWarned = true;
  console.warn("[broadcast] could not read the spending controls; each message is still checked when it is sent:", describeError(error));
}

/**
 * Why the spending controls stop this broadcast now (docs/SPEND-CONTROLS-SPEC.md 4.9, 6.3), or null:
 * - spending is stopped (freeze "all", workspace or platform): spending_stopped;
 * - Meta flagged a marketing template: template_quality;
 * - the number's quality breaker is open: RED pauses every broadcast (number_quality), YELLOW pauses marketing ones
 *   (number_quality_yellow).
 * A read that fails stops nothing here: the send gate still checks every message and holds it, so nothing is sent past a stop.
 */
export async function spendStopReason(
  b: { tenantId: string; template: { status: string; category?: string | null }; phoneNumber: { id: string; phoneNumberId?: string | null } },
  now: Date = new Date(),
): Promise<PauseReasonCode | null> {
  const marketing = normalizeCategory(b.template.category) === "MARKETING";
  if (b.template.status === "flagged" && marketing) return "template_quality";
  try {
    const freeze = await spendState(b.tenantId, { now: now.getTime() });
    if (freeze.workspace === "all" || freeze.platform === "all") return "spending_stopped";
  } catch (error) {
    warnSpendRead(error);
  }
  try {
    const open = await listBreakers(b.tenantId, { kinds: QUALITY_KINDS, now });
    const mine = open.filter((r) => r.scopeType === "phone" && (r.scopeId === b.phoneNumber.id || r.scopeId === b.phoneNumber.phoneNumberId));
    if (mine.some((r) => r.kind === "wa_quality_red")) return "number_quality";
    if (marketing && mine.some((r) => r.kind === "wa_quality_yellow")) return "number_quality_yellow";
  } catch (error) {
    warnSpendRead(error);
  }
  return null;
}

/**
 * A scheduled broadcast that is due takes its 7-day hold now (4.9: the audience and the limit may have changed since it was
 * scheduled). "refused" when it no longer fits; "retry" when the hold could not be taken for another reason.
 */
async function holdWhenDue(b: { id: string; tenantId: string; name: string; phoneNumberId: string; template: { category?: string | null } }, now: Date): Promise<"ok" | "refused" | "retry"> {
  try {
    await holdBroadcastFor(b, WORKER, now);
    return "ok";
  } catch (error) {
    if (error instanceof SpendBlockedError) return "refused";
    console.error("[broadcast] could not set aside a scheduled broadcast's cost; trying again shortly:", describeError(error));
    return "retry";
  }
}

async function processLocked(broadcastId: string, now: Date): Promise<void> {
  const b = await prisma.broadcast.findUnique({ where: { id: broadcastId }, include: { template: true, phoneNumber: true } });
  if (!b) return;
  const blockedByTemplate = await reconcileRecipients(b);

  // A finished broadcast never keeps money aside (cancel and completion release it; this catches anything left over).
  if (FINISHED.has(b.status)) return void (await releaseBulkFor(b.tenantId, { type: "broadcast", id: b.id }, `Broadcast "${b.name}" ended, so what it did not use went back to your WhatsApp limit.`, WORKER));

  if (b.status === "scheduled") {
    if (b.scheduledAt && b.scheduledAt > now) return void (await requeue(b.id, b.scheduledAt));
  } else if (b.status !== "sending") return;

  const gate = await backgroundGate(b.tenantId);
  if (gate === "blocked") return void (await pauseForBlockedTenant(b));
  if (gate === "unknown") return void (await requeue(b.id, new Date(now.getTime() + WAIT_MS)));

  if (blockedByTemplate > 0) return void (await pauseForBlockedTemplate(b, true));
  if (TEMPLATE_BLOCKED_STATUSES.has(b.template.status)) return void (await pauseForBlockedTemplate(b, false));

  const stop = await spendStopReason(b, now);
  if (stop) return void (await pauseWithReason(b, stop, true));

  if (b.status === "scheduled") {
    const held = await holdWhenDue(b, now);
    if (held === "refused") return void (await pauseWithReason(b, "messaging_limit", true));
    if (held === "retry") return void (await requeue(b.id, new Date(now.getTime() + WAIT_MS)));
    await prisma.broadcast.update({ where: { id: b.id, tenantId: b.tenantId }, data: { status: "sending", startedAt: b.startedAt ?? now } });
  }

  if (BAD_QUALITY.has((b.phoneNumber.qualityRating ?? "").toUpperCase())) {
    await prisma.broadcast.update({ where: { id: b.id, tenantId: b.tenantId }, data: { status: "paused" } });
    await storePauseReason(b.id, "number_quality", now);
    await notifyBroadcastPaused(b.tenantId, { id: b.id, name: b.name }, "number_quality");
    return;
  }

  await requeueDueRetries(b, now);

  const usage = await portfolioUsage(b.tenantId, b.phoneNumber.wabaRefId, now);
  const quota = allowedNow({ tier: b.phoneNumber.messagingLimitTier, limit: usage.limit, sentLast24h: usage.used, batchSize: BATCH_SIZE });
  if (quota === 0) {
    const pending = await countPending(b);
    if (pending === 0) return void (await completeOrWait(b, now));
    await requeue(b.id, nextRunWhenExhausted(usage.oldest, now));
    return;
  }

  const batch = await prisma.broadcastRecipient.findMany({
    where: { tenantId: b.tenantId, broadcastId: b.id, status: "pending" },
    orderBy: { id: "asc" },
    take: quota,
    include: { contact: { select: { id: true, name: true, phone: true, bsuid: true, attributes: true, optIn: true, optedOutAt: true } } },
  });
  // The messages take their estimate from the broadcast's hold; without one (none taken, expired, used up) each reserves its own.
  const reservationId = batch.length > 0 ? await openBulkHold(b.tenantId, { type: "broadcast", id: b.id }) : null;
  for (const r of batch) {
    const outcome = await sendOne(b, r, reservationId);
    if (outcome === "blocked") return void (await pauseForBlockedTenant(b));
    if (outcome === "retry") return void (await requeue(b.id, new Date(now.getTime() + WAIT_MS)));
    if (outcome === "missing") return void (await pauseWithReason(b, "missing_values", true));
  }

  if ((await countPending(b)) === 0) return void (await completeOrWait(b, now));
  await requeue(b.id, now);
}

/**
 * A number's quality dropped (6.3): pause the broadcasts sending from it now, instead of waiting for their next run. RED pauses
 * all of them (number_quality); YELLOW pauses marketing ones (number_quality_yellow). Scheduled broadcasts are checked when
 * they are due. Returns how many were paused. Never throws.
 */
export async function pauseBroadcastsForNumber(tenantId: string, phoneRowId: string, reason: "number_quality" | "number_quality_yellow"): Promise<number> {
  try {
    const rows = await prisma.broadcast.findMany({
      where: { tenantId, phoneNumberId: phoneRowId, status: "sending" },
      select: { id: true, name: true, template: { select: { category: true } } },
      take: 200,
    });
    let paused = 0;
    for (const b of rows) {
      if (reason === "number_quality_yellow" && normalizeCategory(b.template?.category) !== "MARKETING") continue;
      await pauseWithReason({ id: b.id, tenantId, name: b.name }, reason, true);
      paused++;
    }
    return paused;
  } catch (error) {
    console.error("[broadcast] could not pause broadcasts for a number's quality drop:", describeError(error));
    return 0;
  }
}

/**
 * Meta changed a template's category (template_category_update, 6.3): the holds of broadcasts sending with it are re-estimated
 * for the people still pending at the new category. A hold that still covers them stays; one that does not is replaced by a
 * hold for the new figure, and a broadcast that no longer fits pauses with messaging_limit (the owner is told). Without a hold
 * (none taken, or observe mode) the messages reserve one by one at the new category anyway. Returns how many paused.
 */
export async function reestimateBroadcastHolds(tenantId: string, templateId: string, now: Date = new Date()): Promise<{ reestimated: number; paused: number }> {
  const out = { reestimated: 0, paused: 0 };
  const card = await getRateCard();
  if (!card) return out;
  const rows = await prisma.broadcast.findMany({
    where: { tenantId, templateId, status: "sending" },
    select: { id: true, name: true, phoneNumberId: true, template: { select: { category: true } } },
    take: 200,
  });
  for (const b of rows) {
    try {
      const open = await openReservationFor(tenantId, { type: "broadcast", id: b.id }, { now });
      if (!open) continue;
      const ref = { id: b.id, tenantId, name: b.name, phoneNumberId: b.phoneNumberId, template: { category: b.template?.category ?? null } };
      const est = await estimateBroadcastHold(ref, card, now);
      if (!est) continue;
      out.reestimated++;
      if (est.estimateMinor <= open.amountMinor - open.consumedMinor) continue;
      await releaseBulkHold(open.id, `Meta changed the category of the template used by "${b.name}", so its cost was worked out again.`, WORKER);
      try {
        await holdBroadcastFor(ref, WORKER, now);
      } catch (error) {
        if (!(error instanceof SpendBlockedError)) throw error;
        await pauseWithReason({ id: b.id, tenantId, name: b.name }, "messaging_limit", true);
        out.paused++;
      }
    } catch (error) {
      console.error("[broadcast] could not re-estimate a broadcast after a template category change:", describeError(error));
    }
  }
  return out;
}

/** For the worker: call this for queue "broadcast". */
export function runBroadcastQueue(limit = 5): Promise<number> {
  return runDueJobs(
    BROADCAST_QUEUE,
    async (payload) => {
      const id = (payload as { broadcastId?: unknown } | null)?.broadcastId;
      if (typeof id === "string") await processBroadcast(id);
    },
    limit,
  );
}
