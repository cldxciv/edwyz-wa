import { prisma } from "@/lib/db";
import { emitEvent } from "./events";
import { broadcastCompletedPayload, broadcastTotals, conversationStatusChangedPayload, leadCreatedPayload } from "./payloads";

/** A conversation moved between statuses. source is "user" for a person or API key, "system" for automations and customer replies. */
export async function emitStatusChanged(tenantId: string, i: { conversationId: string; contactId: string | null; from: string | null; to: string; changedBy?: string | null; source: "user" | "system" }): Promise<void> {
  if (i.from === i.to) return;
  await emitEvent(tenantId, "conversation.status_changed", conversationStatusChangedPayload({ ...i, changedBy: i.changedBy ?? null, timestamp: new Date() }));
}

async function recipientCounts(tenantId: string, broadcastId: string): Promise<Record<string, number>> {
  try {
    const groups = await prisma.broadcastRecipient.groupBy({ by: ["status"], where: { tenantId, broadcastId }, _count: { _all: true } });
    return Object.fromEntries(groups.map((g) => [g.status, g._count._all]));
  } catch {
    return {};
  }
}

export async function emitBroadcastCompleted(tenantId: string, b: { id: string; name?: string | null; templateId?: string | null }, completedAt: Date): Promise<void> {
  const totals = broadcastTotals(await recipientCounts(tenantId, b.id));
  await emitEvent(tenantId, "broadcast.completed", broadcastCompletedPayload({ broadcastId: b.id, name: b.name ?? null, templateId: b.templateId ?? null, completedAt, totals }));
}

type LeadRow = { id: string; status: string; fields: unknown; campaignMetaId: string | null; adMetaId: string | null; createdAt: Date; contactId: string | null; leadForm?: { metaFormId: string } | null; leadFormId?: string | null };

const asText = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : "");

export function leadFieldsAsText(fields: unknown): Record<string, string> {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields as Record<string, unknown>).slice(0, 100)) out[k.slice(0, 80)] = asText(v).slice(0, 500);
  return out;
}

export async function emitLeadCreated(tenantId: string, lead: LeadRow, metaFormId?: string | null): Promise<void> {
  const contact = lead.contactId
    ? await prisma.contact.findFirst({ where: { id: lead.contactId, tenantId }, select: { id: true, phone: true, bsuid: true, waId: true, username: true, name: true } }).catch(() => null)
    : null;
  await emitEvent(
    tenantId,
    "lead.created",
    leadCreatedPayload({
      leadId: lead.id,
      status: lead.status,
      formId: metaFormId ?? lead.leadForm?.metaFormId ?? null,
      campaignId: lead.campaignMetaId,
      adId: lead.adMetaId,
      createdAt: lead.createdAt,
      contact,
      fields: leadFieldsAsText(lead.fields),
    }),
  );
}
