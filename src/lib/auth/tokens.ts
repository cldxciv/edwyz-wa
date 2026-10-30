import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Role } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { HttpError } from "@/lib/tenancy";

export const ACCESS_TTL_SECONDS = 15 * 60;
const ROTATION_GRACE_MS = 60_000;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** `sid` is the hash of the refresh token of the session that minted it, so revoking the session (logout, password reset) also ends the access token. */
export type AccessClaims = { sub: string; tid: string; role: Role; sid?: string; iat: number; exp: number };

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error("SESSION_SECRET must be set to a random string of at least 32 characters");
  return s;
}

const b64 = (v: string | Buffer) => Buffer.from(v).toString("base64url");
const sign = (data: string) => createHmac("sha256", secret()).update(data).digest();

export function signAccessToken(c: { sub: string; tid: string; role: Role; sid?: string }, nowMs = Date.now()): string {
  const iat = Math.floor(nowMs / 1000);
  const header = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64(JSON.stringify({ ...c, iat, exp: iat + ACCESS_TTL_SECONDS }));
  return `${header}.${body}.${b64(sign(`${header}.${body}`))}`;
}

export function verifyAccessToken(token: string, nowMs = Date.now()): AccessClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const given = Buffer.from(sig, "base64url");
  const expected = sign(`${header}.${body}`);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    if (JSON.parse(Buffer.from(header, "base64url").toString()).alg !== "HS256") return null;
    const c = JSON.parse(Buffer.from(body, "base64url").toString()) as AccessClaims;
    if (typeof c.sub !== "string" || typeof c.tid !== "string" || typeof c.exp !== "number") return null;
    if (c.sid !== undefined && typeof c.sid !== "string") return null;
    if (c.exp * 1000 <= nowMs) return null;
    return c;
  } catch {
    return null;
  }
}

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
export const newOpaqueToken = () => randomBytes(32).toString("base64url");

type SessionDb = Pick<typeof prisma, "session">;

export async function createSession(
  userId: string,
  tenantId: string | null,
  userAgent: string | null,
  db: SessionDb = prisma,
): Promise<string> {
  const token = newOpaqueToken();
  await db.session.create({
    data: {
      userId,
      tenantId,
      refreshTokenHash: hashToken(token),
      userAgent: userAgent?.slice(0, 300) ?? null,
      expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
    },
  });
  return token;
}

export type Rotated = { userId: string; tenantId: string; role: Role; refreshToken: string };

const ENDED = "Your session has ended. Please sign in again.";

/** Single-use refresh: the presented token is revoked and replaced. Presenting a revoked token revokes every session of that user. */
export async function rotateRefreshToken(token: string, userAgent: string | null): Promise<Rotated> {
  const session = await prisma.session.findUnique({ where: { refreshTokenHash: hashToken(token) } });
  if (!session) throw new HttpError(401, ENDED);
  const revokeAll = async (): Promise<never> => {
    await prisma.session.updateMany({ where: { userId: session.userId, revokedAt: null }, data: { revokedAt: new Date() } });
    throw new HttpError(401, ENDED);
  };
  if (session.revokedAt) return revokeAll();
  if (session.expiresAt.getTime() <= Date.now()) throw new HttpError(401, ENDED);

  const current = session.tenantId
    ? await prisma.membership.findUnique({ where: { tenantId_userId: { tenantId: session.tenantId, userId: session.userId } } })
    : null;
  const membership = current ?? (await prisma.membership.findFirst({ where: { userId: session.userId }, orderBy: { createdAt: "asc" } }));

  // The old session stays good for access tokens for a short while: other tabs and requests already in flight still carry it.
  // The refresh token itself is single use from this moment (any non-null revokedAt makes reuse an error above).
  const claimed = await prisma.session.updateMany({ where: { id: session.id, revokedAt: null }, data: { revokedAt: new Date(Date.now() + ROTATION_GRACE_MS) } });
  if (claimed.count === 0) return revokeAll();
  if (!membership) throw new HttpError(401, ENDED);

  const refreshToken = await createSession(session.userId, membership.tenantId, userAgent);
  return { userId: session.userId, tenantId: membership.tenantId, role: membership.role, refreshToken };
}

export async function revokeSessionByToken(token: string): Promise<void> {
  await prisma.session.updateMany({ where: { refreshTokenHash: hashToken(token), revokedAt: null }, data: { revokedAt: new Date() } });
}
