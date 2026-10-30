import { audit } from "@/lib/auth/audit";
import { authCookies } from "@/lib/auth/cookies";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { jsonWithCookies, password, readJson, str } from "@/lib/auth/http";
import { assertPasswordPolicy, hashPassword, verifyPassword } from "@/lib/auth/password";
import { checkLoginLimits, clientIp } from "@/lib/auth/ratelimit";
import { createSession, hashToken, signAccessToken } from "@/lib/auth/tokens";
import { prisma } from "@/lib/db";
import { HttpError, errorResponse } from "@/lib/tenancy";

const INVALID = "This invite link is invalid or has expired. Ask for a new invite.";

async function findOpenInvite(token: string) {
  const invite = await prisma.invite.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { tenant: { select: { id: true, name: true } } },
  });
  if (!invite || invite.acceptedAt || invite.expiresAt.getTime() <= Date.now()) throw new HttpError(400, INVALID);
  return invite;
}

export async function GET(request: Request) {
  try {
    const token = new URL(request.url).searchParams.get("token") ?? "";
    if (!token || token.length > 200) throw new HttpError(400, INVALID);
    const invite = await findOpenInvite(token);
    const existing = await prisma.user.findUnique({ where: { email: invite.email }, select: { id: true } });
    return Response.json(
      { email: invite.email, role: invite.role, workspaceName: invite.tenant.name, existingUser: Boolean(existing) },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const body = await readJson(request);
    const token = str(body, "token", "Invite token", 200);
    const pass = password(body);
    const invite = await findOpenInvite(token);
    await checkLoginLimits(clientIp(request), invite.email);

    const existing = await prisma.user.findUnique({ where: { email: invite.email } });
    let passwordHash = "";
    let name = "";
    if (existing) {
      if (!(await verifyPassword(pass, existing.passwordHash))) {
        throw new HttpError(401, "That password did not work. Use the password for your existing Edwyz WA account.");
      }
    } else {
      name = str(body, "name", "Name", 100);
      assertPasswordPolicy(pass);
      passwordHash = await hashPassword(pass);
    }

    const userAgent = request.headers.get("user-agent");
    const result = await prisma.$transaction(async (tx) => {
      const claimed = await tx.invite.updateMany({ where: { id: invite.id, acceptedAt: null }, data: { acceptedAt: new Date() } });
      if (claimed.count === 0) throw new HttpError(400, INVALID);
      // The link was delivered to the invited mailbox, so following it proves control of that address. This only holds when the server
      // mails invites; without a mail server the inviter is handed the link and could accept it in the invitee's place.
      const mailed = Boolean(process.env.SMTP_USER);
      const verifiedNow = mailed ? new Date() : null;
      const user =
        existing ??
        (await tx.user.create({ data: { email: invite.email, name, passwordHash, ...(verifiedNow ? { emailVerifiedAt: verifiedNow } : {}) } }));
      if (existing && verifiedNow && !existing.emailVerifiedAt) {
        await tx.user.update({ where: { id: existing.id }, data: { emailVerifiedAt: verifiedNow } });
      }
      const found = await tx.membership.findUnique({ where: { tenantId_userId: { tenantId: invite.tenantId, userId: user.id } } });
      const membership = found ?? (await tx.membership.create({ data: { tenantId: invite.tenantId, userId: user.id, role: invite.role } }));
      const refresh = await createSession(user.id, invite.tenantId, userAgent, tx);
      return { user, membership, refresh };
    });

    await audit({ tenantId: invite.tenantId, userId: result.user.id, action: "auth.invite_accepted", target: invite.id });
    const access = signAccessToken({ sub: result.user.id, tid: invite.tenantId, role: result.membership.role, sid: hashToken(result.refresh) });
    return jsonWithCookies(
      { user: { id: result.user.id, email: result.user.email, name: result.user.name }, tenantId: invite.tenantId, role: result.membership.role },
      authCookies(access, result.refresh),
    );
  } catch (e) {
    return errorResponse(e);
  }
}
