import { getActor } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { type Actor, HttpError } from "@/lib/tenancy";
import { stepUpFromRequest } from "./stepup";

export function parseAdminEmails(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isPlatformAdminEmail(email: string | null | undefined, raw: string | undefined = process.env.PLATFORM_ADMIN_EMAILS): boolean {
  if (!email) return false;
  return parseAdminEmails(raw).includes(email.trim().toLowerCase());
}

export type AdminFacts = {
  email: string | null | undefined;
  emailVerifiedAt: Date | null | undefined;
  disabledAt?: Date | null;
  totpEnabledAt: Date | null | undefined;
  stepUpValid: boolean;
  allowlist?: string;
};

/**
 * deny: not an eligible admin (answer 404). enroll / verify: eligible admin who must finish TOTP setup or step-up first.
 * ok: allowlisted AND email verified AND enrolled AND step-up passed in this session.
 */
export function evaluateAdminAccess(f: AdminFacts): "deny" | "enroll" | "verify" | "ok" {
  const eligible = isPlatformAdminEmail(f.email, f.allowlist ?? process.env.PLATFORM_ADMIN_EMAILS) && !!f.emailVerifiedAt && !f.disabledAt;
  if (!eligible) return "deny";
  if (!f.totpEnabledAt) return "enroll";
  return f.stepUpValid ? "ok" : "verify";
}

export type AdminIdentity = { actor: Actor; userId: string; email: string; name: string; totpEnabled: boolean; access: "enroll" | "verify" | "ok" };

const notFound = () => new HttpError(404, "Not found.");

/** Allowlisted and email-verified admin, step-up not yet required. Used only by enrolment and the step-up endpoint. */
export async function requireAdminIdentity(request: Request): Promise<AdminIdentity> {
  try {
    const actor = await getActor(request);
    const user = await prisma.user.findUnique({
      where: { id: actor.userId },
      select: { email: true, name: true, emailVerifiedAt: true, disabledAt: true, totpEnabledAt: true },
    });
    if (!user) throw notFound();
    const access = evaluateAdminAccess({ ...user, stepUpValid: stepUpFromRequest(request, actor.userId) });
    if (access === "deny") throw notFound();
    return { actor, userId: actor.userId, email: user.email, name: user.name, totpEnabled: !!user.totpEnabledAt, access };
  } catch {
    throw notFound();
  }
}

/** Full rule for every admin API and page. Every failure is the same 404 so the area is not discoverable. */
export async function requirePlatformAdmin(request: Request): Promise<{ actor: Actor; email: string }> {
  const id = await requireAdminIdentity(request);
  if (id.access !== "ok") throw notFound();
  return { actor: id.actor, email: id.email };
}
