import { audit } from "@/lib/auth/audit";
import { CONSENT_ACTIONS } from "@/lib/contacts/consent";
import { prisma } from "@/lib/db";
import { BOM, csvRow } from "@/lib/reports/csv";
import { HttpError } from "@/lib/tenancy";
import { RETENTION_DEFAULTS } from "./personal-data";

/** Most messages one person export carries. A person with more gets the newest ones and truncated: true. */
export const CONTACT_EXPORT_MESSAGE_CAP = 20_000;
const SIDE_CAP = 2_000;

type Actor = { tenantId: string; userId: string };

/** The export line about Eddy (docs/EDDY-SPEC.md 7.6): a count, since the records are the members' own working notes. */
export function eddyRecordsLine(count: number, days: number): string {
  return `Eddy assistant records that mention this contact: ${count} (deleted after ${days} days)`;
}

/**
 * How many Eddy records mention the contact: the Eddy conversations with a message about them, plus the action records
 * (previews and confirmed actions) that name them. Never fails the export: a store that cannot be read counts as 0.
 */
async function countEddyRecords(tenantId: string, contactId: string): Promise<{ count: number; days: number }> {
  let days: number = RETENTION_DEFAULTS.eddyHistoryDays;
  try {
    days = (await (await import("./retention")).getRetentionConfig()).eddyHistoryDays ?? days;
  } catch {
    // The default period stands.
  }
  try {
    const [messages, actions] = await Promise.all([
      prisma.eddyMessage.findMany({ where: { tenantId, contactIds: { has: contactId } }, select: { conversationId: true }, take: 10_000 }),
      prisma.actionRecord.count({ where: { tenantId, contactIds: { has: contactId } } }),
    ]);
    return { count: new Set(messages.map((m) => m.conversationId)).size + actions, days };
  } catch {
    return { count: 0, days };
  }
}

/**
 * Everything the workspace holds about one contact, for a data-access request: the contact record, consent history, conversations
 * with their messages and internal notes, broadcast delivery rows, leads and automation or conversion log entries.
 * Every query is scoped to the tenant. Nothing here carries tokens, hashes or other people's personal data (staff appear only as ids).
 * It also says how many Eddy assistant records mention the contact (EDDY-SPEC 7.6); those records go after 90 days.
 */
export async function buildContactExport(actor: Actor, contactId: string, now = new Date()) {
  const tenantId = actor.tenantId;
  const contact = await prisma.contact.findFirst({ where: { id: contactId, tenantId } });
  if (!contact) throw new HttpError(404, "Contact not found.");

  const conversations = await prisma.conversation.findMany({ where: { tenantId, contactId }, orderBy: { createdAt: "asc" }, take: SIDE_CAP });
  const conversationIds = conversations.map((c) => c.id);
  const inConversations = { tenantId, conversationId: { in: conversationIds } };

  const [newestFirst, notes, recipients, leads, consent, rules, conversions] = await Promise.all([
    conversationIds.length
      ? prisma.message.findMany({ where: inConversations, orderBy: { createdAt: "desc" }, take: CONTACT_EXPORT_MESSAGE_CAP + 1 })
      : Promise.resolve([]),
    conversationIds.length ? prisma.note.findMany({ where: inConversations, orderBy: { createdAt: "asc" }, take: SIDE_CAP }) : Promise.resolve([]),
    prisma.broadcastRecipient.findMany({
      where: { tenantId, contactId },
      include: { broadcast: { select: { name: true, createdAt: true } } },
      orderBy: { id: "asc" },
      take: SIDE_CAP,
    }),
    prisma.lead.findMany({ where: { tenantId, contactId }, orderBy: { createdAt: "asc" }, take: SIDE_CAP }),
    prisma.auditLog.findMany({
      where: { tenantId, target: contactId, action: { in: [...CONSENT_ACTIONS] } },
      orderBy: { createdAt: "asc" },
      select: { action: true, createdAt: true, meta: true },
      take: SIDE_CAP,
    }),
    prisma.ruleExecution.findMany({ where: { tenantId, contactId }, orderBy: { createdAt: "asc" }, take: SIDE_CAP, select: { ruleId: true, conversationId: true, outcome: true, createdAt: true } }),
    prisma.conversionEvent.findMany({ where: { tenantId, contactId }, orderBy: { createdAt: "asc" }, take: SIDE_CAP, select: { eventName: true, eventTime: true, status: true, createdAt: true } }),
  ]);

  const truncated = newestFirst.length > CONTACT_EXPORT_MESSAGE_CAP;
  const messages = newestFirst.slice(0, CONTACT_EXPORT_MESSAGE_CAP).reverse();
  const eddy = await countEddyRecords(tenantId, contactId);
  return {
    exportedAt: now.toISOString(),
    workspaceId: tenantId,
    truncated,
    contact,
    consentHistory: consent,
    conversations,
    messages,
    notes,
    broadcastDeliveries: recipients.map(({ broadcast, ...r }) => ({ ...r, broadcastName: broadcast?.name ?? null, broadcastCreatedAt: broadcast?.createdAt ?? null })),
    leads,
    automationLog: rules,
    conversionEvents: conversions,
    eddyAssistantRecords: { count: eddy.count, note: eddyRecordsLine(eddy.count, eddy.days) },
  };
}

export type ContactExport = Awaited<ReturnType<typeof buildContactExport>>;

/** One spreadsheet: the contact's messages (the part people usually want to read), formula-safe. */
export function contactExportCsv(data: ContactExport): string {
  const head = ["conversation_id", "created_at", "direction", "type", "body", "template", "status", "error_code"];
  const rows = data.messages.map((m) => csvRow([m.conversationId, m.createdAt, m.direction, m.type, m.body, m.templateName, m.status, m.errorCode]));
  return BOM + csvRow(head) + rows.join("");
}

export async function exportContact(actor: Actor, contactId: string, format: "json" | "csv") {
  const data = await buildContactExport(actor, contactId);
  await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "export.contact", target: contactId, meta: { format, messages: data.messages.length, truncated: data.truncated } });
  return data;
}
