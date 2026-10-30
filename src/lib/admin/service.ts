import { audit } from "@/lib/auth/audit";
import { normalizePhone } from "@/lib/contacts/phone";
import { PIN_REF_PREFIX } from "@/lib/crypto/tokens";
import { prisma } from "@/lib/db";
import { inlineSendable } from "@/lib/inbox/template-vars";
import { isWithinServiceWindow } from "@/lib/inbox/window";
import { HttpError } from "@/lib/tenancy";
import { tenantMayRunBackground } from "@/lib/tenant-state";
import { asArr, asRec } from "@/lib/webhooks/payload";
import { maskRecipient, type TestMessageInput } from "./testMessage";

export type TenantOverview = {
  id: string;
  name: string;
  createdAt: string;
  onboardingStatus: string;
  phoneNumbers: { id: string; wabaRefId: string; displayPhone: string; verifiedName: string | null; qualityRating: string | null; messagingLimitTier: string | null }[];
  recentLogs: { step: string; status: string; at: string }[];
};

const LOGS_PER_TENANT = 3;
const MAX_TENANTS = 200;

/** Workspaces holding a usable WhatsApp token (the same rule as getAccessToken). Only their numbers can send; the demo workspace never can. */
export async function tenantIdsWithSendableToken(tenantIds: string[]): Promise<Set<string>> {
  if (tenantIds.length === 0) return new Set();
  const rows = await prisma.accessToken.findMany({
    where: {
      tenantId: { in: tenantIds },
      OR: [{ wabaRefId: null }, { NOT: { wabaRefId: { startsWith: PIN_REF_PREFIX } } }],
      AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }],
    },
    select: { tenantId: true },
    distinct: ["tenantId"],
  });
  return new Set(rows.map((r) => r.tenantId));
}

export async function listTenantOverview(): Promise<TenantOverview[]> {
  const tenants = await prisma.tenant.findMany({
    orderBy: { createdAt: "desc" },
    take: MAX_TENANTS,
    select: {
      id: true,
      name: true,
      createdAt: true,
      onboardingStatus: true,
      wabas: { select: { phoneNumbers: { select: { id: true, wabaRefId: true, displayPhone: true, verifiedName: true, qualityRating: true, messagingLimitTier: true } } } },
    },
  });
  const logs = await prisma.onboardingLog.findMany({
    where: { tenantId: { in: tenants.map((t) => t.id) } },
    orderBy: { createdAt: "desc" },
    take: tenants.length * LOGS_PER_TENANT + 100,
    select: { tenantId: true, step: true, status: true, createdAt: true },
  });
  return tenants.map((t) => ({
    id: t.id,
    name: t.name,
    createdAt: t.createdAt.toISOString(),
    onboardingStatus: t.onboardingStatus,
    phoneNumbers: t.wabas.flatMap((w) => w.phoneNumbers),
    recentLogs: logs
      .filter((l) => l.tenantId === t.id)
      .slice(0, LOGS_PER_TENANT)
      .map((l) => ({ step: l.step, status: l.status, at: l.createdAt.toISOString() })),
  }));
}

/** An approved template the admin panel may offer. variables is null when the template needs more than body values (media header, button variable). */
export type ApprovedTemplateOption = { id: string; tenantId: string; wabaRefId: string; name: string; language: string; category: string; variables: number | null };

export async function listApprovedTemplatesByTenant(tenantIds: string[]): Promise<ApprovedTemplateOption[]> {
  if (tenantIds.length === 0) return [];
  const rows = await prisma.template.findMany({
    where: { tenantId: { in: tenantIds }, status: "approved" },
    select: { id: true, tenantId: true, wabaRefId: true, name: true, language: true, category: true, components: true },
    orderBy: { name: "asc" },
  });
  return rows.map((t) => {
    const sendable = inlineSendable(t.components);
    return { id: t.id, tenantId: t.tenantId, wabaRefId: t.wabaRefId, name: t.name, language: t.language, category: t.category, variables: sendable.ok ? sendable.variables : null };
  });
}

