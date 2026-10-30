import { randomUUID } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { enqueue } from "@/lib/queue";

export const WEBHOOK_EVENTS = ["message.received", "message.status", "template.status", "broadcast.completed", "contact.opted_out", "conversation.status_changed", "lead.created"] as const;
export type WebhookEventName = (typeof WEBHOOK_EVENTS)[number];
export const TEST_EVENT = "webhook.test";
export const DELIVERY_QUEUE = "outbound-webhook";
export const MAX_DELIVERY_ATTEMPTS = 6;

export const isWebhookEvent = (value: unknown): value is WebhookEventName => (WEBHOOK_EVENTS as readonly unknown[]).includes(value);

export type EventEnvelope = { id: string; event: string; createdAt: string; data: unknown };

export async function queueDelivery(tenantId: string, endpointId: string, event: string, data: unknown) {
  const envelope: EventEnvelope = { id: randomUUID(), event, createdAt: new Date().toISOString(), data };
  const delivery = await prisma.webhookDelivery.create({
    data: { tenantId, endpointId, event, payload: envelope as unknown as Prisma.InputJsonValue },
    select: { id: true },
  });
  await enqueue(DELIVERY_QUEUE, { deliveryId: delivery.id, tenantId }, { maxAttempts: MAX_DELIVERY_ATTEMPTS });
  return delivery.id;
}

/**
 * Records one delivery per enabled endpoint subscribed to the event and queues it. Never throws and never blocks
 * the caller's work: a failure here is logged without payload content.
 */
export async function emitEvent(tenantId: string, event: WebhookEventName, data: unknown): Promise<void> {
  try {
    const endpoints = await prisma.webhookEndpoint.findMany({ where: { tenantId, enabled: true, events: { has: event } }, select: { id: true } });
    for (const endpoint of endpoints) await queueDelivery(tenantId, endpoint.id, event, data);
  } catch {
    console.error(`[integrations] could not record ${event} event`);
  }
}
