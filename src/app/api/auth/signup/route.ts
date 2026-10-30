import { randomBytes } from "node:crypto";
import { audit } from "@/lib/auth/audit";
import { startTrial } from "@/lib/billing";
import { authCookies } from "@/lib/auth/cookies";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { email, jsonWithCookies, password, readJson, slugify, str } from "@/lib/auth/http";
import { hashPassword } from "@/lib/auth/password";
import { checkSignupLimit, clientIp } from "@/lib/auth/ratelimit";
import { createSession, hashToken, signAccessToken } from "@/lib/auth/tokens";
import { prisma } from "@/lib/db";
import { sendVerificationEmail } from "@/lib/email/flows";
import { HttpError, errorResponse } from "@/lib/tenancy";

type Tx = Pick<typeof prisma, "tenant">;

async function uniqueSlug(tx: Tx, name: string): Promise<string> {
  const base = slugify(name) || "workspace";
  for (let i = 0; i < 5; i++) {
    const candidate = i === 0 ? base : `${base}-${randomBytes(2).toString("hex")}`;
    if (!(await tx.tenant.findUnique({ where: { slug: candidate } }))) return candidate;
  }
  return `${base}-${randomBytes(6).toString("hex")}`;
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    await checkSignupLimit(clientIp(request));
    const body = await readJson(request);
    const name = str(body, "name", "Name", 100);
    const mail = email(body);
    const workspaceName = str(body, "workspaceName", "Workspace name", 100);
    const hash = await hashPassword(password(body));

    if (await prisma.user.findUnique({ where: { email: mail } })) {
      throw new HttpError(409, "An account with this email already exists. Try signing in instead.");
    }

    const userAgent = request.headers.get("user-agent");
    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({ data: { email: mail, name, passwordHash: hash } });
      const tenant = await tx.tenant.create({ data: { name: workspaceName, slug: await uniqueSlug(tx, workspaceName) } });
      await tx.membership.create({ data: { tenantId: tenant.id, userId: user.id, role: "owner" } });
      const refresh = await createSession(user.id, tenant.id, userAgent, tx);
      return { user, tenant, refresh };
    });

    await startTrial(result.tenant.id).catch(() => console.error("[billing] could not start trial"));
    await sendVerificationEmail(result.user).catch(() => console.error("[auth] could not queue verification email"));
    await audit({ tenantId: result.tenant.id, userId: result.user.id, action: "auth.signup", target: result.tenant.id });
    const access = signAccessToken({ sub: result.user.id, tid: result.tenant.id, role: "owner", sid: hashToken(result.refresh) });
    return jsonWithCookies(
      {
        user: { id: result.user.id, email: result.user.email, name: result.user.name },
        workspace: { id: result.tenant.id, name: result.tenant.name, slug: result.tenant.slug },
        role: "owner",
      },
      authCookies(access, result.refresh),
      201,
    );
  } catch (e) {
    return errorResponse(e);
  }
}
