import { NoValidTokenError } from "@/lib/crypto/tokens";
import { prisma } from "@/lib/db";
import type { JobContext } from "@/lib/queue";
import { GraphError, graphFetch } from "@/lib/graph";
import { emitEvent } from "@/lib/integrations/events";
import { messageStatusPayload } from "@/lib/integrations/payloads";
import { isAuthFailure, markWhatsAppAuthRejected, noteWhatsAppTokenWorks } from "@/lib/onboarding/token-health";
import { enqueue } from "@/lib/queue";
import { describeError } from "@/lib/safe-error";
import { finishSend, messagingGate, releaseMessageSpend, type MessageSpendFields, type SendResult } from "@/lib/spend/messaging/gate";
import { tenantMayRunBackground } from "@/lib/tenant-state";
import { asArr, asJsonArr, asRec, str } from "@/lib/webhooks/payload";
import { recipientAddress, type RecipientAddress } from "@/lib/contacts/identity";
import { normalizeInteractive } from "./interactive";

type SendResponse = { messages?: { id?: string }[] };

type MessageRow = { type: string; body: string | null; mediaUrl: string | null; mediaMime: string | null };

const MAX_TEXT = 4096;

/** The agent-name option: "*Name*" on its own line in front of the message, as WhatsApp bold. The stored message does not carry it. */
export function withSignature(body: string, signature: unknown): string {
  const name = typeof signature === "string" ? signature.replace(/[*\r\n]+/g, " ").trim().slice(0, 60) : "";
  return name ? `*${name}*\n${body}`.slice(0, MAX_TEXT) : body;
}

/**
 * Who the Cloud API message goes to. A phone number goes in `to` as digits. A contact known only by BSUID is addressed with the
 * `recipient` field instead. VERIFY the field name and the value format against Meta's current send-message reference before launch.
 */
export function addressFields(to: string | RecipientAddress): Record<string, string> {
  if (typeof to === "string") return { to: to.replace(/^\+/, "") };
  return "phone" in to ? { to: to.phone.replace(/^\+/, "") } : { recipient: to.bsuid };
}

export function buildSendBody(to: string | RecipientAddress, message: MessageRow, job: Record<string, unknown>) {
  const base = { messaging_product: "whatsapp", recipient_type: "individual", ...addressFields(to) };
  if (message.type === "template") {
    const t = asRec(job.template);
    return { ...base, type: "template", template: { name: str(t.name), language: { code: str(t.language) }, components: asArr(t.components) } };
  }
  if (message.type === "interactive") return { ...base, type: "interactive", interactive: normalizeInteractive(job.interactive) };
  if (message.type === "text") return { ...base, type: "text", text: { body: withSignature(message.body ?? "", job.signature), preview_url: false } };

  const media = message.mediaUrl ?? "";
  const ref = /^https?:\/\//.test(media) ? { link: media } : { id: media.replace(/^meta-media:/, "") };
  const filename = message.type === "document" ? str(job.filename) : undefined;
  const caption = message.type === "audio" || message.type === "sticker" ? undefined : (message.body ?? undefined);
  return { ...base, type: message.type, [message.type]: { ...ref, ...(caption ? { caption } : {}), ...(filename ? { filename } : {}) } };
}

const SEND_QUEUE = "send";
const BLOCKED_RETRY_MS = 15 * 60_000;
/** A template can still be useful a week later; free-form text and media cannot (the 24 hour service window has closed by then). */
const BLOCKED_MAX_TEMPLATE_MS = 7 * 86_400_000;
const BLOCKED_MAX_FREEFORM_MS = 24 * 3_600_000;

/** Why a job waits, and the errorCode the message gets if it is still waiting when it expires. */
type Hold = { errorCode: string; retryAt?: Date };
const TENANT_BLOCKED: Hold = { errorCode: "tenant_blocked" };

