import { prisma } from "@/lib/db";
import { enqueue } from "@/lib/queue";

export type ConversionInput = { leadId?: string; contactId?: string; eventName: "Lead" | "QualifiedLead" | "Purchase" | "Contact"; eventTime?: Date };

export const CONVERSIONS_QUEUE = "conversions";

export async function enqueueDelivery(tenantId: string, conversionEventId: string): Promise<void> {
  await enqueue(CONVERSIONS_QUEUE, { tenantId, conversionEventId }, { maxAttempts: 5 });
}

/** Records a ConversionEvent and queues delivery to Meta. Never throws to the caller for delivery problems; skips quietly when no dataset is connected. */
export async function queueConversion(tenantId: string, input: ConversionInput): Promise<void> {
  try {
    if (!input.leadId && !input.contactId) return;
    if (input.leadId) {
      const lead = await prisma.lead.findFirst({ where: { id: input.leadId, tenantId }, select: { id: true } });
      if (!lead) return;
    } else if (input.contactId) {
      const contact = await prisma.contact.findFirst({ where: { id: input.contactId, tenantId }, select: { id: true } });
      if (!contact) return;
    }
    const existing = await prisma.conversionEvent.findFirst({
      where: {
        tenantId,
        eventName: input.eventName,
        status: { in: ["pending", "sent"] },
        ...(input.leadId ? { leadId: input.leadId } : { contactId: input.contactId, leadId: null }),
      },
      select: { id: true },
    });
    if (existing) return;
    const event = await prisma.conversionEvent.create({
      data: {
        tenantId,
        leadId: input.leadId ?? null,
        contactId: input.contactId ?? null,
        datasetId: "",
        eventName: input.eventName,
        eventTime: input.eventTime ?? new Date(),
        status: "pending",
      },
      select: { id: true },
    });
    await enqueueDelivery(tenantId, event.id);
  } catch {
    return;
  }
}