export const ADMIN_TEST_SOURCE = "admin_test";
export const NO_TOKEN_MESSAGE = "This workspace has no valid WhatsApp token, so nothing can be sent. Connect WhatsApp in that workspace first.";
export const HELD_MESSAGE = "This workspace is suspended or read-only, so its messages are held.";
/** Plain text to a number that has never written to this business number: the quickest fix is a message from that phone. */
export const NO_CHAT_MESSAGE =
  "This number has not messaged the business number yet, so plain text cannot reach it. Send any message from that phone to the business number first, or send an approved template.";
export const WINDOW_MESSAGE = "The 24-hour customer service window is closed. Send an approved template message instead, or have that phone message the business number again to reopen it.";
export const NEEDS_VALUES_MESSAGE = "This template needs values filled in, so it cannot be sent from here. Send it from that workspace's inbox.";
export const NOT_INLINE_MESSAGE = "This template cannot be sent from here.";

export type TestMessageResult = { ok: true; messageId: string; conversationId: string; status: "queued" };

/**
 * The inbox outbound path is loaded when a test is actually sent, not when this module is imported: every admin route answers a
 * stranger with a 404 and has to stay cheap to load, and the inbox service pulls in the automation, chatbot and routing graph.
 */
async function loadOutbound() {
  const [{ resolveContact }, { sendTemplateMessage, sendText }] = await Promise.all([import("@/lib/inbox/new-chat"), import("@/lib/inbox/service")]);
  return { resolveContact, sendTemplateMessage, sendText };
}

/**
 * Queues one real message through the workspace's own outbound path (contact, chat and Message row, then the send job), so the
 * worker stores the wamid and later status webhooks (delivered, read, failed) land on the row the panel polls. Nothing is written
 * for a workspace that cannot send, and a chat or contact created here is removed again when the send is refused.
 */
export async function sendTestMessage(adminUserId: string, input: TestMessageInput): Promise<TestMessageResult> {
  const phone = await prisma.phoneNumber.findUnique({ where: { id: input.phoneNumberRef }, select: { id: true, tenantId: true, phoneNumberId: true, wabaRefId: true } });
  if (!phone) throw new HttpError(404, "Phone number not found.");
  const { tenantId } = phone;
  const meta: Record<string, unknown> = { phoneNumberRef: phone.id, to: maskRecipient(input.to), mode: input.mode, ...(input.templateId ? { templateId: input.templateId } : {}) };
  const refuse = async (status: number, message: string): Promise<never> => {
    await audit({ tenantId, userId: adminUserId, action: "admin.test_message", target: phone.id, meta: { ...meta, result: "refused", reason: message } });
    throw new HttpError(status, message);
  };

  if (!(await tenantIdsWithSendableToken([tenantId])).has(tenantId)) return refuse(409, NO_TOKEN_MESSAGE);
  if (!(await tenantMayRunBackground(tenantId))) return refuse(409, HELD_MESSAGE);

  // Contact.phone is stored with the leading plus, so the admin send reuses the contact the inbound webhook created.
  const recipient = normalizePhone(`+${input.to}`);
  if (!recipient) throw new HttpError(400, "Enter the recipient number with country code, for example +919876543210.");

  let template: { name: string; language: string } | null = null;
  if (input.mode === "template") {
    if (!input.templateId) throw new HttpError(400, "Choose a template.");
    // Scoped to the sending number's WhatsApp Business Account, which is what the picker shows; a template of another account on the
    // same workspace would only fail at Meta (132001) after the row was written.
    const row = await prisma.template.findFirst({ where: { id: input.templateId, tenantId, wabaRefId: phone.wabaRefId }, select: { name: true, language: true, status: true, components: true } });
    if (!row) return refuse(404, "Template not found.");
    if (row.status !== "approved") return refuse(409, "Only approved templates can be sent.");
    const sendable = inlineSendable(row.components);
    if (!sendable.ok) return refuse(409, `${NOT_INLINE_MESSAGE} ${sendable.reason}`);
    if (sendable.variables > 0) return refuse(409, NEEDS_VALUES_MESSAGE);
    template = { name: row.name, language: row.language };
  }

  const existingContact = await prisma.contact.findFirst({ where: { tenantId, phone: recipient }, select: { id: true } });
  const existingConversation = existingContact
    ? await prisma.conversation.findFirst({ where: { tenantId, phoneNumberId: phone.id, contactId: existingContact.id }, select: { id: true, lastInboundAt: true } })
    : null;
  // Free text needs an open window; with no chat yet it is closed by definition, so refuse before any row is written.
  if (input.mode === "text" && !existingConversation) return refuse(409, NO_CHAT_MESSAGE);
  if (input.mode === "text" && !isWithinServiceWindow(existingConversation?.lastInboundAt)) return refuse(409, WINDOW_MESSAGE);

  const { resolveContact, sendTemplateMessage, sendText } = await loadOutbound();
  // Only rows this call inserted are removed on a refusal: a chat the inbound webhook created in the same instant must survive.
  let contactId: string | null = null;
  let createdContact = false;
  let conversationId: string | null = null;
  let createdConversation = false;
  const undo = async () => {
    try {
      if (createdConversation && conversationId) await prisma.conversation.deleteMany({ where: { id: conversationId, tenantId } });
      if (createdContact && contactId) await prisma.contact.deleteMany({ where: { id: contactId, tenantId } });
    } catch {
      console.error("[admin] could not remove the unused chat after a refused test message");
    }
  };

  try {
    const resolved = await resolveContact(tenantId, { phone: recipient });
    contactId = resolved.contact.id;
    createdContact = resolved.created;
    if (existingConversation) {
      conversationId = existingConversation.id;
    } else {
      try {
        conversationId = (await prisma.conversation.create({ data: { tenantId, phoneNumberId: phone.id, contactId }, select: { id: true } })).id;
        createdConversation = true;
      } catch (e) {
        if ((e as { code?: string })?.code !== "P2002") throw e;
        const raced = await prisma.conversation.findFirst({ where: { tenantId, phoneNumberId: phone.id, contactId }, select: { id: true } });
        if (!raced) throw e;
        conversationId = raced.id;
      }
    }
    const message = template
      ? await sendTemplateMessage({ tenantId, phoneNumberId: phone.id, contactId, conversationId, templateName: template.name, language: template.language, components: [], userId: adminUserId, source: ADMIN_TEST_SOURCE, origin: "admin_test" })
      : await sendText({ tenantId, conversationId, userId: adminUserId, body: input.text, source: ADMIN_TEST_SOURCE, origin: "admin_test" });
    await audit({ tenantId, userId: adminUserId, action: "admin.test_message", target: phone.id, meta: { ...meta, result: "queued", messageId: message.id, conversationId } });
    return { ok: true, messageId: message.id, conversationId, status: "queued" };
  } catch (e) {
    await undo();
    if (e instanceof HttpError) return refuse(e.status, e.message);
    throw e;
  }
}

