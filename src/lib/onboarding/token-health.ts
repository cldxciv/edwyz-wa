import { PIN_REF_PREFIX } from "@/lib/crypto/tokens";
import { prisma } from "@/lib/db";
import { GraphError } from "@/lib/graph";

/** Embedded Signup tokens that expire (the 60 day configuration) are flagged this many days ahead. */
export const EXPIRING_DAYS = 14;
const DAY_MS = 86_400_000;
export const REJECTED_FLAG_PREFIX = "wa-auth-rejected:";
const FLAG_PREFIX = REJECTED_FLAG_PREFIX;

export type TokenState = "none" | "ok" | "expiring" | "expired" | "rejected";
export type TokenHealth = { state: TokenState; expiresAt: string | null; daysLeft: number | null };

type TokenRow = { createdAt: Date; expiresAt: Date | null };

const notPin = { OR: [{ wabaRefId: null }, { NOT: { wabaRefId: { startsWith: PIN_REF_PREFIX } } }] };

/**
 * Pure rule. A token Meta refused (error 190 on a send) after this token was stored is "rejected" whatever its stored expiry says;
 * a newer token (a reconnect) clears an older rejection without any cleanup.
 */
export function classifyToken(row: TokenRow | null, rejectedAt: Date | null, now = new Date()): TokenHealth {
  if (!row) return { state: "none", expiresAt: null, daysLeft: null };
  const expiresAt = row.expiresAt ? row.expiresAt.toISOString() : null;
  if (rejectedAt && rejectedAt.getTime() >= row.createdAt.getTime()) return { state: "rejected", expiresAt, daysLeft: null };
  if (!row.expiresAt) return { state: "ok", expiresAt: null, daysLeft: null };
  const msLeft = row.expiresAt.getTime() - now.getTime();
  if (msLeft <= 0) return { state: "expired", expiresAt, daysLeft: 0 };
  const daysLeft = Math.ceil(msLeft / DAY_MS);
  return { state: daysLeft <= EXPIRING_DAYS ? "expiring" : "ok", expiresAt, daysLeft };
}

export async function latestTokenRow(tenantId: string): Promise<(TokenRow & { id: string }) | null> {
  return prisma.accessToken.findFirst({ where: { tenantId, ...notPin }, orderBy: { createdAt: "desc" }, select: { id: true, createdAt: true, expiresAt: true } });
}

async function rejectedAt(tenantId: string): Promise<Date | null> {
  const row = await prisma.platformSetting.findUnique({ where: { key: `${FLAG_PREFIX}${tenantId}` }, select: { updatedAt: true } });
  return row?.updatedAt ?? null;
}

export async function getWhatsAppTokenHealth(tenantId: string, now = new Date()): Promise<TokenHealth> {
  const [row, flagged] = await Promise.all([latestTokenRow(tenantId), rejectedAt(tenantId)]);
  return classifyToken(row, flagged, now);
}

/** Meta error 190 (invalid or expired token) or an OAuth 401 on a Graph call that used the workspace token. */
export function isAuthFailure(error: unknown): boolean {
  return error instanceof GraphError && (error.code === 190 || (error.status === 401 && error.code === undefined));
}

/**
 * Remembers that Meta refused the workspace token. Never throws: a failed write must not change how the send job ends.
 * attemptStartedAt is when the failed call began: if a newer token was stored since (a reconnect finished while the call was in
 * flight), the refusal belongs to the old token and is ignored, so a reconnect is never undone by a late 190.
 */
export async function markWhatsAppAuthRejected(tenantId: string, attemptStartedAt?: Date): Promise<void> {
  const key = `${FLAG_PREFIX}${tenantId}`;
  try {
    if (attemptStartedAt) {
      const newest = await latestTokenRow(tenantId);
      if (newest && newest.createdAt.getTime() > attemptStartedAt.getTime()) return;
    }
    await prisma.platformSetting.upsert({ where: { key }, create: { key, value: { reason: "token_rejected" } }, update: { value: { reason: "token_rejected" } } });
  } catch {
    console.error("[onboarding] could not record the rejected WhatsApp token");
  }
}

export async function clearWhatsAppAuthRejected(tenantId: string): Promise<void> {
  await prisma.platformSetting.deleteMany({ where: { key: `${FLAG_PREFIX}${tenantId}` } }).catch(() => undefined);
}

const CLEAR_EVERY_MS = 60_000;
const lastClear = new Map<string, number>();

/**
 * Call after Meta accepted a send made with the workspace token: the token demonstrably works, so a rejected flag left by a one-off
 * 190 is dropped. Throttled to one delete per workspace per minute per process so a busy queue pays almost nothing. Never throws.
 */
export async function noteWhatsAppTokenWorks(tenantId: string, now = Date.now()): Promise<void> {
  const last = lastClear.get(tenantId);
  if (last !== undefined && now - last < CLEAR_EVERY_MS) return;
  if (lastClear.size > 5000) lastClear.clear();
  lastClear.set(tenantId, now);
  try {
    await clearWhatsAppAuthRejected(tenantId);
  } catch {
    // The flag is informational; a failed delete is retried by the next successful send.
  }
}

/** Test helper: forgets the throttle. */
export function resetTokenWorksThrottle(): void {
  lastClear.clear();
}

/** Deletes tokens older than the one just stored. They can never be used again (the newest valid row always wins) and hold ciphertext for no reason. */
export async function pruneOlderTokens(tenantId: string, keepId: string): Promise<number> {
  const keep = await prisma.accessToken.findFirst({ where: { id: keepId, tenantId }, select: { createdAt: true } });
  if (!keep) return 0;
  const { count } = await prisma.accessToken.deleteMany({ where: { tenantId, id: { not: keepId }, createdAt: { lt: keep.createdAt }, ...notPin } });
  return count;
}
