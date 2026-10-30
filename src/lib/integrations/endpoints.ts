import { encrypt } from "@/lib/crypto/tokens";
import { prisma } from "@/lib/db";
import { HttpError } from "@/lib/tenancy";
import { isWebhookEvent, queueDelivery, TEST_EVENT, WEBHOOK_EVENTS } from "./events";
import { generateSigningSecret } from "./signing";
import { assertPublicUrl, type Resolver } from "./ssrf";

export const MAX_ENDPOINTS = 10;

const publicFields = { id: true, url: true, events: true, enabled: true, failureCount: true, createdAt: true } as const;

function parseEvents(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((e) => !isWebhookEvent(e))) {
    throw new HttpError(400, `Choose at least one event: ${WEBHOOK_EVENTS.join(", ")}.`);
  }
  return [...new Set(value as string[])];
}

export async function listEndpoints(tenantId: string) {
  return prisma.webhookEndpoint.findMany({ where: { tenantId }, orderBy: { createdAt: "asc" }, select: publicFields });
}

/** Returns the endpoint plus the signing secret, which is shown to the user exactly once. */
export async function createEndpoint(tenantId: string, input: { url: unknown; events: unknown }, resolve?: Resolver) {
  if (typeof input.url !== "string") throw new HttpError(400, "A URL is required.");
  const events = parseEvents(input.events);
  await assertPublicUrl(input.url.trim(), resolve);
  if ((await prisma.webhookEndpoint.count({ where: { tenantId } })) >= MAX_ENDPOINTS) throw new HttpError(409, `You can have up to ${MAX_ENDPOINTS} endpoints.`);
  const secret = generateSigningSecret();
  const enc = encrypt(secret);
  const endpoint = await prisma.webhookEndpoint.create({
    data: { tenantId, url: input.url.trim(), events, secretCiphertext: enc.ciphertext, iv: enc.iv, authTag: enc.authTag },
    select: publicFields,
  });
  return { endpoint, secret };
}

export async function updateEndpoint(tenantId: string, id: string, input: { url?: unknown; events?: unknown; enabled?: unknown }, resolve?: Resolver) {
  const data: { url?: string; events?: string[]; enabled?: boolean; failureCount?: number } = {};
  if (input.url !== undefined) {
    if (typeof input.url !== "string") throw new HttpError(400, "The URL is not valid.");
    await assertPublicUrl(input.url.trim(), resolve);
    data.url = input.url.trim();
  }
  if (input.events !== undefined) data.events = parseEvents(input.events);
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== "boolean") throw new HttpError(400, "enabled must be true or false.");
    data.enabled = input.enabled;
    if (input.enabled) data.failureCount = 0;
  }
  const { count } = await prisma.webhookEndpoint.updateMany({ where: { id, tenantId }, data });
  if (count === 0) throw new HttpError(404, "Endpoint not found.");
  return prisma.webhookEndpoint.findFirst({ where: { id, tenantId }, select: publicFields });
}

export async function rotateSecret(tenantId: string, id: string) {
  const secret = generateSigningSecret();
  const enc = encrypt(secret);
  const { count } = await prisma.webhookEndpoint.updateMany({ where: { id, tenantId }, data: { secretCiphertext: enc.ciphertext, iv: enc.iv, authTag: enc.authTag } });
  if (count === 0) throw new HttpError(404, "Endpoint not found.");
  return { secret };
}

export async function deleteEndpoint(tenantId: string, id: string) {
  const { count } = await prisma.webhookEndpoint.deleteMany({ where: { id, tenantId } });
  if (count === 0) throw new HttpError(404, "Endpoint not found.");
  await prisma.webhookDelivery.deleteMany({ where: { tenantId, endpointId: id } });
}

export async function listDeliveries(tenantId: string, endpointId: string, limit = 25) {
  const endpoint = await prisma.webhookEndpoint.findFirst({ where: { id: endpointId, tenantId }, select: { id: true } });
  if (!endpoint) throw new HttpError(404, "Endpoint not found.");
  return prisma.webhookDelivery.findMany({
    where: { tenantId, endpointId },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(limit, 1), 100),
    select: { id: true, event: true, status: true, attempts: true, lastStatus: true, lastError: true, createdAt: true },
  });
}

/** Queues a ping to this endpoint only, whatever events it subscribes to. */
export async function sendTestEvent(tenantId: string, id: string) {
  const endpoint = await prisma.webhookEndpoint.findFirst({ where: { id, tenantId }, select: { id: true } });
  if (!endpoint) throw new HttpError(404, "Endpoint not found.");
  return { deliveryId: await queueDelivery(tenantId, id, TEST_EVENT, { message: "This is a test event from Edwyz WA." }) };
}