/**
 * The workspace is suspended, deleted or billing-locked (read-only for agents), or the send gate held the message (a freeze,
 * a quality stop, a used-up WhatsApp limit): nothing is sent and the work is not lost. The job is put back on the queue 15
 * minutes later (or at the gate's retryAt when that is sooner) with the time it was first held (`blockedSince`), so a message
 * queued for a workspace that recovers still goes out. The message is read first: one that is gone, already sent or no longer
 * queued is dropped, not held again. Free-form text and media end as failed after 24 hours and templates after 7 days
 * (errorCode tenant_blocked, or the gate's reason such as messaging_limit), so a backlog is not released in one stale burst.
 * Inbound handling is not affected: only this outbound queue is gated, and chatbot replies to new inbound messages are not
 * created for a blocked workspace at all (see chatbots/engine.ts).
 * If the hold itself cannot be re-queued the error propagates so the queue retries; on the last attempt the message is failed
 * rather than left "queued" with no job. A message that ends here gives back anything an earlier attempt reserved.
 */
async function holdBlockedSend(job: Record<string, unknown>, messageId: string, tenantId: string, context?: JobContext, hold: Hold = TENANT_BLOCKED): Promise<void> {
  const now = Date.now();
  const since = new Date(typeof job.blockedSince === "string" ? job.blockedSince : now);
  const sinceMs = Number.isNaN(since.getTime()) ? now : since.getTime();
  const message = await prisma.message.findFirst({
    where: { id: messageId, tenantId },
    select: { id: true, type: true, status: true, wamid: true, statusTimeline: true, conversationId: true, spendState: true, spendDay: true, estCostMinor: true, reservationId: true },
  });
  if (!message || message.status !== "queued" || message.wamid) return;
  const maxMs = message.type === "template" ? BLOCKED_MAX_TEMPLATE_MS : BLOCKED_MAX_FREEFORM_MS;
  if (now - sinceMs > maxMs) return failUnsent(message, tenantId, hold.errorCode);
  const retryAt = Math.min(hold.retryAt?.getTime() ?? Infinity, now + BLOCKED_RETRY_MS);
  const payload = { ...job, blockedSince: new Date(sinceMs).toISOString(), ...(hold === TENANT_BLOCKED ? {} : { heldReason: hold.errorCode }) };
  try {
    await enqueue(SEND_QUEUE, payload, { runAt: new Date(Math.max(retryAt, now + 1_000)) });
  } catch (error) {
    if (!context?.isLastAttempt) throw error;
    await failUnsent(message, tenantId, hold.errorCode);
  }
}

type UnsentMessage = Parameters<typeof markOutcome>[0] & Partial<MessageSpendFields>;

/**
 * Ends a queued message as failed without sending it. When an earlier attempt of the job had reserved its estimate (a retryable
 * error, then a block, an expiry or a STOP), that reservation is given back first, so it is not counted for good (4.9).
 */
async function failUnsent(message: UnsentMessage, tenantId: string, errorCode: string): Promise<void> {
  const held = message.spendState === "reserved";
  if (held) await releaseMessageSpend(tenantId, { id: message.id, estCostMinor: message.estCostMinor, spendState: message.spendState, spendDay: message.spendDay, reservationId: message.reservationId });
  return markOutcome(message, tenantId, { status: "failed", errorCode }, held ? { spendState: "released" } : undefined);
}

const AI_STOP_TAG = "ai:stopped";
const SYSTEM_AUTHOR = "system";
const LIVE_BOT = ["waiting", "active"] as const;

/** The inbox notice when an auto-reply hands the chat over because the WhatsApp limit is used up (decision 2.3.12). */
export function handoffNotice(period: "day" | "month"): string {
  return `Automatic replies are paused because ${period === "day" ? "today's" : "this month's"} WhatsApp limit is used up.`;
}

/** Where a finished send leaves its reservation: settled when Meta may have the message (sent, ambiguous), released otherwise. */
const spendStateAfter = (result: SendResult): "settled" | "released" => (result === "failed" ? "released" : "settled");

