import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Role } from "@/generated/prisma/client";
import { COMPANY } from "@/lib/config";
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

/** Shown at sign-in (and on accepting an invite) to an account a platform admin turned off. */
export const ACCOUNT_DISABLED = `This account has been turned off. Contact ${COMPANY.email} if you think this is a mistake.`;

/**
 * The refresh token that replaces `token` when it is rotated. It is derived from the old token with the server secret, not drawn at
 * random, so a second refresh racing the first one (two tabs, or a wake-up timer and a focus handler firing together) arrives at the
 * same successor instead of looking like a stolen token. Nobody without SESSION_SECRET can work it out from the old token.
 */
export function successorToken(token: string): string {
  return createHmac("sha256", secret()).update(`refresh-successor:${token}`).digest("base64url");
}

/**
 * The membership a refreshed session signs into: the session's workspace while it still exists, otherwise the oldest workspace of
 * the user that was not deleted. A deleted workspace would refuse every request and send the app round the renewal loop for ever.
 */
async function liveMembership(userId: string, tenantId: string | null) {
  const current = tenantId
    ? await prisma.membership.findUnique({ where: { tenantId_userId: { tenantId, userId } }, include: { tenant: { select: { deletedAt: true } } } })
    : null;
  if (current && !current.tenant?.deletedAt) return current;
  return prisma.membership.findFirst({ where: { userId, tenant: { deletedAt: null } }, orderBy: { createdAt: "asc" } });
}

/** Writes the successor session once. Both requests of a race may get here; whichever insert lands first wins, the other is skipped. */
async function storeSuccessor(previousToken: string, userId: string, tenantId: string, userAgent: string | null): Promise<string> {
  const token = successorToken(previousToken);
  await prisma.session.createMany({
    data: [{ userId, tenantId, refreshTokenHash: hashToken(token), userAgent: userAgent?.slice(0, 300) ?? null, expiresAt: new Date(Date.now() + REFRESH_TTL_MS) }],
    skipDuplicates: true,
  });
  return token;
}

const inGrace = (revokedAt: Date | null | undefined, nowMs = Date.now()) => !!revokedAt && revokedAt.getTime() > nowMs;

/**
 * Single-use refresh: the presented token is revoked and replaced. Presenting a token that was rotated less than a minute ago
 * (ROTATION_GRACE_MS) is a refresh racing the one that rotated it, and gets the same successor. Presenting a token revoked any other
 * way (rotated longer ago, signed out, password reset) revokes every session of that user.
 */
export async function rotateRefreshToken(token: string, userAgent: string | null): Promise<Rotated> {
  const session = await prisma.session.findUnique({ where: { refreshTokenHash: hashToken(token) }, include: { user: { select: { disabledAt: true } } } });
  if (!session) throw new HttpError(401, ENDED);
  // A disabled account gets no new session (getActor would refuse it, and the app would loop between /app and the renewal).
  if (session.user?.disabledAt) throw new HttpError(401, ENDED);
  const revokeAll = async (): Promise<never> => {
    await prisma.session.updateMany({ where: { userId: session.userId, revokedAt: null }, data: { revokedAt: new Date() } });
    throw new HttpError(401, ENDED);
  };
  if (session.revokedAt) return inGrace(session.revokedAt) ? joinRotation(session, token, userAgent) : revokeAll();
  if (session.expiresAt.getTime() <= Date.now()) throw new HttpError(401, ENDED);

  const membership = await liveMembership(session.userId, session.tenantId);

  // The old session stays good for access tokens for a short while: other tabs and requests already in flight still carry it.
  // The refresh token itself is single use from this moment: presenting it again gets the same successor while the grace lasts.
  const claimed = await prisma.session.updateMany({ where: { id: session.id, revokedAt: null }, data: { revokedAt: new Date(Date.now() + ROTATION_GRACE_MS) } });
  if (claimed.count === 0) {
    // Another request claimed it between the read and the claim. Join that rotation, unless it was a sign-out rather than a rotation.
    const now = await prisma.session.findUnique({ where: { id: session.id }, select: { revokedAt: true } });
    return inGrace(now?.revokedAt) ? joinRotation(session, token, userAgent) : revokeAll();
  }
  if (!membership) throw new HttpError(401, ENDED);

  const refreshToken = await storeSuccessor(token, session.userId, membership.tenantId, userAgent);
  return { userId: session.userId, tenantId: membership.tenantId, role: membership.role, refreshToken };
}

/** Answers a refresh that lost the race with the successor the winner made (writing it if the winner has not yet). */
async function joinRotation(session: { userId: string; tenantId: string | null }, token: string, userAgent: string | null): Promise<Rotated> {
  const refreshToken = successorToken(token);
  const hash = hashToken(refreshToken);
  let successor = await prisma.session.findUnique({ where: { refreshTokenHash: hash } });
  if (!successor) {
    const membership = await liveMembership(session.userId, session.tenantId);
    if (!membership) throw new HttpError(401, ENDED);
    await storeSuccessor(token, session.userId, membership.tenantId, userAgent);
    successor = await prisma.session.findUnique({ where: { refreshTokenHash: hash } });
  }
  // The successor itself may have been signed out or reset since; then the old token is no good either. (One that was rotated in
  // turn, a moment ago, is still in its own grace and is handed out: the browser then rotates it like any other.)
  if (!successor || (successor.revokedAt && !inGrace(successor.revokedAt)) || successor.expiresAt.getTime() <= Date.now()) throw new HttpError(401, ENDED);
  const membership = await liveMembership(session.userId, successor.tenantId);
  if (!membership) throw new HttpError(401, ENDED);
  return { userId: session.userId, tenantId: membership.tenantId, role: membership.role, refreshToken };
}

/**
 * Sign-out: ends the presented session and the sessions rotated from it. A token rotated less than a minute ago is still in its grace
 * (revokedAt in the future) and its successor is live, which happens when a rotation response was lost or a sign-out raced a renewal.
 * Both end now, so the old token cannot fetch the successor again (joinRotation) and the successor cannot sign the browser back in.
 * Two steps down the line cover a successor that was itself rotated a moment ago; rows exist only where a rotation really happened.
 */
export async function revokeSessionByToken(token: string): Promise<void> {
  const now = new Date();
  const next = successorToken(token);
  const line = [token, next, successorToken(next)].map(hashToken);
  await prisma.session.updateMany({
    where: { refreshTokenHash: { in: line }, OR: [{ revokedAt: null }, { revokedAt: { gt: now } }] },
    data: { revokedAt: now },
  });
}
