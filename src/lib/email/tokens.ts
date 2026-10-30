import { hashToken, newOpaqueToken } from "@/lib/auth/tokens";
import { prisma } from "@/lib/db";

export type EmailTokenKind = "verify" | "reset";
export const EMAIL_TOKEN_TTL_MS: Record<EmailTokenKind, number> = {
  verify: 48 * 60 * 60 * 1000,
  reset: 60 * 60 * 1000,
};

/** Returns the raw token (shown once). Only its sha256 is stored. Earlier unused tokens of the same kind stop working. */
export async function createEmailToken(userId: string, kind: EmailTokenKind): Promise<string> {
  const token = newOpaqueToken();
  await prisma.emailToken.updateMany({ where: { userId, kind, usedAt: null }, data: { usedAt: new Date() } });
  await prisma.emailToken.create({
    data: { userId, kind, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + EMAIL_TOKEN_TTL_MS[kind]) },
  });
  return token;
}

/** Single use: claims the token atomically and returns the user id, or null when unknown, used or expired. */
export async function consumeEmailToken(token: string, kind: EmailTokenKind): Promise<string | null> {
  if (!token || token.length > 200) return null;
  const row = await prisma.emailToken.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!row || row.kind !== kind || row.usedAt || row.expiresAt.getTime() <= Date.now()) return null;
  const claimed = await prisma.emailToken.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
  return claimed.count === 1 ? row.userId : null;
}
