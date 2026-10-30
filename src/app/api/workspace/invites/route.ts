import type { Role } from "@/generated/prisma/client";
import { getActor } from "@/lib/auth";
import { audit } from "@/lib/auth/audit";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { email, readJson, str } from "@/lib/auth/http";
import { hashToken, newOpaqueToken } from "@/lib/auth/tokens";
import { assertWithinLimit } from "@/lib/billing";
import { siteUrl } from "@/lib/config";
import { prisma } from "@/lib/db";
import { queueEmail } from "@/lib/email";
import { inviteTemplate } from "@/lib/email/templates";
import { HttpError, errorResponse, requireRole } from "@/lib/tenancy";

const mailCanBeDelivered = () => Boolean(process.env.SMTP_USER);
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const INVITABLE: Role[] = ["admin", "agent"];

export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const invites = await prisma.invite.findMany({
      where: { tenantId: actor.tenantId, acceptedAt: null },
      orderBy: { createdAt: "desc" },
      select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
    });
    return Response.json({ invites }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const body = await readJson(request);
    const mail = email(body);
    const role = str(body, "role", "Role", 20) as Role;
    if (!INVITABLE.includes(role)) throw new HttpError(400, "Choose admin or agent.");
    if (role === "admin" && actor.role !== "owner") throw new HttpError(403, "Only an owner can invite an admin.");

    const user = await prisma.user.findUnique({ where: { email: mail }, select: { id: true } });
    if (user) {
      const member = await prisma.membership.findUnique({ where: { tenantId_userId: { tenantId: actor.tenantId, userId: user.id } } });
      if (member) throw new HttpError(409, "That person is already a member of this workspace.");
    }

    await assertWithinLimit(actor.tenantId, "seats");
    const token = newOpaqueToken();
    await prisma.invite.deleteMany({ where: { tenantId: actor.tenantId, email: mail, acceptedAt: null } });
    const invite = await prisma.invite.create({
      data: { tenantId: actor.tenantId, email: mail, role, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + INVITE_TTL_MS) },
    });
    await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "invite.created", target: invite.id, meta: { role } });
    const acceptUrl = `${siteUrl()}/accept-invite?token=${token}`;
    try {
      const [inviter, tenant] = await Promise.all([
        prisma.user.findUnique({ where: { id: actor.userId }, select: { name: true } }),
        prisma.tenant.findUnique({ where: { id: actor.tenantId }, select: { name: true } }),
      ]);
      await queueEmail(
        {
          to: invite.email,
          ...inviteTemplate({ workspaceName: tenant?.name ?? "a workspace", inviterName: inviter?.name ?? "A teammate", role, link: acceptUrl }),
        },
        { seal: true },
      );
    } catch {
      console.error("[auth] could not queue invite email");
    }
    return Response.json(
      {
        id: invite.id,
        email: invite.email,
        role: invite.role,
        expiresAt: invite.expiresAt,
        // The link goes to the invited mailbox. The inviter only gets it back when this server cannot send mail at all (local or test
        // setups), because anyone holding the link can create the account for that address and choose its password.
        emailed: mailCanBeDelivered(),
        ...(mailCanBeDelivered() ? {} : { acceptUrl }),
      },
      { status: 201, headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    return errorResponse(e);
  }
}
