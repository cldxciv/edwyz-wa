import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { isUniqueViolation } from "./claims";

const NEGATIVE_TTL_MS = 60_000;
const NEGATIVE_MAX = 2000;
export const WEBHOOK_ID_TTL_MS = 48 * 3_600_000;
const PURGE_EVERY_MS = 10 * 60_000;
const WEBHOOK_ID = /^[A-Za-z0-9-]{8,64}$/;

const missing = new Map<string, number>();
let lastPurge = 0;

export function resetWebhookGuard(): void {
  missing.clear();
  lastPurge = 0;
}

/** Shops we recently found no store for. Spares the database from unauthenticated floods that name made-up shops. Per process, 60 seconds. */
export function isRecentlyMissing(shopDomain: string, now = Date.now()): boolean {
  const until = missing.get(shopDomain);
  if (until === undefined) return false;
  if (until <= now) {
    missing.delete(shopDomain);
    return false;
  }
  return true;
}

export function rememberMissing(shopDomain: string, now = Date.now()): void {
  if (missing.size >= NEGATIVE_MAX) missing.clear();
  missing.set(shopDomain, now + NEGATIVE_TTL_MS);
}

/** Called when a store is connected so its first webhooks are not rejected by an earlier negative lookup. */
export function forgetMissing(shopDomain: string): void {
  missing.delete(shopDomain);
}

export const parseWebhookId = (header: string | null): string | null => (header && WEBHOOK_ID.test(header.trim()) ? header.trim() : null);

const idKey = (storeId: string, webhookId: string) => `shopify:webhook:${storeId}:${webhookId}`;
const bodyKey = (storeId: string, digest: string) => `shopify:webhook:${storeId}:body:${digest}`;

/**
 * X-Shopify-Webhook-Id and X-Shopify-Topic are not covered by the HMAC, so replay protection keys on the signed content itself: a hash of
 * the raw body alone. Mixing the topic header in would let a replayer change it to obtain a "new" delivery.
 */
export const bodyDigest = (rawBody: string): string => createHash("sha256").update(rawBody, "utf8").digest("hex");

async function recordKey(key: string, now: number): Promise<"new" | "duplicate"> {
  try {
    await prisma.platformSetting.create({ data: { key, value: { at: new Date(now).toISOString() } } });
    return "new";
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
  }
  const renewed = await prisma.platformSetting.updateMany({ where: { key, updatedAt: { lt: new Date(now - WEBHOOK_ID_TTL_MS) } }, data: { value: { at: new Date(now).toISOString() } } });
  return renewed.count === 1 ? "new" : "duplicate";
}

/** Records the delivery id for 48 hours. "duplicate" means this exact delivery was already accepted (replay or Shopify retry). */
export const recordWebhookId = (storeId: string, webhookId: string, now = Date.now()) => recordKey(idKey(storeId, webhookId), now);

/**
 * Records a delivery by the digest of its signed content and, when present, by its delivery id. A replay of a captured body is a duplicate
 * even when the id header is missing or changed. Both rows live 48 hours; bodies older than that are refused by isStaleEvent.
 */
export async function recordDelivery(storeId: string, delivery: { digest: string; webhookId: string | null }, now = Date.now()): Promise<"new" | "duplicate"> {
  if ((await recordKey(bodyKey(storeId, delivery.digest), now)) === "duplicate") return "duplicate";
  if (delivery.webhookId && (await recordWebhookId(storeId, delivery.webhookId, now)) === "duplicate") return "duplicate";
  return "new";
}

/** Lets Shopify's retry through when processing failed after the id was recorded. */
export async function forgetWebhookId(storeId: string, webhookId: string): Promise<void> {
  await prisma.platformSetting.deleteMany({ where: { key: idKey(storeId, webhookId) } });
}

export async function forgetDelivery(storeId: string, delivery: { digest: string; webhookId: string | null }): Promise<void> {
  await prisma.platformSetting.deleteMany({ where: { key: bodyKey(storeId, delivery.digest) } });
  if (delivery.webhookId) await forgetWebhookId(storeId, delivery.webhookId);
}

/** An event whose own updated_at is older than the dedupe window can no longer be told apart from a replay, so it is not processed. */
export function isStaleEvent(body: Record<string, unknown>, now = Date.now()): boolean {
  const at = typeof body.updated_at === "string" ? Date.parse(body.updated_at) : NaN;
  return Number.isFinite(at) && now - at > WEBHOOK_ID_TTL_MS;
}

/** Opportunistic cleanup (at most every 10 minutes per process) of ids older than 48 hours. */
export async function purgeOldWebhookIds(now = Date.now()): Promise<void> {
  if (now - lastPurge < PURGE_EVERY_MS) return;
  lastPurge = now;
  try {
    await prisma.platformSetting.deleteMany({ where: { key: { startsWith: "shopify:webhook:" }, updatedAt: { lt: new Date(now - WEBHOOK_ID_TTL_MS) } } });
  } catch {
    lastPurge = 0;
  }
}
