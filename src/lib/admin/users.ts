import { createHash, randomBytes } from "node:crypto";
import { audit } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { siteUrl } from "@/lib/config";
import { revokeKeysBestEffort } from "@/lib/integrations/apikeys";
import { queueEmail } from "@/lib/email";
import { HttpError } from "@/lib/tenancy";
import { requireConfirmation, requireReason, str } from "./http";

export const USER_PAGE_SIZE = 25;
const HOUR_MS = 3_600_000;

export async function listUsers(opts: { q: string; page: number }) {
  const where = opts.q ? { OR: [{ email: { contains: opts.q, mode: "insensitive" as const } }, { name: { contains: opts.q, mode: "insensitive" as const } }] } : {};
  const [total, items] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (opts.page - 1) * USER_PAGE_SIZE,
      take: USER_PAGE_SIZE,
      select: {
        id: true, email: true, name: true, createdAt: true, disabledAt: true, emailVerifiedAt: true,
        memberships: { select: { role: true, tenant: { select: { id: true, name: true } } } },
      },
    }),
  ]);
  return { total, items };
}

const newToken = () => randomBytes(32).toString("base64url");
const hash = (t: string) => createHash("sha256").update(t).digest("hex");

async function issueToken(userId: string, kind: "reset" | "verify", ttlMs: number) {
  const token = newToken();
  await prisma.emailToken.create({ data: { userId, kind, tokenHash: hash(token), expiresAt: new Date(Date.now() + ttlMs) } });
  return token;
}

const log = (adminUserId: string, userId: string, action: string, meta: Record<string, string | number | boolean | null> = {}) =>
  audit({ userId: adminUserId, action: `admin.user.${action}`, target: userId, meta });

export async function applyUserAction(adminUserId: string, userId: string, body: Record<string, unknown>) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true, name: true, emailVerifiedAt: true } });
  if (!user) throw new HttpError(404, "User not found.");
  const action = str(body, "action", "Action", 40);
  const reason = requireReason(body);

  switch (action) {
    case "disable":
      if (userId === adminUserId) throw new HttpError(400, "You cannot disable your own account.");
      requireConfirmation(user.email, body.confirm);
      await prisma.user.update({ where: { id: userId }, data: { disabledAt: new Date() } });
      await prisma.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
      // API keys the user created, in every workspace, stop working now. Enabling the account later does not bring them back.
      await log(adminUserId, userId, action, { reason, keysRevoked: await revokeKeysBestEffort(userId, undefined, "user_disabled") });
      return { ok: true };
    case "enable": {
      // Sweep again before the account can authenticate keys: if the revoke at disable (or anonymise) time failed, the keys were never marked
      // revoked and nothing may have used them while the user was disabled, so enabling would otherwise bring them back.
      const keysRevoked = await revokeKeysBestEffort(userId, undefined, "user_enabled");
      await prisma.user.update({ where: { id: userId }, data: { disabledAt: null } });
      await log(adminUserId, userId, action, { reason, keysRevoked });
      return { ok: true };
    }
    case "force_signout": {
      const res = await prisma.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
      await log(adminUserId, userId, action, { reason, sessions: res.count });
      return { ok: true, sessions: res.count };
    }
    case "resend_verification": {
      if (user.emailVerifiedAt) throw new HttpError(409, "This email is already verified.");
      const token = await issueToken(userId, "verify", 24 * HOUR_MS);
      await queueEmail({
        to: user.email,
        subject: "Verify your email for Edwyz WA",
        text: `Hello ${user.name},\n\nConfirm your email address by opening this link within 24 hours:\n${siteUrl()}/verify-email?token=${token}\n`,
      });
      await log(adminUserId, userId, action, { reason });
      return { ok: true };
    }
    case "reset_link": {
      const token = await issueToken(userId, "reset", HOUR_MS);
      await log(adminUserId, userId, action, { reason });
      return { ok: true, link: `${siteUrl()}/reset-password?token=${token}`, expiresInMinutes: 60 };
    }
    case "mark_verified":
      if (user.emailVerifiedAt) throw new HttpError(409, "This email is already verified.");
      await prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
      await log(adminUserId, userId, action, { reason });
      return { ok: true };
    default:
      throw new HttpError(400, "Unknown action.");
  }
}
