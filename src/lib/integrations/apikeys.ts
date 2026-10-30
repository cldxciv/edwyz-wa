import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/db";
import { createLimiter } from "@/lib/ratelimit";
import { type Actor, HttpError } from "@/lib/tenancy";
import { API_SCOPES, type ApiScope, assertScope } from "./scopes";

export { API_SCOPES };
export type { ApiScope };

export const KEY_PREFIX = "wak_";
export const RATE_LIMIT = 60;
export const RATE_WINDOW_MS = 60_000;
export const LAST_USED_INTERVAL_MS = 60_000;
export const MAX_KEYS = 20;

const limiter = createLimiter(RATE_LIMIT, RATE_WINDOW_MS, "apikey");
export const resetRateLimits = () => limiter.clear();

export const hashApiKey = (key: string) => createHash("sha256").update(key, "utf8").digest("hex");

export function generateApiKey() {
  const key = `${KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { key, prefix: key.slice(0, 8), hash: hashApiKey(key) };
}

export function parseScopes(value: unknown): ApiScope[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((s) => !(API_SCOPES as readonly unknown[]).includes(s))) {
    throw new HttpError(400, `Choose at least one scope: ${API_SCOPES.join(", ")}.`);
  }
  return [...new Set(value as ApiScope[])];
}

export async function createApiKey(actor: Actor, input: { name: unknown; scopes: unknown }) {
  if (typeof input.name !== "string" || !input.name.trim() || input.name.length > 60) throw new HttpError(400, "Give the key a name (up to 60 characters).");
  const scopes = parseScopes(input.scopes);
  if ((await prisma.apiKey.count({ where: { tenantId: actor.tenantId, revokedAt: null } })) >= MAX_KEYS) throw new HttpError(409, `You can have up to ${MAX_KEYS} active keys.`);
  const { key, prefix, hash } = generateApiKey();
  const row = await prisma.apiKey.create({
    data: { tenantId: actor.tenantId, name: input.name.trim(), prefix, keyHash: hash, scopes, createdByUserId: actor.userId },
    select: { id: true, name: true, prefix: true, scopes: true, createdAt: true },
  });
  return { apiKey: row, key };
}

type Standing = "live" | "gone" | "closed" | "suspended";

type CreatorMembership = { createdAt?: Date; user?: { disabledAt: Date | null } | null; tenant?: { deletedAt: Date | null; status: string } | null } | null;

/**
 * "gone": the creator has no membership, is disabled, or joined the workspace after the key was made (removed and re-added), so the key
 * must stay dead even if the person comes back. "closed": workspace deleted. "suspended": workspace not active.
 */
function standingOf(membership: CreatorMembership, keyCreatedAt: Date | undefined): Standing {
  if (!membership?.user || !membership.tenant) return "gone";
  if (membership.user.disabledAt) return "gone";
  if (membership.createdAt && keyCreatedAt && membership.createdAt.getTime() > keyCreatedAt.getTime()) return "gone";
  if (membership.tenant.deletedAt) return "closed";
  return membership.tenant.status === "active" ? "live" : "suspended";
}

/** Keys of members who are gone are revoked for good the first time anyone looks, so a later re-invite or re-enable cannot revive them. */
export async function listApiKeys(tenantId: string) {
  const rows = await prisma.apiKey.findMany({
    where: { tenantId },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, prefix: true, scopes: true, lastUsedAt: true, revokedAt: true, createdAt: true, createdByUserId: true },
  });
  const gone = new Set<string>();
  try {
    const active = rows.filter((r) => !r.revokedAt);
    if (active.length > 0) {
      const members = await prisma.membership.findMany({
        where: { tenantId, userId: { in: [...new Set(active.map((r) => r.createdByUserId))] } },
        select: { userId: true, createdAt: true, user: { select: { disabledAt: true } }, tenant: { select: { deletedAt: true, status: true } } },
      });
      const byUser = new Map(members.map((m) => [m.userId, m]));
      for (const r of active) if (standingOf(byUser.get(r.createdByUserId) ?? null, r.createdAt) === "gone") gone.add(r.id);
      if (gone.size > 0) await prisma.apiKey.updateMany({ where: { id: { in: [...gone] }, tenantId, revokedAt: null }, data: { revokedAt: new Date() } });
    }
  } catch {
    gone.clear();
  }
  const now = new Date();
  return rows.map(({ createdByUserId: _creator, ...key }) => (gone.has(key.id) ? { ...key, revokedAt: now } : key));
}

export async function revokeApiKey(tenantId: string, id: string) {
  const { count } = await prisma.apiKey.updateMany({ where: { id, tenantId, revokedAt: null }, data: { revokedAt: new Date() } });
  if (count === 0) throw new HttpError(404, "Key not found or already revoked.");
}

export type KeyRemoval = "revoked" | "removed";

/**
 * Turns an active key off. A key that is already off is removed from the list instead, so dead rows do not pile up: it cannot be
 * used either way, and the hash is gone with the row. 404 when there is no such key in this workspace.
 */
export async function revokeOrRemoveApiKey(tenantId: string, id: string): Promise<KeyRemoval> {
  const { count } = await prisma.apiKey.updateMany({ where: { id, tenantId, revokedAt: null }, data: { revokedAt: new Date() } });
  if (count === 1) return "revoked";
  const gone = await prisma.apiKey.deleteMany({ where: { id, tenantId, revokedAt: { not: null } } });
  if (gone.count === 0) throw new HttpError(404, "Key not found.");
  return "removed";
}

export type ApiKeyAuth = { actor: Actor; keyId: string; scopes: string[] };

function bearerKey(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header || !/^bearer /i.test(header)) return null;
  const token = header.slice(7).trim();
  return token.startsWith(KEY_PREFIX) && token.length <= 200 ? token : null;
}

async function creatorStanding(tenantId: string, userId: string, keyCreatedAt: Date | undefined): Promise<Standing> {
  const membership = await prisma.membership.findUnique({
    where: { tenantId_userId: { tenantId, userId } },
    select: { createdAt: true, user: { select: { disabledAt: true } }, tenant: { select: { deletedAt: true, status: true } } },
  });
  return standingOf(membership, keyCreatedAt);
}

/**
 * Looks the key up by hash, rejects revoked keys and keys whose creator has left or been disabled (those keys are revoked on the spot,
 * permanently), and touches lastUsedAt at most once a minute. A deleted workspace is a 401; a suspended one is a 403 with a clear message,
 * and its keys are kept so they work again when the workspace is reinstated. Null when not an API key. Only v1, compat and MCP call this:
 * getActor never accepts keys.
 */
export async function authenticateApiKey(request: Request, now = Date.now()): Promise<ApiKeyAuth | null> {
  const token = bearerKey(request);
  if (!token) return null;
  const hash = hashApiKey(token);
  const row = await prisma.apiKey.findUnique({ where: { keyHash: hash } });
  if (!row || row.revokedAt) return null;
  if (!timingSafeEqual(Buffer.from(row.keyHash), Buffer.from(hash))) return null;
  const standing = await creatorStanding(row.tenantId, row.createdByUserId, row.createdAt);
  if (standing === "gone") {
    try {
      await revokeKeysForUser(row.createdByUserId, row.tenantId);
    } catch {
      // the request is refused either way; the sweep in listApiKeys retries
    }
    return null;
  }
  if (standing === "closed") return null;
  if (standing === "suspended") throw new HttpError(403, "This workspace is suspended, so its API keys are paused.");
  if (!row.lastUsedAt || now - row.lastUsedAt.getTime() >= LAST_USED_INTERVAL_MS) {
    await prisma.apiKey.updateMany({ where: { id: row.id, tenantId: row.tenantId }, data: { lastUsedAt: new Date(now) } }).catch(() => undefined);
  }
  return { actor: { userId: row.createdByUserId, tenantId: row.tenantId, role: "agent" }, keyId: row.id, scopes: row.scopes };
}

/** Revokes every active key a user created in one workspace, or in all workspaces when tenantId is omitted. */
export async function revokeKeysForUser(userId: string, tenantId?: string): Promise<number> {
  const { count } = await prisma.apiKey.updateMany({
    where: { createdByUserId: userId, revokedAt: null, ...(tenantId ? { tenantId } : {}) },
    data: { revokedAt: new Date() },
  });
  return count;
}

/**
 * Revokes a departing member's keys without ever blocking the action that removed them. The live-membership check in
 * authenticateApiKey already refuses these keys, so a failure here is logged (ids and reason only, never key material) and the
 * sweep in listApiKeys or the next use of the key finishes the job. Returns the number revoked, or null when the write failed.
 */
export async function revokeKeysBestEffort(userId: string, tenantId: string | undefined, reason: string): Promise<number | null> {
  try {
    return await revokeKeysForUser(userId, tenantId);
  } catch (e) {
    console.warn("[api-keys] revoke on member loss failed", JSON.stringify({ userId, tenantId: tenantId ?? null, reason, error: e instanceof Error ? e.message.slice(0, 200) : "unknown" }));
    return null;
  }
}

/** Full v1 gate: valid key, within the rate limit, and holding the scope. */
export async function requireApiKey(request: Request, scope: ApiScope | readonly ApiScope[]): Promise<ApiKeyAuth> {
  const auth = await authenticateApiKey(request);
  if (!auth) throw new HttpError(401, "Invalid or missing API key.");
  if (!limiter.consume(auth.keyId)) throw new HttpError(429, `Rate limit exceeded: ${RATE_LIMIT} requests per minute per key.`);
  assertScope(auth.scopes, scope);
  return auth;
}