/**
 * A chatbot or AI agent reply found the WhatsApp limit used up (decision 2.3.12): the bot stops, the AI agent pauses for this
 * chat, the chat is opened and routed to a person, and a private note says why. Best effort and never throws: the failed
 * message itself already says messaging_limit.
 */
async function handOffForLimit(tenantId: string, conversationId: string, period: "day" | "month"): Promise<void> {
  const now = new Date();
  const step = async (what: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (error) {
      console.error(`[inbox] limit hand-over could not ${what}:`, describeError(error));
    }
  };
  const conversation = await prisma.conversation.findFirst({ where: { id: conversationId, tenantId }, select: { status: true, tags: true, contactId: true } }).catch(() => null);
  if (!conversation || conversation.status === "blocked") return;
  await step("stop the chatbot", () =>
    prisma.chatbotSession.updateMany({ where: { tenantId, conversationId, status: { in: [...LIVE_BOT] } }, data: { status: "handed_off", endedAt: now, waitingNodeId: null, wakeAt: null } }),
  );
  const tags = Array.isArray(conversation.tags) ? conversation.tags : [];
  await step("open the chat", () =>
    prisma.conversation.updateMany({ where: { id: conversationId, tenantId }, data: { status: "open", statusChangedAt: now, ...(tags.includes(AI_STOP_TAG) ? {} : { tags: [...tags, AI_STOP_TAG] }) } }),
  );
  if (conversation.status !== "open") {
    await step("announce the status", async () =>
      (await import("@/lib/integrations/emitters")).emitStatusChanged(tenantId, { conversationId, contactId: conversation.contactId ?? null, from: conversation.status, to: "open", source: "system" }),
    );
  }
  const body = handoffNotice(period);
  await step("leave a note", async () => {
    const recent = await prisma.note.findFirst({ where: { tenantId, conversationId, authorId: SYSTEM_AUTHOR, body, createdAt: { gte: new Date(now.getTime() - 12 * 3_600_000) } }, select: { id: true } });
    if (!recent) await prisma.note.create({ data: { tenantId, conversationId, authorId: SYSTEM_AUTHOR, body, createdAt: now } });
  });
  await step("route the chat", async () => (await import("@/lib/routing")).assignConversation(tenantId, conversationId));
}