export type TestMessageStatus = {
  id: string;
  conversationId: string;
  status: string;
  statusTimeline: unknown[];
  errorCode: string | null;
  wamid: string | null;
  hint: string | null;
  inboxHref: string;
};

export const WORKER_WAIT_HINT = "Waiting for the background worker to send it.";

/**
 * The polled status of one admin test send. Scoped to messages this admin queued from the panel (sentByUserId plus the admin_test
 * marker), since the platform admin is not a member of the customer workspace; anything else is 404. Body and recipient are never returned.
 */
export async function getTestMessageStatus(adminUserId: string, messageId: string): Promise<TestMessageStatus> {
  const message = await prisma.message.findFirst({
    where: { id: messageId, direction: "outbound", sentByUserId: adminUserId },
    select: { id: true, conversationId: true, status: true, statusTimeline: true, errorCode: true, wamid: true },
  });
  const timeline = asArr(message?.statusTimeline);
  if (!message || asRec(timeline[0]).source !== ADMIN_TEST_SOURCE) throw new HttpError(404, "Not found.");
  // The same sentence the panel shows under a failed send (one source of truth for the copied details); loaded on demand for the reason given at loadOutbound.
  const hint = message.status === "failed" ? (await import("@/components/admin/helpers")).testFailureBody(message.errorCode) : message.status === "queued" ? WORKER_WAIT_HINT : null;
  return {
    id: message.id,
    conversationId: message.conversationId,
    status: message.status,
    statusTimeline: timeline,
    errorCode: message.errorCode,
    wamid: message.wamid,
    hint,
    inboxHref: `/app/inbox?c=${encodeURIComponent(message.conversationId)}`,
  };
}