/** Handles one "send" job. Retryable Graph errors are rethrown so the queue backs off; permanent ones mark the message failed. */
export async function processSendJob(payload: unknown, context?: JobContext): Promise<void> {
  const job = asRec(payload);
  const messageId = str(job.messageId);
  const tenantId = str(job.tenantId);
  if (!messageId || !tenantId) return;
  if (!(await tenantMayRunBackground(tenantId))) return holdBlockedSend(job, messageId, tenantId, context);

  const message = await prisma.message.findFirst({
    where: { id: messageId, tenantId },
    include: { conversation: { include: { contact: true, phoneNumber: true } } },
  });
  if (!message || message.status !== "queued" || message.wamid) return;

  const { contact, phoneNumber } = message.conversation;
  const address = recipientAddress(contact);
  if (!address) return failUnsent(message, tenantId, "no_recipient");
  // STOP can arrive while a template waits in the queue: it is checked again at send time, not only when the message was queued.
  if (message.type === "template" && contact.optedOutAt) return failUnsent(message, tenantId, "opted_out");
  if ("bsuid" in address && message.type === "template" && (await isAuthenticationTemplate(tenantId, job))) {
    return failUnsent(message, tenantId, "bsuid_auth_template");
  }

  // The spend controls' single gate for outbound WhatsApp (docs/SPEND-CONTROLS-SPEC.md 4.9).
  const decision = await messagingGate(tenantId, job, message);
  if (decision.action === "hold") return holdBlockedSend(job, messageId, tenantId, context, { errorCode: decision.reason, retryAt: decision.retryAt });
  if (decision.action === "fail") {
    await markOutcome(message, tenantId, { status: "failed", errorCode: decision.code });
    if (decision.handoff) await handOffForLimit(tenantId, message.conversationId, decision.period ?? "month");
    return;
  }

  const attemptStartedAt = new Date();
  const flags = decision.overLimit ? { spend: "over_limit" } : undefined;
  try {
    const response = await decision.run(() =>
      graphFetch<SendResponse>({
        tenantId,
        path: `${phoneNumber.phoneNumberId}/messages`,
        method: "POST",
        body: buildSendBody(address, message, job),
      }),
    );
    const wamid = response.messages?.[0]?.id;
    if (!wamid) throw new GraphError("Graph response had no message id", 502);
    // The wamid is stored first: Meta's status webhook for it can arrive within milliseconds, and the processor drops a status for a
    // wamid it cannot find. noteWhatsAppTokenWorks never throws, so nothing below can turn an accepted send into a failed one.
    await markOutcome(message, tenantId, { status: "sent", wamid }, { spendState: spendStateAfter("sent") }, flags);
    await finishSend(decision.spend, "sent");
    await noteWhatsAppTokenWorks(tenantId);
  } catch (error) {
    // A retryable error keeps the reservation: the queue's next attempt reuses it instead of reserving again.
    if (error instanceof GraphError && error.retryable && !context?.isLastAttempt) throw error;
    const code = error instanceof GraphError ? (error.ambiguous ? "send_unconfirmed" : String(error.code ?? error.status)) : error instanceof NoValidTokenError ? "auth_expired" : "send_error";
    if (isAuthFailure(error)) await markWhatsAppAuthRejected(tenantId, attemptStartedAt);
    // An ambiguous POST may have reached Meta: it is recorded as failed but settled at its estimate, never released (4.9).
    const result: SendResult = error instanceof GraphError && error.ambiguous ? "ambiguous" : "failed";
    await markOutcome(message, tenantId, { status: "failed", errorCode: code }, { spendState: spendStateAfter(result) });
    await finishSend(decision.spend, result);
  }
}

/** Meta needs a phone number for one-time-password (authentication) templates; a username-only contact cannot receive them. */
async function isAuthenticationTemplate(tenantId: string, job: Record<string, unknown>): Promise<boolean> {
  const t = asRec(job.template);
  const name = str(t.name);
  const language = str(t.language);
  if (!name || !language) return false;
  const row = await prisma.template.findFirst({ where: { tenantId, name, language }, select: { category: true } });
  return row?.category?.toUpperCase() === "AUTHENTICATION";
}

async function markOutcome(
  message: { id: string; statusTimeline: unknown; conversationId: string; conversation?: { contact?: { id: string; phone?: string | null; bsuid?: string | null; waId?: string | null; username?: string | null; name?: string | null } | null } | null },
  tenantId: string,
  outcome: { status: "sent"; wamid: string } | { status: "failed"; errorCode: string },
  spend?: { spendState: "settled" | "released" },
  flags?: Record<string, string>,
) {
  const entry = { status: outcome.status, at: new Date().toISOString(), ...("errorCode" in outcome ? { errorCode: outcome.errorCode } : {}), ...(flags ?? {}) };
  await prisma.message.updateMany({
    where: { id: message.id, tenantId },
    data: { ...outcome, ...(spend ?? {}), statusTimeline: [...asJsonArr(message.statusTimeline), entry] },
  });
  await emitEvent(
    tenantId,
    "message.status",
    messageStatusPayload({
      messageId: message.id,
      conversationId: message.conversationId,
      wamid: "wamid" in outcome ? outcome.wamid : null,
      status: outcome.status,
      errorCode: "errorCode" in outcome ? outcome.errorCode : null,
      timestamp: entry.at,
      contact: message.conversation?.contact ?? null,
    }),
  );
}
